import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import appContext from "../components/app_context.js";
import type { EntityChange } from "../server_types.js";
import { movesCaiusClock, trackStartedNotes } from "./caius.js";
import froca from "./froca.js";
import frocaUpdater from "./froca_updater.js";
import type LoadResults from "./load_results.js";
import { buildNote } from "../test/easy-froca.js";

const MONDAY = "mondayNote";
const STARTED_ID = "startedAttr";

const startedRow = {
    attributeId: STARTED_ID, noteId: MONDAY, type: "label", name: "caiusStarted",
    value: "2026-10-26T01:20:00", isInheritable: false, position: 10
};

let triggerSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
    triggerSpy = vi.fn(async () => []);
    appContext.triggerEvent = triggerSpy as typeof appContext.triggerEvent;
});

afterEach(() => {
    vi.restoreAllMocks();
    delete froca.notes[MONDAY];
    delete froca.attributes[STARTED_ID];
});

function change(entity: Record<string, unknown>): EntityChange {
    return {
        entityName: "attributes", entityId: STARTED_ID, hash: "h", isSynced: false, isErased: false,
        componentId: "NA", entity
    } as EntityChange;
}

const lastLoadResults = () => triggerSpy.mock.calls.at(-1)?.[1].loadResults as LoadResults;

/** Stubs `froca.getNote` to load Monday's day note with its `#caiusStarted` label. */
function loadMondayOnRequest() {
    return vi.spyOn(froca, "getNote").mockImplementation(async (noteId) => {
        froca.addResp({
            notes: [ {
                noteId: MONDAY, title: "2026-10-26", isProtected: false, type: "text",
                mime: "text/html", blobId: "blob"
            } as never ],
            branches: [],
            attributes: [ startedRow as never ]
        });
        return froca.notes[noteId] ?? null;
    });
}

describe("trackStartedNotes", () => {
    it("loads a day note froca lacks, so taking the day back reaches entitiesReloaded", async () => {
        loadMondayOnRequest();

        await frocaUpdater.processEntityChanges([ change(startedRow) ]);
        expect(triggerSpy).toHaveBeenCalledTimes(1);
        const set = lastLoadResults();
        expect(movesCaiusClock(set)).toBe(true);
        await trackStartedNotes(set);
        expect(froca.getNote).toHaveBeenCalledWith(MONDAY, true);

        triggerSpy.mockClear();
        await frocaUpdater.processEntityChanges([ change({ ...startedRow, isDeleted: true }) ]);
        expect(triggerSpy).toHaveBeenCalledTimes(1);
        expect(movesCaiusClock(lastLoadResults())).toBe(true);
    });

    it("drops the removal on a note froca never loaded", async () => {
        await frocaUpdater.processEntityChanges([ change(startedRow) ]);
        await frocaUpdater.processEntityChanges([ change({ ...startedRow, isDeleted: true }) ]);
        expect(triggerSpy).toHaveBeenCalledTimes(1);
    });

    it("skips a note froca holds, a deleted row, another label and a failed load", async () => {
        const getNote = vi.spyOn(froca, "getNote").mockRejectedValue(new Error("offline"));
        const held = buildNote({ title: "Held" });
        const rows = (list: Record<string, unknown>[]) => ({
            getAttributeRows: () => list
        }) as unknown as LoadResults;

        await trackStartedNotes(rows([
            { name: "caiusStarted", noteId: held.noteId },
            { name: "caiusStarted", noteId: "gone", isDeleted: true },
            { name: "caiusFocus", noteId: "other" }
        ]));
        expect(getNote).not.toHaveBeenCalled();

        await expect(trackStartedNotes(rows([ { name: "caiusStarted", noteId: "fresh" } ])))
            .resolves.toBeUndefined();
        expect(getNote).toHaveBeenCalledWith("fresh", true);
    });
});
