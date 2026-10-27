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
    addContext,
    addTasks,
    caiusClock,
    clockOverride,
    daysLate,
    diffSummary,
    dismissTasks,
    ensureListItemIds,
    findPeriodNote,
    forwardTasks,
    gatherContext,
    isPeriodKey,
    label,
    listItemsWithoutIds,
    loadJournal,
    loadStateSymbols,
    meetingLines,
    readRhythm,
    type NoteStore,
    openTasks,
    type OpenTask,
    presentResult,
    readPlan,
    renderDayTerrain,
    scanDocs,
    setMeetings,
    setStates,
    type StateAction,
    suggestedTasks,
    TRILIUM_CONFIG,
    withListItemIds
} from "@triliumnext/caius";
import { becca, date_utils as dateUtils, markdownExportService, markdownImportService } from "@triliumnext/core";
import { t } from "i18next";

import {
    type AcceptInput,
    type AddInput,
    type ApplyInput,
    type AssignIdsInput,
    type BriefWriteInput,
    type ContextAddInput,
    type ContextInput,
    DEFAULT_OPEN_LIMIT,
    type DismissInput,
    type ExplainInput,
    type ForwardInput,
    type HeaderDay,
    type HeaderInput,
    type InputsInput,
    type MeetingsInput,
    type NudgeInput,
    type OpenInput,
    type PlanDayInput,
    type PlanInput,
    type SetStateInput,
    type SkipCatchupInput,
    type WindDownInput
} from "./schemas.js";
import { findBrief, PLANNED_AT_LABEL, SKIP_CATCHUP_LABEL, writeBrief } from "./brief.js";
import { catchupOf, type DayRead, planDay, type Standing, type StepDeps, windDown } from "./daily.js";
import { type CaiusInputs, isInputWarning, readInputs } from "./inputs/index.js";
import { createBeccaStore, putAttachment, setLabel, withCaiusLock } from "./store.js";
import { type DayWeather, fetchDayWeather } from "./weather.js";

export { routeInputs } from "./schemas.js";

const TERRAIN_TITLE = "terrain.svg";

/** How long a `caius_inputs` answer is reused for the same day and Context. */
export const INPUTS_TTL_MS = 15 * 60_000;

export type InputsReader = (input: InputsInput) => Promise<CaiusInputs>;

/** The label of the standing note, "How I work". */
const STANDING_LABEL = "assistantContext";

const STATE_ACTION: Record<"done" | "doing" | "cancelled", StateAction> = {
    done: "done",
    doing: "start",
    cancelled: "drop"
};

export function createCaiusService(
    baseStore: NoteStore = createBeccaStore(),
    weatherOf: (latitude: number, longitude: number) => Promise<DayWeather | undefined> = fetchDayWeather,
    inputsOf: InputsReader = (input) => readInputs(input),
    clockMs: () => number = Date.now
) {
    const store = withListItemIds(baseStore);
    const inputsCache = new Map<string, { at: number; inputs: CaiusInputs }>();

    /** The standing note (`#assistantContext`) as markdown. The caller holds the lock. */
    async function readStanding(): Promise<Standing> {
        const [ note ] = (await store.search(`#${STANDING_LABEL}`)).filter((n) => n.attributes.some((a) => a.type === "label" && a.name === STANDING_LABEL));
        if (!note) {
            return { markdown: null, missing: t("caius.daily.standing_missing") };
        }
        if (note.type !== "text" || note.isProtected) {
            return { markdown: null, missing: t("caius.daily.standing_unreadable") };
        }
        return { markdown: markdownExportService.toMarkdown(await store.content(note.noteId)) };
    }

    /**
     * `caius_inputs` for a day, with the Context in force passed along and the work window from the
     * standing note's Rhythm. An answer for the same input is reused for `INPUTS_TTL_MS`, timed on
     * the real clock since `CAIUS_NOW` stands still, unless a source failed; `refresh` fetches again. The notes are read
     * under the lock, the sources outside it.
     */
    async function dayRead(date: string, refresh = false): Promise<DayRead> {
        const { context, standing } = await withCaiusLock("caius_day_read", async () => ({
            context: (await gatherContext(store, date)).context,
            standing: await readStanding()
        }));
        const rhythm = readRhythm(standing.markdown);
        const input: InputsInput = { date, context: context.map((line) => line.text), workStart: rhythm.start, workEnd: rhythm.workEnd };
        const key = JSON.stringify(input);
        const hit = inputsCache.get(key);
        if (!refresh && hit && clockMs() - hit.at < INPUTS_TTL_MS) {
            return { inputs: hit.inputs, context, standing, rhythm };
        }
        const inputs = await inputsOf(input);
        for (const [ old, entry ] of inputsCache) {
            if (clockMs() - entry.at >= INPUTS_TTL_MS) inputsCache.delete(old);
        }
        // An answer missing a source is fetched again next time, so the source can come back, and
        // an older answer is not served after it.
        if (inputs.errors.every((e) => isInputWarning(e.error))) {
            inputsCache.set(key, { at: clockMs(), inputs });
        } else {
            inputsCache.delete(key);
        }
        return { inputs, context, standing, rhythm };
    }

    const stepDeps = (): StepDeps => ({ store, now: caiusNow(), locked: withCaiusLock, dayRead, standing: readStanding });

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
            const docs = await journalDocs(store);
            if (!docs) {
                return { total: 0, tasks: [], ...NO_JOURNAL };
            }
            const result = scanDocs(docs, TRILIUM_CONFIG, now);
            const tasks = [
                ...openTasks(docs, result).map((t) => toLaneTask(t, t.horizon, now)),
                ...suggestedTasks(docs, now).map((t) => toLaneTask(t, "suggested", now))
            ].filter((t) => !lane || t.lane === lane);
            return { total: tasks.length, tasks: tasks.slice(0, limit) };
        }),

        explain: ({ noteId, listItemId }: ExplainInput) => withCaiusLock("caius_explain", async () => {
            const now = caiusNow();
            const docs = await journalDocs(store);
            if (!docs) {
                return { error: "not_found", detail: "There is no Journal: no note carries #calendarRoot", ...NO_JOURNAL };
            }
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
                    source: "The task is under the note's Suggested heading, so it is not part of any lane until accepted",
                    summary: t("caius.explain.suggested")
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
                ...(lateBy === null ? {} : { daysLate: lateBy }),
                summary: explainSummary(horizon.value, horizon.rule, horizon.source, lateBy)
            };
        }),

        context: ({ date }: ContextInput) => withCaiusLock("caius_context", () => gatherContext(store, date)),

        add: ({ items, dryRun, html }: AddInput) => withCaiusLock("caius_add", async () => withBlobIds(
            (await addTasks(store, items, { dryRun, now: caiusNow() })).map((r) => presentResult(r, html))
        )),

        accept: ({ items, dryRun, html }: AcceptInput) => withCaiusLock("caius_accept", async () => withBlobIds(
            (await unlessStale(items, (fresh) => acceptTasks(store, fresh, { dryRun }))).map((r) => presentResult(r, html))
        )),

        dismiss: ({ items, dryRun, html }: DismissInput) => withCaiusLock("caius_dismiss", async () => withBlobIds(
            (await unlessStale(items, (fresh) => dismissTasks(store, fresh, { dryRun }))).map((r) => presentResult(r, html))
        )),

        setState: ({ items, dryRun, html }: SetStateInput) => withCaiusLock("caius_set_state", async () => withBlobIds(
            (await unlessStale(items, (fresh) => setStatesOf(store, fresh, dryRun))).map((r) => presentResult(r, html))
        )),

        forward: ({ items, dryRun, html }: ForwardInput) => withCaiusLock("caius_forward", async () => withBlobIds(
            (await unlessStale(items, (fresh) => forwardTasks(store, fresh, { dryRun }))).map((r) => presentResult(r, html))
        )),

        apply: ({ forwards, drops, expectedBlobId }: ApplyInput) => withCaiusLock("caius_apply", async () => {
            // One version check before the first write: every item is compared with the same token.
            const items = [
                ...forwards.map((item) => ({ ...item, expectedBlobId })),
                ...drops.map((item) => ({ ...item, expectedBlobId }))
            ];
            return withBlobIds((await unlessStale(items, async (fresh) => {
                const forwarding = fresh.filter((item): item is typeof forwards[number] => "to" in item);
                const dropping = fresh.filter((item): item is typeof drops[number] => "state" in item);
                return [
                    ...(forwarding.length ? await forwardTasks(store, forwarding, {}) : []),
                    ...(dropping.length ? await setStatesOf(store, dropping) : [])
                ];
            })).map((r) => presentResult(r)));
        }),

        /** Replaces the Meetings block of a day note; no tool or route reaches it yet. */
        setMeetings: ({ date, lines, dryRun }: { date: string; lines: string[]; dryRun?: boolean }) => withCaiusLock("caius_set_meetings", async () => {
            const result = await setMeetings(store, { date, lines }, { dryRun });
            return withBlobIds([ result ]);
        }),

        /**
         * Writes the Meetings block of a day note: `items` when given, else the day's calendar as
         * clock lines. A calendar that could not be read writes nothing, so a feed that fails never
         * empties the block.
         */
        meetings: async ({ date, items, dryRun, refresh }: MeetingsInput) => {
            let lines = items;
            if (!lines) {
                const { inputs } = await dayRead(date, refresh);
                const errors = inputs.errors.filter((e) => e.source === "calendar" && !isInputWarning(e.error));
                if (errors.length) {
                    return { date, status: "skipped", reason: "calendar_unavailable", errors };
                }
                lines = meetingLines(inputs.calendar);
            }
            const written = lines;
            return withCaiusLock("caius_meetings", async () => {
                const result = await setMeetings(store, { date, lines: written }, { dryRun });
                return { date, source: items ? "items" : "calendar", lines: written, ...withBlobIds([ withDiff(result) ]) };
            });
        },

        contextAdd: ({ dryRun, ...req }: ContextAddInput) => withCaiusLock("caius_context_add", async () => {
            const result = await addContext(store, req, { dryRun, now: caiusNow() });
            return withBlobIds([ withDiff(result) ]);
        }),

        /** Labels the day note `#caiusSkipCatchup=<date>`, so Plan my day treats its catch-up as done. */
        skipCatchup: ({ date }: SkipCatchupInput) => withCaiusLock("caius_skip_catchup", async () => {
            const existing = await findPeriodNote(store, "day", date);
            const note = existing ?? await store.calendarDay(date);
            if (note.isProtected) {
                return { date, error: "bad_request", detail: `The day note for ${date} is protected` };
            }
            const labelled = note.attributes.some((a) => a.type === "label" && a.name === SKIP_CATCHUP_LABEL && a.value === date);
            if (!labelled) setLabel(note.noteId, SKIP_CATCHUP_LABEL, date);
            return { date, noteId: note.noteId, status: labelled ? "unchanged" : "updated", created: !existing };
        }),

        winddown: (input: WindDownInput) => windDown(stepDeps(), input),

        planday: (input: PlanDayInput) => planDay(stepDeps(), input),

        /**
         * The state of the nudge bar on the day note of `date`, by the rules of the `catchup` step and
         * the brief lookup of `caius_brief_write`: `catchup` while the last workday has live tasks,
         * then `planned` once the day has a brief, else `unplanned`. Reads only.
         */
        nudge: ({ date }: NudgeInput) => withCaiusLock("caius_nudge", async () => {
            const { lastWorkday, note, tasks } = await catchupOf(store, date, caiusNow());
            if (tasks.length) {
                return { date, state: "catchup", lastWorkday, tasks: tasks.map(({ noteId, listItemId, text }) => ({ noteId, listItemId, text })) };
            }
            const brief = note ? await findBrief(store, note.noteId, date) : null;
            return brief
                ? { date, state: "planned", lastWorkday, plannedAt: label(brief, PLANNED_AT_LABEL) ?? null }
                : { date, state: "unplanned", lastWorkday };
        }),

        header: async ({ noteId, latitude, longitude, ...day }: HeaderInput) => {
            // The forecast can take 3 s, so it is fetched before the lock is taken.
            const weather = latitude === undefined || longitude === undefined ? undefined : await weatherOf(latitude, longitude);
            return withCaiusLock("caius_header", async () => {
                const note = await store.note(noteId).catch(() => undefined);
                if (!note) {
                    return { error: "not_found", detail: `Note '${noteId}' not found` };
                }
                if (note.isProtected) {
                    return { error: "bad_request", detail: `Note '${noteId}' is protected and cannot be modified` };
                }
                const { attachmentId, created } = drawHeader(noteId, day, weather);
                return { attachmentId, created, snippet: `<img src="api/attachments/${attachmentId}/image/${TERRAIN_TITLE}">` };
            });
        },

        /**
         * Writes the day's Morning Brief, its `Header` child with the drawing, and the header's
         * include-note at the top of the day note. The weather is fetched before the lock.
         */
        briefWrite: async ({ latitude, longitude, ...input }: BriefWriteInput) => {
            const weather = input.dryRun || latitude === undefined || longitude === undefined ? undefined : await weatherOf(latitude, longitude);
            return withCaiusLock("caius_brief_write", () => writeBrief({
                store,
                draw: (noteId) => drawHeader(noteId, input.header, weather).attachmentId,
                render: (markdown, title) => markdownImportService.renderToHtml(markdown, title),
                plannedAt: localIso(caiusNow())
            }, input));
        },

        assignIds: ({ dryRun, html }: AssignIdsInput) => withCaiusLock("caius_assign_ids", async () => {
            const docs = await journalDocs(store);
            const results: AssignIdsResult[] = [];
            for (const doc of docs ?? []) {
                const result = await assignIdsInNote(store, doc.noteId, doc.path, { dryRun, html });
                if (result) {
                    results.push(result);
                }
            }
            return {
                ...(dryRun ? { dryRun: true } : {}),
                notes: results.length,
                added: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
                ...withBlobIds(results),
                ...(docs ? {} : NO_JOURNAL)
            };
        })
    };
}

export type CaiusService = ReturnType<typeof createCaiusService>;

export const caiusService = createCaiusService();

/**
 * The moment the planning operations treat as "now": Trilium's local date and time, which follows
 * the `trilium-local-now-datetime` header when the request carries one and the server clock
 * otherwise. With `TRILIUM_ENV=dev`, `CAIUS_NOW` replaces it (see `caiusClock()` in the library).
 */
export function caiusNow(env: Record<string, string | undefined> = process.env): Date {
    return caiusClock(env, triliumNow);
}

/** `CAIUS_NOW` as the local `YYYY-MM-DDTHH:mm:ss` the client reads, or `undefined` outside dev. */
export function caiusDevNow(env: Record<string, string | undefined> = process.env): string | undefined {
    const at = clockOverride(env);
    return at ? localIso(at) : undefined;
}

/** A moment as local `YYYY-MM-DDTHH:mm:ss`. */
function localIso(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Draws the day on a note as its `terrain.svg` attachment, created or updated. The caller holds the lock. */
function drawHeader(noteId: string, day: HeaderDay, weather: DayWeather | undefined) {
    const svg = renderDayTerrain({ ...day, ...(weather ? { weather } : {}) });
    return putAttachment(noteId, { role: "image", mime: "image/svg+xml", title: TERRAIN_TITLE, content: svg });
}

function triliumNow(): Date {
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

/**
 * One sentence on why a task sits in its lane, such as "Overdue by 3 days: it's in the day note for
 * Monday 26 October, which is past." It reads the period and how it relates to now from `source`
 * (`past day 2026-10-26 vs now`), and falls back to `rule` and `source` for any other horizon rule.
 */
export function explainSummary(lane: string | null, rule: string, source: string, lateBy: number | null): string {
    const laneLabel = lane === "overdue" && lateBy
        ? t("caius.explain.overdue_by", { count: lateBy })
        : t(`caius.explain.lane.${lane ?? "none"}`, { defaultValue: (lane ?? "none").replaceAll("_", " ") });
    const { relation, unit, key } = source.match(
        /^(?<relation>past|current|future) (?<unit>day|week|month) (?<key>\S+) vs now$/
    )?.groups ?? {};
    if (!relation || !unit || !key) {
        return t("caius.explain.other", { lane: laneLabel, rule, source });
    }

    return t(`caius.explain.${relation}.${unit}`, { lane: laneLabel, period: periodName(unit, key) });
}

/** "Monday 26 October", "week 43 of 2026" or "October 2026", with names from the server catalogue. */
function periodName(unit: string, key: string): string {
    const day = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (unit === "day" && day) {
        const [year, month, date] = day.slice(1).map(Number) as [number, number, number];
        const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()] ?? "";
        return t("caius.explain.day_name", {
            weekday: t(`weekdays.${weekday}`), day: date, month: t(`months.${MONTHS[month - 1] ?? ""}`)
        });
    }

    const week = key.match(/^(\d{4})-W(\d{2})$/);
    if (unit === "week" && week) {
        return t("caius.explain.week_name", { week: Number(week[2]), year: week[1] });
    }

    const month = key.match(/^(\d{4})-(\d{2})$/);
    if (unit === "month" && month) {
        return t("caius.explain.month_name", { month: t(`months.${MONTHS[Number(month[2]) - 1] ?? ""}`), year: month[1] });
    }

    return key;
}

const WEEKDAYS = [ "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday" ];
const MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
];

/** Runs set state over `items` one at a time, each with its own action. */
async function setStatesOf(
    store: NoteStore,
    items: Omit<SetStateInput["items"][number], "expectedBlobId">[],
    dryRun?: boolean
) {
    const states = await loadStateSymbols(store);
    const results: object[] = [];
    for (const { state, ...item } of items) {
        results.push(...await setStates(store, STATE_ACTION[state], [item], { dryRun, states }));
    }
    return results;
}

/**
 * `results` with the current `blobId` of every note they name (an item's `noteId`, and the
 * `writtenNoteId` or `writtenNoteIds` it wrote). Read inside the Caius lock, right after the
 * writes, so a client knows which version of each note is the final one.
 */
function withBlobIds<R extends object>(results: R[]) {
    const blobIds: Record<string, string> = {};
    for (const result of results) {
        const named = result as { noteId?: unknown; writtenNoteId?: unknown; writtenNoteIds?: unknown };
        const noteIds = [
            named.noteId, named.writtenNoteId, ...(Array.isArray(named.writtenNoteIds) ? named.writtenNoteIds : [])
        ];
        for (const noteId of noteIds) {
            const blobId = typeof noteId === "string" ? becca.notes[noteId]?.blobId : undefined;
            if (typeof noteId === "string" && blobId) {
                blobIds[noteId] = blobId;
            }
        }
    }
    return { results, blobIds };
}

/** A dry run's result with its full `before` and `after` HTML reduced to the diff summary. */
function withDiff<R extends object>(result: R): R | Omit<R, "before" | "after"> {
    if (!("before" in result) || !("after" in result) || typeof result.before !== "string" || typeof result.after !== "string") {
        return result;
    }
    const { before, after, ...rest } = result;
    return { ...rest, ...diffSummary(before, after) };
}

/**
 * The Journal's notes, or null when no note carries `#calendarRoot`: a document that doesn't use the
 * Journal, whose reads answer with {@link NO_JOURNAL} rather than an error.
 */
async function journalDocs(store: NoteStore) {
    if (!(await store.search("#calendarRoot")).length) {
        return null;
    }
    return (await loadJournal(store)).docs;
}

/** Added to an answer from a document with no Journal, so that it reads apart from "nothing to do". */
const NO_JOURNAL = { journal: false } as const;

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
    /** Dry run without `html`: what differs between the note's HTML before and after. */
    changes?: { noteId: string; role: "target"; removed: string; added: string }[];
    /** Dry run with `html`: the note's HTML before and after. */
    before?: string;
    after?: string;
}

/**
 * Gives the note's list items without an id one, through the compare-and-swap, and reports how
 * many. Returns null when every item already has an id. A dry run lists the text of each item
 * instead of writing, with the diff summary of the change, or with `html` the note's HTML before
 * and after.
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
            return {
                ...base, status: "updated", items,
                ...(html ? { before, after } : { changes: [{ noteId, role: "target", ...diffSummary(before, after) }] })
            };
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
