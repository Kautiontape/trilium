/**
 * The week of the second normal-user simulation (T16, Mon 2 to Mon 9 Nov 2026), replayed through
 * the tools: each test follows one of the sequences that went wrong there.
 */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs, JiraTicket } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const bullets = (...items: string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const MON9 = "2026-11-09";

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Code Review", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-10-27T10:00:00.000-0400", ...o
});

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
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
    return { code: 61, label: "Rain" };
}, stubInputs);

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li><li>Bedtime: 23:00.</li><li>Location for the weather: 39.95, -75.17</li></ul>"
    + "<h2>Brief rules</h2><ul><li>Open time is work time.</li></ul>";

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

/** Sets the Caius clock. */
const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        const w44 = await store.calendarWeek("2026-W44");
        await store.putContent(w44.noteId, `<h3>Context</h3>${bullets("ZAP-2590 is open; Jira&#39;s Done is a mistake.")}`);
        await store.addLabel(createChildNote("root", "🧭 How I work", STANDING), "assistantContext", "");
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a Context line is one line, whatever its full stop", () => {
    it("Tue 09:35: the line Monday kept into Week 45 without its full stop isn't offered to carry again", async () => {
        at(`${MON}T09:40`);
        const monday = await call("caius_planday", { date: MON, step: "inputs" });
        expect(monday.data.carry.map((c: any) => c.line)).toEqual([ "ZAP-2590 is open; Jira's Done is a mistake." ]);
        const kept = await call("caius_context_keep", { date: MON, lines: [ { text: "ZAP-2590 is open; Jira's Done is a mistake" } ] });
        expect(kept.results[0]).toMatchObject({ status: "added", week: "2026-W45" });

        at(`${TUE}T09:35`);
        const tuesday = await call("caius_planday", { date: TUE, step: "inputs" });
        expect(tuesday.data.carry).toEqual([]);
        expect(tuesday.data.context.map((c: any) => c.text)).toEqual([ "ZAP-2590 is open; Jira's Done is a mistake" ]);
    });
});

describe("a day note's Context lasts its day", () => {
    it("Wed 17:45 to Fri: Thursday's overlap answer holds on Thursday and is gone on Friday, never offered to carry", async () => {
        at(`${WED}T17:45`);
        const added = await call("caius_context_add", { date: THU, text: "Take Incident Review over Vendor Onboarding at 11:00" });
        expect(added.results[0]).toMatchObject({ status: "added" });
        const line = "Take Incident Review over Vendor Onboarding at 11:00";
        expect((await call("caius_context", { date: THU })).context.map((c: any) => c.text)).toContain(line);
        expect((await call("caius_context", { date: FRI })).context.map((c: any) => c.text)).not.toContain(line);
        expect((await call("caius_context", { date: MON9 })).context.map((c: any) => c.text)).not.toContain(line);

        at(`${THU}T17:30`);
        const closing = await call("caius_winddown", { date: THU, step: "context" });
        expect(closing.data.noticed.map((n: any) => n.line)).not.toContain(line);
        at(`${FRI}T09:30`);
        expect((await call("caius_planday", { date: FRI, step: "inputs" })).data.carry.map((c: any) => c.line)).not.toContain(line);
    });
});

describe("step data names every date and carries the ids the apply tools take", () => {
    it("Mon 2 Nov: the catch-up says Friday 30 Oct, not Thursday", async () => {
        at(`${MON}T09:40`);
        const catchup = await call("caius_planday", { date: MON, step: "catchup" });
        expect(catchup).toMatchObject({ date: MON, dateLabel: "Mon 2 Nov" });
        expect(catchup.data).toMatchObject({ lastWorkday: "2026-10-30", lastWorkdayLabel: "Fri 30 Oct", moveTo: MON, moveToLabel: "Mon 2 Nov" });
    });

    it("Fri 13 Nov: the wind-down labels each fate and origin, and gives each line and candidate an id", async () => {
        jira.handoff.push({ ...ticket("ZAP-110"), daysInStatus: 2 });
        await cls.init(async () => {
            const friday = await store.calendarDay("2026-11-13");
            await store.putContent(friday.noteId, `<h2>☑️ Tasks</h2>${ul(li("f13a", "Write the runbook ~30m"))}`);
            const week = await store.calendarWeek("2026-W46");
            await store.putContent(week.noteId, `<h3>Context</h3>${bullets("Sam is out.")}<h2>☑️ Tasks</h2>${ul(li("w46a", "Tidy the backlog ~45m"))}`);
        });
        at("2026-11-13T17:30");
        const open = await call("caius_winddown", { date: "2026-11-13", step: "open" });
        expect(open).toMatchObject({ targetDay: "2026-11-16", targetDayLabel: "Mon 16 Nov" });
        expect(open.data.items).toEqual([
            expect.objectContaining({ listItemId: "f13a", period: "2026-11-13", periodLabel: "Fri 13 Nov", fate: { forward: "2026-11-16", forwardLabel: "Mon 16 Nov" } }),
            expect.objectContaining({ listItemId: "w46a", period: "2026-W46", periodLabel: "the week of Mon 9 Nov", fate: { forward: "2026-W47", forwardLabel: "the week of Mon 16 Nov" } })
        ]);

        const next = await call("caius_winddown", { date: "2026-11-13", step: "next" });
        expect(next.data.candidates.find((c: any) => c.key === "ZAP-110")).toMatchObject({ candidateId: "ZAP-110" });

        const context = await call("caius_winddown", { date: "2026-11-13", step: "context" });
        const carry = context.data.noticed.find((n: any) => n.kind === "carry");
        expect(carry).toMatchObject({ line: "Sam is out.", lineId: expect.stringMatching(/^l[0-9a-f]{10}$/) });
        expect(context.data).toMatchObject({ targetWeek: "2026-W47", targetWeekLabel: "the week of Mon 16 Nov", keepDate: "2026-11-16", keepDateLabel: "Mon 16 Nov" });

        at("2026-11-16T09:30");
        const monday = await call("caius_planday", { date: "2026-11-16", step: "inputs" });
        expect(monday.data.carry).toEqual([ expect.objectContaining({ line: "Sam is out.", lineId: carry.lineId }) ]);
    });
});

describe("done means done everywhere in the step data", () => {
    const ask = (key: string, commentId: string, created: string, author = "Riley Sample", excerpt = "Is the legacy report job gone from production?") =>
        ({ ticket: ticket(key), author, created, commentId, excerpt });

    it("Thu 5 Nov: a ticket done in Monday's note isn't in caius_inputs' review list, nor a Done ticket's ask in the follow-ups", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay(MON);
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("m111", "<a href=\"https://example.atlassian.net/browse/ZAP-111\">ZAP-111</a> Check the export in QA ~30m"))}`);
        });
        jira.handoff.push({ ...ticket("ZAP-111", { status: "QA Testing" }), daysInStatus: 3 }, { ...ticket("ZAP-104"), daysInStatus: 9 });
        jira.asks.push(ask("ZAP-104", "2", "2026-10-26T19:30:00.000Z"));
        jira.done.push("ZAP-104");

        at(`${MON}T17:30`);
        const notes = await call("caius_plan", { period: "day", date: MON });
        const done = await call("caius_set_state", { items: [ { noteId: notes.noteId, listItemId: "m111", state: "done" } ] });
        expect(done.results[0]).toMatchObject({ status: "updated" });

        at(`${WED}T09:40`);
        const wednesday = await call("caius_planday", { date: WED, step: "brief", refresh: true });
        expect(wednesday.data.followUps.map((f: any) => f.key)).not.toContain("ZAP-104");

        at(`${THU}T09:30`);
        const review = await call("caius_inputs", { date: THU, refresh: true });
        expect(review.jira.handoff.map((t: any) => t.key)).toContain("ZAP-110");
        expect(review.jira.handoff.map((t: any) => t.key)).not.toContain("ZAP-111");
        expect(review.jira.handoff.map((t: any) => t.key)).not.toContain("ZAP-104");
        expect(review.jira.asks.map((a: any) => a.ticket.key)).not.toContain("ZAP-104");
        expect(review.jira.done).toContain("ZAP-104");
        const inputs = await call("caius_planday", { date: THU, step: "inputs" });
        expect(inputs.data.followUps.map((f: any) => f.key)).not.toContain("ZAP-104");
    });
});

describe("follow-ups are written by the tool", () => {
    it("Mon 2 Nov: Jordan's ZAP-105 comment reads as a quote, not as an ask the agent reworded", async () => {
        const excerpt = "The rollout note is now in the runbook, so the deploy can go ahead whenever the staging bucket name is confirmed by someone on your side.";
        jira.asks.push({ ticket: ticket("ZAP-105"), author: "Jordan Placeholder", created: "2026-11-01T15:00:00.000Z", commentId: "50", excerpt });
        at(`${MON}T09:40`);
        const brief = await call("caius_planday", { date: MON, step: "brief", refresh: true });
        const followUp = brief.data.followUps.find((f: any) => f.key === "ZAP-105");
        expect(followUp.sentence).toBe("Jordan Placeholder asked on Sunday: \"The rollout note is now in the runbook, so the deploy can go ahead whenever the staging bucket name…\" (ZAP-105). If you already answered in Chat, dismiss this.");
        // The brief's Follow up starts from the same sentences.
        expect(brief.data.shape.sections[0]).toEqual({ title: "Follow up", markdown: `- ${followUp.sentence}` });
    });
});

describe("the overdue backlog is not a nightly line", () => {
    it("Mon and Wed nights leave the older count out; Friday, or a wind-down that asks, has it", async () => {
        await cls.init(async () => {
            const july = await store.calendarDay("2026-07-01");
            await store.putContent(july.noteId, `<h2>☑️ Tasks</h2>${ul(li("j1", "Sort the garage ~1h"))}`);
        });
        for (const date of [ MON, WED ]) {
            at(`${date}T17:30`);
            const open = await call("caius_winddown", { date, step: "open" });
            expect(open.data, date).not.toHaveProperty("olderCount");
            expect(open.data, date).not.toHaveProperty("oldestDate");
            expect((await call("caius_winddown", { date, step: "open", older: true })).data, date).toMatchObject({ olderCount: 1, oldestDate: "2026-07-01" });
        }
        at(`${FRI}T17:20`);
        expect((await call("caius_winddown", { date: FRI, step: "open" })).data).toMatchObject({ olderCount: 1, oldestDate: "2026-07-01", oldestDateLabel: "Wed 1 Jul" });
    });
});

describe("the weather never depends on the agent", () => {
    it("Thu 5 Nov: a brief written without coordinates still gets the day's weather, from the standing note", async () => {
        at(`${THU}T09:30`);
        const shape = (await call("caius_planday", { date: THU, step: "brief" })).data.shape;
        const { latitude: _latitude, longitude: _longitude, ...withoutCoordinates } = shape;
        weatherCalls.length = 0;
        const written = await call("caius_brief_write", { ...withoutCoordinates, headline: "A heavy day of meetings" });
        expect(written).toMatchObject({ date: THU, plannedAt: expect.any(String) });
        expect(weatherCalls).toEqual([ [ 39.95, -75.17, THU ] ]);
        const svg = await cls.init(async () => (await store.note(written.headerNoteId)) && (await import("@triliumnext/core")).becca.getAttachmentOrThrow(written.attachmentId).getContent());
        expect(String(svg)).toContain("data-part=\"weather\"");
    });
});

/** A brief's prose, as the agent writes it. */
const prose = { headline: "A light day", acts: [ { range: "10:00 to 12:00", text: "x" }, { range: "12:00 to 18:00", text: "y" }, { range: "Evening", text: "z" } ], sections: [] };

describe("skip is not dismiss", () => {
    it("Mon 2 Nov 'skip the rest': ZAP-110 and ZAP-105 are put off for Monday only, and offered again on Tuesday", async () => {
        at(`${MON}T09:40`);
        const monday = await call("caius_planday", { date: MON, step: "inputs", refresh: true });
        const offered = monday.data.candidates.map((c: any) => c.candidateId);
        expect(offered).toEqual(expect.arrayContaining([ "ZAP-110", "ZAP-105" ]));
        const applied = await call("caius_plan_apply", { date: MON, notToday: [ { candidateId: "ZAP-110" }, { candidateId: "ZAP-105" } ], brief: prose });
        expect(applied.skipped).toEqual([]);
        const note = await cls.init(async () => store.note((await call("caius_plan", { period: "day", date: MON })).noteId));
        expect(note.attributes.filter((a) => a.name === "caiusNotToday").map((a) => a.value).sort()).toEqual([ "ZAP-105", "ZAP-110" ]);
        expect(note.attributes.filter((a) => a.name === "caiusDismissed")).toEqual([]);
        // Monday itself no longer offers them, nor its Suggested holds them.
        const forMonday = await call("caius_winddown", { date: "2026-10-30", step: "next" });
        expect(forMonday.data.candidates.map((c: any) => c.candidateId)).not.toContain("ZAP-110");
        expect(forMonday.data.candidates.map((c: any) => c.candidateId)).not.toContain("ZAP-105");

        at(`${TUE}T09:35`);
        const tuesday = await call("caius_planday", { date: TUE, step: "inputs", refresh: true });
        expect(tuesday.data.candidates.map((c: any) => c.candidateId)).toEqual(expect.arrayContaining([ "ZAP-110", "ZAP-105" ]));
    });
});

describe("the ZAP-2590 line is asked about only at the week boundary", () => {
    it("Wed night doesn't raise it; Friday offers to carry it into Week 46 once", async () => {
        const lines = (answer: any) => answer.data.noticed.map((n: any) => n.line);
        at(`${WED}T17:45`);
        expect(lines(await call("caius_winddown", { date: WED, step: "context" }))).not.toContain("ZAP-2590 is open; Jira's Done is a mistake");
        at(`${FRI}T17:20`);
        expect(lines(await call("caius_winddown", { date: FRI, step: "context" }))).toContain("ZAP-2590 is open; Jira's Done is a mistake");
    });
});

describe("only his explicit words drop, cancel or dismiss", () => {
    it("Tue 3 Nov 11:10 (sim B R1.3) 'I saw Jordan's note, drop that one': ZAP-105 is dismissed, and its Follow up goes with it", async () => {
        at(`${TUE}T11:10`);
        const inputs = await call("caius_planday", { date: TUE, step: "inputs", refresh: true });
        expect(inputs.data.candidates.map((c: any) => c.candidateId)).toContain("ZAP-105");
        const applied = await call("caius_plan_apply", { date: TUE, dismiss: [ { candidateId: "ZAP-105" } ], brief: prose });
        expect(applied.skipped).toEqual([]);
        expect(applied.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "dismiss", id: "ZAP-105", status: "written" }) ]));
        const tuesday = await call("caius_plan", { period: "day", date: TUE });
        expect(tuesday.suggested.map((t: any) => t.text).join()).not.toContain("ZAP-105");
        const note = await cls.init(() => store.note(tuesday.noteId));
        expect(note.attributes.filter((a) => a.name === "caiusDismissed").map((a) => a.value)).toEqual([ "ZAP-105" ]);
        expect((await call("caius_planday", { date: TUE, step: "brief" })).data.followUps.map((f: any) => f.key)).not.toContain("ZAP-105");
        at(`${WED}T09:40`);
        expect((await call("caius_planday", { date: WED, step: "inputs", refresh: true })).data.candidates.map((c: any) => c.candidateId)).not.toContain("ZAP-105");
    });

    it("Mon night (sim B R2.1) 'dave skip that': an open item he doesn't name is moved as proposed, never cancelled; a drop needs his reason; no Context line is removed", async () => {
        await cls.init(async () => {
            const day = await store.calendarDay("2026-11-23");
            await store.putContent(day.noteId, `<h3>Context</h3>${bullets("Vendor call moved to Thursday")}<h2>☑️ Tasks</h2>${ul(li("dave23", "Message Dave about hanging lights"))}`);
        });
        at("2026-11-23T17:30");
        const applied = await call("caius_winddown_apply", { date: "2026-11-23", context: [ "Riley covers the release" ] });
        expect(applied.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "fate", id: "dave23", detail: "2026-11-24" }) ]));
        const monday = await call("caius_plan", { period: "day", date: "2026-11-23" });
        expect(monday.sections.flatMap((s: any) => s.tasks).map((t: any) => t.text)).toEqual([ expect.stringContaining("_scheduled [Tuesday 24]") ]);
        expect(monday.context.map((c: any) => c.text)).toEqual([ "Vendor call moved to Thursday" ]);
        await expect(async () => call("caius_winddown_apply", { date: "2026-11-23", fates: [ { listItemId: "dave23", drop: "" } ] })).rejects.toThrow(/too_small|>=1/);
    });
});

describe("Heads-up comes only from outside events", () => {
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });
    const DAY = "2026-11-17";

    it("Tue 11:05 (round 2): the moved Customer Call is the Heads-up, never a line from the standing note", async () => {
        calendars[DAY] = [ event("09:30", "09:45", "Team Standup"), event("11:00", "11:30", "Customer Call") ];
        at(`${DAY}T09:35`);
        const morning = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(morning.data.headsUp).toEqual([]);
        const sections = [ { title: "Heads-up", markdown: "Jaco is out on PTO this week." } ];
        expect((await call("caius_plan_apply", { date: DAY, brief: { ...prose, sections } })).skipped).toEqual([]);

        calendars[DAY] = [ event("09:30", "09:45", "Team Standup"), event("15:00", "15:30", "Customer Call"), event("16:00", "16:30", "Vendor sync") ];
        at(`${DAY}T11:05`);
        const refresh = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(refresh.data.headsUp).toEqual([ "Customer Call moved to 15:00.", "New on the calendar: 16:00 Vendor sync." ]);
        const applied = await call("caius_plan_apply", { date: DAY, brief: { ...prose, sections } });
        const brief = await cls.init(() => store.content(applied.briefNoteId));
        expect(brief).toContain("<h2>Heads-up</h2><ul><li");
        expect(brief).toContain("Customer Call moved to 15:00.");
        expect(brief).not.toContain("Jaco");
    });
});

describe("a Context line can hold over a range of days", () => {
    it("'Sam is out Thu–Fri', written on Monday, holds on Thursday and Friday only, and is Thursday's Heads-up", async () => {
        at("2026-11-30T17:30");
        const added = await call("caius_context_add", { date: "2026-11-30", text: "Sam is out Thu–Fri" });
        expect(added.results[0]).toMatchObject({ status: "added", line: "Sam is out Thu–Fri (from Thu 3 Dec until Fri 4 Dec)", detail: "moved to the week note" });
        const inForce = async (date: string) => (await call("caius_context", { date })).context.map((c: any) => c.text).includes("Sam is out Thu–Fri");
        expect([ await inForce("2026-12-01"), await inForce("2026-12-02"), await inForce("2026-12-03"), await inForce("2026-12-04"), await inForce("2026-12-07") ])
            .toEqual([ false, false, true, true, false ]);

        at("2026-12-03T09:30");
        const thursday = await call("caius_planday", { date: "2026-12-03", step: "inputs", refresh: true });
        expect(thursday.data.headsUp).toEqual([ "Sam is out Thu–Fri" ]);
        const applied = await call("caius_plan_apply", { date: "2026-12-03", brief: prose });
        expect(await cls.init(() => store.content(applied.briefNoteId))).toContain("Sam is out Thu–Fri");
        at("2026-12-04T09:30");
        expect((await call("caius_planday", { date: "2026-12-04", step: "inputs", refresh: true })).data.headsUp).toEqual([]);
    });
});

describe("a refresh keeps the morning", () => {
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });
    const DAY = "2026-11-19";

    it("11:05 (round 2, sim B R1.3): his picks and the Follow up stay, the settled overlap isn't asked again, only the new one is", async () => {
        jira.asks.push({ ticket: ticket("ZAP-140"), author: "Riley Sample", created: "2026-11-18T15:00:00.000Z", commentId: "70", excerpt: "Is the bucket confirmed?" });
        calendars[DAY] = [ event("10:00", "10:15", "Standup"), event("10:30", "11:30", "Incident Review"), event("11:00", "12:00", "Vendor Onboarding") ];
        at(`${DAY}T09:35`);
        const morning = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(morning.question).toContain("Incident Review overlaps Vendor Onboarding");
        const first = await call("caius_plan_apply", {
            date: DAY, accept: [ { candidateId: "ZAP-110" } ], context: [ "Take Incident Review over Vendor Onboarding at 11:00" ], brief: prose
        });
        expect(first.skipped).toEqual([]);
        const before = await cls.init(() => store.content(first.briefNoteId));
        expect(before).toContain("ZAP-110");
        expect(before).toContain("(ZAP-140)");

        calendars[DAY] = [ ...calendars[DAY] ?? [], event("14:00", "15:00", "Roadmap Review"), event("14:30", "15:30", "Design Workshop") ];
        at(`${DAY}T11:05`);
        const refresh = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(refresh.data.candidates).toEqual([]);
        expect(refresh.data.carry).toEqual([]);
        expect(refresh.question).toBe("Roadmap Review overlaps Design Workshop at 14:30. Which one do you take?");
        const second = await call("caius_plan_apply", { date: DAY, brief: prose });
        const after = await cls.init(() => store.content(second.briefNoteId));
        expect(after).toContain("ZAP-110");
        expect(after).toContain("(ZAP-140)");

        at(`${DAY}T11:30`);
        expect((await call("caius_planday", { date: DAY, step: "inputs", refresh: true })).question).toBeNull();
    });
});

describe("the catch-up covers every day since the last closed one", () => {
    const task = async (date: string, id: string, text: string) => cls.init(async () => {
        const note = await store.calendarDay(date);
        await store.putContent(note.noteId, `<h2>☑️ Tasks</h2>${ul(li(id, text))}`);
    });

    it("Thu 10 Dec after missed Tuesday and Wednesday nights: both days' tasks, back to Monday's wind-down", async () => {
        await task("2026-12-04", "c4", "Friday leftover");
        await task("2026-12-07", "c7", "Call the bank");
        at("2026-12-07T17:30");
        expect((await call("caius_winddown_apply", { date: "2026-12-07" })).skipped).toEqual([]);
        await task("2026-12-09", "c9", "Book the venue");

        at("2026-12-10T09:30");
        const catchup = await call("caius_planday", { date: "2026-12-10", step: "catchup" });
        expect(catchup.data).toMatchObject({ lastWorkday: "2026-12-09", days: [ "2026-12-08", "2026-12-09" ], oldestDay: "2026-12-08", oldestDayLabel: "Tue 8 Dec" });
        // Monday's wind-down moved Friday's leftover to Tuesday too; Friday itself is behind the wound-down Monday.
        expect(catchup.data.tasks.map((t: any) => [ t.period, t.text.split(" [")[0] ])).toEqual([
            [ "2026-12-08", "Call the bank" ], [ "2026-12-08", "Friday leftover" ], [ "2026-12-09", "Book the venue" ]
        ]);
        expect(catchup.question).toBe("Tuesday and Wednesday have 3 open tasks. Move all to today, review them, or skip?");

        const moved = await call("caius_plan_apply", { date: "2026-12-10", catchup: "move_all", brief: prose });
        expect(moved.written.filter((w: any) => w.kind === "catchup").map((w: any) => w.id)).toEqual(expect.arrayContaining([ "c9" ]));
        expect((await call("caius_planday", { date: "2026-12-10", step: "catchup" })).data.tasks).toEqual([]);
    });

    it("looks back five workdays at most, and stops at a day with nothing live", async () => {
        for (const [ date, id ] of [ [ "2026-12-11", "x1" ], [ "2026-12-14", "x2" ], [ "2026-12-15", "x3" ], [ "2026-12-16", "x4" ], [ "2026-12-17", "x5" ], [ "2026-12-18", "x6" ] ]) {
            await task(date as string, id as string, `Task ${id}`);
        }
        at("2026-12-21T09:30");
        expect((await call("caius_planday", { date: "2026-12-21", step: "catchup" })).data.days).toEqual([ "2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17", "2026-12-18" ]);
    });
});
