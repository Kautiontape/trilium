/**
 * Caius the guide: a Wind down that adds a task and reads tomorrow's meetings, would-like and
 * need-to fates, On deck kept out of the committed capacity but in the overload flag, Plan my day
 * putting On deck first and giving every item a fate, and the summary of yesterday.
 * Wed 8 to Fri 10 Mar 2028.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const critical = (...items: string[]) => `<aside class="admonition important">${ul(...items)}</aside>`;

const WED = "2028-03-08";
const THU = "2028-03-09";
const FRI = "2028-03-10";
const WEEK = "2028-W10";
/** A Wednesday with nothing open around it. */
const QUIET = "2028-03-22";

const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });
const calendars: Record<string, CalendarEvent[]> = {
    [THU]: [ event("10:00", "10:15", "Standup"), event("13:00", "14:00", "Design review"), event("15:00", "15:30", "Pickup for HT") ]
};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return { date: input.date, jira: { handoff: [], asks: [], done: [] }, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);
const prose = { headline: "The report, then the idea", acts: [ { range: "", text: "The report." }, { range: "", text: "The idea." } ], sections: [] };
/** A task's words without its forward links. */
const plain = (text: string) => text.replace(/\s*(?:\[from [^\]]*\]\([^)]*\)|_scheduled \[[^\]]*\]\([^)]*\)_)/g, "").trim();
const listOf = (plan: any) => plan.sections.flatMap((s: any) => s.tasks).filter((t: any) => t.state === "open").map((t: any) => plain(t.text));
const deckOf = (plan: any) => plan.onDeck.filter((t: any) => t.state === "open").map((t: any) => plain(t.text));

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const wed = await store.calendarDay(WED);
        const [ root ] = await store.search("#calendarRoot");
        if (!root) throw new Error("no #calendarRoot note");
        await store.addLabel(root.noteId, "enableWeekNote", "");
        await store.putContent(wed.noteId, critical(li("wc", "Pay the rent ~10m"))
            + `<h2>☑️ Tasks</h2>${ul(li("w1", "Write the report ~1h"), li("w2", "Call the plumber"), li("w3", "Email Sam ~15m"))}`
            + `<h3>Evening</h3>${ul(li("we", "Laundry"))}`);
        const thu = await store.calendarDay(THU);
        await store.putContent(thu.noteId, `<h2>☑️ Tasks</h2>${ul(li("t1", "Existing thing ~2h"))}<h3>On deck</h3>${ul(li("td1", "Maybe idea ~30m"))}<h3>Suggested</h3>`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a guide, not a script", () => {
    it("(a) Wed 17:30: the wind-down reads tomorrow's meetings by title and time, and caius_add puts a new task on Thursday's On deck", async () => {
        at(`${WED}T17:30`);
        const next = await call("caius_winddown", { date: WED, step: "next" });
        expect(next.targetDay).toBe(THU);
        expect(next.data.meetings).toEqual([
            { start: "10:00", end: "10:15", title: "Standup" }, { start: "13:00", end: "14:00", title: "Design review" }, { start: "15:00", end: "15:30", title: "Pickup for HT" }
        ]);
        expect(next.data.onDeck.map((item: any) => [ item.text, item.minutes ])).toEqual([ [ "Maybe idea", 30 ] ]);

        // "ZAP-2388 is next for Thursday": he'd like to, so it goes on deck, tracked.
        const added = await call("caius_add", { items: [ { date: THU, onDeck: true, text: "ZAP-2388 next step", est: "1h" } ] });
        expect(added.results[0]).toMatchObject({ status: "added" });
        const thursday = await call("caius_plan", { period: "day", date: THU });
        expect(deckOf(thursday)).toEqual([ "Maybe idea", expect.stringContaining("ZAP-2388") ]);
        expect(listOf(thursday)).toEqual([ "Existing thing" ]);
        // Tracked: it is live in the lanes, so nothing can add it twice.
        const again = await call("caius_add", { items: [ { date: FRI, section: "Tasks", text: "ZAP-2388 next step" } ] });
        expect(again.results[0]).toMatchObject({ status: "skipped", reason: "duplicate" });
    });

    it("(c, f) On deck stays out of the committed capacity but counts in the overload flag", async () => {
        at(`${WED}T17:35`);
        const thursday = await call("caius_plan", { period: "day", date: THU });
        expect(thursday.capacity).toMatchObject({ totalMinutes: 120, onDeckMinutes: 90 });

        const next = await call("caius_winddown", { date: WED, step: "next" });
        // The committed list alone.
        expect(next.data.capacity.plannedMinutes).toBe(120);
        // 1 h 45 m of meetings leave 6 h 15 m open, so the focus target is 4 h; the list (2 h), On deck
        // (1 h 30 m) and the leftovers proposed for Thursday (the report, the plumber, the email and the
        // rent, 1 h 55 m; the evening's laundry isn't work) pass it.
        expect(next.data.load).toMatchObject({
            meetingMinutes: 105, listMinutes: 120, onDeckMinutes: 90, incomingMinutes: 115, targetMinutes: 240, over: true, overMinutes: 85
        });
        expect(next.data.load.sentence).toBe("Thursday: 1 h 45 m of meetings, 2 h on the list, 1 h 30 m on deck and 1 h 55 m more if today's leftovers go there, against 3–4 h of focus time. That's 1 h 25 m more than fits.");
    });

    it("(b) Wed 17:40: 'I'd like to' goes on Thursday's On deck, 'I need to' on its list; Important and evening tasks keep their place", async () => {
        at(`${WED}T17:40`);
        const open = await call("caius_winddown", { date: WED, step: "open" });
        const item = (id: string) => open.data.items.find((i: any) => i.listItemId === id);
        expect(item("w1")).toMatchObject({ onDeck: false, minutes: 60, fate: { forward: THU, onDeck: true } });
        expect(item("wc").fate).toEqual({ forward: THU, forwardLabel: "Thu 9 Mar" });
        expect(item("we").fate).toEqual({ forward: THU, forwardLabel: "Thu 9 Mar" });
        expect(open.question).toContain("The rest goes on Thursday's On deck unless you say otherwise.");

        const result = await call("caius_winddown_apply", {
            date: WED, said: "Sam is emailed. I need to call the plumber tomorrow, and I'd like to get the report done Thursday.",
            done: [ "w3" ], fates: [ { listItemId: "w2", to: THU, onDeck: false }, { listItemId: "w1", to: THU } ]
        });
        expect(result.skipped).toEqual([]);
        expect(result.say).toContain("moved to Thu 9 Mar's On deck");
        const thursday = await call("caius_plan", { period: "day", date: THU });
        expect(deckOf(thursday)).toEqual([ "Maybe idea", expect.stringContaining("ZAP-2388"), "Write the report" ]);
        expect(listOf(thursday)).toEqual([ "Existing thing", "Call the plumber", "Laundry" ]);
        expect(thursday.critical.map((t: any) => plain(t.text))).toEqual([ "Pay the rent" ]);
        expect(thursday.sections.find((s: any) => s.name === "Evening")?.tasks.map((t: any) => plain(t.text))).toEqual([ "Laundry" ]);
        // The apply says how Thursday stands now: still over, for the pushback.
        expect(result.load).toMatchObject({ listMinutes: 160, onDeckMinutes: 150, over: true });
    });

    it("(f) a light day is not flagged, and Thursday's leftovers would overload Friday", async () => {
        at(`${QUIET}T17:30`);
        const quiet = await call("caius_winddown", { date: QUIET, step: "next" });
        expect(quiet.data.load).toMatchObject({ listMinutes: 0, onDeckMinutes: 0, incomingMinutes: 0, over: false, overMinutes: 0 });
        expect(quiet.data.load.sentence).toBe("Thursday: 0 m of meetings, 0 m on the list and 0 m on deck, against 3–4 h of focus time.");

        // Everything still open on Thursday would land on Friday: the step says so before he answers.
        at(`${THU}T17:30`);
        const next = await call("caius_winddown", { date: THU, step: "next" });
        expect(next.targetDay).toBe(FRI);
        expect(next.data.load).toMatchObject({ incomingMinutes: 310, over: true, overMinutes: 70 });
    });
});

describe("Plan my day", () => {
    it("(e) Thu 09:30: remembers how Wednesday closed", async () => {
        at(`${THU}T09:30`);
        const inputs = await call("caius_planday", { date: THU, step: "inputs" });
        expect(inputs.data.yesterday).toMatchObject({ date: WED, done: 1, moved: 4, dropped: 0, open: 0, woundDown: true });
        expect(inputs.data.yesterday.onDeck).toEqual([ "Maybe idea", expect.stringContaining("ZAP-2388"), "Write the report" ]);
        expect(inputs.data.yesterday.sentence).toBe("Wednesday: 1 done, 4 moved on, 0 dropped, 0 left open. It was wound down.");
    });

    it("(d) Thu 09:30: offers On deck first, and every On deck item gets a fate", async () => {
        at(`${THU}T09:31`);
        const inputs = await call("caius_planday", { date: THU, step: "inputs" });
        // 2 h 40 m committed against 4 h: the idea fits, the next two don't.
        expect(inputs.data.onDeck.map((item: any) => [ item.text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"), item.fate ])).toEqual([
            [ "Maybe idea", { list: true } ],
            [ "ZAP-2388 next step", { forward: WEEK, forwardLabel: "the week of Mon 6 Mar" } ],
            [ "Write the report", { forward: WEEK, forwardLabel: "the week of Mon 6 Mar" } ]
        ]);
        expect(inputs.question).toMatch(/^On your list from On deck: 'Maybe idea'\. Back up to the week, since it won't fit today: '.*ZAP-2388.*' and 'Write the report'\. Change any\?/);
        const report = inputs.data.onDeck.find((item: any) => item.text === "Write the report");

        // "The report goes first; the rest as you said."
        const result = await call("caius_plan_apply", {
            date: THU, said: "The report goes first; the rest as you said.", onDeck: [ { listItemId: report.ref, first: true } ], brief: prose
        });
        expect(result.skipped).toEqual([]);
        const thursday = await call("caius_plan", { period: "day", date: THU });
        expect(deckOf(thursday)).toEqual([]);
        expect(listOf(thursday)).toEqual([ "Write the report", "Existing thing", "Call the plumber", "Maybe idea", "Laundry" ]);
        const week = await call("caius_plan", { period: "week", date: WEEK });
        expect(listOf(week)).toEqual([ expect.stringContaining("ZAP-2388") ]);
        expect(result.say).toContain("moved to the week of Mon 6 Mar");

        // A re-run changes nothing.
        const again = await call("caius_plan_apply", {
            date: THU, said: "The report goes first; the rest as you said.", onDeck: [ { listItemId: report.ref, first: true } ], brief: prose
        });
        expect(again.skipped).toEqual([]);
        expect(again.written.filter((w: any) => w.kind !== "brief" && w.kind !== "meetings" && w.status !== "unchanged")).toEqual([]);
    });

    it("(d) Fri 09:30: a named drop and a named week, then the same call again, which finds both in place", async () => {
        await cls.init(async () => {
            const fri = await store.calendarDay(FRI);
            await store.putContent(fri.noteId, `<h2>☑️ Tasks</h2>${ul(li("f1", "Friday thing ~30m"))}<h3>On deck</h3>${ul(li("fd1", "Sort the garage"), li("fd2", "Clean the gutters"))}`);
        });
        at(`${FRI}T09:30`);
        const inputs = await call("caius_planday", { date: FRI, step: "inputs" });
        const ref = (text: string) => inputs.data.onDeck.find((item: any) => item.text === text).ref;
        const answer = {
            date: FRI, said: "Drop the garage, it's sorted. Gutters to next week.", brief: prose,
            onDeck: [ { listItemId: ref("Sort the garage"), drop: "it's sorted" }, { listItemId: ref("Clean the gutters"), to: "w2" } ]
        };
        const first = await call("caius_plan_apply", answer);
        expect(first.skipped).toEqual([]);
        const friday = await call("caius_plan", { period: "day", date: FRI });
        expect(deckOf(friday)).toEqual([]);
        expect(friday.onDeck.map((t: any) => t.state)).toEqual([ "cancelled", expect.stringMatching(/done|tombstone/) ]);
        expect(listOf(await call("caius_plan", { period: "week", date: "2028-W11" }))).toEqual([ "Clean the gutters" ]);

        const again = await call("caius_plan_apply", answer);
        expect(again.skipped).toEqual([]);
        expect(again.written.filter((w: any) => w.kind !== "brief" && w.kind !== "meetings" && w.status !== "unchanged")).toEqual([]);
        expect(again.say).not.toContain("wasn't found");
    });
});

describe("corrections and places, Wed 5 to Fri 7 Apr 2028", () => {
    const AWED = "2028-04-05";
    const ATHU = "2028-04-06";
    const AFRI = "2028-04-07";
    const AMON = "2028-04-10";

    it("Wind down: a named day keeps an Important or evening task in place, a place puts a leftover on the list, and 'need to' takes a deck copy onto the list", async () => {
        await cls.init(async () => {
            const wed = await store.calendarDay(AWED);
            await store.putContent(wed.noteId, critical(li("ac", "Pay the gas ~10m"))
                + `<h2>☑️ Tasks</h2>${ul(li("aa", "Alpha task ~30m"), li("ab", "Fix the bike ~30m"))}<h3>Evening</h3>${ul(li("ae", "Fold laundry"))}`);
        });
        at(`${AWED}T17:30`);
        await call("caius_winddown", { date: AWED, step: "open" });
        const first = await call("caius_winddown_apply", {
            date: AWED, said: "Gas and laundry Thursday. The bike first tomorrow.",
            fates: [ { listItemId: "ac", to: ATHU }, { listItemId: "ae", to: ATHU } ], move: [ { listItemId: "ab", first: true } ]
        });
        expect(first.skipped).toEqual([]);
        let thursday = await call("caius_plan", { period: "day", date: ATHU });
        expect(thursday.critical.map((t: any) => plain(t.text))).toEqual([ "Pay the gas" ]);
        expect(listOf(thursday)).toEqual([ "Fix the bike", "Fold laundry" ]);
        expect(thursday.sections.find((s: any) => s.name === "Evening")?.tasks.map((t: any) => plain(t.text))).toEqual([ "Fold laundry" ]);
        expect(deckOf(thursday)).toEqual([ "Alpha task" ]);

        // "Actually I need to do Alpha tomorrow."
        const fix = await call("caius_winddown_apply", { date: AWED, said: "Actually I need to do Alpha tomorrow.", fates: [ { listItemId: "aa", to: ATHU, onDeck: false } ] });
        expect(fix.skipped).toEqual([]);
        expect(fix.say).not.toContain("already moved");
        thursday = await call("caius_plan", { period: "day", date: ATHU });
        expect(deckOf(thursday)).toEqual([]);
        expect(listOf(thursday)).toEqual([ "Fix the bike", "Alpha task", "Fold laundry" ]);
        const again = await call("caius_winddown_apply", { date: AWED, said: "Actually I need to do Alpha tomorrow.", fates: [ { listItemId: "aa", to: ATHU, onDeck: false } ] });
        expect(again.written.filter((w: any) => w.status !== "unchanged" && w.kind !== "header")).toEqual([]);
    });

    it("Plan my day: an ambiguous answer holds both items on deck, a move or forward of a deck item is its fate, and corrections act where the item now is", async () => {
        await cls.init(async () => {
            const fri = await store.calendarDay(AFRI);
            await store.putContent(fri.noteId, `<h2>☑️ Tasks</h2>${ul(li("fa", "Friday thing ~3h"))}<h3>On deck</h3>${ul(
                li("fg1", "Garage shelf one"), li("fg2", "Garage shelf two"), li("fbig", "Big thing ~2h"), li("fy", "Yodel chore"), li("fr", "Report draft")
            )}`);
        });
        at(`${AFRI}T09:30`);
        const inputs = await call("caius_planday", { date: AFRI, step: "inputs" });
        const ref = (text: string) => inputs.data.onDeck.find((item: any) => item.text === text).ref;
        expect(inputs.data.onDeck.map((item: any) => "list" in item.fate)).toEqual([ true, true, false, false, false ]);

        const first = await call("caius_plan_apply", {
            date: AFRI, said: "Garage shelf next week. Yodel first. Report Monday.", brief: prose,
            onDeck: [ { listItemId: "garage shelf", to: "w2" } ], move: [ { listItemId: ref("Yodel chore"), first: true } ], forward: [ { listItemId: ref("Report draft"), to: AMON } ]
        });
        expect(first.skipped).toEqual([ expect.objectContaining({ kind: "deck", reason: "ambiguous" }) ]);
        expect(first.say).toMatch(/Which garage shelf: Garage shelf one or Garage shelf two\?/);
        let friday = await call("caius_plan", { period: "day", date: AFRI });
        expect(deckOf(friday)).toEqual([ "Garage shelf one", "Garage shelf two" ]);
        expect(listOf(friday)).toEqual([ "Yodel chore", "Friday thing" ]);
        expect(deckOf(await call("caius_plan", { period: "day", date: AMON }))).toEqual([ "Report draft" ]);
        expect(listOf(await call("caius_plan", { period: "week", date: "2028-W14" }))).toEqual([ "Big thing" ]);

        // "Shelf one today, shelf two next week. Big thing back on today after all, and drop the yodel."
        at(`${AFRI}T09:40`);
        const fix = await call("caius_plan_apply", {
            date: AFRI, said: "Shelf one today, shelf two next week. Big thing back on today after all, and drop the yodel.", brief: prose,
            onDeck: [
                { listItemId: ref("Garage shelf one") }, { listItemId: ref("Garage shelf two"), to: "w2" },
                { listItemId: ref("Big thing"), first: true }, { listItemId: ref("Yodel chore"), drop: "not needed" }
            ]
        });
        expect(fix.skipped).toEqual([]);
        friday = await call("caius_plan", { period: "day", date: AFRI });
        expect(deckOf(friday)).toEqual([]);
        expect(listOf(friday)).toEqual([ "Big thing", "Friday thing", "Garage shelf one" ]);
        expect(friday.sections.flatMap((s: any) => s.tasks).find((t: any) => t.text.startsWith("Yodel")).state).toBe("cancelled");
        expect(listOf(await call("caius_plan", { period: "week", date: "2028-W15" }))).toEqual([ "Garage shelf two" ]);
    });
});
