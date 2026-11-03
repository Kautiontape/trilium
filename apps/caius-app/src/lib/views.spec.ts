import { dayLoad, liveMinutes } from "@triliumnext/caius/src/daily/load.js";
import type { DayViewData, DaysViewData, ItemViewData, ShownView, ViewTask } from "@triliumnext/caius/src/daily/views.js";
import { describe, expect, it } from "vitest";

import { slipLabel } from "../components/TaskRow.js";
import { dayGroups, dayTerrain, fateChoices, hasLiveSubItems, redraw, redrawRows, rowKey, type ViewAnswers, viewOf, viewPicks, viewReply } from "./views.js";

const FOCUS = { min: 180, max: 240 };
const GROWTH = { min: 30, max: 60 };

function row(listItemId: string, text: string, rest: Partial<ViewTask> = {}): ViewTask {
    return {
        noteId: "day1", listItemId, ref: `v${listItemId}`, text, state: "open", estMinutes: 30, parent: null, parentListItemId: null,
        section: null, critical: false, area: "foundation", block: null, at: null, period: { kind: "day", key: "2026-11-03" },
        place: "list", slips: 0, ...rest
    };
}

/** Foundation on the list 60 + 30 + 60 + 20 + 25 = 195; On deck 30; Growth 45; one Recharge. */
const TASKS: ViewTask[] = [
    row("a1", "Garage shelf", { estMinutes: 60, block: "morning" }),
    row("a2", "The ballot"),
    row("a3", "ZAP-2611 review", { estMinutes: 60, ticket: { key: "ZAP-2611", status: "In Review" } }),
    row("p", "Parent", { estMinutes: null }),
    row("s1", "First part", { estMinutes: 20, parent: "Parent", parentListItemId: "p" }),
    row("s2", "Second part", { estMinutes: 25, parent: "Parent", parentListItemId: "p" }),
    row("g", "Read a chapter", { estMinutes: 45, area: "growth", block: "evening" }),
    row("r", "Walk", { area: "recharge", block: "evening" }),
    row("d", "Deck thing", { place: "onDeck" })
];

function loadOf(tasks: ViewTask[]) {
    const list = tasks.filter((t) => t.place === "list");
    const deck = tasks.filter((t) => t.place === "onDeck");
    return dayLoad({
        foundation: liveMinutes(list, "foundation"),
        onDeck: liveMinutes(deck, "foundation"),
        growth: liveMinutes(list, "growth"),
        recharge: list.filter((t) => !t.parent && t.area === "recharge").length
    }, { focus: FOCUS, growthTarget: GROWTH });
}

const DAY: DayViewData = {
    date: "2026-11-03", dateLabel: "Tue 3 Nov", openOn: null, load: loadOf(TASKS), calendarFailed: false,
    capacity: { windowMinutes: 480, bookedMinutes: 60, openMinutes: 420 },
    span: { start: "09:00", noon: "12:00", workEnd: "17:00", end: "23:00" },
    meetings: [], drawn: null, unplacedMinutes: 0, tasks: TASKS, context: []
};
const DAY_VIEW: ShownView = { view: "day", title: "Tue 3 Nov", sentence: "3 h 15 m of 3–4 h.", data: DAY };

const key = (id: string) => rowKey({ noteId: "day1", listItemId: id });
const tap = (rows: ViewAnswers["rows"]): ViewAnswers => ({ rows });

describe("viewOf", () => {
    const call = (toolName: string, result: unknown, isError?: boolean) => ({ id: "c", toolName, input: {}, result: typeof result === "string" ? result : JSON.stringify(result), isError });

    it("reads a caius_show result, plain or in an MCP envelope, with or without the server prefix", () => {
        expect(viewOf(call("caius_show", DAY_VIEW))).toEqual(DAY_VIEW);
        expect(viewOf(call("mcp__trilium__caius_show", { content: [ { type: "text", text: JSON.stringify(DAY_VIEW) } ] }))).toEqual(DAY_VIEW);
        expect(viewOf(call("mcp__trilium-notes__caius_show", DAY_VIEW))?.view).toBe("day");
    });

    it("rejects other tools, errors and results that are not views", () => {
        expect(viewOf(call("caius_plan", DAY_VIEW))).toBeNull();
        expect(viewOf(call("caius_show", DAY_VIEW, true))).toBeNull();
        expect(viewOf(call("caius_show", { error: "not_found" }))).toBeNull();
        expect(viewOf(call("caius_show", { view: "board", title: "", sentence: "", data: {} }))).toBeNull();
        expect(viewOf(call("caius_show", { view: "day", title: "", sentence: "" }))).toBeNull();
        expect(viewOf(call("caius_show", "not json"))).toBeNull();
    });
});

describe("viewReply and viewPicks", () => {
    const one = (answers: ViewAnswers, view: ShownView = DAY_VIEW) => ({ reply: viewReply(view, answers), ...viewPicks(view, answers) });
    const lead = "From the day view of Tue 3 Nov: ";

    it("gives no answer for no taps", () => {
        expect(one({})).toEqual({ reply: [], picks: [], total: 0 });
        expect(one({ rows: {}, tickets: {} })).toEqual({ reply: [], picks: [], total: 0 });
    });

    it("gives each tap its sentence and its pill row", () => {
        const cases: [ ViewAnswers, string, string, string ][] = [
            [ tap({ [key("a1")]: { fate: { kind: "block", block: "afternoon" } } }), `"Garage shelf" goes in the afternoon`, "Garage shelf", "Afternoon" ],
            [ tap({ [key("a2")]: { fate: { kind: "onDeck" } } }), `"The ballot" goes On deck`, "The ballot", "On deck" ],
            [ tap({ [key("d")]: { fate: { kind: "list" } } }), `"Deck thing" goes on the list`, "Deck thing", "On the list" ],
            [ tap({ [key("a1")]: { fate: { kind: "day", date: "2026-11-09", label: "Mon 9 Nov", onDeck: true } } }), `"Garage shelf" goes on Mon 9 Nov's On deck`, "Garage shelf", "Mon · On deck" ],
            [ tap({ [key("a1")]: { fate: { kind: "day", date: "2026-11-09", label: "Mon 9 Nov", onDeck: false } } }), `"Garage shelf" goes on Mon 9 Nov's list`, "Garage shelf", "Mon · list" ],
            [ tap({ [key("a1")]: { fate: { kind: "week", week: "2026-W46", label: "Week 46" } } }), `"Garage shelf" goes to Week 46`, "Garage shelf", "Week 46" ],
            [ tap({ [key("a1")]: { fate: { kind: "park", month: "2026-11", label: "November" } } }), `"Garage shelf" goes to November`, "Garage shelf", "Park · November" ],
            [ tap({ [key("a2")]: { fate: { kind: "done" } } }), `"The ballot" is done`, "The ballot", "Done" ],
            [ tap({ [key("a2")]: { fate: { kind: "drop", reason: "not needed" } } }), `"The ballot": drop it: not needed`, "The ballot", "Drop: not needed" ],
            [ tap({ [key("a3")]: { estimate: 30 } }), `"ZAP-2611 review" is 30 minutes`, "ZAP-2611 review", "~30m" ],
            [ tap({ [key("a3")]: { estimate: 120 } }), `"ZAP-2611 review" is 2 hours`, "ZAP-2611 review", "~2h" ],
            [ tap({ [key("a2")]: { area: "growth" } }), `"The ballot" is Growth`, "The ballot", "Growth" ]
        ];
        for (const [ answers, sentence, what, choice ] of cases) {
            const got = one(answers);
            expect(got.reply).toEqual([ `${lead}${sentence}.` ]);
            expect(got.picks.map(({ what, choice }) => ({ what, choice }))).toEqual([ { what, choice } ]);
            expect(got.total).toBe(1);
        }
    });

    it("gives a row's fate and its estimate both, each undone on its own", () => {
        const answers = tap({ [key("a1")]: { fate: { kind: "block", block: "afternoon" }, estimate: 30 } });
        const got = one(answers);
        expect(got.reply).toEqual([ `${lead}"Garage shelf" goes in the afternoon; "Garage shelf" is 30 minutes.` ]);
        expect(got.picks.map((p) => p.choice)).toEqual([ "Afternoon", "~30m" ]);
        expect(viewReply(DAY_VIEW, got.picks[0].undo)).toEqual([ `${lead}"Garage shelf" is 30 minutes.` ]);
        expect(viewPicks(DAY_VIEW, got.picks[1].undo).picks.map((p) => p.choice)).toEqual([ "Afternoon" ]);
    });

    it("takes a ticket with no task to a day, the week, or finishes it", () => {
        const item: ItemViewData = {
            task: null, trail: [], origin: null, context: [], dispositions: [],
            ticket: { key: "ZAP-2640", summary: "Fix the export", status: "To Do", daysInStatus: 3, assignee: null, url: "", done: false, lastComment: null, ask: null },
            today: "2026-11-03", nextWorkday: "2026-11-04", week: "2026-W45"
        };
        const view: ShownView = { view: "item", title: "ZAP-2640", sentence: "", data: item };
        const take = (answer: NonNullable<ViewAnswers["tickets"]>[string]) => one({ tickets: { "ZAP-2640": answer } }, view);
        expect(take({ kind: "take", to: "2026-11-03", label: "today", onDeck: true }).reply).toEqual([ "From the item view: Take ZAP-2640 to today's On deck." ]);
        expect(take({ kind: "take", to: "2026-11-04", label: "Wed 4 Nov", onDeck: false }).reply).toEqual([ "From the item view: Take ZAP-2640 to Wed 4 Nov's list." ]);
        expect(take({ kind: "take", to: "2026-W45", label: "Week 45", onDeck: true }).reply).toEqual([ "From the item view: Take ZAP-2640 to Week 45." ]);
        const finished = take({ kind: "finished" });
        expect(finished.reply).toEqual([ "From the item view: ZAP-2640 is finished." ]);
        expect(finished.picks.map(({ what, choice }) => ({ what, choice }))).toEqual([ { what: "ZAP-2640", choice: "Finished" } ]);
    });
});

describe("redraw", () => {
    const [ day ] = redraw(DAY_VIEW, {});
    const moved = (answers: ViewAnswers) => redraw(DAY_VIEW, answers)[0];

    it("gives the view's own load when nothing is tapped", () => {
        expect(day.load).toEqual(DAY.load);
        expect(day.load.foundation.minutes).toBe(195);
        expect(day.tasks.every((t) => !t.leaving)).toBe(true);
    });

    it("moves a row's block without touching Foundation", () => {
        const after = moved(tap({ [key("a1")]: { fate: { kind: "block", block: "afternoon" } } }));
        expect(after.tasks.find((t) => t.listItemId === "a1")?.block).toBe("afternoon");
        expect(after.load).toEqual(DAY.load);
    });

    it("lowers Foundation for On deck and a smaller estimate, and matches dayLoad on the moved rows", () => {
        const answers = tap({ [key("a2")]: { fate: { kind: "onDeck" } }, [key("a3")]: { estimate: 15 } });
        const after = moved(answers);
        expect(after.tasks.find((t) => t.listItemId === "a2")?.place).toBe("onDeck");
        expect(after.tasks.find((t) => t.listItemId === "a3")?.estMinutes).toBe(15);
        expect(after.load.foundation.minutes).toBe(195 - 30 - 45);
        expect(after.load.onDeck.minutes).toBe(60);
        expect(after.load).toEqual(loadOf(after.tasks));
    });

    it("takes a row and its sub-items off the day, kept as leaving", () => {
        const after = moved(tap({ [key("p")]: { fate: { kind: "week", week: "2026-W45", label: "Week 45" } }, [key("a1")]: { fate: { kind: "done" } } }));
        expect(after.tasks.filter((t) => t.leaving).map((t) => t.listItemId)).toEqual([ "a1", "p", "s1", "s2" ]);
        expect(after.tasks).toHaveLength(TASKS.length);
        expect(after.load.foundation.minutes).toBe(195 - 60 - 45);
        expect(after.load).toEqual(loadOf(after.tasks.filter((t) => !t.leaving)));
    });

    it("carries sub-items On deck with their parent, and a block tap brings an On deck row onto the list", () => {
        const after = moved(tap({ [key("p")]: { fate: { kind: "onDeck" } }, [key("d")]: { fate: { kind: "block", block: "morning" } } }));
        expect(after.tasks.filter((t) => t.place === "onDeck").map((t) => t.listItemId)).toEqual([ "p", "s1", "s2" ]);
        expect(after.tasks.find((t) => t.listItemId === "d")).toMatchObject({ place: "list", block: "morning" });
        expect(after.load.foundation.minutes).toBe(195 - 45 + 30);
        expect(after.load.onDeck.minutes).toBe(45);
    });

    it("moves minutes between meters on an area tap", () => {
        const after = moved(tap({ [key("a2")]: { area: "growth" }, [key("g")]: { area: "recharge" } }));
        expect(after.load.foundation.minutes).toBe(165);
        expect(after.load.growth.minutes).toBe(30);
        expect(after.load.recharge.count).toBe(2);
    });

    it("carries a parent's fate to a sub-item listed before it", () => {
        const order = [ TASKS[4], TASKS[3], TASKS[5] ];
        const after = redrawRows(order, tap({ [key("p")]: { fate: { kind: "week", week: "2026-W45", label: "Week 45" } } }));
        expect(after.map((t) => [ t.listItemId, t.leaving ])).toEqual([ [ "s1", true ], [ "p", true ], [ "s2", true ] ]);
        const deck = redrawRows(order, tap({ [key("p")]: { fate: { kind: "onDeck" } }, [key("s2")]: { fate: { kind: "done" } } }));
        expect(deck.map((t) => [ t.listItemId, t.place, t.leaving ])).toEqual([ [ "s1", "onDeck", false ], [ "p", "onDeck", false ], [ "s2", "list", true ] ]);
    });

    it("lowers the Foundation meter and adds one pill row for a tap to On deck", () => {
        const answers = tap({ [key("a2")]: { fate: { kind: "onDeck" } } });
        expect(moved(answers).load.foundation.minutes).toBeLessThan(DAY.load.foundation.minutes);
        expect(moved(answers).load.onDeck.minutes).toBe(60);
        expect(viewPicks(DAY_VIEW, answers).picks.map(({ what, choice }) => ({ what, choice }))).toEqual([ { what: "The ballot", choice: "On deck" } ]);
        expect(viewPicks(DAY_VIEW, viewPicks(DAY_VIEW, answers).picks[0].undo).picks).toEqual([]);
    });

    it("redraws each day of Days", () => {
        const other = TASKS.map((t) => ({ ...t, noteId: "day2", period: { kind: "day" as const, key: "2026-11-04" } }));
        const days: DaysViewData = {
            from: "2026-11-03",
            days: [
                { date: "2026-11-03", dateLabel: "Tue 3 Nov", workday: true, meetingMinutes: 60, load: DAY.load, calendarFailed: false, tasks: TASKS },
                { date: "2026-11-04", dateLabel: "Wed 4 Nov", workday: true, meetingMinutes: 0, load: DAY.load, calendarFailed: false, tasks: other }
            ],
            week: { key: "2026-W45", label: "Week 45", tasks: [], foundation: { minutes: 0, target: { min: 720, max: 900 } } }
        };
        const view: ShownView = { view: "days", title: "", sentence: "", data: days };
        const after = redraw(view, tap({ [rowKey({ noteId: "day2", listItemId: "a1" })]: { fate: { kind: "drop", reason: "" } } }));
        expect(after.map((d) => d.load.foundation.minutes)).toEqual([ 195, 135 ]);
    });
});

describe("fateChoices", () => {
    it("offers a day's row the blocks and On deck, the days, the week and Drop, and Park only when asked", () => {
        const labels = (task: ViewTask, where: Parameters<typeof fateChoices>[1]) => fateChoices(task, where).map((c) => c.label);
        const where = { nextWorkday: "2026-11-04", days: [ "2026-11-03", "2026-11-04", "2026-11-05" ], week: "2026-W45" };
        expect(labels(TASKS[0], where)).toEqual([ "Done", "Morning", "Afternoon", "Evening", "On deck", "Wed 4 Nov", "Thu 5 Nov", "A day…", "Week 45", "Drop…" ]);
        expect(labels(TASKS[8], { ...where, parkMonth: "2026-12" })).toContain("Onto the list");
        expect(labels(TASKS[8], { ...where, parkMonth: "2026-12" })).toContain("Park");
        const weekRow = { ...TASKS[1], period: { kind: "week" as const, key: "2026-W45" } };
        expect(labels(weekRow, where)).toEqual([ "Done", "Wed 4 Nov", "Tue 3 Nov", "Thu 5 Nov", "A day…", "Drop…" ]);
        expect(fateChoices(TASKS[0], where).find((c) => c.label === "Wed 4 Nov")?.fate).toEqual({ kind: "day", date: "2026-11-04", label: "Wed 4 Nov", onDeck: true });
    });
});

describe("fateChoices for an Important row", () => {
    it("leaves out the blocks and On deck", () => {
        const critical = { ...TASKS[1], critical: true };
        expect(fateChoices(critical, { nextWorkday: "2026-11-04", week: "2026-W45" }).map((c) => c.label))
            .toEqual([ "Done", "Wed 4 Nov", "A day…", "Week 45", "Drop…" ]);
    });
});

describe("dayGroups", () => {
    const names = (groups: ReturnType<typeof dayGroups>) => groups.map((g) => [ g.name, g.variant, g.tasks.map((t) => t.listItemId) ]);

    it("groups the rows Important first, then by block, then the list, then On deck, each sub-item under its parent", () => {
        const tasks = [
            row("i", "Ship it", { critical: true }), row("s1a", "Part of a part", { parent: "First part", parentListItemId: "s1" }), ...TASKS,
            row("s0", "Early part", { parent: "Parent", parentListItemId: "p", block: "evening" })
        ];
        expect(names(dayGroups(redrawRows(tasks, {})))).toEqual([
            [ "Important", "critical", [ "i" ] ],
            [ "Morning", "list", [ "a1" ] ],
            [ "Evening", "list", [ "g", "r" ] ],
            [ "The list", "list", [ "a2", "a3", "p", "s1", "s1a", "s2", "s0" ] ],
            [ "On deck", "onDeck", [ "d" ] ]
        ]);
    });

    it("moves a row with its tap and keeps a leaving row in place", () => {
        const after = redrawRows(TASKS, tap({
            [key("a2")]: { fate: { kind: "block", block: "afternoon" } },
            [key("p")]: { fate: { kind: "onDeck" } },
            [key("a1")]: { fate: { kind: "done" } }
        }));
        expect(names(dayGroups(after))).toEqual([
            [ "Morning", "list", [ "a1" ] ],
            [ "Afternoon", "list", [ "a2" ] ],
            [ "Evening", "list", [ "g", "r" ] ],
            [ "The list", "list", [ "a3" ] ],
            [ "On deck", "onDeck", [ "p", "s1", "s2", "d" ] ]
        ]);
        expect(dayGroups(after)[0].tasks[0].leaving).toBe(true);
    });

    it("shows a sub-item whose parent is not on the view as a row of its own", () => {
        expect(names(dayGroups(redrawRows([ row("x", "Orphan", { parent: "Gone", parentListItemId: "gone", block: "morning" }) ], {}))))
            .toEqual([ [ "Morning", "list", [ "x" ] ] ]);
    });
});

describe("hasLiveSubItems", () => {
    it("is true for a row with a live sub-item on its note", () => {
        expect(hasLiveSubItems(TASKS[3], TASKS)).toBe(true);
        expect(hasLiveSubItems(TASKS[0], TASKS)).toBe(false);
        const finished = TASKS.map((t) => t.parentListItemId === "p" ? { ...t, state: "done" as const } : t);
        expect(hasLiveSubItems(TASKS[3], finished)).toBe(false);
        expect(hasLiveSubItems(TASKS[3], TASKS.map((t) => ({ ...t, noteId: t.listItemId === "p" ? "day1" : "day2" })))).toBe(false);
    });
});

describe("dayTerrain", () => {
    const tasks = [
        row("m1", "Deep work", { estMinutes: 60, block: "morning" }),
        row("m2", "Email", { block: "morning" }),
        row("gr", "Read", { estMinutes: 45, area: "growth", block: "evening" }),
        row("dk", "Deck thing", { place: "onDeck" })
    ];
    const data: DayViewData = {
        ...DAY,
        tasks,
        meetings: [ { start: "10:00", end: "11:00", title: "Weekly sync with team" }, { start: "00:00", end: "24:00", title: "Holiday", allDay: true } ],
        drawn: { groups: [ { name: "Focus", items: [ "m1", "m2" ] }, { name: "Evening", items: [ "gr" ] } ], meetings: [ { title: "Weekly sync with team", name: "Sync" } ] }
    };
    const laid = (answers: ViewAnswers, from: DayViewData = data) => dayTerrain(from, redrawRows(from.tasks, answers));
    const hills = (answers: ViewAnswers, from?: DayViewData) => laid(answers, from).input.groups.map((g) => [ g.name, g.start, g.end, g.count ]);

    it("lays the list's live rows into the brief's groups around the timed meetings", () => {
        const { input, unplacedMinutes } = laid({});
        expect(input).toMatchObject({ start: "09:00", end: "23:00", events: [ { start: "10:00", end: "11:00", title: "Sync" } ] });
        expect(hills({})).toEqual([ [ "Focus", "09:00", "11:30", 2 ], [ "Evening", "17:00", "17:45", 1 ] ]);
        expect(unplacedMinutes).toBe(0);
    });

    it("moves, drops and resizes hills with the taps", () => {
        expect(hills(tap({ [key("m2")]: { fate: { kind: "block", block: "afternoon" } } }))).toEqual([ [ "Focus", "09:00", "10:00", 1 ], [ "Focus", "12:00", "12:30", 1 ], [ "Evening", "17:00", "17:45", 1 ] ]);
        expect(hills(tap({ [key("m1")]: { fate: { kind: "done" } } }))).toEqual([ [ "Focus", "09:00", "09:30", 1 ], [ "Evening", "17:00", "17:45", 1 ] ]);
        expect(hills(tap({ [key("m1")]: { estimate: 120 } }))).toEqual([ [ "Focus", "09:00", "12:30", 2 ], [ "Evening", "17:00", "17:45", 1 ] ]);
        expect(hills(tap({ [key("dk")]: { fate: { kind: "block", block: "evening" } } }))).toEqual([ [ "Focus", "09:00", "11:30", 2 ], [ "Evening", "17:00", "17:45", 1 ], [ "Focus", "17:45", "18:15", 1 ] ]);
    });

    it("gives the minutes that don't fit before bedtime, and starts the drawing at an earlier meeting's hour", () => {
        expect(laid(tap({ [key("gr")]: { estimate: 600 } })).unplacedMinutes).toBe(240);
        const early = { ...data, meetings: [ { start: "08:15", end: "08:45", title: "Moved by the clock" } ] };
        expect(laid({}, early).input.start).toBe("08:00");
    });
});

describe("slipLabel", () => {
    it("shows the slip count from 2 only", () => {
        expect([ 0, 1, 2, 3 ].map(slipLabel)).toEqual([ null, null, "↻2", "↻3" ]);
    });
});
