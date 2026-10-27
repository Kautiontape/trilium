/**
 * The Caius operations, shared by the `caius_*` tools and the `/api/caius/*` routes. Each one
 * composes the `@triliumnext/caius` library the way the Caius CLI does for its Trilium commands,
 * takes input its caller has validated against `schemas.ts`, and runs under `withCaiusLock`. The
 * entry points never call one another, since the lock is not re-entrant. Each store write commits
 * in its own transaction behind a compare-and-swap, and gives any list item without an id one.
 *
 * Items of accept, dismiss, set state and forward can carry the `expectedBlobId` of their note,
 * which the routes accept and the tools don't: an item whose note has changed since is skipped as
 * `stale` with the note's current `blobId`, and the library never sees it.
 */

import {
    acceptTasks,
    addTasks,
    daysLate,
    dismissTasks,
    ensureListItemIds,
    forwardTasks,
    isPeriodKey,
    listItemsWithoutIds,
    loadJournal,
    loadStateSymbols,
    type NoteStore,
    openTasks,
    type OpenTask,
    presentResult,
    readPlan,
    scanDocs,
    setStates,
    type StateAction,
    suggestedTasks,
    TRILIUM_CONFIG,
    withListItemIds
} from "@triliumnext/caius";
import { becca, date_utils as dateUtils } from "@triliumnext/core";

import {
    type AcceptInput,
    type AddInput,
    type AssignIdsInput,
    DEFAULT_OPEN_LIMIT,
    type DismissInput,
    type ExplainInput,
    type ForwardInput,
    type OpenInput,
    type PlanInput,
    type SetStateInput
} from "./schemas.js";
import { createBeccaStore, withCaiusLock } from "./store.js";

export { routeInputs } from "./schemas.js";

const STATE_ACTION: Record<"done" | "doing" | "cancelled", StateAction> = {
    done: "done",
    doing: "start",
    cancelled: "drop"
};

export function createCaiusService(baseStore: NoteStore = createBeccaStore()) {
    const store = withListItemIds(baseStore);

    return {
        plan: ({ period, date }: PlanInput) => withCaiusLock("caius_plan", async () => {
            const now = caiusNow();
            const key = date ?? currentKey(period, now);
            if (!isPeriodKey(period, key)) {
                return { error: "bad_request", detail: `"${key}" is not a ${period} that exists` };
            }
            return readPlan(store, period, key, now);
        }),

        open: ({ lane, limit = DEFAULT_OPEN_LIMIT }: OpenInput) => withCaiusLock("caius_open", async () => {
            const now = caiusNow();
            const { docs } = await loadJournal(store);
            const result = scanDocs(docs, TRILIUM_CONFIG, now);
            const tasks = [
                ...openTasks(docs, result).map((t) => toLaneTask(t, t.horizon, now)),
                ...suggestedTasks(docs, now).map((t) => toLaneTask(t, "suggested", now))
            ].filter((t) => !lane || t.lane === lane);
            return { total: tasks.length, tasks: tasks.slice(0, limit) };
        }),

        explain: ({ noteId, listItemId }: ExplainInput) => withCaiusLock("caius_explain", async () => {
            const now = caiusNow();
            const { docs } = await loadJournal(store);
            const doc = docs.find((d) => d.noteId === noteId);
            const line = doc && [...doc.itemIds].find(([, id]) => id === listItemId)?.[0];
            if (!doc || line === undefined) {
                return { error: "not_found", detail: `No task ${listItemId} in note ${noteId}` };
            }

            const period = doc.path.match(/^Journal\/\w+\/([^/]+?)(?:\.md|\/)/)?.[1] ?? "";
            if (doc.suggested.has(line)) {
                return {
                    noteId, listItemId, lane: "suggested", period,
                    rule: "Suggested section",
                    source: "The task is under the note's Suggested heading, so it is not part of any lane until accepted"
                };
            }

            const task = scanDocs(docs, TRILIUM_CONFIG, now).tasks.find((t) => t.file === doc.path && t.line === line);
            const horizon = task?.derivations.find((d) => d.axis === "horizon");
            if (!task || !horizon) {
                return { error: "not_found", detail: `Task ${listItemId} was not found in the scan of note ${noteId}` };
            }
            const lateBy = horizon.value === "overdue" ? daysLate(period, now) : null;
            return {
                noteId, listItemId, text: task.text, state: task.state, period,
                lane: horizon.value, rule: horizon.rule, source: horizon.source,
                ...(lateBy === null ? {} : { daysLate: lateBy })
            };
        }),

        add: ({ items, dryRun, html }: AddInput) => withCaiusLock("caius_add", async () => ({
            results: (await addTasks(store, items, { dryRun, now: caiusNow() })).map((r) => presentResult(r, html))
        })),

        accept: ({ items, dryRun, html }: AcceptInput) => withCaiusLock("caius_accept", async () => ({
            results: (await unlessStale(items, (fresh) => acceptTasks(store, fresh, { dryRun }))).map((r) => presentResult(r, html))
        })),

        dismiss: ({ items, dryRun, html }: DismissInput) => withCaiusLock("caius_dismiss", async () => ({
            results: (await unlessStale(items, (fresh) => dismissTasks(store, fresh, { dryRun }))).map((r) => presentResult(r, html))
        })),

        setState: ({ items, dryRun, html }: SetStateInput) => withCaiusLock("caius_set_state", async () => ({
            results: (await unlessStale(items, async (fresh) => {
                const states = await loadStateSymbols(store);
                const results: object[] = [];
                for (const { state, ...item } of fresh) {
                    results.push(...await setStates(store, STATE_ACTION[state], [item], { dryRun, states }));
                }
                return results;
            })).map((r) => presentResult(r, html))
        })),

        forward: ({ items, dryRun, html }: ForwardInput) => withCaiusLock("caius_forward", async () => ({
            results: (await unlessStale(items, (fresh) => forwardTasks(store, fresh, { dryRun }))).map((r) => presentResult(r, html))
        })),

        assignIds: ({ dryRun, html }: AssignIdsInput) => withCaiusLock("caius_assign_ids", async () => {
            const { docs } = await loadJournal(store);
            const results: AssignIdsResult[] = [];
            for (const doc of docs) {
                const result = await assignIdsInNote(store, doc.noteId, doc.path, { dryRun, html });
                if (result) {
                    results.push(result);
                }
            }
            return {
                ...(dryRun ? { dryRun: true } : {}),
                notes: results.length,
                added: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
                results
            };
        })
    };
}

export type CaiusService = ReturnType<typeof createCaiusService>;

export const caiusService = createCaiusService();

/**
 * The moment the planning operations treat as "now": Trilium's local date and time, which follows
 * the `trilium-local-now-datetime` header when the request carries one and the server clock
 * otherwise.
 */
export function caiusNow(): Date {
    const match = dateUtils.localNowDateTime().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!match) {
        return new Date();
    }
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
    return new Date(year, month - 1, day, hour, minute, second);
}

function currentKey(period: "day" | "week" | "month", now: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (period === "day") {
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
    if (period === "month") {
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    }
    // ISO week: the year and number of the week's Thursday.
    const thursday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
    const week = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    return `${thursday.getUTCFullYear()}-W${pad(week)}`;
}

/** One note's part in `assignIds`. */
interface AssignIdsResult {
    noteId: string;
    title?: string;
    path: string;
    /** How many list items get an id. */
    added?: number;
    status: "updated" | "skipped" | "failed";
    reason?: "edited";
    error?: string;
    /** Dry run: the text of each list item that gets an id. */
    items?: string[];
    /** Dry run with `html`: the note's HTML before and after. */
    before?: string;
    after?: string;
}

/**
 * Gives the note's list items without an id one, through the compare-and-swap, and reports how
 * many. Returns null when every item already has an id. A dry run lists the text of each item
 * instead of writing, and with `html` also carries the note's HTML before and after.
 */
async function assignIdsInNote(store: NoteStore, noteId: string, path: string, { dryRun, html }: AssignIdsInput): Promise<AssignIdsResult | null> {
    try {
        const before = await store.content(noteId);
        const items = listItemsWithoutIds(before);
        if (!items.length) {
            return null;
        }

        const after = ensureListItemIds(before);
        const base = { noteId, title: (await store.note(noteId)).title, path, added: items.length };
        if (dryRun) {
            return { ...base, status: "updated", items, ...(html ? { before, after } : {}) };
        }
        return await store.putContent(noteId, after, before)
            ? { ...base, status: "updated" }
            : { ...base, status: "skipped", reason: "edited" };
    } catch (e) {
        return { noteId, path, status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
}

/** An item skipped because its note changed since the client read the `blobId` it sent. */
type StaleSkip = Record<string, unknown> & { noteId: string; status: "skipped"; reason: "stale"; blobId: string };

/**
 * Runs `operation` on the items whose `expectedBlobId`, when given, still matches their note's
 * `blobId`, and skips the rest as stale, keeping the items' order. Every `blobId` is read before
 * `operation` writes anything, so items of one batch that act on the same note all compare against
 * the version the client sent. An item whose note does not exist goes on to the library, which
 * reports it as `not_found`.
 */
async function unlessStale<I extends { noteId: string; expectedBlobId?: string }, R>(
    items: I[],
    operation: (fresh: Omit<I, "expectedBlobId">[]) => Promise<R[]>
): Promise<(R | StaleSkip)[]> {
    const stale = new Map<number, StaleSkip>();
    const fresh: Omit<I, "expectedBlobId">[] = [];
    for (const [index, { expectedBlobId, ...item }] of items.entries()) {
        const blobId = becca.notes[item.noteId]?.blobId;
        if (expectedBlobId !== undefined && blobId !== undefined && blobId !== expectedBlobId) {
            stale.set(index, { ...item, status: "skipped", reason: "stale", blobId });
        } else {
            fresh.push(item);
        }
    }

    const done = fresh.length ? await operation(fresh) : [];
    const results: (R | StaleSkip)[] = [];
    let next = 0;
    for (const index of items.keys()) {
        const result = stale.get(index) ?? done[next++];
        if (result === undefined) {
            throw new Error("The library returned fewer results than it was given items");
        }
        results.push(result);
    }
    return results;
}

/** An open task as the library reports it, plus the lane it sits in and, when overdue, how late it is. */
type LaneTask = OpenTask & { lane: string | null; daysLate?: number };

function toLaneTask(task: OpenTask, lane: string | null, now: Date): LaneTask {
    const lateBy = lane === "overdue" ? daysLate(task.period, now) : null;
    return { ...task, lane, ...(lateBy === null ? {} : { daysLate: lateBy }) };
}
