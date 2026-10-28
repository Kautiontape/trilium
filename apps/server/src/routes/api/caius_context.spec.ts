import { becca, cls } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type ApiTestContext, bootLoggedInApp } from "../../../spec/support/internal_api.js";
import { createBeccaStore } from "../../services/caius/store.js";

const FRIDAY = "2033-03-04";
const MONDAY = "2033-03-07";
const TUESDAY = "2033-03-08";

const store = createBeccaStore();
const noteIds: Record<string, string> = {};
let ctx: ApiTestContext;

const context = (date: string) => ctx.agent.get(`/api/caius/context?date=${date}`);

describe("Caius context route", () => {
    beforeAll(async () => {
        vi.stubEnv("TRILIUM_ENV", "dev");
        vi.stubEnv("CAIUS_NOW", `${TUESDAY}T09:00`);
        ctx = await bootLoggedInApp();
        await cls.init(async () => {
            const friday = await store.calendarDay(FRIDAY);
            await store.putContent(friday.noteId, "<h3>Context</h3><ul><li>Jaco out (until Fri 11 Mar)</li><li>Over by Monday (until Sat 5 Mar)</li></ul>");
            const monday = await store.calendarDay(MONDAY);
            await store.putContent(monday.noteId, "<h3>Context</h3><ul><li>ZAP-2590 is open</li></ul>");
            Object.assign(noteIds, { friday: friday.noteId, monday: monday.noteId });
        });
    });

    afterAll(() => {
        vi.unstubAllEnvs();
    });

    it("answers the Context in force for a day, newest first, without the lapsed lines", async () => {
        const { body } = await context(TUESDAY).expect(200);
        expect(body).toEqual({
            date: TUESDAY,
            context: [
                { text: "ZAP-2590 is open", period: "day", key: MONDAY, noteId: noteIds.monday },
                { text: "Jaco out", until: "2033-03-11", period: "day", key: FRIDAY, noteId: noteIds.friday }
            ]
        });
    });

    it("creates no note for a day without one, and refuses a bad date", async () => {
        const before = Object.keys(becca.notes).length;
        expect((await context("2033-03-09").expect(200)).body.context.map((line: { text: string }) => line.text))
            .toEqual([ "ZAP-2590 is open", "Jaco out" ]);
        expect(Object.keys(becca.notes).length).toBe(before);

        await context("2033-02-30").expect(400);
    });
});
