import { describe, expect, it } from "vitest";

import { carryQuestion } from "./daily.js";

describe("carryQuestion", () => {
    it("names up to four lines in one question, into next week or into the next day", () => {
        expect(carryQuestion([ "A" ], false, "Monday")).toBe("Carry 'A' into next week?");
        expect(carryQuestion([ "A", "B", "C" ], true, "Wednesday")).toBe("Keep 'A', 'B' and 'C' going into Wednesday?");
        expect(carryQuestion([ "A", "B", "C", "D", "E", "F" ], false, "Monday")).toBe("Carry 'A', 'B', 'C', 'D' …and 2 more into next week?");
    });
});
