import { DEFAULT_WEEK_SETTINGS, type WeekSettings } from "@triliumnext/commons";
import { describe, expect, it } from "vitest";

import { detectLevel, expectedAncestors, isValidValue, stepValue } from "./journal_navigation.js";

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

/** Trilium's shipped default: first week contains Jan 1, weeks start Monday. */
const DEFAULTS: WeekSettings = { firstDayOfWeek: 1, firstWeekOfYear: 0, minDaysInFirstWeek: 4 };
/** ISO 8601: first week contains the first Thursday. */
const ISO: WeekSettings = { firstDayOfWeek: 1, firstWeekOfYear: 1, minDaysInFirstWeek: 4 };
/** Minimum-days rule with a full week required. */
const MIN_DAYS_7: WeekSettings = { firstDayOfWeek: 1, firstWeekOfYear: 2, minDaysInFirstWeek: 7 };
/** Sunday-start weeks. */
const SUNDAY: WeekSettings = { firstDayOfWeek: 7, firstWeekOfYear: 0, minDaysInFirstWeek: 4 };

describe("stepValue — week", () => {
    it("steps within a year", () => {
        expect(stepValue("week", "2026-W30", 1, DEFAULTS)).toBe("2026-W31");
        expect(stepValue("week", "2026-W30", -1, DEFAULTS)).toBe("2026-W29");
    });

    it("zero-pads single-digit week numbers", () => {
        expect(stepValue("week", "2026-W06", 1, DEFAULTS)).toBe("2026-W07");
        expect(stepValue("week", "2026-W10", -1, DEFAULTS)).toBe("2026-W09");
    });

    it("crosses the 2025/2026 boundary identically under every setting", () => {
        expect(stepValue("week", "2026-W01", -1, DEFAULTS)).toBe("2025-W52");
        expect(stepValue("week", "2026-W01", -1, ISO)).toBe("2025-W52");
        expect(stepValue("week", "2026-W01", -1, MIN_DAYS_7)).toBe("2025-W52");
        expect(stepValue("week", "2026-W01", -1, SUNDAY)).toBe("2025-W52");
    });

    it("yields a 53rd week only where the settings actually produce one", () => {
        // 2023 has 53 weeks under Trilium's defaults but 52 under the others.
        expect(stepValue("week", "2024-W01", -1, DEFAULTS)).toBe("2023-W53");
        expect(stepValue("week", "2024-W01", -1, ISO)).toBe("2023-W52");
        expect(stepValue("week", "2024-W01", -1, MIN_DAYS_7)).toBe("2023-W52");
        expect(stepValue("week", "2024-W01", -1, SUNDAY)).toBe("2023-W52");
    });

    it("round-trips forward and back", () => {
        for (const settings of [ DEFAULTS, ISO, MIN_DAYS_7, SUNDAY ]) {
            for (const week of [ "2026-W01", "2026-W30", "2026-W52", "2024-W01" ]) {
                const forward = stepValue("week", week, 1, settings);
                expect(forward).not.toBeNull();
                expect(stepValue("week", forward as string, -1, settings)).toBe(week);
            }
        }
    });

    it("returns null for a malformed week value", () => {
        expect(stepValue("week", "2026-W1", 1, DEFAULTS)).toBeNull();
        expect(stepValue("week", "not-a-week", 1, DEFAULTS)).toBeNull();
    });
});

describe("expectedAncestors", () => {
    it("returns coarse-to-fine ancestors for a day note", () => {
        expect(expectedAncestors("day", "2026-07-20", DEFAULTS, { week: true, quarter: true })).toEqual([
            { level: "year", labelName: "yearNote", value: "2026" },
            { level: "quarter", labelName: "quarterNote", value: "2026-Q3" },
            { level: "month", labelName: "monthNote", value: "2026-07" },
            { level: "week", labelName: "weekNote", value: "2026-W30" }
        ]);
    });

    it("omits levels the calendar root has not enabled", () => {
        expect(expectedAncestors("day", "2026-07-20", DEFAULTS, { week: false, quarter: false })).toEqual([
            { level: "year", labelName: "yearNote", value: "2026" },
            { level: "month", labelName: "monthNote", value: "2026-07" }
        ]);
    });

    it("returns only coarser levels than the note's own", () => {
        expect(expectedAncestors("month", "2026-07", DEFAULTS, { week: true, quarter: false })).toEqual([
            { level: "year", labelName: "yearNote", value: "2026" }
        ]);
        expect(expectedAncestors("year", "2026", DEFAULTS, { week: true, quarter: true })).toEqual([]);
    });

    it("derives a cross-year week's own year from its week-year, not its start date", () => {
        // 2026-W01 starts 2025-12-29, so it is filed under 2025-12 / 2025 in the tree,
        // but its own identity is 2026. The clone into 2026-01 is what the walk matches.
        expect(expectedAncestors("week", "2026-W01", DEFAULTS, { week: true, quarter: false })).toEqual([
            { level: "year", labelName: "yearNote", value: "2026" },
            { level: "month", labelName: "monthNote", value: "2026-01" }
        ]);
    });

    it("returns an empty list for a malformed value", () => {
        expect(expectedAncestors("day", "someday", DEFAULTS, { week: true, quarter: true })).toEqual([]);
    });
});
