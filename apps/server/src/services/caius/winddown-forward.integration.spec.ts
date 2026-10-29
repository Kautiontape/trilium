/**
 * A task he names in a wind-down that the wind-down didn't offer. The apply keeps to what the
 * steps showed, so the agent moves it on its own: `caius_assign_ids` gives it an id when it has
 * none (in that note only), `caius_plan` finds its ids, and `caius_forward` moves it to a day he named.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string | null, text: string) =>
    `<li${id ? ` data-list-item-id="${id}"` : ""}><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const OLD = "2027-03-01";
const OTHER = "2027-03-02";
const WED = "2027-03-10";
const FRI = "2027-03-12";

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

let oldDay = "";
let otherDay = "";

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        if (!root) await store.calendarDay(OLD);
        oldDay = (await store.calendarDay(OLD)).noteId;
        await store.putContent(oldDay, `<h2>☑️ Tasks</h2>${ul(li("o1", "Book the dentist ~15m"), li(null, "Return the library book"))}`);
        otherDay = (await store.calendarDay(OTHER)).noteId;
        await store.putContent(otherDay, `<h2>☑️ Tasks</h2>${ul(li(null, "Water the plants"))}`);
        const wed = await store.calendarDay(WED);
        await store.putContent(wed.noteId, `<h2>☑️ Tasks</h2>${ul(li("w1", "Write the report ~30m"))}`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("moving a task the wind-down didn't offer", () => {
    it("gives a task without an id one, in its own note only", async () => {
        at(`${WED}T17:55`);
        const dry = await call("caius_assign_ids", { noteId: oldDay });
        expect(dry).toMatchObject({ dryRun: true, notes: 1, added: 1 });
        const done = await call("caius_assign_ids", { noteId: oldDay, dryRun: false });
        expect(done).toMatchObject({ notes: 1, added: 1 });
        expect(await content(otherDay)).not.toContain("data-list-item-id");
        expect(await call("caius_assign_ids", { noteId: "root", dryRun: false })).toMatchObject({ error: "not_found" });

        const plan = await call("caius_plan", { period: "day", date: OLD });
        const task = plan.sections.flatMap((s: any) => s.tasks).find((t: any) => t.text.startsWith("Return the library book"));
        expect(task.listItemId).toMatch(/^e[0-9a-f]{32}$/);
    });

    it("is refused by the apply, and moved by caius_forward to the day he named", async () => {
        at(`${WED}T18:00`);
        const open = await call("caius_winddown", { date: WED, step: "open" });
        expect(open.data.items.map((item: any) => item.listItemId)).toEqual([ "w1" ]);
        const friday = open.data.days.find((day: any) => day.date === FRI);
        expect(friday).toBeDefined();

        // The apply's guard stays: an item the steps didn't show is not_offered, and nothing moves.
        const refused = await call("caius_winddown_apply", { date: WED, fates: [ { listItemId: "o1", to: FRI } ] });
        expect(refused.skipped).toEqual(expect.arrayContaining([ expect.objectContaining({ reason: "not_offered" }) ]));
        expect(await content(oldDay)).not.toContain("_rescheduled");

        // The agent finds it on the day he named and moves it on its own.
        const plan = await call("caius_plan", { period: "day", date: OLD });
        const task = plan.sections.flatMap((s: any) => s.tasks).find((t: any) => t.text.startsWith("Book the dentist"));
        expect(task).toMatchObject({ noteId: oldDay, listItemId: "o1" });
        const moved = await call("caius_forward", { items: [ { noteId: task.noteId, listItemId: task.listItemId, to: friday.date } ] });
        expect(moved.results[0]).toMatchObject({ status: "moved" });
        const target = (await cls.init(() => store.calendarDay(FRI))).noteId;
        expect(await content(target)).toContain("Book the dentist");
        expect(await content(oldDay)).toContain("_rescheduled");
    });
});
