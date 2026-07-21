import { DEFAULT_WEEK_SETTINGS } from "@triliumnext/commons";
import { describe, expect, it } from "vitest";

import { detectLevel, isValidValue, stepValue } from "./journal_navigation.js";

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

describe("stepValue — day", () => {
    it("steps forward and back, rolling over month and year boundaries", () => {
        expect(stepValue("day", "2026-07-20", 1, DEFAULT_WEEK_SETTINGS)).toBe("2026-07-21");
        expect(stepValue("day", "2026-07-20", -1, DEFAULT_WEEK_SETTINGS)).toBe("2026-07-19");
        expect(stepValue("day", "2026-07-31", 1, DEFAULT_WEEK_SETTINGS)).toBe("2026-08-01");
        expect(stepValue("day", "2026-12-31", 1, DEFAULT_WEEK_SETTINGS)).toBe("2027-01-01");
        expect(stepValue("day", "2026-01-01", -1, DEFAULT_WEEK_SETTINGS)).toBe("2025-12-31");
        expect(stepValue("day", "2024-02-28", 1, DEFAULT_WEEK_SETTINGS)).toBe("2024-02-29");
    });
});

describe("stepValue — month, quarter, year", () => {
    it("rolls month over the year boundary and keeps zero padding", () => {
        expect(stepValue("month", "2026-07", 1, DEFAULT_WEEK_SETTINGS)).toBe("2026-08");
        expect(stepValue("month", "2026-12", 1, DEFAULT_WEEK_SETTINGS)).toBe("2027-01");
        expect(stepValue("month", "2026-01", -1, DEFAULT_WEEK_SETTINGS)).toBe("2025-12");
        expect(stepValue("month", "2026-09", 1, DEFAULT_WEEK_SETTINGS)).toBe("2026-10");
    });

    it("rolls quarter over the year boundary and stays unpadded", () => {
        expect(stepValue("quarter", "2026-Q3", 1, DEFAULT_WEEK_SETTINGS)).toBe("2026-Q4");
        expect(stepValue("quarter", "2026-Q4", 1, DEFAULT_WEEK_SETTINGS)).toBe("2027-Q1");
        expect(stepValue("quarter", "2026-Q1", -1, DEFAULT_WEEK_SETTINGS)).toBe("2025-Q4");
    });

    it("steps the year", () => {
        expect(stepValue("year", "2026", 1, DEFAULT_WEEK_SETTINGS)).toBe("2027");
        expect(stepValue("year", "2026", -1, DEFAULT_WEEK_SETTINGS)).toBe("2025");
    });

    it("returns null for a malformed value rather than guessing", () => {
        expect(stepValue("day", "someday", 1, DEFAULT_WEEK_SETTINGS)).toBeNull();
        expect(stepValue("month", "2026-7", 1, DEFAULT_WEEK_SETTINGS)).toBeNull();
    });
});
