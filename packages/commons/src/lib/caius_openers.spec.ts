import { describe, expect, it } from "vitest";

import { caiusConversationOf, caiusConversationOfMessages, caiusOpener } from "./caius_openers.js";

describe("Caius openers", () => {
    it("writes each kind's opener and reads it back", () => {
        expect(caiusOpener("plan", "2026-11-04")).toBe("Plan my day 2026-11-04");
        expect(caiusOpener("winddown", "2026-11-04")).toBe("Wind down 2026-11-04");
        expect(caiusOpener("ask", "2026-11-04")).toBe("Ask 2026-11-04");
        for (const kind of [ "plan", "winddown", "ask" ] as const) {
            expect(caiusConversationOf(caiusOpener(kind, "2026-11-04"))).toBe(kind);
        }
    });

    it("reads only an exact opener, ignoring surrounding space", () => {
        expect(caiusConversationOf("  Ask 2026-11-04\n")).toBe("ask");
        expect(caiusConversationOf("Ask 2026-11-04 what's next?")).toBeNull();
        expect(caiusConversationOf("Ask me anything")).toBeNull();
        expect(caiusConversationOf("ask 2026-11-04")).toBeNull();
        expect(caiusConversationOf("Plan my day")).toBeNull();
        expect(caiusConversationOf("Wind down 2026-11-4")).toBeNull();
        expect(caiusConversationOf("")).toBeNull();
    });

    it("reads a chat's first user message, and only an opener on its own", () => {
        const ask = { role: "user" as const, content: "Ask 2026-11-04" };
        expect(caiusConversationOfMessages([ ask ])).toBe("ask");
        expect(caiusConversationOfMessages([ { role: "user", content: [ { type: "text", text: "Wind down 2026-11-04" } ] } ])).toBe("winddown");
        expect(caiusConversationOfMessages([ { role: "assistant", content: "Hi" }, ask, { role: "user", content: "and tomorrow?" } ])).toBe("ask");

        expect(caiusConversationOfMessages([ { role: "user", content: [ { type: "text", text: "Ask " }, { type: "text", text: "2026-11-04" } ] } ])).toBeNull();
        expect(caiusConversationOfMessages([ { role: "user", content: [
            { type: "text", text: "Ask 2026-11-04" }, { type: "image", attachmentId: "a1", mime: "image/png" }
        ] } ])).toBeNull();
        expect(caiusConversationOfMessages([ { role: "user", content: [] } ])).toBeNull();
        expect(caiusConversationOfMessages([ { role: "assistant", content: "Ask 2026-11-04" } ])).toBeNull();
        expect(caiusConversationOfMessages([])).toBeNull();
    });
});
