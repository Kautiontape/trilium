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

describe("an act names a ticket by its whole key", () => {
    it("an act naming ZAP-811 doesn't name ZAP-81, so it keeps its words", async () => {
        const DAY = "2030-06-10";
        await dayWith(DAY, `<h2>☑️ Tasks</h2>${ul(li("k-811", `${zap("ZAP-811", "Verify the export retry")} ~30m`), li("k-81", `${zap("ZAP-81", "Tidy the board")} ~30m`))}`);
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, said: "", brief: { headline: "The export retry, then the board.", acts: [
            { range: "", text: "Verify the ZAP-811 export retry." }, { range: "", text: "Tidy the board on ZAP-81." }
        ] } });
        expect(planned.skipped).toEqual([]);
        const header = await contentOf(planned.headerNoteId);
        expect(header).toContain("<p>Verify the ZAP-811 export retry.</p>");
        expect(header).toContain("<p>Tidy the board on ZAP-81.</p>");
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
        expect(planned.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "suggested", status: "written", text: "Something away from screens, a chore or a Recharge item" }) ]));
        expect(planned.say).toBe("Something away from screens, a chore or a Recharge item is in Suggested, the meetings are updated and the brief is written.");
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

    it("the suggestion is offered once a day: accepted and ticked done, a later refresh offers it again nowhere", async () => {
        const DAY = "2030-06-12";
        await dayWith(DAY, `<h2>☑️ Tasks</h2>${ul(li("g-1", "Write the runbook ~30m"))}`);
        at(`${DAY}T09:40`);
        const brief = { headline: "The runbook.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] };
        await call("caius_plan_apply", { date: DAY, said: "", brief });
        let plan = await call("caius_plan", { period: "day", date: DAY });
        expect(plan.suggested.map((t: any) => t.text)).toEqual([ SUGGESTION ]);
        await call("caius_accept", { items: [ { noteId: plan.noteId, listItemId: plan.suggested[0].listItemId } ] });
        plan = await call("caius_plan", { period: "day", date: DAY });
        const accepted = plan.sections.flatMap((s: any) => s.tasks).find((t: any) => t.text.startsWith("Something"));
        await call("caius_set_state", { items: [ { noteId: plan.noteId, listItemId: accepted.listItemId, state: "done" } ] });

        at(`${DAY}T19:30`);
        expect((await call("caius_planday", { date: DAY, step: "inputs" })).data.evening.suggestion).toBeNull();
        await call("caius_plan_apply", { date: DAY, said: "", brief });
        expect(await suggestedOf(DAY)).toEqual([]);
    });

    it("'nothing for the evening' is an answer: no suggestion, in the plan's reply or the wind-down's the night before", async () => {
        const DAY = "2030-06-13";
        await dayWith(DAY, `<h2>☑️ Tasks</h2>${ul(li("h-1", "Write the runbook ~30m"))}`);
        at(`${DAY}T09:40`);
        const brief = { headline: "The runbook.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] };
        const planned = await call("caius_plan_apply", { date: DAY, said: "nothing for the evening", evening: [], eveningAnswered: true, brief });
        expect(planned.skipped).toEqual([]);
        expect(planned.say).not.toContain("Suggested");
        expect(await suggestedOf(DAY)).toEqual([]);
        expect((await call("caius_planday", { date: DAY, step: "inputs" })).data.evening.suggestion).toBeNull();

        const MON = "2030-06-17";
        const TUE = "2030-06-18";
        await dayWith(MON, `<h2>☑️ Tasks</h2>${ul(li("h-2", "Write the release note ~30m"))}`);
        at(`${MON}T17:30`);
        expect((await call("caius_winddown_apply", { date: MON, said: "done. nothing tomorrow evening", done: [ "h-2" ], evening: [], eveningAnswered: true })).skipped).toEqual([]);
        at(`${TUE}T09:40`);
        expect((await call("caius_planday", { date: TUE, step: "inputs" })).data.evening.suggestion).toBeNull();
        await call("caius_plan_apply", { date: TUE, said: "", brief });
        expect(await suggestedOf(TUE)).toEqual([]);
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

describe("a stale errand", () => {
    const DAVE = "Message Dave if he knows anyone who will hang lights as a small job";
    const textsOf = async (period: "day" | "month", date: string) => (await call("caius_plan", { period, date })).sections
        .flatMap((s: any) => s.tasks).map((t: any) => ({ text: t.text.replace(/\s*(?:\[from [^\]]*\]\([^)]*\)|_scheduled \[[^\]]*\]\([^)]*\)_)/g, ""), state: t.state }));
    /** Dave on `days[0]`, forwarded by three wind-downs, so the fourth day's wind-down offers the park. */
    const carriedThrice = async (days: string[]) => {
        await dayWith(days[0] ?? "", `<h2>☑️ Tasks</h2>${ul(li(`d-${days[0]}`, DAVE))}`);
        for (const day of days.slice(0, 3)) {
            at(`${day}T17:30`);
            expect((await call("caius_winddown_apply", { date: day, said: "" })).skipped).toEqual([]);
        }
    };
    const fatesOf = (result: any) => result.written.filter((entry: any) => entry.kind === "fate").map((entry: any) => entry.detail);

    it("a bare yes with a candidate on offer too is a check and writes nothing; asOffered takes the candidate and the item goes on", async () => {
        const days = [ "2030-04-01", "2030-04-02", "2030-04-03", "2030-04-04", "2030-04-05" ];
        const [ , , , THU, FRI ] = days as [ string, string, string, string, string ];
        await carriedThrice(days);
        jira.handoff.push({ ...ticket("ZAP-901", { summary: "Check the invoice export in QA", status: "QA Testing" }), daysInStatus: 3 });
        at(`${THU}T17:30`);
        expect((await call("caius_winddown", { date: THU, step: "open" })).question).toContain("Park it in April?");
        expect((await call("caius_winddown", { date: THU, step: "next" })).data.candidates.map((c: any) => c.candidateId)).toEqual([ "ZAP-901" ]);
        const checked = await call("caius_winddown_apply", { date: THU, said: "yes" });
        expect(checked.check).toEqual([ expect.objectContaining({ missing: "asOffered", message: "His reply reads as a yes to what was offered. Pass `asOffered: true`, or the specific fields." }) ]);
        expect(checked.written).toEqual([]);
        expect(await textsOf("day", FRI)).toEqual([]);
        expect(await textsOf("month", "2030-04")).toEqual([]);

        const result = await call("caius_winddown_apply", { date: THU, said: "yes", asOffered: true });
        expect(result.skipped).toEqual([]);
        expect(fatesOf(result)).toEqual([ FRI ]);
        expect(await textsOf("month", "2030-04")).toEqual([]);
        expect((await textsOf("day", FRI)).map((task: any) => task.text)).toEqual([ DAVE, expect.stringContaining("ZAP-901") ]);
        expect((await call("caius_plan", { period: "day", date: FRI })).suggested).toEqual([]);
    });

    it("his yes to the park with the month fate in the call parks the item and takes no candidate", async () => {
        const days = [ "2030-08-05", "2030-08-06", "2030-08-07", "2030-08-08", "2030-08-09" ];
        const [ , , , THU, FRI ] = days as [ string, string, string, string, string ];
        await carriedThrice(days);
        jira.handoff.push({ ...ticket("ZAP-961", { summary: "Check the invoice export", status: "QA Testing" }), daysInStatus: 3 });
        at(`${THU}T17:30`);
        const open = await call("caius_winddown", { date: THU, step: "open" });
        const dave = open.data.items.find((item: any) => item.text.startsWith("Message Dave"));
        expect((await call("caius_winddown", { date: THU, step: "next" })).data.candidates.map((c: any) => c.candidateId)).toEqual([ "ZAP-961" ]);
        const result = await call("caius_winddown_apply", { date: THU, said: "yes", fates: [ { listItemId: dave.ref, to: dave.park.month } ] });
        expect(result.check).toBeUndefined();
        expect(result.written.map((entry: any) => entry.kind)).not.toContain("accept");
        expect(fatesOf(result)).toEqual([ "2030-08" ]);
        expect(await textsOf("day", FRI)).toEqual([]);
        expect(await textsOf("month", "2030-08")).toEqual([ { text: DAVE, state: "open" } ]);
    });

    it("asOffered takes no candidate the call itself calls finished", async () => {
        const DAY = "2030-09-02";
        await dayWith(DAY, `<h2>☑️ Tasks</h2>${ul(li("f-1", "Write the release note ~30m"))}`);
        jira.handoff.push(
            { ...ticket("ZAP-971", { summary: "Check the import", status: "QA Testing" }), daysInStatus: 3 },
            { ...ticket("ZAP-972", { summary: "Check the export", status: "QA Testing" }), daysInStatus: 3 }
        );
        at(`${DAY}T17:30`);
        await call("caius_winddown", { date: DAY, step: "open" });
        expect((await call("caius_winddown", { date: DAY, step: "next" })).data.candidates.map((c: any) => c.candidateId)).toEqual([ "ZAP-971", "ZAP-972" ]);
        const result = await call("caius_winddown_apply", { date: DAY, said: "971 is finished, the rest is fine", finished: [ "ZAP-971" ], asOffered: true });
        expect(result.skipped).toEqual([]);
        expect(result.written.filter((entry: any) => entry.kind === "accept").map((entry: any) => entry.id)).toEqual([ "ZAP-972" ]);
        expect((await textsOf("day", "2030-09-03")).map((task: any) => task.text)).toEqual([ "Write the release note", expect.stringContaining("ZAP-972") ]);
    });

    it("a bare yes with only the park on offer and no fate in the call is a check; checked, the item takes its proposed fate", async () => {
        const days = [ "2030-07-01", "2030-07-02", "2030-07-03", "2030-07-04", "2030-07-05" ];
        const [ , , , THU, FRI ] = days as [ string, string, string, string, string ];
        await carriedThrice(days);
        at(`${THU}T17:30`);
        expect((await call("caius_winddown", { date: THU, step: "open" })).question).toContain("Park it in July?");
        const checked = await call("caius_winddown_apply", { date: THU, said: "yes" });
        expect(checked.check).toEqual([ expect.objectContaining({ missing: "asOffered" }) ]);
        expect(checked.written).toEqual([]);
        expect(await textsOf("day", FRI)).toEqual([]);
        const result = await call("caius_winddown_apply", { date: THU, said: "yes", checked: true });
        expect(result.skipped).toEqual([]);
        expect(fatesOf(result)).toEqual([ FRI ]);
        expect(await textsOf("month", "2030-07")).toEqual([]);
    });

    it("'sure, park it' with two items on offer and neither named nor given its fate is a check naming both", async () => {
        const days = [ "2030-10-07", "2030-10-08", "2030-10-09", "2030-10-10", "2030-10-11" ];
        const [ , , , THU, FRI ] = days as [ string, string, string, string, string ];
        const BULBS = "Order the spare bulbs for the porch";
        await dayWith(days[0] ?? "", `<h2>☑️ Tasks</h2>${ul(li("two-dave", DAVE), li("two-bulbs", BULBS))}`);
        for (const day of days.slice(0, 3)) {
            at(`${day}T17:30`);
            expect((await call("caius_winddown_apply", { date: day, said: "" })).skipped).toEqual([]);
        }
        at(`${THU}T17:30`);
        const open = await call("caius_winddown", { date: THU, step: "open" });
        expect(open.data.items.filter((item: any) => item.park).length).toBe(2);
        const result = await call("caius_winddown_apply", { date: THU, said: "sure, park it" });
        expect(result.check?.map((entry: any) => ({ item: entry.item, missing: entry.missing }))).toEqual([ { item: DAVE, missing: "fate" }, { item: BULBS, missing: "fate" } ]);
        expect(result.written).toEqual([]);
        expect(await textsOf("day", FRI)).toEqual([]);
        expect(await textsOf("month", "2030-10")).toEqual([]);
    });

    it("asOffered doesn't park: a park needs his month fate", async () => {
        const days = [ "2030-06-03", "2030-06-04", "2030-06-05", "2030-06-06", "2030-06-07" ];
        const [ , , , THU, FRI ] = days as [ string, string, string, string, string ];
        await carriedThrice(days);
        at(`${THU}T17:30`);
        expect((await call("caius_winddown", { date: THU, step: "open" })).question).toContain("Park it in June?");
        const result = await call("caius_winddown_apply", { date: THU, said: "fine", asOffered: true });
        expect(result.skipped).toEqual([]);
        expect(fatesOf(result)).toEqual([ FRI ]);
        expect(await textsOf("month", "2030-06")).toEqual([]);
    });

    it("a bare yes with an overlap asked too is a check and parks nothing", async () => {
        const days = [ "2030-05-06", "2030-05-07", "2030-05-08", "2030-05-09", "2030-05-10" ];
        const [ , , , THU, FRI ] = days as [ string, string, string, string, string ];
        await carriedThrice(days);
        calendars[FRI] = [ event("10:30", "11:30", "Incident Review"), event("11:00", "12:00", "Vendor Onboarding") ];
        at(`${THU}T17:30`);
        expect((await call("caius_winddown", { date: THU, step: "next" })).question).toContain("Incident Review overlaps Vendor Onboarding");
        const result = await call("caius_winddown_apply", { date: THU, said: "yes" });
        expect(result.check).toEqual([ expect.objectContaining({ missing: "asOffered" }) ]);
        expect(result.written).toEqual([]);
        expect(await textsOf("day", FRI)).toEqual([]);
        expect(await textsOf("month", "2030-05")).toEqual([]);
        delete calendars[FRI];
    });


    it("'Message Dave' forwarded from Mon 26 Oct: from its third forward the open step asks to park it in the month; it never parks unasked", async () => {
        const days = [ "2029-04-02", "2029-04-03", "2029-04-04", "2029-04-05", "2029-04-06" ];
        const [ MON, TUE, WED, THU, FRI ] = days as [ string, string, string, string, string ];
        await dayWith(MON, `<h2>☑️ Tasks</h2>${ul(li("s-dave", DAVE))}`);
        const daveOf = (open: any) => open.data.items.find((item: any) => item.text.startsWith("Message Dave"));
        for (const day of [ MON, TUE, WED ]) {
            at(`${day}T17:30`);
            const open = await call("caius_winddown", { date: day, step: "open" });
            expect(daveOf(open).park).toBeUndefined();
            expect(open.question).not.toContain("Park");
            expect((await call("caius_winddown_apply", { date: day, said: "" })).skipped).toEqual([]);
        }

        // Thursday: forwarded on Mon, Tue and Wed. The park is asked; its fate stays the next workday.
        at(`${THU}T17:30`);
        const thu = await call("caius_winddown", { date: THU, step: "open" });
        expect(daveOf(thu)).toMatchObject({ forwarded: 3, park: { month: "2029-04", monthLabel: "April 2029" }, fate: { forward: FRI } });
        expect(thu.question).toContain(`'${DAVE}' has been carried 3 times. Park it in April?`);
        expect((await call("caius_winddown_apply", { date: THU, said: "carry it" })).skipped).toEqual([]);
        expect(await textsOf("day", FRI)).toEqual([ { text: DAVE, state: "open" } ]);

        // Friday: "park it" without the fate is a check; his yes parks it as the month fate the call passes.
        at(`${FRI}T17:30`);
        const fri = await call("caius_winddown", { date: FRI, step: "open" });
        expect(daveOf(fri)).toMatchObject({ forwarded: 4, park: { month: "2029-04" } });
        const checked = await call("caius_winddown_apply", { date: FRI, said: "park it" });
        expect(checked.check).toEqual([ expect.objectContaining({ missing: "fate", item: DAVE }) ]);
        expect(await textsOf("day", FRI)).toEqual([ { text: DAVE, state: "open" } ]);
        const parked = await call("caius_winddown_apply", { date: FRI, said: "yes", fates: [ { listItemId: daveOf(fri).ref, to: "2029-04" } ] });
        expect(parked.skipped).toEqual([]);
        expect(parked.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "fate", detail: "2029-04" }) ]));
        expect(await textsOf("month", "2029-04")).toEqual([ { text: DAVE, state: "open" } ]);
        expect((await call("caius_plan", { period: "day", date: "2029-04-09" })).sections.flatMap((s: any) => s.tasks)).toEqual([]);
    });

    it("the plan's top pick is work when his list has work: a chore or a ticketless personal item never leads it", async () => {
        const DAY = "2029-05-07";
        await dayWith(DAY, `<h2>☑️ Tasks</h2><h3>Home</h3>${ul(li("p-dave", "Message Dave about the lights"))}<h3>Chores</h3>${ul(li("p-bins", "Take the bins out"))}`
            + `<h3>Work</h3>${ul(li("p-801", `${zap("ZAP-801", "Verify the export retry")} ~30m`), li("p-802", `${zap("ZAP-802", "Check the invoice export")} ~30m`))}`);
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, said: "", brief: { headline: "Verify the export retry, then the invoice check.", acts: [
            { range: "", text: "x" }, { range: "", text: "y" }
        ] } });
        expect(planned.skipped).toEqual([]);
        expect(planned.topPick).toContain("ZAP-801");
        const brief = await contentOf(planned.briefNoteId);
        expect(brief.indexOf("ZAP-801")).toBeLessThan(brief.indexOf("Message Dave"));
    });

    it("a task with a ticket is work under any heading: ZAP-821 under Admin chores stays the top pick", async () => {
        const DAY = "2030-06-11";
        await dayWith(DAY, `<h2>☑️ Tasks</h2><h3>Admin chores</h3>${ul(li("c-821", `${zap("ZAP-821", "Submit the expense report")} ~15m`))}`
            + `<h3>Work</h3>${ul(li("c-822", `${zap("ZAP-822", "Fix the export retry")} ~30m`))}`);
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, said: "", brief: { headline: "Expense report on ZAP-821, then the export retry.", acts: [
            { range: "", text: "x" }, { range: "", text: "y" }
        ] } });
        expect(planned.topPick).toContain("ZAP-821");
    });

    it("the agent's headline is written as sent, an evening task's words in it or not", async () => {
        const DAY = "2029-05-08";
        const HEADLINE = "Call Jordan about the ZAP-811 export retry first.";
        await dayWith(DAY, `<h2>☑️ Tasks</h2>${ul(li("q-801", `${zap("ZAP-811", "Verify the export retry")} ~30m`))}<h3>Evening</h3>${ul(li("q-mom", "Call Mom about the flights"))}`);
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, said: "", brief: { headline: HEADLINE, acts: [
            { range: "", text: "x" }, { range: "", text: "y" }
        ] } });
        expect(planned.headline).toBe(HEADLINE);
        expect(await contentOf(planned.headerNoteId)).toContain(`<h2>${HEADLINE}</h2>`);
    });
});

describe("a candidate the call itself names", () => {
    const brief = { headline: "The runbook.", acts: [ { range: "", text: "x" }, { range: "", text: "y" } ] };
    const kindsOf = (result: any, kind: string) => result.written.filter((entry: any) => entry.kind === kind).map((entry: any) => entry.id);
    const openOn = async (date: string) => (await call("caius_plan", { period: "day", date })).sections.flatMap((s: any) => s.tasks)
        .filter((task: any) => task.state === "open").map((task: any) => task.text);

    it("Plan my day's asOffered takes no candidate the call calls finished", async () => {
        const DAY = "2031-06-02";
        await dayWith(DAY, `<h2>☑️ Tasks</h2>${ul(li("q7-1", "Write the runbook ~30m"))}`);
        jira.handoff.push(
            { ...ticket("ZAP-975", { summary: "Ship the fix", status: "QA Testing" }), daysInStatus: 2 },
            { ...ticket("ZAP-976", { summary: "Check the gate", status: "QA Testing" }), daysInStatus: 2 }
        );
        at(`${DAY}T09:40`);
        expect((await call("caius_planday", { date: DAY, step: "inputs" })).data.candidates.map((c: any) => c.candidateId)).toEqual([ "ZAP-975", "ZAP-976" ]);
        const planned = await call("caius_plan_apply", { date: DAY, said: "975 is already done, rest fine", asOffered: true, finished: [ "ZAP-975" ], brief });
        expect(planned.check).toBeUndefined();
        expect(kindsOf(planned, "accept")).toEqual([ "ZAP-976" ]);
        expect(kindsOf(planned, "finished")).toEqual([ "ZAP-975" ]);
        const open = await openOn(DAY);
        expect(open).toEqual([ "Write the runbook", expect.stringContaining("ZAP-976") ]);
        expect(open.some((text: string) => text.includes("ZAP-975"))).toBe(false);
    });
});
