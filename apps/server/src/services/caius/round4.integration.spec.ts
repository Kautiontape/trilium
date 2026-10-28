/**
 * The week of the fourth normal-user simulation (T21, Mon 2 to Wed 11 Nov 2026), replayed through
 * the tools: each test follows one of the answers the apply tools read wrong there.
 */

import { dayCapacity } from "@triliumnext/caius";
import { becca, cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs, JiraTicket } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { refOf } from "./refs.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const zap = (key: string, title: string) => `<a href="https://example.atlassian.net/browse/${key}">${key}</a> ${title}`;

const MON = "2026-11-02";
const WED = "2026-11-04";
const THU = "2026-11-05";

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Code Review", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-10-27T10:00:00.000-0400", ...o
});

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return { date: input.date, jira, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
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

/** The day's tasks in his order, each as its plain text with its state. */
async function tasksOf(date: string) {
    const plan = await call("caius_plan", { period: "day", date });
    return plan.sections.flatMap((s: any) => s.tasks).map((t: any) => ({
        text: t.text.replace(/\s*(?:\[from [^\]]*\]\([^)]*\)|_scheduled \[[^\]]*\]\([^)]*\)_)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
        state: t.state
    }));
}

/** Monday 2 Nov's Jira: three hand-offs and Jordan's ask on ZAP-105 from Sunday. */
function mondayJira() {
    jira.handoff.push(
        { ...ticket("ZAP-110", { summary: "Review the importer", status: "Code Review" }), daysInStatus: 2 },
        { ...ticket("ZAP-111", { summary: "Check the invoice export in QA", status: "QA Testing" }), daysInStatus: 3 },
        { ...ticket("ZAP-101", { summary: "Verify the export retry on staging", status: "Dev Verify" }), daysInStatus: 6 }
    );
    jira.asks.push({
        ticket: ticket("ZAP-105", { summary: "Confirm the staging bucket name" }), author: "Jordan Placeholder", created: "2026-11-01T15:00:00.000-0500",
        commentId: "c105", excerpt: "@Sam Example the rollout note is in the runbook now."
    });
}

/** The labels of `name` on the day note of `date`. */
async function labelsOf(date: string, name: string) {
    const [ note ] = await cls.init(() => store.search(`#dateNote="${date}"`));
    return note?.attributes.filter((a) => a.type === "label" && a.name === name).map((a) => a.value) ?? [];
}

/** Wednesday 4 Nov as it stood at 17:45: two tickets, the Dave message and the gym bag. */
async function wednesday(date = WED) {
    await cls.init(async () => {
        const day = await store.calendarDay(date);
        await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(
            li(`${date}-111`, `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`),
            li(`${date}-101`, `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`),
            li(`${date}-dave`, "Message Dave if he knows anyone who will hang lights as a small job")
        )}<h3>Evening</h3>${ul(li(`${date}-bag`, "Pack the climbing gym bag"))}`);
    });
}

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
    jira.handoff.length = 0;
    jira.asks.length = 0;
});

describe("reorder after the plan", () => {
    it("Mon 09:40 'take 110, 111 and 101', then 'put 101 first': the move-only call reorders his list and rewrites only the header", async () => {
        mondayJira();
        at(`${MON}T09:40`);
        const planned = await call("caius_plan_apply", { date: MON, accept: [ { candidateId: "110" }, { candidateId: "111" }, { candidateId: "101" } ], brief: prose });
        expect(planned.skipped).toEqual([]);
        const brief = await cls.init(() => store.content(planned.briefNoteId));
        const asked = await labelsOf(MON, "caiusAsked");
        const drawing = () => String(cls.init(() => becca.getNoteOrThrow(planned.headerNoteId).getAttachments().find((a) => a.title === "terrain.svg")?.getContent()));
        expect(drawing().indexOf("ZAP-110")).toBeLessThan(drawing().indexOf("ZAP-101"));

        at(`${MON}T09:41`);
        const moved = await call("caius_plan_apply", { date: MON, move: [ { listItemId: "101", first: true } ] });
        expect(moved.skipped).toEqual([]);
        expect(moved.written).toEqual([
            expect.objectContaining({ kind: "move", status: "written", detail: "first" }),
            expect.objectContaining({ kind: "header" })
        ]);
        expect(moved.say).toBe("ZAP-101 is first.");
        expect((await tasksOf(MON)).map((task: any) => task.text)).toEqual([ "ZAP-101 Verify the export retry on staging", "ZAP-110 Review the importer", "ZAP-111 Check the invoice export in QA" ]);
        // Nothing else: the brief, the questions answered and Suggested are as the plan left them.
        expect(await cls.init(() => store.content(planned.briefNoteId))).toBe(brief);
        expect(await labelsOf(MON, "caiusAsked")).toEqual(asked);
        const plan = await call("caius_plan", { period: "day", date: MON });
        expect(plan.suggested.map((task: any) => task.text)).toEqual([ expect.stringContaining("ZAP-105") ]);
        // The picks changed, so the header's drawing leads with ZAP-101, and his acts stay.
        expect(drawing().indexOf("ZAP-101")).toBeLessThan(drawing().indexOf("ZAP-110"));
        expect(await cls.init(() => store.content(planned.headerNoteId))).toContain("<strong>10:00 to 12:00</strong>");

        const again = await call("caius_plan_apply", { date: MON, move: [ { listItemId: "101", first: true } ] });
        expect(again.written).toEqual([ expect.objectContaining({ kind: "move", status: "unchanged" }) ]);

        // Monday's tickets are closed, so the later tests' days don't find them open.
        const ids = plan.sections.flatMap((section: any) => section.tasks).map((task: any) => ({ noteId: plan.noteId, listItemId: task.listItemId, state: "done" }));
        await call("caius_set_state", { items: ids });
    });
});

describe("short references", () => {
    it("every item a step shows carries a ref: open items, candidates, his list, Context lines and days", async () => {
        await wednesday("2026-11-11");
        jira.handoff.push({ ...ticket("ZAP-140"), daysInStatus: 2 });
        at("2026-11-11T17:45");
        const open = await call("caius_winddown", { date: "2026-11-11", step: "open" });
        const ids = [ "111", "101", "dave", "bag" ].map((id) => `2026-11-11-${id}`);
        expect(open.data.items.map((item: any) => item.ref)).toEqual(ids.map((id) => refOf("o", id)));
        expect(open.data.days[0]).toEqual(expect.objectContaining({ ref: "d1", date: "2026-11-12", dateLabel: "Thu 12 Nov" }));
        const next = await call("caius_winddown", { date: "2026-11-11", step: "next" });
        expect(next.data.candidates).toEqual([ expect.objectContaining({ ref: refOf("c", "ZAP-140"), candidateId: "ZAP-140" }) ]);

        at("2026-11-11T09:40");
        const inputs = await call("caius_planday", { date: "2026-11-11", step: "inputs", refresh: true });
        expect(inputs.data.list.map((item: any) => item.ref)).toEqual(ids.map((id) => refOf("l", id)));
        expect(inputs.data.candidates[0]).toEqual(expect.objectContaining({ ref: refOf("c", "ZAP-140"), candidateId: "ZAP-140" }));
        expect(inputs.data.days[0]).toEqual(expect.objectContaining({ ref: "d1", date: "2026-11-12" }));
    });

    it("Wed 17:45 '111, 101 and the bag are done, dave tomorrow': names resolve to the three open items, and a ref to a day", async () => {
        await wednesday();
        at(`${WED}T17:45`);
        const applied = await call("caius_winddown_apply", { date: WED, done: [ "111", "ZAP-101", "the bag" ], fates: [ { listItemId: refOf("o", `${WED}-dave`), to: "d1" } ] });
        expect(applied.skipped).toEqual([]);
        expect(await tasksOf(WED)).toEqual([
            { text: "ZAP-111 Check the invoice export in QA", state: "done" },
            { text: "ZAP-101 Verify the export retry on staging", state: "done" },
            { text: "Message Dave if he knows anyone who will hang lights as a small job", state: expect.not.stringMatching(/^open$/) },
            { text: "Pack the climbing gym bag", state: "done" }
        ]);
        expect(await tasksOf(THU)).toEqual([ { text: "Message Dave if he knows anyone who will hang lights as a small job", state: "open" } ]);
    });

    it("a name that matches more than one item is skipped as ambiguous, listing the matches, and nothing is written for those items", async () => {
        await wednesday("2026-11-18");
        at("2026-11-18T17:45");
        const applied = await call("caius_winddown_apply", { date: "2026-11-18", done: [ "the export" ], fates: [ { listItemId: "the export", to: "d1" } ] });
        expect(applied.skipped).toEqual([
            { kind: "done", text: "the export", reason: "ambiguous", detail: "ZAP-111 Check the invoice export in QA; ZAP-101 Verify the export retry on staging" },
            { kind: "fate", text: "the export", reason: "ambiguous", detail: "ZAP-111 Check the invoice export in QA; ZAP-101 Verify the export retry on staging" }
        ]);
        // Both stay open where they are; only Dave and the bag take their proposed fate.
        expect((await tasksOf("2026-11-18")).slice(0, 2)).toEqual([
            { text: "ZAP-111 Check the invoice export in QA", state: "open" },
            { text: "ZAP-101 Verify the export retry on staging", state: "open" }
        ]);
        expect((await tasksOf("2026-11-19")).map((task: any) => task.text).join()).not.toContain("ZAP-1");
        expect(applied.say).toBe("Message Dave if he knows anyone who will hang lights as a small job and Pack the climbing gym bag moved to Thu 19 Nov. "
            + "Which export: ZAP-111 or ZAP-101?");
    });

    it("Plan my day takes refs and names anywhere it takes an id: a candidate, a place on his list and a move", async () => {
        const DAY = "2026-11-23";
        jira.handoff.push({ ...ticket("ZAP-150", { summary: "Check the report" }), daysInStatus: 2 }, { ...ticket("ZAP-151", { summary: "Fix the gate" }), daysInStatus: 2 });
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("p-memo", "Write the memo ~30m"), li("p-desk", "Tidy the desk ~30m"))}`);
        });
        at(`${DAY}T09:40`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(inputs.data.candidates.map((c: any) => [ c.ref, c.candidateId ])).toEqual([ [ refOf("c", "ZAP-150"), "ZAP-150" ], [ refOf("c", "ZAP-151"), "ZAP-151" ] ]);
        const applied = await call("caius_plan_apply", {
            date: DAY, accept: [ { candidateId: refOf("c", "ZAP-151"), after: "memo" }, { candidateId: "150" } ], move: [ { listItemId: refOf("l", "p-desk"), first: true } ], brief: prose
        });
        expect(applied.skipped).toEqual([]);
        expect((await tasksOf(DAY)).map((task: any) => task.text)).toEqual([ "Tidy the desk", "Write the memo", "ZAP-151 Fix the gate", "ZAP-150 Check the report" ]);
    });
});

describe("'done' means done", () => {
    it("Wed 17:45 '111, 101 and the bag are done': keys in finished that are open items are ticked and recorded, and the bag's text is a done answer", async () => {
        await wednesday("2026-12-02");
        at("2026-12-02T17:45");
        const applied = await call("caius_winddown_apply", {
            date: "2026-12-02", done: [], finished: [ "ZAP-111", "ZAP-101", "the gym bag" ], fates: [],
            context: [ "Taking Incident Review over Vendor Onboarding at 11:00" ], evening: [ "Laundry" ]
        });
        expect(applied.skipped).toEqual([]);
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "done", id: "2026-12-02-111", status: "written" }),
            expect.objectContaining({ kind: "done", id: "2026-12-02-101", status: "written" }),
            expect.objectContaining({ kind: "done", id: "2026-12-02-bag", status: "written" }),
            expect.objectContaining({ kind: "finished", id: "ZAP-111" }),
            expect.objectContaining({ kind: "finished", id: "ZAP-101" })
        ]));
        // Only Dave goes on to Thursday, with the evening's Laundry.
        expect(await tasksOf("2026-12-03")).toEqual([
            { text: "Message Dave if he knows anyone who will hang lights as a small job", state: "open" },
            { text: "Laundry", state: "open" }
        ]);
    });

    it("Thu 09:30 '111 and 101 were done yesterday': Plan my day ticks the list items that finished keys name, and the picks leave them out", async () => {
        const DAY = "2026-12-10";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(
                li("t111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`),
                li("t101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`),
                li("tdave", "Message Dave about the lights")
            )}<h3>Evening</h3>${ul(li("tbag", "Pack the climbing gym bag"))}`);
        });
        at(`${DAY}T09:30`);
        const applied = await call("caius_plan_apply", { date: DAY, finished: [ "ZAP-111", "ZAP-101", "bag" ], brief: prose });
        expect(applied.skipped).toEqual([]);
        expect((await tasksOf(DAY)).map((task: any) => task.state)).toEqual([ "done", "done", "open", "done" ]);
        expect(applied.topPick).toBe("Message Dave about the lights");
    });
});

describe("the result is the recap", () => {
    it("Wed 17:45: say tells what was ticked, moved and added, with no ids, and names a skip in a clause", async () => {
        await wednesday("2026-12-16");
        at("2026-12-16T17:45");
        const applied = await call("caius_winddown_apply", {
            date: "2026-12-16", done: [ "111", "101", "the bag", "groceries" ], fates: [ { listItemId: "dave", to: "d1" } ], evening: [ "Water the plants" ]
        });
        expect(applied.say).toBe("ZAP-111, ZAP-101 and Pack the climbing gym bag are done, "
            + "Message Dave if he knows anyone who will hang lights as a small job moved to Thu 17 Dec and Water the plants is on Thursday evening. "
            + "'groceries' wasn't found.");
        expect(applied.say).not.toMatch(/2026-12-16-|\b[ocl]\d\b|\d{4}-\d{2}-\d{2}/);
    });

    it("Plan my day: say names what the plan wrote", async () => {
        const DAY = "2026-12-21";
        jira.handoff.push({ ...ticket("ZAP-160", { summary: "Check the report" }), daysInStatus: 2 }, { ...ticket("ZAP-161", { summary: "Fix the gate" }), daysInStatus: 2 });
        at(`${DAY}T09:40`);
        const applied = await call("caius_plan_apply", { date: DAY, accept: [ { candidateId: "161" } ], brief: prose });
        expect(applied.say).toBe("ZAP-161 is on your list, ZAP-160 is in Suggested and the brief is written.");
    });
});

describe("a question answered once stays answered", () => {
    const EVENING = "Anything for the evening?";
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

    it("Tue 09:35 then 11:05: the plan asks about the evening, and the refresh doesn't ask again, in that conversation or a later one", async () => {
        const DAY = "2027-01-12";
        at(`${DAY}T09:35`);
        expect((await call("caius_planday", { date: DAY, step: "inputs", refresh: true })).question).toContain(EVENING);
        await call("caius_plan_apply", { date: DAY, brief: prose });
        expect(await labelsOf(DAY, "caiusAsked")).toContain("evening");

        at(`${DAY}T11:05`);
        calendars[DAY] = [ event("15:00", "16:00", "Customer Call") ];
        const refresh = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(refresh.question).toBeNull();
        expect(refresh.data.headsUp).toEqual([]);
        delete calendars[DAY];
    });

    it("Mon 17:30: the wind-down asks about Tuesday's evening, so Tuesday's plan doesn't", async () => {
        at("2027-01-04T17:30");
        expect((await call("caius_winddown", { date: "2027-01-04", step: "next" })).question).toContain(EVENING);
        await call("caius_winddown_apply", { date: "2027-01-04", evening: [ "Pack the climbing gym bag" ] });
        at("2027-01-05T09:35");
        expect((await call("caius_planday", { date: "2027-01-05", step: "inputs", refresh: true })).question).toBeNull();
    });

    it("Wed 11 09:45: the Review of Monday asks about Wednesday's evening once, and the plan after it doesn't", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2027-01-18");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("m-dave", "Message Dave about the lights"))}<h3>Evening</h3>${ul(li("m-groc", "Groceries"))}`);
        });
        at("2027-01-20T09:45");
        const next = await call("caius_winddown", { date: "2027-01-18", step: "next" });
        expect(next.question).toContain(EVENING);
        await call("caius_winddown_apply", { date: "2027-01-18", done: [ "groceries" ] });
        const inputs = await call("caius_planday", { date: "2027-01-20", step: "inputs", refresh: true });
        expect(inputs.question).toBeNull();
    });

    it("Wed 17:45: an overlap on Thursday asked in the wind-down isn't asked again in Thursday's plan", async () => {
        const THURSDAY = "2027-01-28";
        calendars[THURSDAY] = [ event("11:00", "12:00", "Incident Review"), event("11:00", "11:30", "Vendor Onboarding") ];
        at("2027-01-27T17:45");
        expect((await call("caius_winddown", { date: "2027-01-27", step: "next" })).question).toContain("Incident Review overlaps Vendor Onboarding");
        await call("caius_winddown_apply", { date: "2027-01-27", context: [ "Taking Incident Review over Vendor Onboarding at 11:00" ] });
        at(`${THURSDAY}T09:30`);
        const inputs = await call("caius_planday", { date: THURSDAY, step: "inputs", refresh: true });
        expect(inputs.data.overlaps).toEqual([]);
        expect(inputs.question).toBeNull();
        delete calendars[THURSDAY];
    });
});

describe("review continues", () => {
    it("Wed 11 09:45: the Review's apply says to go on to today's plan, and the plan step takes the answers already given", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2027-02-01");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("r-dave", "Message Dave about the lights"))}<h3>Evening</h3>${ul(li("r-groc", "Groceries"))}`);
        });
        at("2027-02-03T09:45");
        const wound = await call("caius_winddown_apply", { date: "2027-02-01", done: [ "groceries" ] });
        expect(wound.next).toBe("planday");
        expect(wound.nextCall).toEqual({ tool: "caius_planday", date: "2027-02-03" });
        expect(wound.say).toMatch(/ Now today's plan\.$/);

        // A day nothing recorded: the answers he gave in this conversation are passed through instead.
        at("2027-02-10T09:45");
        expect((await call("caius_planday", { date: "2027-02-10", step: "inputs", refresh: true })).question).toContain("Anything for the evening?");
        expect((await call("caius_planday", { date: "2027-02-10", step: "inputs", answered: { evening: [] } })).question).toBeNull();

        // Last week's line is offered to carry on Tuesday, unless he already said to keep it.
        expect((await call("caius_context_add", { week: "2027-W07", text: "Sam is out", until: "2027-02-26" })).results[0]).toMatchObject({ status: "added" });
        at("2027-02-23T09:45");
        const offered = await call("caius_planday", { date: "2027-02-23", step: "inputs", refresh: true });
        expect(offered.data.carry.map((line: any) => line.line)).toEqual([ "Sam is out" ]);
        const kept = await call("caius_planday", { date: "2027-02-23", step: "inputs", answered: { evening: [ "Groceries" ], keep: [ "Sam is out" ] } });
        expect(kept.data.carry).toEqual([]);
        expect(kept.question).toBeNull();
    });

    it("an evening wind-down has no next call", async () => {
        at("2027-02-15T17:30");
        const wound = await call("caius_winddown_apply", { date: "2027-02-15" });
        expect(wound.next).toBeNull();
        expect(wound.nextCall).toBeUndefined();
        expect(wound.say).not.toContain("Now today's plan.");
    });
});

describe("asks are suggestions first, follow-ups later", () => {
    it("Mon 09:40: Jordan's ask on ZAP-105 is a candidate to answer and no Follow up; on Tuesday it is a Follow up and no candidate", async () => {
        jira.asks.push({
            ticket: ticket("ZAP-105", { summary: "Confirm the staging bucket name" }), author: "Jordan Placeholder", created: "2027-03-07T15:00:00.000-0500",
            commentId: "c105b", excerpt: "@Sam Example the rollout note is in the runbook now."
        });
        at("2027-03-08T09:40");
        const monday = await call("caius_planday", { date: "2027-03-08", step: "inputs", refresh: true });
        expect(monday.data.candidates).toEqual([ expect.objectContaining({
            candidateId: "ZAP-105", kind: "ask", text: "Answer Jordan Placeholder's question on ZAP-105", minutes: 15, because: "Jordan Placeholder asked on Sunday"
        }) ]);
        expect(monday.data.followUps).toEqual([]);
        const planned = await call("caius_plan_apply", { date: "2027-03-08", brief: prose });
        expect(planned.skipped).toEqual([]);
        const plan = await call("caius_plan", { period: "day", date: "2027-03-08" });
        expect(plan.suggested.map((task: any) => task.text)).toEqual([
            expect.stringMatching(/^Answer Jordan Placeholder's question on \[ZAP-105\]\([^)]+\): because Jordan Placeholder asked on Sunday \(~15m\)$/)
        ]);
        expect(await cls.init(() => store.content(planned.briefNoteId))).not.toContain("Follow up");

        at("2027-03-09T09:35");
        const tuesday = await call("caius_planday", { date: "2027-03-09", step: "inputs", refresh: true });
        expect(tuesday.data.candidates).toEqual([]);
        expect(tuesday.data.followUps).toEqual([ expect.objectContaining({ key: "ZAP-105", commentId: "c105b" }) ]);
        // The wind-down the night before already counts as a later day.
        at("2027-03-08T17:30");
        const night = await call("caius_winddown", { date: "2027-03-08", step: "next" });
        expect(night.data.candidates).toEqual([]);
        expect(night.data.followUps).toEqual([ expect.objectContaining({ key: "ZAP-105" }) ]);
    });
});

describe("no third person in his notes", () => {
    it("Wed 17:45: 'Shawn takes Incident Review…' is written as 'Taking Incident Review…', and a line it can't reword is sent back", async () => {
        at("2027-03-24T17:45");
        const applied = await call("caius_winddown_apply", {
            date: "2027-03-24", context: [ "Shawn takes Incident Review over Vendor Onboarding at 11:00", "Riley plans the release with Shawn at 14:00" ]
        });
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "context", text: "Taking Incident Review over Vendor Onboarding at 11:00", status: "written" })
        ]));
        expect(applied.skipped).toEqual([ expect.objectContaining({
            kind: "context", text: "Riley plans the release with Shawn at 14:00", reason: "third_person", detail: expect.stringContaining("his voice")
        }) ]);
        const thursday = await call("caius_plan", { period: "day", date: "2027-03-25" });
        expect(thursday.context.map((line: any) => line.text)).toEqual([ "Taking Incident Review over Vendor Onboarding at 11:00" ]);
    });
});

describe("an emptied Suggested goes", () => {
    it("Wed 09:40 'I answered Jordan in chat': dismissing the only suggestion takes the Suggested heading with it", async () => {
        const DAY = "2027-03-31";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("s-dave", "Message Dave about the lights"))}<h2>Suggested</h2>${ul(
                li("s-105", `Get ${zap("ZAP-105", "Confirm the staging bucket name")} done: because Jordan Placeholder asked on Sunday (~30m)`)
            )}`);
        });
        at(`${DAY}T09:40`);
        const applied = await call("caius_plan_apply", { date: DAY, dismiss: [ { candidateId: "ZAP-105" } ], brief: prose });
        expect(applied.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "dismiss", status: "written" }) ]));
        const plan = await call("caius_plan", { period: "day", date: DAY });
        expect(await cls.init(() => store.content(plan.noteId))).not.toContain("Suggested");
    });
});

describe("a refresh plans from now", () => {
    it("Tue 11:05: the refresh's acts and drawing start at 11:15, not at standup", async () => {
        const DAY = "2027-04-06";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("n101", `${zap("ZAP-101", "Verify the export retry")} ~30m`), li("n-dave", "Message Dave ~15m"))}`);
        });
        at(`${DAY}T09:35`);
        await call("caius_plan_apply", { date: DAY, brief: prose });
        at(`${DAY}T11:05`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(inputs.data.planFrom).toBe("11:15");
        const refreshed = await call("caius_plan_apply", { date: DAY, brief: {
            ...prose, acts: [ { range: "10:00 to 12:15", text: "Verify ZAP-101" }, { range: "10:30 to 11:00", text: "Message Dave" }, { range: "Evening", text: "z" } ]
        } });
        const header = await cls.init(() => store.content(refreshed.headerNoteId));
        expect(header).toContain("<strong>11:15 to 12:15</strong>");
        expect(header).toContain("<strong>11:15</strong>");
        expect(header).not.toContain("10:00 to");
        const brief = await call("caius_planday", { date: DAY, step: "brief" });
        expect(brief.data.header.work.map((block: any) => block.start)).toEqual([ "11:15", "11:45" ]);
    });
});

describe("a place finds the copy the wind-down moved", () => {
    it("Tue 17:30 'laundry first': the Laundry forwarded from Tuesday goes first, not Monday's; an item sent elsewhere is no place on Wednesday", async () => {
        await cls.init(async () => {
            const tuesday = await store.calendarDay("2027-04-13");
            await store.putContent(tuesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("t-lau", "Laundry"), li("t-wat", "Water the plants"))}`);
            const wednesday = await store.calendarDay("2027-04-14");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(
                li("w-lau", "Laundry <a href=\"#root/aMonday\">from Mon 12 Apr</a>"), li("w-wat", "Water the plants"), li("w-oth", "Other")
            )}`);
        });
        at("2027-04-13T17:30");
        const applied = await call("caius_winddown_apply", {
            date: "2027-04-13", fates: [ { listItemId: "t-wat", to: "w1" } ], move: [ { listItemId: "t-lau", first: true }, { listItemId: "t-wat", after: "Other" } ]
        });
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "move", id: "t-wat", reason: "not_on_list" }) ]);
        const plan = await call("caius_plan", { period: "day", date: "2027-04-14" });
        const tuesdayId = (await call("caius_plan", { period: "day", date: "2027-04-13" })).noteId;
        expect(plan.sections.flatMap((s: any) => s.tasks).map((t: any) => t.text)).toEqual([
            `Laundry [from Tue 13 Apr](#root/${tuesdayId})`, "Laundry [from Mon 12 Apr](#root/aMonday)", "Water the plants", "Other"
        ]);
    });
});

describe("an accepted ask is no Follow up", () => {
    it("Mon 'take 105', Mon night forwards it: on Tuesday it is a task on his list and no Follow up", async () => {
        jira.asks.push({
            ticket: ticket("ZAP-106", { summary: "Confirm the bucket" }), author: "Jordan Placeholder", created: "2027-04-18T15:00:00.000-0500",
            commentId: "c106", excerpt: "Can you confirm the bucket?"
        });
        at("2027-04-19T09:40");
        expect((await call("caius_plan_apply", { date: "2027-04-19", accept: [ { candidateId: "106" } ], brief: prose })).skipped).toEqual([]);
        at("2027-04-19T17:30");
        await call("caius_winddown_apply", { date: "2027-04-19" });
        at("2027-04-20T09:35");
        expect((await tasksOf("2027-04-20")).map((task: any) => task.text)).toEqual(expect.arrayContaining([ expect.stringContaining("ZAP-106") ]));
        const tuesday = await call("caius_planday", { date: "2027-04-20", step: "inputs", refresh: true });
        expect(tuesday.data.followUps).toEqual([]);
        expect((await call("caius_planday", { date: "2027-04-20", step: "brief" })).data.followUps).toEqual([]);
    });
});

describe("'later this week' is the week", () => {
    it("Mon 17:30 '111 later this week': the days carry week refs, and the fate goes to the week note, not a day", async () => {
        await wednesday("2027-03-15");
        at("2027-03-15T17:30");
        const open = await call("caius_winddown", { date: "2027-03-15", step: "open" });
        expect(open.data.days.slice(-2)).toEqual([
            { ref: "w1", week: "2027-W11", name: "later this week", weekLabel: "the week of Mon 15 Mar" },
            { ref: "w2", week: "2027-W12", name: "next week", weekLabel: "the week of Mon 22 Mar" }
        ]);
        const applied = await call("caius_winddown_apply", { date: "2027-03-15", fates: [ { listItemId: "111", to: "w1" }, { listItemId: "101", to: "next week" } ] });
        expect(applied.skipped).toEqual([]);
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "fate", id: "2027-03-15-111", detail: "2027-W11", status: "written" }),
            expect.objectContaining({ kind: "fate", id: "2027-03-15-101", detail: "2027-W12", status: "written" })
        ]));
        const week = await call("caius_plan", { period: "week", date: "2027-W11" });
        expect(week.sections.flatMap((s: any) => s.tasks).map((t: any) => t.text)).toEqual([ expect.stringContaining("ZAP-111") ]);
    });
});

describe("fix round 1: a ref names the item the step showed", () => {
    it("P1: he ticks 111 between the step and the apply; '101 is done, drop Dave' still lands on 101 and Dave", async () => {
        const DAY = "2027-05-05";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const open = await call("caius_winddown", { date: DAY, step: "open" });
        const ref = (word: string) => open.data.items.find((item: any) => item.text.includes(word)).ref;
        const plan = await call("caius_plan", { period: "day", date: DAY });
        await call("caius_set_state", { items: [ { noteId: plan.noteId, listItemId: `${DAY}-111`, state: "done" } ] });

        const applied = await call("caius_winddown_apply", { date: DAY, done: [ ref("ZAP-101") ], fates: [ { listItemId: ref("Dave"), drop: "not needed" } ] });
        expect(applied.skipped).toEqual([]);
        const states = Object.fromEntries((await call("caius_plan", { period: "day", date: DAY })).sections.flatMap((s: any) => s.tasks)
            .map((t: any) => [ t.listItemId, t.state ]));
        expect(states).toEqual({ [`${DAY}-111`]: "done", [`${DAY}-101`]: "done", [`${DAY}-dave`]: "cancelled", [`${DAY}-bag`]: expect.anything() });
        expect((await tasksOf("2027-05-06")).map((task: any) => task.text)).toEqual([ "Pack the climbing gym bag" ]);
    });

    it("a candidate ref no longer on offer is skipped as stale, with its text while Jira has the ticket, and lands on no other candidate", async () => {
        const DAY = "2027-05-10";
        jira.handoff.push(
            { ...ticket("ZAP-170", { summary: "Check the report" }), daysInStatus: 2 }, { ...ticket("ZAP-171", { summary: "Fix the gate" }), daysInStatus: 2 },
            { ...ticket("ZAP-173", { summary: "Read the spec" }), daysInStatus: 2 }
        );
        at(`${DAY}T09:40`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        const refOf = (key: string) => inputs.data.candidates.find((c: any) => c.candidateId === key).ref;
        const [ done, gone ] = [ refOf("ZAP-170"), refOf("ZAP-173") ];
        // ZAP-170 went to Suggested since the step, and ZAP-173 has left the hand-offs.
        await call("caius_add", { items: [ { date: DAY, suggested: true, key: "ZAP-170", title: "Check the report", because: "it waits", minutes: 30 } ] });
        jira.handoff.splice(2, 1);
        const applied = await call("caius_plan_apply", { date: DAY, accept: [ { candidateId: done }, { candidateId: gone } ], brief: prose });
        expect(applied.skipped).toEqual([
            { kind: "accept", reason: "stale", text: "Get ZAP-170 Check the report done" },
            { kind: "accept", reason: "stale" }
        ]);
        expect((await tasksOf(DAY)).map((task: any) => task.text).join()).not.toContain("ZAP-17");
    });

    it("M2: after 'take 172 first', 'put the desk first' by the step's list ref moves the desk, not what now sits in its old place", async () => {
        const DAY = "2027-05-11";
        jira.handoff.push({ ...ticket("ZAP-172", { summary: "Check the export" }), daysInStatus: 2 });
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("m-memo", "Write the memo ~30m"), li("m-desk", "Tidy the desk ~30m"))}`);
        });
        at(`${DAY}T09:40`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        const desk = inputs.data.list.find((item: any) => item.listItemId === "m-desk").ref;
        await call("caius_plan_apply", { date: DAY, accept: [ { candidateId: "172", first: true } ], brief: prose });
        await call("caius_plan_apply", { date: DAY, move: [ { listItemId: desk, first: true } ] });
        expect((await tasksOf(DAY)).map((task: any) => task.text)).toEqual([ "Tidy the desk", "ZAP-172 Check the export", "Write the memo" ]);
    });
});

describe("fix round 1: a re-run by his words finds what the first run did", () => {
    it("P4: the same wind-down by words twice: the second finds 111 and the bag done, skips nothing and changes nothing", async () => {
        const DAY = "2027-05-12";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const answer = { date: DAY, done: [ "111", "the bag" ], fates: [ { listItemId: "dave", to: "d1" } ] };
        expect((await call("caius_winddown_apply", answer)).skipped).toEqual([]);
        const again = await call("caius_winddown_apply", answer);
        expect(again.skipped).toEqual([]);
        expect(again.say).toBe("Everything was already in place.");
    });

    it("P8: the same Plan my day accept by number twice: the second finds ZAP-174 on his list", async () => {
        const DAY = "2027-05-17";
        jira.handoff.push({ ...ticket("ZAP-174", { summary: "Check the export" }), daysInStatus: 2 });
        at(`${DAY}T09:40`);
        const answer = { date: DAY, accept: [ { candidateId: "174" } ], brief: prose };
        expect((await call("caius_plan_apply", answer)).skipped).toEqual([]);
        const again = await call("caius_plan_apply", answer);
        expect(again.skipped).toEqual([]);
        expect(again.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "accept", id: "ZAP-174", status: "unchanged" }) ]));
    });

    it("a partial first run, then a re-run by words: 111 already done counts as answered, and the day ends wound down", async () => {
        const DAY = "2027-05-19";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const first = await call("caius_winddown_apply", { date: DAY, done: [ "111", "laundry" ] });
        expect(first.skipped).toEqual([ expect.objectContaining({ kind: "done", reason: "not_offered" }) ]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toEqual([]);
        const second = await call("caius_winddown_apply", { date: DAY, done: [ "111", "the bag" ] });
        expect(second.skipped).toEqual([]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
    });
});

describe("fix round 1: an item held by an ambiguous answer stays held", () => {
    it("P5: 'the export is done' is ambiguous; the third-person retry forwards neither export, and naming them settles both and closes the day", async () => {
        const DAY = "2027-06-16";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const first = await call("caius_winddown_apply", { date: DAY, done: [ "the export" ], context: [ "Riley covers for Shawn on Friday" ] });
        expect(first.skipped.map((s: any) => s.reason)).toEqual([ "ambiguous", "third_person" ]);
        expect(first.say).toMatch(/Which export: ZAP-111 or ZAP-101\?$/);
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([ `${DAY}-111`, `${DAY}-101` ]);

        const retry = await call("caius_winddown_apply", { date: DAY, context: [ "Riley covers for me on Friday" ] });
        expect(retry.skipped).toEqual([]);
        expect((await tasksOf(DAY)).slice(0, 2).map((task: any) => task.state)).toEqual([ "open", "open" ]);
        expect((await tasksOf("2027-06-17")).map((task: any) => task.text).join()).not.toContain("ZAP-1");
        expect(await labelsOf(DAY, "caiusWoundDown")).toEqual([]);
        expect(retry.say).toMatch(/Which do you mean: ZAP-111 or ZAP-101\?$/);

        const settled = await call("caius_winddown_apply", { date: DAY, done: [ "111" ], fates: [ { listItemId: "101", to: "d1" } ] });
        expect(settled.skipped).toEqual([]);
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
        expect((await tasksOf("2027-06-17")).map((task: any) => task.text)).toEqual(expect.arrayContaining([ "ZAP-101 Verify the export retry on staging" ]));
    });

    it("P6: an ambiguous move holds both exports open, and the day isn't marked wound down while they are held", async () => {
        const DAY = "2027-06-09";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const applied = await call("caius_winddown_apply", { date: DAY, move: [ { listItemId: "the export", first: true } ] });
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "move", reason: "ambiguous" }) ]);
        expect((await tasksOf(DAY)).slice(0, 2).map((task: any) => task.state)).toEqual([ "open", "open" ]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toEqual([]);
        // Dave and the bag, which he didn't name, take their proposed fate.
        expect((await tasksOf("2027-06-10")).map((task: any) => task.text)).toEqual([ expect.stringContaining("Message Dave"), "Pack the climbing gym bag" ]);
    });
});

describe("fix round 1: a held item isn't among what the wind-down moved", () => {
    it("M5: 'after the plants' names a held item, which stayed behind; the place isn't taken from Thursday's own plants", async () => {
        await cls.init(async () => {
            const wednesday = await store.calendarDay("2027-06-23");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("h-wat", "Water the plants"), li("h-lawn", "Water the lawn"), li("h-oth", "Call the plumber"))}`);
            const thursday = await store.calendarDay("2027-06-24");
            await store.putContent(thursday.noteId, `<h2>☑️ Tasks</h2>${ul(li("t-wat", "Water the plants"), li("t-tidy", "Tidy"))}`);
        });
        at("2027-06-23T17:45");
        const applied = await call("caius_winddown_apply", { date: "2027-06-23", done: [ "water" ], move: [ { listItemId: "plumber", after: "h-wat" } ] });
        expect(applied.skipped).toEqual([
            expect.objectContaining({ kind: "done", reason: "ambiguous" }),
            expect.objectContaining({ kind: "move", id: "h-oth", reason: "not_on_list" })
        ]);
        expect((await tasksOf("2027-06-24")).map((task: any) => task.text)).toEqual([ "Water the plants", "Tidy", "Call the plumber" ]);
    });
});
