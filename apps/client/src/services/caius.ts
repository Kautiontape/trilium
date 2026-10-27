import type { CKTextEditor } from "@triliumnext/ckeditor5";

import appContext from "../components/app_context.js";
import { getEditorNoteId } from "../widgets/react/NoteStore.js";
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

/** One item's outcome: `moved`, `added` and the like, `skipped` with a reason, or `failed`. */
export interface CaiusItemResult {
    status: string;
    reason?: string;
    error?: string;
    noteId?: string;
    blobId?: string;
}

export type CaiusExplanation =
    | { lane: string; rule: string; source: string; daysLate?: number; summary: string }
    | { error: "not_found" };

interface CaiusStatus {
    enabled: boolean;
    detail?: unknown;
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
    } catch {
        lastKnownEnabled = false;
        statusRequest = null;
    }

    return lastKnownEnabled;
}

export const caiusApi = {
    setState: (items: CaiusSetStateItem[]) => postItems("set-state", items),
    forward: (items: CaiusForwardItem[]) => postItems("forward", items),
    accept: (items: CaiusAcceptItem[]) => postItems("accept", items),
    dismiss: (items: CaiusDismissItem[]) => postItems("dismiss", items),
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
    const response = await server.post<{ results: CaiusItemResult[] }>(
        `caius/${action}`,
        { items, dryRun: false }
    );

    return response.results;
}

/**
 * Runs a Caius write on `noteId` without racing the editors that show it, and toasts the outcome.
 *
 * Every open editor of the note, and of the notes in `options.alsoLock`, is made read-only at once.
 * Writes that share a note then take turns: each saves those editors, so that `call` receives the
 * note's `blobId` as the server sees it, and a `stale` skip (a save landed in between) saves again
 * and retries once. After a write that changed something, the editors stay read-only until they
 * have reloaded the note; one that misses the reload for {@link RELOAD_TIMEOUT_MS} has the note
 * fetched again. The save and the request each get {@link ANSWER_TIMEOUT_MS}. With no editor open,
 * `call` runs as is.
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
    const editors = [ ...new Set(noteIds.flatMap(findOpenEditors)) ];
    const lock = Symbol(CAIUS_WRITE_LOCK);
    for (const editor of editors) {
        editor.enableReadOnlyMode(lock);
    }

    const turn = Promise.all(noteIds.map((id) => writeQueues.get(id)))
        .then(() => writeInTurn(noteId, editors, call, successMessage));
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
        unlock(editors, lock);
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
    editors: CKTextEditor[],
    call: (expectedBlobId: string | undefined) => Promise<CaiusItemResult[]>,
    successMessage: string
): Promise<CaiusItemResult[] | null> {
    const attempt = async () => {
        if (!editors.length) {
            return { results: await answerInTime(call(undefined)), reload: NO_RELOAD };
        }

        await answerInTime(flushEditors(editors));
        const expectedBlobId = froca.notes[noteId]?.blobId;
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

        if (written.results.some(isChange)) {
            await settleReload(written.reload);
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
 * Waits for the editors to reload the written note. Those that miss it have the note fetched again
 * and get another {@link RELOAD_TIMEOUT_MS}; if that fails too, the user is told to reload the note
 * before typing, since a save of the stale content would undo the write.
 */
async function settleReload(reload: PendingReload) {
    const missed = await reload.promise;
    if (!missed.length) {
        return;
    }

    const retry = waitForReload(missed);
    fetchContentAgain(missed.map(getEditorNoteId).filter((id): id is string => !!id));
    if ((await retry.promise).length) {
        toast.showError(t("caius.reload_before_typing"));
    }
}

/** Drops froca's cached blobs of `noteIds` and has the widgets showing them fetch them again. */
function fetchContentAgain(noteIds: string[]) {
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
    for (const editor of editors) {
        const domRoot = editor.editing.view.getDomRoot();
        const component = domRoot ? appContext.getComponentByEl(domRoot) : null;
        await component?.triggerCommand("saveNoteDetailNow");
    }

    await ws.waitForMaxKnownEntityChangeId();
}

/**
 * Resolves once each of `editors` has had its data replaced (`EditableText` reloading the note), or
 * after {@link RELOAD_TIMEOUT_MS}, to the editors that were not. Registered before the request,
 * since the reload can arrive over the WebSocket ahead of the response.
 */
function waitForReload(editors: CKTextEditor[]): PendingReload {
    const reloaded = new Set<CKTextEditor>();
    const cleanups: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cancel = () => {
        clearTimeout(timer);
        for (const cleanup of cleanups) {
            cleanup();
        }
    };

    const reloads = editors.map((editor) => new Promise<void>((resolve) => {
        const onSet = () => {
            editor.data.off("set", onSet);
            reloaded.add(editor);
            resolve();
        };
        // `set` is decorated, so a listener below `normal` runs after the data is in the model.
        editor.data.on("set", onSet, { priority: "lowest" });
        cleanups.push(() => editor.data.off("set", onSet));
    }));

    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RELOAD_TIMEOUT_MS);
    });

    return {
        promise: Promise.race([ Promise.all(reloads), timeout ])
            .then(() => editors.filter((editor) => !reloaded.has(editor)))
            .finally(cancel),
        cancel
    };
}

interface PendingReload {
    /** Resolves to the editors that did not reload. */
    promise: Promise<CKTextEditor[]>;
    cancel(): void;
}

const NO_RELOAD: PendingReload = { promise: Promise.resolve([]), cancel: () => {} };

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
    "dismissed", "duplicate", "edited", "not_live", "not_suggested", "same_day", "stale",
    "unreadable"
];

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return typeof error === "string" ? error : JSON.stringify(error);
}
