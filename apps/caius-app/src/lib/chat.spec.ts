import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { applyChunk, type AssistantTurn, type ChatChunk, sseParser, stepOf, turnText } from "./chat.js";

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
