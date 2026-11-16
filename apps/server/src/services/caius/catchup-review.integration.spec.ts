/**
 * A catch-up review: the wind-down of an older day run from a later one. "Later this week" and
 * "next week" count from the day the review works against, not from the week the reviewed day is in.
 * It writes only the reviewed day: what it would offer or write for the target day is left to Plan my day.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs, JiraTicket } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string | null, text: string) =>
    `<li${id ? ` data-list-item-id="${id}"` : ""}><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const bullets = (...items: string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const REVIEWED = "2026-11-10";
const TODAY = "2026-11-16";

const ticket = (key: string, summary: string): JiraTicket => ({
    key, summary, status: "Code Review", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-11-09T10:00:00.000-0500"
});

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

/** The values of the label `name` on the day note of `date`. */
async function labelsOf(date: string, name: string) {
    const [ note ] = await cls.init(() => store.search(`#dateNote="${date}"`));
    return note?.attributes.filter((a) => a.type === "label" && a.name === name).map((a) => a.value) ?? [];
}

describe("a catch-up review writes only the reviewed day", () => {
    beforeAll(async () => {
        jira.handoff.push(
            { ...ticket("ABC-21", "Check the invoice export"), daysInStatus: 2 },
            { ...ticket("ABC-22", "Review the importer"), daysInStatus: 2 },
            { ...ticket("ABC-23", "Verify the upload retry"), daysInStatus: 2 }
        );
        await cls.init(async () => {
            const week = await store.calendarWeek("2026-W46");
            await store.putContent(week.noteId, `<h3>Context</h3>${bullets("Ben covers the on-call rotation", "Ana reviews the release notes")}`);
        });
    });

    it("Mon 19:00, Review of Tue 10: done, fates, the drop, an open item's area and the forward's move are written; the rest is left for Plan my day", async () => {
        await cls.init(async () => {
            const reviewed = await store.calendarDay(REVIEWED);
            const before = await store.content(reviewed.noteId);
            const added = [ li("cr-done", "Send the invoice ~15m"), li("cr-fwd", "Draft the agenda ~30m"), li("cr-drop", "Book the room"), li("cr-area", "Read the design doc ~30m") ];
            await store.putContent(reviewed.noteId, before.replace("</ul>", `${added.join("")}</ul>`));
            const target = await store.calendarDay(TODAY);
            await store.putContent(target.noteId, `<h2>☑️ Tasks</h2>${ul(li("cr-list", "Review the roadmap ~30m"))}`);
        });
        at(`${TODAY}T19:00`);
        const open = await call("caius_winddown", { date: REVIEWED, step: "open" });
        expect(open.data.items.map((item: any) => item.listItemId)).toEqual([ "cr-done", "cr-fwd", "cr-drop", "cr-area" ]);
        const next = await call("caius_winddown", { date: REVIEWED, step: "next", refresh: true });
        expect(next.data.candidates.map((c: any) => c.candidateId)).toEqual(expect.arrayContaining([ "ABC-21", "ABC-22", "ABC-23" ]));
        const context = await call("caius_winddown", { date: REVIEWED, step: "context" });
        const carry = context.data.noticed.find((line: any) => line.line === "Ben covers the on-call rotation");
        expect(carry).toMatchObject({ kind: "carry" });

        const applied = await call("caius_winddown_apply", {
            date: REVIEWED,
            done: [ "cr-done" ],
            fates: [ { listItemId: "cr-fwd", to: TODAY }, { listItemId: "cr-drop", drop: "not needed" } ],
            areas: [ { item: "cr-area", area: "growth" }, { item: "cr-list", area: "recharge" } ],
            accept: [ { candidateId: "ABC-21" } ],
            notToday: [ { candidateId: "ABC-23" } ],
            carry: [ { lineId: carry.lineId } ],
            context: [ "Ana is out Tuesday" ],
            move: [ { listItemId: "cr-fwd", first: true }, { listItemId: "cr-list", after: "cr-area" } ]
        });
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "done", id: "cr-done", status: "written" }),
            expect.objectContaining({ kind: "fate", id: "cr-fwd", detail: TODAY, status: "written" }),
            expect.objectContaining({ kind: "fate", id: "cr-drop", detail: "dropped", status: "written" }),
            expect.objectContaining({ kind: "area", id: "cr-area", detail: "growth", status: "written" }),
            expect.objectContaining({ kind: "move", id: "cr-fwd", detail: "first", status: "written" })
        ]));
        const later = { reason: "review_only", detail: expect.stringContaining("Plan my day") };
        expect(applied.skipped).toEqual([
            { kind: "area", id: "cr-list", text: expect.stringContaining("Review the roadmap"), ...later },
            { kind: "accept", id: "ABC-21", text: expect.stringContaining("ABC-21"), ...later },
            { kind: "not_today", id: "ABC-23", text: expect.stringContaining("ABC-23"), ...later },
            { kind: "move", id: "cr-list", text: expect.stringContaining("Review the roadmap"), ...later },
            { kind: "carry", id: carry.lineId, text: "Ben covers the on-call rotation", ...later },
            { kind: "context", text: "Ana is out Tuesday", ...later }
        ]);
        expect(applied.say).toContain("Review the roadmap, ABC-21, ABC-23, Ben covers the on-call rotation and Ana is out Tuesday are left for Plan my day");

        // The target day keeps his list as it was, with the forward placed first, and nothing else of the review's.
        // The skipped move's anchor stays on the On deck its proposed fate gives it.
        const plan = await call("caius_plan", { period: "day", date: TODAY });
        const words = (tasks: any[]) => tasks.map((task: any) => task.text.split(" [")[0]);
        expect(words(plan.sections.flatMap((s: any) => s.tasks))).toEqual([ "Draft the agenda", "Review the roadmap" ]);
        expect(words(plan.onDeck)).toEqual([ expect.stringContaining("Read the design doc") ]);
        expect(plan.suggested).toEqual([]);
        expect(await labelsOf(TODAY, "caiusFocus")).toEqual([]);
        expect(await labelsOf(TODAY, "caiusNotToday")).toEqual([]);
        expect(await labelsOf(REVIEWED, "caiusAsked")).not.toContain(carry.lineId);
        const monday = await call("caius_context", { date: TODAY });
        expect(monday.context.map((line: any) => line.text)).not.toContain("Ana is out Tuesday");
        const tuesday = await call("caius_context", { date: "2026-11-17" });
        expect(tuesday.context.map((line: any) => line.text)).toEqual([]);
    });

    it("Mon 09:00, Review of Thu 12: a carry the review skips is still asked by the Plan my day it goes on to", async () => {
        await cls.init(async () => {
            const reviewed = await store.calendarDay("2026-11-12");
            await store.putContent(reviewed.noteId, `<h2>☑️ Tasks</h2>${ul(li("cm-1", "Water the plants"))}`);
        });
        at(`${TODAY}T09:00`);
        const context = await call("caius_winddown", { date: "2026-11-12", step: "context" });
        const carry = context.data.noticed.find((line: any) => line.line === "Ana reviews the release notes");
        expect(carry).toMatchObject({ kind: "carry" });

        const review = await call("caius_winddown_apply", { date: "2026-11-12", done: [ "cm-1" ], carry: [ { lineId: carry.lineId } ] });
        expect(review.skipped).toEqual([ expect.objectContaining({ kind: "carry", id: carry.lineId, reason: "review_only" }) ]);
        expect(review.planday).toBeDefined();
        expect(review.planday.inputs.data.carry.map((line: any) => line.lineId)).toContain(carry.lineId);
    });
});
