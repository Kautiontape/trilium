import { describe, expect, it } from "vitest";

import { carryQuestion } from "./daily.js";

describe("carryQuestion", () => {
    it("names up to four lines in one question, into next week or within the week", () => {
        expect(carryQuestion([ "A" ], false)).toBe("Carry 'A' into next week?");
        expect(carryQuestion([ "A", "B", "C" ], true)).toBe("Keep 'A', 'B' and 'C' going?");
        expect(carryQuestion([ "A", "B", "C", "D", "E", "F" ], false)).toBe("Carry 'A', 'B', 'C', 'D' …and 2 more into next week?");
    });
});
