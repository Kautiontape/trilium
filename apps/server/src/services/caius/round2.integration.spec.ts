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
