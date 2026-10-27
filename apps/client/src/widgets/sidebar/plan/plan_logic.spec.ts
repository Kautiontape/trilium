import { describe, expect, it } from "vitest";

import type { CaiusPlan, CaiusPlanTask } from "../../../services/caius";
import froca from "../../../services/froca";
import { buildNote } from "../../../test/easy-froca";
import {
    acceptSections, capacityStatus, closeCandidates, closeFates, fateTarget, groupFates,
    isCloseable, listedFates, parsePeriodKey, periodKey, periodOfNote, stepPeriod, taskLabel,
    unestimatedTasks, type ViewedPeriod
} from "./plan_logic";

const NOW = new Date(2026, 9, 27, 10, 0);

describe("plan periods", () => {
    it("follows a day, week or month note, or its child, and falls back to today", () => {
        const week = buildNote({
            title: "Week 44",
            "#weekNote": "2026-W44",
            children: [ { id: "weekChild", title: "Child" } ]
        });
        const child = froca.notes["weekChild"];
        const of = (labels: Record<`#${string}`, string>) =>
            keyOf(periodOfNote(buildNote({ title: "N", ...labels }), NOW));
        expect(of({ "#dateNote": "2026-10-20" })).toBe("day 2026-10-20");
        expect(keyOf(periodOfNote(week, NOW))).toBe("week 2026-W44");
        expect(keyOf(periodOfNote(child, NOW))).toBe("week 2026-W44");
        expect(of({ "#monthNote": "2026-09" })).toBe("month 2026-09");
        expect(of({})).toBe("day 2026-10-27");
        expect(keyOf(periodOfNote(null, NOW))).toBe("day 2026-10-27");
        expect(of({ "#dateNote": "2026-02-30" })).toBe("day 2026-10-27");
    });

    it("parses keys only for periods that exist", () => {
        expect(parsePeriodKey("week", "2026-W53")).toEqual(new Date(2026, 11, 28));
        expect(parsePeriodKey("week", "2027-W01")).toEqual(new Date(2027, 0, 4));
        expect(parsePeriodKey("week", "2025-W01")).toEqual(new Date(2024, 11, 30));
        expect(parsePeriodKey("week", "2025-W53")).toBeNull();
        expect(parsePeriodKey("month", "2026-13")).toBeNull();
        expect(parsePeriodKey("day", "2028-02-29")).toEqual(new Date(2028, 1, 29));
        expect(parsePeriodKey("day", "2026-W44")).toBeNull();
    });

    it("steps across month and year ends and ISO week years", () => {
        expect(steps("day", "2026-12-31", 1)).toBe("2027-01-01");
        expect(steps("day", "2026-03-01", -1)).toBe("2026-02-28");
        expect(steps("week", "2026-W53", 1)).toBe("2027-W01");
        expect(steps("week", "2026-W01", -1)).toBe("2025-W52");
        expect(steps("week", "2020-W52", 1)).toBe("2020-W53");
        expect(steps("month", "2026-12", 1)).toBe("2027-01");
        expect(steps("month", "2026-01", -1)).toBe("2025-12");
        // A day late in a month steps by whole months, not by 31 days.
        const lateInJanuary = { kind: "month" as const, anchor: new Date(2026, 0, 31) };
        expect(periodKey(stepPeriod(lateInJanuary, 1))).toBe("2026-02");
        // Switching kind keeps the day: 1 January 2027 is in the last week of 2026.
        expect(periodKey({ kind: "week", anchor: new Date(2027, 0, 1) })).toBe("2026-W53");
    });

    it("is closeable when past, today from 15:00, or the current week or month", () => {
        const at = (hour: number) => new Date(2026, 9, 27, hour, 0);
        const day = (key: string) => period("day", key);
        expect(isCloseable(day("2026-10-26"), at(9))).toBe(true);
        expect(isCloseable(day("2026-10-27"), at(14))).toBe(false);
        expect(isCloseable(day("2026-10-27"), at(15))).toBe(true);
        expect(isCloseable(day("2026-10-28"), at(23))).toBe(false);
        expect(isCloseable(period("week", "2026-W44"), at(9))).toBe(true);
        expect(isCloseable(period("week", "2026-W43"), at(9))).toBe(true);
        expect(isCloseable(period("week", "2026-W45"), at(9))).toBe(false);
        expect(isCloseable(period("month", "2026-10"), at(9))).toBe(true);
        expect(isCloseable(period("month", "2026-11"), at(9))).toBe(false);
        expect(isCloseable(period("month", "2025-12"), at(9))).toBe(true);
    });
});

describe("plan tasks", () => {
    const plan = planOf([
        task({ listItemId: "a", text: "Parent" }),
        task({ listItemId: "a1", text: "Sub one", parent: "Parent", parentListItemId: "a" }),
        task({
            listItemId: "a2", text: "Sub two", parent: "Parent", parentListItemId: "a",
            estMinutes: 15
        }),
        task({ listItemId: "b", text: "Estimated", estMinutes: 45 }),
        task({ listItemId: "c", text: "Doing", state: "in_progress" }),
        task({ listItemId: "d", text: "Done", state: "done" }),
        task({ listItemId: "e", text: "Done parent", state: "done" }),
        task({
            listItemId: "e1", text: "Orphan", parent: "Done parent", parentListItemId: "e",
            estMinutes: 10
        })
    ], [ task({ listItemId: "k", text: "Critical", critical: true }) ]);

    it("lists the unestimated tasks the capacity counts, through sub-items", () => {
        // The server counts Sub one, Doing and Critical; Parent counts through its sub-items.
        expect(unestimatedTasks(plan).map((t) => t.listItemId)).toEqual([ "k", "a1", "c" ]);
    });

    it("tells a sub-item's parent by its id, not by its text", () => {
        // Two live tasks and a done one share a name; only the done one has a live sub-item.
        const emails = planOf([
            task({ listItemId: "m1", text: "Email" }),
            task({ listItemId: "m2", text: "Email" }),
            task({ listItemId: "m3", text: "Email", state: "done" }),
            task({
                listItemId: "m3a", text: "Reply to Ann", parent: "Email", parentListItemId: "m3"
            }),
            task({
                listItemId: "m1a", text: "Reply to Bo", parent: "Email", parentListItemId: "m1"
            })
        ]);
        expect(closeCandidates(emails).map((t) => t.listItemId)).toEqual([ "m1", "m2", "m3a" ]);
    });

    it("asks a fate of every live task its parent does not carry", () => {
        expect(closeCandidates(plan).map((t) => t.listItemId))
            .toEqual([ "k", "a", "b", "c", "e1" ]);
    });

    it("rates capacity against the target", () => {
        const capacity = (totalMinutes: number, target: { min: number; max: number } | null) =>
            capacityStatus({ ...plan.capacity, totalMinutes, target });
        expect(capacity(120, { min: 180, max: 240 })).toBe("under");
        expect(capacity(180, { min: 180, max: 240 })).toBe("within");
        expect(capacity(241, { min: 180, max: 240 })).toBe("over");
        expect(capacity(900, null)).toBe("none");
    });

    it("offers the note's headings for Accept, without Suggested or repeats", () => {
        const html = "<h2>Morning</h2><ul><li>x</li></ul><h2> Deep&nbsp;work </h2><h3></h3>"
            + "<h2>Morning</h2><h2>💡 Suggested</h2>";
        expect(acceptSections(html)).toEqual([ "Morning", "Deep work" ]);
    });

    it("shows a Markdown link in a task's text as its label", () => {
        expect(taskLabel("Forward me [from Sunday 25](#root/irdD0L4zQixz) and [x](y)"))
            .toBe("Forward me from Sunday 25 and x");
        expect(taskLabel("Plain [brackets] (and parens)")).toBe("Plain [brackets] (and parens)");
    });

    it("groups the decided fates into one forward call and one drop call", () => {
        const calls = groupFates("day", {
            a: { kind: "tomorrow" },
            b: { kind: "next_week" },
            c: { kind: "drop", reason: "  Not needed " },
            d: { kind: "drop", reason: "  " },
            e: { kind: "next_month" }
        }, new Date(2026, 11, 31, 18), "day");
        expect(calls).toEqual({
            forward: [
                { noteId: "day", listItemId: "a", to: "2027-01-01" },
                { noteId: "day", listItemId: "b", to: "2027-W01" },
                { noteId: "day", listItemId: "e", to: "2027-01" }
            ],
            drop: [ { noteId: "day", listItemId: "c", state: "cancelled", reason: "Not needed" } ]
        });
        expect(groupFates("day", { d: { kind: "drop" } }, NOW, "day"))
            .toEqual({ forward: [], drop: [] });
    });

    it("keeps only the fates of tasks still listed", () => {
        const fates = {
            kept: { kind: "tomorrow" as const }, gone: { kind: "drop" as const, reason: "x" }
        };
        expect(listedFates(fates, [ { listItemId: "kept" }, { listItemId: undefined } ]))
            .toEqual({ kept: { kind: "tomorrow" } });
    });

    it("offers the current period first when closing a past one, and sends tasks there", () => {
        const later = [ "tomorrow", "next_week", "next_month", "drop" ];
        expect(closeFates("day", "2026-10-26", NOW)).toEqual([ "current", ...later ]);
        expect(closeFates("day", "2026-10-27", NOW)).toEqual(later);
        expect(closeFates("week", "2026-W43", NOW)).toEqual([ "current", ...later ]);
        expect(closeFates("week", "2026-W44", NOW)).toEqual(later);
        expect(closeFates("month", "2026-09", NOW)).toEqual([ "current", ...later ]);
        expect(closeFates("month", "2026-10", NOW)).toEqual(later);

        expect(fateTarget("current", NOW, "day")).toBe("2026-10-27");
        expect(fateTarget("current", NOW, "week")).toBe("2026-W44");
        expect(fateTarget("current", NOW, "month")).toBe("2026-10");
        expect(groupFates("week", { a: { kind: "current" } }, NOW, "week").forward)
            .toEqual([ { noteId: "week", listItemId: "a", to: "2026-W44" } ]);
    });
});

function period(kind: ViewedPeriod["kind"], key: string): ViewedPeriod {
    const anchor = parsePeriodKey(kind, key);
    if (!anchor) throw new Error(`bad key ${key}`);
    return { kind, anchor };
}

function steps(kind: ViewedPeriod["kind"], key: string, delta: number) {
    return periodKey(stepPeriod(period(kind, key), delta));
}

function keyOf(viewed: ViewedPeriod) {
    return `${viewed.kind} ${periodKey(viewed)}`;
}

function task(overrides: Partial<CaiusPlanTask>): CaiusPlanTask {
    return {
        noteId: "day", listItemId: null, state: "open", text: "", estMinutes: null, parent: null,
        parentListItemId: null, section: "Morning", critical: false, ...overrides
    };
}

function planOf(tasks: CaiusPlanTask[], critical: CaiusPlanTask[] = []): CaiusPlan {
    return {
        period: "day", key: "2026-10-27", noteId: "day", critical,
        sections: [ { name: "Morning", kind: "slot", tasks } ],
        top3: [], suggested: [], dismissed: [],
        capacity: {
            plannedMinutes: 0, estimatedCount: 0, unestimatedCount: 0, unestimatedMinutes: 0,
            totalMinutes: 0, target: { min: 180, max: 240 }, horizons: {}
        }
    };
}
