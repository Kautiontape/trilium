import type { CKTextEditor } from "@triliumnext/ckeditor5";

import appContext from "../components/app_context.js";
import { getEditorNoteId } from "../widgets/react/NoteStore.js";
import froca from "./froca.js";
import { t } from "./i18n.js";
import server from "./server.js";
import toast from "./toast.js";
import ws from "./ws.js";

/** The read-only lock `caiusWrite()` holds on every editor showing the note it writes to. */
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
    explain: (noteId: string, listItemId: string) => server.get<CaiusExplanation>(
        `caius/explain?${new URLSearchParams({ noteId, listItemId }).toString()}`
    )
};

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
 * Every open editor of the note is made read-only and saved first; `call` then receives the note's
 * `blobId` as the server sees it. A `stale` skip (a save landed in between) saves again and retries
 * once. After a write that changed something, the editors stay read-only until they have reloaded
 * the note, or for {@link RELOAD_TIMEOUT_MS}. With no editor open, `call` runs as is.
 *
 * @param successMessage the toast for a write the server carried out.
 * @returns the per-item results, or `null` when the request failed.
 */
export async function caiusWrite(
    noteId: string,
    call: (expectedBlobId: string | undefined) => Promise<CaiusItemResult[]>,
    successMessage: string
): Promise<CaiusItemResult[] | null> {
    const editors = findOpenEditors(noteId);
    for (const editor of editors) {
        editor.enableReadOnlyMode(CAIUS_WRITE_LOCK);
    }

    const flushAndCall = async () => {
        if (!editors.length) {
            return { results: await call(undefined), reload: NO_RELOAD };
        }

        await flushEditors(editors);
        const expectedBlobId = froca.notes[noteId]?.blobId;
        const reload = waitForReload(editors);
        try {
            return { results: await call(expectedBlobId), reload };
        } catch (error) {
            reload.cancel();
            throw error;
        }
    };

    try {
        let attempt = await flushAndCall();
        if (attempt.results.some(isStale)) {
            attempt.reload.cancel();
            attempt = await flushAndCall();
        }

        if (attempt.results.some(isChange)) {
            await attempt.reload.promise;
        } else {
            attempt.reload.cancel();
        }

        showOutcome(attempt.results, successMessage, editors.length > 0);
        return attempt.results;
    } catch (error) {
        forgetCaiusStatus();
        toast.showError(t("caius.request_failed", { message: describeError(error) }));
        return null;
    } finally {
        for (const editor of editors) {
            editor.disableReadOnlyMode(CAIUS_WRITE_LOCK);
        }
    }
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
 * after {@link RELOAD_TIMEOUT_MS}. Registered before the request, since the reload can arrive over
 * the WebSocket ahead of the response.
 */
function waitForReload(editors: CKTextEditor[]): PendingReload {
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
        promise: Promise.race([ Promise.all(reloads).then(() => undefined), timeout ])
            .finally(cancel),
        cancel
    };
}

interface PendingReload {
    promise: Promise<void>;
    cancel(): void;
}

const NO_RELOAD: PendingReload = { promise: Promise.resolve(), cancel: () => {} };

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
