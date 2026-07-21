import { describe, expect, it } from "vitest";

import { detectLevel, isValidValue } from "./journal_navigation.js";

/** Minimal stand-in for FNote — detectLevel only needs getOwnedLabelValue. */
function fakeNote(labels: Record<string, string>) {
    return {
        getOwnedLabelValue: (name: string) => labels[name] ?? null
    };
}

describe("isValidValue", () => {
    it("accepts well-formed values for each level", () => {
        expect(isValidValue("day", "2026-07-20")).toBe(true);
        expect(isValidValue("week", "2026-W30")).toBe(true);
        expect(isValidValue("month", "2026-07")).toBe(true);
        expect(isValidValue("quarter", "2026-Q3")).toBe(true);
        expect(isValidValue("year", "2026")).toBe(true);
    });

    it("rejects malformed values", () => {
        expect(isValidValue("day", "someday")).toBe(false);
        expect(isValidValue("day", "2026-02-30")).toBe(false);
        expect(isValidValue("day", "")).toBe(false);
        expect(isValidValue("month", "2026-7")).toBe(false);
        expect(isValidValue("week", "2026-W1")).toBe(false);
        expect(isValidValue("quarter", "2026-Q5")).toBe(false);
        expect(isValidValue("year", "26")).toBe(false);
    });
});

describe("detectLevel", () => {
    it("detects each level from its owned label", () => {
        expect(detectLevel(fakeNote({ dateNote: "2026-07-20" }))).toEqual({ level: "day", value: "2026-07-20" });
        expect(detectLevel(fakeNote({ weekNote: "2026-W30" }))).toEqual({ level: "week", value: "2026-W30" });
        expect(detectLevel(fakeNote({ monthNote: "2026-07" }))).toEqual({ level: "month", value: "2026-07" });
        expect(detectLevel(fakeNote({ quarterNote: "2026-Q3" }))).toEqual({ level: "quarter", value: "2026-Q3" });
        expect(detectLevel(fakeNote({ yearNote: "2026" }))).toEqual({ level: "year", value: "2026" });
    });

    it("applies most-specific-first precedence when several labels are present", () => {
        const note = fakeNote({ dateNote: "2026-07-20", monthNote: "2026-07", yearNote: "2026" });
        expect(detectLevel(note)).toEqual({ level: "day", value: "2026-07-20" });
    });

    it("returns null for a note with no calendar label or a malformed one", () => {
        expect(detectLevel(fakeNote({}))).toBeNull();
        expect(detectLevel(fakeNote({ dateNote: "someday" }))).toBeNull();
    });
});
