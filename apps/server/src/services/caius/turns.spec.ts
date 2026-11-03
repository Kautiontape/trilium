import type { CaiusStoredMessage, LlmMessage, LlmStreamChunk } from "@triliumnext/commons";
import { becca, cls, hidden_subtree, special_notes, sql_init } from "@triliumnext/core";
import i18next from "i18next";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    MAX_RUNNING_TURNS,
    MAX_TURN_LOG_LENGTH,
    MAX_TURN_MS,
    phoneChatNoteOf,
    RETAIN_MS,
    SAVE_INTERVAL_MS,
    startTurn,
    subscribe,
    type Turn,
    turnOf,
    type TurnStart
} from "./turns.js";

type Script = (signal?: AbortSignal) => AsyncGenerator<LlmStreamChunk>;

const llm = vi.hoisted(() => ({
    script: undefined as Script | undefined,
    calls: [] as { messages: unknown; config: unknown; signal?: AbortSignal }[]
}));

vi.mock("@triliumnext/core/src/services/llm/chat.js", () => ({
    runChat(messages: unknown, config: unknown, signal?: AbortSignal) {
        llm.calls.push({ messages, config, signal });
        if (!llm.script) {
            throw new Error("No chat script set");
        }
        return llm.script(signal);
    }
}));

const OPENER: LlmMessage[] = [ { role: "user", content: "Wind down 2026-11-04" } ];
const USER: CaiusStoredMessage = {
    id: "u1",
    role: "user",
    content: "Wind down 2026-11-04",
    createdAt: "2026-11-04T21:00:00.000Z"
};
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: [ "setTimeout", "clearTimeout", "Date" ]
};
/** Text for the `caius.turn.*` keys that differs from the catalogue's, so a spec sees `t()` run. */
const MESSAGES = {
    stopped: "Stopped (spec)",
    out_of_time: "Out of time (spec)",
    too_long: "Too long (spec)"
};
const catalogue = new Map<string, unknown>();

beforeAll(async () => {
    await sql_init.dbReady;
    if (!becca.getNote("_llmChat")) {
        cls.init(() => hidden_subtree.checkHiddenSubtree());
    }
    for (const [ name, text ] of Object.entries(MESSAGES)) {
        const key = `caius.turn.${name}`;
        catalogue.set(key, i18next.getResource(i18next.language, "server", key));
        i18next.addResource(i18next.language, "server", key, text);
    }
});

afterAll(() => {
    for (const [ key, text ] of catalogue) {
        if (typeof text === "string") {
            i18next.addResource(i18next.language, "server", key, text);
        }
    }
});

afterEach(() => {
    vi.useRealTimers();
    llm.script = undefined;
});

describe("startTurn", () => {
    it("runs a turn with no subscriber to its end and saves it to the note", async () => {
        const noteId = newChatNote();
        let drained = false;
        llm.script = async function* () {
            yield { type: "text", content: "Here's " };
            const toolInput = { date: "2026-11-04" };
            yield { type: "tool_use", toolCallId: "t1", toolName: "caius_plan", toolInput };
            yield { type: "tool_result", toolCallId: "t1", toolName: "caius_plan", result: "{}" };
            yield { type: "text", content: "what's left." };
            yield { type: "done" };
            drained = true;
        };

        const config = { chatNoteId: noteId };
        const turn = started({ ...withTranscript(noteId), config });
        expect(turn).toMatchObject({ noteId, replyId: "r1", running: true });
        await turn.finished;

        expect(turn.running).toBe(false);
        expect(turn.chunks).toHaveLength(5);
        const call = llm.calls.at(-1);
        expect(call).toMatchObject({ messages: OPENER, config });
        await vi.waitFor(() => expect(drained).toBe(true));
        expect(call?.signal?.aborted).toBe(false);
        expect(contentOf(noteId)).toEqual({
            version: 1,
            messages: [
                USER,
                {
                    id: "r1",
                    role: "assistant",
                    createdAt: turn.createdAt,
                    content: [
                        { type: "text", content: "Here's " },
                        {
                            type: "tool_call",
                            toolCall: {
                                id: "t1",
                                toolName: "caius_plan",
                                input: { date: "2026-11-04" },
                                result: "{}"
                            }
                        },
                        { type: "text", content: "what's left." }
                    ]
                }
            ],
            enableNoteTools: true,
            enableWebSearch: false
        });
    });

    it("marks the reply partial in saves made while the turn runs, not in the last", async () => {
        vi.useFakeTimers(FAKE_TIMERS);
        const noteId = newChatNote();
        const chat = gated([ text("Hel") ], [ text("lo"), { type: "done" } ]);

        const turn = started(withTranscript(noteId));
        await chat.reached;
        expect(contentOf(noteId).messages).toEqual([
            USER,
            { id: "r1", role: "assistant", content: [], createdAt: turn.createdAt, partial: true }
        ]);

        await vi.advanceTimersByTimeAsync(SAVE_INTERVAL_MS);
        const saved = contentOf(noteId).messages[1];
        expect(saved).toMatchObject({ content: [ text("Hel") ], partial: true });

        chat.release();
        await turn.finished;
        const reply = contentOf(noteId).messages[1];
        expect(reply).toMatchObject({ content: [ text("Hello") ] });
        expect(reply).not.toHaveProperty("partial");
    });

    it("refuses a second turn while one runs, and replaces a finished one", async () => {
        const noteId = newChatNote();
        const chat = gated([ text("Hi") ], [ { type: "done" } ]);

        const first = started({ noteId, messages: OPENER, config: {} });
        expect(startTurn({ noteId, messages: OPENER, config: {} })).toBe("running");
        expect(turnOf(noteId)).toBe(first);

        chat.release();
        await first.finished;
        expect(turnOf(noteId)).toBe(first);
        expect(first.replyId).toMatch(/\S/);

        llm.script = async function* () {
            yield { type: "done" };
        };
        const second = started({ noteId, messages: OPENER, config: {} });
        expect(second).not.toBe(first);
        expect(turnOf(noteId)).toBe(second);
        await second.finished;
    });

    it("refuses a turn on another note while `MAX_RUNNING_TURNS` run, and starts it once one ends", async () => {
        const chat = gated([ text("Hi") ], [ { type: "done" } ]);
        const running: Turn[] = [];
        try {
            for (let i = 0; i < MAX_RUNNING_TURNS; i++) {
                running.push(started({ noteId: newChatNote(), messages: OPENER, config: {} }));
            }
            const noteId = newChatNote();
            expect(startTurn({ noteId, messages: OPENER, config: {} })).toBe("busy");
            expect(turnOf(noteId)).toBeUndefined();
            expect(startTurn({ noteId: running[0].noteId, messages: OPENER, config: {} })).toBe("running");
        } finally {
            chat.release();
            await Promise.all(running.map((turn) => turn.finished));
        }

        const next = started({ noteId: newChatNote(), messages: OPENER, config: {} });
        await next.finished;
        expect(next.chunks.at(-1)).toEqual({ type: "done" });
    });

    it("keeps tool-input chunks out of the log and from subscribers, with matching offsets", async () => {
        const noteId = newChatNote();
        const toolInput = { date: "2026-11-04" };
        const chat = gated([ text("a") ], [
            { type: "tool_input_start", toolCallId: "t1", toolName: "caius_plan" },
            { type: "tool_input_delta", toolCallId: "t1", delta: "{\"date\":" },
            { type: "tool_input_delta", toolCallId: "t1", delta: "\"2026-11-04\"}" },
            { type: "tool_use", toolCallId: "t1", toolName: "caius_plan", toolInput },
            { type: "tool_result", toolCallId: "t1", toolName: "caius_plan", result: "{}" },
            { type: "done" }
        ]);
        const turn = started({ noteId, messages: OPENER, config: {} });
        await chat.reached;

        const live: string[] = [];
        subscribe(turn, 0, (chunk, index) => live.push(`${index}:${chunk.type}`), () => {});
        chat.release();
        await turn.finished;

        const types = [ "text", "tool_use", "tool_result", "done" ];
        expect(turn.chunks.map((chunk) => chunk.type)).toEqual(types);
        expect(live).toEqual(types.map((type, index) => `${index}:${type}`));
    });

    it("runs `runChat` in a context of its own, apart from the caller's", async () => {
        const noteId = newChatNote();
        llm.script = async function* () {
            cls.set("probe", "turn");
            yield { type: "done" };
        };

        const bare = started({ noteId, messages: OPENER, config: {} });
        await bare.finished;
        expect(bare.chunks).toEqual([ { type: "done" } ]);

        await cls.init(async () => {
            cls.set("probe", "request");
            const turn = started({ noteId, messages: OPENER, config: {} });
            await turn.finished;
            expect(turn.chunks).toEqual([ { type: "done" } ]);
            expect(cls.get("probe")).toBe("request");
        });
    });

    it("ends a turn that stops early with an error chunk, and writes no other note", async () => {
        const before = cls.init(() => becca.getNoteOrThrow("root").getContent());
        llm.script = async function* () {
            yield text("Half a");
        };

        const turn = started(withTranscript("root"));
        await turn.finished;

        expect(turn.chunks).toEqual([
            text("Half a"),
            { type: "error", error: MESSAGES.stopped }
        ]);
        expect(cls.init(() => becca.getNoteOrThrow("root").getContent())).toBe(before);
    });
});

describe("subscribe", () => {
    it("replays from an offset, follows live chunks, then ends after the last", async () => {
        const noteId = newChatNote();
        const chat = gated([ text("a"), text("b") ], [ text("c"), { type: "done" } ]);
        const turn = started({ noteId, messages: OPENER, config: {} });
        await chat.reached;

        const events: string[] = [];
        const onEnd = () => events.push("end");
        subscribe(turn, 1, (chunk, index) => events.push(`${index}:${label(chunk)}`), onEnd);
        expect(events).toEqual([ "1:b" ]);

        const dropped: string[] = [];
        const drop = (chunk: LlmStreamChunk) => dropped.push(label(chunk));
        const unsubscribe = subscribe(turn, 0, drop, () => dropped.push("end"));
        unsubscribe();

        chat.release();
        await turn.finished;
        expect(events).toEqual([ "1:b", "2:c", "3:done", "end" ]);
        expect(dropped).toEqual([ "a", "b" ]);

        const late: string[] = [];
        subscribe(turn, 99, (chunk) => late.push(label(chunk)), () => late.push("end"));
        subscribe(turn, -5, (chunk) => late.push(label(chunk)), () => late.push("end"));
        expect(late).toEqual([ "end", "a", "b", "c", "done", "end" ]);
    });

    it("keeps a turn running when a subscriber throws", async () => {
        const noteId = newChatNote();
        llm.script = async function* () {
            yield text("a");
            yield { type: "done" };
        };
        const turn = started({ noteId, messages: OPENER, config: {} });
        const fail = () => {
            throw new Error("closed");
        };
        subscribe(turn, 0, fail, fail);
        await turn.finished;
        expect(turn.chunks.at(-1)).toEqual({ type: "done" });
    });
});

describe("bounds", () => {
    it("ends a turn that runs past the time cap with an error chunk", async () => {
        vi.useFakeTimers(FAKE_TIMERS);
        const noteId = newChatNote();
        const chat = gated([ text("Hel") ], [ text("lo"), { type: "done" } ]);
        const turn = started(withTranscript(noteId));
        await chat.reached;

        await vi.advanceTimersByTimeAsync(MAX_TURN_MS - 1);
        expect(turn.running).toBe(true);
        await vi.advanceTimersByTimeAsync(1);

        const error = MESSAGES.out_of_time;
        expect(turn.running).toBe(false);
        expect(llm.calls.at(-1)?.signal?.aborted).toBe(true);
        expect(turn.chunks).toEqual([ text("Hel"), { type: "error", error } ]);
        await turn.finished;
        expect(contentOf(noteId).messages).toEqual([
            USER,
            { id: "r1", role: "assistant", content: [ { type: "text", content: "Hel" } ], createdAt: turn.createdAt },
            { id: "r1-error", role: "assistant", content: error, createdAt: turn.createdAt, type: "error" }
        ]);
    });

    it("ends a turn whose log passes the size cap, and keeps the reply it wrote", async () => {
        const noteId = newChatNote();
        const call = { toolCallId: "a", toolName: "caius_winddown_apply" };
        // `status` chunks count toward the log but stay out of the saved reply, which keeps it under `MAX_CHAT_CONTENT_LENGTH`.
        const filler: LlmStreamChunk = { type: "status", status: "x".repeat(64 * 1024) };
        llm.script = async function* () {
            yield { type: "tool_use", ...call, toolInput: {} };
            yield { type: "tool_result", ...call, result: "{}" };
            yield text("Applied.");
            for (let size = 0; size < MAX_TURN_LOG_LENGTH * 2; size += 64 * 1024) {
                yield filler;
            }
            yield { type: "done" };
        };
        const turn = started(withTranscript(noteId));
        await turn.finished;

        const logged = turn.chunks.slice(0, -1).reduce((size, chunk) => size + JSON.stringify(chunk).length, 0);
        expect(logged).toBeGreaterThanOrEqual(MAX_TURN_LOG_LENGTH);
        expect(logged - JSON.stringify(filler).length).toBeLessThan(MAX_TURN_LOG_LENGTH);
        expect(turn.chunks.at(-1)).toEqual({ type: "error", error: MESSAGES.too_long });
        expect(llm.calls.at(-1)?.signal?.aborted).toBe(true);
        expect(contentOf(noteId).messages).toEqual([
            USER,
            {
                id: "r1",
                role: "assistant",
                content: [
                    { type: "tool_call", toolCall: { id: "a", toolName: "caius_winddown_apply", input: {}, result: "{}" } },
                    { type: "text", content: "Applied." }
                ],
                createdAt: turn.createdAt
            },
            { id: "r1-error", role: "assistant", content: MESSAGES.too_long, createdAt: turn.createdAt, type: "error" }
        ]);
    });

    it("drops a finished turn after the retention, unless a newer turn replaced it", async () => {
        vi.useFakeTimers(FAKE_TIMERS);
        const noteId = newChatNote();
        llm.script = async function* () {
            yield { type: "done" };
        };

        const first = started({ noteId, messages: OPENER, config: {} });
        await first.finished;
        await vi.advanceTimersByTimeAsync(RETAIN_MS - 1);
        expect(turnOf(noteId)).toBe(first);
        await vi.advanceTimersByTimeAsync(1);
        expect(turnOf(noteId)).toBeUndefined();

        const second = started({ noteId, messages: OPENER, config: {} });
        await second.finished;
        await vi.advanceTimersByTimeAsync(RETAIN_MS / 2);
        const third = started({ noteId, messages: OPENER, config: {} });
        await third.finished;
        await vi.advanceTimersByTimeAsync(RETAIN_MS / 2);
        expect(turnOf(noteId)).toBe(third);
        await vi.advanceTimersByTimeAsync(RETAIN_MS / 2);
        expect(turnOf(noteId)).toBeUndefined();
    });
});

describe("phoneChatNoteOf", () => {
    it("names an unprotected chat note under _llmChat, and nothing else", () => {
        const noteId = newChatNote();
        expect(phoneChatNoteOf(noteId)?.noteId).toBe(noteId);
        for (const other of [ undefined, 42, "nonexistent00", "root", "_llmChat" ]) {
            expect(phoneChatNoteOf(other)).toBeNull();
        }
    });
});

function started(start: TurnStart): Turn {
    const turn = startTurn(start);
    if (typeof turn === "string") {
        throw new Error(`The turn did not start: ${turn}`);
    }
    return turn;
}

function newChatNote(): string {
    return cls.init(() => special_notes.createLlmChat().noteId);
}

/** A turn for `noteId` that saves, with the reply id `r1`. */
function withTranscript(noteId: string): TurnStart {
    return { noteId, messages: OPENER, config: {}, transcript: [ USER ], replyId: "r1" };
}

function contentOf(noteId: string): { messages: Record<string, unknown>[] } {
    return JSON.parse(cls.init(() => becca.getNoteOrThrow(noteId).getContent()) as string);
}

function text(content: string): LlmStreamChunk {
    return { type: "text", content };
}

function label(chunk: LlmStreamChunk): string {
    return chunk.type === "text" ? chunk.content : chunk.type;
}

/**
 * Sets a chat script that yields `before`, then waits until the test calls `release` (or the turn
 * is aborted, when it returns as `runChat` does), then yields `after`.
 */
function gated(before: LlmStreamChunk[], after: LlmStreamChunk[]) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let reach = () => {};
    const reached = new Promise<void>((resolve) => {
        reach = resolve;
    });
    llm.script = async function* (signal?: AbortSignal) {
        yield* before;
        reach();
        const aborted = new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve());
        });
        await Promise.race([ gate, aborted ]);
        if (signal?.aborted) {
            return;
        }
        yield* after;
    };
    return { reached, release };
}
