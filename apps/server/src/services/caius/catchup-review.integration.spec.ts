/**
 * A review: the wind-down of an older day run from a later one, as the catch-up's Review or a
 * Monday-morning Wind down of Friday. "Later this week" and "next week" count from the day the
 * review works against, not from the week the reviewed day is in.
 * It writes only the reviewed day: what it would offer or write for the target day is left to Plan my day.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { lineIdOf } from "./daily.js";
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
const FRIDAY = "2026-11-13";
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

/** The content of the day note of `date`, to compare a re-run against. */
async function contentOf(date: string) {
    const [ note ] = await cls.init(() => store.search(`#dateNote="${date}"`));
    return note ? cls.init(() => store.content(note.noteId)) : null;
}

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
            await store.putContent(target.noteId, `<h2>☑️ Tasks</h2>${ul(li("cr-list", "Review the roadmap ~30m"))}<h2>On deck</h2>${ul(li("cr-deck", "Call the printer ~15m"))}`);
        });
        at(`${TODAY}T19:00`);
        const open = await call("caius_winddown", { date: REVIEWED, step: "open" });
        expect(open.data.items.map((item: any) => item.listItemId)).toEqual([ "cr-done", "cr-fwd", "cr-drop", "cr-area" ]);
        // The review's next and context steps show nothing of Monday, so the call names Monday's items and the carry line by id.
        const carry = { lineId: lineIdOf("Ben covers the on-call rotation") };

        // Each open item is named by the ref its step gave it, as the agent names it.
        const [ done, forward, drop, area ] = open.data.items.map((item: any) => item.ref);
        const answers = {
            date: REVIEWED,
            done: [ done ],
            fates: [ { listItemId: forward, to: TODAY }, { listItemId: drop, drop: "not needed" } ],
            areas: [ { item: area, area: "growth" }, { item: "cr-list", area: "recharge" }, { item: "cr-deck", area: "recharge" } ],
            accept: [ { candidateId: "ABC-21" } ],
            notToday: [ { candidateId: "ABC-23" } ],
            carry: [ carry ],
            context: [ "Ana is out Tuesday" ],
            move: [ { listItemId: forward, first: true }, { listItemId: "cr-list", after: area } ]
        };
        const applied = await call("caius_winddown_apply", answers);
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
            { kind: "area", id: "cr-deck", text: expect.stringContaining("Call the printer"), ...later },
            { kind: "accept", id: "ABC-21", text: expect.stringContaining("ABC-21"), ...later },
            { kind: "not_today", id: "ABC-23", text: expect.stringContaining("ABC-23"), ...later },
            { kind: "move", id: "cr-list", text: expect.stringContaining("Review the roadmap"), ...later },
            { kind: "carry", id: carry.lineId, text: "Ben covers the on-call rotation", ...later },
            { kind: "context", text: "Ana is out Tuesday", ...later }
        ]);
        const left = "Review the roadmap, Call the printer, ABC-21, ABC-23, Ben covers the on-call rotation and Ana is out Tuesday are left for Plan my day";
        expect(applied.say).toContain(left);

        // The target day keeps his list as it was, with the forward placed first, and nothing else of the review's.
        // The skipped move's anchor stays on the On deck its proposed fate gives it.
        const plan = await call("caius_plan", { period: "day", date: TODAY });
        const words = (tasks: any[]) => tasks.map((task: any) => task.text.split(" [")[0]);
        expect(words(plan.sections.flatMap((s: any) => s.tasks))).toEqual([ "Draft the agenda", "Review the roadmap" ]);
        expect(words(plan.onDeck)).toEqual([ "Call the printer", expect.stringContaining("Read the design doc") ]);
        expect(plan.suggested).toEqual([]);
        expect(await labelsOf(TODAY, "caiusFocus")).toEqual([]);
        expect(await labelsOf(TODAY, "caiusNotToday")).toEqual([]);
        expect(await labelsOf(TODAY, "caiusAsked")).not.toContain("area:cr-deck");
        expect(await labelsOf(REVIEWED, "caiusAsked")).not.toContain(carry.lineId);
        const monday = await call("caius_context", { date: TODAY });
        expect(monday.context.map((line: any) => line.text)).not.toContain("Ana is out Tuesday");
        const tuesday = await call("caius_context", { date: "2026-11-17" });
        expect(tuesday.context.map((line: any) => line.text)).toEqual([]);

        // The same call again finds the forward's move in place and changes nothing on the target day.
        const before = await contentOf(TODAY);
        const again = await call("caius_winddown_apply", answers);
        expect(again.skipped.filter((entry: any) => entry.kind === "move")).toEqual([ expect.objectContaining({ id: "cr-list", reason: "review_only" }) ]);
        expect(again.written).toContainEqual(expect.objectContaining({ kind: "move", detail: "first", status: "unchanged" }));
        expect(again.say).toContain(left);
        expect(await contentOf(TODAY)).toBe(before);
        expect(await labelsOf(TODAY, "caiusFocus")).toEqual([]);
        expect(await labelsOf(TODAY, "caiusNotToday")).toEqual([]);
    });

    it("Mon 09:00, Review of Thu 12: a carry the review skips is still asked by the Plan my day it goes on to", async () => {
        await cls.init(async () => {
            const reviewed = await store.calendarDay("2026-11-12");
            await store.putContent(reviewed.noteId, `<h2>☑️ Tasks</h2>${ul(li("cm-1", "Water the plants"))}`);
        });
        at(`${TODAY}T09:00`);
        const carry = { lineId: lineIdOf("Ana reviews the release notes") };

        const review = await call("caius_winddown_apply", { date: "2026-11-12", done: [ "cm-1" ], carry: [ { lineId: carry.lineId } ] });
        expect(review.skipped).toEqual([ expect.objectContaining({ kind: "carry", id: carry.lineId, reason: "review_only" }) ]);
        expect(review.planday).toBeDefined();
        expect(review.planday.inputs.data.carry.map((line: any) => line.lineId)).toContain(carry.lineId);
    });
});

/** The week a step's `data.days` names by `ref` (`w1` "later this week", `w2` "next week"). */
const weekOf = (step: any, ref: string) => step.data.days.find((day: any) => day.ref === ref)?.week;

describe("a wind-down of a day before today is a review", () => {
    beforeAll(async () => {
        await cls.init(async () => {
            const friday = await store.calendarDay(FRIDAY);
            await store.putContent(friday.noteId, `<h2>☑️ Tasks</h2>${ul(li("fr-week", "Plan the offsite ~30m"), li("fr-done", "File the expenses ~15m"))}`);
        });
    });

    it("Fri 23:00 and Sat 02:00, before the rollover: the wind-down of Friday is no review, and 'later this week' is Friday's week", async () => {
        for (const stamp of [ `${FRIDAY}T23:00`, "2026-11-14T02:00" ]) {
            at(stamp);
            const open = await call("caius_winddown", { date: FRIDAY, step: "open" });
            expect(open.targetDay, stamp).toBe(TODAY);
            expect(weekOf(open, "w1"), stamp).toBe("2026-W46");
        }
    });

    it("Mon 08:00, Review of Fri 13: 'later this week' is the target day's week, and the answers about Monday are left for Plan my day", async () => {
        at(`${TODAY}T08:00`);
        const open = await call("caius_winddown", { date: FRIDAY, step: "open" });
        expect(open.targetDay).toBe(TODAY);
        expect(weekOf(open, "w1")).toBe("2026-W47");
        const ref = (id: string) => open.data.items.find((item: any) => item.listItemId === id)?.ref;

        const applied = await call("caius_winddown_apply", {
            date: FRIDAY, done: [ ref("fr-done") ], fates: [ { listItemId: ref("fr-week"), to: "w1" } ],
            accept: [ { candidateId: "ABC-21" } ], notToday: [ { candidateId: "ABC-23" } ]
        });
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "done", id: "fr-done", status: "written" }),
            expect.objectContaining({ kind: "fate", id: "fr-week", detail: "2026-W47", status: "written" })
        ]));
        const later = { reason: "review_only", detail: expect.stringContaining("Plan my day") };
        expect(applied.skipped).toEqual([
            { kind: "accept", id: "ABC-21", text: expect.stringContaining("ABC-21"), ...later },
            { kind: "not_today", id: "ABC-23", text: expect.stringContaining("ABC-23"), ...later }
        ]);
        expect(applied.say).toContain("ABC-21 and ABC-23 are left for Plan my day");
        expect(await labelsOf(TODAY, "caiusNotToday")).toEqual([]);
        const plan = await call("caius_plan", { period: "day", date: TODAY });
        expect(plan.sections.flatMap((s: any) => s.tasks).map((task: any) => task.text).join("\n")).not.toContain("ABC-21");
    });
});

describe("a review asks nothing Plan my day asks", () => {
    const WEDNESDAY = "2026-11-11";
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

    it("Mon 08:00, Review of Fri 13: the open step is the last, and the next and context steps ask nothing", async () => {
        calendars[TODAY] = [ event("11:00", "12:00", "Design sync"), event("11:30", "12:30", "Vendor call") ];
        at(`${TODAY}T08:00`);
        const open = await call("caius_winddown", { date: FRIDAY, step: "open" });
        expect(open.next).toBeNull();
        for (const step of [ "next", "context" ]) {
            const answer = await call("caius_winddown", { date: FRIDAY, step, refresh: true });
            expect(answer, step).toMatchObject({ question: null, next: null });
            expect(answer.data, step).toEqual({ summary: "Plan my day sets up Monday." });
        }
        delete calendars[TODAY];
    });

    it("Mon 19:00, Review of Wed 11: a dismissal in his words or a bare yes is no check, and the answers about Monday are left for Plan my day", async () => {
        await cls.init(async () => {
            const wednesday = await store.calendarDay(WEDNESDAY);
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("wd-done", "Sort the receipts ~15m"))}`);
        });
        at(`${TODAY}T19:00`);
        const dismissed = await call("caius_winddown_apply", { date: WEDNESDAY, said: "dismiss ABC-22", done: [ "wd-done" ], notToday: [ { candidateId: "ABC-23" } ] });
        expect(dismissed.check).toBeUndefined();
        expect(dismissed.written).toContainEqual(expect.objectContaining({ kind: "done", id: "wd-done", status: "written" }));
        expect(dismissed.skipped).toEqual([ expect.objectContaining({ kind: "not_today", id: "ABC-23", reason: "review_only" }) ]);

        await cls.init(async () => {
            const wednesday = await store.calendarDay(WEDNESDAY);
            const before = await store.content(wednesday.noteId);
            await store.putContent(wednesday.noteId, before.replace("</ul>", `${li("wd-left", "Return the cables ~15m")}</ul>`));
        });
        const yes = await call("caius_winddown_apply", { date: WEDNESDAY, said: "yes" });
        expect(yes.check).toBeUndefined();
        expect(yes.written).toContainEqual(expect.objectContaining({ kind: "fate", id: "wd-left", detail: TODAY, status: "written" }));
    });

    it("Mon 19:00, Review of Wed 11: a keep line and a dismissal passed anyway are left for Plan my day", async () => {
        await cls.init(async () => {
            const wednesday = await store.calendarDay(WEDNESDAY);
            const before = await store.content(wednesday.noteId);
            await store.putContent(wednesday.noteId, `<h3>Context</h3>${bullets("ABC-30 is open (until Thu 12 Nov)")}${before}`);
        });
        at(`${TODAY}T19:00`);
        const keep = lineIdOf("ABC-30 is open");
        const applied = await call("caius_winddown_apply", { date: WEDNESDAY, keep: [ { lineId: keep } ], dismiss: [ { candidateId: "ABC-22" } ] });
        const later = { reason: "review_only", detail: expect.stringContaining("Plan my day") };
        expect(applied.skipped).toEqual([
            { kind: "dismiss", id: "ABC-22", text: expect.stringContaining("ABC-22"), ...later },
            { kind: "keep", id: keep, text: "ABC-30 is open", ...later }
        ]);
        expect(await labelsOf(TODAY, "caiusDismissed")).toEqual([]);
        const week = await call("caius_context", { date: TODAY });
        expect(week.context.map((line: any) => line.text)).not.toContain("ABC-30 is open");
    });
});
