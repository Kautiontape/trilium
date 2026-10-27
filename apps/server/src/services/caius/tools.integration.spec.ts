import { cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBeccaStore } from "./store.js";
import { caiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const PAST_DAY = "2031-05-04";
const TODAY = "2031-05-06";
const WEEK = "2031-W19";

const noteIds: Record<string, string> = {};

function toolNamed(name: string) {
    for (const [n, def] of caiusTools) {
        if (n === name) return def;
    }
    throw new Error(`Tool ${name} not registered`);
}

function call(name: string, args: object): Promise<any> {
    return cls.init(() => toolNamed(name).execute(args)) as Promise<any>;
}

beforeAll(async () => {
    await sql_init.dbReady;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2031, 4, 6, 10, 0, 0));

    await cls.init(async () => {
        const [root] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(TODAY), (await store.search("#calendarRoot"))[0]);
        await store.addLabel(calendarRoot!.noteId, "enableWeekNote", "");

        const past = await store.calendarDay(PAST_DAY);
        await store.putContent(past.noteId, `<h3>Work</h3>${ul(li("o1", "Overdue thing"))}`);
        const today = await store.calendarDay(TODAY);
        await store.putContent(today.noteId, `<h3>Work</h3>${ul(li("t1", "Today thing"), li("t2", "Move me"), li("t3", "Drop me"))}<h2>Suggested</h2>${ul(li("s1", "Maybe thing"), li("s2", "Skip thing"))}`);
        const week = await store.calendarWeek(WEEK);
        await store.putContent(week.noteId, `<h3>Work</h3>${ul(li("w1", "Week thing"))}`);
        Object.assign(noteIds, { past: past.noteId, today: today.noteId, week: week.noteId });
    });
});

afterAll(() => vi.useRealTimers());

describe("caius tools", () => {
    it("lists the eight tools, with reads non-mutating and writes async and mutating", () => {
        const defs = new Map([...caiusTools]);
        expect([...defs.keys()]).toEqual([
            "caius_plan", "caius_open", "caius_explain", "caius_add",
            "caius_accept", "caius_dismiss", "caius_set_state", "caius_forward"
        ]);
        for (const [name, def] of defs) {
            expect(def.async).toBe(true);
            expect(!!def.mutates).toBe(!["caius_plan", "caius_open", "caius_explain"].includes(name));
        }
    });

    it("caius_plan reads a day, and defaults to the current period", async () => {
        const view = await call("caius_plan", { period: "day", date: TODAY });
        expect(view.noteId).toBe(noteIds.today);
        expect(view.sections[0].tasks.map((t: any) => t.text)).toContain("Today thing");

        const current = await call("caius_plan", { period: "week" });
        expect(current.noteId).toBe(noteIds.week);

        expect(await call("caius_plan", { period: "day", date: "2031-W19" })).toHaveProperty("error");
    });

    it("caius_open lists lanes with ids and days late, and filters", async () => {
        const all = await call("caius_open", {});
        const byText = new Map<string, any>(all.tasks.map((t: any) => [t.text, t]));
        expect(byText.get("Overdue thing")).toMatchObject({ lane: "overdue", daysLate: 2, noteId: noteIds.past, listItemId: "o1" });
        expect(byText.get("Today thing")).toMatchObject({ lane: "today", listItemId: "t1" });
        expect(byText.get("Week thing")).toMatchObject({ lane: "week" });
        expect(byText.get("Maybe thing")).toMatchObject({ lane: "suggested", listItemId: "s1" });
        expect(byText.get("Today thing")).not.toHaveProperty("daysLate");
        expect(byText.get("Maybe thing")).toMatchObject({ horizon: null, state: "open", rank: expect.any(Number), path: expect.any(String), sectionKind: expect.any(String) });
        expect(byText.get("Today thing")).toMatchObject({ horizon: "today", line: expect.any(Number), parent: null });

        const overdue = await call("caius_open", { lane: "overdue" });
        expect(overdue.tasks.map((t: any) => t.text)).toEqual(["Overdue thing"]);
        expect((await call("caius_open", { limit: 1 })).tasks).toHaveLength(1);
    });

    it("caius_explain gives the rule and source for a lane, and not_found otherwise", async () => {
        const overdue = await call("caius_explain", { noteId: noteIds.past, listItemId: "o1" });
        expect(overdue).toMatchObject({ lane: "overdue", daysLate: 2 });
        expect(overdue.rule).toContain("past");
        expect(overdue.source).toContain(PAST_DAY);

        const suggested = await call("caius_explain", { noteId: noteIds.today, listItemId: "s1" });
        expect(suggested).toMatchObject({ lane: "suggested", rule: "Suggested section" });

        expect(await call("caius_explain", { noteId: noteIds.today, listItemId: "nope" })).toMatchObject({ error: "not_found" });
    });

    it("caius_add adds a task, with a dry run that writes nothing", async () => {
        const item = { date: TODAY, section: "Work", text: "Added by the model" };
        const dry = await call("caius_add", { items: [item], dryRun: true });
        expect(dry.results[0]).toMatchObject({ status: "added", dryRun: true });
        for (const change of dry.results[0].changes) {
            expect(change).not.toHaveProperty("before");
            expect(change).toHaveProperty("added");
        }
        const full = await call("caius_add", { items: [item], dryRun: true, html: true });
        expect(full.results[0].changes[0]).toHaveProperty("before");
        expect(full.results[0].changes[0]).toHaveProperty("after");
        expect((await call("caius_open", {})).tasks.map((t: any) => t.text)).not.toContain("Added by the model");

        const real = await call("caius_add", { items: [item] });
        expect(real.results[0]).toMatchObject({ status: "added" });
        expect((await call("caius_open", {})).tasks.map((t: any) => t.text)).toContain("Added by the model");
    });

    it("caius_accept and caius_dismiss act on Suggested items", async () => {
        const accepted = await call("caius_accept", { items: [{ noteId: noteIds.today, listItemId: "s1", section: "Work" }] });
        expect(accepted.results[0]).toMatchObject({ status: "accepted" });
        expect((await call("caius_open", { lane: "today" })).tasks.map((t: any) => t.text)).toContain("Maybe thing");

        const dismissed = await call("caius_dismiss", { items: [{ noteId: noteIds.today, listItemId: "s2" }] });
        expect(dismissed.results[0]).toMatchObject({ status: "dismissed" });
        expect((await call("caius_open", { lane: "suggested" })).tasks.map((t: any) => t.text)).not.toContain("Skip thing");
    });

    it("caius_set_state maps states to the library's actions, with a dry run first", async () => {
        const dry = await call("caius_set_state", { items: [{ noteId: noteIds.today, listItemId: "t1", state: "done" }], dryRun: true });
        expect(dry.results[0]).toMatchObject({ status: "updated", dryRun: true });
        expect((await call("caius_open", { lane: "today" })).tasks.map((t: any) => t.text)).toContain("Today thing");

        const real = await call("caius_set_state", {
            items: [
                { noteId: noteIds.today, listItemId: "t1", state: "done" },
                { noteId: noteIds.today, listItemId: "t3", state: "cancelled", reason: "no longer needed" }
            ]
        });
        expect(real.results.map((r: any) => [r.status, r.state])).toEqual([["updated", "done"], ["updated", "cancelled"]]);
        const open = (await call("caius_open", { lane: "today" })).tasks.map((t: any) => t.text);
        expect(open).not.toContain("Today thing");
        expect(open).not.toContain("Drop me");
    });

    it("caius_set_state rejects a cancelled task without a reason", () => {
        const schema = toolNamed("caius_set_state").inputSchema;
        const base = { noteId: "n", listItemId: "i" };
        expect(schema.safeParse({ items: [{ ...base, state: "cancelled" }] }).success).toBe(false);
        expect(schema.safeParse({ items: [{ ...base, state: "cancelled", reason: " " }] }).success).toBe(false);
        expect(schema.safeParse({ items: [{ ...base, state: "cancelled", reason: "moot" }] }).success).toBe(true);
        expect(schema.safeParse({ items: [{ ...base, state: "done" }] }).success).toBe(true);
    });

    it("caius_forward moves a task to a day or a week, and accepts a month", async () => {
        const result = await call("caius_forward", { items: [{ noteId: noteIds.today, listItemId: "t2", to: "2031-05-07" }] });
        expect(result.results[0]).toMatchObject({ status: "moved" });
        expect((await call("caius_plan", { period: "day", date: "2031-05-07" })).sections.flatMap((s: any) => s.tasks.map((t: any) => t.text)).join("\n")).toContain("Move me");

        await cls.init(async () => store.putContent(noteIds.today, `${await store.content(noteIds.today)}${ul(li("t4", "Back up to the week"))}`));
        const toWeek = await call("caius_forward", { items: [{ noteId: noteIds.today, listItemId: "t4", to: WEEK }] });
        expect(toWeek.results[0]).toMatchObject({ status: "moved" });
        const weekTexts = (await call("caius_plan", { period: "week", date: WEEK })).sections.flatMap((s: any) => s.tasks.map((t: any) => t.text));
        expect(weekTexts.join("\n")).toContain("Back up to the week");
        expect(await store.content(noteIds.today)).toContain(`href="#root/${noteIds.week}">week 19</a>`);

        const schema = toolNamed("caius_forward").inputSchema;
        const base = { noteId: "n", listItemId: "i" };
        for (const to of ["2031-W20", "2031-06", "2031-05-08"]) {
            expect(schema.safeParse({ items: [{ ...base, to }] }).success).toBe(true);
        }
        for (const to of ["tomorrow", "2031", "2031-W2"]) {
            expect(schema.safeParse({ items: [{ ...base, to }] }).success).toBe(false);
        }
    });
});
