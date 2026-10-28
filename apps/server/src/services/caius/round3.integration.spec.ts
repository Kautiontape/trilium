/**
 * The week of the third normal-user simulation (T19, Mon 2 to Wed 11 Nov 2026), replayed through
 * the tools: each test follows one of the sequences that went wrong there.
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

const zap = (key: string, title: string) => `<a href="https://example.atlassian.net/browse/${key}">${key}</a> ${title}`;
/** The day's main list and evening, as the plan reads them. */
async function listed(date: string) {
    const plan = await call("caius_plan", { period: "day", date });
    return plan.sections.flatMap((s: any) => s.tasks).filter((t: any) => t.state === "open").map((t: any) => t.text.replace(/ \[from [^\]]*\]\([^)]*\)/, ""));
}

describe("accept takes a position", () => {
    it("Wed 09:40 'yes, 101 first': the week's ZAP-101 goes to the top of his list, not the end", async () => {
        await cls.init(async () => {
            const wednesday = await store.calendarDay(WED);
            await store.putContent(wednesday.noteId, `<h2>☑️ Tasks</h2>${ul(li("w105", `${zap("ZAP-105", "Confirm the staging bucket name")} ~30m`), li("w111", `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`))}`
                + `<h3>Evening</h3>${ul(li("wlau", "Laundry"))}`);
            const week = await store.calendarWeek("2026-W45");
            await store.putContent(week.noteId, `${await store.content(week.noteId)}<h2>☑️ Tasks</h2>${ul(li("k101", `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`))}`);
        });
        at(`${WED}T09:40`);
        const inputs = await call("caius_planday", { date: WED, step: "inputs", refresh: true });
        expect(inputs.data.candidates).toEqual([ expect.objectContaining({ candidateId: "ZAP-101", kind: "week" }) ]);
        expect(inputs.data.list).toEqual([
            { listItemId: "w105", text: "ZAP-105 Confirm the staging bucket name", evening: false },
            { listItemId: "w111", text: "ZAP-111 Check the invoice export in QA", evening: false },
            { listItemId: "wlau", text: "Laundry", evening: true }
        ]);
        const applied = await call("caius_plan_apply", { date: WED, accept: [ { candidateId: "ZAP-101", first: true } ], brief: prose });
        expect(applied.skipped).toEqual([]);
        expect(await listed(WED)).toEqual([
            "[ZAP-101](https://example.atlassian.net/browse/ZAP-101) Verify the export retry on staging",
            "[ZAP-105](https://example.atlassian.net/browse/ZAP-105) Confirm the staging bucket name",
            "[ZAP-111](https://example.atlassian.net/browse/ZAP-111) Check the invoice export in QA",
            "Laundry"
        ]);
    });

    it("Tue 'add 120 after 105', then 'runbook first': a Suggested ticket goes after the task he names, and his own task moves to the top", async () => {
        const DAY = "2026-11-10";
        jira.handoff.push({ ...ticket("ZAP-120", { status: "QA Testing" }), daysInStatus: 3 });
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("t105", `${zap("ZAP-105", "Confirm the staging bucket name")} ~30m`), li("trun", "Write the runbook ~30m"))}`
                + `<h3>Evening</h3>${ul(li("tlau", "Laundry"))}<h2>Suggested</h2>${ul(li("ts120", `Get ${zap("ZAP-120", "Check the invoice export in QA")} done: because sitting in QA Testing for 3 days (~30m)`))}`);
        });
        at(`${DAY}T09:35`);
        const applied = await call("caius_plan_apply", { date: DAY, accept: [ { candidateId: "ZAP-120", after: "t105" } ], brief: prose });
        expect(applied.skipped).toEqual([]);
        expect(await listed(DAY)).toEqual([ expect.stringContaining("ZAP-105"), expect.stringContaining("ZAP-120"), "Write the runbook", "Laundry" ]);

        const moved = await call("caius_plan_apply", { date: DAY, move: [ { listItemId: "trun", first: true } ], brief: prose });
        expect(moved.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "move", id: "trun", status: "written" }) ]));
        expect(await listed(DAY)).toEqual([ "Write the runbook", expect.stringContaining("ZAP-105"), expect.stringContaining("ZAP-120"), "Laundry" ]);

        const refused = await call("caius_plan_apply", { date: DAY, move: [ { listItemId: "tlau", first: true } ], brief: prose });
        expect(refused.skipped).toEqual([ expect.objectContaining({ kind: "move", id: "tlau", reason: "not_in_main_list" }) ]);
    });
});

/** The header the brief of `applied` wrote: its acts and the drawing's SVG. */
async function headerOf(applied: { headerNoteId: string; attachmentId: string }) {
    const html = await cls.init(() => store.content(applied.headerNoteId));
    const acts = [ ...html.matchAll(/<td><p><strong>([^<]*)<\/strong><\/p><p>([^<]*)<\/p><\/td>/g) ].map((m) => ({ range: m[1], text: m[2] }));
    const svg = String(cls.init(() => becca.getAttachmentOrThrow(applied.attachmentId).getContent()));
    return { acts, svg };
}

describe("the header is drawn from the note as it ends", () => {
    it("Wed 09:40 'laundry can go to tomorrow': the forward of his own evening item is made, and neither the drawing nor the Evening act has Laundry", async () => {
        const DAY = "2026-11-11";
        calendars[DAY] = [ event("10:00", "10:15", "Daily Standup"), event("19:00", "20:30", "Climbing gym") ];
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("h130", `${zap("ZAP-130", "Verify the export retry")} ~30m`))}`
                + `<h3>Evening</h3>${ul(li("hlau", "Laundry <a href=\"#root/abc\">from Tue 10 Nov</a>"))}`);
        });
        at(`${DAY}T09:40`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(inputs.data.list.map((item: any) => item.listItemId)).toEqual([ "h130", "hlau" ]);
        const applied = await call("caius_plan_apply", { date: DAY, forward: [ { listItemId: "hlau", to: "2026-11-12" } ], brief: { ...prose, acts: [ prose.acts[0], prose.acts[1], { range: "Evening", text: "Laundry, then Climbing gym." } ] } });
        expect(applied.skipped).toEqual([]);
        const { acts, svg } = await headerOf(applied);
        expect(acts[2]).toEqual({ range: "Evening", text: "Climbing gym." });
        expect(svg).not.toContain("Laundry");
        expect(svg).toContain("ZAP-130");
    });

    it("Wed 11 'fine': a forward stamp is not in a bar's label, and an evening chore is never the focus block", async () => {
        const DAY = "2026-11-13";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2><h3>Evening</h3>${ul(li("flau", "Laundry <a href=\"#root/abc\">from Tuesday 3</a>"))}`);
        });
        at(`${DAY}T09:45`);
        const evening = (await call("caius_planday", { date: DAY, step: "brief" })).data.header.work;
        expect(evening).toEqual([ { start: "18:00", end: "18:30", label: "Laundry" } ]);
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("frun", "Write the runbook <a href=\"#root/abc\">from Monday 9</a> ~30m"))}<h3>Evening</h3>${ul(li("flau", "Laundry"))}`);
        });
        const work = (await call("caius_planday", { date: DAY, step: "brief" })).data.header.work;
        expect(work.map((w: any) => [ w.label, w.focus ?? false ])).toEqual([ [ "Write the runbook", true ], [ "Laundry", false ] ]);
    });

    it("Mon 09:40 'evening is just mom': the Evening act is its own act and names the call once", async () => {
        const DAY = "2026-11-16";
        calendars[DAY] = [ event("10:00", "10:15", "Daily Standup"), event("18:00", "18:30", "Call Mom") ];
        at(`${DAY}T09:40`);
        const applied = await call("caius_plan_apply", { date: DAY, evening: [ "Call Mom" ], brief: { ...prose, acts: [ prose.acts[0], prose.acts[1], { range: "14:00 to 18:00", text: "Call Mom." } ] } });
        expect((await headerOf(applied)).acts[2]).toEqual({ range: "Evening", text: "Call Mom." });
    });

    it("Wed 17:45: a wind-down that moves tonight's Laundry on draws today's header again without it", async () => {
        const DAY = "2026-11-18";
        await cls.init(async () => {
            const day = await store.calendarDay(DAY);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("g140", `${zap("ZAP-140", "Ship the fix")} ~30m`))}<h3>Evening</h3>${ul(li("glau", "Laundry"))}`);
        });
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, brief: prose });
        expect((await headerOf(planned)).acts[2]).toEqual({ range: "Evening", text: "Laundry." });
        at(`${DAY}T17:45`);
        const wound = await call("caius_winddown_apply", { date: DAY, done: [ "g140" ] });
        expect(wound.skipped).toEqual([]);
        expect(wound.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "header", detail: DAY, status: "written" }) ]));
        const { acts, svg } = await headerOf(planned);
        expect(acts[0]).toEqual(prose.acts[0]);
        expect(acts[2]).toEqual({ range: "Evening", text: "Nothing planned." });
        expect(svg).not.toContain("Laundry");
    });
});
