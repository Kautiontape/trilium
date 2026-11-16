import { describe, expect, it } from "vitest";

import { weekPlace } from "./writes.js";

// Wednesday 25 Nov 2026, in ISO week 2026-W48.
const DATE = "2026-11-25";
const W48 = "2026-W48";
const W49 = "2026-W49";

describe("weekPlace, a line naming one weekday", () => {
    const day = (week: string, date: string) => ({ week, from: date, until: date });

    it("places it on that day: later this week, today, or next week when the day is past", () => {
        const cases: [ string, ReturnType<typeof weekPlace> ][] = [
            [ "Riley is out Thursday", day(W48, "2026-11-26") ],
            [ "Riley is out thursday", day(W48, "2026-11-26") ],
            [ "Riley is out Thu", day(W48, "2026-11-26") ],
            [ "Riley is out Wednesday", day(W48, "2026-11-25") ],
            [ "Pat is out Monday", day(W49, "2026-11-30") ],
            [ "Pat is out Mon", day(W49, "2026-11-30") ],
            [ "Riley is out next Friday", day(W49, "2026-12-04") ],
            [ "Riley is out next Thursday", day(W49, "2026-12-03") ],
            [ "Riley is out next Wednesday", day(W49, "2026-12-02") ],
            [ "ABC-12 ships Tuesday", day(W49, "2026-12-01") ],
            [ "Fix the sun panel Tuesday", day(W49, "2026-12-01") ],
            [ "I sat in on Tuesday standup", day(W49, "2026-12-01") ]
        ];
        for (const [ text, placed ] of cases) expect(weekPlace(text, DATE), text).toEqual(placed);
    });

    it("leaves a plural, a dated day, a day after until/since/from, two days and ordinary words to the other rules", () => {
        const state = { week: W48, until: DATE };
        const cases: [ string, ReturnType<typeof weekPlace> ][] = [
            [ "Ana is out Tuesdays", state ],
            [ "Vendor freeze since Monday", state ],
            [ "Code freeze from Wednesday", state ],
            [ "Ana is out Tue 24 Nov", state ],
            [ "Ana is out Tue, 24 Nov", state ],
            [ "Ana is out Tuesday, 24 Nov", state ],
            [ "Ana is out Tuesday and Thursday", state ],
            [ "Ana is out until Friday", { week: W48 } ],
            [ "Sam is out Thu–Fri", { week: W48, from: "2026-11-26", until: "2026-11-27" } ],
            [ "I sat with Ana", null ],
            [ "Demo Tuesday at 15:00", null ],
            [ "Fix the monitoring alert", null ],
            [ "A friend is sunny", null ]
        ];
        for (const [ text, placed ] of cases) expect(weekPlace(text, DATE), text).toEqual(placed);
    });
});
