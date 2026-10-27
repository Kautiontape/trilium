import type { NoteStore } from "@triliumnext/caius";
import { describe, expect, it } from "vitest";

import { caiusDevNow, caiusNow, createCaiusService } from "./service.js";

/** A document with no Journal: no note carries `#calendarRoot`, and nothing else is read. */
const noJournal = {
    search: async () => [],
    note: async (noteId: string) => {
        throw new Error(`Note ${noteId} not found`);
    }
} as unknown as NoteStore;

describe("the caius service without a Journal", () => {
    const service = createCaiusService(noJournal);

    it("answers empty lanes, an unknown task and nothing to assign, rather than failing", async () => {
        // `journal: false` tells "no Journal" apart from "nothing to do".
        expect(await service.open({})).toEqual({ total: 0, tasks: [], journal: false });
        expect(await service.explain({ noteId: "n1", listItemId: "e1" }))
            .toMatchObject({ error: "not_found", journal: false });
        expect(await service.assignIds({ dryRun: true })).toEqual({
            dryRun: true, notes: 0, added: 0, results: [], blobIds: {}, journal: false
        });
    });
});

describe("caiusNow", () => {
    it("takes CAIUS_NOW under TRILIUM_ENV=dev and Trilium's local time otherwise", () => {
        const dev = caiusNow({ TRILIUM_ENV: "dev", CAIUS_NOW: "2026-11-06T17:30" });
        expect([ dev.getMonth(), dev.getDate(), dev.getHours(), dev.getMinutes() ]).toEqual([ 10, 6, 17, 30 ]);

        const production = caiusNow({ TRILIUM_ENV: "production", CAIUS_NOW: "2026-11-06T17:30" });
        expect(Math.abs(production.getTime() - Date.now())).toBeLessThan(5000);
    });

    it("tells the client the overridden time, and only in dev", () => {
        expect(caiusDevNow({ TRILIUM_ENV: "dev", CAIUS_NOW: "2026-11-06T17:30" })).toBe("2026-11-06T17:30:00");
        expect(caiusDevNow({ TRILIUM_ENV: "production", CAIUS_NOW: "2026-11-06T17:30" })).toBeUndefined();
    });
});
