import { dayLoad, liveMinutes } from "@triliumnext/caius/src/daily/load.js";
import type { DayViewData, DaysViewData, ItemViewData, ShownView, ViewTask } from "@triliumnext/caius/src/daily/views.js";
import { describe, expect, it } from "vitest";

import { slipLabel } from "../components/TaskRow.js";
import { fateChoices, redraw, rowKey, type ViewAnswers, viewOf, viewPicks, viewReply } from "./views.js";

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

describe("slipLabel", () => {
    it("shows the slip count from 2 only", () => {
        expect([ 0, 1, 2, 3 ].map(slipLabel)).toEqual([ null, null, "↻2", "↻3" ]);
    });
});
