import { dayCapacity, type NoteStore } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { overriddenKeys } from "./inputs/jira.js";
import type { CaiusInputs, CalendarEvent, JiraInputs, JiraTicket } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string, o: { checked?: boolean; sub?: string } = {}) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${o.checked ? " checked=\"checked\"" : ""} disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label>${o.sub ?? ""}</li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const bullets = (...items: string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const THURSDAY = "2026-11-05";
const FRIDAY = "2026-11-06";
const MONDAY = "2026-11-09";
const TUESDAY = "2026-11-10";
const WEDNESDAY = "2026-11-11";

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li><li>Bedtime: 23:00.</li></ul>"
    + "<h2>Brief rules</h2><ul><li>Open time is work time.</li><li>Name concrete tickets.</li></ul>";

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Dev Verify", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-11-04T10:00:00.000-0500", ...o
});
const event = (start: string, end: string, title: string, o: Partial<CalendarEvent> = {}): CalendarEvent => ({
    start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ], ...o
});

/** What the stubbed `caius_inputs` answers, by date. Context lines that say a ticket is open override `done`, as the real one does. */
const jiraByDate: Record<string, JiraInputs> = {};
const calendars: Record<string, CalendarEvent[]> = {};
const inputsCalls: InputsInput[] = [];

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    inputsCalls.push(input);
    const jira = jiraByDate[input.date] ?? { handoff: [], asks: [], done: [] };
    const overridden = overriddenKeys(input.context ?? []);
    const mark = <T extends JiraTicket>(t: T): T => overridden.has(t.key) ? { ...t, overridden: true } : t;
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date,
        jira: {
            handoff: jira.handoff.map(mark),
            asks: jira.asks.map((ask) => ({ ...ask, ticket: mark(ask.ticket) })),
            // As the real reader does: only tickets it read as hand-offs or asks can be done.
            done: jira.done.filter((key) => !overridden.has(key)
                && [ ...jira.handoff, ...jira.asks.map((ask) => ask.ticket) ].some((t) => t.key === key))
        },
        calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }),
        errors: []
    };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function callWith(registry: typeof tools, name: string, args: object): Promise<any> {
    const def = [ ...registry ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}
const call = (name: string, args: object) => callWith(tools, name, args);

const notes: Record<string, string> = {};

async function dayNote(date: string, html: string): Promise<string> {
    const note = await store.calendarDay(date);
    await store.putContent(note.noteId, html);
    return note.noteId;
}

beforeAll(async () => {
    await sql_init.dbReady;
    vi.stubEnv("CAIUS_NOW", `${FRIDAY}T17:30`);

    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(FRIDAY), (await store.search("#calendarRoot"))[0]);
        await store.addLabel(calendarRoot!.noteId, "enableWeekNote", "");

        notes.thursday = await dayNote(THURSDAY, `<h3>Work</h3>${ul(li("o1", "Slipped thing ~1h"), li("o2", "Fix <a href=\"https://example.atlassian.net/browse/ZAP-104\">ZAP-104</a>"))}`);
        notes.friday = await dayNote(FRIDAY, `<h3>Context</h3>${bullets("ZAP-2590 is open (until Fri 6 Nov)")}<h3>Work</h3>${ul(
            li("f1", "Friday leftover ~30m"),
            li("f2", "Finished thing", { checked: true }),
            li("f3", "Parent task", { sub: ul(li("f4", "Sub step")) })
        )}`);
        const week = await store.calendarWeek("2026-W45");
        await store.putContent(week.noteId, `<h3>Work</h3>${ul(li("w1", "Week item ~45m"))}`);
        notes.week = week.noteId;
        notes.monday = await dayNote(MONDAY, `<h3>Work</h3>${ul(li("m1", "Monday thing ~1h"))}<h3>Suggested</h3>${ul(li("ms1", "Get ZAP-105 Summary ZAP-105 done"))}`);
        await store.addLabel(notes.monday, "caiusDismissed", "ZAP-103");
        const nextWeek = await store.calendarWeek("2026-W46");
        await store.putContent(nextWeek.noteId, `<h3>Context</h3>${bullets("ZAP-2600 is open")}<h3>Work</h3>${ul(li("nw1", "Next week item ~45m"))}`);
        notes.tuesday = await dayNote(TUESDAY, `<h3>Work</h3>${ul(li("t1", "Huge thing ~4h"))}<h3>Evening</h3>${ul(li("t2", "Walk ~45m"))}`);
        notes.wednesday = await dayNote(WEDNESDAY, `<h3>Work</h3>${ul(li("we1", "Small thing ~30m"))}<h3>Evening</h3>${ul(li("we2", "Read ~30m"))}`);

        const standing = createChildNote("root", "🧭 How I work", STANDING);
        await store.addLabel(standing, "assistantContext", "");
    });

    jiraByDate[MONDAY] = {
        handoff: [ { ...ticket("ZAP-101"), daysInStatus: 3 }, { ...ticket("ZAP-103"), daysInStatus: 9 }, { ...ticket("ZAP-104"), daysInStatus: 2 }, { ...ticket("ZAP-105"), daysInStatus: 2 } ],
        asks: [
            { ticket: ticket("ZAP-102"), author: "Sam Example", created: "2026-11-04T09:00:00.000-0500", excerpt: "Can you look?" },
            { ticket: ticket("ZAP-2600"), author: "Riley Sample", created: "2026-11-05T09:00:00.000-0500", excerpt: "Still open?" }
        ],
        done: [ "ZAP-2590", "ZAP-2600" ]
    };
    calendars[MONDAY] = [
        event("10:00", "10:15", "Standup"),
        event("12:00", "13:00", "Release call", { overlap: true }),
        event("12:30", "13:00", "Review", { overlap: true })
    ];
    calendars[TUESDAY] = [ event("10:00", "12:00", "Workshop") ];
});

afterAll(() => {
    vi.unstubAllEnvs();
});

describe("caius_winddown", () => {
    it("open: lists today's leftovers, what slipped and the week's items for Friday, with fates on Monday and in next week's note", async () => {
        const answer = await call("caius_winddown", { date: FRIDAY, step: "open" });
        expect(answer).toMatchObject({ step: "open", date: FRIDAY, targetDay: MONDAY, next: "next" });
        expect(answer.question).toBe("These are still open: today's leftovers and what's slipped. Which are actually done? Everything else goes to Monday unless you say otherwise.");
        const items = answer.data.items.map((item: any) => [ item.group, item.listItemId, item.fate ]);
        expect(items).toEqual(expect.arrayContaining([
            [ "today", "f1", { forward: MONDAY } ],
            [ "today", "f3", { forward: MONDAY } ],
            [ "overdue", "o1", { forward: MONDAY } ],
            [ "week", "w1", { forward: "2026-W46" } ]
        ]));
        // The sub-item goes with its parent, and done tasks are left out.
        expect(answer.data.items.map((item: any) => item.listItemId)).not.toContain("f4");
        expect(answer.data.items.map((item: any) => item.listItemId)).not.toContain("f2");
        expect(answer.standing).toContain("Open time is work time.");
    });

    it("open: keeps the week's items in the week when the next workday is in the same week", async () => {
        const answer = await call("caius_winddown", { date: MONDAY, step: "open" });
        expect(answer.data.items.find((item: any) => item.listItemId === "nw1")).toMatchObject({ group: "week", fate: { stay: "2026-W46" } });
    });

    it("next: offers candidates for Monday, leaving out done, live, suggested and dismissed ones, and asks about the overlap and the empty evening", async () => {
        const answer = await call("caius_winddown", { date: FRIDAY, step: "next" });
        expect(answer).toMatchObject({ step: "next", targetDay: MONDAY, next: "context" });
        const candidates = answer.data.candidates.map((c: any) => [ c.text, c.because, c.minutes, c.source ]);
        expect(candidates).toEqual([
            [ "Get ZAP-101 Summary ZAP-101 done", "sitting in Dev Verify for 3 days", 30, "ZAP-101" ],
            [ "Get ZAP-102 Summary ZAP-102 done", "Sam Example asked on Wednesday", 30, "ZAP-102" ],
            [ "Get ZAP-2600 Summary ZAP-2600 done", "Riley Sample asked on Thursday", 30, "ZAP-2600" ],
            [ "Next week item", "on the week's list", 45, "2026-W46" ]
        ]);
        // A Context override keeps a ticket Jira calls Done on offer.
        expect(answer.data.candidates[2]).toMatchObject({ overridden: true });
        expect(answer.data.capacity).toMatchObject({ plannedMinutes: 60, candidateMinutes: 135 });
        expect(answer.data.overlaps).toEqual([ { first: "Release call", second: "Review", at: "12:30" } ]);
        expect(answer.data.evening).toEqual({ hasTask: false });
        expect(answer.question).toBe("Release call overlaps Review at 12:30. Which one do you take? Anything for the evening?");
    });

    it("next: reuses the inputs for 15 minutes unless told to refresh", async () => {
        const before = inputsCalls.filter((c) => c.date === MONDAY).length;
        await call("caius_winddown", { date: FRIDAY, step: "next" });
        expect(inputsCalls.filter((c) => c.date === MONDAY).length).toBe(before);
        await call("caius_winddown", { date: FRIDAY, step: "next", refresh: true });
        expect(inputsCalls.filter((c) => c.date === MONDAY).length).toBe(before + 1);
        expect(inputsCalls.at(-1)).toMatchObject({ date: MONDAY, workStart: "10:00", workEnd: "18:00", context: expect.arrayContaining([ "ZAP-2600 is open" ]) });
    });

    it("next: asks which tasks can wait on an over-capacity day", async () => {
        const answer = await call("caius_winddown", { date: MONDAY, step: "next" });
        expect(answer.targetDay).toBe(TUESDAY);
        expect(answer.data.capacity).toMatchObject({ plannedMinutes: 240, eveningMinutes: 45, candidateMinutes: 45, targetMinutes: 234 });
        expect(answer.data.evening).toEqual({ hasTask: true });
        expect(answer.question).toBe("Tuesday is over by about 1 h. Which of these can wait?");
    });

    it("next: says the day fits when nothing needs asking", async () => {
        const answer = await call("caius_winddown", { date: TUESDAY, step: "next" });
        expect(answer.question).toBeNull();
        expect(answer.data.summary).toBe("Wednesday holds 1 h 15 m of work against 4 h open. Fits.");
    });

    it("next: leaves the evening's tasks out of the work it weighs against the target", async () => {
        await cls.init(() => dayNote("2026-11-12", `<h3>Work</h3>${ul(li("th1", "Spec ~1h30m"), li("th2", "Review ~1h"), li("th3", "Fix ~30m"))}<h3>Evening</h3>${ul(li("th4", "Walk ~45m"))}`));
        const answer = await call("caius_winddown", { date: WEDNESDAY, step: "next" });
        expect(answer.data.capacity).toMatchObject({ plannedMinutes: 180, eveningMinutes: 45, candidateMinutes: 45, targetMinutes: 240 });
        expect(answer.question).toBeNull();
        expect(answer.data.summary).toBe("Thursday holds 3 h 45 m of work against 4 h open. Fits.");
    });

    it("context: notices an override that lapses before Monday and asks to keep it", async () => {
        const answer = await call("caius_winddown", { date: FRIDAY, step: "context" });
        expect(answer).toMatchObject({ step: "context", targetDay: MONDAY, next: null });
        expect(answer.data.noticed).toEqual([ { line: "ZAP-2590 is open", until: FRIDAY, keys: [ "ZAP-2590" ], question: "Keep 'ZAP-2590 is open'?" } ]);
        expect(answer.data.context.map((line: any) => line.text)).toContain("ZAP-2600 is open");
        expect(answer.question).toBe("Keep 'ZAP-2590 is open'? Anything to know for Monday?");

        const quiet = await call("caius_winddown", { date: TUESDAY, step: "context" });
        expect(quiet.question).toBeNull();
        expect(quiet.data.noticed).toEqual([]);
    });

    it("next: a candidate put in Suggested and then dismissed does not come back", async () => {
        const sources = async () => (await call("caius_winddown", { date: FRIDAY, step: "next" })).data.candidates.map((c: any) => c.source);
        expect(await sources()).toContain("ZAP-101");

        const added = await call("caius_add", { items: [ { date: MONDAY, suggested: true, text: "Get ZAP-101 Summary ZAP-101 done", source: "ZAP-101", est: "30m" } ] });
        expect(added.results[0]).toMatchObject({ status: "added" });
        expect(await sources()).not.toContain("ZAP-101");

        const dismissed = await call("caius_dismiss", { items: [ { noteId: notes.monday, listItemId: added.results[0].listItemId } ] });
        expect(dismissed.results[0]).toMatchObject({ status: "dismissed", key: "ZAP-101" });
        expect(await sources()).not.toContain("ZAP-101");
    });

    it("says in one line that the standing note is missing", async () => {
        const blind: NoteStore = { ...store, search: (query, ancestor) => query.includes("assistantContext") ? Promise.resolve([]) : store.search(query, ancestor) };
        const answer = await callWith(createCaiusTools(blind, async () => undefined, stubInputs), "caius_winddown", { date: FRIDAY, step: "open" });
        expect(answer.standing).toBeNull();
        expect(answer.standingMissing).toBe("No note is labelled #assistantContext, so the rhythm and the brief rules are the defaults.");
    });
});

describe("caius_planday", () => {
    it("catchup: offers to move a missed night's open tasks, and stops asking once skipped", async () => {
        const answer = await call("caius_planday", { date: MONDAY, step: "catchup" });
        expect(answer).toMatchObject({ step: "catchup", date: MONDAY, next: "inputs" });
        expect(answer.question).toBe("Friday has 2 open tasks. Move all to today, review them, or skip?");
        expect(answer.data).toMatchObject({ lastWorkday: FRIDAY, moveTo: MONDAY, skipped: false });
        expect(answer.data.tasks.map((task: any) => task.listItemId)).toEqual([ "f1", "f3" ]);

        expect(await call("caius_skip_catchup", { date: MONDAY })).toMatchObject({ status: "updated" });
        const skipped = await call("caius_planday", { date: MONDAY, step: "catchup" });
        expect(skipped.question).toBeNull();
        expect(skipped.data).toMatchObject({ skipped: true, tasks: [] });
    });

    it("catchup: has nothing to ask when the last workday is closed", async () => {
        const answer = await call("caius_planday", { date: FRIDAY, step: "catchup" });
        expect(answer.data).toMatchObject({ lastWorkday: THURSDAY, skipped: false });
        expect(answer.data.tasks.map((task: any) => task.listItemId)).toEqual([ "o1", "o2" ]);

        const closed = await call("caius_planday", { date: THURSDAY, step: "catchup" });
        expect(closed.question).toBeNull();
        expect(closed.data.tasks).toEqual([]);
    });

    it("inputs: gives the candidates, the Meetings block to write and the overlap question", async () => {
        const answer = await call("caius_planday", { date: MONDAY, step: "inputs" });
        expect(answer).toMatchObject({ step: "inputs", next: "brief" });
        expect(answer.data.candidates.map((c: any) => c.source)).toEqual([ "ZAP-102", "ZAP-2600", "2026-W46" ]);
        expect(answer.data.meetings).toEqual({
            lines: [ "10:00 Standup", "12:00 Release call (overlaps)", "12:30 Review (overlaps)" ], current: [], changed: true
        });
        expect(answer.data.forwardSuggestion).toBeNull();
        expect(answer.question).toBe("Release call overlaps Review at 12:30. Which one do you take?");
    });

    it("inputs: on a day over 60% booked, offers to move the last task of the list to the next workday", async () => {
        calendars[WEDNESDAY] = [ event("10:00", "15:30", "Offsite") ];
        const answer = await call("caius_planday", { date: WEDNESDAY, step: "inputs", refresh: true });
        expect(answer.data.forwardSuggestion).toMatchObject({ noteId: notes.wednesday, listItemId: "we2", text: "Read", to: "2026-11-12" });
        expect(answer.question).toBe("The day is 69% booked. Move 'Read' to Thursday?");
    });

    it("brief: lays the main list out between the meetings, from the standing note's rhythm, with its brief rules and the input caius_brief_write takes", async () => {
        const answer = await call("caius_planday", { date: MONDAY, step: "brief" });
        expect(answer).toMatchObject({ step: "brief", question: null, next: null });
        expect(answer.data.day).toEqual({ start: "10:00", end: "23:00", workEnd: "18:00", from: { start: "rhythm", end: "rhythm", workEnd: "default" } });
        expect(answer.data.header).toEqual({
            start: "10:00", end: "23:00", workEnd: "18:00",
            events: [
                { start: "10:00", end: "10:15", title: "Standup" },
                { start: "12:00", end: "13:00", title: "Release call", overlap: true },
                { start: "12:30", end: "13:00", title: "Review", overlap: true }
            ],
            work: [ { start: "10:15", end: "11:15", label: "Monday thing", focus: true } ]
        });
        expect(answer.data.briefRules).toContain("Open time is work time.");
        expect(answer.data.briefRules).not.toContain("Rhythm");
        expect(answer.data.shape).toMatchObject({ date: MONDAY, header: answer.data.header, acts: [ expect.any(Object), expect.any(Object), expect.any(Object) ] });
        const schema = [ ...tools ].find(([ n ]) => n === "caius_brief_write")?.[1].inputSchema;
        expect(schema?.safeParse({ ...answer.data.shape, headline: "Ship it" }).success).toBe(true);
    });

    it("inputs: after a brief, offers only what is new since it was planned", async () => {
        const shape = (await call("caius_planday", { date: MONDAY, step: "brief" })).data.shape;
        expect((await call("caius_brief_write", { ...shape, headline: "Monday" })).plannedAt).toBe(`${FRIDAY}T17:30:00`);

        jiraByDate[MONDAY]?.asks.push({ ticket: ticket("ZAP-106"), author: "Sam Example", created: "2026-11-08T12:00:00Z", excerpt: "One more?" });
        const answer = await call("caius_planday", { date: MONDAY, step: "inputs", refresh: true });
        expect(answer.data.plannedAt).toBe(`${FRIDAY}T17:30:00`);
        expect(answer.data.candidates.map((c: any) => c.source)).toEqual([ "ZAP-106" ]);
    });
});
