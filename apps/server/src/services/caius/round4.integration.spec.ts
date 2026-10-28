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
import { createBeccaStore, createChildNote, removeLabel } from "./store.js";
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
    // An apply answers a reply of his; a test without one passes none.
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
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

/** Takes every hold off the day note of `date`, so a later test's catch-up doesn't ask about it. */
async function clearHolds(date: string) {
    const [ note ] = await cls.init(() => store.search(`#dateNote="${date}"`));
    for (const a of note?.attributes ?? []) {
        if (a.type === "label" && (a.name === "caiusHeld" || a.name === "caiusHeldGroup")) cls.init(() => removeLabel(note?.noteId ?? "", a.name, a.value));
    }
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
    it("Mon 09:40 'take 110, 111 and 101', then 'put 101 first': the move-only call reorders his list, and the picks, acts and drawing follow it", async () => {
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
            expect.objectContaining({ kind: "picks", status: "written" }),
            expect.objectContaining({ kind: "header", status: "written" })
        ]);
        expect(moved.say).toBe("ZAP-101 is first.");
        expect((await tasksOf(MON)).map((task: any) => task.text)).toEqual([ "ZAP-101 Verify the export retry on staging", "ZAP-110 Review the importer", "ZAP-111 Check the invoice export in QA" ]);
        // The brief's picks follow the new order; its prose, the questions answered and Suggested stay.
        const picksOf = (html: string) => [ ...html.matchAll(/<li[^>]*>([^<]*)<\/li>/g) ].map((m) => (m[1] ?? "").slice(0, 7));
        const rewritten = await cls.init(() => store.content(planned.briefNoteId));
        expect(picksOf(brief)).toEqual([ "ZAP-110", "ZAP-111", "ZAP-101" ]);
        expect(picksOf(rewritten)).toEqual([ "ZAP-101", "ZAP-110", "ZAP-111" ]);
        expect(rewritten.replace(/<ul>[\s\S]*?<\/ul>/, "")).toBe(brief.replace(/<ul>[\s\S]*?<\/ul>/, ""));
        expect(await labelsOf(MON, "caiusAsked")).toEqual(asked);
        const plan = await call("caius_plan", { period: "day", date: MON });
        expect(plan.suggested.map((task: any) => task.text)).toEqual([ expect.stringContaining("ZAP-105") ]);
        // The picks changed, so the drawing leads with ZAP-101, and with no acts given the tool writes plain ones.
        expect(drawing().indexOf("ZAP-101")).toBeLessThan(drawing().indexOf("ZAP-110"));
        const header = await cls.init(() => store.content(planned.headerNoteId));
        expect(header).toContain("<td><p><strong>10:00 to 11:00</strong></p><p>ZAP-101, then ZAP-110.</p></td>");
        expect(header).toContain("<td><p><strong>11:00 to 11:30</strong></p><p>ZAP-111.</p></td>");

        // Acts he sent with the move replace the first two.
        const acts = [ { range: "10:00 to 11:00", text: "Verify the retry, then the importer." }, { range: "11:00 to 12:00", text: "The export check." }, { range: "Evening", text: "z" } ];
        await call("caius_plan_apply", { date: MON, move: [ { listItemId: "110", first: true } ], acts });
        expect(await cls.init(() => store.content(planned.headerNoteId))).toContain("<p>Verify the retry, then the importer.</p>");
        // Three plain strings take the ranges the drawing gives.
        await call("caius_plan_apply", { date: MON, move: [ { listItemId: "101", first: true } ], acts: [ "Verify the retry, then the importer.", "The export check.", "z" ] });
        expect(await cls.init(() => store.content(planned.headerNoteId)))
            .toContain("<td><p><strong>10:00 to 11:00</strong></p><p>Verify the retry, then the importer.</p></td><td><p><strong>11:00 to 11:30</strong></p><p>The export check.</p></td>");

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
        await clearHolds("2026-11-18");
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
        const applied = await call("caius_plan_apply", { date: DAY, said: "I answered Jordan in chat", dismiss: [ { candidateId: "ZAP-105", answered: true } ], brief: prose });
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
        expect(header).toContain("<td><p><strong>11:15 to 11:45</strong></p><p>Verify ZAP-101</p></td><td><p><strong>11:45 to 12:00</strong></p><p>Message Dave</p></td>");
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
        // Every answer found already settled is named, never a silent "already in place".
        expect(again.say).toBe("ZAP-111 and Pack the climbing gym bag were already done and Message Dave if he knows anyone who will hang lights as a small job was already moved.");
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
        expect(again.say).toMatch(/^ZAP-174 was already on your list/);
    });

    it("a partial first run, then a re-run by words: 111 already done counts as answered, the bag and Dave are settled where they now sit, and the day ends wound down", async () => {
        const DAY = "2027-05-19";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const first = await call("caius_winddown_apply", { date: DAY, done: [ "111", "laundry" ] });
        expect(first.skipped).toEqual([ expect.objectContaining({ kind: "done", reason: "not_offered" }) ]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toEqual([]);
        // The first run forwarded the bag and Dave to Thursday as proposed; the re-run settles those copies.
        const second = await call("caius_winddown_apply", { date: DAY, done: [ "111", "the bag" ], fates: [ { listItemId: "dave", drop: "not needed" } ] });
        expect(second.skipped).toEqual([]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
        const thursday = Object.fromEntries((await tasksOf("2027-05-20")).map((task: any) => [ task.text, task.state ]));
        expect(thursday["Pack the climbing gym bag"]).toBe("done");
        expect(thursday["Message Dave if he knows anyone who will hang lights as a small job _not needed_"]).toBe("cancelled");
    });

    it("the same partial run, then a re-run by the open step's refs: the refs follow the bag and Dave to Thursday's copies", async () => {
        const DAY = "2027-09-08";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const open = await call("caius_winddown", { date: DAY, step: "open" });
        const ref = (word: string) => open.data.items.find((item: any) => item.text.includes(word)).ref;
        await call("caius_winddown_apply", { date: DAY, done: [ ref("ZAP-111"), "laundry" ] });
        const second = await call("caius_winddown_apply", { date: DAY, done: [ ref("ZAP-111"), ref("climbing") ], fates: [ { listItemId: ref("Dave"), drop: "not needed" } ] });
        expect(second.skipped).toEqual([]);
        const thursday = Object.fromEntries((await tasksOf("2027-09-09")).map((task: any) => [ task.text, task.state ]));
        expect(thursday["Pack the climbing gym bag"]).toBe("done");
        expect(thursday["Message Dave if he knows anyone who will hang lights as a small job _not needed_"]).toBe("cancelled");
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
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([ `${DAY}-111@${DAY}`, `${DAY}-101@${DAY}` ]);

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
        await clearHolds(DAY);
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
        await clearHolds("2027-06-23");
    });
});

describe("fix round 1: a finished key that two open items carry", () => {
    it("P2: 'ZAP-105 is finished' ticks the work item and the Answer task, since finishing the ticket settles its question", async () => {
        const DAY = "2027-06-30";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(
                li("f-105", `${zap("ZAP-105", "Confirm the bucket")} ~30m`),
                li("f-ask", `Answer Jordan Placeholder's question on ${zap("ZAP-105", "")} ~15m`),
                li("f-oth", "Other thing")
            )}`);
        });
        at(`${DAY}T17:45`);
        const applied = await call("caius_winddown_apply", { date: DAY, finished: [ "ZAP-105" ] });
        expect(applied.skipped).toEqual([]);
        expect((await tasksOf(DAY)).map((task: any) => task.state)).toEqual([ "done", "done", "done" ]);
        expect((await tasksOf("2027-07-01")).map((task: any) => task.text)).toEqual([ "Other thing" ]);
    });

    it("any other pair is held and reported as ambiguous, never ticked or forwarded in silence", async () => {
        const DAY = "2027-07-07";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("g-a", `${zap("ZAP-106", "Confirm the bucket")} ~30m`), li("g-b", `${zap("ZAP-106", "Write the rollout note")} ~30m`))}`);
        });
        at(`${DAY}T17:45`);
        const applied = await call("caius_winddown_apply", { date: DAY, finished: [ "ZAP-106" ] });
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "done", text: "ZAP-106", reason: "ambiguous" }) ]);
        expect((await tasksOf(DAY)).map((task: any) => task.state)).toEqual([ "open", "open" ]);
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([ `g-a@${DAY}`, `g-b@${DAY}` ]);
        expect(applied.say).toMatch(/Which ZAP-106: Confirm the bucket or Write the rollout note\?$/);
        await clearHolds(DAY);
    });
});

describe("fix round 1: finished in Plan my day reaches the catch-up", () => {
    it("P3: Thu 09:30 'move them all over, 111 is finished': ZAP-111 is ticked on Wednesday and isn't moved; the rest come over", async () => {
        await wednesday("2027-07-14");
        at("2027-07-15T09:30");
        const applied = await call("caius_plan_apply", { date: "2027-07-15", catchup: "move_all", finished: [ "ZAP-111" ], brief: prose });
        expect(applied.skipped).toEqual([]);
        expect((await tasksOf("2027-07-14"))[0]).toEqual({ text: "ZAP-111 Check the invoice export in QA", state: "done" });
        const thursday = (await tasksOf("2027-07-15")).map((task: any) => task.text);
        expect(thursday).not.toContain("ZAP-111 Check the invoice export in QA");
        expect(thursday).toEqual(expect.arrayContaining([ "ZAP-101 Verify the export retry on staging", "Pack the climbing gym bag" ]));
    });
});

describe("fix round 1: an ambiguous destination holds the item", () => {
    it("P7: '111 this week' goes to the week note; '101 some week' holds 101 open, and say asks which week instead of calling it moved", async () => {
        const DAY = "2027-07-21";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const applied = await call("caius_winddown_apply", { date: DAY, fates: [ { listItemId: "111", to: "this week" }, { listItemId: "101", to: "week" } ] });
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "fate", text: "week", reason: "ambiguous" }) ]);
        expect(applied.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "fate", id: `${DAY}-111`, detail: "2027-W29" }) ]));
        expect((await tasksOf(DAY))[1]).toEqual({ text: "ZAP-101 Verify the export retry on staging", state: "open" });
        expect((await tasksOf("2027-07-22")).map((task: any) => task.text).join()).not.toContain("ZAP-101");
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([ `${DAY}-101@${DAY}` ]);
        expect(applied.say).not.toMatch(/ZAP-101[^?]*moved/);
        expect(applied.say).toMatch(/Which week: later this week or next week\?$/);
        await clearHolds(DAY);
    });
});

describe("fix round 1: the third-person retry in Plan my day", () => {
    it("M1: a call with only context, and no brief, validates and writes only those lines", async () => {
        const DAY = "2027-07-26";
        at(`${DAY}T09:40`);
        const first = await call("caius_plan_apply", { date: DAY, context: [ "Riley plans the release with Shawn at 14:00" ], brief: prose });
        expect(first.skipped).toEqual([ expect.objectContaining({ kind: "context", reason: "third_person" }) ]);
        const asked = await labelsOf(DAY, "caiusAsked");
        const brief = await cls.init(() => store.content(first.briefNoteId));

        const retry = await call("caius_plan_apply", { date: DAY, context: [ "Planning the release with Riley at 14:00" ] });
        expect(retry.skipped).toEqual([]);
        expect(retry.written).toEqual([ expect.objectContaining({ kind: "context", text: "Planning the release with Riley at 14:00", status: "written" }) ]);
        expect((await call("caius_plan", { period: "day", date: DAY })).context.map((line: any) => line.text)).toEqual([ "Planning the release with Riley at 14:00" ]);
        expect(await labelsOf(DAY, "caiusAsked")).toEqual(asked);
        expect(await cls.init(() => store.content(first.briefNoteId))).toBe(brief);
    });
});

describe("fix round 1: answered.keep takes the line's id or ref", () => {
    it("M4: a line he already said to keep, given by its lineId or its x ref, isn't offered to carry again", async () => {
        expect((await call("caius_context_add", { week: "2027-W31", text: "Pat is out", until: "2027-08-13" })).results[0]).toMatchObject({ status: "added" });
        at("2027-08-10T09:45");
        const offered = await call("caius_planday", { date: "2027-08-10", step: "inputs", refresh: true });
        const [ line ] = offered.data.carry;
        expect(line).toEqual(expect.objectContaining({ line: "Pat is out" }));
        for (const given of [ line.lineId, line.ref, "Pat is out" ]) {
            const kept = await call("caius_planday", { date: "2027-08-10", step: "inputs", answered: { keep: [ given ] } });
            expect(kept.data.carry, given).toEqual([]);
        }
    });
});

describe("fix round 1: the put-off description", () => {
    it("M6: notToday says a put-off ask comes back as a Follow up, in both apply tools", () => {
        for (const name of [ "caius_plan_apply", "caius_winddown_apply" ]) {
            const schema = [ ...tools ].find(([ n ]) => n === name)?.[1].inputSchema as any;
            expect(schema?.shape.notToday.description, name).toMatch(/an ask comes back as a Follow up/);
        }
    });
});

describe("fix round 1: a moved item is followed to its copy, not taken as in place", () => {
    it("the bag went to Thursday as proposed; 'the bag is done too' ticks Thursday's copy, and 'drop Dave' drops his", async () => {
        const DAY = "2027-08-18";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "111" ] });
        expect((await tasksOf("2027-08-19")).map((task: any) => [ task.text, task.state ])).toEqual([
            [ "ZAP-101 Verify the export retry on staging", "open" ], [ "Message Dave if he knows anyone who will hang lights as a small job", "open" ],
            [ "Pack the climbing gym bag", "open" ]
        ]);
        const later = await call("caius_winddown_apply", { date: DAY, done: [ "the bag" ], fates: [ { listItemId: "dave", drop: "not needed" } ] });
        expect(later.skipped).toEqual([]);
        expect((await tasksOf("2027-08-19")).map((task: any) => task.state)).toEqual([ "open", "cancelled", "done" ]);
        expect(later.say).toMatch(/^Pack the climbing gym bag is done and Message Dave .* is dropped\.$/);
        // Dave's copy is dropped now, so calling him done is stale, not already in place.
        const after = await call("caius_winddown_apply", { date: DAY, done: [ "dave" ] });
        expect(after.skipped).toEqual([ expect.objectContaining({ kind: "done", reason: "stale", text: "Message Dave if he knows anyone who will hang lights as a small job" }) ]);
    });

    it("Plan my day: a catch-up task's ref still names it after move_all moved it, so 'put it first' moves the copy", async () => {
        await cls.init(async () => {
            const tuesday = await store.calendarDay("2027-08-24");
            await store.putContent(tuesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("c-one", "First leftover ~30m"), li("c-two", "Second leftover ~30m"))}`);
            const wednesday = await store.calendarDay("2027-08-25");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("c-own", "Own task ~30m"))}`);
        });
        at("2027-08-25T09:40");
        const catchup = await call("caius_planday", { date: "2027-08-25", step: "catchup" });
        const second = catchup.data.tasks.find((task: any) => task.listItemId === "c-two").ref;
        await call("caius_plan_apply", { date: "2027-08-25", catchup: "move_all", brief: prose });
        const moved = await call("caius_plan_apply", { date: "2027-08-25", move: [ { listItemId: second, first: true } ] });
        expect(moved.skipped).toEqual([]);
        const wednesday = (await tasksOf("2027-08-25")).map((task: any) => task.text);
        expect(wednesday[0]).toBe("Second leftover");
        expect(wednesday).toEqual(expect.arrayContaining([ "Own task", "First leftover" ]));
    });
});

describe("fix round 1: a hold survives the catch-up", () => {
    it("Wed night 'the export is done' holds both; Thu move_all leaves them on Wednesday and asks which; 'ZAP-111 is finished' settles it and releases 101", async () => {
        await wednesday("2027-09-01");
        at("2027-09-01T17:45");
        await call("caius_winddown_apply", { date: "2027-09-01", done: [ "the export" ] });
        at("2027-09-02T09:30");
        const catchup = await call("caius_planday", { date: "2027-09-02", step: "catchup" });
        expect(catchup.data.tasks.map((task: any) => task.listItemId)).not.toContain("2027-09-01-111");
        // The held exports surface in the catch-up as their own question, with refs to answer by.
        expect(catchup.data.held.map((task: any) => [ task.listItemId, task.ref ])).toEqual([
            [ "2027-09-01-111", refOf("o", "2027-09-01-111") ], [ "2027-09-01-101", refOf("o", "2027-09-01-101") ]
        ]);
        expect(catchup.question).toMatch(/Which do you mean: ZAP-111 or ZAP-101\?$/);
        const planned = await call("caius_plan_apply", { date: "2027-09-02", catchup: "move_all", brief: prose });
        expect((await tasksOf("2027-09-01")).slice(0, 2).map((task: any) => task.state)).toEqual([ "open", "open" ]);
        expect((await tasksOf("2027-09-02")).map((task: any) => task.text).join()).not.toContain("ZAP-1");
        expect(planned.say).toMatch(/Which do you mean: ZAP-111 or ZAP-101\?$/);

        const finished = await call("caius_plan_apply", { date: "2027-09-02", finished: [ "ZAP-111" ], brief: prose });
        expect(finished.skipped).toEqual([]);
        expect((await tasksOf("2027-09-01"))[0]).toEqual({ text: "ZAP-111 Check the invoice export in QA", state: "done" });
        // The hold narrowed to ZAP-101, which is released: no longer held, and not asked about.
        expect(await labelsOf("2027-09-01", "caiusHeld")).toEqual([]);
        expect(finished.say).not.toMatch(/\?$/);
    });
});

describe("fix round 2: copies of one carried item are one item", () => {
    it("N2: Monday carries the memo and the plumber to Tuesday; re-runs by words on Tuesday find them, never 'Write the memo or Write the memo?', and close the day", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2027-09-13");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("n-memo", "Write the memo"), li("n-plumb", "Call the plumber ~15m"))}`);
        });
        at("2027-09-13T17:30");
        await call("caius_winddown_apply", { date: "2027-09-13" });
        at("2027-09-14T17:30");
        const answer = { date: "2027-09-14", done: [ "the memo" ], fates: [ { listItemId: "plumber", drop: "not needed" } ] };
        const partial = await call("caius_winddown_apply", { ...answer, done: [ "the memo", "laundry" ] });
        expect(partial.skipped).toEqual([ expect.objectContaining({ kind: "done", reason: "not_offered" }) ]);
        for (const run of [ "re-run", "again" ]) {
            const again = await call("caius_winddown_apply", answer);
            expect(again.skipped, run).toEqual([]);
            expect(again.say, run).not.toContain("Which");
        }
        expect(await labelsOf("2027-09-14", "caiusWoundDown")).toHaveLength(1);
    });
});

describe("fix round 2: the settled fallback stays on the day and says what it found", () => {
    it("N5: Monday's done 'Buy a new gym bag' doesn't absorb Wednesday's 'the bag', which matches nothing open there", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2027-09-20");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("b-gym", "Buy a new gym bag"))}`);
            const wednesday = await store.calendarDay("2027-09-22");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("b-duf", "Pack the climbing duffel"))}`);
        });
        const monday = await call("caius_plan", { period: "day", date: "2027-09-20" });
        await call("caius_set_state", { items: [ { noteId: monday.noteId, listItemId: "b-gym", state: "done" } ] });
        at("2027-09-22T17:45");
        const applied = await call("caius_winddown_apply", { date: "2027-09-22", done: [ "the bag" ] });
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "done", reason: "not_offered" }) ]);
        expect(applied.say).toContain("'the bag' wasn't found");
        expect(await labelsOf("2027-09-22", "caiusWoundDown")).toEqual([]);
    });
});

describe("fix round 2: a hold that narrows to one item is resolved", () => {
    it("N4: 'the export is done' holds both; '111' settles it, so 101 is released to its proposed fate and nothing is asked", async () => {
        const DAY = "2027-09-29";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "the export" ] });
        const narrowed = await call("caius_winddown_apply", { date: DAY, done: [ "111" ] });
        expect(narrowed.skipped).toEqual([]);
        expect(narrowed.say).not.toMatch(/\?$/);
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
        expect((await tasksOf("2027-09-30")).map((task: any) => task.text)).toContain("ZAP-101 Verify the export retry on staging");
    });
});

describe("fix round 2: rewritten picks survive a sub-bullet", () => {
    it("N3: a pick with a sub-bullet he added; 'put gamma first' rewrites the whole list, well-formed, and the rest of the brief stays byte for byte", async () => {
        const DAY = "2027-10-04";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("p-a", "Alpha task ~30m"), li("p-b", "Beta task ~30m"), li("p-g", "Gamma task ~30m"))}`);
        });
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, brief: { ...prose, sections: [ { title: "Notes", markdown: "Keep it light." } ] } });
        const before = await cls.init(() => store.content(planned.briefNoteId));
        // He adds a sub-bullet under the first pick.
        const nested = before.replace(/(<li[^>]*>Alpha task[^<]*)<\/li>/, "$1<ul><li>ask Pat first</li></ul></li>");
        expect(nested).not.toBe(before);
        await cls.init(() => store.putContent(planned.briefNoteId, nested));

        await call("caius_plan_apply", { date: DAY, move: [ { listItemId: "gamma", first: true } ] });
        const after = await cls.init(() => store.content(planned.briefNoteId));
        const picks = /<h2>Get done today<\/h2>(<ul>[\s\S]*?<\/ul>)<h2>/.exec(after)?.[1] ?? "";
        expect([ ...picks.matchAll(/<li[^>]*>([^<]*)/g) ].map((m) => m[1])).toEqual([ "Gamma task (~30m)", "Alpha task (~30m)", "Beta task (~30m)" ]);
        expect((after.match(/<ul>/g) ?? []).length).toBe((after.match(/<\/ul>/g) ?? []).length);
        expect((after.match(/<li[ >]/g) ?? []).length).toBe((after.match(/<\/li>/g) ?? []).length);
        const outside = (html: string) => html.replace(/<h2>Get done today<\/h2>[\s\S]*?(?=<h2>Notes<\/h2>)/, "");
        expect(outside(after)).toBe(outside(nested));
    });
});

describe("fix round 2: acts outside a move are said, not dropped", () => {
    it("N7: a context-only call that carries acts writes the line and reports the acts as skipped", async () => {
        const DAY = "2027-10-11";
        at(`${DAY}T09:40`);
        const applied = await call("caius_plan_apply", { date: DAY, context: [ "Taking the vendor call at 15:00" ], acts: [ "a", "b", "c" ] });
        expect(applied.written).toEqual([ expect.objectContaining({ kind: "context", status: "written" }) ]);
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "acts", reason: "not_a_move" }) ]);
        expect(applied.say).toMatch(/[Tt]he acts go with a move/);
    });

    it("N7: a full plan call that carries acts writes the brief from its own acts and reports the stray ones", async () => {
        const DAY = "2027-10-12";
        at(`${DAY}T09:40`);
        const applied = await call("caius_plan_apply", { date: DAY, brief: prose, acts: [ "a", "b", "c" ] });
        expect(applied.skipped).toEqual([ expect.objectContaining({ kind: "acts", reason: "not_a_move" }) ]);
    });
});

describe("fix round 2: a held item is never forwarded or forgotten by a later day", () => {
    it("Wed's ambiguous done holds the exports; Thursday's wind-down neither forwards nor hides them; Monday still asks; naming them releases them", async () => {
        await wednesday("2027-10-13");
        at("2027-10-13T17:45");
        await call("caius_winddown_apply", { date: "2027-10-13", done: [ "the export" ] });

        at("2027-10-14T17:30");
        const open = await call("caius_winddown", { date: "2027-10-14", step: "open" });
        const exports = open.data.items.filter((item: any) => item.text.includes("export"));
        expect(exports.map((item: any) => item.fate)).toEqual([ { held: true }, { held: true } ]);
        expect(open.question).toMatch(/Which do you mean: ZAP-111 or ZAP-101\?$/);
        const thursday = await call("caius_winddown_apply", { date: "2027-10-14" });
        expect(thursday.say).toMatch(/Which do you mean: ZAP-111 or ZAP-101\?$/);
        expect((await tasksOf("2027-10-13")).slice(0, 2).map((task: any) => task.state)).toEqual([ "open", "open" ]);
        expect((await tasksOf("2027-10-15")).map((task: any) => task.text).join()).not.toContain("ZAP-1");

        at("2027-10-18T09:30");
        const monday = await call("caius_planday", { date: "2027-10-18", step: "catchup" });
        expect(monday.data.held.map((task: any) => task.listItemId)).toEqual([ "2027-10-13-111", "2027-10-13-101" ]);
        expect(monday.question).toMatch(/Which do you mean: ZAP-111 or ZAP-101\?$/);
        const named = await call("caius_plan_apply", { date: "2027-10-18", finished: [ "ZAP-111", "ZAP-101" ], brief: prose });
        expect(named.say).not.toMatch(/\?$/);
        expect(await labelsOf("2027-10-13", "caiusHeld")).toEqual([]);
        expect((await tasksOf("2027-10-13")).slice(0, 2).map((task: any) => task.state)).toEqual([ "done", "done" ]);
    });
});

describe("fix round 3: a hold that spans two days", () => {
    it("F0 (X1, X2): Monday's 111 and Wednesday's 101 held together; neither Thursday's move_all nor Thursday's wind-down moves either until he names one", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2027-11-01");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("x-111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`);
            const wednesday = await store.calendarDay("2027-11-03");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("x-101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`))}`);
        });
        at("2027-11-03T17:45");
        const held = await call("caius_winddown_apply", { date: "2027-11-03", done: [ "the export" ] });
        expect(held.say).toMatch(/Which export: ZAP-101 or ZAP-111\?$/);
        const states = async () => [ ...(await tasksOf("2027-11-01")), ...(await tasksOf("2027-11-03")) ].map((task: any) => task.state);

        // X1: Thursday morning's catch-up neither offers 111 to move nor moves it.
        at("2027-11-04T09:30");
        const catchup = await call("caius_planday", { date: "2027-11-04", step: "catchup" });
        expect(catchup.data.tasks.map((task: any) => task.listItemId)).toEqual([]);
        expect(catchup.data.held.map((task: any) => task.listItemId)).toEqual([ "x-111", "x-101" ]);
        expect(catchup.question).toMatch(/Which do you mean: ZAP-1\d\d.* or ZAP-1\d\d.*\?$/);
        const planned = await call("caius_plan_apply", { date: "2027-11-04", catchup: "move_all", brief: prose });
        expect(planned.say).toMatch(/Which do you mean: ZAP-1\d\d.* or ZAP-1\d\d.*\?$/);
        expect(await states()).toEqual([ "open", "open" ]);
        expect((await tasksOf("2027-11-04")).map((task: any) => task.text).join()).not.toContain("ZAP-1");

        // X2: Thursday evening's wind-down with no answers forwards neither.
        at("2027-11-04T17:30");
        const thursday = await call("caius_winddown_apply", { date: "2027-11-04" });
        expect(thursday.say).toMatch(/Which do you mean: ZAP-1\d\d.* or ZAP-1\d\d.*\?$/);
        expect(await states()).toEqual([ "open", "open" ]);
        expect((await tasksOf("2027-11-05")).map((task: any) => task.text).join()).not.toContain("ZAP-1");
        expect((await labelsOf("2027-11-03", "caiusHeld")).sort()).toEqual([ "x-101@2027-11-03", "x-111@2027-11-01" ]);
        await clearHolds("2027-11-03");
    });
});

describe("fix round 3: a three-way hold narrowed by one", () => {
    it("F5 (S2): 'the export is done' holds 111, 101 and 120; '111' answers it, so 101 and 120 are released and nothing is asked", async () => {
        const DAY = "2027-11-10";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(
                li("t3-111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`), li("t3-101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`),
                li("t3-120", `${zap("ZAP-120", "Fix the export columns")} ~30m`)
            )}`);
        });
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "the export" ] });
        const answered = await call("caius_winddown_apply", { date: DAY, done: [ "111" ] });
        expect(answered.say).not.toMatch(/\?$/);
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
        expect((await tasksOf("2027-11-11")).map((task: any) => task.text)).toEqual([ "ZAP-101 Verify the export retry on staging", "ZAP-120 Fix the export columns" ]);
    });
});

describe("fix round 3: an answer of another intent settles only what it names", () => {
    it("F2 (S10): 'the export is done' holds both; the Review's 'drop 101' drops 101 and keeps 111 held, asking about it by name", async () => {
        const DAY = "2027-11-17";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "the export" ] });
        at("2027-11-18T09:40");
        const review = await call("caius_winddown_apply", { date: DAY, fates: [ { listItemId: "101", drop: "not needed" } ] });
        expect(review.skipped).toEqual([]);
        expect(review.say).toContain("And ZAP-111: is that the one that's done?");
        expect((await tasksOf(DAY)).slice(0, 2).map((task: any) => task.state)).toEqual([ "open", "cancelled" ]);
        expect((await tasksOf("2027-11-18")).map((task: any) => task.text).join()).not.toContain("ZAP-111");
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([ `${DAY}-111@${DAY}` ]);
        expect(await labelsOf(DAY, "caiusWoundDown")).toEqual([]);

        // The next call answers nothing about the exports: 111 stays held, unmoved, and asked about.
        at("2027-11-18T09:45");
        const planned = await call("caius_plan_apply", { date: "2027-11-18", catchup: "move_all", brief: prose });
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([ `${DAY}-111@${DAY}` ]);
        expect((await tasksOf(DAY))[0]).toEqual({ text: "ZAP-111 Check the invoice export in QA", state: "open" });
        expect((await tasksOf("2027-11-18")).map((task: any) => task.text).join()).not.toContain("ZAP-111");
        expect(planned.say).toMatch(/ZAP-111\?$/);
        await clearHolds(DAY);
    });
});

describe("fix round 3: hold and settled labels are cleaned up", () => {
    it("F3 (S9): he ticks both held exports by hand; the next apply takes their hold labels off", async () => {
        const DAY = "2027-11-24";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "the export" ] });
        const plan = await call("caius_plan", { period: "day", date: DAY });
        await call("caius_set_state", { items: [ `${DAY}-111`, `${DAY}-101` ].map((listItemId) => ({ noteId: plan.noteId, listItemId, state: "done" })) });
        at("2027-11-25T09:40");
        await call("caius_plan_apply", { date: "2027-11-25", brief: prose });
        expect(await labelsOf(DAY, "caiusHeld")).toEqual([]);
        expect(await labelsOf(DAY, "caiusHeldGroup")).toEqual([]);
    });

    it("F4, G1: a day keeps its #caiusSettled labels through its own wind-down; the next workday's wind-down takes them off", async () => {
        const DAY = "2027-12-01";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        const first = await call("caius_winddown_apply", { date: DAY, done: [ "111", "laundry" ] });
        expect(first.skipped).toEqual([ expect.objectContaining({ reason: "not_offered" }) ]);
        expect(await labelsOf(DAY, "caiusSettled")).not.toEqual([]);
        await call("caius_winddown_apply", { date: DAY, done: [ "111", "the bag" ] });
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
        expect(await labelsOf(DAY, "caiusSettled")).not.toEqual([]);
        at("2027-12-02T17:45");
        const thursday = await call("caius_winddown_apply", { date: "2027-12-02", done: [ "ZAP-101" ], fates: [ { listItemId: "Dave", drop: "asked in person" } ] });
        expect(thursday.skipped).toEqual([]);
        expect(await labelsOf("2027-12-02", "caiusWoundDown")).toHaveLength(1);
        expect(await labelsOf("2027-12-02", "caiusSettled")).not.toEqual([]);
        expect(await labelsOf(DAY, "caiusSettled")).toEqual([]);
    });

    it("G1: #caiusSettled labels older than 3 workdays are taken off by a wind-down that doesn't close its day", async () => {
        const DAY = "2028-02-14";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "111" ] });
        expect(await labelsOf(DAY, "caiusSettled")).not.toEqual([]);
        await cls.init(async () => {
            const later = await store.calendarDay("2028-02-21");
            await store.putContent(later.noteId, `<h2>☑️ Tasks</h2>${ul(li("ag-1", "Renew the parking permit"))}`);
        });
        at("2028-02-21T17:45");
        const open = await call("caius_winddown_apply", { date: "2028-02-21", fates: [ { listItemId: "ag-1", to: "2099-01-01" } ] });
        expect(open.skipped).toEqual([ expect.objectContaining({ reason: "not_a_listed_day" }) ]);
        expect(await labelsOf("2028-02-21", "caiusWoundDown")).toEqual([]);
        expect(await labelsOf(DAY, "caiusSettled")).toEqual([]);
    });
});

describe("fix round 4: a follow-up by words after a complete wind-down", () => {
    it("G1 (N3): 'drop Dave' drops Thursday's copy of Monday's Dave, and 'the export' asks which instead of ticking 101", async () => {
        const MO = "2028-02-07", WE = "2028-02-09", TH = "2028-02-10";
        await cls.init(async () => {
            const monday = await store.calendarDay(MO);
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${MO}-111`, `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`), li(`${MO}-dave`, "Message Dave about the lights"))}`);
            const wednesday = await store.calendarDay(WE);
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${WE}-101`, `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`), li(`${WE}-bag`, "Pack the climbing gym bag"))}`);
        });
        at(`${WE}T17:45`);
        const first = await call("caius_winddown_apply", { date: WE, done: [ "the invoice export" ] });
        expect(first.say).toMatch(/^ZAP-111 is done/);
        expect(await labelsOf(WE, "caiusWoundDown")).toHaveLength(1);

        const second = await call("caius_winddown_apply", { date: WE, done: [ "the invoice export" ], fates: [ { listItemId: "Dave", drop: "not needed" } ] });
        expect(second.say).toBe("ZAP-111 was already done and Message Dave about the lights is dropped.");
        expect(await tasksOf(TH)).toContainEqual({ text: "Message Dave about the lights _not needed_", state: "cancelled" });

        const third = await call("caius_winddown_apply", { date: WE, done: [ "the export" ] });
        expect(third.say).toMatch(/Which export: ZAP-111 or ZAP-101\?$/);
        expect(third.written.filter((entry: any) => entry.kind === "done")).toEqual([]);
        expect((await tasksOf(TH)).find((task: any) => task.text.startsWith("ZAP-101"))?.state).toBe("open");
        await clearHolds(WE);
    });
});

describe("fix round 3: held items on several days are named with their days", () => {
    it("F6: Monday's 111 and Wednesday's 101 held together; Thursday's question names each one's day", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2027-12-06");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("d6-111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`);
            const wednesday = await store.calendarDay("2027-12-08");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("d6-101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`))}`);
        });
        at("2027-12-08T17:45");
        await call("caius_winddown_apply", { date: "2027-12-08", done: [ "the export" ] });
        at("2027-12-09T09:30");
        const catchup = await call("caius_planday", { date: "2027-12-09", step: "catchup" });
        expect(catchup.question).toMatch(/Which do you mean: ZAP-111 \(Mon 6 Dec\) or ZAP-101 \(Wed 8 Dec\)\?$/);
        const planned = await call("caius_plan_apply", { date: "2027-12-09", brief: prose });
        expect(planned.say).toMatch(/Which do you mean: ZAP-111 \(Mon 6 Dec\) or ZAP-101 \(Wed 8 Dec\)\?$/);
        await clearHolds("2027-12-08");
    });
});

describe("fix round 3: Review with only held tasks", () => {
    it("F7: catchup 'review' when Wednesday's only open tasks are held says the review is coming and asks the held question", async () => {
        const DAY = "2027-12-15";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "the export" ] });
        at("2027-12-16T09:30");
        const planned = await call("caius_plan_apply", { date: "2027-12-16", catchup: "review", brief: prose });
        expect(planned.skipped).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "catchup", reason: "review" }) ]));
        expect(planned.say).toContain("goes through its wind-down");
        expect(planned.say).toMatch(/Which do you mean: ZAP-1\d\d or ZAP-1\d\d\?$/);
        await clearHolds(DAY);
    });
});

describe("fix round 3: a held week item is asked about too", () => {
    it("Wednesday's 111 and the week's 101 held together; Thursday's catch-up lists the week item with the day item and asks which", async () => {
        await cls.init(async () => {
            const wednesday = await store.calendarDay("2027-12-22");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("ws-111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`);
            const week = await store.calendarWeek("2027-W51");
            await store.putContent(week.noteId, `${await store.content(week.noteId)}<h2>☑️ Tasks</h2>${ul(li("ws-101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`))}`);
        });
        at("2027-12-22T17:45");
        const held = await call("caius_winddown_apply", { date: "2027-12-22", done: [ "the export" ] });
        expect(held.say).toMatch(/Which export: ZAP-1\d\d or ZAP-1\d\d\?$/);
        at("2027-12-23T09:30");
        const catchup = await call("caius_planday", { date: "2027-12-23", step: "catchup" });
        expect(catchup.data.held.map((task: any) => task.listItemId).sort()).toEqual([ "ws-101", "ws-111" ]);
        expect(catchup.question).toMatch(/ZAP-111.* or ZAP-101.*\?$|ZAP-101.* or ZAP-111.*\?$/);
        await clearHolds("2027-12-22");
    });
});

describe("fix round 3: a day with a held item isn't closed", () => {
    it("Wednesday's hold covers Monday's 111; Thursday's Review of Monday keeps 111 there and doesn't mark Monday wound down", async () => {
        await cls.init(async () => {
            const monday = await store.calendarDay("2028-01-03");
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li("cg-111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`);
            const wednesday = await store.calendarDay("2028-01-05");
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("cg-101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`))}`);
        });
        at("2028-01-05T17:45");
        await call("caius_winddown_apply", { date: "2028-01-05", done: [ "the export" ] });
        at("2028-01-06T09:30");
        const review = await call("caius_winddown_apply", { date: "2028-01-03" });
        expect(review.say).toMatch(/ZAP-1\d\d.*\?/);
        expect((await tasksOf("2028-01-03"))[0]).toEqual({ text: "ZAP-111 Check the invoice export in QA", state: "open" });
        expect(await labelsOf("2028-01-03", "caiusWoundDown")).toEqual([]);
        await clearHolds("2028-01-05");
    });
});

describe("fix round 4: a hold settled from a day whose window doesn't reach the item", () => {
    /** Monday's 111 and Wednesday's 101, held together by Wednesday's "the export is done". */
    async function heldAcrossDays(mon: string, wed: string, prefix: string) {
        await cls.init(async () => {
            const monday = await store.calendarDay(mon);
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${prefix}-111`, `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`);
            const wednesday = await store.calendarDay(wed);
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${prefix}-101`, `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`), li(`${prefix}-dave`, "Message Dave about the lights"))}`);
        });
        at(`${wed}T17:45`);
        const held = await call("caius_winddown_apply", { date: wed, done: [ "the export" ] });
        expect(held.say).toMatch(/Which export: ZAP-1\d\d or ZAP-1\d\d\?$/);
    }

    it("G2 (N1c): Friday's 'ZAP-101 is done' releases Monday's 111, which goes on to Monday and is said", async () => {
        const MO = "2028-03-06", WE = "2028-03-08", FR = "2028-03-10", NEXT = "2028-03-13";
        await heldAcrossDays(MO, WE, "nc");
        await cls.init(async () => {
            const friday = await store.calendarDay(FR);
            await store.putContent(friday.noteId, `<h2>☑️ Tasks</h2>${ul(li("nc-x", "Water the office plants"))}`);
        });
        at(`${FR}T17:45`);
        const friday = await call("caius_winddown_apply", { date: FR, done: [ "ZAP-101", "nc-x" ] });
        expect(friday.skipped).toEqual([]);
        expect(friday.written).toContainEqual(expect.objectContaining({ kind: "fate", id: "nc-111", detail: NEXT, status: "written" }));
        expect(friday.say).toMatch(/ZAP-111 moved to Mon 13 Mar/);
        expect(await labelsOf(WE, "caiusHeld")).toEqual([]);
        expect(await tasksOf(NEXT)).toContainEqual({ text: "ZAP-111 Check the invoice export in QA", state: "open" });
    });

    it("G2 (N2b): Monday's Review, 'move 111 to Friday', asks about Wednesday's 101 in the same call", async () => {
        const MO = "2028-03-20", WE = "2028-03-22";
        await heldAcrossDays(MO, WE, "nb");
        at("2028-03-23T09:30");
        const review = await call("caius_winddown_apply", { date: MO, fates: [ { listItemId: "ZAP-111", to: "2028-03-24" } ] });
        expect(review.say).toMatch(/^ZAP-111 moved to Fri 24 Mar\. And ZAP-101: is that the one that's done\?/);
        expect(await labelsOf(WE, "caiusHeld")).toEqual([ `nb-101@${WE}` ]);
        await clearHolds(WE);
    });
});

describe("fix round 5: a Review of a day older than 3 workdays keeps its settled record", () => {
    it("H1 (P1): Friday's Review of Monday, no hold; 'drop Dave' drops today's copy and 'the export' asks which instead of ticking 101", async () => {
        const TH = "2028-03-30", MO = "2028-04-03", FR = "2028-04-07";
        await cls.init(async () => {
            const thursday = await store.calendarDay(TH);
            await store.putContent(thursday.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${TH}-111`, `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`), li(`${TH}-dave`, "Message Dave about the lights"))}`);
            const monday = await store.calendarDay(MO);
            await store.putContent(monday.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${MO}-101`, `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`), li(`${MO}-bag`, "Pack the climbing gym bag"))}`);
        });
        at(`${FR}T09:30`);
        const first = await call("caius_winddown_apply", { date: MO, done: [ "the invoice export" ] });
        expect(first.say).toMatch(/^ZAP-111 is done/);
        expect(await labelsOf(MO, "caiusWoundDown")).toHaveLength(1);
        expect(await labelsOf(MO, "caiusSettled")).not.toEqual([]);

        const second = await call("caius_winddown_apply", { date: MO, done: [ "the invoice export" ], fates: [ { listItemId: "Dave", drop: "not needed" } ] });
        expect(second.say).toMatch(/^ZAP-111 was already done and Message Dave about the lights is dropped\./);
        expect(await tasksOf(FR)).toContainEqual({ text: "Message Dave about the lights _not needed_", state: "cancelled" });

        const third = await call("caius_winddown_apply", { date: MO, done: [ "the export" ] });
        expect(third.say).toMatch(/Which export: ZAP-111 or ZAP-101\?/);
        expect(third.written.filter((entry: any) => entry.kind === "done")).toEqual([]);
        expect((await tasksOf(FR)).find((task: any) => task.text.startsWith("ZAP-101"))?.state).toBe("open");
        await clearHolds(MO);
    });

    it("H1 (S5i): a hold eight workdays old; the Review of its day settles it and keeps that day's #caiusSettled", async () => {
        const DAY = "2028-05-03", TODAY = "2028-05-15";
        await wednesday(DAY);
        at(`${DAY}T17:45`);
        await call("caius_winddown_apply", { date: DAY, done: [ "the export" ] });
        for (const day of [ "2028-05-04", "2028-05-05", "2028-05-08", "2028-05-09", "2028-05-10", "2028-05-11", "2028-05-12" ]) {
            await cls.init(async () => {
                const note = await store.calendarDay(day);
                await store.putContent(note.noteId, `<h2>☑️ Tasks</h2>${ul(li(`${day}-x`, `Thing on ${day}`))}`);
            });
            at(`${day}T17:45`);
            await call("caius_winddown_apply", { date: day, done: [ `${day}-x` ] });
        }
        at(`${TODAY}T09:30`);
        const review = await call("caius_winddown_apply", { date: DAY, done: [ "ZAP-101" ] });
        expect(review.say).toMatch(/^ZAP-101 is done and ZAP-111 moved to Mon 15 May\./);
        expect(await labelsOf(DAY, "caiusWoundDown")).toHaveLength(1);
        expect(await labelsOf(DAY, "caiusSettled")).toEqual(expect.arrayContaining([ `${DAY}-101`, `${DAY}-111` ]));
    });
});

describe("fix round 5: a hold settled in Plan my day", () => {
    it("N1f: Thursday's 'ZAP-101 is finished' releases the previous Friday's 111, which comes to today and is said", async () => {
        const FR = "2028-05-19", WE = "2028-05-24", TH = "2028-05-25";
        await cls.init(async () => {
            const friday = await store.calendarDay(FR);
            await store.putContent(friday.noteId, `<h2>☑️ Tasks</h2>${ul(li("nf-111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`);
            const wednesday = await store.calendarDay(WE);
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("nf-101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`), li("nf-dave", "Message Dave about the lights"))}`);
        });
        at(`${WE}T17:45`);
        const held = await call("caius_winddown_apply", { date: WE, done: [ "the export" ] });
        expect(held.say).toMatch(/Which export: ZAP-1\d\d or ZAP-1\d\d\?$/);
        at(`${TH}T09:30`);
        const planned = await call("caius_plan_apply", { date: TH, finished: [ "ZAP-101" ], catchup: "move_all", brief: prose });
        expect(planned.written).toContainEqual(expect.objectContaining({ kind: "fate", id: "nf-111", detail: TH, status: "written" }));
        expect(planned.say).toMatch(/ZAP-111 moved to/);
        expect(planned.say).not.toMatch(/\?$/);
        expect(await labelsOf(WE, "caiusHeld")).toEqual([]);
        expect(await tasksOf(TH)).toContainEqual({ text: "ZAP-111 Check the invoice export in QA", state: "open" });
    });
});
