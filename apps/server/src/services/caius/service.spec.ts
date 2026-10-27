import type { NoteStore } from "@triliumnext/caius";
import { describe, expect, it } from "vitest";

import { createCaiusService } from "./service.js";

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
