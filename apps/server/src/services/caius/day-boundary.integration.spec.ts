/**
 * The day boundary: Shawn works until 1 to 4 AM, so before the rollover in the standing note's
 * Rhythm it is still the day he started, and a bedtime after midnight counts on from 24:00.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const MON = "2026-11-02";
const TUE = "2026-11-03";
const FRI = "2026-11-06";
const SAT = "2026-11-07";
const NEXT_MON = "2026-11-09";

const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date,
        jira: { handoff: [], asks: [], done: [] },
        calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }),
        errors: []
    };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

const rhythm = (...lines: string[]) => `<h2>Rhythm</h2><ul>${[ "Work starts at standup, 10:00.", ...lines ].map((line) => `<li>${line}</li>`).join("")}</ul>`;
let standingId = "";

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    // An apply answers a reply of his; a test without one passes none.
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

/** Sets the Caius clock. */
const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

const setRhythm = (...lines: string[]) => cls.init(() => store.putContent(standingId, rhythm(...lines)));

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        standingId = createChildNote("root", "🧭 How I work", rhythm("Bedtime: 2:30 AM.", "The day rolls over at 04:00."));
        await store.addLabel(standingId, "assistantContext", "");
        const monday = await store.calendarDay(MON);
        await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("m1", "Write the report ~30m"), li("m2", "Review the patch ~30m"), li("m3", "Tidy the inbox ~15m"))}`);
        const friday = await store.calendarDay(FRI);
        await store.putContent(friday.noteId, `<h2>☑️ Tasks</h2>${ul(li("f1", "Friday thing ~30m"))}`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("today before the rollover", () => {
    it("is yesterday for the plan, until 04:00", async () => {
        at(`${TUE}T00:00`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(MON);
        at(`${TUE}T03:59`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(MON);
        at(`${TUE}T04:00`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(TUE);
    });

    it("moves with the rollover the standing note gives", async () => {
        await setRhythm("Bedtime: 2:30 AM.", "The day rolls over at 03:00.");
        at(`${TUE}T03:30`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(TUE);
        at(`${TUE}T02:30`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(MON);
        await setRhythm("Bedtime: 2:30 AM.");
        at(`${TUE}T03:30`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(MON);
        await setRhythm("Bedtime: 2:30 AM.", "The day rolls over at 04:00.");
    });
});

describe("Wind down in the small hours", () => {
    it("Tue 01:30: it closes Monday against Tuesday, and does not go on to plan Tuesday", async () => {
        at(`${TUE}T01:30`);
        const open = await call("caius_winddown", { date: MON, step: "open" });
        expect(open).toMatchObject({ date: MON, targetDay: TUE });
        expect(open.data.items.map((item: any) => item.listItemId)).toEqual(expect.arrayContaining([ "m1", "m2", "m3" ]));
        const applied = await call("caius_winddown_apply", { date: MON, done: [ "m1" ] });
        expect(applied).toMatchObject({ date: MON, targetDay: TUE, next: null });
        expect(applied.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "done", status: "written" }) ]));
    });

    it("Tue 04:30: the same Review is a morning one, which goes on to plan Tuesday", async () => {
        at(`${TUE}T04:30`);
        expect(await call("caius_winddown_apply", { date: MON, done: [ "m2" ] })).toMatchObject({ targetDay: TUE, next: "planday" });
    });

    it("Sat 01:30 after a Friday: still Friday, so it winds down towards Monday", async () => {
        at(`${SAT}T01:30`);
        expect(await call("caius_winddown", { date: FRI, step: "open" })).toMatchObject({ date: FRI, targetDay: NEXT_MON });
        expect((await call("caius_plan", { period: "day" })).key).toBe(FRI);
        at(`${SAT}T04:30`);
        expect((await call("caius_plan", { period: "day" })).key).toBe(SAT);
    });
});

describe("Plan my day in the small hours", () => {
    it("Tue 01:30: plans Monday, from 25:30, and refuses Tuesday", async () => {
        at(`${TUE}T01:30`);
        expect(await call("caius_planday", { date: TUE, step: "inputs" })).toMatchObject({ error: "not_today" });
        const offer = await call("caius_planday", { date: MON, step: "inputs" });
        expect(offer.error).toBeUndefined();
        expect(offer.data).toMatchObject({ planFrom: "25:30" });
        const brief = await call("caius_planday", { date: MON, step: "brief" });
        expect(brief.data.day).toMatchObject({ end: "26:30", from: { end: "rhythm", rollover: "rhythm" } });
        expect(brief.data.header).toMatchObject({ start: "10:00", end: "26:30" });
    });

    it("Tue 04:30: it is Tuesday, planned from standup", async () => {
        at(`${TUE}T04:30`);
        const offer = await call("caius_planday", { date: TUE, step: "inputs" });
        expect(offer.error).toBeUndefined();
        expect(offer.data).not.toHaveProperty("planFrom");
    });

    it("Sat 01:30 after a Friday: plans Friday's remaining evening up to bedtime, and refuses Saturday", async () => {
        at(`${SAT}T01:30`);
        expect(await call("caius_planday", { date: SAT, step: "inputs" })).toMatchObject({ error: "not_today" });
        expect((await call("caius_planday", { date: FRI, step: "inputs" })).data).toMatchObject({ planFrom: "25:30" });
        const brief = await call("caius_planday", { date: FRI, step: "brief" });
        expect(brief.data.header).toMatchObject({ end: "26:30", work: [ { start: "25:30", end: "26:00", label: "Friday thing" } ] });
    });

    it("Sat 01:30: a bedtime of 1:00 AM has passed, so nothing is placed and the day ends at 25:00", async () => {
        await setRhythm("Bedtime: 1:00 AM.");
        at(`${SAT}T01:30`);
        const brief = await call("caius_planday", { date: FRI, step: "brief" });
        expect(brief.data.header.end).toBe("25:00");
        expect(brief.data.header.work).toEqual([]);
        await setRhythm("Bedtime: 2:30 AM.", "The day rolls over at 04:00.");
    });
});

describe("the drawing", () => {
    it("takes a bedtime past 24:00", async () => {
        at(`${TUE}T01:30`);
        const note = await cls.init(() => store.calendarDay(MON));
        const drawn = await call("caius_header", { noteId: note.noteId, start: "10:00", end: "25:00", workEnd: "18:00", events: [], work: [ { start: "22:00", end: "24:30", label: "Late" } ] });
        expect(drawn.attachmentId).toBeTruthy();
    });
});
