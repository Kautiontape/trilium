/**
 * The day frame and the day read: the frame reads the calendar without Jira, and the day read gives
 * the meetings, capacity, layout, slips and Context the steps and the views share.
 */

import { dayCapacity, readPlan } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { readDay } from "./day-read.js";
import type { CaiusInputs, CalendarEvent, InputError } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createCaiusService } from "./service.js";
import { createBeccaStore, createChildNote, withCaiusLock } from "./store.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li>"
    + "<li>The day runs to bedtime, and the evening is planned too. Bedtime: 23:00. Evening: something away from screens, a chore or a Recharge item.</li>"
    + "<li>Capacity: 180–240 work minutes a day, and 45–60 minutes in the evening.</li></ul>";

const MON = "2032-03-01";
const TUE = "2032-03-02";
const WED = "2032-03-03";
const THU = "2032-03-04";

const calendars: Record<string, CalendarEvent[]> = {
    [TUE]: [ event("10:00", "10:15", "Daily Standup"), event("13:00", "14:00", "Vendor sync"), event("15:00", "15:30", "Design review") ]
};

/** A service whose sources are counted: `inputsOf` answers from `calendars` unless `jiraFails`, `calendarOf` from `feeds`. */
function countedService(opts: { jiraFails?: boolean; feeds?: Record<string, { events: CalendarEvent[]; errors: InputError[] } | "throws"> } = {}) {
    let clock = 0;
    const inputsCalls: string[] = [];
    const calendarCalls: string[] = [];
    const inputsOf = async (input: InputsInput): Promise<CaiusInputs> => {
        inputsCalls.push(input.date);
        if (opts.jiraFails) throw new Error("Jira is not to be read");
        const calendar = calendars[input.date] ?? [];
        return { date: input.date, jira: { handoff: [], asks: [], done: [] }, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
    };
    const calendarOf = async (date: string) => {
        calendarCalls.push(date);
        const feed = opts.feeds?.[date] ?? { events: calendars[date] ?? [], errors: [] };
        if (feed === "throws") throw new Error("feed exploded");
        return feed;
    };
    const service = createCaiusService(store, undefined, inputsOf, () => clock, undefined, calendarOf);
    return { service, inputsCalls, calendarCalls, advance: (minutes: number) => { clock += minutes * 60_000; } };
}

const dayWith = (date: string, html: string) => cls.init(async () => {
    const day = await store.calendarDay(date);
    await store.putContent(day.noteId, html);
    return day.noteId;
});

const run = <T>(fn: () => Promise<T>) => cls.init(fn) as Promise<T>;

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        await store.addLabel(createChildNote("root", "🧭 How I work", STANDING), "assistantContext", "");
        const tue = await store.calendarDay(TUE);
        await store.addLabel(tue.noteId, "caiusDeclined", "o1234567890|15:00|Design review");
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("the day frame", () => {
    it("reads the calendar alone, never Jira, leaves a declined meeting out and reuses the read for 15 minutes", async () => {
        const { service, inputsCalls, calendarCalls, advance } = countedService({ jiraFails: true });
        vi.stubEnv("CAIUS_NOW", `${MON}T17:30`);

        const frame = await run(() => service.dayFrame(TUE));
        expect(inputsCalls).toEqual([]);
        expect(calendarCalls).toEqual([ TUE ]);
        expect(frame.rhythm).toMatchObject({ start: "10:00", end: "23:00" });
        expect(frame.inputs.calendar.find((e) => e.title === "Design review")?.declined).toBe(true);
        const taken = (calendars[TUE] ?? []).filter((e) => e.title !== "Design review");
        expect(frame.inputs.capacity).toEqual(dayCapacity(taken, { workStart: frame.rhythm.start, workEnd: frame.rhythm.workEnd }));
        expect(frame.inputs.capacity.bookedMinutes).toBe(75);
        expect(frame.inputs.errors).toEqual([]);

        advance(14);
        await run(() => service.dayFrame(TUE));
        expect(calendarCalls).toEqual([ TUE ]);
        advance(2);
        await run(() => service.dayFrame(TUE));
        expect(calendarCalls).toEqual([ TUE, TUE ]);
        expect(inputsCalls).toEqual([]);
    });

    it("keeps no failed read: a feed error or a reader that throws is read again next time", async () => {
        const { service, calendarCalls } = countedService({ jiraFails: true, feeds: {
            [WED]: { events: [], errors: [ { source: "calendar", error: "feed_0_timeout" } ] },
            [THU]: "throws"
        } });
        vi.stubEnv("CAIUS_NOW", `${MON}T17:30`);

        expect((await run(() => service.dayFrame(WED))).inputs.errors).toEqual([ { source: "calendar", error: "feed_0_timeout" } ]);
        await run(() => service.dayFrame(WED));
        expect((await run(() => service.dayFrame(THU))).inputs).toMatchObject({ calendar: [], errors: [ { source: "calendar", error: "unexpected" } ] });
        await run(() => service.dayFrame(THU));
        expect(calendarCalls).toEqual([ WED, WED, THU, THU ]);
    });

    it("takes the calendar of a fresh inputs read for the day instead of reading the feeds", async () => {
        const feedCalendar = [ event("09:00", "09:30", "Only in the feed") ];
        const { service, inputsCalls, calendarCalls, advance } = countedService({ feeds: { [TUE]: { events: feedCalendar, errors: [] } } });
        vi.stubEnv("CAIUS_NOW", `${MON}T17:30`);

        await run(() => service.inputs({ date: TUE, context: [], keys: [], workStart: "10:00", workEnd: "18:00" }));
        expect(inputsCalls).toEqual([ TUE ]);
        const frame = await run(() => service.dayFrame(TUE));
        expect(calendarCalls).toEqual([]);
        expect(frame.inputs.calendar.map((e) => e.title)).toEqual([ "Daily Standup", "Vendor sync", "Design review" ]);
        expect(frame.inputs.capacity.bookedMinutes).toBe(75);

        advance(16);
        expect((await run(() => service.dayFrame(TUE))).inputs.calendar.map((e) => e.title)).toEqual([ "Only in the feed" ]);
        expect(calendarCalls).toEqual([ TUE ]);
    });
});

describe("the day read", () => {
    it("gives Tuesday's meetings, capacity, groups and unplaced, slips from the trail and the Context in force", async () => {
        const { service } = countedService();
        vi.stubEnv("CAIUS_NOW", `${MON}T17:30`);
        await dayWith(TUE, `<h3>Admin</h3>${ul(li("t-qa", "Review the QA notes ~30m"))}`
            + `<h3>Work</h3>${ul(li("t-spec", "Write the export spec ~1h"), li("t-archive", "Rebuild the whole archive ~14h"))}`);
        const mon = await dayWith(MON, `<h3>Work</h3>${ul(li("m-plumber", "Ring the plumber ~30m"))}<h2>On deck</h2>${ul(li("m-garage", "Sort the garage ~1h"))}`);
        const moved = await run(() => service.forward({ items: [ { noteId: mon, listItemId: "m-plumber", to: TUE }, { noteId: mon, listItemId: "m-garage", to: TUE } ] }));
        expect(moved.results.map((r: { status: string }) => r.status)).toEqual([ "moved", "moved" ]);
        expect((await run(() => service.contextAdd({ date: TUE, text: "Sam is out today" }))).results[0]).toMatchObject({ status: "added" });

        const now = new Date(`${MON}T17:30:00`);
        const frame = await run(() => service.dayFrame(TUE));
        const day = await run(() => withCaiusLock("spec_day_read", async () => readDay(store, frame, await readPlan(store, "day", TUE, now), { date: TUE, now })));

        expect(day.date).toBe(TUE);
        expect(day.meetings.map((m) => m.title)).toEqual([ "Daily Standup", "Vendor sync" ]);
        expect(day.calendarFailed).toBe(false);
        expect(day.capacity).toMatchObject({ bookedMinutes: 75, plannedMinutes: day.plan.capacity.totalMinutes, focus: { min: 180, max: 240 } });
        expect(day.growth).toMatchObject({ minutes: 0, over: false });

        // The plumber joins Monday's heading on Tuesday; the archive fills the day, so it and the plumber are left over.
        expect(day.layout.groups.map((g) => [ g.name, g.count ])).toEqual([ [ "Admin", 1 ], [ "Work", 3 ] ]);
        expect(day.layout.unplaced.map((u) => u.label)).toEqual([ expect.stringContaining("Rebuild the whole"), "Ring the plumber" ]);
        expect(day.layout.events.map((e) => [ e.start, e.title ])).toEqual([ [ "10:00", "Daily" ], [ "13:00", "Vendor" ] ]);

        const listIds = new Map([ ...day.plan.critical, ...day.plan.sections.flatMap((s) => s.tasks), ...day.plan.onDeck ]
            .map((task) => [ task.text.replace(/\s*\[from [^\]]*\]\([^)]*\)/g, ""), task.listItemId ]));
        const idOf = (words: string) => [ ...listIds ].find(([ text ]) => text.includes(words))?.[1] ?? `no ${words}`;
        expect(day.slips).toEqual({
            "t-spec": 0, "t-archive": 0, "t-qa": 0, [idOf("Ring the plumber")]: 1, [idOf("Sort the garage")]: 1
        });

        expect(day.context.map((line) => line.text)).toContain("Sam is out today");

        const steps = await run(() => service.planday({ date: TUE, step: "inputs", refresh: true, early: true }));
        const { sentence: _sentence, ...figures } = (steps as { data: { capacity: Record<string, unknown> } }).data.capacity;
        expect(day.capacity).toEqual(figures);
        expect(JSON.parse(JSON.stringify(day))).toEqual(day);
    });
});
