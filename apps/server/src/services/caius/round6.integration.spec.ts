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
    + "<li>Location for the weather: 39.95, -75.17</li><li>Capacity: 180–240 work minutes a day, and 45–60 minutes in the evening.</li></ul>"
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

describe("a closed day's header", () => {
    it("Mon 2 Nov 17:30: the wind-down leaves the header as planned, so the headline names the tasks the drawing shows", async () => {
        const MON = "2028-11-06";
        calendars[MON] = [ event("10:00", "10:15", "Daily Standup"), event("11:00", "12:00", "Sprint Planning") ];
        await dayWith(MON, `<h2>☑️ Tasks</h2>${ul(
            li("m-101", `${zap("ZAP-601", "Verify the export retry on staging")} ~30m`),
            li("m-110", `${zap("ZAP-610", "Review the import mapper change")} ~30m`),
            li("m-111", `${zap("ZAP-611", "Check the invoice export in QA")} ~30m`)
        )}`);
        at(`${MON}T09:40`);
        const planned = await call("caius_plan_apply", { date: MON, said: "", brief: { headline: "ZAP-601 first, then ZAP-610 and ZAP-611.", acts: [
            { range: "", text: "ZAP-601, then ZAP-610." }, { range: "", text: "ZAP-611." }
        ], sections: [] } });
        expect(planned.skipped).toEqual([]);
        const header = await contentOf(planned.headerNoteId);
        const drawing = () => becca.getNote(planned.headerNoteId)?.getAttachments().find((a) => a.role === "image")?.getContent();
        const drawn = drawing();

        at(`${MON}T17:30`);
        const wound = await call("caius_winddown_apply", { date: MON, said: "610 is done", done: [ "610" ] });
        expect(wound.skipped).toEqual([]);
        expect(wound.written).not.toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "header", detail: MON }) ]));
        expect(await contentOf(planned.headerNoteId)).toBe(header);
        expect(drawing()).toEqual(drawn);
        expect(header).toContain("ZAP-601 first, then ZAP-610 and ZAP-611.");
        for (const key of [ "ZAP-601", "ZAP-610", "ZAP-611" ]) expect(String(drawn)).toContain(key);
        delete calendars[MON];
    });
});

describe("the evening", () => {
    const SUGGESTION = "Something away from screens, a chore or a Recharge item: because the evening has nothing planned (~45m)";
    const suggestedOf = async (date: string) => (await call("caius_plan", { period: "day", date })).suggested.map((t: any) => t.text);

    it("Wed 11 Nov: after a Review whose evening question went unsaid, the plan offers one Suggested evening item from the standing rule, once", async () => {
        const MON = "2028-11-13";
        const WED = "2028-11-15";
        calendars[WED] = [ event("14:00", "15:00", "Design Sync") ];
        await dayWith(MON, `<h2>☑️ Tasks</h2>${ul(li("n-dave", "Message Dave if he knows anyone who will hang lights as a small job"))}`);
        at(`${WED}T09:45`);
        // The round-6 calls: the three steps, then "carry it" with no evening answer.
        for (const step of [ "open", "next", "context" ]) await call("caius_winddown", { date: MON, step });
        const review = await call("caius_winddown_apply", { date: MON, said: "carry it" });
        expect(review.skipped).toEqual([]);
        const inputs = review.planday.inputs;
        expect(inputs.question).toBeNull();
        expect(inputs.data.candidates).toEqual([]);
        expect(inputs.data.evening).toEqual({ tasks: [], events: [], suggestion: SUGGESTION });

        const planned = await call("caius_plan_apply", { date: WED, said: "fine", asOffered: true, brief: { headline: "Message Dave, then Design Sync at 14:00.", acts: [
            { range: "10:00-14:00", text: "Message Dave about the lights." }, { range: "14:00-15:00", text: "Design Sync with Jordan." }
        ] } });
        expect(planned.skipped).toEqual([]);
        expect(planned.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "suggested", status: "written", text: SUGGESTION }) ]));
        expect(planned.say).toContain("Something away from screens");
        expect(await suggestedOf(WED)).toEqual([ SUGGESTION ]);

        // A refresh doesn't offer it again, and the step says so.
        at(`${WED}T11:05`);
        expect((await call("caius_planday", { date: WED, step: "inputs" })).data.evening.suggestion).toBeNull();
        await call("caius_plan_apply", { date: WED, said: "", brief: { headline: "Message Dave.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] } });
        expect(await suggestedOf(WED)).toEqual([ SUGGESTION ]);

        // Accepted with no section, it goes under the evening's heading, not his work list.
        const plan = await call("caius_plan", { period: "day", date: WED });
        const [ item ] = plan.suggested;
        await call("caius_accept", { items: [ { noteId: plan.noteId, listItemId: item.listItemId } ] });
        expect(await sectionsOf(WED)).toEqual({
            "☑️ Tasks": [ "Message Dave if he knows anyone who will hang lights as a small job" ],
            Evening: [ "Something away from screens, a chore or a Recharge item" ]
        });
        delete calendars[WED];
    });

    it("Thu 5 Nov: the evening asked last night and ignored is offered one Suggested item; an evening event or task, or a dismissal, keeps it off", async () => {
        const WED = "2029-01-17";
        const THU = "2029-01-18";
        await dayWith(WED, `<h2>☑️ Tasks</h2>${ul(li("t-dave", "Message Dave about the lights"), li("t-101", `${zap("ZAP-701", "Verify the export retry")} ~30m`))}`);
        at(`${WED}T17:45`);
        const next = await call("caius_winddown", { date: WED, step: "next" });
        expect(next.question).toBe("Anything for the evening?");
        const wound = await call("caius_winddown_apply", { date: WED, said: "101 is done", done: [ "701" ] });
        expect(wound.skipped).toEqual([]);

        at(`${THU}T09:30`);
        const inputs = await call("caius_planday", { date: THU, step: "inputs" });
        expect(inputs.question).toBeNull();
        expect(inputs.data.evening).toEqual({ tasks: [], events: [], suggestion: SUGGESTION });
        const planned = await call("caius_plan_apply", { date: THU, said: "", brief: { headline: "Message Dave.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] } });
        expect(planned.skipped).toEqual([]);
        expect(await suggestedOf(THU)).toEqual([ SUGGESTION ]);

        // Dismissed, it stays off the day.
        const plan = await call("caius_plan", { period: "day", date: THU });
        await call("caius_dismiss", { items: [ { noteId: plan.noteId, listItemId: plan.suggested[0].listItemId } ] });
        expect((await call("caius_planday", { date: THU, step: "inputs" })).data.evening.suggestion).toBeNull();
        await call("caius_plan_apply", { date: THU, said: "", brief: { headline: "Message Dave.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] } });
        expect(await suggestedOf(THU)).toEqual([]);
    });

    it("an evening with a calendar event, or a task he names in the reply, gets no suggestion", async () => {
        const MON = "2029-02-05";
        const TUE = "2029-02-06";
        calendars[MON] = [ event("19:00", "20:30", "Climbing gym") ];
        await dayWith(MON, `<h2>☑️ Tasks</h2>${ul(li("e-1", "Write the runbook ~30m"))}`);
        at(`${MON}T09:40`);
        const gym = await call("caius_planday", { date: MON, step: "inputs" });
        expect(gym.data.evening).toEqual({ tasks: [], events: [ "Climbing gym" ], suggestion: null });
        await call("caius_plan_apply", { date: MON, said: "", brief: { headline: "The runbook.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] } });
        expect(await suggestedOf(MON)).toEqual([]);

        await dayWith(TUE, `<h2>☑️ Tasks</h2>${ul(li("e-2", "Write the release note ~30m"))}`);
        at(`${TUE}T09:40`);
        const asked = await call("caius_planday", { date: TUE, step: "inputs" });
        expect(asked.question).toBe("Anything for the evening?");
        await call("caius_plan_apply", { date: TUE, said: "evening laundry", evening: [ "Laundry" ], brief: { headline: "The release note.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] } });
        expect(await suggestedOf(TUE)).toEqual([]);
        expect((await sectionsOf(TUE)).Evening).toEqual([ "Laundry" ]);
        delete calendars[MON];
    });
});
