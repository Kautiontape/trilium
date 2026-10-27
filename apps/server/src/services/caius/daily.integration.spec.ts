import { dayCapacity } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const FRIDAY = "2026-11-06";
const MONDAY = "2026-11-09";

const event = (start: string, end: string, title: string, o: Partial<CalendarEvent> = {}): CalendarEvent => ({
    start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ], ...o
});

/** What the stubbed `caius_inputs` answers, by date; a missing date answers an empty day. */
const calendars: Record<string, CalendarEvent[]> = {};
const calendarErrors: Record<string, CaiusInputs["errors"]> = {};
const inputsCalls: InputsInput[] = [];

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    inputsCalls.push(input);
    const calendar = calendars[input.date] ?? [];
    return {
        date: input.date,
        jira: { handoff: [], asks: [], done: [] },
        calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }),
        errors: calendarErrors[input.date] ?? []
    };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

async function dayNoteId(date: string): Promise<string | undefined> {
    return cls.init(async () => (await store.search(`#dateNote="${date}"`))[0]?.noteId);
}

beforeAll(async () => {
    await sql_init.dbReady;
    vi.stubEnv("CAIUS_NOW", `${FRIDAY}T17:30`);

    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(FRIDAY), (await store.search("#calendarRoot"))[0]);
        await store.addLabel(calendarRoot!.noteId, "enableWeekNote", "");
        const friday = await store.calendarDay(FRIDAY);
        await store.putContent(friday.noteId, `<h3>Work</h3>${ul(li("f1", "Friday thing"))}`);
    });
});

afterAll(() => {
    vi.unstubAllEnvs();
});

describe("caius_meetings", () => {
    it("writes the calendar's meetings as clock lines, dry run first, creating the day note only for real", async () => {
        calendars[MONDAY] = [
            event("10:00", "10:15", "Standup", { attendees: [ "Sam Example", "Riley Sample" ] }),
            event("11:00", "12:00", "Skipped", { declined: true }),
            event("12:00", "13:00", "Release call", { overlap: true }),
            event("12:30", "13:00", "Review", { overlap: true })
        ];
        const lines = [ "10:00 Standup (Sam, Riley)", "12:00 Release call (overlaps)", "12:30 Review (overlaps)" ];

        const dry = await call("caius_meetings", { date: MONDAY, dryRun: true });
        expect(dry).toMatchObject({ date: MONDAY, source: "calendar", lines });
        expect(dry.results[0]).toMatchObject({ status: "dry-run", added: expect.stringContaining("10:00 Standup (Sam, Riley)") });
        expect(dry.results[0]).not.toHaveProperty("after");
        expect(await dayNoteId(MONDAY)).toBeUndefined();

        const real = await call("caius_meetings", { date: MONDAY });
        expect(real.results[0]).toMatchObject({ status: "updated", detail: "created the day note" });
        const noteId = await dayNoteId(MONDAY);
        expect(noteId).toBeDefined();
        const html = await cls.init(() => store.content(noteId ?? ""));
        expect(html).toContain("<h3>Meetings</h3><ul><li");
        expect(html).toContain("12:30 Review (overlaps)</li></ul>");
    });

    it("writes the items it is given instead of the calendar's", async () => {
        const answer = await call("caius_meetings", { date: MONDAY, items: [ "09:30 Early call" ] });
        expect(answer).toMatchObject({ source: "items", lines: [ "09:30 Early call" ], results: [ { status: "updated" } ] });
        const html = await cls.init(async () => store.content((await dayNoteId(MONDAY)) ?? ""));
        expect(html).toContain("09:30 Early call");
        expect(html).not.toContain("Standup");
    });

    it("writes nothing when the calendar could not be read", async () => {
        calendarErrors["2026-11-10"] = [ { source: "calendar", error: "feed_0_http_404" } ];
        const answer = await call("caius_meetings", { date: "2026-11-10" });
        expect(answer).toMatchObject({ status: "skipped", reason: "calendar_unavailable", errors: [ { source: "calendar", error: "feed_0_http_404" } ] });
        expect(await dayNoteId("2026-11-10")).toBeUndefined();
    });
});

describe("caius_context_add", () => {
    it("writes a line with its until to the next workday's note, creating the note, and skips a duplicate", async () => {
        const dry = await call("caius_context_add", { date: "2026-11-11", text: "Release frozen", until: "2026-11-13", dryRun: true });
        expect(dry.results[0]).toMatchObject({ status: "dry-run", line: "Release frozen (until Fri 13 Nov)", added: expect.stringContaining("<h3>Context</h3>") });
        expect(await dayNoteId("2026-11-11")).toBeUndefined();

        const real = await call("caius_context_add", { date: "2026-11-11", text: "Release frozen", until: "2026-11-13" });
        expect(real.results[0]).toMatchObject({ status: "added", detail: "created the day note" });
        const html = await cls.init(async () => store.content((await dayNoteId("2026-11-11")) ?? ""));
        expect(html).toContain("<li data-list-item-id=");
        expect(html).toContain(">Release frozen (until Fri 13 Nov)</li>");

        expect((await call("caius_context_add", { date: "2026-11-11", text: "release frozen" })).results[0])
            .toMatchObject({ status: "skipped", reason: "duplicate" });
    });

    it("writes to a week note, and takes exactly one of date or week", async () => {
        const answer = await call("caius_context_add", { week: "2026-W46", text: "Jaco out all week" });
        expect(answer.results[0]).toMatchObject({ status: "added", line: "Jaco out all week" });
        const context = await call("caius_context", { date: "2026-11-11" });
        expect(context.context.map((line: any) => line.text)).toEqual(expect.arrayContaining([ "Jaco out all week", "Release frozen" ]));

        const schema = [ ...tools ].find(([ n ]) => n === "caius_context_add")?.[1].inputSchema;
        expect(schema?.safeParse({ text: "x" }).success).toBe(false);
        expect(schema?.safeParse({ date: MONDAY, week: "2026-W46", text: "x" }).success).toBe(false);
        expect(schema?.safeParse({ date: MONDAY, text: "x", until: "6 Nov" }).success).toBe(false);
    });
});
