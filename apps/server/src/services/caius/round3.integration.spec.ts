/**
 * The week of the third normal-user simulation (T19, Mon 2 to Wed 11 Nov 2026), replayed through
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

const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Code Review", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-10-27T10:00:00.000-0400", ...o
});

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
const calendars: Record<string, CalendarEvent[]> = {};
const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date, jira, calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }),
        errors: []
    };
}

const tools = createCaiusTools(undefined, async () => ({ code: 3, label: "Overcast" }), stubInputs);

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li><li>Bedtime: 23:00.</li><li>Location for the weather: 39.95, -75.17</li></ul>"
    + "<h2>Brief rules</h2><ul><li>Open time is work time.</li></ul>";

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

/** Sets the Caius clock. */
const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

/** A brief's prose, as the agent writes it. */
const prose = { headline: "A light day", acts: [ { range: "10:00 to 12:00", text: "x" }, { range: "12:00 to 18:00", text: "y" }, { range: "Evening", text: "z" } ], sections: [] };

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        await store.addLabel(createChildNote("root", "🧭 How I work", STANDING), "assistantContext", "");
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("a Context line he gave is settled until the week boundary", () => {
    it("Mon 17:30 to Fri 17:20: 'ZAP-2590 is open' goes to Week 45 and no step asks about it until Friday's carry", async () => {
        at(`${MON}T17:30`);
        const monday = await call("caius_winddown_apply", { date: MON, context: [ "ZAP-2590 is open" ] });
        expect(monday.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "context", text: "ZAP-2590 is open", status: "written" }) ]));

        const unasked = (answer: any, when: string) => {
            expect(answer.question, when).toBeNull();
            expect(answer.data.carry ?? answer.data.noticed, when).toEqual([]);
        };
        at(`${TUE}T09:35`);
        const tuesday = await call("caius_planday", { date: TUE, step: "inputs", refresh: true });
        unasked(tuesday, "Tue 09:35");
        expect(tuesday.data.context.map((c: any) => c.text)).toEqual([ "ZAP-2590 is open" ]);
        await call("caius_plan_apply", { date: TUE, brief: prose });
        at(`${TUE}T11:05`);
        unasked(await call("caius_planday", { date: TUE, step: "inputs", refresh: true }), "Tue 11:05");
        at(`${WED}T09:40`);
        unasked(await call("caius_planday", { date: WED, step: "inputs", refresh: true }), "Wed 09:40");
        at(`${WED}T17:45`);
        unasked(await call("caius_winddown", { date: WED, step: "context" }), "Wed 17:45");
        at(`${THU}T09:30`);
        unasked(await call("caius_planday", { date: THU, step: "inputs", refresh: true }), "Thu 09:30");

        at(`${FRI}T17:20`);
        const friday = await call("caius_winddown", { date: FRI, step: "context" });
        expect(friday.data.noticed).toEqual([ expect.objectContaining({ kind: "carry", line: "ZAP-2590 is open" }) ]);
        expect(friday.question).toContain("Carry 'ZAP-2590 is open' into next week?");
    });
});
