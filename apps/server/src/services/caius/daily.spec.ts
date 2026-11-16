import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { carryQuestion, fitted, isReview, MAX_REPLY_CHARS, namedDays, withoutMoveLinks } from "./daily.js";

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
        expect((fit.data as Record<string, unknown>).omitted).toEqual({ candidates: 400 - fit.data.candidates.length });
        expect(fit.data.overlaps).toEqual(reply.data.overlaps);
        expect(fitted({ step: "next", data: { candidates: [] } })).toEqual({ step: "next", data: { candidates: [] } });
    });
});

describe("withoutMoveLinks", () => {
    it("takes off only the links a forward adds, never his own words or links", () => {
        expect(withoutMoveLinks("Message Dave [from Friday 30](#root/abc) _scheduled [Tuesday 3](#root/def)_")).toBe("Message Dave");
        expect(withoutMoveLinks("Get a quote from Acme 2")).toBe("Get a quote from Acme 2");
        expect(withoutMoveLinks("See [Plan](#root/zz) scheduled Tuesday 3")).toBe("See [Plan](#root/zz) scheduled Tuesday 3");
    });
});

describe("the words Caius writes", () => {
    it("never say still, outstanding, unanswered or waiting, in any caius.daily, caius.brief or caius.say string", () => {
        const catalogue = JSON.parse(readFileSync(new URL("../../assets/translations/en/server.json", import.meta.url), "utf8")) as { caius: Record<string, Record<string, unknown>> };
        const strings = (value: unknown): string[] => typeof value === "string" ? [ value ] : Object.values(value as object).flatMap(strings);
        for (const group of [ "daily", "brief", "say" ] as const) {
            for (const text of strings(catalogue.caius[group])) expect(text, group).not.toMatch(/\b(?:still|outstanding|unanswered|waiting)\b/i);
        }
    });
});

describe("namedDays", () => {
    it("counts weeks, days and months from the target day in a catch-up review, and from the date otherwise", () => {
        const review = namedDays("2026-11-10", "2026-11-16");
        expect(review.weeks).toEqual([ { week: "2026-W47" }, { week: "2026-W48" } ]);
        expect(review.days.filter((day) => "ref" in day && "week" in day).map((day) => [ day.ref, "week" in day ? day.week : "" ])).toEqual([ [ "w1", "2026-W47" ], [ "w2", "2026-W48" ] ]);
        const dates = review.days.flatMap((day) => "date" in day ? [ day.date ] : []);
        expect(dates).toEqual([ "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27" ]);
        expect(review.months).toEqual([ { month: "2026-11" }, { month: "2026-12" }, { month: "2027-01" } ]);

        const plain = namedDays("2026-11-13", "2026-11-16");
        expect(plain.weeks).toEqual([ { week: "2026-W46" }, { week: "2026-W47" } ]);
        expect(plain.days.flatMap((day) => "date" in day ? [ day.date ] : [])).toEqual([ "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20" ]);

        const old = namedDays("2026-10-27", "2026-11-16");
        expect(old.days.flatMap((day) => "date" in day ? [ day.date ] : [])[0]).toBe("2026-11-16");

        const monday = namedDays("2026-11-13", "2026-11-16", true);
        expect(monday.weeks).toEqual([ { week: "2026-W47" }, { week: "2026-W48" } ]);
        expect(monday.days.flatMap((day) => "week" in day ? [ [ day.ref, day.week ] ] : [])).toEqual([ [ "w1", "2026-W47" ], [ "w2", "2026-W48" ] ]);
    });
});

describe("isReview", () => {
    it("is true for a catch-up review and for any wind-down of a day before today, false for one of today", () => {
        expect(isReview("2026-11-13", "2026-11-16", "2026-11-16")).toBe(true);
        expect(isReview("2026-11-13", "2026-11-16", "2026-11-13")).toBe(false);
        expect(isReview("2026-11-10", "2026-11-16", "2026-11-10")).toBe(true);
    });
});
