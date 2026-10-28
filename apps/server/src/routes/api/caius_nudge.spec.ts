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
            tasks: [
                { noteId: noteIds.friday, listItemId: "f1", text: "Left over" },
                { noteId: noteIds.friday, listItemId: "f2", text: "Also open" }
            ]
        });
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

        expect((await nudge("2033-03-13").expect(200)).body).toEqual({ date: "2033-03-13", state: "unplanned", lastWorkday: "2033-03-11" });
        expect(Object.keys(becca.notes).length).toBe(before);

        await nudge("2033-02-30").expect(400);
        await skip("not-a-date").expect(400);
    });
});
