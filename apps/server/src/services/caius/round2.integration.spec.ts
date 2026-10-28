/**
 * The week of the second normal-user simulation (T16, Mon 2 to Mon 9 Nov 2026), replayed through
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

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

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
