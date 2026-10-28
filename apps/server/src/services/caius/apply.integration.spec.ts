/**
 * The apply tools: one call per conversation that makes every write from his answers. The day is
 * round 2's Monday (T16, Mon 2 Nov 2026).
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
const bullets = (...items: string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const FRI = "2026-10-30";
const MON = "2026-11-02";

const ticket = (key: string, summary: string, status: string): JiraTicket => ({
    key, summary, status, resolution: null, url: `https://example.atlassian.net/browse/${key}`,
    assignee: "Me", updated: "2026-10-27T10:00:00.000-0400"
});

const jira: JiraInputs = {
    handoff: [
        { ...ticket("ZAP-101", "Verify the export retry on staging", "Dev Verify"), daysInStatus: 6 },
        { ...ticket("ZAP-110", "Review the import mapper change", "Code Review"), daysInStatus: 2 },
        { ...ticket("ZAP-111", "Check the invoice export", "QA Testing"), daysInStatus: 3 }
    ],
    asks: [ {
        ticket: ticket("ZAP-105", "Confirm the staging bucket name", "In Progress"), author: "Jordan Placeholder",
        created: "2026-11-01T15:00:00.000Z", commentId: "50", excerpt: "The rollout note is now in the runbook."
    } ],
    done: []
};
const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });
const calendars: Record<string, CalendarEvent[]> = {
    [MON]: [ event("10:00", "10:15", "Standup"), event("10:45", "12:00", "Sprint Planning"), event("18:00", "18:30", "Call Mom") ]
};

async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    const calendar = calendars[input.date] ?? [];
    return { date: input.date, jira, calendar, capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const weatherCalls: unknown[][] = [];
const tools = createCaiusTools(undefined, async (...args: unknown[]) => {
    weatherCalls.push(args);
    return { code: 3, label: "Overcast" };
}, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

const at = (stamp: string) => vi.stubEnv("CAIUS_NOW", stamp);
const notes: Record<string, string> = {};

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li><li>Bedtime: 23:00.</li><li>Location for the weather: 39.95, -75.17</li></ul>"
    + "<h2>Brief rules</h2><ul><li>Open time is work time.</li></ul>";

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        await store.addLabel(createChildNote("root", "🧭 How I work", STANDING), "assistantContext", "");
        const friday = await store.calendarDay(FRI);
        await store.putContent(friday.noteId, `<h2>☑️ Tasks</h2>${ul(li("fd1", "Message Dave about hanging lights"))}`);
        notes.friday = friday.noteId;
        const w44 = await store.calendarWeek("2026-W44");
        await store.putContent(w44.noteId, `<h3>Context</h3>${bullets("ZAP-2590 is open; Jira&#39;s Done is a mistake.", "Jaco out all week.")}`);
        const w45 = await store.calendarWeek("2026-W45");
        await store.putContent(w45.noteId, `<h2>☑️ Tasks</h2>${ul(li("wk1", "Tidy the backlog ~45m"))}`);
        notes.w45 = w45.noteId;
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

/** Every note's content, by noteId, to compare a re-run against. */
const snapshot = () => cls.init(() => Object.fromEntries(Object.values(becca.notes).map((note) => [ note.noteId, note.blobId ])));

describe("caius_plan_apply", () => {
    let input: any;

    it("Mon 09:40: one call does the catch-up, his accepts in order, the keep, the evening, the Context, the Meetings and the brief", async () => {
        at(`${MON}T09:40`);
        const catchup = await call("caius_planday", { date: MON, step: "catchup" });
        expect(catchup.data.tasks.map((task: any) => task.listItemId)).toEqual([ "fd1" ]);
        const inputs = await call("caius_planday", { date: MON, step: "inputs" });
        const ids = inputs.data.candidates.map((c: any) => c.candidateId);
        expect(ids).toEqual(expect.arrayContaining([ "ZAP-101", "ZAP-110", "ZAP-111", "ZAP-105" ]));
        const keep = inputs.data.carry.find((line: any) => line.line.startsWith("ZAP-2590"));
        expect(keep).toBeDefined();

        input = {
            date: MON,
            catchup: "move_all",
            accept: [ { candidateId: "ZAP-111" }, { candidateId: "ZAP-101" } ],
            keep: [ { lineId: keep.lineId } ],
            finished: [],
            notToday: [ { candidateId: "ZAP-110" } ],
            evening: [ "Laundry" ],
            context: [ "Riley covers the deploy today" ],
            brief: {
                headline: "Two hand-offs around Sprint Planning",
                acts: [ { range: "10:00 to 12:00", text: "Standup, then ZAP-111 before planning." }, { range: "12:00 to 18:00", text: "ZAP-101 after lunch." }, { range: "Evening", text: "Call Mom, then laundry." } ],
                sections: [ { title: "Heads-up", markdown: "Sprint Planning runs long." }, { title: "Follow up", markdown: "Jordan said something about a runbook." } ]
            }
        };
        weatherCalls.length = 0;
        const result = await call("caius_plan_apply", input);
        expect(result.error).toBeUndefined();
        expect(result.skipped).toEqual([]);
        expect(result.written.map((w: any) => [ w.kind, w.id ?? null ])).toEqual([
            [ "catchup", "fd1" ],
            [ "accept", "ZAP-111" ],
            [ "accept", "ZAP-101" ],
            [ "keep", keep.lineId ],
            [ "not_today", "ZAP-110" ],
            [ "suggested", "ZAP-105" ],
            [ "evening", null ],
            [ "context", null ],
            [ "meetings", null ],
            [ "brief", null ]
        ]);

        const plan = await call("caius_plan", { period: "day", date: MON });
        const main = plan.sections.filter((section: any) => section.name !== "Evening").flatMap((section: any) => section.tasks.map((task: any) => task.text));
        expect(main).toEqual([ expect.stringMatching(/^Message Dave about hanging lights \[from Friday 30\]/), expect.stringContaining("ZAP-111"), expect.stringContaining("ZAP-101") ]);
        expect(plan.sections.find((section: any) => section.name === "Evening")?.tasks.map((task: any) => task.text)).toEqual([ "Laundry" ]);
        expect(plan.suggested.map((task: any) => task.text)).toEqual([ expect.stringContaining("ZAP-105") ]);
        expect(plan.meetings).toEqual([ "10:00 Standup", "10:45 Sprint Planning", "18:00 Call Mom" ]);
        expect(plan.context.map((line: any) => line.text)).toEqual([ "Riley covers the deploy today" ]);
        const dayNote = await cls.init(() => store.note(plan.noteId));
        expect(dayNote.attributes.filter((a) => a.name === "caiusNotToday").map((a) => a.value)).toEqual([ "ZAP-110" ]);
        expect((await call("caius_plan", { period: "week", date: "2026-W45" })).context.map((line: any) => line.text))
            .toEqual([ "ZAP-2590 is open; Jira's Done is a mistake." ]);

        // The brief: picks from his list in its order, the tool's Follow up in place of the agent's, the weather from the standing note.
        expect(weatherCalls).toEqual([ [ 39.95, -75.17, MON ] ]);
        const brief = await cls.init(() => store.content(result.briefNoteId));
        expect(brief).toContain("Message Dave about hanging lights (~30m)");
        expect(brief).toContain("ZAP-111 Check the invoice export: because sitting in QA Testing for 3 days (~30m)");
        expect(brief.indexOf("ZAP-111")).toBeLessThan(brief.indexOf("ZAP-101"));
        expect(brief).not.toContain("Laundry");
        expect(brief).toContain("Jordan Placeholder asked on Sunday: \"The rollout note is now in the runbook.\" (ZAP-105). If you already answered in Chat, dismiss this.");
        expect(brief).not.toContain("something about a runbook");
        expect(brief).toContain("Sprint Planning runs long.");
        const header = await cls.init(() => store.content(result.headerNoteId));
        expect(header).toContain("Two hand-offs around Sprint Planning");
        const svg = String(await cls.init(() => becca.getAttachmentOrThrow(result.attachmentId).getContent()));
        expect(svg).toContain("data-part=\"weather\"");
        expect(svg).toContain(">Call Mom</text>");
        expect(result).toMatchObject({ date: MON, dateLabel: "Mon 2 Nov", plannedAt: `${MON}T09:40:00`, headline: "Two hand-offs around Sprint Planning" });
    });

    it("Mon 09:40: running it again with the same answers changes no note", async () => {
        at(`${MON}T09:40`);
        const before = await snapshot();
        const again = await call("caius_plan_apply", input);
        expect(again.skipped).toEqual([]);
        expect(again.written.filter((w: any) => w.status !== "unchanged").map((w: any) => w.kind)).toEqual([]);
        expect(await snapshot()).toEqual(before);
    });

    it("says what it skipped and why, and writes the rest", async () => {
        at(`${MON}T10:30`);
        const result = await call("caius_plan_apply", {
            ...input,
            accept: [ { candidateId: "ZAP-999" } ],
            forward: [ { listItemId: "nope", to: "2026-11-03" } ],
            notToday: [], keep: [], evening: [], context: []
        });
        expect(result.skipped).toEqual([
            expect.objectContaining({ kind: "accept", id: "ZAP-999", reason: "not_offered" }),
            expect.objectContaining({ kind: "forward", id: "nope", reason: "not_found" })
        ]);
        expect(result.written.find((w: any) => w.kind === "brief")).toBeDefined();
    });

    it("refuses a later day, as the steps do", async () => {
        at(`${MON}T09:40`);
        expect(await call("caius_plan_apply", { ...input, date: "2026-11-03" })).toMatchObject({ date: "2026-11-03", error: "not_today" });
    });
});
