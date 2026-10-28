/**
 * The week of the fourth normal-user simulation (T21, Mon 2 to Wed 11 Nov 2026), replayed through
 * the tools: each test follows one of the answers the apply tools read wrong there.
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

describe("short references", () => {
    it("every item a step shows carries a ref: open items, candidates, his list, Context lines and days", async () => {
        await wednesday("2026-11-11");
        jira.handoff.push({ ...ticket("ZAP-140"), daysInStatus: 2 });
        at("2026-11-11T17:45");
        const open = await call("caius_winddown", { date: "2026-11-11", step: "open" });
        expect(open.data.items.map((item: any) => item.ref)).toEqual([ "o1", "o2", "o3", "o4" ]);
        expect(open.data.days[0]).toEqual(expect.objectContaining({ ref: "d1", date: "2026-11-12", dateLabel: "Thu 12 Nov" }));
        const next = await call("caius_winddown", { date: "2026-11-11", step: "next" });
        expect(next.data.candidates).toEqual([ expect.objectContaining({ ref: "c1", candidateId: "ZAP-140" }) ]);

        at("2026-11-11T09:40");
        const inputs = await call("caius_planday", { date: "2026-11-11", step: "inputs", refresh: true });
        expect(inputs.data.list.map((item: any) => item.ref)).toEqual([ "l1", "l2", "l3", "l4" ]);
        expect(inputs.data.candidates[0]).toEqual(expect.objectContaining({ ref: "c1", candidateId: "ZAP-140" }));
        expect(inputs.data.days[0]).toEqual(expect.objectContaining({ ref: "d1", date: "2026-11-12" }));
    });

    it("Wed 17:45 '111, 101 and the bag are done, dave tomorrow': names resolve to the three open items, and a ref to a day", async () => {
        await wednesday();
        at(`${WED}T17:45`);
        const applied = await call("caius_winddown_apply", { date: WED, done: [ "111", "ZAP-101", "the bag" ], fates: [ { listItemId: "o3", to: "d1" } ] });
        expect(applied.skipped).toEqual([]);
        expect(await tasksOf(WED)).toEqual([
            { text: "ZAP-111 Check the invoice export in QA", state: "done" },
            { text: "ZAP-101 Verify the export retry on staging", state: "done" },
            { text: "Message Dave if he knows anyone who will hang lights as a small job", state: expect.not.stringMatching(/^open$/) },
            { text: "Pack the climbing gym bag", state: "done" }
        ]);
        expect(await tasksOf(THU)).toEqual([ { text: "Message Dave if he knows anyone who will hang lights as a small job", state: "open" } ]);
    });

    it("a name that matches more than one item is skipped as ambiguous, listing the matches, and the items keep their proposed fate", async () => {
        await wednesday("2026-11-18");
        at("2026-11-18T17:45");
        const applied = await call("caius_winddown_apply", { date: "2026-11-18", done: [ "the export" ], fates: [ { listItemId: "the export", to: "d1" } ] });
        expect(applied.skipped).toEqual([
            { kind: "done", text: "the export", reason: "ambiguous", detail: "ZAP-111 Check the invoice export in QA; ZAP-101 Verify the export retry on staging" },
            { kind: "fate", text: "the export", reason: "ambiguous", detail: "ZAP-111 Check the invoice export in QA; ZAP-101 Verify the export retry on staging" }
        ]);
        // Neither is marked done: each keeps its proposed fate, open on the next workday.
        expect((await tasksOf("2026-11-19")).slice(0, 2)).toEqual([
            { text: "ZAP-111 Check the invoice export in QA", state: "open" },
            { text: "ZAP-101 Verify the export retry on staging", state: "open" }
        ]);
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
        expect(inputs.data.candidates.map((c: any) => [ c.ref, c.candidateId ])).toEqual([ [ "c1", "ZAP-150" ], [ "c2", "ZAP-151" ] ]);
        const applied = await call("caius_plan_apply", {
            date: DAY, accept: [ { candidateId: "c2", after: "memo" }, { candidateId: "150" } ], move: [ { listItemId: "l2", first: true } ], brief: prose
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
