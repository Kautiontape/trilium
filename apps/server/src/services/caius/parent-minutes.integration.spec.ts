/**
 * A parent without an estimate of its own counts its sub-items (`unitMinutes`) wherever the steps
 * show or weigh its minutes: On deck, the wind-down's leftovers and a pinned Growth parent's span.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string, sub: string[] = []) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label>${sub.length ? `<ul class="todo-list">${sub.join("")}</ul>` : ""}</li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const family = (id: string, text: string) => li(id, text, [ 1, 2, 3, 4 ].map((n) => li(`${id}${n}`, `Step ${n} of ${text}`)));

const DECK_DAY = "2027-05-10";
const CLOSING_DAY = "2027-05-14";
const PINNED_DAY = "2027-05-11";

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

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        if (!root) await store.calendarDay(DECK_DAY);
        const put = async (date: string, html: string) => store.putContent((await store.calendarDay(date)).noteId, html);
        // 3 h 20 m on the list leaves 40 minutes of the 4 h focus.
        await put(DECK_DAY, `<h3>Work</h3>${ul(li("big", "Write the proposal ~3h20m"))}<h2>On deck</h2>${ul(family("dp", "Tidy the garage"))}`);
        await put(CLOSING_DAY, `<h3>Work</h3>${ul(family("cp", "Sort the cellar"))}`);
        await put(PINNED_DAY, `<h3>Work</h3>${ul(li("gp", "🌱 15:00 Study session", [ li("gp1", "Read ch. 1"), li("gp2", "Read ch. 2") ]))}`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a parent with no estimate of its own", () => {
    it("is On deck at the sum of its sub-items, and is not proposed onto a day without room for it", async () => {
        at(`${DECK_DAY}T08:00`);
        const answer = await call("caius_planday", { date: DECK_DAY, step: "inputs" });
        expect(answer.data.onDeck).toMatchObject([ { listItemId: "dp", minutes: 120, fate: { forward: expect.any(String) } } ]);
    });

    it("carries its minutes in the wind-down's leftovers", async () => {
        at(`${CLOSING_DAY}T17:30`);
        const answer = await call("caius_winddown", { date: CLOSING_DAY, step: "open" });
        expect(answer.data.items.find((item: any) => item.listItemId === "cp")).toMatchObject({ minutes: 120 });
    });

    it("takes its sub-items' time from the open time when it is a Growth task pinned to a clock", async () => {
        at(`${PINNED_DAY}T09:30`);
        const answer = await call("caius_planday", { date: PINNED_DAY, step: "inputs" });
        expect(answer.data.capacity).toMatchObject({ bookedMinutes: 0, openMinutes: 420 });
    });
});
