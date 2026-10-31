import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { applyChunk, type AssistantTurn, type ChatChunk, historyForServer, sseParser, stepOf, turnText } from "./chat.js";

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

    it("leaves a turn without its done chunk unfinished, which the chat shows as cut off", () => {
        const feed: ChatChunk[] = [ { type: "text", content: "Here's what's" } ];
        const turn = feed.reduce(applyChunk, { id: "t", blocks: [], done: false } as AssistantTurn);
        expect(turn.done).toBe(false);
        expect(applyChunk(turn, { type: "done" }).done).toBe(true);
    });
});

describe("applyChunk", () => {
    it("takes back narration streamed before a tool call and keeps it to fade out", () => {
        let turn: AssistantTurn = { id: "t", blocks: [], done: false };
        for (const chunk of [
            { type: "text", content: "Let me " },
            { type: "text", content: "check." },
            { type: "text_retract" },
            { type: "tool_use", toolCallId: "a", toolName: "caius_planday", toolInput: {} },
            { type: "tool_result", toolCallId: "a", toolName: "caius_planday", result: "{}" },
            { type: "text", content: "Here's your day." },
            { type: "done" }
        ] as ChatChunk[]) {
            turn = applyChunk(turn, chunk);
        }
        expect(turnText(turn.blocks)).toBe("Here's your day.");
        expect(turn.fading).toEqual({ key: 1, text: "Let me check." });
        expect(turn.blocks.map((b) => b.type)).toEqual([ "tool_call", "text" ]);
    });
});
