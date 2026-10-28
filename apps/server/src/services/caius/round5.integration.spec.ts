/**
 * The week of the fifth normal-user simulation (T23, Mon 2 to Wed 11 Nov 2026), replayed through
 * the tools: each test follows an answer the round-5 transcripts show the tools losing.
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
async function tasksOf(period: "day" | "week", date: string) {
    const plan = await call("caius_plan", { period, date });
    return plan.sections.flatMap((s: any) => s.tasks).map((t: any) => ({
        text: t.text.replace(/\s*(?:\[from [^\]]*\]\([^)]*\)|_scheduled \[[^\]]*\]\([^)]*\)_)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
        state: t.state
    }));
}

/** The content of every day and week note, to see that a call changed none. */
async function journal() {
    return cls.init(async () => {
        const notes = [ ...await store.search("#dateNote"), ...await store.search("#weekNote") ];
        return Object.fromEntries(await Promise.all(notes.map(async (note) => [ note.noteId, await store.content(note.noteId) ] as const)));
    });
}

/** Monday as it stood at 17:30: his three tickets in the order he took them. */
async function monday(date: string) {
    await cls.init(async () => {
        const day = await store.calendarDay(date);
        await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(
            li(`${date}-101`, `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`),
            li(`${date}-110`, `${zap("ZAP-110", "Review the import mapper change")} ~30m`),
            li(`${date}-111`, `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`)
        )}`);
    });
}

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay("2026-11-02"), (await store.search("#calendarRoot"))[0]);
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

describe("a correction after the apply", () => {
    it("Mon 17:30: '111 was later this week, not tomorrow' is a second apply that moves only 111 to the week, adds the Context line, and repeats without change", async () => {
        const MON = "2026-11-02";
        const TUE = "2026-11-03";
        const FIX = "111 was later this week, not tomorrow. and don't dismiss 105. also ZAP-2590 is open, Jira's Done is wrong";
        await monday(MON);
        jira.handoff.push({ ...ticket("ZAP-111", { summary: "Check the invoice export in QA", status: "QA Testing" }), daysInStatus: 3 });
        at(`${MON}T17:30`);
        const first = await call("caius_winddown_apply", { date: MON, said: "110 is done. evening pack the climbing gym bag", done: [ "ZAP-110" ], evening: [ "Pack the climbing gym bag" ] });
        expect(first.skipped).toEqual([]);
        expect((await tasksOf("day", TUE)).map((task: any) => task.text)).toEqual([
            "ZAP-101 Verify the export retry on staging", "ZAP-111 Check the invoice export in QA", "Pack the climbing gym bag"
        ]);

        at(`${MON}T17:31`);
        const fix = await call("caius_winddown_apply", { date: MON, said: FIX, fates: [ { listItemId: "111", to: "w1" } ], context: [ "ZAP-2590 is open" ] });
        expect(fix.skipped).toEqual([]);
        expect(fix.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "fate", detail: "2026-W45", status: "written" }),
            expect.objectContaining({ kind: "context", status: "written" })
        ]));
        // 111 left Tuesday for the week; 101 and the bag stay on Tuesday, once each.
        expect(await tasksOf("day", TUE)).toEqual([
            { text: "ZAP-101 Verify the export retry on staging", state: "open" },
            { text: "ZAP-111 Check the invoice export in QA ~30m", state: expect.not.stringMatching(/^open$/) },
            { text: "Pack the climbing gym bag", state: "open" }
        ]);
        expect(await tasksOf("week", "2026-W45")).toEqual([ { text: "ZAP-111 Check the invoice export in QA", state: "open" } ]);
        expect((await call("caius_context", { date: TUE })).context.map((line: any) => line.text)).toContain("ZAP-2590 is open");

        const before = await journal();
        const again = await call("caius_winddown_apply", { date: MON, said: FIX, fates: [ { listItemId: "111", to: "w1" } ], context: [ "ZAP-2590 is open" ] });
        expect(again.skipped).toEqual([]);
        expect(again.written.filter((entry: any) => entry.status === "written")).toEqual([]);
        expect(await journal()).toEqual(before);

        // Put off to the week, 111 isn't offered for Tuesday the next morning.
        at(`${TUE}T09:35`);
        const inputs = await call("caius_planday", { date: TUE, step: "inputs", refresh: true });
        expect(inputs.data.candidates.map((candidate: any) => candidate.candidateId)).not.toContain("ZAP-111");
    });
});

describe("his words decide", () => {
    it("Mon 17:30: the agent's round-5 call left out '111 later this week'; the apply writes nothing and asks for a check, and the call with the fate writes it", async () => {
        const MON = "2026-11-16";
        await monday(MON);
        at(`${MON}T17:30`);
        const said = "110 is done. 111 later this week. evening laundry";
        const before = await journal();
        const checked = await call("caius_winddown_apply", { date: MON, said, done: [ "ZAP-110" ], evening: [ "Laundry" ] });
        expect(checked.written).toEqual([]);
        expect(checked.check).toEqual([ expect.objectContaining({ item: "ZAP-111 Check the invoice export in QA", said: "111 later this week", missing: "fate" }) ]);
        expect(checked.check[0].message).toContain("later this week");
        expect(await journal()).toEqual(before);

        const applied = await call("caius_winddown_apply", { date: MON, said, done: [ "ZAP-110" ], fates: [ { listItemId: "111", to: "w1" } ], evening: [ "Laundry" ] });
        expect(applied.check).toBeUndefined();
        expect(applied.skipped).toEqual([]);
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "fate", id: `${MON}-111`, detail: "2026-W47", status: "written" }),
            expect.objectContaining({ kind: "fate", id: `${MON}-101`, detail: "2026-11-17", status: "written" })
        ]));
        expect((await tasksOf("week", "2026-W47")).map((task: any) => task.text)).toEqual([ "ZAP-111 Check the invoice export in QA" ]);
    });

    it("his words never move an item: negations, questions and another item's words give a check or nothing, and checked: true writes only the proposed fates", async () => {
        const replies = [ "111 not this week", "can't do 101 friday", "should 111 go thursday?", "call mom friday", "message mom tuesday", "ZAP-111 later this week" ];
        for (const [ i, said ] of replies.entries()) {
            const MON = [ "2027-04-05", "2027-04-12", "2027-04-19", "2027-04-26", "2027-05-03", "2027-05-10" ][i] ?? "";
            const TUE = `${MON.slice(0, 8)}${String(Number(MON.slice(8)) + 1).padStart(2, "0")}`;
            await cls.init(async () => {
                const day = await store.calendarDay(MON);
                await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(
                    li(`${MON}-101`, `${zap("ZAP-101", "Verify the export retry on staging")} ~30m`),
                    li(`${MON}-111`, `${zap("ZAP-111", "Check the invoice export in QA")} ~30m`),
                    li(`${MON}-dave`, "Message Dave about the lights"),
                    li(`${MON}-plumber`, "Call the plumber")
                )}`);
            });
            at(`${MON}T17:30`);
            const first = await call("caius_winddown_apply", { date: MON, said });
            expect(first.check?.length, said).toBeGreaterThan(0);
            expect(first.written, said).toEqual([]);
            const second = await call("caius_winddown_apply", { date: MON, said, checked: true });
            expect(second.check, said).toBeUndefined();
            expect(second.written.filter((entry: any) => entry.kind === "fate").map((entry: any) => entry.detail), said).toEqual([ TUE, TUE, TUE, TUE ]);
        }
    });

    it("nothing is dismissed without his word: 'don't dismiss 105' or 'fine' leaves Jordan's ask on the shelf; 'answered jordan in chat' dismisses it", async () => {
        const DAY = "2026-11-18";
        const ask = () => jira.asks.push({
            ticket: ticket("ZAP-105", { summary: "Confirm the staging bucket name" }), author: "Jordan Placeholder", created: "2026-11-15T15:00:00.000-0500",
            commentId: "c105", excerpt: "@Sam Example the rollout note is in the runbook now."
        });
        ask();
        at(`${DAY}T09:40`);
        const refused = await call("caius_plan_apply", { date: DAY, said: "fine. and don't dismiss 105", dismiss: [ { candidateId: "ZAP-105" } ], brief: prose });
        expect(refused.skipped).toEqual([ expect.objectContaining({ kind: "dismiss", id: "ZAP-105", reason: "not_his_word" }) ]);
        expect((await call("caius_plan", { period: "day", date: DAY })).suggested.map((task: any) => task.text)).toEqual([ expect.stringContaining("ZAP-105") ]);

        const dismissed = await call("caius_plan_apply", { date: DAY, said: "answered jordan in chat", dismiss: [ { candidateId: "ZAP-105" } ], brief: prose });
        expect(dismissed.skipped).toEqual([]);
        expect(dismissed.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "dismiss", id: "ZAP-105", status: "written" }) ]));
    });
});

describe("answered in Chat", () => {
    const jordan = (commentId: string, created: string) => jira.asks.push({
        ticket: ticket("ZAP-205", { summary: "Confirm the staging bucket name" }), author: "Jordan Placeholder", created,
        commentId, excerpt: "@Sam Example the rollout note is in the runbook now."
    });

    it("Tue 09:35 'answered jordan in chat' closes the Follow up for good: not at 11:05, not two weeks on, back only with a newer comment", async () => {
        const MON = "2026-11-23";
        const TUE = "2026-11-24";
        jordan("c205", "2026-11-22T15:00:00.000-0500");
        at(`${MON}T09:40`);
        await call("caius_plan_apply", { date: MON, said: "evening just mom", brief: prose });

        at(`${TUE}T09:35`);
        expect((await call("caius_planday", { date: TUE, step: "inputs", refresh: true })).data.followUps.map((f: any) => f.key)).toEqual([ "ZAP-205" ]);
        // The agent's round-5 call: no dismiss, only his words.
        const planned = await call("caius_plan_apply", {
            date: TUE, said: "111 not today. answered jordan in chat. ZAP-2590 is open, Jira's Done is wrong", context: [ "ZAP-2590 is open" ], brief: prose
        });
        expect(planned.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "dismiss", id: "ZAP-205", status: "written" }) ]));
        expect(await cls.init(() => store.content(planned.briefNoteId))).not.toContain("ZAP-205");

        at(`${TUE}T11:05`);
        expect((await call("caius_planday", { date: TUE, step: "inputs", refresh: true })).data.followUps).toEqual([]);
        const refreshed = await call("caius_plan_apply", { date: TUE, said: "", brief: prose });
        expect(await cls.init(() => store.content(refreshed.briefNoteId))).not.toContain("ZAP-205");

        at("2026-12-09T09:45");
        const later = await call("caius_planday", { date: "2026-12-09", step: "inputs", refresh: true });
        expect(later.data.followUps).toEqual([]);
        expect(later.data.candidates.map((c: any) => c.candidateId)).not.toContain("ZAP-205");

        jordan("c206", "2026-12-08T15:00:00.000-0500");
        // A newer comment is a new ask: offered again, first as a candidate.
        expect((await call("caius_planday", { date: "2026-12-09", step: "inputs", refresh: true })).data.candidates.map((c: any) => c.candidateId)).toContain("ZAP-205");
    });
});

describe("the overlap answer", () => {
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

    it("Wed 17:45 'incident review': Thursday's Context says so, its Meetings, drawing and capacity drop Vendor Onboarding, and nothing is asked again", async () => {
        const WED = "2027-01-06";
        const THU = "2027-01-07";
        calendars[THU] = [ event("10:00", "10:15", "Daily Standup"), event("10:30", "11:30", "Incident Review"), event("11:00", "12:00", "Vendor Onboarding") ];
        at(`${WED}T17:45`);
        const next = await call("caius_winddown", { date: WED, step: "next" });
        expect(next.question).toContain("Incident Review overlaps Vendor Onboarding at 11:00");
        // The agent's round-5 call: his answer only in his words.
        const wound = await call("caius_winddown_apply", { date: WED, said: "111, 101 and the bag are done. incident review. evening iron shirts", evening: [ "Iron shirts" ] });
        expect(wound.skipped).toEqual([]);
        expect(wound.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "overlap", detail: "Incident Review", status: "written" }) ]));
        expect((await call("caius_context", { date: THU })).context).toEqual([ expect.objectContaining({ text: "Taking Incident Review, not Vendor Onboarding, at 11:00", period: "day" }) ]);

        at(`${THU}T09:30`);
        const inputs = await call("caius_planday", { date: THU, step: "inputs", refresh: true });
        expect(inputs.data.overlaps).toEqual([]);
        expect(inputs.data.meetings.lines).toEqual([ "10:00 Daily Standup", "10:30 Incident Review" ]);
        expect(inputs.data.headsUp).toEqual([ "Taking Incident Review, not Vendor Onboarding, at 11:00" ]);
        expect(inputs.data.capacity.bookedMinutes).toBe(75);
        const planned = await call("caius_plan_apply", { date: THU, said: "", brief: prose });
        const brief = await cls.init(() => store.content(planned.briefNoteId));
        expect(brief).toContain("Taking Incident Review, not Vendor Onboarding, at 11:00");
        const drawing = String(cls.init(() => becca.getNoteOrThrow(planned.headerNoteId).getAttachments().find((a) => a.title === "terrain.svg")?.getContent()));
        expect(drawing).toContain("Incident Review");
        expect(drawing).not.toContain("Vendor Onboarding");
        delete calendars[THU];
    });
});

describe("the header follows the drawing", () => {
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });
    const headerOf = (noteId: string) => cls.init(() => store.content(noteId));
    const handoffs = () => jira.handoff.push(
        { ...ticket("ZAP-310", { summary: "Review the import mapper change", status: "Code Review" }), daysInStatus: 2 },
        { ...ticket("ZAP-311", { summary: "Check the invoice export in QA", status: "QA Testing" }), daysInStatus: 3 },
        { ...ticket("ZAP-301", { summary: "Verify the export retry on staging", status: "Dev Verify" }), daysInStatus: 6 }
    );

    it("Mon 09:40 'put 101 first': the headline is rewritten, and the acts group whole tasks, with no dangling ', then' and the drawing's times", async () => {
        const MON = "2027-01-11";
        calendars[MON] = [ event("10:00", "10:15", "Daily Standup"), event("11:00", "12:00", "Sprint Planning") ];
        handoffs();
        at(`${MON}T09:40`);
        const planned = await call("caius_plan_apply", {
            date: MON, said: "take 310, 311 and 301", accept: [ { candidateId: "310" }, { candidateId: "311" }, { candidateId: "301" } ],
            brief: { headline: "Clear the review and QA check before verifying the export retry on staging.", acts: [
                { range: "10:00 to 11:00", text: "Standup and Sprint Planning open the day." },
                { range: "11:00 to 14:00", text: "Review the import mapper, check the invoice export in QA, then verify the export retry on staging." }
            ], sections: [] }
        });
        expect(planned.skipped).toEqual([]);
        at(`${MON}T09:41`);
        const moved = await call("caius_plan_apply", { date: MON, said: "put 301 first", move: [ { listItemId: "301", first: true } ] });
        expect(moved.skipped).toEqual([]);
        const header = await headerOf(planned.headerNoteId);
        expect(header).not.toContain("Clear the review");
        expect(header).toContain("ZAP-301 first, then ZAP-310 and ZAP-311.");
        expect(header).toContain("<td><p><strong>10:15 to 12:15</strong></p><p>ZAP-301, then ZAP-310.</p></td>");
        expect(header).toContain("<td><p><strong>12:15 to 12:45</strong></p><p>ZAP-311.</p></td>");
        expect(header).not.toContain("<p>, then");

        // A headline sent with the move is written as sent.
        await call("caius_plan_apply", { date: MON, said: "310 first", move: [ { listItemId: "310", first: true } ], headline: "Review the mapper, then the two export checks." });
        expect(await headerOf(planned.headerNoteId)).toContain("Review the mapper, then the two export checks.");

        // At the wind-down the closed day's header is drawn as worked: acts from the drawing, never the morning's.
        at(`${MON}T17:30`);
        const wound = await call("caius_winddown_apply", { date: MON, said: "310 is done", done: [ "310" ] });
        expect(wound.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "header", detail: MON, status: "written" }) ]));
        expect(await headerOf(planned.headerNoteId)).toContain("<p>ZAP-310.</p>");
        delete calendars[MON];
    });

    it("Tue 09:35: an act that names other work than the drawing puts in its span is written from the drawing; one that names its work keeps its words", async () => {
        const TUE = "2027-01-19";
        calendars[TUE] = [ event("09:30", "09:45", "Team Standup"), event("10:00", "10:30", "Weekly Planning Sync"), event("11:00", "11:30", "Customer Call") ];
        await cls.init(async () => {
            const day = await store.calendarDay(TUE);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("t-101", `${zap("ZAP-401", "Verify the export retry on staging")} ~30m`), li("t-dave", "Message Dave ~30m"))}`);
        });
        at(`${TUE}T09:35`);
        // The agent's round-5 acts, with only two given.
        const planned = await call("caius_plan_apply", { date: TUE, said: "", brief: { headline: "Verify the export retry and message Dave.", acts: [
            { range: "09:30 to 12:00", text: "Standup, Weekly Planning Sync, then the Customer Call back to back." },
            { range: "12:00 to 18:00", text: "Verify the ZAP-401 export retry on staging and message Dave about the lights." }
        ], sections: [] } });
        expect(planned.skipped).toEqual([]);
        const header = await headerOf(planned.headerNoteId);
        expect(header).toContain("<td><p><strong>10:30 to 11:00</strong></p><p>ZAP-401.</p></td>");
        expect(header).toContain("<td><p><strong>11:30 to 12:00</strong></p><p>Message Dave.</p></td>");
        expect(header).not.toContain("12:00 to 18:00");

        const kept = await call("caius_plan_apply", { date: TUE, said: "", brief: { headline: "Verify the export retry and message Dave.", acts: [
            { range: "10:00 to 12:00", text: "Verify the ZAP-401 export retry after the sync." },
            { range: "12:00 to 18:00", text: "Message Dave about the lights after the Customer Call." }
        ], sections: [] } });
        expect(await headerOf(kept.headerNoteId)).toContain("<td><p><strong>10:30 to 11:00</strong></p><p>Verify the ZAP-401 export retry after the sync.</p></td>"
            + "<td><p><strong>11:30 to 12:00</strong></p><p>Message Dave about the lights after the Customer Call.</p></td>");
        delete calendars[TUE];
    });
});

describe("one capacity figure", () => {
    const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

    it("the steps word the capacity with the focus the Plan tab shows: 3–4 h on a light day, the smaller figure on a heavy one", async () => {
        const MON = "2027-02-01";
        const THU = "2027-02-04";
        calendars[MON] = [ event("10:00", "10:15", "Daily Standup"), event("11:00", "12:00", "Sprint Planning"), event("14:00", "14:30", "1:1 with Riley") ];
        calendars[THU] = [
            event("10:00", "10:15", "Daily Standup"), event("10:30", "11:30", "Incident Review"), event("11:00", "12:00", "Vendor Onboarding"),
            event("13:00", "14:00", "Roadmap Review"), event("14:00", "15:00", "Design Workshop"), event("16:00", "17:00", "Interview Panel")
        ];
        at(`${MON}T09:40`);
        const light = await call("caius_planday", { date: MON, step: "inputs", refresh: true });
        expect(light.data.capacity).toMatchObject({ focus: { min: 180, max: 240 }, sentence: "1 h 45 m of meetings and 6 h 15 m open: nothing planned against 3–4 h of focus time." });
        await call("caius_plan_apply", { date: MON, said: "", brief: prose });
        expect((await call("caius_plan", { period: "day", date: MON })).capacity.target).toEqual({ min: 180, max: 240 });

        at("2027-02-03T17:45");
        const next = await call("caius_winddown", { date: "2027-02-03", step: "next" });
        expect(next.data.capacity).toMatchObject({ focus: { min: 120, max: 120 }, sentence: "4 h 45 m of meetings and 3 h 15 m open: nothing planned against 2 h of focus time." });
        await call("caius_winddown_apply", { date: "2027-02-03", said: "nothing" });
        expect((await call("caius_plan", { period: "day", date: THU })).capacity.target).toEqual({ min: 120, max: 120 });
        delete calendars[MON];
        delete calendars[THU];
    });
});

describe("the wind-down's last question", () => {
    it("Mon 17:30 with nothing to keep or carry: the context step still asks 'anything to add?', in one line", async () => {
        at("2027-02-08T17:30");
        const context = await call("caius_winddown", { date: "2027-02-08", step: "context" });
        expect(context.data.noticed).toEqual([]);
        expect(context.question).toBe("Anything to add for Tuesday?");
    });
});

describe("a Review goes straight on", () => {
    it("Wed 11 09:45 'carry it', 'nothing': the Review's apply returns today's plan steps already run, with the evening it heard not asked again", async () => {
        const MON = "2027-02-15";
        const WED = "2027-02-17";
        await cls.init(async () => {
            const day = await store.calendarDay(MON);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("r5-dave", "Message Dave about the lights"))}`);
        });
        at(`${WED}T09:45`);
        const wound = await call("caius_winddown_apply", { date: MON, said: "nothing", evening: [] });
        expect(wound.next).toBe("planday");
        expect(wound.planday.catchup).toMatchObject({ step: "catchup", date: WED, question: null });
        expect(wound.planday.inputs).toMatchObject({ step: "inputs", date: WED, question: null });
        expect(wound.planday.inputs.data.list.map((item: any) => item.text)).toEqual([ "Message Dave about the lights" ]);
    });
});

describe("'fine' takes what was offered", () => {
    it("a vague yes accepts the candidates in the order shown, in Plan my day and in a wind-down, and is never read as a skip", async () => {
        const DAY = "2027-03-01";
        jira.handoff.push(
            { ...ticket("ZAP-501", { summary: "Check the report" }), daysInStatus: 2 },
            { ...ticket("ZAP-502", { summary: "Fix the gate" }), daysInStatus: 3 }
        );
        at(`${DAY}T09:40`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(inputs.data.candidates.map((c: any) => c.candidateId)).toEqual([ "ZAP-501", "ZAP-502" ]);
        // The agent passes nothing but his word.
        const planned = await call("caius_plan_apply", { date: DAY, said: "fine", brief: prose });
        expect(planned.skipped).toEqual([]);
        expect((await tasksOf("day", DAY)).map((task: any) => task.text)).toEqual([ "ZAP-501 Check the report", "ZAP-502 Fix the gate" ]);

        jira.handoff.push({ ...ticket("ZAP-503", { summary: "Ship the fix" }), daysInStatus: 1 });
        at(`${DAY}T17:30`);
        await call("caius_winddown_apply", { date: DAY, said: "501 and 502 are done, the rest is fine", done: [ "501", "502" ], asOffered: true });
        expect((await tasksOf("day", "2027-03-02")).map((task: any) => task.text)).toEqual([ "ZAP-503 Ship the fix" ]);
    });
});

describe("a correction after the plan", () => {
    it("Tue 09:40 'oh, I answered jordan in chat' after the plan: one more plan apply with said, the answer and the brief again; a bare one is refused; a repeat changes nothing", async () => {
        const DAY = "2027-03-09";
        jira.asks.push({
            ticket: ticket("ZAP-605", { summary: "Confirm the bucket" }), author: "Jordan Placeholder", created: "2027-03-01T15:00:00.000-0500",
            commentId: "c605", excerpt: "Is the bucket name right?"
        });
        at("2027-03-08T09:40");
        await call("caius_plan_apply", { date: "2027-03-08", said: "nothing today", brief: prose });
        at(`${DAY}T09:40`);
        const planned = await call("caius_plan_apply", { date: DAY, said: "no", brief: prose });
        expect(await cls.init(() => store.content(planned.briefNoteId))).toContain("ZAP-605");

        await expect((async () => call("caius_plan_apply", { date: DAY, said: "oh, I answered jordan in chat", dismiss: [ { candidateId: "ZAP-605" } ] }))()).rejects.toThrow(/Give brief/);
        const fixed = await call("caius_plan_apply", { date: DAY, said: "oh, I answered jordan in chat", dismiss: [ { candidateId: "ZAP-605" } ], brief: prose });
        expect(fixed.written).toEqual(expect.arrayContaining([ expect.objectContaining({ kind: "dismiss", id: "ZAP-605", status: "written" }) ]));
        expect(await cls.init(() => store.content(fixed.briefNoteId))).not.toContain("ZAP-605");

        const before = await journal();
        const again = await call("caius_plan_apply", { date: DAY, said: "oh, I answered jordan in chat", dismiss: [ { candidateId: "ZAP-605" } ], brief: prose });
        expect(again.written.filter((entry: any) => entry.status === "written")).toEqual([]);
        expect(await journal()).toEqual(before);
    });
});
