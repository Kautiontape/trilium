/**
 * A sub-item whose parent is no longer live (a standup ticked with an answer not given) stays on
 * every reader that keeps top-level tasks, and a parent counts by its own estimate.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string, o: { checked?: boolean; sub?: string[] } = {}) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${o.checked ? " checked=\"checked\"" : ""} disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label>${o.sub ? `<ul class="todo-list">${o.sub.join("")}</ul>` : ""}</li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const MON = "2027-04-05";
const TUE = "2027-04-06";

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
const content = (noteId: string) => cls.init(() => store.content(noteId));

let monDay = "";

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        if (!root) await store.calendarDay(MON);
        monDay = (await store.calendarDay(MON)).noteId;
        await store.putContent(monDay, `<h2>☑️ Tasks</h2>${ul(
            li("t1", "Write the report ~20m"),
            li("p1", "Standup with Ana", { checked: true, sub: [ li("s1", "Ask Ben about ABC-12 ~15m"), li("s2", "Share the notes", { checked: true }) ] }),
            li("q1", "Plan the review", { sub: [ li("q1a", "Read the draft ~10m"), li("q1b", "Mark it up") ] }),
            li("r1", "Clear the inbox ~50m", { sub: [ li("r1a", "Reply to Ana ~5m") ] })
        )}`);
        await store.calendarDay(TUE);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a sub-item whose parent is not live", () => {
    it("is offered by the wind-down and kept in the day's list", async () => {
        at(`${MON}T17:30`);
        const open = await call("caius_winddown", { date: MON, step: "open" });
        const ids = open.data.items.map((item: any) => item.listItemId);
        expect(ids).toContain("s1");
        expect(ids).not.toContain("s2");

        const plan = await call("caius_planday", { date: MON, step: "brief" });
        expect(plan.data.list.map((item: any) => item.id)).toContain("s1");
    });

    it("cannot anchor a move of the main list", async () => {
        at(`${MON}T10:00`);
        const result = await call("caius_plan_apply", { date: MON, move: [ { listItemId: "t1", after: "s1" } ] });
        expect(result.skipped).toEqual([ expect.objectContaining({ kind: "move", reason: "not_in_main_list" }) ]);
    });

    it("counts a parent by its own estimate, else by its sub-items", async () => {
        at(`${MON}T10:00`);
        const brief = await call("caius_planday", { date: MON, step: "brief" });
        const minutes = (id: string) => brief.data.list.find((item: any) => item.id === id)?.minutes;
        expect(minutes("t1")).toBe(20);
        expect(minutes("r1")).toBe(50);
        expect(minutes("q1")).toBe(40);
    });

    it("moves on its own to the top level of the target day, with its from link", async () => {
        at(`${MON}T17:35`);
        const moved = await call("caius_forward", { items: [ { noteId: monDay, listItemId: "s1", to: TUE } ] });
        expect(moved.results[0]).toMatchObject({ status: "moved" });
        const target = await content((await cls.init(() => store.calendarDay(TUE))).noteId);
        expect(target).toContain("Ask Ben about ABC-12");
        expect(target).toContain("from ");
        expect(target).not.toMatch(/<li[^>]*>(?:(?!<\/li>).)*<ul[^>]*>(?:(?!<\/li>).)*Ask Ben/s);
    });
});
