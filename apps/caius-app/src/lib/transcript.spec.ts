import { describe, expect, it } from "vitest";

import type { StoredMessage } from "./chat.js";
import { chatTranscript, RESULT_LIMIT } from "./transcript.js";

const messages: StoredMessage[] = [
    { id: "1", role: "user", content: "Wind down 2026-11-04", createdAt: "2026-11-04T20:00:00.000Z" },
    { id: "2-notes", role: "assistant", content: "Check what is still open.", createdAt: "2026-11-04T20:00:05.000Z", type: "thinking" },
    {
        id: "2", role: "assistant", createdAt: "2026-11-04T20:00:06.000Z", content: [
            { type: "tool_call", toolCall: { id: "t1", toolName: "caius_winddown", input: { date: "2026-11-04", step: "open" }, result: "x".repeat(RESULT_LIMIT + 500) } },
            { type: "text", content: "Three things are still open." }
        ]
    },
    { id: "3", role: "user", content: "I'll forward the rest.\n\nForward the report.", createdAt: "2026-11-04T20:01:00.000Z" }
];

describe("chatTranscript", () => {
    const text = chatTranscript({ kind: "winddown", date: "2026-11-04", effort: "high", appVersion: "1.0 (3)", exportedAt: new Date("2026-11-04T21:00:00.000Z"), messages });

    it("opens with the kind, date, version, effort and export time", () => {
        expect(text.split("\n").slice(0, 4)).toEqual([
            "Caius chat: Wind down, 2026-11-04", "App version: 1.0 (3)", "Effort: high", "Exported: 2026-11-04T21:00:00.000Z"
        ]);
    });

    it("prints each message in order, with notes marked", () => {
        const headings = text.split("\n").filter((l) => l.startsWith("--- "));
        expect(headings.map((h) => h.replace(/ \(.*$/, ""))).toEqual([ "--- Shawn", "--- Caius's notes", "--- Caius", "--- Shawn" ]);
        expect(text).toContain("--- Caius's notes (thinking) (");
        expect(text).toContain("Check what is still open.");
        expect(text).toContain("Three things are still open.");
        expect(text).toContain("I'll forward the rest.\n\nForward the report.");
    });

    it("shows a tool call with its input and cuts a long result", () => {
        expect(text).toContain('[tool call] caius_winddown {"date":"2026-11-04","step":"open"}');
        expect(text).toContain(`[tool result] ${"x".repeat(RESULT_LIMIT)}… [cut, ${RESULT_LIMIT + 500} chars in all]`);
        expect(text).not.toContain("x".repeat(RESULT_LIMIT + 1));
    });
});
