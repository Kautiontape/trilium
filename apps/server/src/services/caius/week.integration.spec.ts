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
        const added = await call("caius_add", { items: [ { date: TUE, suggested: true, text: "Get ZAP-101 verified", source: "ZAP-101" } ] });
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
        const added = await call("caius_add", { items: [ { date: TUE, suggested: true, text: "Get ZAP-112 Check the report job done", source: "ZAP-112" } ] });
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
