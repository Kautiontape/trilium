/**
 * A task moved on, whose source note the desktop editor then saved: its "scheduled" mark is no
 * longer `<em>scheduled <a>…</a></em>` but the shape CKEditor saves (`caius_markup.spec.ts` in the
 * client). The trail, Plan my day's count of yesterday and a wind-down's answers must still read
 * the line as moved and follow it to its copy, with and without a Rescheduled state note in the
 * test database.
 */
import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { yesterdayOf } from "./daily.js";
import type { CaiusInputs, JiraInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";
import { slipsOf, trailOf, trails } from "./trail.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    return { date: input.date, jira, calendar: [], capacity: dayCapacity([], { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}
const tools = createCaiusTools(undefined, async () => ({ code: 3, label: "Overcast" }), stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

/**
 * The "scheduled" mark of a note as CKEditor saves it: a plain link, or a reference link written
 * before 26 Oct. `none` leaves the mark as Caius wrote it.
 */
const EDITOR_SAVES = {
    none: (html: string) => html,
    plain: (html: string) => html.replace(/<em>scheduled (<a href="#root\/[^"]+">)([^<]*)<\/a><\/em>/g, "<em>scheduled </em>$1<em>$2</em></a>"),
    reference: (html: string) => html.replace(/<em>scheduled <a (href="#root\/[^"]+")>[^<]*<\/a><\/em>/g, "<em>scheduled&nbsp;</em><a class=\"reference-link\" $1>08 - Tuesday</a>")
};
type Shape = keyof typeof EDITOR_SAVES;

const dayId = (date: string) => cls.init(async () => (await store.calendarDay(date)).noteId);
const idIn = async (noteId: string) => /data-list-item-id="([^"]+)"/.exec(await cls.init(() => store.content(noteId)))?.[1] ?? "";

/** Saves `noteId` as the editor would; fails when the note holds no mark to reshape. */
async function editorSave(noteId: string, shape: Shape) {
    await cls.init(async () => {
        const html = await store.content(noteId);
        const saved = EDITOR_SAVES[shape](html);
        if (saved === html && shape !== "none") throw new Error(`no scheduled mark in ${noteId}`);
        await store.putContent(noteId, saved, html);
    });
}

/** Writes "Ring the plumber" on `from`, forwards it to `to` and saves `from` in the editor; the copy's trail item. */
async function moveAndSave(from: string, to: string, shape: Shape) {
    const fromId = await dayId(from);
    await cls.init(() => store.putContent(fromId, `<h3>Work</h3>${ul(li(`${from}-t`, "Ring the plumber"))}`));
    const moved = await call("caius_forward", { items: [ { noteId: fromId, listItemId: `${from}-t`, to } ] });
    expect(moved.results[0].status).toBe("moved");
    await editorSave(fromId, shape);
    const toId = await dayId(to);
    return { noteId: toId, listItemId: await idIn(toId), text: `Ring the plumber [from a day](#root/${fromId})` };
}

/** Each task of the day's list as its words and state. */
async function statesOn(date: string) {
    const plan = await call("caius_plan", { period: "day", date });
    return plan.sections.flatMap((s: any) => s.tasks).map((t: any) => [ t.text.replace(/\s*\[from [^\]]*\]\([^)]*\)/, ""), t.state ]);
}

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay("2031-04-07"), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

// The test database has no Rescheduled state note; the scan still reads `_rescheduled` as moved.
describe.each([
    [ "as written", "none", "2031-03-31", "2031-04-01" ],
    [ "saved with a plain link", "plain", "2031-04-07", "2031-04-08" ],
    [ "saved with a reference link", "reference", "2031-04-14", "2031-04-15" ]
] as const)("a task moved on, its mark %s, no state note", (_label, shape, mon, tue) => {
    let copy: Awaited<ReturnType<typeof moveAndSave>>;
    beforeAll(async () => {
        copy = await moveAndSave(mon, tue, shape);
    });

    it("keeps one trail, the saved line moved on", async () => {
        const all = await cls.init(() => trails(store, new Date(`${tue}T12:00:00`)));
        expect(trailOf(all, copy)?.copies.map((c) => [ c.period, c.movedOn ])).toEqual([ [ mon, true ], [ tue, false ] ]);
        expect(slipsOf(all, copy)).toBe(1);
    });

    it("counts the saved line as moved on in Plan my day's yesterday, not done", async () => {
        const yesterday = await cls.init(() => yesterdayOf(store, tue, new Date(`${tue}T09:00:00`)));
        expect({ moved: yesterday.moved, done: yesterday.done }).toEqual({ moved: 1, done: 0 });
    });

    it("ticks the copy when a wind-down calls the moved task done", async () => {
        vi.stubEnv("CAIUS_NOW", `${mon}T17:45`);
        const done = await call("caius_winddown_apply", { date: mon, done: [ "Ring the plumber" ] });
        expect.soft(done.skipped).toEqual([]);
        expect(await statesOn(tue)).toEqual([ [ "Ring the plumber", "done" ] ]);
    });
});

// A mark with no link after it is not a mark: the line stays open.
describe("a task with a bare italic \"scheduled\", no state note", () => {
    const mon = "2031-05-05";
    const tue = "2031-05-06";

    it("keeps the copy's trail unmoved and counts the line open in Plan my day's yesterday", async () => {
        const fromId = await dayId(mon);
        const bare = `<h3>Work</h3>${ul(li(`${mon}-t`, "Ring the plumber <em>scheduled</em>"))}`;
        await cls.init(() => store.putContent(fromId, `<h3>Work</h3>${ul(li(`${mon}-t`, "Ring the plumber"))}`));
        const moved = await call("caius_forward", { items: [ { noteId: fromId, listItemId: `${mon}-t`, to: tue } ] });
        expect(moved.results[0].status).toBe("moved");
        await cls.init(async () => store.putContent(fromId, bare, await store.content(fromId)));
        const toId = await dayId(tue);
        const copy = { noteId: toId, listItemId: await idIn(toId), text: `Ring the plumber [from a day](#root/${fromId})` };

        const all = await cls.init(() => trails(store, new Date(`${tue}T12:00:00`)));
        expect(trailOf(all, copy)?.copies.map((c) => [ c.period, c.movedOn ])).toEqual([ [ mon, false ], [ tue, false ] ]);
        const yesterday = await cls.init(() => yesterdayOf(store, tue, new Date(`${tue}T09:00:00`)));
        expect({ open: yesterday.open, moved: yesterday.moved }).toEqual({ open: 1, moved: 0 });
    });
});

// One click on a moved line's checkbox clears its state and unticks it but keeps the mark: the
// state wins, so the line is open.
describe("a moved task reopened with a click, no state note", () => {
    const mon = "2031-05-12";
    const tue = "2031-05-13";
    let copy: Awaited<ReturnType<typeof moveAndSave>>;
    beforeAll(async () => {
        copy = await moveAndSave(mon, tue, "plain");
        const fromId = await dayId(mon);
        await cls.init(async () => {
            const html = await store.content(fromId);
            const reopened = html.replace(/ data-trilium-task-state="[^"]*"/, "").replace(/ title="[^"]*"/, "").replace(/ checked="checked"/, "");
            if (reopened === html) throw new Error("nothing to reopen");
            await store.putContent(fromId, reopened, html);
        });
    });

    it("keeps the saved line open on its trail and in Plan my day's yesterday", async () => {
        const all = await cls.init(() => trails(store, new Date(`${tue}T12:00:00`)));
        expect(trailOf(all, copy)?.copies.map((c) => [ c.period, c.movedOn ])).toEqual([ [ mon, false ], [ tue, false ] ]);
        const yesterday = await cls.init(() => yesterdayOf(store, tue, new Date(`${tue}T09:00:00`)));
        expect({ open: yesterday.open, moved: yesterday.moved }).toEqual({ open: 1, moved: 0 });
    });

    it("ticks that line when a wind-down calls it done, and leaves the copy open", async () => {
        vi.stubEnv("CAIUS_NOW", `${mon}T17:45`);
        const done = await call("caius_winddown_apply", { date: mon, done: [ "Ring the plumber" ] });
        expect.soft(done.skipped).toEqual([]);
        expect((await statesOn(mon)).map(([ words, state ]: string[]) => [ words.replace(/\s*_scheduled.*$/, ""), state ])).toEqual([ [ "Ring the plumber", "done" ] ]);
        expect(await statesOn(tue)).toEqual([ [ "Ring the plumber", "open" ] ]);
    });

    it("counts the line ticked done as done, not moved on", async () => {
        const all = await cls.init(() => trails(store, new Date(`${tue}T12:00:00`)));
        expect(trailOf(all, copy)?.copies.map((c) => [ c.period, c.movedOn ])).toEqual([ [ mon, false ], [ tue, false ] ]);
        const yesterday = await cls.init(() => yesterdayOf(store, tue, new Date(`${tue}T09:00:00`)));
        expect({ done: yesterday.done, moved: yesterday.moved, open: yesterday.open }).toEqual({ done: 1, moved: 0, open: 0 });
    });
});

// Last: the state note stays for the rest of the file. The same cases as above with the state
// listed, to pin that both symbol sets agree.
describe("the Rescheduled state known", () => {
    beforeAll(() => cls.init(async () => {
        const state = createChildNote("_taskStates", "Rescheduled", "");
        await store.addLabel(state, "stateId", "_rescheduled");
        await store.addLabel(state, "markdownSymbol", ">");
    }));

    describe.each([
        [ "as written", "none", "2031-04-21", "2031-04-22" ],
        [ "saved with a plain link", "plain", "2031-04-28", "2031-04-29" ]
    ] as const)("a task moved on, its mark %s", (_label, shape, mon, tue) => {
        let copy: Awaited<ReturnType<typeof moveAndSave>>;
        beforeAll(async () => {
            copy = await moveAndSave(mon, tue, shape);
        });

        it("keeps one trail", async () => {
            const all = await cls.init(() => trails(store, new Date(`${tue}T12:00:00`)));
            expect(trailOf(all, copy)?.copies.map((c) => [ c.period, c.movedOn ])).toEqual([ [ mon, true ], [ tue, false ] ]);
        });

        it("ticks the copy when a wind-down calls the moved task done", async () => {
            vi.stubEnv("CAIUS_NOW", `${mon}T17:45`);
            const done = await call("caius_winddown_apply", { date: mon, done: [ "Ring the plumber" ] });
            expect.soft(done.skipped).toEqual([]);
            expect(await statesOn(tue)).toEqual([ [ "Ring the plumber", "done" ] ]);
        });
    });
});
