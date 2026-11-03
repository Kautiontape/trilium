import { describe, expect, it } from "vitest";

import { applyChunk, type AssistantTurn, type CaiusTurnChunk, turnMessages } from "./caius_turn.js";

const AT = "2026-11-04T09:00:00.000Z";

function run(chunks: CaiusTurnChunk[]): AssistantTurn {
    return chunks.reduce(applyChunk, { id: "t", blocks: [], done: false } as AssistantTurn);
}

function textOf(turn: AssistantTurn) {
    return turn.blocks.map((b) => b.type === "text" ? b.content : "").join("");
}

describe("applyChunk", () => {
    it("takes back narration streamed before a tool call and keeps it in the notes", () => {
        const turn = run([
            { type: "text", content: "Let me " },
            { type: "text", content: "check." },
            { type: "text_retract" },
            { type: "tool_use", toolCallId: "a", toolName: "caius_planday", toolInput: {} },
            { type: "tool_result", toolCallId: "a", toolName: "caius_planday", result: "{}" },
            { type: "text", content: "Here's your day." },
            { type: "done" }
        ]);
        expect(textOf(turn)).toBe("Here's your day.");
        expect(turn.notes).toEqual([ "Let me check." ]);
        expect(turn.blocks.map((b) => b.type)).toEqual([ "tool_call", "text" ]);
    });

    it("keeps each stretch of thinking as one note, in order with the taken-back text", () => {
        const turn = run([
            { type: "thinking", content: "He asked for " },
            { type: "thinking", content: "today." },
            { type: "text", content: "Let me look." },
            { type: "text_retract" },
            { type: "tool_result", toolCallId: "a", toolName: "caius_planday", result: "{}" },
            { type: "thinking", content: "Three meetings." },
            { type: "text", content: "Here's your day." },
            { type: "done" }
        ]);
        expect(turn.notes).toEqual([ "He asked for today.", "Let me look.", "Three meetings." ]);
        expect(textOf(turn)).toBe("Here's your day.");
    });

    it("leaves a turn without its done chunk unfinished, which the chat shows as cut off", () => {
        const turn = run([ { type: "text", content: "Here's what's" } ]);
        expect(turn.done).toBe(false);
        expect(applyChunk(turn, { type: "done" }).done).toBe(true);
    });
});

describe("turnMessages", () => {
    it("stores the notes as a thinking message just before the reply", () => {
        const turn = run([
            { type: "thinking", content: "One." },
            { type: "text", content: "Let me look." },
            { type: "text_retract" },
            { type: "text", content: "Done." },
            { type: "done" }
        ]);
        expect(turnMessages(turn, AT)).toEqual([
            { id: "t-notes", role: "assistant", content: "One.\n\nLet me look.", createdAt: AT, type: "thinking" },
            { id: "t", role: "assistant", content: [ { type: "text", content: "Done." } ], createdAt: AT }
        ]);
    });

    it("stores a reply without notes as the reply alone", () => {
        const turn = run([ { type: "text", content: "Hi." }, { type: "done" } ]);
        expect(turnMessages(turn, AT)).toEqual([
            { id: "t", role: "assistant", content: [ { type: "text", content: "Hi." } ], createdAt: AT }
        ]);
    });

    it("stores a failed turn as an error message with no notes", () => {
        const turn = run([ { type: "thinking", content: "One." }, { type: "error", error: "Boom" } ]);
        expect(turnMessages(turn, AT)).toEqual([
            { id: "t", role: "assistant", content: "Boom", createdAt: AT, type: "error" }
        ]);
    });

    it("marks the reply of a turn still running as partial", () => {
        const turn = run([ { type: "thinking", content: "One." }, { type: "text", content: "Half" } ]);
        const [ notes, reply ] = turnMessages(turn, AT, { partial: true });
        expect(notes.partial).toBeUndefined();
        expect(reply).toEqual({ id: "t", role: "assistant", content: [ { type: "text", content: "Half" } ], createdAt: AT, partial: true });
    });
});
