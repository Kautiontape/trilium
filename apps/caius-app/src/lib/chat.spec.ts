import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activityLine, applyChunk, type AssistantTurn, type ChatChunk, chatApi, type ContentBlock, firstLine, historyForServer, latestLine, NeedsServerUpdateError, NoTurnError, sseParser, TooManyTurnsError, type StoredMessage, stepOf, turnText, TurnRunningError, workingLine } from "./chat.js";
import { HttpError, request } from "./http.js";
import { afterStreamError } from "./chats.js";
import { messageOf } from "./store.js";

vi.mock("./http.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./http.js")>(), request: vi.fn() }));

/** A real Wind down, two turns, as `POST /etapi/llm-chat/stream` sent it from a seeded test Journal. */
const FIXTURE = readFileSync(new URL("./fixtures/chat-winddown.sse", import.meta.url), "utf-8");

describe("a recorded Wind down", () => {
    it("assembles each turn, its step cards and its text, whatever the read sizes", () => {
        const turns = FIXTURE.split(/^### .*$/m).filter((t) => t.trim());
        expect(turns).toHaveLength(2);

        const assembled = turns.map((wire) => {
            let turn: AssistantTurn = { id: "t", blocks: [], done: false };
            const feed = sseParser((data) => {
                turn = applyChunk(turn, JSON.parse(data) as ChatChunk);
            });
            for (let at = 0; at < wire.length; at += 97) {
                feed(wire.slice(at, at + 97));
            }
            return turn;
        });

        const [ first, second ] = assembled;
        expect(first.done).toBe(true);
        const steps = first.blocks.flatMap((b) => b.type === "tool_call" ? [ stepOf(b.toolCall) ] : []).filter((s) => s !== null);
        expect(steps.map((s) => s.step)).toEqual([ "open", "next", "context" ]);
        expect(steps.every((s) => s.ritual === "winddown")).toBe(true);
        expect(Array.isArray(steps[0].data.items)).toBe(true);
        expect(turnText(first.blocks)).toContain(steps[0].question);

        expect(second.done).toBe(true);
        const calls = second.blocks.flatMap((b) => b.type === "tool_call" ? [ b.toolCall.toolName ] : []);
        expect(calls).toContain("caius_winddown_apply");
        expect(turnText(second.blocks)).toMatch(/are done/);
    });
});

describe("historyForServer", () => {
    it("leaves out a failed attempt, so the model never reads an error as its own words", () => {
        const at = "2026-11-04T09:00:00.000Z";
        const sent = historyForServer([
            { id: "1", role: "user", content: "Wind down 2026-11-04", createdAt: at },
            { id: "2", role: "assistant", content: [ { type: "text", content: "Which are done?" } ], createdAt: at },
            { id: "3", role: "user", content: "Laundry is done.", createdAt: at },
            { id: "4", role: "assistant", content: "The reply was cut off.", createdAt: at, type: "error" },
            { id: "5", role: "user", content: "Laundry is done.", createdAt: at }
        ]);
        expect(sent).toEqual([
            { role: "user", content: "Wind down 2026-11-04" },
            { role: "assistant", content: "Which are done?" },
            { role: "user", content: "Laundry is done." }
        ]);
    });

    it("leaves out Caius's notes, which are the working and not the replies", () => {
        const at = "2026-11-04T09:00:00.000Z";
        const sent = historyForServer([
            { id: "1", role: "user", content: "Wind down 2026-11-04", createdAt: at },
            { id: "2-notes", role: "assistant", content: "He wants to close out Tuesday.", createdAt: at, type: "thinking" },
            { id: "2", role: "assistant", content: [ { type: "text", content: "Which are done?" } ], createdAt: at },
            { id: "3", role: "user", content: "Laundry is done.", createdAt: at }
        ]);
        expect(sent).toEqual([
            { role: "user", content: "Wind down 2026-11-04" },
            { role: "assistant", content: "Which are done?" },
            { role: "user", content: "Laundry is done." }
        ]);
    });
});

describe("the turn routes", () => {
    const api = chatApi({ url: "https://caius.example", token: "tok" } as Parameters<typeof chatApi>[0]);
    const sse = (frames: string) => new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const json = (status: number, body?: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(request).mockReset();
    });

    it("words a 429 too_many_turns as a refusal the phone saves itself", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { error: "too_many_turns" })));
        const error = await api.stream([], "note1", "low", { replyId: "r", transcript: [] }, () => {}).catch((e) => e);
        expect(error).toBeInstanceOf(TooManyTurnsError);
        expect(messageOf(error)).toBe("Caius is busy with other chats. Try again in a minute.");
        expect(afterStreamError(error)).toBe("refused");
    });

    it("sends the reply id and transcript with a turn, and a 409 means a turn is running", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(sse("data: {\"type\":\"done\"}\n\n")).mockResolvedValueOnce(json(409, { error: "turn_running" }));
        vi.stubGlobal("fetch", fetchMock);
        const transcript = [ { id: "u1", role: "user", content: "hi", createdAt: "2026-01-01" } ] as StoredMessage[];
        const chunks: ChatChunk[] = [];

        await api.stream([ { role: "user", content: "hi" } ], "note1", "low", { replyId: "r1", transcript }, (c) => chunks.push(c));
        expect(chunks).toEqual([ { type: "done" } ]);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.turn).toEqual({ replyId: "r1", transcript });
        expect(body.config).toEqual({ chatNoteId: "note1", reasoningEffort: "low" });

        await expect(api.stream([], "note1", "low", { replyId: "r2", transcript }, () => {})).rejects.toBeInstanceOf(TurnRunningError);
    });

    it("reads a turn's state", async () => {
        const state = { content: null, running: true, replyId: "r1", chunks: 4 };
        vi.mocked(request).mockResolvedValueOnce({ status: 200, text: JSON.stringify(state) }).mockResolvedValueOnce({ status: 404, text: "" }).mockResolvedValueOnce({ status: 500, text: "x" });

        await expect(api.turnState("n 1")).resolves.toEqual(state);
        expect(vi.mocked(request).mock.calls[0][0]).toMatchObject({ method: "GET", url: "https://caius.example/etapi/llm-chat/n%201/turn" });
        await expect(api.turnState("n1")).rejects.toBeInstanceOf(NeedsServerUpdateError);
        await expect(api.turnState("n1")).rejects.toBeInstanceOf(HttpError);
    });

    it("reattaches from a chunk index, and tells no turn from an older server", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(sse(": hb\n\ndata: {\"type\":\"text\",\"content\":\"a\"}\n\ndata: {\"type\":\"done\"}\n\n"))
            .mockResolvedValueOnce(json(404, { error: "no_turn" }))
            .mockResolvedValueOnce(json(404));
        vi.stubGlobal("fetch", fetchMock);
        const chunks: ChatChunk[] = [];

        await api.reattach("n1", 7, (c) => chunks.push(c));
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://caius.example/etapi/llm-chat/n1/stream?from=7");
        expect(chunks).toEqual([ { type: "text", content: "a" }, { type: "done" } ]);
        await expect(api.reattach("n1", 0, () => {})).rejects.toBeInstanceOf(NoTurnError);
        await expect(api.reattach("n1", 0, () => {})).rejects.toBeInstanceOf(NeedsServerUpdateError);
    });
});

describe("latestLine and firstLine", () => {
    it("pick the last and first non-blank line, stripped of markdown", () => {
        const text = "\n# Plan for **today**\n\n> *quoted* note\n- _first_ bullet\n2. last step\n  \n";
        expect(firstLine(text)).toBe("Plan for today");
        expect(latestLine(text)).toBe("last step");
        expect(latestLine("a\n* b")).toBe("b");
        expect(firstLine("   \n\n")).toBe("");
        expect(latestLine("")).toBe("");
    });

    it("clip to 120 characters with an ellipsis", () => {
        const long = "x".repeat(300);
        expect(firstLine(long)).toBe(`${"x".repeat(119)}…`);
        expect(firstLine("y".repeat(120))).toBe("y".repeat(120));
    });
});

describe("activityLine", () => {
    const tool: ContentBlock = { type: "tool_call", toolCall: { id: "c1", toolName: "caius_plan", input: {} } };
    const reply = (id: string, content: StoredMessage["content"], type?: StoredMessage["type"]): StoredMessage => ({ id, role: "assistant", content, createdAt: "", ...(type ? { type } : {}) });

    it("shows the streaming text's last line while Caius works, else the transcript's working line", () => {
        const turn: AssistantTurn = { id: "t", blocks: [ { type: "text", content: "Here is the plan.\n\n- **Ship** the fix" } ], done: false };
        expect(activityLine(true, turn, [], null)).toBe("Ship the fix");
        expect(activityLine(true, null, [], null)).toBe("Caius is reading the Journal…");
        expect(activityLine(true, { id: "t", blocks: [ tool ], done: false }, [], null)).toBe("Caius is writing…");
        expect(workingLine({ id: "t", blocks: [ tool ], done: false })).toBe("Caius is writing…");
        expect(workingLine(null)).toBe("Caius is reading the Journal…");
    });

    it("shows the last reply's first line once Caius is done, or the error, and nothing before a reply", () => {
        const messages = [
            { id: "u", role: "user" as const, content: "Plan my day", createdAt: "" },
            reply("a", [ { type: "text", content: "\n## Three things today\nThen more." } ]),
            reply("n", "Weighing the calendar", "thinking")
        ];
        expect(activityLine(false, null, messages, null)).toBe("Three things today");
        expect(activityLine(false, null, [ ...messages, reply("e", "The server went away.", "error") ], null)).toBe("The server went away.");
        expect(activityLine(false, null, messages, "Not connected.\nTry again.")).toBe("Not connected.");
        expect(activityLine(false, null, messages.slice(0, 1), null)).toBeNull();
    });
});
