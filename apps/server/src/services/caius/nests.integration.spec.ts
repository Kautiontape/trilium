/**
 * Plan my day's `nests`: asks under the meeting their asker is in, and a run of one project's tasks
 * under one item, offered by the inputs step and written by `caius_plan_apply`'s `nest`.
 */

import { dayCapacity } from "@triliumnext/caius";
import { becca, cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs } from "./inputs/types.js";
import { refOf } from "./refs.js";
import { type InputsInput, toolInputs } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const STANDUP_DAY = "2026-11-10";
const GARDEN_DAY = "2026-11-11";
const QUIET_DAY = "2026-11-12";
const PICK_DAY = "2026-11-13";

const jiraByDate: Record<string, JiraInputs> = {};
const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date, jira: jiraByDate[input.date] ?? { handoff: [], asks: [], done: [] }, calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: []
    };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

async function planday(date: string): Promise<any> {
    const def = [ ...tools ].find(([ name ]) => name === "caius_planday")?.[1];
    if (!def) throw new Error("caius_planday is not registered");
    vi.stubEnv("CAIUS_NOW", `${date}T08:00`);
    return cls.init(() => def.execute({ date, step: "inputs" })) as Promise<any>;
}

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

async function dayNote(date: string, html: string) {
    const note = await store.calendarDay(date);
    await store.putContent(note.noteId, html);
    return note.noteId;
}

const content = (noteId: string) => cls.init(() => store.content(noteId));

/** Every note's content, by noteId, to compare a re-run against. */
const snapshot = () => cls.init(() => Object.fromEntries(Object.values(becca.notes).map((note) => [ note.noteId, note.blobId ])));

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const garden = createChildNote("root", "Garden", "");
        await dayNote(STANDUP_DAY, `<h3>Work</h3>${ul(li("s1", "09:30 Standup"), li("s2", "Write the report ~20m"))}`);
        await dayNote(GARDEN_DAY, `<h3>Work</h3>${ul(...[ "Prune the roses", "Water the beds", "Plant the beans" ].map((text, i) => li(`g${i}`, `${text} <a href="#root/${garden}">from Garden</a>`)))}`);
        const pick = createChildNote("root", "Garden", "<p>Beds</p>");
        await store.addLabel(pick, "status", "active");
        await store.addLabel(pick, "priorityGroup", "Growth");
        await dayNote(PICK_DAY, `<h3>Work</h3>${ul(...[ "Prune the roses", "Water the beds", "Plant the beans" ].map((text, i) => li(`k${i}`, `🌱 Garden: ${text}`)))}`);
        await dayNote(QUIET_DAY, `<h3>Work</h3>${ul(li("q1", "Write the report ~20m"))}`);
    });
    calendars[STANDUP_DAY] = [ {
        start: "09:30", end: "09:45", title: "Standup", attendees: [ "ana.lopez@example.com", "Ben Ortiz" ], allDay: false, declined: false, source: [ 0 ]
    } ];
    jiraByDate[STANDUP_DAY] = {
        handoff: [],
        asks: [ {
            ticket: { key: "ABC-12", summary: "Summary ABC-12", status: "Dev Verify", resolution: null, url: "https://example.atlassian.net/browse/ABC-12", assignee: "Me", updated: "2026-11-09T10:00:00.000-0500" },
            author: "Ana Lopez", created: "2026-11-09T09:00:00.000-0500", commentId: "1", excerpt: "Can you look?"
        } ],
        done: []
    };
});

afterAll(() => {
    vi.unstubAllEnvs();
});

describe("caius_planday inputs: nests", () => {
    it("offers an ask under the meeting its asker is in, and says so", async () => {
        const answer = await planday(STANDUP_DAY);
        const ask = answer.data.candidates.find((candidate: any) => candidate.kind === "ask");
        expect(answer.data.nests).toEqual([ {
            ref: "n1",
            under: { listItemId: "s1", ref: expect.stringMatching(/^l[0-9a-f]{5}$/), text: "Standup" },
            items: [ { id: "ABC-12", ref: ask.ref, text: "Answer Ana Lopez's question on ABC-12" } ],
            because: "Put 1 answer under Standup? Ana is in it.",
            reason: { kind: "meeting", meeting: "Standup", askers: [ "Ana" ] }
        } ]);
        expect(answer.question).toContain("Put 1 answer under Standup? Ana is in it.");
    });

    it("offers three tasks from one project note under one item named for it", async () => {
        const answer = await planday(GARDEN_DAY);
        expect(answer.data.nests).toMatchObject([ {
            ref: "n1", under: { text: "Garden" }, items: [ { id: "g0" }, { id: "g1" }, { id: "g2" } ],
            because: "Put the 3 Garden tasks under one Garden item?", reason: { kind: "project", project: "Garden", count: 3 }
        } ]);
        expect(answer.question).toContain("Put the 3 Garden tasks under one Garden item?");
    });

    it("offers tasks written as an active project's picks under one item named for it, with no from link", async () => {
        const answer = await planday(PICK_DAY);
        expect(answer.data.nests).toMatchObject([ {
            ref: "n1", under: { text: "Garden" }, items: [ { id: "k0" }, { id: "k1" }, { id: "k2" } ],
            because: "Put the 3 Garden tasks under one Garden item?"
        } ]);
    });

    it("offers none on a day with neither", async () => {
        const answer = await planday(QUIET_DAY);
        expect(answer.data.nests).toEqual([]);
    });
});

describe("caius_plan_apply: nest", () => {
    const LIST_DAY = "2035-03-05";
    const ASK_DAY = "2035-04-04";
    const OBJECT_DAY = "2035-04-11";
    const OLD_DAY = "2035-06-07";
    const NEXT_DAY = "2035-06-08";
    const prose = { headline: "A day of fixes", sections: [] };
    const ids: Record<string, string> = {};
    let fixes: any;

    beforeAll(async () => {
        await cls.init(async () => {
            ids.list = await dayNote(LIST_DAY, `<h3>Work</h3>${ul(
                li("n1", "Fix the login bug"), li("n2", "Fix the export bug"), li("n3", "Write the report ~20m"), li("n4", "Plan the sprint")
            )}`);
            ids.ask = await dayNote(ASK_DAY, `<h3>Work</h3>${ul(li("w1", "09:30 Standup"), li("w2", "Write the report ~20m"))}`);
            ids.object = await dayNote(OBJECT_DAY, `<h3>Work</h3>${ul(li("u1", "09:30 Standup"), li("u2", "Write the report ~20m"))}`);
            ids.old = await dayNote(OLD_DAY, `<h3>Work</h3>${ul(li("v1", "Renew the passport"))}`);
            ids.next = await dayNote(NEXT_DAY, `<h3>Work</h3>${ul(li("x1", "Call the bank"))}`);
        });
        calendars[ASK_DAY] = [ {
            start: "09:30", end: "09:45", title: "Standup", attendees: [ "ana.lopez@example.com", "Ben Ortiz" ], allDay: false, declined: false, source: [ 0 ]
        } ];
        calendars[OBJECT_DAY] = calendars[ASK_DAY];
        jiraByDate[OBJECT_DAY] = {
            handoff: [],
            asks: [ {
                ticket: { key: "ABC-22", summary: "Summary ABC-22", status: "Dev Verify", resolution: null, url: "https://example.atlassian.net/browse/ABC-22", assignee: "Me", updated: "2035-04-10T10:00:00.000-0400" },
                author: "Ana Lopez", created: "2035-04-10T09:00:00.000-0400", commentId: "3", excerpt: "Can you look?"
            } ],
            done: []
        };
        jiraByDate[ASK_DAY] = {
            handoff: [],
            asks: [ {
                ticket: { key: "ABC-21", summary: "Summary ABC-21", status: "Dev Verify", resolution: null, url: "https://example.atlassian.net/browse/ABC-21", assignee: "Me", updated: "2035-04-03T10:00:00.000-0400" },
                author: "Ana Lopez", created: "2035-04-03T09:00:00.000-0400", commentId: "2", excerpt: "Can you look?"
            } ],
            done: []
        };
    });

    it("puts two tasks of his list under a new parent, in order, where the first stood", async () => {
        vi.stubEnv("CAIUS_NOW", `${LIST_DAY}T08:00`);
        fixes = { date: LIST_DAY, nest: [ { items: [ refOf("l", "n1"), refOf("l", "n2") ], under: { text: "09:30 Standup", est: "15m" } } ], brief: prose };
        const result = await call("caius_plan_apply", fixes);
        expect(result.error).toBeUndefined();
        const nested = result.written.filter((entry: any) => entry.kind === "nest");
        const parent = nested[0]?.parentListItemId;
        expect(nested).toEqual([
            expect.objectContaining({ id: "n1", status: "written", parentListItemId: expect.any(String) }),
            expect.objectContaining({ id: "n2", status: "written", parentListItemId: parent })
        ]);
        expect(await content(ids.list)).toMatch(new RegExp(`<li data-list-item-id="${parent}">(?:(?!</li>).)*09:30 Standup ~15m(?:(?!</li>).)*`
            + "<ul class=\"todo-list\"><li data-list-item-id=\"n1\">(?:(?!</li>).)*</li><li data-list-item-id=\"n2\">(?:(?!</li>).)*</li></ul></li>"
            + "<li data-list-item-id=\"n3\">"));
    });

    it("changes nothing when run again", async () => {
        vi.stubEnv("CAIUS_NOW", `${LIST_DAY}T08:00`);
        const before = await snapshot();
        const again = await call("caius_plan_apply", fixes);
        expect(again.skipped).toEqual([]);
        expect(again.written.filter((entry: any) => entry.kind === "nest").map((entry: any) => [ entry.id, entry.status ])).toEqual([ [ "n1", "unchanged" ], [ "n2", "unchanged" ] ]);
        expect(again.written.filter((entry: any) => entry.status !== "unchanged")).toEqual([]);
        expect(await snapshot()).toEqual(before);
    });

    it("takes a call with only nest and no brief, and draws the header again", async () => {
        vi.stubEnv("CAIUS_NOW", `${LIST_DAY}T11:00`);
        const result = await call("caius_plan_apply", { date: LIST_DAY, said: "put the report under the sprint", nest: [ { items: [ refOf("l", "n3"), "the budget" ], under: refOf("l", "n4") } ] });
        expect(result.error).toBeUndefined();
        expect(result.skipped).toEqual([ expect.objectContaining({ kind: "nest", id: "the budget", reason: "not_on_list" }) ]);
        expect(result.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "nest", id: "n3", status: "written", parentListItemId: "n4" }),
            expect.objectContaining({ kind: "picks", status: "written" }),
            expect.objectContaining({ kind: "header", status: "written" })
        ]));
        expect(result.say).toContain("Write the report went under Plan the sprint");
    });

    it("takes an ask it names that the call doesn't accept, and puts it under the standup task", async () => {
        const offered = await planday(ASK_DAY);
        const [ offer ] = offered.data.nests;
        expect(offer).toMatchObject({ under: { listItemId: "w1" }, items: [ { id: "ABC-21" } ] });
        const answer = { date: ASK_DAY, said: "yes", nest: [ { items: offer.items.map((item: any) => item.ref), under: offer.under.ref } ], brief: prose };
        const result = await call("caius_plan_apply", answer);
        expect(result.skipped).toEqual([]);
        expect(result.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "accept", id: "ABC-21", status: "written" }),
            expect.objectContaining({ kind: "nest", status: "written", parentListItemId: "w1", text: expect.stringContaining("ABC-21") })
        ]));
        expect(result.written.filter((entry: any) => entry.kind === "suggested")).toEqual([]);
        expect(await content(ids.ask)).toMatch(/<li data-list-item-id="w1">(?:(?!<\/li>).)*<ul class="todo-list"><li [^>]*>(?:(?!<\/li>).)*ABC-21/);
        expect((await call("caius_plan", { period: "day", date: ASK_DAY })).suggested).toEqual([]);

        // Again: the ask is found under the standup by its key, not taken a second time.
        const before = await snapshot();
        const again = await call("caius_plan_apply", answer);
        expect(again.skipped).toEqual([]);
        expect(again.written.filter((entry: any) => entry.status !== "unchanged")).toEqual([]);
        expect(again.written.filter((entry: any) => entry.kind === "nest")).toEqual([ expect.objectContaining({ status: "unchanged", parentListItemId: "w1" }) ]);
        expect(await snapshot()).toEqual(before);
    });

    it("takes the offer's under object as the task it names, and makes no second parent", async () => {
        const offered = await planday(OBJECT_DAY);
        const [ offer ] = offered.data.nests;
        expect(offer.under).toEqual({ listItemId: "u1", ref: expect.any(String), text: "Standup" });
        const schema = toolInputs.planApply;
        const asked = (under: unknown, items: string[]) => ({ date: OBJECT_DAY, said: "yes", nest: [ { items, under } ], brief: prose });

        const parsed = schema.parse(asked(offer.under, offer.items.map((item: any) => item.ref)));
        expect(parsed.nest[0]?.under).toBe("u1");
        const result = await call("caius_plan_apply", parsed);
        expect(result.skipped).toEqual([]);
        expect(result.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "nest", status: "written", parentListItemId: "u1" }) ]));
        expect(await content(ids.object)).toMatch(/<li data-list-item-id="u1">(?:(?!<\/li>).)*<ul class="todo-list"><li [^>]*>(?:(?!<\/li>).)*ABC-22/);
        expect(result.written.filter((entry: any) => entry.kind === "nest").map((entry: any) => entry.parentListItemId)).toEqual([ "u1" ]);

        expect(schema.parse(asked({ ref: offer.under.ref }, [ "u2" ])).nest[0]?.under).toBe(offer.under.ref);
        const refused = schema.safeParse(asked({ text: "Group", note: "x" }, [ "u2" ]));
        expect(refused.success).toBe(false);
        expect(schema.safeParse(asked({ text: "Group", est: "15m" }, [ "u2" ])).success).toBe(true);
    });

    it("skips a task of another day's note as other_note and forwards nothing, until the catch-up moves it here", async () => {
        vi.stubEnv("CAIUS_NOW", `${NEXT_DAY}T08:00`);
        const catchup = await call("caius_planday", { date: NEXT_DAY, step: "catchup" });
        const passport = catchup.data.tasks.find((task: any) => task.listItemId === "v1");
        const answer = { date: NEXT_DAY, nest: [ { items: [ passport.ref ], under: refOf("l", "x1") } ], brief: prose };
        const before = await snapshot();
        const result = await call("caius_plan_apply", answer);
        expect(result.skipped).toEqual([ expect.objectContaining({ kind: "nest", id: "v1", reason: "other_note", detail: expect.stringContaining(OLD_DAY) }) ]);
        expect(result.written.filter((entry: any) => [ "nest", "catchup", "forward" ].includes(entry.kind))).toEqual([]);
        expect((await snapshot())[ids.old]).toBe(before[ids.old]);
        expect(await content(ids.next)).not.toContain("Renew the passport");

        const moved = await call("caius_plan_apply", { ...answer, catchup: "move_all" });
        expect(moved.skipped).toEqual([]);
        expect(moved.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "catchup", id: "v1", status: "written" }),
            expect.objectContaining({ kind: "nest", status: "written", parentListItemId: "x1", text: expect.stringContaining("Renew the passport") })
        ]));
        expect(await content(ids.next)).toMatch(/<li data-list-item-id="x1">(?:(?!<\/li>).)*<ul class="todo-list"><li [^>]*>(?:(?!<\/li>).)*Renew the passport/);
    });
});
