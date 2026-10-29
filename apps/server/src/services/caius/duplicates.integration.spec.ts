/**
 * Two notes for one period. Trilium's calendar sometimes misses a day's note and makes a second
 * one; the older note is the real one, whatever the newer holds (even Caius's own labels), so
 * Caius reads and writes the older, names the newer in a warning, and still counts its open
 * tasks as the period's leftovers. Nothing is merged or deleted.
 */

import { dayCapacity } from "@triliumnext/caius";
import { becca, cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import sql from "../sql.js";
import type { CaiusInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const WED = "2027-02-10";
const THU = "2027-02-11";
const WEEK = "2027-W06";

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    return { date: input.date, jira: { handoff: [], asks: [], done: [] }, calendar: [], capacity: dayCapacity([], { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

/** Sets a note's creation time, in becca and in the database. */
function createdAt(noteId: string, utc: string) {
    const note = becca.notes[noteId];
    if (!note) throw new Error(`no note ${noteId}`);
    note.utcDateCreated = utc;
    sql.execute("UPDATE notes SET utcDateCreated = ? WHERE noteId = ?", [ utc, noteId ]);
}

/** The ids of the live notes labelled `#name=value`. */
const labelled = (name: string, value: string) => sql.getColumn<string>(
    "SELECT DISTINCT attributes.noteId FROM attributes JOIN notes USING (noteId) WHERE attributes.type = 'label' AND name = ? AND value = ? AND attributes.isDeleted = 0 AND notes.isDeleted = 0",
    [ name, value ]
);

const content = (noteId: string) => cls.init(() => store.content(noteId));

// The spurious notes are made first in this database and sort first in a search, so a lookup that
// takes the first hit finds them. The real ones are made after, but are older.
let spuriousDay = "";
let realDay = "";
let spuriousWeek = "";
let realWeek = "";

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay("2027-01-04"), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");

        // Trilium's calendar makes the day: it is the newer, spurious one. It was even wound down,
        // as production's was. Its week, by Trilium's own week settings, is not Caius's ISO week,
        // so the spurious ISO week note is made by hand, also first.
        const spurious = await store.calendarDay(WED);
        spuriousDay = spurious.noteId;
        await store.putContent(spuriousDay, `<h2>☑️ Tasks</h2>${ul(li("s1", "Stray task on the second note ~15m"))}`);
        await store.addLabel(spuriousDay, "caiusWoundDown", `${WED}T18:00:00`);
        const month = (await store.note(spurious.parentNoteIds[0]!)).parentNoteIds[0]!;
        spuriousWeek = createChildNote(month, "Week 6 (again)", `<h2>☑️ Tasks</h2>${ul(li("sw1", "Stray week task"))}`);
        await store.addLabel(spuriousWeek, "weekNote", WEEK);

        // The real ones, older. Trilium's search orders hits by their path's title, so these are
        // titled to come after the spurious ones: a lookup that takes the first hit gets it wrong.
        realWeek = createChildNote(month, "Wk 6", `<h2>☑️ Tasks</h2>${ul(li("w1", "Ship the release notes ~1h"))}`);
        await store.addLabel(realWeek, "weekNote", WEEK);
        realDay = createChildNote(realWeek, "10 - Wednesday", `<h2>☑️ Tasks</h2>${ul(li("r1", "Write the report ~30m"), li("r2", "Review the patch ~30m"))}`);
        await store.addLabel(realDay, "dateNote", WED);
        createdAt(realWeek, "2027-02-08 08:00:00.000Z");
        createdAt(realDay, "2027-02-10 08:00:00.000Z");
        createdAt(spuriousWeek, "2027-02-10 19:00:00.000Z");
        createdAt(spuriousDay, "2027-02-10 19:00:00.000Z");
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a day with two notes", () => {
    it("reads the older one, and names the newer in a warning", async () => {
        at(`${WED}T09:00`);
        const plan = await call("caius_plan", { period: "day", date: WED });
        expect(plan.noteId).toBe(realDay);
        expect(plan.sections.flatMap((s: any) => s.tasks).map((t: any) => t.listItemId)).toEqual([ "r1", "r2" ]);
        expect(plan.warnings).toEqual([ `${WED} has a second day note ${spuriousDay}; using the older ${realDay}.` ]);
        expect(labelled("dateNote", WED).sort()).toEqual([ realDay, spuriousDay ].sort());
    });

    it("takes the older one from the store's calendar, and creates no third note", async () => {
        expect((await cls.init(() => store.calendarDay(WED))).noteId).toBe(realDay);
        expect((await cls.init(() => store.calendarWeek(WEEK))).noteId).toBe(realWeek);
        expect(labelled("dateNote", WED)).toHaveLength(2);
        expect(labelled("weekNote", WEEK)).toHaveLength(2);
    });

    it("counts the newer note's open tasks in the next morning's catch-up, and ignores its wind-down label", async () => {
        at(`${THU}T09:00`);
        const catchup = await call("caius_planday", { date: THU, step: "catchup" });
        expect(catchup.data.days).toEqual([ WED ]);
        expect(catchup.data.tasks.map((t: any) => t.listItemId).sort()).toEqual([ "r1", "r2", "s1" ]);
        expect(catchup.warnings).toEqual(expect.arrayContaining([ `${WED} has a second day note ${spuriousDay}; using the older ${realDay}.` ]));
    });

    it("lists the older note's open tasks in Wind down, with the newer note's, and closes the older one", async () => {
        at(`${WED}T18:00`);
        const open = await call("caius_winddown", { date: WED, step: "open" });
        const items = open.data.items.map((item: any) => item.listItemId);
        expect(items).toEqual(expect.arrayContaining([ "r1", "r2", "s1", "w1", "sw1" ]));
        expect(open.data.items.find((item: any) => item.listItemId === "r1")).toMatchObject({ group: "today", noteId: realDay, fate: { forward: THU } });
        expect(open.data.items.find((item: any) => item.listItemId === "s1")).toMatchObject({ group: "today", noteId: spuriousDay });
        expect(open.warnings).toEqual(expect.arrayContaining([
            `${WED} has a second day note ${spuriousDay}; using the older ${realDay}.`,
            `${WEEK} has a second week note ${spuriousWeek}; using the older ${realWeek}.`
        ]));

        const applied = await call("caius_winddown_apply", { date: WED, done: [ "r2" ] });
        expect(applied.warnings).toEqual(expect.arrayContaining([ `${WED} has a second day note ${spuriousDay}; using the older ${realDay}.` ]));
        expect(becca.notes[realDay]!.getOwnedLabels("caiusWoundDown")).toHaveLength(1);
        const thursday = labelled("dateNote", THU);
        expect(thursday).toHaveLength(1);
        const moved = await content(thursday[0]!);
        expect(moved).toContain("Write the report");
        expect(moved).toContain("Stray task on the second note");
        expect(await content(realDay)).toContain("_rescheduled");
        expect(labelled("dateNote", WED)).toHaveLength(2);
    });
});

describe("a week with two notes", () => {
    it("reads the older one, warns, and forwards into it", async () => {
        at(`${THU}T09:00`);
        const plan = await call("caius_plan", { period: "week", date: WEEK });
        expect(plan.noteId).toBe(realWeek);
        expect(plan.warnings).toEqual([ `${WEEK} has a second week note ${spuriousWeek}; using the older ${realWeek}.` ]);

        const thursday = labelled("dateNote", THU)[0]!;
        const before = (await call("caius_plan", { period: "day", date: THU })).sections.flatMap((s: any) => s.tasks);
        const task = before.find((t: any) => t.text.startsWith("Write the report"));
        const dry = await call("caius_forward", { items: [ { noteId: thursday, listItemId: task.listItemId, to: WEEK } ], dryRun: true });
        expect(dry.results[0]).toMatchObject({ status: "moved", dryRun: true });
        expect(dry.results[0].changes[0].noteId).toBe(realWeek);
        const result = await call("caius_forward", { items: [ { noteId: thursday, listItemId: task.listItemId, to: WEEK } ] });
        expect(result.results[0]).toMatchObject({ status: "moved" });
        expect(await content(realWeek)).toContain("Write the report");
        expect(await content(spuriousWeek)).not.toContain("Write the report");
        expect(labelled("weekNote", WEEK)).toHaveLength(2);
    });
});
