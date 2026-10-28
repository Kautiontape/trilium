/**
 * The week of the first normal-user simulation (T13A, Mon 2 to Mon 9 Nov 2026), replayed through
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

const li = (id: string, text: string, o: { checked?: boolean } = {}) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${o.checked ? " checked=\"checked\"" : ""} disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const jiraLink = (key: string) => `<a href="https://example.atlassian.net/browse/${key}">${key}</a>`;

const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const MON9 = "2026-11-09";

const ticket = (key: string, o: Partial<JiraTicket> = {}): JiraTicket => ({
    key, summary: `Summary ${key}`, status: "Dev Verify", resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-10-27T10:00:00.000-0400", ...o
});

/** Jira as the simulation served it all week: every ticket still open, whatever Shawn did. */
const jira: JiraInputs = {
    handoff: [ "ZAP-101", "ZAP-105", "ZAP-110", "ZAP-111", "ZAP-112" ].map((key) => ({ ...ticket(key), daysInStatus: 6 })),
    asks: [],
    done: []
};
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

const notes: Record<string, string> = {};

async function dayNote(date: string, html: string): Promise<string> {
    const note = await store.calendarDay(date);
    await store.putContent(note.noteId, html);
    return note.noteId;
}

const sources = (answer: any): string[] => answer.data.candidates.map((c: any) => c.source);

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        notes.mon = await dayNote(MON, `<h2>☑️ Tasks</h2>${ul(
            li("m1", `${jiraLink("ZAP-105")} — Confirm the staging bucket name ~30m`),
            li("m2", `${jiraLink("ZAP-101")} — Verify the export retry on staging ~30m`),
            li("m3", `${jiraLink("ZAP-110")} — Review the import mapper change ~30m`)
        )}`);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("work he finished never comes back", () => {
    it("Mon 17:30: closing the day marks ZAP-101 done and moves the other two on", async () => {
        at(`${MON}T17:30`);
        const done = await call("caius_set_state", { items: [ { noteId: notes.mon, listItemId: "m2", state: "done" } ] });
        expect(done.results[0]).toMatchObject({ status: "updated" });
        const moved = await call("caius_forward", { items: [
            { noteId: notes.mon, listItemId: "m3", to: "2026-W45" },
            { noteId: notes.mon, listItemId: "m1", to: TUE }
        ] });
        expect(moved.results.map((r: any) => r.status)).toEqual([ "moved", "moved" ]);
    });

    it("Tue 09:35: Plan my day leaves out ZAP-101, which Jira still calls Dev Verify, and keeps the forwarded ZAP-110 on offer from the week", async () => {
        at(`${TUE}T09:35`);
        const answer = await call("caius_planday", { date: TUE, step: "inputs" });
        expect(sources(answer)).not.toContain("ZAP-101");
        expect(sources(answer)).toEqual(expect.arrayContaining([ "ZAP-111", "ZAP-112", "2026-W45" ]));
        expect(answer.data.candidates.find((c: any) => c.source === "2026-W45")?.text).toContain("ZAP-110");
    });

    it("Tue 11:05: the agent can't put ZAP-101 back in Suggested by hand", async () => {
        at(`${TUE}T11:05`);
        const added = await call("caius_add", { items: [ { date: TUE, suggested: true, key: "ZAP-101", title: "Verify the export retry", because: "sitting in Dev Verify for 6 days", minutes: 45 } ] });
        expect(added.results[0]).toMatchObject({ status: "skipped", reason: "finished" });
    });

    it("Wed 17:45: a ticket he says is finished, that was never a task, leaves every list for 30 days", async () => {
        at(`${WED}T17:45`);
        const finished = await call("caius_finished", { keys: [ "ZAP-111" ] });
        expect(finished).toMatchObject({ status: "updated", keys: [ "ZAP-111" ] });
        expect(sources(await call("caius_winddown", { date: WED, step: "next" }))).not.toContain("ZAP-111");

        at("2026-12-04T09:30");
        expect(sources(await call("caius_planday", { date: "2026-12-04", step: "inputs" }))).not.toContain("ZAP-111");
        at("2026-12-05T09:30");
        expect(sources(await call("caius_planday", { date: "2026-12-05", step: "inputs" }))).toContain("ZAP-111");
    });

    it("Thu 09:30: a dismissal on Tuesday's note keeps ZAP-112 out of Friday's plan for Monday", async () => {
        at(`${THU}T09:30`);
        const added = await call("caius_add", { items: [ { date: TUE, suggested: true, key: "ZAP-112", title: "Check the report job", because: "sitting in Dev Verify for 6 days", minutes: 30 } ] });
        expect(added.results[0]).toMatchObject({ status: "added" });
        const dismissed = await call("caius_dismiss", { items: [ { noteId: added.results[0].writtenNoteId, listItemId: added.results[0].listItemId } ] });
        expect(dismissed.results[0]).toMatchObject({ status: "dismissed", key: "ZAP-112" });

        at(`${FRI}T17:20`);
        const answer = await call("caius_winddown", { date: FRI, step: "next" });
        expect(answer.targetDay).toBe(MON9);
        expect(sources(answer)).not.toContain("ZAP-112");
        expect(sources(answer)).not.toContain("ZAP-101");
    });

    it("after 14 days, a ticket done once and still open in Jira is offered again", async () => {
        at("2026-11-16T09:30");
        expect(sources(await call("caius_planday", { date: "2026-11-16", step: "inputs" }))).not.toContain("ZAP-101");
        at("2026-11-17T09:30");
        expect(sources(await call("caius_planday", { date: "2026-11-17", step: "inputs" }))).toContain("ZAP-101");
    });
});

describe("a wind-down that fits on one screen", () => {
    it("Wed 17:45: open lists today, the last three workdays and the week, and counts the 189 older overdue tasks", async () => {
        await cls.init(async () => {
            for (let day = 1; day <= 21; day++) {
                const date = `2026-10-${String(day).padStart(2, "0")}`;
                await dayNote(date, `<h3>Work</h3>${ul(...Array.from({ length: 9 }, (_, i) =>
                    li(`old${day}-${i}`, `Old overdue task ${day}.${i}: follow up on the vendor export and the long tail of the migration ~30m`)))}`);
            }
            await dayNote("2026-10-30", `<h3>Work</h3>${ul(li("f30", "Friday leftover ~30m"))}`);
            notes.wed = await dayNote(WED, `<h3>Work</h3>${ul(li("w1", "Wednesday thing ~30m"))}`);
        });
        at(`${WED}T17:45`);
        const answer = await call("caius_winddown", { date: WED, step: "open" });
        const items = answer.data.items.map((item: any) => [ item.group, item.text ]);
        expect(items).toEqual([
            [ "today", "Wednesday thing" ],
            [ "recent", "Friday leftover" ],
            [ "recent", expect.stringContaining("Confirm the staging bucket name") ],
            [ "week", expect.stringContaining("Review the import mapper change") ]
        ]);
        expect(answer.data).toMatchObject({ olderCount: 189, oldestDate: "2026-10-01" });
        expect(JSON.stringify(answer).length).toBeLessThan(20_000);
    });
});

describe("Context writes decide their own target", () => {
    const JACO = "Jaco out all week.";
    const ZAP2590 = "ZAP-2590 is open; Jira's Done is a mistake.";
    const contextOf = async (period: string, date: string) => (await call("caius_plan", { period, date })).context.map((line: any) => line.text);

    it("Mon 09:40: \"keep going\" on last week's lines writes them to week 45, not to Monday's note", async () => {
        await cls.init(async () => {
            const lastWeek = await store.calendarWeek("2026-W44");
            await store.putContent(lastWeek.noteId, `<h3>Context</h3><ul><li>${JACO}</li><li>${ZAP2590.replace("'", "&#39;")}</li></ul>`);
        });
        at(`${MON}T09:40`);
        const answer = await call("caius_planday", { date: MON, step: "inputs" });
        expect(answer.data.carry.map((c: any) => c.line).sort()).toEqual([ JACO, ZAP2590 ]);
        expect(answer.data.keepDate).toBe(MON);

        const kept = await call("caius_context_keep", { date: answer.data.keepDate, lines: answer.data.carry.map((c: any) => ({ text: c.line })) });
        expect(kept.results.map((r: any) => r.status)).toEqual([ "added", "added" ]);
        expect((await contextOf("week", "2026-W45")).sort()).toEqual([ JACO, ZAP2590 ]);
        expect(await contextOf("day", MON)).toEqual([]);
    });

    it("Fri 17:20: the wind-down carries them into week 46 for Monday", async () => {
        at(`${FRI}T17:20`);
        const answer = await call("caius_winddown", { date: FRI, step: "context" });
        expect(answer.data.keepDate).toBe(MON9);
        expect(answer.data.noticed.map((n: any) => n.line).sort()).toEqual([ JACO, ZAP2590 ]);
        expect(answer.question).toContain("into next week?");

        const kept = await call("caius_context_keep", { date: answer.data.keepDate, lines: [ { text: ZAP2590 } ] });
        expect(kept.results[0]).toMatchObject({ status: "added" });
        expect(await contextOf("week", "2026-W46")).toEqual([ ZAP2590 ]);
        expect((await call("caius_context", { date: "2026-11-10" })).context.map((line: any) => line.text)).toContain(ZAP2590);
    });

    it("caius_context_add moves a line about a ticket or a state to the week note, and keeps a line about one day on the day", async () => {
        at(`${WED}T17:45`);
        const ticketLine = await call("caius_context_add", { date: THU, text: "ZAP-2620 waits on legal" });
        expect(ticketLine.results[0]).toMatchObject({ status: "added", detail: "moved to the week note" });
        const out = await call("caius_context_add", { date: THU, text: "Riley is out on Thursday" });
        expect(out.results[0]).toMatchObject({ status: "added", detail: "moved to the week note" });
        const day = await call("caius_context_add", { date: THU, text: "Taking Incident Review over Vendor Onboarding at 11:00" });
        expect(day.results[0]).toMatchObject({ status: "added" });
        expect(day.results[0].detail).not.toBe("moved to the week note");

        expect(await contextOf("week", "2026-W45")).toEqual(expect.arrayContaining([ "ZAP-2620 waits on legal", "Riley is out on Thursday" ]));
        expect(await contextOf("day", THU)).toEqual([ "Taking Incident Review over Vendor Onboarding at 11:00" ]);
    });
});

describe("Suggested lines have one format, built by the tool", () => {
    it("writes the structured fields as \"Get KEY title done: because why (~Nm)\", with the estimate once", async () => {
        at(`${THU}T09:30`);
        const added = await call("caius_add", { items: [
            { date: THU, suggested: true, key: "ZAP-121", title: "Check the invoice export in QA", because: "because sitting in QA Testing for 3 days", minutes: 30 },
            { date: THU, suggested: true, title: "Book the venue", because: "the quote expires Friday", minutes: 15 }
        ] });
        expect(added.results.map((r: any) => r.status)).toEqual([ "added", "added" ]);
        const suggested = (await call("caius_plan", { period: "day", date: THU })).suggested.map((task: any) => task.text.replace(/\]\([^)]*\)/g, "]"));
        expect(suggested).toEqual([
            "Get [ZAP-121] Check the invoice export in QA done: because sitting in QA Testing for 3 days (~30m)",
            "Get Book the venue done: because the quote expires Friday (~15m)"
        ]);
    });

    it("rejects the four formats T13A's Suggested lines came in, and an estimate given twice", async () => {
        // The schema throws before the tool returns a promise.
        const add = (item: object) => Promise.resolve().then(() => call("caius_add", { items: [ item ] }));
        for (const text of [
            "ZAP-101 — Verify the export retry on staging ~30m",
            "ZAP-111",
            "ZAP-111 (QA Testing, 3 days) ~30m",
            "Get ZAP-111 \"Check the invoice export in QA\" done: sitting in QA Testing for 3 days (~30m) ~30m"
        ]) {
            await expect(add({ date: THU, suggested: true, text, source: "ZAP-111" }), text).rejects.toThrow(/Get KEY title done: because why \(~30m\)/);
        }
        await expect(add({ date: THU, suggested: true, key: "ZAP-120", title: "Check it", because: "it waits", minutes: 30, est: "30m" })).rejects.toThrow(/est/);
        const shaped = await call("caius_add", { items: [ { date: THU, suggested: true, text: "Get ZAP-120 Check it done: because it waits (~30m)", source: "ZAP-120" } ] });
        expect(shaped.results[0]).toMatchObject({ status: "added" });
    });
});
