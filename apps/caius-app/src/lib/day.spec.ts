import { describe, expect, it } from "vitest";

import { dayMinutes, flipOffer } from "./day.js";

const rhythm = { rollover: "04:00" };
const monday = (hours: number, minutes: number) => new Date(2026, 10, 16, hours, minutes);

describe("flipOffer and dayMinutes", () => {
    it("offers Start before the rollover with no label, and reads the small hours as the previous day", () => {
        expect(flipOffer(monday(0, 30), rhythm, null)).toEqual({ kind: "start", day: "Monday" });
        expect(flipOffer(monday(3, 59), rhythm, undefined)).toEqual({ kind: "start", day: "Monday" });
        expect(dayMinutes(monday(0, 30), rhythm, null)).toBe(24 * 60 + 30);
        expect(dayMinutes(monday(3, 59), rhythm)).toBe(24 * 60 + 239);
    });

    it("offers Back while the label counts, and reads the clock from midnight", () => {
        const started = "2026-11-16T00:20:00";
        expect(flipOffer(monday(0, 30), rhythm, started)).toEqual({ kind: "back", day: "Sunday" });
        expect(flipOffer(monday(3, 59), rhythm, started)).toEqual({ kind: "back", day: "Sunday" });
        expect(dayMinutes(monday(0, 30), rhythm, started)).toBe(30);
        expect(dayMinutes(monday(3, 59), rhythm, started)).toBe(239);
    });

    it("offers nothing from the rollover on, and reads the plain clock", () => {
        const started = "2026-11-16T00:20:00";
        for (const label of [ null, started ]) {
            expect(flipOffer(monday(4, 0), rhythm, label)).toBeNull();
            expect(flipOffer(monday(23, 0), rhythm, label)).toBeNull();
            expect(dayMinutes(monday(4, 0), rhythm, label)).toBe(240);
        }
    });

    it("offers nothing with a rollover of midnight, and ignores a label from another date", () => {
        expect(flipOffer(monday(0, 30), { rollover: "00:00" }, null)).toBeNull();
        expect(flipOffer(monday(0, 30), rhythm, "2026-11-15T00:20:00")).toEqual({ kind: "start", day: "Monday" });
        expect(dayMinutes(monday(0, 30), rhythm, "2026-11-15T00:20:00")).toBe(24 * 60 + 30);
    });
});
