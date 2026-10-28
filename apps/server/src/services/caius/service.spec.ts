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

describe("the caius service writing Meetings", () => {
    const html: Record<string, string> = { d: "<h2>Tasks</h2><ul class=\"todo-list\"><li>keep</li></ul>" };
    const dayNote = {
        noteId: "d", title: "d", type: "text", isProtected: false, parentNoteIds: [], childNoteIds: [],
        attributes: [ { type: "label", name: "dateNote", value: "2026-11-06" } ], utcDateModified: ""
    };
    const store = {
        search: async () => [ dayNote ],
        note: async () => dayNote,
        content: async (id: string) => html[id] ?? "",
        putContent: async (id: string, body: string, expected?: string) => {
            if (expected !== undefined && html[id] !== expected) {
                return false;
            }
            html[id] = body;
            return true;
        }
    } as unknown as NoteStore;

    it("replaces the block under the lock and leaves the task list alone", async () => {
        const service = createCaiusService(store);
        const answer = await service.meetings({ date: "2026-11-06", items: [ "10:00 Standup" ] });
        expect(answer).toMatchObject({ source: "items", lines: [ "10:00 Standup" ] });
        expect("results" in answer && answer.results).toEqual([ { date: "2026-11-06", status: "updated", writtenNoteId: "d" } ]);
        expect(html.d).toMatch(/^<h3>Meetings<\/h3><ul><li data-list-item-id="e[0-9a-f]{32}">10:00 Standup<\/li><\/ul><h2>Tasks<\/h2>/);
        expect(html.d).toContain("<ul class=\"todo-list\"><li");
    });
});

describe("the caius service reading Context", () => {
    const note = {
        noteId: "d", title: "d", type: "text", isProtected: false, parentNoteIds: [], childNoteIds: [],
        attributes: [ { type: "label", name: "dateNote", value: "2026-11-06" } ], utcDateModified: ""
    };
    const store = {
        search: async () => [ note ],
        note: async () => note,
        content: async () => "<h3>Context</h3><ul><li>Jaco out (until Fri 6 Nov)</li><li>Gone (until 5 Nov)</li></ul>"
    } as unknown as NoteStore;

    it("returns the lines in force for the day", async () => {
        const answer = await createCaiusService(store).context({ date: "2026-11-06" });
        expect(answer.context.map((line) => line.text)).toEqual([ "Jaco out" ]);
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
