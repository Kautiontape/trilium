/**
 * Areas and time blocks: Foundation (unmarked), Growth 🌱 and Recharge 🔋 under Morning, Afternoon
 * and Evening. The day is Tue 3 Nov 2026 of the design: two tickets, and the ballot and the Vincent
 * relink, which are Growth and so are not work.
 */

import { dayCapacity } from "@triliumnext/caius";
import { becca, cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, CalendarEvent, JiraInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { refOf } from "./refs.js";
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

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });
const calendars: Record<string, CalendarEvent[]> = {};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return { date: input.date, jira, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(name.endsWith("_apply") ? { said: "", ...args } : args)) as Promise<any>;
}

const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);
afterEach(() => vi.unstubAllEnvs());

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li><li>Bedtime: 23:00.</li></ul><h2>Brief rules</h2><ul><li>Open time is work time.</li></ul>";
const prose = { headline: "A day", sections: [] };

/** A day note laid out by time: `blocks` maps each heading to its to-do items. */
const dayWith = (date: string, blocks: Record<string, string[]>, tail = "") => cls.init(async () => {
    const day = await store.calendarDay(date);
    await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${Object.entries(blocks).map(([ name, items ]) => `<h3>${name}</h3>${ul(...items)}`).join("")}${tail}`);
    return day.noteId;
});

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

describe("Tue 3 Nov: two tickets, the ballot and the relink", () => {
    const tasks = {
        Morning: [ li("m1", "ZAP-2620 prod bug ~1h30m"), li("m2", "ZAP-2611 sign-offs ~1h30m") ],
        Afternoon: [ li("a1", "🌱 Drop off the ballot ~30m") ],
        Evening: [ li("e1", "🌱 Relink Vincent ~1h30m") ]
    };

    it("is not over: only the tickets are work, so Plan my day weighs 3 h against the focus target and offers no move", async () => {
        calendars[TUE] = [ event("10:00", "10:15", "Standup"), event("14:00", "15:00", "Corporate Team") ];
        await dayWith(TUE, tasks);
        at(`${TUE}T09:30`);
        const plan = await call("caius_plan", { period: "day", date: TUE });
        expect(plan.capacity).toMatchObject({ totalMinutes: 180, eveningMinutes: 120 });
        expect(plan.capacity.areas).toMatchObject({ foundation: { minutes: 180 }, growth: { minutes: 120, target: { min: 60, max: 120 } }, recharge: { minutes: 0, target: null } });
        expect(plan.sections.map((section: any) => [ section.name, section.tasks.map((task: any) => [ task.area, task.block ]) ])).toEqual([
            [ "Morning", [ [ "foundation", "morning" ], [ "foundation", "morning" ] ] ], [ "Afternoon", [ [ "growth", "afternoon" ] ] ], [ "Evening", [ [ "growth", "evening" ] ] ]
        ]);

        const inputs = await call("caius_planday", { date: TUE, step: "inputs" });
        expect(inputs.data.capacity).toMatchObject({ plannedMinutes: 180, targetMinutes: 240, focus: { min: 180, max: 240 } });
        expect(inputs.data.forwardSuggestion).toBeNull();
        expect(inputs.data.growth).toMatchObject({ minutes: 120, over: false, sentence: "Growth: 2 h planned against 1–2 h." });
        expect(inputs.data.unmarked).toEqual([]);
        expect(inputs.question).toBeNull();
        expect(inputs.data.list.map((item: any) => [ item.text, item.area, item.block ])).toEqual([
            [ "ZAP-2620 prod bug", "foundation", "morning" ], [ "ZAP-2611 sign-offs", "foundation", "morning" ],
            [ "Drop off the ballot", "growth", "afternoon" ], [ "Relink Vincent", "growth", "evening" ]
        ]);
    });

    it("Mon night: the wind-down's load for Tuesday counts the tickets alone, and asks nothing about the evening", async () => {
        at(`${MON}T17:30`);
        const next = await call("caius_winddown", { date: MON, step: "next" });
        expect(next.targetDay).toBe(TUE);
        expect(next.data.load).toMatchObject({ listMinutes: 180, over: false });
        expect(next.data.growth).toMatchObject({ minutes: 120, over: false });
        expect(next.question).toBeNull();
        expect(next.data.summary).toContain("holds 3 h of work");
    });

    it("the old reading would have been over: add the same two hours as work and the move question comes, to the next workday and never to the evening", async () => {
        const noteId = await dayWith(WED, { Morning: [ li("w1", "ZAP-3001 big one ~2h"), li("w2", "ZAP-3002 other one ~2h") ], Afternoon: [ li("w3", "ZAP-3003 and one more ~1h") ], Evening: [ li("w4", "🔋 TTRPG prep ~1h") ] });
        calendars[WED] = [ event("10:00", "14:00", "Offsite workshop") ];
        at(`${WED}T09:30`);
        expect(noteId).toBeTruthy();
        const inputs = await call("caius_planday", { date: WED, step: "inputs", refresh: true });
        // 5 h of Foundation against the 2 h or so the offsite leaves: over, and the move is the last Foundation task, to Thursday.
        expect(inputs.data.forwardSuggestion).toMatchObject({ listItemId: "w3", to: THU });
        expect(inputs.question).toBe("The day is 50% booked. Move 'ZAP-3003 and one more' to Thursday?");
        expect(inputs.question).not.toMatch(/evening/i);
        expect(inputs.data.forwardSuggestion.text).not.toContain("TTRPG");
        delete calendars[WED];
    });
});

describe("a Foundation-over day never offers the evening", () => {
    it("the wind-down's over question and the On deck overflow go to the week, and the Recharge task is never the one to move", async () => {
        calendars[FRI] = [ event("10:00", "14:00", "Planning offsite") ];
        await dayWith(FRI, {
            Morning: [ li("o1", "ZAP-4001 first ~2h") ],
            Afternoon: [ li("o2", "ZAP-4002 second ~2h") ],
            Evening: [ li("o3", "🔋 Arcade ~1h") ]
        }, `<h2>On deck</h2>${ul(li("od1", "ZAP-4003 deck work ~2h"), li("od2", "🌱 Ballot deck ~30m"))}`);
        at(`${THU}T17:30`);
        const next = await call("caius_winddown", { date: THU, step: "next" });
        expect(next.targetDay).toBe(FRI);
        expect(next.question).toMatch(/^Friday is over by about [\d.]+ h\. Which of these can wait\?$/);
        expect(next.data.load).toMatchObject({ over: true });
        // The deck's Growth item counts apart from the work.
        expect(next.data.load.onDeckMinutes).toBe(120);

        at(`${FRI}T09:30`);
        const inputs = await call("caius_planday", { date: FRI, step: "inputs", refresh: true });
        // Nothing fits the room the offsite leaves: the work goes back up to the week; the Growth item goes on the list in its block.
        expect(inputs.data.onDeck.map((item: any) => [ item.text, item.area, item.fate ])).toEqual([
            [ "ZAP-4003 deck work", "foundation", { forward: "2026-W45", forwardLabel: "the week of Mon 2 Nov" } ],
            [ "🌱 Ballot deck", "growth", { list: true } ]
        ]);
        expect(JSON.stringify([ inputs.data.forwardSuggestion, inputs.question ])).not.toMatch(/evening|Evening|Arcade/);
        // The offsite books half the day, so it is heavy: the move is the last Foundation task, to Monday, never the Recharge one.
        expect(inputs.data.forwardSuggestion).toMatchObject({ listItemId: "o2", to: "2026-11-09" });
        expect(inputs.question).toContain("Move 'ZAP-4002 second' to Monday?");
        delete calendars[FRI];
    });
});

describe("workBlocks with a pinned clock", () => {
    it("lays a Growth task at its clock in the afternoon and books that time: the open time shrinks by it, the meetings' booked time doesn't", async () => {
        const DAY = "2026-11-09";
        calendars[DAY] = [ event("10:00", "10:15", "Standup") ];
        await dayWith(DAY, {
            Morning: [ li("p1", "ZAP-5001 first ~1h") ],
            Afternoon: [ li("p2", "🌱 15:00 Drop off the ballot ~30m"), li("p3", "ZAP-5002 second ~1h") ]
        });
        at(`${DAY}T09:30`);
        const brief = await call("caius_planday", { date: DAY, step: "brief" });
        // Morning's work starts at standup's end; the pinned ballot sits at 15:00 and the afternoon's work flows around it from noon.
        expect(brief.data.list.map((item: any) => [ item.label, item.area, item.block, item.at ])).toEqual([
            [ "ZAP-5001", "foundation", "morning", null ], [ "Drop off the ballot", "growth", "afternoon", "15:00" ], [ "ZAP-5002", "foundation", "afternoon", null ]
        ]);
        const groups = brief.data.header.groups;
        expect(groups.find((group: any) => group.start === "15:00")).toMatchObject({ end: "15:30", count: 1 });
        const morning = groups.find((group: any) => group.start === "10:15");
        expect(morning).toMatchObject({ end: "11:15" });
        expect(groups.find((group: any) => group.start === "12:00")).toMatchObject({ end: "13:00" });

        const inputs = await call("caius_planday", { date: DAY, step: "inputs" });
        expect(inputs.data.capacity).toMatchObject({ bookedMinutes: 15, openMinutes: 435 });
        // Foundation work pinned at 15:00 books nothing: it is work, weighed against the target, not time away from it.
        await call("caius_set_area", { items: [ { noteId: (await call("caius_plan", { period: "day", date: DAY })).noteId, listItemId: "p2", area: "foundation" } ] });
        expect((await call("caius_planday", { date: DAY, step: "inputs", refresh: true })).data.capacity).toMatchObject({ bookedMinutes: 15, openMinutes: 465 });
        delete calendars[DAY];
    });
});

describe("the unmarked list and the areas answer", () => {
    it("lists a task with no marker, key or area heading once; foundation writes nothing and is not asked again; growth writes the marker", async () => {
        const DAY = "2026-11-10";
        await dayWith(DAY, { Morning: [ li("u1", "Drop off the ballot ~30m"), li("u2", "ZAP-6001 fix ~30m"), li("u3", "Review the sign-offs ~30m"), li("u4", "🔋 Arcade ~30m") ] });
        at(`${DAY}T09:30`);
        const inputs = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(inputs.data.unmarked).toEqual([
            { ref: refOf("l", "u1"), listItemId: "u1", text: "Drop off the ballot" }, { ref: refOf("l", "u3"), listItemId: "u3", text: "Review the sign-offs" }
        ]);
        const applied = await call("caius_plan_apply", {
            date: DAY, brief: prose,
            areas: [ { item: refOf("l", "u1"), area: "growth" }, { item: "sign-offs", area: "foundation" } ]
        });
        expect(applied.skipped).toEqual([]);
        expect(applied.written).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "area", id: "u1", detail: "growth", status: "written" }),
            expect.objectContaining({ kind: "area", id: "u3", detail: "foundation", status: "unchanged" })
        ]));
        expect(applied.say).toContain("Drop off the ballot is marked Growth");
        const plan = await call("caius_plan", { period: "day", date: DAY });
        expect(plan.sections[0].tasks.map((task: any) => [ task.text, task.area ])).toEqual([
            [ "🌱 Drop off the ballot", "growth" ], [ "ZAP-6001 fix", "foundation" ], [ "Review the sign-offs", "foundation" ], [ "🔋 Arcade", "recharge" ]
        ]);
        // Neither is asked about again, in a refresh or after the apply.
        const again = await call("caius_planday", { date: DAY, step: "inputs", refresh: true });
        expect(again.data.unmarked).toEqual([]);
        // An answer naming nothing is skipped, not written.
        const stray = await call("caius_plan_apply", { date: DAY, brief: prose, areas: [ { item: "the moon", area: "recharge" } ] });
        expect(stray.skipped).toEqual([ expect.objectContaining({ kind: "area", reason: "not_found" }) ]);
    });
});

describe("caius_add files by block and area", () => {
    const sectionsOf = async (date: string) => {
        const plan = await call("caius_plan", { period: "day", date });
        return Object.fromEntries(plan.sections.map((section: any) => [ section.name, section.tasks.map((task: any) => task.text) ]));
    };

    it("a Growth task with no place goes under Evening with its marker; a named block files it there, whatever its area", async () => {
        const DAY = "2026-11-11";
        await dayWith(DAY, { Morning: [ li("f1", "ZAP-7001 first ~30m") ] });
        const added = await call("caius_add", { items: [
            { date: DAY, area: "growth", text: "Return the library books ~30m" },
            { date: DAY, area: "recharge", block: "afternoon", text: "Walk ~30m" },
            { date: DAY, block: "evening", text: "Read" }
        ] });
        expect(added.results.map((r: any) => r.status)).toEqual([ "added", "added", "added" ]);
        expect(await sectionsOf(DAY)).toEqual({
            Morning: [ "ZAP-7001 first" ], Afternoon: [ "🔋 Walk" ], Evening: [ "🌱 Return the library books", "Read" ]
        });
    });

    it("a Foundation task goes under Morning when the note has that heading, else into the main list; no place and no area is refused", async () => {
        const WITH = "2026-11-12";
        await dayWith(WITH, { Morning: [ li("g1", "ZAP-7101 first ~30m") ], Afternoon: [ li("g2", "ZAP-7102 second ~30m") ] });
        await call("caius_add", { items: [ { date: WITH, area: "foundation", text: "ZAP-7103 third ~30m" } ] });
        expect(await sectionsOf(WITH)).toEqual({ Morning: [ "ZAP-7101 first", "ZAP-7103 third" ], Afternoon: [ "ZAP-7102 second" ] });

        const PLAIN = "2026-11-13";
        await cls.init(async () => {
            const day = await store.calendarDay(PLAIN);
            await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(li("g3", "ZAP-7201 first ~30m"))}`);
        });
        await call("caius_add", { items: [ { date: PLAIN, area: "foundation", text: "ZAP-7202 second ~30m" }, { date: PLAIN, area: "growth", text: "Ballot ~30m" } ] });
        expect(await sectionsOf(PLAIN)).toEqual({ "☑️ Tasks": [ "ZAP-7201 first", "ZAP-7202 second" ], Evening: [ "🌱 Ballot" ] });

        const schema = [ ...tools ].find(([ n ]) => n === "caius_add")?.[1].inputSchema;
        expect(schema?.safeParse({ items: [ { date: PLAIN, text: "No place" } ] }).success).toBe(false);
        expect(schema?.safeParse({ items: [ { week: "2026-W46", block: "morning", text: "A week has no blocks" } ] }).success).toBe(false);
        expect(schema?.safeParse({ items: [ { date: PLAIN, block: "morning", section: "Work", text: "Two places" } ] }).success).toBe(false);
    });
});

describe("caius_set_area", () => {
    const html = (noteId: string) => cls.init(() => store.content(noteId));

    it("writes the marker, replaces it, removes it for Foundation, and leaves an unchanged task alone", async () => {
        const DAY = "2026-11-16";
        const noteId = await dayWith(DAY, { Morning: [ li("s1", "Drop off the ballot ~30m"), li("s2", "🌱 Draft the memo ~30m") ] });
        const item = (listItemId: string, area: string) => ({ noteId, listItemId, area });
        const grown = await call("caius_set_area", { items: [ item("s1", "growth"), item("s2", "recharge") ] });
        expect(grown.results.map((r: any) => [ r.listItemId, r.status ])).toEqual([ [ "s1", "updated" ], [ "s2", "updated" ] ]);
        expect(grown.blobIds).toEqual({ [noteId]: becca.getNoteOrThrow(noteId).blobId });
        expect(await html(noteId)).toContain(">🌱 Drop off the ballot ~30m<");
        expect(await html(noteId)).toContain(">🔋 Draft the memo ~30m<");

        const removed = await call("caius_set_area", { items: [ item("s1", "foundation"), item("s2", "recharge") ] });
        expect(removed.results.map((r: any) => [ r.listItemId, r.status ])).toEqual([ [ "s1", "updated" ], [ "s2", "unchanged" ] ]);
        expect(await html(noteId)).toContain(">Drop off the ballot ~30m<");
        // A dry run reports and writes nothing.
        const before = await html(noteId);
        const dry = await call("caius_set_area", { items: [ item("s1", "growth") ], dryRun: true });
        expect(dry.results[0]).toMatchObject({ status: "updated", dryRun: true });
        expect(await html(noteId)).toBe(before);
        expect((await call("caius_set_area", { items: [ item("nope", "growth") ] })).results[0]).toMatchObject({ status: "skipped", reason: "not_found" });
    });

    it("skips a note edited between the read and the write, and nothing of it is written", async () => {
        const DAY = "2026-11-17";
        const noteId = await dayWith(DAY, { Morning: [ li("s3", "Drop off the ballot ~30m"), li("s4", "Draft the memo ~30m") ] });
        const racing = createBeccaStore();
        const putContent = racing.putContent.bind(racing);
        // Someone edits the note just before Caius writes: the compare-and-swap fails.
        racing.putContent = async (id, content, expected) => {
            await putContent(id, (await racing.content(id)).replace("Draft the memo", "Draft the memo (edited)"));
            return putContent(id, content, expected);
        };
        const fragile = createCaiusTools(racing, async () => undefined, stubInputs);
        const run = (args: object) => cls.init(() => [ ...fragile ].find(([ n ]) => n === "caius_set_area")?.[1].execute(args)) as Promise<any>;
        const raced = await run({ items: [ { noteId, listItemId: "s3", area: "growth" }, { noteId, listItemId: "s4", area: "recharge" } ] });
        expect(raced.results.map((r: any) => [ r.listItemId, r.status, r.reason ])).toEqual([ [ "s3", "skipped", "edited" ], [ "s4", "skipped", "edited" ] ]);
        const content = await html(noteId);
        expect(content).not.toContain("🌱");
        expect(content).not.toContain("🔋");
    });
});
