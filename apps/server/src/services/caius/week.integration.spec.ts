/**
 * The week of the first normal-user simulation (T13A, Mon 2 to Mon 9 Nov 2026), replayed through
 * the tools: each test follows one of the sequences that went wrong there.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs, JiraTicket } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string, o: { checked?: boolean } = {}) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${o.checked ? " checked=\"checked\"" : ""} disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const jiraLink = (key: string) => `<a href="https://example.atlassian.net/browse/${key}">${key}</a>`;

const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const MON9 = "2026-11-09";

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Dev Verify", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-10-27T10:00:00.000-0400", ...o
});

/** Jira as the simulation served it all week: every ticket still open, whatever Shawn did. */
const jira: JiraInputs = {
    handoff: [ "ZAP-101", "ZAP-105", "ZAP-110", "ZAP-111", "ZAP-112" ].map((key) => ({ ...ticket(key), daysInStatus: 6 })),
    asks: [],
    done: []
};
const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date, jira, calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }),
        errors: []
    };
}

const weatherCalls: unknown[][] = [];
const tools = createCaiusTools(undefined, async (...args: unknown[]) => {
    weatherCalls.push(args);
    return undefined;
}, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

/** Sets the Caius clock. */
const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

const notes: Record<string, string> = {};

async function dayNote(date: string, html: string): Promise<string> {
    const note = await store.calendarDay(date);
    await store.putContent(note.noteId, html);
    return note.noteId;
}

const sources = (answer: any): string[] => answer.data.candidates.map((c: any) => c.source);

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        notes.mon = await dayNote(MON, `<h2>☑️ Tasks</h2>${ul(
            li("m1", `${jiraLink("ZAP-105")} — Confirm the staging bucket name ~30m`),
            li("m2", `${jiraLink("ZAP-101")} — Verify the export retry on staging ~30m`),
            li("m3", `${jiraLink("ZAP-110")} — Review the import mapper change ~30m`)
        )}`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("work he finished never comes back", () => {
    it("Mon 17:30: closing the day marks ZAP-101 done and moves the other two on", async () => {
        at(`${MON}T17:30`);
        const done = await call("caius_set_state", { items: [ { noteId: notes.mon, listItemId: "m2", state: "done" } ] });
        expect(done.results[0]).toMatchObject({ status: "updated" });
        const moved = await call("caius_forward", { items: [
            { noteId: notes.mon, listItemId: "m3", to: "2026-W45" },
            { noteId: notes.mon, listItemId: "m1", to: TUE }
        ] });
        expect(moved.results.map((r: any) => r.status)).toEqual([ "moved", "moved" ]);
    });

    it("Tue 09:35: Plan my day leaves out ZAP-101, which Jira still calls Dev Verify, and keeps the forwarded ZAP-110 on offer from the week", async () => {
        at(`${TUE}T09:35`);
        const answer = await call("caius_planday", { date: TUE, step: "inputs" });
        expect(sources(answer)).not.toContain("ZAP-101");
        expect(sources(answer)).toEqual(expect.arrayContaining([ "ZAP-111", "ZAP-112", "2026-W45" ]));
        expect(answer.data.candidates.find((c: any) => c.source === "2026-W45")?.text).toContain("ZAP-110");
    });

    it("Tue 11:05: the agent can't put ZAP-101 back in Suggested by hand", async () => {
        at(`${TUE}T11:05`);
        const added = await call("caius_add", { items: [ { date: TUE, suggested: true, key: "ZAP-101", title: "Verify the export retry", because: "sitting in Dev Verify for 6 days", minutes: 45 } ] });
        expect(added.results[0]).toMatchObject({ status: "skipped", reason: "finished" });
    });

    it("Wed 17:45: a ticket he says is finished, that was never a task, leaves every list for 30 days", async () => {
        at(`${WED}T17:45`);
        const finished = await call("caius_finished", { keys: [ "ZAP-111" ] });
        expect(finished).toMatchObject({ status: "updated", keys: [ "ZAP-111" ] });
        expect(sources(await call("caius_winddown", { date: WED, step: "next" }))).not.toContain("ZAP-111");

        at("2026-12-04T09:30");
        expect(sources(await call("caius_planday", { date: "2026-12-04", step: "inputs" }))).not.toContain("ZAP-111");
        at("2026-12-05T09:30");
        expect(sources(await call("caius_planday", { date: "2026-12-05", step: "inputs" }))).toContain("ZAP-111");
    });

    it("Thu 09:30: a dismissal on Tuesday's note keeps ZAP-112 out of Friday's plan for Monday", async () => {
        at(`${THU}T09:30`);
        const added = await call("caius_add", { items: [ { date: TUE, suggested: true, key: "ZAP-112", title: "Check the report job", because: "sitting in Dev Verify for 6 days", minutes: 30 } ] });
        expect(added.results[0]).toMatchObject({ status: "added" });
        const dismissed = await call("caius_dismiss", { items: [ { noteId: added.results[0].writtenNoteId, listItemId: added.results[0].listItemId } ] });
        expect(dismissed.results[0]).toMatchObject({ status: "dismissed", key: "ZAP-112" });

        at(`${FRI}T17:20`);
        const answer = await call("caius_winddown", { date: FRI, step: "next" });
        expect(answer.targetDay).toBe(MON9);
        expect(sources(answer)).not.toContain("ZAP-112");
        expect(sources(answer)).not.toContain("ZAP-101");
    });

    it("after 14 days, a ticket done once and still open in Jira is offered again", async () => {
        at("2026-11-16T09:30");
        expect(sources(await call("caius_planday", { date: "2026-11-16", step: "inputs" }))).not.toContain("ZAP-101");
        at("2026-11-17T09:30");
        expect(sources(await call("caius_planday", { date: "2026-11-17", step: "inputs" }))).toContain("ZAP-101");
    });
});

describe("a wind-down that fits on one screen", () => {
    it("Wed 17:45: open lists today, the last three workdays and the week, and counts the 189 older overdue tasks", async () => {
        await cls.init(async () => {
            for (let day = 1; day <= 21; day++) {
                const date = `2026-10-${String(day).padStart(2, "0")}`;
                await dayNote(date, `<h3>Work</h3>${ul(...Array.from({ length: 9 }, (_, i) =>
                    li(`old${day}-${i}`, `Old overdue task ${day}.${i}: follow up on the vendor export and the long tail of the migration ~30m`)))}`);
            }
            await dayNote("2026-10-30", `<h3>Work</h3>${ul(li("f30", "Friday leftover ~30m"))}`);
            notes.wed = await dayNote(WED, `<h3>Work</h3>${ul(li("w1", "Wednesday thing ~30m"))}`);
        });
        at(`${WED}T17:45`);
        const answer = await call("caius_winddown", { date: WED, step: "open" });
        const items = answer.data.items.map((item: any) => [ item.group, item.text ]);
        expect(items).toEqual([
            [ "today", "Wednesday thing" ],
            [ "recent", "Friday leftover" ],
            [ "recent", expect.stringContaining("Confirm the staging bucket name") ],
            [ "week", expect.stringContaining("Review the import mapper change") ]
        ]);
        expect(answer.data).toMatchObject({ olderCount: 189, oldestDate: "2026-10-01" });
        expect(JSON.stringify(answer).length).toBeLessThan(20_000);
    });
});

describe("Context writes decide their own target", () => {
    const JACO = "Jaco out all week.";
    const ZAP2590 = "ZAP-2590 is open; Jira's Done is a mistake.";
    const contextOf = async (period: string, date: string) => (await call("caius_plan", { period, date })).context.map((line: any) => line.text);

    it("Mon 09:40: \"keep going\" on last week's lines writes them to week 45, not to Monday's note", async () => {
        await cls.init(async () => {
            const lastWeek = await store.calendarWeek("2026-W44");
            await store.putContent(lastWeek.noteId, `<h3>Context</h3><ul><li>${JACO}</li><li>${ZAP2590.replace("'", "&#39;")}</li></ul>`);
        });
        at(`${MON}T09:40`);
        const answer = await call("caius_planday", { date: MON, step: "inputs" });
        expect(answer.data.carry.map((c: any) => c.line).sort()).toEqual([ JACO, ZAP2590 ]);
        expect(answer.data.keepDate).toBe(MON);

        const kept = await call("caius_context_keep", { date: answer.data.keepDate, lines: answer.data.carry.map((c: any) => ({ text: c.line })) });
        expect(kept.results.map((r: any) => r.status)).toEqual([ "added", "added" ]);
        expect((await contextOf("week", "2026-W45")).sort()).toEqual([ JACO, ZAP2590 ]);
        expect(await contextOf("day", MON)).toEqual([]);
    });

    it("Fri 17:20: the wind-down carries them into week 46 for Monday", async () => {
        at(`${FRI}T17:20`);
        const answer = await call("caius_winddown", { date: FRI, step: "context" });
        expect(answer.data.keepDate).toBe(MON9);
        expect(answer.data.noticed.map((n: any) => n.line).sort()).toEqual([ JACO, ZAP2590 ]);
        expect(answer.question).toContain("into next week?");

        const kept = await call("caius_context_keep", { date: answer.data.keepDate, lines: [ { text: ZAP2590 } ] });
        expect(kept.results[0]).toMatchObject({ status: "added" });
        expect(await contextOf("week", "2026-W46")).toEqual([ ZAP2590 ]);
        expect((await call("caius_context", { date: "2026-11-10" })).context.map((line: any) => line.text)).toContain(ZAP2590);
    });

    it("caius_context_add moves a line about a ticket or a state to the week note, and keeps a line about one day on the day", async () => {
        at(`${WED}T17:45`);
        const ticketLine = await call("caius_context_add", { date: THU, text: "ZAP-2620 waits on legal" });
        expect(ticketLine.results[0]).toMatchObject({ status: "added", detail: "moved to the week note" });
        const out = await call("caius_context_add", { date: THU, text: "Riley is out on Thursday" });
        expect(out.results[0]).toMatchObject({ status: "added", detail: "moved to the week note" });
        const day = await call("caius_context_add", { date: THU, text: "Taking Incident Review over Vendor Onboarding at 11:00" });
        expect(day.results[0]).toMatchObject({ status: "added" });
        expect(day.results[0].detail).not.toBe("moved to the week note");

        expect(await contextOf("week", "2026-W45")).toEqual(expect.arrayContaining([ "ZAP-2620 waits on legal", "Riley is out on Thursday" ]));
        expect(await contextOf("day", THU)).toEqual([ "Taking Incident Review over Vendor Onboarding at 11:00" ]);
    });
});

describe("Suggested lines have one format, built by the tool", () => {
    it("writes the structured fields as \"Get KEY title done: because why (~Nm)\", with the estimate once", async () => {
        at(`${THU}T09:30`);
        const added = await call("caius_add", { items: [
            { date: THU, suggested: true, key: "ZAP-121", title: "Check the invoice export in QA", because: "because sitting in QA Testing for 3 days", minutes: 30 },
            { date: THU, suggested: true, title: "Book the venue", because: "the quote expires Friday", minutes: 15 }
        ] });
        expect(added.results.map((r: any) => r.status)).toEqual([ "added", "added" ]);
        const suggested = (await call("caius_plan", { period: "day", date: THU })).suggested.map((task: any) => task.text.replace(/\]\([^)]*\)/g, "]"));
        expect(suggested).toEqual([
            "Get [ZAP-121] Check the invoice export in QA done: because sitting in QA Testing for 3 days (~30m)",
            "Get Book the venue done: because the quote expires Friday (~15m)"
        ]);
    });

    it("rejects the four formats T13A's Suggested lines came in, and an estimate given twice", async () => {
        // The schema throws before the tool returns a promise.
        const add = (item: object) => Promise.resolve().then(() => call("caius_add", { items: [ item ] }));
        for (const text of [
            "ZAP-101 — Verify the export retry on staging ~30m",
            "ZAP-111",
            "ZAP-111 (QA Testing, 3 days) ~30m",
            "Get ZAP-111 \"Check the invoice export in QA\" done: sitting in QA Testing for 3 days (~30m) ~30m"
        ]) {
            await expect(add({ date: THU, suggested: true, text, source: "ZAP-111" }), text).rejects.toThrow(/Get KEY title done: because why \(~30m\)/);
        }
        await expect(add({ date: THU, suggested: true, key: "ZAP-120", title: "Check it", because: "it waits", minutes: 30, est: "30m" })).rejects.toThrow(/est/);
        const shaped = await call("caius_add", { items: [ { date: THU, suggested: true, text: "Get ZAP-120 Check it done: because it waits (~30m)", source: "ZAP-120" } ] });
        expect(shaped.results[0]).toMatchObject({ status: "added" });
    });
});

describe("follow-ups are raised once", () => {
    const ask = (key: string, commentId: string, created: string, author = "Riley Sample") =>
        ({ ticket: ticket(key), author, created, commentId, excerpt: "Is the legacy report job gone from production?" });
    const followUps = (answer: any) => answer.data.followUps.map((f: any) => `${f.key}:${f.commentId}`);

    it("Mon 09:40: a brief with a Follow up records every ask it was given", async () => {
        jira.done.push("ZAP-104");
        jira.asks.push(ask("ZAP-104", "2", "2026-10-26T19:30:00.000Z"), ask("ZAP-130", "20", "2026-10-30T14:00:00.000Z", "Jordan Placeholder"));
        at(`${MON}T09:40`);
        const brief = await call("caius_planday", { date: MON, step: "brief", refresh: true });
        expect(followUps(brief)).toEqual([ "ZAP-104:2", "ZAP-130:20" ]);
        expect(brief.data.shape.followUps).toEqual([ { key: "ZAP-104", commentId: "2" }, { key: "ZAP-130", commentId: "20" } ]);

        const written = await call("caius_brief_write", {
            ...brief.data.shape, headline: "Sprint planning, then the handoffs",
            sections: [ { title: "Follow up", markdown: "Riley asked on ZAP-104 whether the legacy report job is gone. If you already answered in Chat, dismiss this." } ]
        });
        const note = await cls.init(() => store.note(written.briefNoteId));
        expect(note.attributes.filter((a) => a.name === "caiusRaised").map((a) => a.value)).toEqual([ "ZAP-104:2", "ZAP-130:20" ]);
    });

    it("Thu 09:30: Plan my day and Wind down drop an ask raised on Monday until a newer comment comes", async () => {
        at(`${THU}T09:30`);
        const quiet = await call("caius_planday", { date: THU, step: "inputs", refresh: true });
        expect(followUps(quiet)).toEqual([]);
        expect(sources(quiet)).not.toContain("ZAP-130");
        expect(followUps(await call("caius_planday", { date: THU, step: "brief" }))).toEqual([]);

        jira.asks.push(ask("ZAP-130", "21", "2026-11-04T15:00:00.000Z", "Jordan Placeholder"));
        const newer = await call("caius_planday", { date: THU, step: "inputs", refresh: true });
        expect(followUps(newer)).toEqual([ "ZAP-130:21" ]);
        expect(sources(newer)).toContain("ZAP-130");
        expect(followUps(await call("caius_planday", { date: THU, step: "brief" }))).toEqual([ "ZAP-130:21" ]);
        expect(followUps(await call("caius_winddown", { date: THU, step: "next" }))).toEqual([ "ZAP-130:21" ]);
    });

    it("Tue 10 Nov: an ask raised more than 7 days ago can come back", async () => {
        at("2026-11-10T09:30");
        expect(followUps(await call("caius_planday", { date: "2026-11-10", step: "brief", refresh: true }))).toContain("ZAP-104:2");
    });
});

describe("never plan another day from a wind-down", () => {
    it("Fri 17:20: Plan my day refuses Monday, and still plans a missed morning", async () => {
        at(`${FRI}T17:20`);
        for (const step of [ "catchup", "inputs", "brief" ]) {
            expect(await call("caius_planday", { date: MON9, step }), step).toMatchObject({ step, date: MON9, error: "not_today" });
        }
        expect(await call("caius_planday", { date: THU, step: "catchup" })).toMatchObject({ step: "catchup", date: THU, next: "inputs" });
        expect(await call("caius_planday", { date: FRI, step: "catchup" })).toMatchObject({ step: "catchup", date: FRI, next: "inputs" });
    });

    it("Fri 17:20: the brief and the Meetings block refuse Monday too, and still write a missed day", async () => {
        at(`${FRI}T17:20`);
        const shape = (await call("caius_planday", { date: FRI, step: "brief" })).data.shape;
        expect(await call("caius_brief_write", { ...shape, date: MON9, headline: "Monday" })).toMatchObject({ date: MON9, error: "not_today" });
        expect(await call("caius_brief_write", { ...shape, date: MON9, headline: "Monday", dryRun: true })).toMatchObject({ error: "not_today" });
        expect(await call("caius_meetings", { date: MON9, items: [ "10:00 Standup" ] })).toMatchObject({ date: MON9, error: "not_today" });
        expect(await call("caius_meetings", { date: THU, items: [ "10:00 Daily Standup" ], dryRun: true })).toMatchObject({ date: THU, source: "items" });
    });
});

describe("the work layout starts at now", () => {
    it("Tue 11:05: the refresh lays ZAP-105 out from 11:15, not in the hour already gone", async () => {
        calendars[TUE] = [
            { start: "09:30", end: "09:45", title: "Team Standup", attendees: [], allDay: false, declined: false, source: [ 0 ] },
            { start: "10:00", end: "10:30", title: "Weekly Planning Sync", attendees: [], allDay: false, declined: false, source: [ 0 ] },
            { start: "15:00", end: "15:30", title: "Customer Call", attendees: [], allDay: false, declined: false, source: [ 0 ] }
        ];
        at(`${TUE}T11:05`);
        const brief = await call("caius_planday", { date: TUE, step: "brief", refresh: true });
        expect(brief.data.header.work[0]).toMatchObject({ start: "11:15", end: "11:45", focus: true });
        expect(brief.data.header.work[0].label).toBe("ZAP-105");

        at(`${WED}T09:40`);
        const missed = await call("caius_planday", { date: TUE, step: "brief" });
        expect(missed.data.header.work[0]).toMatchObject({ start: "10:30" });
    });
});

describe("weather by date", () => {
    it("Wed 09:40: the brief asks for the planned day's weather, and goes on without one", async () => {
        at(`${WED}T09:40`);
        const shape = (await call("caius_planday", { date: WED, step: "brief" })).data.shape;
        const written = await call("caius_brief_write", { ...shape, headline: "Wednesday", latitude: 39.95, longitude: -75.17 });
        expect(written.plannedAt).toBe(`${WED}T09:40:00`);
        expect(weatherCalls.at(-1)).toEqual([ 39.95, -75.17, WED ]);
    });
});

describe("the brief follows his list", () => {
    it("Fri 09:30: the picks and the work bars are his accepted tasks in his order; a candidate he left isn't a pick", async () => {
        await cls.init(() => dayNote(FRI, `<h2>☑️ Tasks</h2>${ul(
            li("x1", `${jiraLink("ZAP-140")} — Confirm the staging bucket ~30m`),
            li("x2", `${jiraLink("ZAP-141")} — Review the mapper change ~45m`)
        )}<h3>Suggested</h3>${ul(li("x3", `Get ${jiraLink("ZAP-142")} Check the export done: because it waits (~30m)`))}`));
        calendars[FRI] = [];
        at(`${FRI}T09:30`);
        const brief = await call("caius_planday", { date: FRI, step: "brief" });
        expect(brief.data.list.map((task: any) => [ task.label, task.minutes ])).toEqual([ [ "ZAP-140", 30 ], [ "ZAP-141", 45 ] ]);

        const written = await call("caius_brief_write", {
            ...brief.data.shape, headline: "Clear the handoffs",
            header: { ...brief.data.shape.header, work: [ { start: "12:00", end: "14:00", label: "Handoff queue" } ] },
            picks: [
                { text: "Get ZAP-142 Check the export done", because: "it waits", minutes: 30 },
                { text: "Get ZAP-141 Review the mapper change done", because: "Riley waits on it", minutes: 45 },
                { text: "Get ZAP-140 Confirm the staging bucket done", because: "the runbook needs it", minutes: 30 }
            ]
        });
        expect(written.droppedPicks).toEqual([ "Get ZAP-142 Check the export done" ]);
        expect(written.work.map((block: any) => [ block.start, block.end, block.label ])).toEqual([ [ "10:00", "10:30", "ZAP-140" ], [ "10:30", "11:15", "ZAP-141" ] ]);
        const body = await cls.init(() => store.content(written.briefNoteId));
        expect([ ...body.matchAll(/<li[^>]*>([^<]*)<\/li>/g) ].map((m) => m[1])).toEqual([
            "Get ZAP-140 Confirm the staging bucket done: because the runbook needs it (~30m)",
            "Get ZAP-141 Review the mapper change done: because Riley waits on it (~45m)"
        ]);
    });
});

describe("an evening thing he names", () => {
    it("goes on his list under Evening, above Suggested, and is drawn after the end of work", async () => {
        const day = "2026-11-12";
        await cls.init(() => dayNote(day, `<h3>Meetings</h3><ul><li>10:00 Daily Standup</li></ul><h3>Context</h3><ul><li>Taking Incident Review</li></ul>`
            + `<h2>☑️ Tasks</h2>${ul(li("e1", `${jiraLink("ZAP-150")} — Review the mapper ~30m`))}<h3>Suggested</h3>${ul(li("e2", `Get ${jiraLink("ZAP-151")} Check it done: because it waits (~30m)`))}`));
        calendars[day] = [ { start: "10:00", end: "10:15", title: "Daily Standup", attendees: [], allDay: false, declined: false, source: [ 0 ] } ];
        at(`${day}T09:30`);
        const added = await call("caius_add", { items: [ { date: day, section: "Evening", text: "Laundry ~45m" } ] });
        expect(added.results[0]).toMatchObject({ status: "added" });

        const plan = await call("caius_plan", { period: "day", date: day });
        expect(plan.sections.map((section: any) => [ section.name, section.tasks.map((task: any) => task.text) ])).toEqual([
            [ "☑️ Tasks", [ expect.stringContaining("Review the mapper") ] ],
            [ "Evening", [ "Laundry" ] ]
        ]);
        expect(plan.suggested.map((task: any) => task.text)).toEqual([ expect.stringContaining("Check it done") ]);
        const brief = await call("caius_planday", { date: day, step: "brief" });
        expect(brief.data.header.work.find((block: any) => block.label === "Laundry")).toMatchObject({ start: "18:00", end: "18:45" });
    });
});

describe("accepting into his list", () => {
    it("without a section, appends what he named after his own items, in his order, with no new heading", async () => {
        const day = "2026-11-13";
        const noteId = await cls.init(() => dayNote(day, `<h3>Meetings</h3><ul><li>10:00 Daily Standup</li></ul><h2>☑️ Tasks</h2>${ul(li("a1", "His own first thing ~30m"))}`
            + `<h3>Suggested</h3>${ul(li("as1", "Get Book the venue done: because the quote expires Friday (~15m)"), li("as2", "Get Write the notes done: because Sam asked (~30m)"))}`));
        at(`${day}T09:30`);
        const accepted = await call("caius_accept", { items: [ { noteId, listItemId: "as2" }, { noteId, listItemId: "as1" } ] });
        expect(accepted.results.map((r: any) => r.status)).toEqual([ "accepted", "accepted" ]);
        const plan = await call("caius_plan", { period: "day", date: day });
        expect(plan.sections.map((section: any) => [ section.name, section.tasks.map((task: any) => task.listItemId) ])).toEqual([ [ "☑️ Tasks", [ "a1", "as2", "as1" ] ] ]);
    });
});

describe("an accepted suggestion reads like his own task", () => {
    it("counts its estimate, keeps a clean bar label, and still matches its pick", async () => {
        const day = "2026-11-16";
        const noteId = await cls.init(() => dayNote(day, `<h2>☑️ Tasks</h2>${ul(li("b1", "His own first thing ~30m"))}<h3>Suggested</h3>${ul(
            li("bs1", `Get ${jiraLink("ZAP-111")} Check the invoice export in QA done: because sitting in QA Testing for 3 days (~45m)`),
            li("bs2", "Get Book the venue done: because the quote expires Friday (~15m)")
        )}`));
        calendars[day] = [];
        at(`${day}T09:30`);
        await call("caius_accept", { items: [ { noteId, listItemId: "bs1" }, { noteId, listItemId: "bs2" } ] });

        expect((await call("caius_plan", { period: "day", date: day })).capacity).toMatchObject({ totalMinutes: 90, unestimatedCount: 0 });
        const brief = await call("caius_planday", { date: day, step: "brief" });
        expect(brief.data.list.map((task: any) => [ task.label, task.text, task.minutes ])).toEqual([
            [ "His own first thing", "His own first thing", 30 ],
            [ "ZAP-111", "ZAP-111 Check the invoice export in QA", 45 ],
            [ "Book the venue", "Book the venue", 15 ]
        ]);
        const written = await call("caius_brief_write", { ...brief.data.shape, headline: "Venue and the export", picks: [
            { text: "Get Book the venue done", because: "the quote expires Friday", minutes: 15 }
        ] });
        expect(written.droppedPicks).toEqual([]);
        expect(written.work.map((block: any) => block.label)).toEqual([ "His own first thing", "ZAP-111", "Book the venue" ]);
    });
});

describe("week items", () => {
    it("are marked as week items, and one he names reaches his day once, through a forward", async () => {
        const day = "2026-11-18";
        const weekId = await cls.init(async () => {
            const week = await store.calendarWeek("2026-W47");
            await store.putContent(week.noteId, `<h3>Work</h3>${ul(li("wk1", "Order the banners ~30m"))}`);
            return week.noteId;
        });
        at(`${day}T09:30`);
        const inputs = await call("caius_planday", { date: day, step: "inputs" });
        const item = inputs.data.candidates.find((c: any) => c.text === "Order the banners");
        expect(item).toMatchObject({ kind: "week", noteId: weekId, listItemId: "wk1", source: "2026-W47" });
        expect(item.key).toBeUndefined();
        expect(inputs.data.candidates.filter((c: any) => c.kind !== "week").every((c: any) => c.kind === "handoff" || c.kind === "ask")).toBe(true);

        const moved = await call("caius_forward", { items: [ { noteId: item.noteId, listItemId: item.listItemId, to: day } ] });
        expect(moved.results[0]).toMatchObject({ status: "moved" });
        const open = await call("caius_open", { limit: 500 });
        expect(open.tasks.filter((task: any) => task.text.startsWith("Order the banners")).map((task: any) => task.period)).toEqual([ day ]);
        expect((await call("caius_planday", { date: day, step: "inputs" })).data.candidates.map((c: any) => c.text)).not.toContain("Order the banners");
    });
});

describe("finished clears Suggested", () => {
    it("dismisses the key's Suggested items from today on, and leaves earlier days alone", async () => {
        const suggestion = (id: string) => `<h3>Suggested</h3>${ul(li(id, `Get ${jiraLink("ZAP-170")} Check the export done: because it waits (~30m)`))}`;
        await cls.init(async () => {
            for (const [ date, id ] of [ [ "2026-11-18", "f18" ], [ "2026-11-19", "f19" ], [ "2026-11-20", "f20" ] ]) {
                const note = await store.calendarDay(date);
                await store.putContent(note.noteId, (await store.content(note.noteId)) + suggestion(id));
            }
        });
        at("2026-11-19T09:30");
        const finished = await call("caius_finished", { keys: [ "ZAP-170" ] });
        expect(finished.dismissed.map((d: any) => [ d.listItemId, d.status ])).toEqual([ [ "f19", "dismissed" ], [ "f20", "dismissed" ] ]);
        const suggested = async (date: string) => (await call("caius_plan", { period: "day", date })).suggested.map((task: any) => task.listItemId);
        expect(await suggested("2026-11-18")).toContain("f18");
        expect(await suggested("2026-11-19")).not.toContain("f19");
        expect(await suggested("2026-11-20")).not.toContain("f20");
    });
});

describe("a done task closes its own ticket only", () => {
    it("\"Reply to Riley on ZAP-180, unblocks ZAP-181\" done closes ZAP-180 and leaves ZAP-181 on offer", async () => {
        jira.handoff.push({ ...ticket("ZAP-180"), daysInStatus: 2 }, { ...ticket("ZAP-181"), daysInStatus: 2 });
        await cls.init(() => dayNote("2026-11-23", `<h2>☑️ Tasks</h2>${ul(li("r1", "Reply to Riley on ZAP-180, unblocks ZAP-181", { checked: true }))}`));
        at("2026-11-24T09:30");
        const offered = sources(await call("caius_planday", { date: "2026-11-24", step: "inputs" }));
        expect(offered).not.toContain("ZAP-180");
        expect(offered).toContain("ZAP-181");
    });
});

describe("where a Context line goes", () => {
    const day = "2026-11-25";
    const lines = async (period: string, date: string) => (await call("caius_plan", { period, date })).context.map((line: any) => [ line.text, line.until ?? null ]);
    // The reviewer's examples: where each line lands, and when it ends.
    const DAY: string[] = [
        "Riley is out today", "Heads down until lunch", "Pair with Sam on ZAP-110 at 14:00",
        "Taking Incident Review over Vendor Onboarding at 11:00", "Dentist 15:00, offline until 16:30", "Gym is off tonight",
        "Riley out tomorrow", "Kick off the migration", "Back up the prod DB first", "Sign off on the release notes",
        "Wind down early, school play", "Jordan off sick"
    ];
    const WEEK: [ string, string | null ][] = [
        [ "ZAP-2590 is open; Jira's Done is a mistake.", null ], [ "Sam's off this week", null ], [ "Release freeze this week", null ],
        [ "Jaco out all week.", null ], [ "Vendor freeze until Friday", null ], [ "Code review paused until 27 Nov", null ],
        [ "Staging is down", day ], [ "Jordan covering for Jaco", day ], [ "Jaco is on PTO", day ], [ "Sam is on vacation", day ],
        [ "Pat is on holiday", day ], [ "Riley is out Thursday", day ], [ "Code freeze from Wednesday", day ],
        [ "Jaco out Thu-Fri", "2026-11-27" ]
    ];

    it("keeps a line on the day unless it names a ticket, a state after is/are, a span or a weekday range", async () => {
        at(`${day}T09:30`);
        for (const text of DAY) expect((await call("caius_context_add", { date: day, text })).results[0].detail, text).not.toBe("moved to the week note");
        for (const [ text ] of WEEK) expect((await call("caius_context_add", { date: day, text })).results[0].detail, text).toBe("moved to the week note");
        expect((await call("caius_context_add", { date: day, text: "Sam's away next week" })).results[0].detail).toBe("moved to the week note");

        expect((await lines("day", day)).map(([ text ]: string[]) => text).sort()).toEqual([ ...DAY ].sort());
        expect((await lines("week", "2026-W48")).sort()).toEqual([ ...WEEK ].sort());
        expect(await lines("week", "2026-W49")).toEqual([ [ "Sam's away next week", null ] ]);
    });
});

describe("a same-day refresh keeps the Follow up", () => {
    it("09:35 raises the ask, 11:05 still has it, and the next morning drops it", async () => {
        const day = "2026-11-26";
        jira.asks.push({ ticket: ticket("ZAP-190"), author: "Riley Sample", created: "2026-11-25T15:00:00.000Z", commentId: "30", excerpt: "Is the bucket confirmed?" });
        await cls.init(() => dayNote(day, `<h2>☑️ Tasks</h2>${ul(li("q1", "Something ~30m"))}`));
        const raised = (answer: any) => answer.data.followUps.map((f: any) => `${f.key}:${f.commentId}`);

        at(`${day}T09:35`);
        const morning = await call("caius_planday", { date: day, step: "brief", refresh: true });
        expect(raised(morning)).toContain("ZAP-190:30");
        await call("caius_brief_write", { ...morning.data.shape, headline: "Morning", sections: [ { title: "Follow up", markdown: "Riley asked on ZAP-190 whether the bucket is confirmed." } ] });

        at(`${day}T11:05`);
        expect(raised(await call("caius_planday", { date: day, step: "brief" }))).toContain("ZAP-190:30");
        at("2026-11-27T09:30");
        expect(raised(await call("caius_planday", { date: "2026-11-27", step: "brief", refresh: true }))).not.toContain("ZAP-190:30");
    });
});

describe("what counts as raised", () => {
    it("records every follow-up passed when the Follow up has text, whatever its wording, and none without one", async () => {
        const day = "2026-11-30";
        jira.asks.push({ ticket: ticket("ZAP-191"), author: "Jordan Placeholder", created: "2026-11-27T15:00:00.000Z", commentId: "31", excerpt: "Can you check?" });
        jira.asks.push({ ticket: ticket("ZAP-192"), author: "Sam Example", created: "2026-11-27T16:00:00.000Z", commentId: "32", excerpt: "Any news?" });
        await cls.init(() => dayNote(day, `<h2>☑️ Tasks</h2>${ul(li("v1", "Something ~30m"))}`));
        at(`${day}T09:30`);
        const brief = await call("caius_planday", { date: day, step: "brief", refresh: true });
        const passed = brief.data.shape.followUps;
        expect(passed).toEqual([ { key: "ZAP-191", commentId: "31" }, { key: "ZAP-192", commentId: "32" } ]);
        const raisedOn = async (noteId: string) => (await cls.init(() => store.note(noteId))).attributes.filter((a) => a.name === "caiusRaised").map((a) => a.value).sort();

        const quiet = await call("caius_brief_write", { ...brief.data.shape, headline: "Quiet", sections: [ { title: "Follow up", markdown: " " }, { title: "Heads-up", markdown: "ZAP-191 shipped." } ] });
        expect(await raisedOn(quiet.briefNoteId)).toEqual([]);

        const written = await call("caius_brief_write", { ...brief.data.shape, headline: "Asks", sections: [ { title: "Follow up", markdown: "Jordan asked whether you could check the export." } ] });
        expect(await raisedOn(written.briefNoteId)).toEqual(passed.map((f: any) => `${f.key}:${f.commentId}`).sort());
    });

    it("accepts only valid ticket keys in followUps", async () => {
        const schema = [ ...tools ].find(([ n ]) => n === "caius_brief_write")?.[1].inputSchema;
        const shape = { date: "2026-11-30", headline: "x", acts: [ { range: "", text: "" }, { range: "", text: "" }, { range: "", text: "" } ], picks: [], sections: [],
            header: { start: "10:00", end: "23:00", events: [], work: [] } };
        expect(schema?.safeParse({ ...shape, followUps: [ { key: "ZAP-1", commentId: "1" } ] }).success).toBe(true);
        expect(schema?.safeParse({ ...shape, followUps: [ { key: "ZAP.*", commentId: "1" } ] }).success).toBe(false);
    });
});

describe("done in Jira", () => {
    it("flags the wind-down's open items whose ticket Jira calls done", async () => {
        const day = "2026-12-01";
        await cls.init(() => dayNote(day, `<h2>☑️ Tasks</h2>${ul(li("j1", `${jiraLink("ZAP-104")} — Remove the legacy job ~30m`), li("j2", "Plain thing ~30m"))}`));
        at(`${day}T17:30`);
        const answer = await call("caius_winddown", { date: day, step: "open" });
        expect(answer.data.items.filter((item: any) => item.group === "today").map((item: any) => [ item.listItemId, item.jiraDone ?? false ])).toEqual([ [ "j1", true ], [ "j2", false ] ]);
    });
});

describe("accepting past an Evening list", () => {
    it("Thu: with only laundry under Evening, accepting ZAP-9 lands under Tasks and counts as work", async () => {
        const day = "2026-12-03";
        const noteId = await cls.init(() => dayNote(day, `<h2>☑️ Tasks</h2><h3>Evening</h3>${ul(li("l1", "Laundry ~45m"))}<h3>Suggested</h3>${ul(
            li("z9", `Get ${jiraLink("ZAP-9")} Fix it done: because it waits (~45m)`))}`));
        calendars[day] = [];
        at(`${day}T09:30`);
        expect((await call("caius_accept", { items: [ { noteId, listItemId: "z9" } ] })).results[0]).toMatchObject({ status: "accepted" });
        const plan = await call("caius_plan", { period: "day", date: day });
        expect(plan.sections.map((section: any) => [ section.name, section.tasks.map((task: any) => task.listItemId) ])).toEqual([ [ "☑️ Tasks", [ "z9" ] ], [ "Evening", [ "l1" ] ] ]);
        const brief = await call("caius_planday", { date: day, step: "brief" });
        expect(brief.data.list.map((task: any) => [ task.label, task.evening ])).toEqual([ [ "ZAP-9", false ], [ "Laundry", true ] ]);
        expect(brief.data.header.work.find((block: any) => block.label === "ZAP-9")).toMatchObject({ start: "10:00", end: "10:45" });
    });
});

describe("a keyless suggestion of a live task", () => {
    it("skips 'Sandbox first', already on the week's list, as a duplicate, written either way", async () => {
        await cls.init(async () => {
            const week = await store.calendarWeek("2026-W49");
            await store.putContent(week.noteId, `<h2>Tasks</h2>${ul(li("sb1", "Sandbox first ~30m"))}`);
        });
        at("2026-12-02T09:30");
        const added = await call("caius_add", { items: [
            { date: "2026-12-02", suggested: true, title: "Sandbox first", because: "on the week's list", minutes: 30 },
            { date: "2026-12-02", suggested: true, text: "Get Sandbox first done: because on the week's list (~30m)" }
        ] });
        expect(added.results.map((r: any) => [ r.status, r.reason ])).toEqual([ [ "skipped", "duplicate" ], [ "skipped", "duplicate" ] ]);
        expect((await call("caius_plan", { period: "day", date: "2026-12-02" })).suggested).toEqual([]);
    });
});
