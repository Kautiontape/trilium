import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    notes: {} as Record<string, { blobId: string; getOwnedLabelValue?: (name: string) => string | null }>,
    blobPromises: {} as Record<string, unknown>,
    getComponentByEl: vi.fn(),
    triggerEvent: vi.fn(),
    waitForMaxKnownEntityChangeId: vi.fn(async () => {}),
    getWithSilentNotFound: vi.fn(),
    post: vi.fn(),
    showMessage: vi.fn(),
    showError: vi.fn()
}));

vi.mock("../components/app_context.js", () => ({
    default: { getComponentByEl: h.getComponentByEl, triggerEvent: h.triggerEvent }
}));
vi.mock("./froca.js", () => ({ default: { notes: h.notes, blobPromises: h.blobPromises } }));
vi.mock("./ws.js", () => ({ default: { waitForMaxKnownEntityChangeId: h.waitForMaxKnownEntityChangeId } }));
vi.mock("./server.js", () => ({ default: { getWithSilentNotFound: h.getWithSilentNotFound, post: h.post } }));
vi.mock("./toast.js", () => ({ default: { showMessage: h.showMessage, showError: h.showError } }));
vi.mock("./i18n.js", () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)
}));

import { setEditorNoteId } from "../widgets/react/NoteStore.js";
import {
    ANSWER_TIMEOUT_MS, CAIUS_WRITE_LOCK, caiusApi, type CaiusItemResult, caiusWrite, describeSkip,
    forgetCaiusStatus, isCaiusEnabled, openPeriodNoteIds, RELOAD_TIMEOUT_MS
} from "./caius.js";
import type LoadResults from "./load_results.js";

/** A stand-in for a CKEditor showing `noteId`, mounted where `findOpenEditors()` looks. */
function openEditor(noteId: string) {
    const listeners = new Set<() => void>();
    const locks = new Set<string | symbol>();
    const domRoot = document.createElement("div");
    domRoot.className = "ck-editor__editable";
    const editor = {
        editing: { view: { getDomRoot: () => domRoot } },
        data: {
            on: (_event: string, listener: () => void) => listeners.add(listener),
            off: (_event: string, listener: () => void) => listeners.delete(listener)
        },
        enableReadOnlyMode: vi.fn((lock: string | symbol) => locks.add(lock)),
        disableReadOnlyMode: vi.fn((lock: string | symbol) => locks.delete(lock)),
        get isReadOnly() {
            return locks.size > 0;
        },
        /** What `EditableText` does when the note's content reloads. */
        reload: () => {
            for (const listener of [ ...listeners ]) listener();
        },
        get listenerCount() {
            return listeners.size;
        }
    };
    Object.assign(domRoot, { ckeditorInstance: editor });
    document.body.appendChild(domRoot);
    setEditorNoteId(editor, noteId);
    return editor;
}

/** Wires `saveNoteDetailNow` for every editor; each save gives the note a new `blobId`. */
function stubSaves(noteId: string) {
    let saves = 0;
    const save = vi.fn(async () => {
        saves++;
        h.notes[noteId] = { blobId: `blob${saves}` };
    });
    h.getComponentByEl.mockReturnValue({ triggerCommand: save });
    return save;
}

const moved: CaiusItemResult[] = [ { status: "moved" } ];
const stale: CaiusItemResult[] = [ { status: "skipped", reason: "stale", noteId: "n1", blobId: "x" } ];

describe("caiusWrite", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        for (const key of Object.keys(h.notes)) delete h.notes[key];
        h.notes.n1 = { blobId: "blob0" };
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("locks, saves, sends the saved blobId, then unlocks once the editor has reloaded", async () => {
        const editor = openEditor("n1");
        const save = stubSaves("n1");
        const seen: { readOnly: boolean; blobId?: string }[] = [];
        const call = vi.fn(async (expectedBlobId?: string) => {
            seen.push({ readOnly: editor.isReadOnly, blobId: expectedBlobId });
            return moved;
        });

        const write = caiusWrite("n1", call, "done!");
        await vi.waitFor(() => expect(call).toHaveBeenCalled());
        await Promise.resolve();

        expect(save).toHaveBeenCalledWith("saveNoteDetailNow");
        const [ lock ] = editor.enableReadOnlyMode.mock.calls[0] ?? [];
        expect(typeof lock === "symbol" && lock.description).toBe(CAIUS_WRITE_LOCK);
        expect(seen).toEqual([ { readOnly: true, blobId: "blob1" } ]);
        // Still locked: the reload has not happened yet.
        expect(editor.isReadOnly).toBe(true);

        editor.reload();
        await expect(write).resolves.toEqual(moved);
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showMessage).toHaveBeenCalledWith("done!");
    });

    it("unlocks and reports the error when the request fails", async () => {
        const editor = openEditor("n1");
        stubSaves("n1");

        const result = await caiusWrite("n1", async () => {
            throw new Error("boom");
        }, "done!");

        expect(result).toBeNull();
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showError).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("stays locked when the editor misses the reload, and fetches the note again before unlocking", async () => {
        vi.useFakeTimers();
        const editor = openEditor("n1");
        stubSaves("n1");
        h.blobPromises["notes-n1"] = Promise.resolve("cached blob");
        h.triggerEvent.mockImplementation((_name: string, { loadResults }: { loadResults: LoadResults }) => {
            if (loadResults.isNoteContentReloaded("n1")) setTimeout(() => editor.reload(), 100);
        });

        let settled = false;
        const write = caiusWrite("n1", async () => moved, "done!").then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(RELOAD_TIMEOUT_MS);
        expect(h.triggerEvent).toHaveBeenCalledWith("entitiesReloaded", expect.anything());
        expect(h.blobPromises["notes-n1"]).toBeUndefined();
        expect(settled).toBe(false);
        expect(editor.isReadOnly).toBe(true);

        await vi.advanceTimersByTimeAsync(100);
        await write;
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showMessage).toHaveBeenCalledWith("done!");
        expect(h.showError).not.toHaveBeenCalled();
    });

    it("unlocks and asks for a reload of the note when fetching it again does not reach the editor either", async () => {
        vi.useFakeTimers();
        const editor = openEditor("n1");
        stubSaves("n1");

        const write = caiusWrite("n1", async () => moved, "done!");
        await vi.advanceTimersByTimeAsync(RELOAD_TIMEOUT_MS);
        expect(editor.isReadOnly).toBe(true);

        await vi.advanceTimersByTimeAsync(RELOAD_TIMEOUT_MS);
        await write;
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showError).toHaveBeenCalledWith("caius.reload_before_typing");
    });

    it("unlocks with a toast when the WebSocket never catches up with the save", async () => {
        vi.useFakeTimers();
        const editor = openEditor("n1");
        stubSaves("n1");
        h.waitForMaxKnownEntityChangeId.mockReturnValueOnce(new Promise(() => {}));
        const call = vi.fn(async () => moved);

        let result: CaiusItemResult[] | null | undefined;
        const write = caiusWrite("n1", call, "done!").then((r) => {
            result = r;
        });
        await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
        expect(editor.isReadOnly).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        await write;
        expect(result).toBeNull();
        expect(call).not.toHaveBeenCalled();
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showError).toHaveBeenCalledWith("caius.no_answer");
    });

    it("unlocks with a toast when the request never answers", async () => {
        vi.useFakeTimers();
        const editor = openEditor("n1");
        stubSaves("n1");

        let result: CaiusItemResult[] | null | undefined;
        const write = caiusWrite("n1", () => new Promise(() => {}), "done!").then((r) => {
            result = r;
        });
        await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
        expect(editor.isReadOnly).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        await write;
        expect(result).toBeNull();
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showError).toHaveBeenCalledWith("caius.no_answer");
    });

    it("unlocks every editor even when one of them throws", async () => {
        const broken = openEditor("n1");
        const editor = openEditor("n1");
        stubSaves("n1");
        broken.disableReadOnlyMode.mockImplementation(() => {
            throw new Error("destroyed");
        });

        await caiusWrite("n1", async () => {
            setTimeout(() => {
                broken.reload();
                editor.reload();
            }, 0);
            return moved;
        }, "done!");

        expect(editor.isReadOnly).toBe(false);
    });

    it("also locks and saves the editors of the other notes it is given", async () => {
        const source = openEditor("n1");
        const target = openEditor("n2");
        const other = openEditor("n3");
        const save = stubSaves("n1");
        const seen: boolean[] = [];

        await caiusWrite("n1", async () => {
            seen.push(target.isReadOnly);
            setTimeout(() => {
                source.reload();
                target.reload();
            }, 0);
            return moved;
        }, "done!", { alsoLock: [ "n2" ] });

        expect(seen).toEqual([ true ]);
        expect(save).toHaveBeenCalledTimes(2);
        expect(other.enableReadOnlyMode).not.toHaveBeenCalled();
        expect(source.isReadOnly || target.isReadOnly).toBe(false);
    });

    it("saves again and retries once on a stale skip, with the fresh blobId", async () => {
        const editor = openEditor("n1");
        const save = stubSaves("n1");
        const call = vi.fn()
            .mockResolvedValueOnce(stale)
            .mockImplementationOnce(async () => {
                setTimeout(() => editor.reload(), 0);
                return moved;
            });

        await expect(caiusWrite("n1", call, "done!")).resolves.toEqual(moved);

        expect(save).toHaveBeenCalledTimes(2);
        expect(call.mock.calls).toEqual([ [ "blob1" ], [ "blob2" ] ]);
        expect(editor.isReadOnly).toBe(false);
    });

    it("gives up after one retry, without waiting for a reload that will not come", async () => {
        const editor = openEditor("n1");
        stubSaves("n1");
        const call = vi.fn(async () => stale);

        await expect(caiusWrite("n1", call, "done!")).resolves.toEqual(stale);

        expect(call).toHaveBeenCalledTimes(2);
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
        expect(h.showMessage).toHaveBeenCalledWith("caius.skip.stale", 5000, "bx bx-info-circle");
    });

    it("locks every editor showing the note and none showing another", async () => {
        const first = openEditor("n1");
        const second = openEditor("n1");
        const other = openEditor("n2");
        stubSaves("n1");

        await caiusWrite("n1", async () => {
            setTimeout(() => {
                first.reload();
                second.reload();
            }, 0);
            return moved;
        }, "done!");

        expect(first.enableReadOnlyMode).toHaveBeenCalled();
        expect(other.enableReadOnlyMode).not.toHaveBeenCalled();
        expect(first.isReadOnly || second.isReadOnly).toBe(false);
    });

    it("runs two overlapping writes on one note in turn, locked until the second has reloaded", async () => {
        const editor = openEditor("n1");
        const save = stubSaves("n1");
        let finishFirst = (_results: CaiusItemResult[]) => {};
        const firstCall = vi.fn(() => new Promise<CaiusItemResult[]>((resolve) => {
            finishFirst = resolve;
        }));
        const secondCall = vi.fn(async () => moved);
        const first = caiusWrite("n1", firstCall, "first");
        const second = caiusWrite("n1", secondCall, "second");
        expect(editor.enableReadOnlyMode).toHaveBeenCalledTimes(2);

        await vi.waitFor(() => expect(firstCall).toHaveBeenCalled());
        expect(secondCall).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledTimes(1);

        finishFirst(moved);
        editor.reload();
        await first;
        expect(editor.isReadOnly).toBe(true);

        await vi.waitFor(() => expect(secondCall).toHaveBeenCalledWith("blob2"));
        expect(editor.isReadOnly).toBe(true);
        editor.reload();
        await second;
        expect(editor.isReadOnly).toBe(false);
        expect(h.showMessage.mock.calls.map(([ message ]) => message)).toEqual([ "first", "second" ]);
    });

    it("calls the route straight away when the note is not open", async () => {
        const call = vi.fn(async () => moved);

        await caiusWrite("n1", call, "done!");

        expect(call).toHaveBeenCalledWith(undefined);
        expect(h.getComponentByEl).not.toHaveBeenCalled();
        expect(h.showMessage).toHaveBeenCalledWith("done!");
    });
});

describe("describeSkip", () => {
    it("asks for a save when a saved note still lacks the item", () => {
        expect(describeSkip("not_found", true)).toBe("caius.skip.not_found_after_save");
        expect(describeSkip("not_found", false)).toBe("caius.skip.not_found");
        expect(describeSkip("already_done", true)).toBe("caius.skip.already_done");
        expect(describeSkip("weird", true)).toBe("caius.skip.other {\"reason\":\"weird\"}");
    });

    it("words every reason the library and the routes skip for", () => {
        const reasons = [
            "already_cancelled", "already_doing", "already_done", "already_moved", "bad_request",
            "dismissed", "duplicate", "edited", "not_live", "not_suggested", "same_day", "stale",
            "unreadable"
        ];
        for (const reason of reasons) {
            expect(describeSkip(reason, true)).toBe(`caius.skip.${reason}`);
        }
    });
});

describe("openPeriodNoteIds", () => {
    it("finds the open notes that carry a day, week or month key's label", () => {
        document.body.innerHTML = "";
        const labelled = (label: string, value: string) => ({
            blobId: "b", getOwnedLabelValue: (name: string) => (name === label ? value : null)
        });
        h.notes.day = labelled("dateNote", "2026-10-27");
        h.notes.week = labelled("weekNote", "2026-W44");
        h.notes.month = labelled("monthNote", "2026-11");
        h.notes.closed = labelled("dateNote", "2026-10-28");
        for (const noteId of [ "day", "week", "month" ]) openEditor(noteId);

        expect(openPeriodNoteIds("2026-10-27")).toEqual([ "day" ]);
        expect(openPeriodNoteIds("2026-W44")).toEqual([ "week" ]);
        expect(openPeriodNoteIds("2026-11")).toEqual([ "month" ]);
        expect(openPeriodNoteIds("2026-10-28")).toEqual([]);
    });
});

describe("caiusApi", () => {
    it("explains through the silent-404 getter, reading the server's not_found body as the answer", async () => {
        h.getWithSilentNotFound.mockResolvedValueOnce({ lane: "today", summary: "Today: …" });
        await expect(caiusApi.explain("n1", "e1")).resolves.toEqual({ lane: "today", summary: "Today: …" });
        expect(h.getWithSilentNotFound).toHaveBeenLastCalledWith("caius/explain?noteId=n1&listItemId=e1");

        h.getWithSilentNotFound.mockRejectedValueOnce(JSON.stringify({ error: "not_found", detail: "No task e1" }));
        await expect(caiusApi.explain("n1", "e1")).resolves.toEqual({ error: "not_found" });

        h.getWithSilentNotFound.mockRejectedValueOnce("<html>Cannot GET</html>");
        await expect(caiusApi.explain("n1", "e1")).rejects.toBe("<html>Cannot GET</html>");
    });

    it("posts the items for real and reads the results out of the response", async () => {
        const results = [ { status: "updated", noteId: "n1" } ];
        h.post.mockResolvedValueOnce({ results });
        const item = { noteId: "n1", listItemId: "e1", state: "done" as const, expectedBlobId: "b1" };

        await expect(caiusApi.setState([ item ])).resolves.toEqual(results);
        expect(h.post).toHaveBeenCalledWith("caius/set-state", { items: [ item ], dryRun: false });
    });
});

describe("isCaiusEnabled", () => {
    beforeEach(() => {
        forgetCaiusStatus();
        h.getWithSilentNotFound.mockReset();
    });

    it("asks once per session and asks again after a failure", async () => {
        h.getWithSilentNotFound.mockRejectedValueOnce("404").mockResolvedValue({ enabled: true });

        await expect(isCaiusEnabled()).resolves.toBe(false);
        await expect(isCaiusEnabled()).resolves.toBe(true);
        await expect(isCaiusEnabled()).resolves.toBe(true);

        expect(h.getWithSilentNotFound).toHaveBeenCalledTimes(2);
        expect(h.getWithSilentNotFound).toHaveBeenCalledWith("caius/status");
    });

    it("reads enabled: false, which the server answers when the service fails to load", async () => {
        h.getWithSilentNotFound.mockResolvedValueOnce({ enabled: false, detail: "Cannot find module" });
        await expect(isCaiusEnabled()).resolves.toBe(false);
    });
});
