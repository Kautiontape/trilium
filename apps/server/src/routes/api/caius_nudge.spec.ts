import { becca, cls } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type ApiTestContext, bootLoggedInApp } from "../../../spec/support/internal_api.js";
import { createBeccaStore, createChildNote, setLabel } from "../../services/caius/store.js";

const li = (id: string, text: string, checked = false) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${checked ? " checked=\"checked\"" : ""} disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const FRIDAY = "2033-03-04";
const MONDAY = "2033-03-07";
const TUESDAY = "2033-03-08";
const WEDNESDAY = "2033-03-09";

const store = createBeccaStore();
const noteIds: Record<string, string> = {};
let ctx: ApiTestContext;

const nudge = (date: string) => ctx.agent.get(`/api/caius/nudge?date=${date}`);
const skip = (date: string) => ctx.agent.post("/api/caius/skip-catchup").set("x-csrf-token", ctx.csrfToken).send({ date });

describe("Caius nudge route", () => {
    beforeAll(async () => {
        vi.stubEnv("TRILIUM_ENV", "dev");
        vi.stubEnv("CAIUS_NOW", `${MONDAY}T09:00`);
        ctx = await bootLoggedInApp();
        await cls.init(async () => {
            const friday = await store.calendarDay(FRIDAY);
            await store.putContent(friday.noteId, `<h3>Work</h3>${ul(li("f1", "Left over"), li("f2", "Also open"), li("f3", "Finished", true))}`);
            const monday = await store.calendarDay(MONDAY);
            await store.putContent(monday.noteId, `<h3>Work</h3>${ul(li("m1", "Monday thing", true))}`);
            const tuesday = await store.calendarDay(TUESDAY);
            await store.putContent(tuesday.noteId, `<h3>Work</h3>${ul(li("t1", "Tuesday thing"))}`);
            const brief = createChildNote(tuesday.noteId, "🌅 Morning Brief", "<p></p>");
            setLabel(brief, "morningBrief", TUESDAY);
            setLabel(brief, "caiusPlannedAt", `${TUESDAY}T08:40:00`);
            Object.assign(noteIds, { friday: friday.noteId, monday: monday.noteId, tuesday: tuesday.noteId });
        });
    });

    afterAll(() => {
        vi.unstubAllEnvs();
    });

    it("offers the catch-up of Friday's live tasks on a Monday", async () => {
        const { body } = await nudge(MONDAY).expect(200);
        expect(body).toEqual({
            date: MONDAY,
            state: "catchup",
            lastWorkday: FRIDAY,
            days: [ FRIDAY ],
            tasks: [
                { noteId: noteIds.friday, listItemId: "f1", text: "Left over" },
                { noteId: noteIds.friday, listItemId: "f2", text: "Also open" }
            ]
        });
    });

    it("covers every day since the last closed one: Thursday and Wednesday's tasks on a Friday, stopping at Tuesday's wind-down", async () => {
        await cls.init(async () => {
            for (const [ date, id ] of [ [ "2033-03-15", "s1" ], [ "2033-03-16", "s2" ], [ "2033-03-17", "s3" ] ]) {
                const day = await store.calendarDay(date as string);
                await store.putContent(day.noteId, `<h3>Work</h3>${ul(li(id as string, `Task ${id}`, id === "s1"))}`);
                if (id === "s1") setLabel(day.noteId, "caiusWoundDown", date as string);
            }
        });
        const { body } = await nudge("2033-03-18").expect(200);
        expect(body).toMatchObject({ state: "catchup", lastWorkday: "2033-03-17", days: [ "2033-03-16", "2033-03-17" ] });
        expect(body.tasks.map((task: { listItemId: string }) => task.listItemId)).toEqual([ "s2", "s3" ]);
    });

    it("flags a day whose only open tasks are held, listing them apart so Move all leaves them", async () => {
        await cls.init(async () => {
            const wed = await store.calendarDay("2033-05-04");
            await store.putContent(wed.noteId, `<h3>Work</h3>${ul(li("h1", "Check the export"), li("h2", "Verify the export"))}`);
            await store.addLabel(wed.noteId, "caiusHeld", "h1");
            await store.addLabel(wed.noteId, "caiusHeld", "h2");
            noteIds.held = wed.noteId;
        });
        const { body } = await nudge("2033-05-05").expect(200);
        expect(body).toMatchObject({ state: "catchup", lastWorkday: "2033-05-04", days: [ "2033-05-04" ], tasks: [] });
        expect(body.held).toEqual([
            { noteId: noteIds.held, listItemId: "h1", text: "Check the export" }, { noteId: noteIds.held, listItemId: "h2", text: "Verify the export" }
        ]);
    });

    it("walks past a missing day to the open one before it", async () => {
        await cls.init(async () => {
            const tue = await store.calendarDay("2033-04-05");
            await store.putContent(tue.noteId, `<h3>Work</h3>${ul(li("g1", "Open on Tuesday"), li("g2", "Also Tuesday"))}`);
        });
        const { body } = await nudge("2033-04-07").expect(200);
        expect(body).toMatchObject({ state: "catchup", lastWorkday: "2033-04-06", days: [ "2033-04-05" ] });
    });

    it("keeps a catch-up skipped from the bar skipped the next day, though the skipping day has no tasks", async () => {
        await cls.init(async () => {
            const fri = await store.calendarDay("2033-04-15");
            await store.putContent(fri.noteId, `<h3>Work</h3>${ul(li("k1", "Friday leftover"))}`);
        });
        expect((await nudge("2033-04-18").expect(200)).body).toMatchObject({ state: "catchup", days: [ "2033-04-15" ] });
        await skip("2033-04-18").expect(200);
        expect((await nudge("2033-04-19").expect(200)).body).toMatchObject({ state: "unplanned", lastWorkday: "2033-04-18" });
    });

    it("answers unplanned once the catch-up is skipped, and planned with the date and time once a brief exists", async () => {
        expect((await skip(MONDAY).expect(200)).body).toMatchObject({ date: MONDAY, status: "updated" });
        expect(becca.getNoteOrThrow(noteIds.monday).getLabelValue("caiusSkipCatchup")).toBe(MONDAY);
        expect((await nudge(MONDAY).expect(200)).body).toEqual({ date: MONDAY, state: "unplanned", lastWorkday: FRIDAY });

        // Monday's only task is done, so Tuesday has nothing to catch up.
        expect((await nudge(TUESDAY).expect(200)).body).toEqual({
            date: TUESDAY, state: "planned", lastWorkday: MONDAY, plannedAt: `${TUESDAY}T08:40:00`, plannedDate: TUESDAY, plannedTime: "08:40"
        });
    });

    it("answers wound_down with the time on a day wound down, over its plan, and without a time for a label that has none", async () => {
        const day = "2033-03-14";
        const note = await cls.init(async () => {
            const monday = await store.calendarDay(day);
            await store.putContent(monday.noteId, `<h3>Work</h3>${ul(li("w1", "Done thing", true))}`);
            const brief = createChildNote(monday.noteId, "🌅 Morning Brief", "<p></p>");
            setLabel(brief, "morningBrief", day);
            setLabel(brief, "caiusPlannedAt", `${day}T09:40:00`);
            setLabel(monday.noteId, "caiusWoundDown", `${day}T17:20:00`);
            return monday.noteId;
        });
        expect((await nudge(day).expect(200)).body).toEqual({
            date: day, state: "wound_down", lastWorkday: "2033-03-11", woundDownAt: `${day}T17:20:00`, woundDownTime: "17:20"
        });
        cls.init(() => setLabel(note, "caiusWoundDown", day));
        expect((await nudge(day).expect(200)).body).toMatchObject({ state: "wound_down", woundDownAt: null, woundDownTime: null });
    });

    it("reads a protected or non-text last workday as having no catch-up", async () => {
        const thursday = await cls.init(async () => {
            const note = await store.calendarDay("2033-03-10");
            await store.putContent(note.noteId, `<h3>Work</h3>${ul(li("h1", "Behind a password"))}`);
            return note.noteId;
        });
        becca.getNoteOrThrow(thursday).isProtected = true;
        expect((await nudge("2033-03-11").expect(200)).body).toEqual({ date: "2033-03-11", state: "unplanned", lastWorkday: "2033-03-10" });

        becca.getNoteOrThrow(thursday).isProtected = false;
        becca.getNoteOrThrow(thursday).type = "code";
        expect((await nudge("2033-03-11").expect(200)).body).toMatchObject({ state: "unplanned" });
        becca.getNoteOrThrow(thursday).type = "text";
        expect((await nudge("2033-03-11").expect(200)).body).toMatchObject({ state: "catchup" });
    });

    it("reads a day without a note as unplanned, without creating it, and refuses a bad date", async () => {
        const before = Object.keys(becca.notes).length;
        expect((await nudge(WEDNESDAY).expect(200)).body).toMatchObject({ state: "catchup", lastWorkday: TUESDAY });
        expect(Object.keys(becca.notes).length).toBe(before);

        // Friday has no note, so the catch-up walks on to Thursday's open task.
        expect((await nudge("2033-03-13").expect(200)).body).toMatchObject({ date: "2033-03-13", state: "catchup", lastWorkday: "2033-03-11" });
        expect(Object.keys(becca.notes).length).toBe(before);

        await nudge("2033-02-30").expect(400);
        await skip("not-a-date").expect(400);
    });
});
