import { dayCapacity, type NoteStore } from "@triliumnext/caius";
import { becca, cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import sql from "../sql.js";
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
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
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

describe("the inputs cache", () => {
    const callsFor = (date: string) => inputsCalls.filter((input) => input.date === date).length;

    it("does not keep an answer with a failed source, keeps one with only warnings, and refreshes on request", async () => {
        calendarErrors["2026-11-17"] = [ { source: "calendar", error: "feed_0_timeout" } ];
        await call("caius_meetings", { date: "2026-11-17", dryRun: true });
        await call("caius_meetings", { date: "2026-11-17", dryRun: true });
        expect(callsFor("2026-11-17")).toBe(2);

        calendarErrors["2026-11-18"] = [ { source: "calendar", error: "feed_0_unknown_tz" }, { source: "jira", error: "asks_partial" } ];
        await call("caius_meetings", { date: "2026-11-18", dryRun: true });
        await call("caius_meetings", { date: "2026-11-18", dryRun: true });
        expect(callsFor("2026-11-18")).toBe(1);
        await call("caius_meetings", { date: "2026-11-18", dryRun: true, refresh: true });
        expect(callsFor("2026-11-18")).toBe(2);
    });

    it("serves caius_inputs from the injected reader through the same cache", async () => {
        const input = { date: "2026-11-19", context: [ "ZAP-1 is open" ] };
        const first = await call("caius_inputs", input);
        expect(first).toMatchObject({ date: "2026-11-19", errors: [] });
        expect(inputsCalls.at(-1)).toEqual(input);
        await call("caius_inputs", input);
        expect(callsFor("2026-11-19")).toBe(1);
        await call("caius_inputs", { ...input, refresh: true });
        expect(callsFor("2026-11-19")).toBe(2);
        expect(inputsCalls.at(-1)).toEqual(input);
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

        expect((await call("caius_context_add", { date: "2026-11-11", text: "release frozen", until: "2026-11-12" })).results[0])
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

describe("caius_brief_write", () => {
    const BRIEF_DAY = "2026-11-12";
    const brief = {
        date: BRIEF_DAY,
        headline: "Ship the fix, then review",
        acts: [
            { range: "10:00 to 12:00", text: "Standup, then the fix." },
            { range: "12:00 to 18:00", text: "Review around the release call." },
            { range: "Evening", text: "A walk." }
        ],
        picks: [
            { text: "Get ZAP-101 done", because: "sitting in Dev Verify for 3 days", minutes: 30 },
            { text: "Get the review done", because: "because Sam asked on Tuesday", minutes: 90 }
        ],
        sections: [
            { title: "Follow up", markdown: "**Sam** asked for the numbers." },
            { title: "Heads-up", markdown: "- Two packages shipped overnight\n\n![](https://tracker.example/pixel.png)" }
        ],
        header: {
            start: "10:00", end: "23:00",
            events: [ { start: "10:00", end: "10:15", title: "Standup" } ],
            work: [ { start: "10:15", end: "11:00", label: "ZAP-101", focus: true } ]
        }
    };
    const DAY_HTML = `<h3>Meetings</h3><ul><li data-list-item-id="em1">10:00 Standup</li></ul><h2>☑️ Tasks</h2>${ul(li("bt1", "Fix ZAP-101 ~30m"), li("bt2", "The review ~1h30m"))}`;
    let dayId = "";

    beforeAll(async () => {
        dayId = await cls.init(async () => {
            const day = await store.calendarDay(BRIEF_DAY);
            await store.putContent(day.noteId, DAY_HTML);
            return day.noteId;
        });
    });

    it("dry-runs without creating a note or an attachment", async () => {
        const dry = await call("caius_brief_write", { ...brief, dryRun: true });
        expect(dry).toMatchObject({ date: BRIEF_DAY, dryRun: true, dayNoteId: dayId, briefNoteId: null, headerNoteId: null });
        expect(dry.header).toContain("<h2>Ship the fix, then review</h2>");
        expect(dry.brief).toContain("Get ZAP-101 done: because sitting in Dev Verify for 3 days (~30m)");
        expect(becca.notes[dayId]?.getChildNotes()).toEqual([]);
    });

    it("writes the brief and its header under the day note and includes the header at the top of the day note", async () => {
        const answer = await call("caius_brief_write", brief);
        expect(answer).toMatchObject({ date: BRIEF_DAY, dayNoteId: dayId, created: { brief: true, header: true }, includeAdded: true, plannedAt: "2026-11-06T17:30:00" });

        const briefNote = becca.notes[answer.briefNoteId];
        expect(briefNote?.title).toBe("🌅 Morning Brief");
        expect(briefNote?.getParentNotes().map((n) => n.noteId)).toEqual([ dayId ]);
        expect(briefNote?.getLabelValue("morningBrief")).toBe(BRIEF_DAY);
        expect(briefNote?.getLabelValue("caiusPlannedAt")).toBe("2026-11-06T17:30:00");
        expect(briefNote?.getLabelValue("cssClass")).toBe("briefdemo");

        const header = becca.notes[answer.headerNoteId];
        expect(header?.title).toBe("Header");
        expect(header?.getParentNotes().map((n) => n.noteId)).toEqual([ answer.briefNoteId ]);
        expect(header?.getLabelValue("cssClass")).toBe("briefdemo");
        const [ attachment ] = header?.getAttachments() ?? [];
        expect(attachment).toMatchObject({ role: "image", title: "terrain.svg" });
        const headerHtml = String(header?.getContent());
        expect(headerHtml).toMatch(/^<p>Thursday · November 12 2026<\/p><h2>Ship the fix, then review<\/h2><p><img class="image_resized" style="width:100%;" src="api\/attachments\/[^/]+\/image\/terrain\.svg" alt="[^"]+"><\/p><figure class="table">/);
        expect(headerHtml.match(/<td>/g)).toHaveLength(3);

        const body = String(briefNote?.getContent());
        expect(body.startsWith(`<section class="include-note" data-note-id="${answer.headerNoteId}" data-box-size="full">&nbsp;</section><h2>Get done today</h2><ul><li`)).toBe(true);
        expect(body).toContain(">Get ZAP-101 done: because sitting in Dev Verify for 3 days (~30m)</li>");
        expect(body).toContain(">Get the review done: because Sam asked on Tuesday (~1h30m)</li>");
        expect(body).not.toContain("todo-list");
        expect(body).not.toContain("<img");
        expect(body).toMatch(/<h2>Follow up<\/h2><p><strong>Sam<\/strong> asked for the numbers\.<\/p><h2>Heads-up<\/h2><ul>/);

        const day = await cls.init(() => store.content(dayId));
        expect(day).toBe(`<section class="include-note" data-note-id="${answer.headerNoteId}" data-box-size="full">&nbsp;</section>${DAY_HTML}`);
    });

    it("updates the same notes on a re-run, replaces the planned time and adds the include-note once", async () => {
        const first = becca.notes[dayId]?.getChildNotes().find((n) => n.title === "🌅 Morning Brief");
        vi.stubEnv("CAIUS_NOW", `${FRIDAY}T18:05`);
        try {
            const again = await call("caius_brief_write", { ...brief, headline: "Review first" });
            expect(again).toMatchObject({ briefNoteId: first?.noteId, created: { brief: false, header: false }, includeAdded: false });
        } finally {
            vi.stubEnv("CAIUS_NOW", `${FRIDAY}T17:30`);
        }
        expect(becca.notes[dayId]?.getChildNotes()).toHaveLength(1);
        expect(first?.getChildNotes()).toHaveLength(1);
        expect(first?.getChildNotes()[0]?.getAttachments()).toHaveLength(1);
        expect(first?.getLabels("caiusPlannedAt").map((l) => l.value)).toEqual([ "2026-11-06T18:05:00" ]);
        expect(String(first?.getChildNotes()[0]?.getContent())).toContain("<h2>Review first</h2>");
        const day = await cls.init(() => store.content(dayId));
        expect(day.match(/class="include-note"/g)).toHaveLength(1);
    });

    it("sets the planned time only once every write went through, and refuses a protected brief or Header", async () => {
        const { briefNoteId, headerNoteId } = await call("caius_brief_write", brief);
        const before = becca.notes[briefNoteId]?.getLabelValue("caiusPlannedAt");
        const losing: NoteStore = { ...store, putContent: (id, html, expected) => id === briefNoteId ? Promise.resolve(false) : store.putContent(id, html, expected) };
        const [ , write ] = [ ...createCaiusTools(losing, async () => undefined, stubInputs) ].find(([ n ]) => n === "caius_brief_write") ?? [];
        vi.stubEnv("CAIUS_NOW", `${FRIDAY}T19:00`);
        try {
            const raced = await cls.init(() => write?.execute({ ...brief, headline: "Raced", picks: [] }) as Promise<any>);
            expect(raced).toMatchObject({ plannedAt: null });
            expect(raced.writes.find((w: any) => w.role === "brief")).toMatchObject({ status: "skipped", reason: "edited" });
        } finally {
            vi.stubEnv("CAIUS_NOW", `${FRIDAY}T17:30`);
        }
        expect(becca.notes[briefNoteId]?.getLabelValue("caiusPlannedAt")).toBe(before);

        for (const noteId of [ briefNoteId, headerNoteId ]) {
            const note = becca.notes[noteId];
            if (!note) throw new Error("missing note");
            note.isProtected = true;
            try {
                expect(await call("caius_brief_write", brief)).toMatchObject({ error: "bad_request" });
            } finally {
                note.isProtected = false;
            }
        }
    });

    it("answers unchanged for every note on an identical re-run", async () => {
        const withList = { ...brief, sections: [ ...brief.sections, { title: "List", markdown: "- one\n- two" } ] };
        await call("caius_brief_write", withList);
        const again = await call("caius_brief_write", withList);
        expect(again.writes.map((w: any) => [ w.role, w.status ])).toEqual([ [ "header", "unchanged" ], [ "brief", "unchanged" ], [ "day", "unchanged" ] ]);
    });

    it("replaces the include-note of a deleted brief or Header rather than adding a second", async () => {
        const remove = (noteId: string) => cls.init(() => sql.transactional(() => becca.notes[noteId]?.deleteNote()));
        const includes = async () => [ ...(await cls.init(() => store.content(dayId))).matchAll(/data-note-id="([^"]+)"/g) ].map((m) => m[1]);

        const first = await call("caius_brief_write", brief);
        remove(first.briefNoteId);
        const afterBrief = await call("caius_brief_write", brief);
        expect(afterBrief).toMatchObject({ created: { brief: true, header: true } });
        expect(await includes()).toEqual([ afterBrief.headerNoteId ]);

        remove(afterBrief.headerNoteId);
        const afterHeader = await call("caius_brief_write", brief);
        expect(afterHeader).toMatchObject({ briefNoteId: afterBrief.briefNoteId, created: { brief: false, header: true } });
        expect(await includes()).toEqual([ afterHeader.headerNoteId ]);
    });

    it("keeps the brief's lines out of the lanes", async () => {
        const open = await call("caius_open", {});
        expect(open.tasks.map((t: any) => t.text).join("\n")).not.toContain("Get ZAP-101 done");
        expect(open.tasks.map((t: any) => t.text)).toContain("Fix ZAP-101");
    });

    it("takes three acts, and latitude with longitude", () => {
        const schema = [ ...tools ].find(([ n ]) => n === "caius_brief_write")?.[1].inputSchema;
        expect(schema?.safeParse(brief).success).toBe(true);
        expect(schema?.safeParse({ ...brief, acts: brief.acts.slice(0, 2) }).success).toBe(false);
        expect(schema?.safeParse({ ...brief, latitude: 1 }).success).toBe(false);
    });
});

describe("caius_skip_catchup", () => {
    it("labels the day note once, creating it if missing", async () => {
        const first = await call("caius_skip_catchup", { date: "2026-11-16" });
        expect(first).toMatchObject({ date: "2026-11-16", status: "updated", created: true });
        const note = becca.notes[first.noteId];
        expect(note?.getLabelValue("dateNote")).toBe("2026-11-16");

        expect(await call("caius_skip_catchup", { date: "2026-11-16" })).toMatchObject({ noteId: first.noteId, status: "unchanged", created: false });
        expect(note?.getLabels("caiusSkipCatchup").map((l) => l.value)).toEqual([ "2026-11-16" ]);
    });
});
