import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { carryQuestion, fitted, MAX_REPLY_CHARS, withoutMoveLinks } from "./daily.js";

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
