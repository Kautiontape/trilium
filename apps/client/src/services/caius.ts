import type { CKTextEditor } from "@triliumnext/ckeditor5";

import appContext from "../components/app_context.js";
import { getEditorNoteId, noteSavedDataStore } from "../widgets/react/NoteStore.js";
import froca from "./froca.js";
import { t } from "./i18n.js";
import LoadResults from "./load_results.js";
import server from "./server.js";
import toast from "./toast.js";
import ws from "./ws.js";

/**
 * The description of the read-only lock `caiusWrite()` holds on every editor showing the note it
 * writes to. Each write locks with a `Symbol` of its own, so that one write ending does not unlock
 * the editor for another still running on the same note.
 */
export const CAIUS_WRITE_LOCK = "caius-write";

/** How long `caiusWrite()` waits for an open editor to reload the note after a write. */
export const RELOAD_TIMEOUT_MS = 3000;

export type CaiusTaskState = "done" | "doing" | "cancelled";

interface CaiusItemRef {
    noteId: string;
    listItemId: string;
    /** The note's `blobId` as the client last saw it; a mismatch skips the item as `stale`. */
    expectedBlobId?: string;
}

export interface CaiusSetStateItem extends CaiusItemRef {
    state: CaiusTaskState;
    /** Required for `cancelled`. */
    reason?: string;
}

export interface CaiusForwardItem extends CaiusItemRef {
    /** `YYYY-MM-DD`, `YYYY-Www` (ISO week) or `YYYY-MM`. */
    to: string;
}

export type CaiusAcceptItem = CaiusItemRef & ({ section: string } | { critical: true });

export type CaiusDismissItem = CaiusItemRef;

export interface CaiusApplyRequest {
    forwards: Omit<CaiusForwardItem, "expectedBlobId">[];
    drops: Omit<CaiusSetStateItem, "expectedBlobId">[];
    /** The closed note's `blobId`, compared once before the first write. */
    expectedBlobId?: string;
}

/** One item's outcome: `moved`, `added` and the like, `skipped` with a reason, or `failed`. */
export interface CaiusItemResult {
    status: string;
    reason?: string;
    error?: string;
    noteId?: string;
    blobId?: string;
    /** A forward: the notes it wrote, without the target when that already held the copy. */
    writtenNoteIds?: string[];
}

export type CaiusExplanation =
    | { lane: string; rule: string; source: string; daysLate?: number; summary: string }
    | { error: "not_found" };

export type CaiusPeriodKind = "day" | "week" | "month";

/** A task of a period note, as `/api/caius/plan` lists it. */
export interface CaiusPlanTask {
    noteId: string;
    /** `null` for an item without `data-list-item-id`, which no write can target. */
    listItemId: string | null;
    state: "open" | "in_progress" | "done" | "cancelled" | "tombstone";
    text: string;
    estMinutes: number | null;
    /** The parent task's text, for a sub-item. */
    parent: string | null;
    /** The parent task's list item id, for a sub-item whose parent has one. */
    parentListItemId: string | null;
    section: string | null;
    critical: boolean;
}

/** One day, week or month note read as a plan. */
export interface CaiusPlan {
    period: CaiusPeriodKind;
    key: string;
    /** `null` when the note does not exist yet. */
    noteId: string | null;
    critical: CaiusPlanTask[];
    sections: { name: string | null; kind: string | null; tasks: CaiusPlanTask[] }[];
    top3: CaiusPlanTask[];
    suggested: CaiusPlanTask[];
    dismissed: string[];
    capacity: {
        plannedMinutes: number;
        estimatedCount: number;
        unestimatedCount: number;
        unestimatedMinutes: number;
        totalMinutes: number;
        /** `null` for a month, which has no target. */
        target: { min: number; max: number } | null;
        horizons: Record<string, number>;
    };
}

export type CaiusLane =
    "overdue" | "today" | "week" | "orbit" | "planning_ahead" | "someday" | "suggested";

/** An open task anywhere in the Journal, as `/api/caius/open` lists it. */
export interface CaiusOpenTask {
    noteId: string;
    /** The period of the note the task is in: `2026-10-26`, `2026-W44` or `2026-10`. */
    period: string;
    listItemId: string | null;
    state: "open" | "in_progress";
    text: string;
    parent: string | null;
    /** The parent task's list item id, for a sub-item whose parent has one. */
    parentListItemId: string | null;
    section: string | null;
    lane: CaiusLane | null;
    /** Set for an overdue task. */
    daysLate?: number;
}

interface CaiusStatus {
    enabled: boolean;
    detail?: unknown;
    /** The server's local time, `YYYY-MM-DDTHH:mm:ss`, sent only when its dev clock is set. */
    now?: string;
}

/** The gap between the server's dev clock and this browser's, in ms; 0 without a dev clock. */
let clockOffset = 0;

/**
 * The moment the Plan tab treats as now: the browser clock, or the server's when it runs a dev
 * `CAIUS_NOW` (known once `isCaiusEnabled()` has answered).
 */
export function caiusNow() {
    return new Date(Date.now() + clockOffset);
}

let statusRequest: Promise<boolean> | null = null;
let lastKnownEnabled = false;

/**
 * Whether the server runs Caius. The answer is fetched once per session; a failed request answers
 * `false` and is asked again on the next call. A 404 (the standalone and Capacitor builds have no
 * such route) is a failure too.
 */
export function isCaiusEnabled(): Promise<boolean> {
    statusRequest ??= fetchStatus();
    return statusRequest;
}

/**
 * The last answer `isCaiusEnabled()` got, for a caller that must decide synchronously (the
 * browser's `contextmenu` listener). `false` until the first request resolves.
 */
export function wasCaiusEnabled() {
    return lastKnownEnabled;
}

/** Drops the cached status, so that the next `isCaiusEnabled()` asks the server again. */
export function forgetCaiusStatus() {
    statusRequest = null;
}

async function fetchStatus() {
    try {
        const status = await server.getWithSilentNotFound<CaiusStatus>("caius/status");
        lastKnownEnabled = status?.enabled === true;
        const serverNow = status?.now ? new Date(status.now).getTime() : NaN;
        clockOffset = Number.isNaN(serverNow) ? 0 : serverNow - Date.now();
    } catch {
        lastKnownEnabled = false;
        statusRequest = null;
    }

    return lastKnownEnabled;
}

export const caiusApi = {
    plan: (period: CaiusPeriodKind, date: string) => server.get<CaiusPlan>(
        `caius/plan?${new URLSearchParams({ period, date }).toString()}`
    ),
    /** Open tasks of `lane`, or of every lane when it is left out. */
    open: (lane: CaiusLane | undefined, limit: number) => {
        const query = new URLSearchParams({ ...(lane ? { lane } : {}), limit: String(limit) });
        const url = `caius/open?${query.toString()}`;
        return server.get<{ total: number; tasks: CaiusOpenTask[] }>(url);
    },
    setState: (items: CaiusSetStateItem[]) => postItems("set-state", items),
    forward: (items: CaiusForwardItem[]) => postItems("forward", items),
    accept: (items: CaiusAcceptItem[]) => postItems("accept", items),
    dismiss: (items: CaiusDismissItem[]) => postItems("dismiss", items),
    /** Close: the forwards, then the drops, in one request behind one version check. */
    apply: (body: CaiusApplyRequest) => postWrite("caius/apply", body),
    explain
};

/**
 * Why a task is in its lane. The route answers 404 `{ error: "not_found" }` for an item it cannot
 * find; that comes back as the answer, without the generic error toast `server.get()` would show.
 */
async function explain(noteId: string, listItemId: string): Promise<CaiusExplanation> {
    try {
        return await server.getWithSilentNotFound<CaiusExplanation>(
            `caius/explain?${new URLSearchParams({ noteId, listItemId }).toString()}`
        );
    } catch (error) {
        if (isNotFoundBody(error)) {
            return { error: "not_found" };
        }
        throw error;
    }
}

function isNotFoundBody(responseText: unknown) {
    try {
        return typeof responseText === "string"
            && (JSON.parse(responseText) as { error?: unknown }).error === "not_found";
    } catch {
        return false;
    }
}

async function postItems(action: string, items: object[]): Promise<CaiusItemResult[]> {
    return postWrite(`caius/${action}`, { items, dryRun: false });
}

/** Posts a Caius write, and records the final `blobId` of each note it wrote. */
async function postWrite(url: string, body: object): Promise<CaiusItemResult[]> {
    const response = await server.post<CaiusWriteResponse>(url, body);
    for (const [ noteId, blobId ] of Object.entries(response.blobIds ?? {})) {
        finalBlobIds.set(noteId, blobId);
    }
    return response.results;
}

interface CaiusWriteResponse {
    results: CaiusItemResult[];
    /** Each note the results name, with its `blobId` once the request was done. */
    blobIds?: Record<string, string>;
}

/**
 * The `blobId` the latest Caius response gave each note, so that `caiusWrite()` can tell its
 * editor's reload of the final version from an intermediate one. A write's turn clears its notes.
 */
const finalBlobIds = new Map<string, string>();

/**
 * Runs a Caius write on `noteId` without racing the editors that show it, and toasts the outcome.
 *
 * Every open editor of the note, and of the notes in `options.alsoLock`, is made read-only at once.
 * Writes that share a note then take turns. When its turn comes, a write locks and saves the
 * editors that show those notes then, so that `call` receives the note's `blobId` as the server
 * sees it; a `stale` skip (a save landed in between) saves again and retries once. After a write
 * that changed something, the editors of `noteId`, and of the `alsoLock` notes a result names in
 * `writtenNoteIds`, stay read-only until they have reloaded the note; one that misses the reload
 * for {@link RELOAD_TIMEOUT_MS} has the note fetched again. The save and the request each get
 * {@link ANSWER_TIMEOUT_MS}. With no editor open, `call` runs as is.
 *
 * @param successMessage the toast for a write the server carried out.
 * @returns the per-item results, or `null` when the request failed or did not answer in time.
 */
export async function caiusWrite(
    noteId: string,
    call: (expectedBlobId: string | undefined) => Promise<CaiusItemResult[]>,
    successMessage: string,
    options: CaiusWriteOptions = {}
): Promise<CaiusItemResult[] | null> {
    const noteIds = [ ...new Set([ noteId, ...(options.alsoLock ?? []) ]) ];
    const lock = Symbol(CAIUS_WRITE_LOCK);
    const locked: CKTextEditor[] = [];
    lockEditors(noteIds.flatMap(findOpenEditors), lock, locked);

    const turn = Promise.all(noteIds.map((id) => writeQueues.get(id)))
        .then(() => writeInTurn(noteId, noteIds, { lock, locked }, call, successMessage));
    const settled = turn.then(() => undefined, () => undefined);
    for (const id of noteIds) {
        writeQueues.set(id, settled);
    }

    try {
        return await turn;
    } finally {
        for (const id of noteIds) {
            if (writeQueues.get(id) === settled) {
                writeQueues.delete(id);
            }
        }
        unlock(locked, lock);
    }
}

export interface CaiusWriteOptions {
    /** Other notes the write changes, such as a forward's target; their editors are locked too. */
    alsoLock?: string[];
}

/** How long `caiusWrite()` waits for the save to come back over the WebSocket, and for the call. */
export const ANSWER_TIMEOUT_MS = 10_000;

/** The end of the last write queued on each note. */
const writeQueues = new Map<string, Promise<void>>();

async function writeInTurn(
    noteId: string,
    noteIds: string[],
    { lock, locked }: { lock: symbol; locked: CKTextEditor[] },
    call: (expectedBlobId: string | undefined) => Promise<CaiusItemResult[]>,
    successMessage: string
): Promise<CaiusItemResult[] | null> {
    // An editor can have moved to another note, or opened this one, while the write was queued.
    const editorsByNote = new Map(noteIds.map((id) => [ id, findOpenEditors(id) ]));
    const editors = [ ...new Set([ ...editorsByNote.values() ].flat()) ];
    lockEditors(editors, lock, locked);
    releaseMovedAway(editors, lock, locked);

    let blobIdsBefore = new Map<string, string | undefined>();
    const attempt = async () => {
        for (const id of noteIds) {
            finalBlobIds.delete(id);
        }
        if (!editors.length) {
            return { results: await answerInTime(call(undefined)), reload: NO_RELOAD };
        }

        await answerInTime(flushEditors(editors));
        blobIdsBefore = new Map(noteIds.map((id) => [ id, froca.notes[id]?.blobId ]));
        const expectedBlobId = blobIdsBefore.get(noteId);
        const reload = waitForReload(editors);
        try {
            return { results: await answerInTime(call(expectedBlobId)), reload };
        } catch (error) {
            reload.cancel();
            throw error;
        }
    };

    try {
        let written = await attempt();
        if (written.results.some(isStale)) {
            written.reload.cancel();
            written = await attempt();
        }

        const changed = changedNotes(noteId, noteIds, written.results, blobIdsBefore);
        if (changed.length) {
            const expected = changed.flatMap((id) => (editorsByNote.get(id) ?? [])
                .map((editor) => ({ editor, noteId: id, blobId: finalBlobIds.get(id) })));
            await settleReload(written.reload, expected);
        } else {
            written.reload.cancel();
        }

        showOutcome(written.results, successMessage, editors.length > 0);
        return written.results;
    } catch (error) {
        if (error instanceof NoAnswerError) {
            toast.showError(t("caius.no_answer"));
        } else {
            forgetCaiusStatus();
            toast.showError(t("caius.request_failed", { message: describeError(error) }));
        }
        return null;
    }
}

/**
 * The notes of the write that changed: those whose final `blobId` in the response differs from the
 * one before the request. Without one, `noteId` changed when any result did, and an `alsoLock`
 * note when a result names it in `writtenNoteIds`.
 */
function changedNotes(
    noteId: string,
    noteIds: string[],
    results: CaiusItemResult[],
    blobIdsBefore: Map<string, string | undefined>
) {
    const writtenNoteIds = new Set(results.flatMap((result) => result.writtenNoteIds ?? []));
    return noteIds.filter((id) => {
        const final = finalBlobIds.get(id);
        if (final !== undefined) {
            return final !== blobIdsBefore.get(id);
        }
        return id === noteId ? results.some(isChange) : writtenNoteIds.has(id);
    });
}

/** Unlocks the editors in `locked` that no longer show one of the write's notes. */
function releaseMovedAway(editors: CKTextEditor[], lock: symbol, locked: CKTextEditor[]) {
    for (const editor of [ ...locked ]) {
        if (!editors.includes(editor)) {
            unlock([ editor ], lock);
            locked.splice(locked.indexOf(editor), 1);
        }
    }
}

/** Locks the editors of `editors` not yet in `locked`, and records them there. */
function lockEditors(editors: CKTextEditor[], lock: symbol, locked: CKTextEditor[]) {
    for (const editor of new Set(editors)) {
        if (!locked.includes(editor)) {
            editor.enableReadOnlyMode(lock);
            locked.push(editor);
        }
    }
}

function unlock(editors: CKTextEditor[], lock: symbol) {
    for (const editor of editors) {
        try {
            editor.disableReadOnlyMode(lock);
        } catch (error) {
            console.error("Cannot unlock an editor after a Caius write", error);
        }
    }
}

class NoAnswerError extends Error {}

/** `promise`, or a {@link NoAnswerError} after {@link ANSWER_TIMEOUT_MS}. */
async function answerInTime<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NoAnswerError()), ANSWER_TIMEOUT_MS);
    });
    try {
        return await Promise.race([ promise, timeout ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Waits for the `expected` editors to reload the written note. Those that miss it have the note
 * fetched again and get another {@link RELOAD_TIMEOUT_MS}; if that fails too, the user is told to
 * reload the note before typing, since a save of the stale content would undo the write.
 */
async function settleReload(reload: PendingReload, expected: ReloadExpectation[]) {
    const missed = await reload.settle(expected);
    if (!missed.length) {
        return;
    }

    // The refetch reads the note after the write, so any reload it brings is the final version.
    const retry = waitForReload(missed.map(({ editor }) => editor));
    fetchContentAgain(missed.map(({ noteId }) => noteId));
    const anyReload = missed.map((expectation) => ({ ...expectation, blobId: undefined }));
    if ((await retry.settle(anyReload)).length) {
        toast.showError(t("caius.reload_before_typing"));
    }
}

/** Drops froca's cached blobs of `noteIds` and has the widgets showing them fetch them again. */
export function fetchContentAgain(noteIds: string[]) {
    const loadResults = new LoadResults([]);
    for (const noteId of new Set(noteIds)) {
        for (const key of Object.keys(froca.blobPromises)) {
            if (key.includes(noteId)) {
                delete froca.blobPromises[key];
            }
        }
        loadResults.addNoteContent(noteId, CAIUS_WRITE_LOCK);
    }
    void appContext.triggerEvent("entitiesReloaded", { loadResults });
}

/**
 * The notes open in an editor that are the day, week or month note of a forward key: a
 * `#dateNote`, `#weekNote` or `#monthNote` label equal to `key`.
 */
export function openPeriodNoteIds(key: string): string[] {
    const label = /^\d{4}-\d{2}-\d{2}$/.test(key) ? "dateNote"
        : /^\d{4}-W\d{2}$/.test(key) ? "weekNote" : "monthNote";
    const noteIds = new Set<string>();
    for (const element of Array.from(document.querySelectorAll(".ck-editor__editable"))) {
        const editor = (element as EditableElement).ckeditorInstance;
        const noteId = editor && getEditorNoteId(editor);
        if (noteId && froca.notes[noteId]?.getOwnedLabelValue(label) === key) {
            noteIds.add(noteId);
        }
    }

    return [ ...noteIds ];
}

/** The editable element CKEditor renders, which carries the editor instance. */
export type EditableElement = HTMLElement & { ckeditorInstance?: CKTextEditor };

/** Every live text editor that holds `noteId` — a split or the popup editor can show it twice. */
export function findOpenEditors(noteId: string): CKTextEditor[] {
    const editors = new Set<CKTextEditor>();
    for (const element of Array.from(document.querySelectorAll(".ck-editor__editable"))) {
        const editor = (element as EditableElement).ckeditorInstance;
        if (editor && getEditorNoteId(editor) === noteId) {
            editors.add(editor);
        }
    }

    return [ ...editors ];
}

/**
 * Saves every editor in `editors` now, and waits until froca holds the resulting note row, so that
 * `froca.notes[noteId].blobId` is the saved content's.
 */
export async function flushEditors(editors: CKTextEditor[]) {
    // Decided before any save, since a save changes the version the next editor is compared with.
    const unsaved = await Promise.all(editors.map(holdsUnsavedListItemIds));
    for (const [ index, editor ] of editors.entries()) {
        const domRoot = editor.editing.view.getDomRoot();
        const component = domRoot ? appContext.getComponentByEl(domRoot) : null;
        if (unsaved[index]) {
            await component?.triggerCommand("saveNoteDetailNow", { force: true });
        } else {
            await component?.triggerCommand("saveNoteDetailNow");
        }
    }

    await ws.waitForMaxKnownEntityChangeId();
}

/**
 * Whether `editor` holds list item ids its note's stored content lacks. CKEditor gives an id to
 * every list item it loads without one, which is no change to save, so the server would not know
 * the id a task action sends. Only the version the editor last loaded or saved counts: when the
 * stored content has changed since, a forced save would revert that outside write.
 */
async function holdsUnsavedListItemIds(editor: CKTextEditor) {
    const noteId = getEditorNoteId(editor);
    const loaded = noteId ? noteSavedDataStore.get(noteId) : undefined;
    const blob = noteId ? await froca.getBlob("notes", noteId) : null;
    if (loaded === undefined || blob?.content !== loaded) {
        return false;
    }

    const stored = new Set(listItemIds(loaded));
    return listItemIds(editor.getData()).some((id) => !stored.has(id));
}

function listItemIds(html: string) {
    return Array.from(html.matchAll(/data-list-item-id="([^"]+)"/g), (match) => match[1]);
}

/**
 * Listens for each of `editors` to have its data replaced (`EditableText` reloading the note).
 * Registered before the request, since the reload can arrive over the WebSocket ahead of the
 * response; `settle()` then waits for the editors the write turned out to change.
 */
function waitForReload(editors: CKTextEditor[]): PendingReload {
    // For each editor, the `blobId` froca held for its note at each reload.
    const reloads = new Map<CKTextEditor, (string | undefined)[]>();
    const onReloaded: (() => void)[] = [];
    const cleanups: (() => void)[] = [];
    const cancel = () => {
        for (const cleanup of cleanups) {
            cleanup();
        }
    };

    for (const editor of editors) {
        const onSet = () => {
            const noteId = getEditorNoteId(editor);
            const blobId = noteId ? froca.notes[noteId]?.blobId : undefined;
            reloads.set(editor, [ ...reloads.get(editor) ?? [], blobId ]);
            for (const notify of onReloaded) {
                notify();
            }
        };
        // `set` is decorated, so a listener below `normal` runs after the data is in the model.
        editor.data.on("set", onSet, { priority: "lowest" });
        cleanups.push(() => editor.data.off("set", onSet));
    }

    const isMet = ({ editor, blobId }: ReloadExpectation) => {
        const seen = reloads.get(editor) ?? [];
        return blobId === undefined ? seen.length > 0 : seen.includes(blobId);
    };

    return {
        async settle(expected) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await new Promise<void>((resolve) => {
                    const check = () => {
                        if (expected.every(isMet)) {
                            resolve();
                        }
                    };
                    onReloaded.push(check);
                    check();
                    timer = setTimeout(resolve, RELOAD_TIMEOUT_MS);
                });
                return expected.filter((expectation) => !isMet(expectation));
            } finally {
                clearTimeout(timer);
                cancel();
            }
        },
        cancel
    };
}

/** An editor that must reload `noteId`; at `blobId`, when the response named the final one. */
interface ReloadExpectation {
    editor: CKTextEditor;
    noteId: string;
    blobId?: string;
}

interface PendingReload {
    /**
     * Waits up to {@link RELOAD_TIMEOUT_MS} for `expected` to be met, stops listening, and resolves
     * to those that were not.
     */
    settle(expected: ReloadExpectation[]): Promise<ReloadExpectation[]>;
    cancel(): void;
}

const NO_RELOAD: PendingReload = { settle: async () => [], cancel: () => {} };

function isStale(result: CaiusItemResult) {
    return result.status === "skipped" && result.reason === "stale";
}

function isChange(result: CaiusItemResult) {
    return result.status !== "skipped" && result.status !== "failed";
}

/** Toasts the first failure, else the first skip, else `successMessage`. */
function showOutcome(results: CaiusItemResult[], successMessage: string, flushed: boolean) {
    const failure = results.find((result) => result.status === "failed");
    if (failure) {
        toast.showError(t("caius.request_failed", { message: failure.error ?? "" }));
        return;
    }

    const skip = results.find((result) => result.status === "skipped");
    if (skip) {
        toast.showMessage(describeSkip(skip.reason ?? "", flushed), 5000, "bx bx-info-circle");
        return;
    }

    toast.showMessage(successMessage);
}

/** A skipped or failed item's outcome in plain words, or `null` when the write went through. */
export function describeOutcome(result: CaiusItemResult | undefined, flushed: boolean) {
    if (result?.status === "failed") {
        return t("caius.request_failed", { message: result.error ?? "" });
    }

    return result?.status === "skipped" ? describeSkip(result.reason ?? "", flushed) : null;
}

/** A skip reason in plain words. `flushed` says whether the note was saved before the request. */
export function describeSkip(reason: string, flushed: boolean) {
    if (reason === "not_found") {
        return flushed ? t("caius.skip.not_found_after_save") : t("caius.skip.not_found");
    }

    return KNOWN_SKIP_REASONS.includes(reason)
        ? t(`caius.skip.${reason}`)
        : t("caius.skip.other", { reason });
}

/** Every reason the library and the routes skip an item for, besides `not_found`. */
const KNOWN_SKIP_REASONS = [
    "already_cancelled", "already_doing", "already_done", "already_moved", "bad_request",
    "dismissed", "duplicate", "edited", "not_live", "not_suggested", "prose_section", "same_day",
    "stale", "unreadable"
];

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return typeof error === "string" ? error : JSON.stringify(error);
}
