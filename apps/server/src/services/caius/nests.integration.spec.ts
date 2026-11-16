/** Plan my day's `nests`: asks under the meeting their asker is in, and a run of one project's tasks under one item. */

import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const STANDUP_DAY = "2026-11-10";
const GARDEN_DAY = "2026-11-11";
const QUIET_DAY = "2026-11-12";
const PICK_DAY = "2026-11-13";

const jiraByDate: Record<string, JiraInputs> = {};
const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date, jira: jiraByDate[input.date] ?? { handoff: [], asks: [], done: [] }, calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: []
    };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

async function planday(date: string): Promise<any> {
    const def = [ ...tools ].find(([ name ]) => name === "caius_planday")?.[1];
    if (!def) throw new Error("caius_planday is not registered");
    vi.stubEnv("CAIUS_NOW", `${date}T08:00`);
    return cls.init(() => def.execute({ date, step: "inputs" })) as Promise<any>;
}

async function dayNote(date: string, html: string) {
    const note = await store.calendarDay(date);
    await store.putContent(note.noteId, html);
}

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const garden = createChildNote("root", "Garden", "");
        await dayNote(STANDUP_DAY, `<h3>Work</h3>${ul(li("s1", "09:30 Standup"), li("s2", "Write the report ~20m"))}`);
        await dayNote(GARDEN_DAY, `<h3>Work</h3>${ul(...[ "Prune the roses", "Water the beds", "Plant the beans" ].map((text, i) => li(`g${i}`, `${text} <a href="#root/${garden}">from Garden</a>`)))}`);
        const pick = createChildNote("root", "Garden", "<p>Beds</p>");
        await store.addLabel(pick, "status", "active");
        await store.addLabel(pick, "priorityGroup", "Growth");
        await dayNote(PICK_DAY, `<h3>Work</h3>${ul(...[ "Prune the roses", "Water the beds", "Plant the beans" ].map((text, i) => li(`k${i}`, `🌱 Garden: ${text}`)))}`);
        await dayNote(QUIET_DAY, `<h3>Work</h3>${ul(li("q1", "Write the report ~20m"))}`);
    });
    calendars[STANDUP_DAY] = [ {
        start: "09:30", end: "09:45", title: "Standup", attendees: [ "ana.lopez@example.com", "Ben Ortiz" ], allDay: false, declined: false, source: [ 0 ]
    } ];
    jiraByDate[STANDUP_DAY] = {
        handoff: [],
        asks: [ {
            ticket: { key: "ABC-12", summary: "Summary ABC-12", status: "Dev Verify", resolution: null, url: "https://example.atlassian.net/browse/ABC-12", assignee: "Me", updated: "2026-11-09T10:00:00.000-0500" },
            author: "Ana Lopez", created: "2026-11-09T09:00:00.000-0500", commentId: "1", excerpt: "Can you look?"
        } ],
        done: []
    };
});

afterAll(() => {
    vi.unstubAllEnvs();
});

describe("caius_planday inputs: nests", () => {
    it("offers an ask under the meeting its asker is in, and says so", async () => {
        const answer = await planday(STANDUP_DAY);
        const ask = answer.data.candidates.find((candidate: any) => candidate.kind === "ask");
        expect(answer.data.nests).toEqual([ {
            ref: "n1",
            under: { listItemId: "s1", ref: expect.stringMatching(/^l[0-9a-f]{5}$/), text: "Standup" },
            items: [ { id: "ABC-12", ref: ask.ref, text: "Answer Ana Lopez's question on ABC-12" } ],
            because: "Put 1 answer under Standup? Ana is in it.",
            reason: { kind: "meeting", meeting: "Standup", askers: [ "Ana" ] }
        } ]);
        expect(answer.question).toContain("Put 1 answer under Standup? Ana is in it.");
    });

    it("offers three tasks from one project note under one item named for it", async () => {
        const answer = await planday(GARDEN_DAY);
        expect(answer.data.nests).toMatchObject([ {
            ref: "n1", under: { text: "Garden" }, items: [ { id: "g0" }, { id: "g1" }, { id: "g2" } ],
            because: "Put the 3 Garden tasks under one Garden item?", reason: { kind: "project", project: "Garden", count: 3 }
        } ]);
        expect(answer.question).toContain("Put the 3 Garden tasks under one Garden item?");
    });

    it("offers tasks written as an active project's picks under one item named for it, with no from link", async () => {
        const answer = await planday(PICK_DAY);
        expect(answer.data.nests).toMatchObject([ {
            ref: "n1", under: { text: "Garden" }, items: [ { id: "k0" }, { id: "k1" }, { id: "k2" } ],
            because: "Put the 3 Garden tasks under one Garden item?"
        } ]);
    });

    it("offers none on a day with neither", async () => {
        const answer = await planday(QUIET_DAY);
        expect(answer.data.nests).toEqual([]);
    });
});
