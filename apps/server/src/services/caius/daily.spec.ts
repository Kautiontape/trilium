import { describe, expect, it } from "vitest";

import { carryQuestion, fitted, MAX_REPLY_CHARS } from "./daily.js";

describe("carryQuestion", () => {
    it("names up to four lines in one question, into next week or within the week", () => {
        expect(carryQuestion([ "A" ], false)).toBe("Carry 'A' into next week?");
        expect(carryQuestion([ "A", "B", "C" ], true)).toBe("Keep 'A', 'B' and 'C' going?");
        expect(carryQuestion([ "A", "B", "C", "D", "E", "F" ], false)).toBe("Carry 'A', 'B', 'C', 'D' …and 2 more into next week?");
    });
});

describe("fitted", () => {
    it("cuts a step's longest lists until the reply is under the size the sidebar agent takes, and says how many it left out", () => {
        const reply = { step: "next", data: { candidates: Array.from({ length: 400 }, (_, i) => ({ text: `Get ZAP-${i} done`, because: "sitting in QA Testing for 3 days" })), overlaps: [ { first: "A", second: "B" } ] } };
        const fit = fitted(reply);
        expect(JSON.stringify(fit).length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
        expect(fit.data.candidates.length).toBeGreaterThan(100);
        expect(fit.data.omitted).toEqual({ candidates: 400 - fit.data.candidates.length });
        expect(fit.data.overlaps).toEqual(reply.data.overlaps);
        expect(fitted({ step: "next", data: { candidates: [] } })).toEqual({ step: "next", data: { candidates: [] } });
    });
});
