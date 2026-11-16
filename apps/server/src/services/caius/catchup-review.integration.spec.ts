/**
 * A catch-up review: the wind-down of an older day run from a later one. "Later this week" and
 * "next week" count from the day the review works against, not from the week the reviewed day is in.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string | null, text: string) =>
    `<li${id ? ` data-list-item-id="${id}"` : ""}><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const REVIEWED = "2026-11-10";
const TODAY = "2026-11-16";

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return { date: input.date, jira, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(REVIEWED), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        const day = await store.calendarDay(REVIEWED);
        await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("r1", "Write the report ~30m"))}`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a catch-up review's week refs", () => {
    it("sends 'later this week' to the week of the day the review works against", async () => {
        at(`${TODAY}T19:00`);
        const open = await call("caius_winddown", { date: REVIEWED, step: "open" });
        const item = open.data.items[0];
        expect(item.listItemId).toBe("r1");

        const done = await call("caius_winddown_apply", { date: REVIEWED, fates: [ { listItemId: item.listItemId, to: "w1" } ] });
        expect(done.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "fate", id: "r1", detail: "2026-W47", status: "written" }) ]));

        const week = await call("caius_plan", { period: "week", date: "2026-W47" });
        const texts = week.sections.flatMap((s: any) => s.tasks).map((task: any) => task.text);
        expect(texts.some((text: string) => text.startsWith("Write the report"))).toBe(true);
    });
});
