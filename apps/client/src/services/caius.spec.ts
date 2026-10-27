import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    notes: {} as Record<string, { blobId: string }>,
    getComponentByEl: vi.fn(),
    waitForMaxKnownEntityChangeId: vi.fn(async () => {}),
    getWithSilentNotFound: vi.fn(),
    post: vi.fn(),
    showMessage: vi.fn(),
    showError: vi.fn()
}));

vi.mock("../components/app_context.js", () => ({
    default: { getComponentByEl: h.getComponentByEl }
}));
vi.mock("./froca.js", () => ({ default: { notes: h.notes } }));
vi.mock("./ws.js", () => ({ default: { waitForMaxKnownEntityChangeId: h.waitForMaxKnownEntityChangeId } }));
vi.mock("./server.js", () => ({ default: { getWithSilentNotFound: h.getWithSilentNotFound, post: h.post } }));
vi.mock("./toast.js", () => ({ default: { showMessage: h.showMessage, showError: h.showError } }));
vi.mock("./i18n.js", () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)
}));

import { setEditorNoteId } from "../widgets/react/NoteStore.js";
import {
    CAIUS_WRITE_LOCK, caiusApi, type CaiusItemResult, caiusWrite, describeSkip, forgetCaiusStatus,
    isCaiusEnabled, RELOAD_TIMEOUT_MS
} from "./caius.js";

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

    it("unlocks after the timeout when the editor never reloads", async () => {
        vi.useFakeTimers();
        const editor = openEditor("n1");
        stubSaves("n1");

        let settled = false;
        const write = caiusWrite("n1", async () => moved, "done!").then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(RELOAD_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        expect(editor.isReadOnly).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        await write;
        expect(editor.isReadOnly).toBe(false);
        expect(editor.listenerCount).toBe(0);
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

    it("keeps the editor read-only until the last of two overlapping writes on the note ends", async () => {
        const editor = openEditor("n1");
        stubSaves("n1");
        let finishFirst = (_results: CaiusItemResult[]) => {};
        let finishSecond = (_results: CaiusItemResult[]) => {};
        const first = caiusWrite("n1", () => new Promise((resolve) => {
            finishFirst = resolve;
        }), "first");
        const second = caiusWrite("n1", () => new Promise((resolve) => {
            finishSecond = resolve;
        }), "second");
        await vi.waitFor(() => expect(editor.listenerCount).toBe(2));

        finishFirst(moved);
        editor.reload();
        await first;
        expect(h.showMessage).toHaveBeenCalledWith("first");
        expect(editor.isReadOnly).toBe(true);

        finishSecond(moved);
        await second;
        expect(editor.isReadOnly).toBe(false);
        const [ [ firstLock ], [ secondLock ] ] = editor.enableReadOnlyMode.mock.calls;
        expect(firstLock).not.toBe(secondLock);
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

describe("caiusApi", () => {
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
