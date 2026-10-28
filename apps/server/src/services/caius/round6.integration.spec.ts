/**
 * The week of the sixth normal-user simulation (T25, Mon 2 to Wed 11 Nov 2026), replayed through
 * the tools: each test follows a problem the round-6 report and transcripts show.
 */

import { dayCapacity } from "@triliumnext/caius";
import { becca, cls, sql_init } from "@triliumnext/core";
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
const zap = (key: string, title: string) => `<a href="https://example.atlassian.net/browse/${key}">${key}</a> ${title}`;

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Code Review", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2028-10-20T10:00:00.000-0400", ...o
});

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
const calendars: Record<string, CalendarEvent[]> = {};
const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return { date: input.date, jira, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const tools = createCaiusTools(undefined, async () => ({ code: 3, label: "Overcast" }), stubInputs);

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li>"
    + "<li>The day runs to bedtime, and the evening is planned too. Bedtime: 23:00. Evening: something away from screens, a chore or a Recharge item.</li>"
    + "<li>Location for the weather: 39.95, -75.17</li></ul>"
    + "<h2>Brief rules</h2><ul><li>Open time is work time.</li></ul>";

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

/** Sets the Caius clock. */
const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);

/** A day note holding `html`. */
const dayWith = (date: string, html: string) => cls.init(async () => {
    const day = await store.calendarDay(date);
    await store.putContent(day.noteId, html);
    return day.noteId;
});

const contentOf = (noteId: string) => cls.init(() => store.content(noteId));

/** The text of the day's tasks under each heading, in his order, with their states. */
async function sectionsOf(date: string) {
    const plan = await call("caius_plan", { period: "day", date });
    return Object.fromEntries(plan.sections.map((s: any) => [ s.name, s.tasks.map((t: any) => t.text.replace(/\s*\[from [^\]]*\]\([^)]*\)/g, "")) ]));
}

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay("2028-10-23"), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        await store.addLabel(createChildNote("root", "🧭 How I work", STANDING), "assistantContext", "");
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
    jira.handoff.length = 0;
    jira.asks.length = 0;
});

describe("the header's acts", () => {
    it("Wed 4 Nov: a long task is cut at a word with one ellipsis, in the acts and the drawing, never 'know….'", async () => {
        const WED = "2028-11-01";
        calendars[WED] = [ event("10:00", "10:15", "Daily Standup") ];
        await dayWith(WED, `<h2>☑️ Tasks</h2>${ul(
            li("w-dave", "Message Dave if he knows anyone who will hang lights as a small job"),
            li("w-111", `${zap("ZAP-611", "Check the invoice export in QA")} ~30m`)
        )}`);
        at(`${WED}T09:40`);
        const planned = await call("caius_plan_apply", { date: WED, said: "", brief: { headline: "Message Dave, then ZAP-611.", acts: [
            { range: "", text: "x" }, { range: "", text: "y" }
        ], sections: [] } });
        expect(planned.skipped).toEqual([]);
        const header = await contentOf(planned.headerNoteId);
        expect(header).toContain("<p>Message Dave if he…</p>");
        expect(header).not.toContain("….");
        expect(header).not.toMatch(/know…/);
        const svg = becca.getNote(planned.headerNoteId)?.getAttachments().find((a) => a.role === "image")?.getContent();
        expect(String(svg)).toContain("Message Dave if he…");
        expect(String(svg)).not.toMatch(/know…/);
        delete calendars[WED];
    });
});
