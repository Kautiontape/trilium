import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./local.js";
import { NUDGE_IDS, plannedNudges, SNOOZE_IDS, staleSnoozes } from "./notify.js";
import type { TodayData } from "./store.js";

function today(overrides: Partial<TodayData> = {}, state: "unplanned" | "planned" | "wound_down" = "unplanned"): TodayData {
    return {
        key: "2026-11-04",
        label: "Wed 4 Nov",
        plan: {
            period: "day", key: "2026-11-04", noteId: "n1", critical: [], sections: [], top3: [], onDeck: [], suggested: [], dismissed: [],
            capacity: { plannedMinutes: 0, estimatedCount: 0, unestimatedCount: 0, unestimatedMinutes: 0, totalMinutes: 0, eveningMinutes: 0, onDeckMinutes: 0, target: { min: 180, max: 240 }, horizons: {} },
            meetings: [], context: [], expiredContext: [], pendingContext: []
        },
        catchup: null,
        rhythm: { start: "09:30", end: "23:00", workEnd: "17:30", rollover: "04:00", from: { start: "rhythm", end: "rhythm", workEnd: "rhythm", rollover: "rhythm" } },
        nudge: { date: "2026-11-04", lastWorkday: "2026-11-03", state } as TodayData["nudge"],
        asOf: "2026-11-04T08:00:00.000Z",
        offline: false,
        ...overrides
    };
}

const ids = (nudges: ReturnType<typeof plannedNudges>) => nudges.map((n) => [ n.id, n.schedule?.at?.toString() ]);

describe("plannedNudges", () => {
    it("schedules today's nudges and the next workday's morning nudge ahead", () => {
        const nudges = plannedNudges(today(), DEFAULT_SETTINGS, new Date(2026, 10, 4, 8, 0));
        expect(ids(nudges)).toEqual([
            [ NUDGE_IDS.plan, new Date(2026, 10, 4, 9, 10).toString() ],
            [ NUDGE_IDS.winddown, new Date(2026, 10, 4, 17, 30).toString() ],
            [ NUDGE_IDS.nextPlan, new Date(2026, 10, 5, 9, 10).toString() ]
        ]);
    });

    it("still has the next workday's nudge after a wind-down on a Friday, and none offline", () => {
        const friday = today({ key: "2026-11-06" }, "wound_down");
        expect(ids(plannedNudges(friday, DEFAULT_SETTINGS, new Date(2026, 10, 6, 21, 0))))
            .toEqual([ [ NUDGE_IDS.nextPlan, new Date(2026, 10, 9, 9, 10).toString() ] ]);
        expect(plannedNudges(today({ offline: true }), DEFAULT_SETTINGS, new Date(2026, 10, 4, 8, 0))).toEqual([]);
    });

    it("cancels a snoozed morning nudge once the day is planned, and both once it is wound down", () => {
        expect(staleSnoozes("unplanned")).toEqual([]);
        expect(staleSnoozes("planned")).toEqual([ SNOOZE_IDS.plan ]);
        expect(staleSnoozes("wound_down")).toEqual([ SNOOZE_IDS.plan, SNOOZE_IDS.winddown ]);
        expect(staleSnoozes(undefined)).toEqual([]);
    });
});
