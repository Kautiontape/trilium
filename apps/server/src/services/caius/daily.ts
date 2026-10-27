/**
 * The steps of the two planning conversations, `caius_winddown` and `caius_planday`. Each step
 * reads the notes again and answers `{ step, data, question, next }`: the facts, the exact question
 * for the agent to ask (null when there is nothing to ask) and the step after it. No state is kept
 * outside the notes, apart from the inputs cache the service holds.
 */

import {
    type Candidate,
    type ContextEntry,
    dayCandidates,
    formatHours,
    gatherContext,
    isoWeekKey,
    keysOf,
    liveKeys,
    loadJournal,
    nextWorkday,
    normName,
    type NoteStore,
    openTasks,
    overlapPairs,
    type PlanTask,
    type PlanView,
    readPlan,
    readRhythm,
    type Rhythm,
    scanDocs,
    TRILIUM_CONFIG
} from "@triliumnext/caius";
import { t } from "i18next";

import type { CaiusInputs } from "./inputs/types.js";
import { overriddenKeys } from "./inputs/jira.js";

/** The standing note as markdown, or null with the one-line reason. */
export interface Standing {
    markdown: string | null;
    missing?: string;
}

/** What a step reads about a day from outside its notes, and the Context and rhythm it was read with. */
export interface DayRead {
    inputs: CaiusInputs;
    context: ContextEntry[];
    standing: Standing;
    rhythm: Rhythm;
}

export interface StepDeps {
    store: NoteStore;
    now: Date;
    /** Runs `fn` under the Caius lock. */
    locked: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    /** The day's inputs, cached, with the Context in force and the standing note. */
    dayRead: (date: string, refresh?: boolean) => Promise<DayRead>;
    /** The standing note, read under the lock. */
    standing: () => Promise<Standing>;
}

export type WindDownStep = "open" | "next" | "context";

const EVENING_SECTIONS = new Set([ "evening", "recharge" ]);

export async function windDown(deps: StepDeps, { date, step, refresh }: { date: string; step: WindDownStep; refresh?: boolean }) {
    const targetDay = dayKey(nextWorkday(localDay(date)));
    const reply = (standing: Standing, data: object, question: string | null, next: WindDownStep | null) => ({
        step, date, targetDay, targetDayName: weekdayName(targetDay), data, question, next,
        standing: standing.markdown, ...(standing.missing ? { standingMissing: standing.missing } : {})
    });

    if (step === "open") {
        const { standing, items } = await deps.locked("caius_winddown", async () => ({
            standing: await deps.standing(),
            items: await stillOpen(deps.store, date, targetDay)
        }));
        const question = items.length ? t("caius.daily.open", { day: weekdayName(targetDay) }) : null;
        return reply(standing, { items, ...(items.length ? {} : { summary: t("caius.daily.nothing_open") }) }, question, "next");
    }

    const read = await deps.dayRead(targetDay, refresh);
    if (step === "next") {
        const facts = await deps.locked("caius_winddown", () => dayFacts(deps.store, targetDay, deps.now));
        const candidates = dayCandidates({ jira: read.inputs.jira, week: facts.week, live: facts.live, exclude: facts.exclude }).map(present);
        const plannedMinutes = facts.plan.capacity.totalMinutes;
        const candidateMinutes = candidates.reduce((sum, c) => sum + c.minutes, 0);
        const targetMinutes = read.inputs.capacity.targetMinutes;
        const overlaps = overlapPairs(read.inputs.calendar);
        const evening = { hasTask: facts.evening };
        const over = plannedMinutes + candidateMinutes - targetMinutes;
        const questions = [
            ...(over > 0 ? [ t("caius.daily.over", { day: weekdayName(targetDay), hours: Math.max(0.5, Math.round(over / 30) / 2) }) ] : []),
            ...overlaps.map((pair) => t("caius.daily.overlap", { first: pair.first, second: pair.second, time: pair.at })),
            ...(evening.hasTask ? [] : [ t("caius.daily.evening") ])
        ];
        const summary = questions.length ? {} : {
            summary: t("caius.daily.fits", { day: weekdayName(targetDay), planned: formatHours(plannedMinutes + candidateMinutes), open: formatHours(targetMinutes) })
        };
        return reply(read.standing, {
            candidates,
            capacity: { plannedMinutes, candidateMinutes, targetMinutes, bookedRatio: read.inputs.capacity.bookedRatio },
            overlaps, evening, errors: read.inputs.errors, ...summary
        }, questions.length ? questions.join(" ") : null, "context");
    }

    // A line in force today that lapses before the target day and keeps a ticket Jira calls done open.
    const today = await deps.locked("caius_winddown", () => gatherContext(deps.store, date));
    const done = new Set(read.inputs.jira.done);
    const noticed = today.context
        .filter((line) => line.until !== undefined && line.until < targetDay)
        .flatMap((line) => [ ...overriddenKeys([ line.text ]) ].filter((key) => done.has(key)).map((key) => ({
            line: line.text, until: line.until, key, question: t("caius.daily.keep", { line: line.text })
        })));
    const question = noticed.length ? [ ...noticed.map((n) => n.question), t("caius.daily.context", { day: weekdayName(targetDay) }) ].join(" ") : null;
    return reply(read.standing, { context: read.context, noticed }, question, null);
}

/**
 * The live tasks the wind-down of `date` closes: those in its day note, the overdue ones and those
 * in its ISO week note, each with its proposed fate. A sub-item goes with its listed parent.
 */
async function stillOpen(store: NoteStore, date: string, targetDay: string) {
    const docs = (await loadJournal(store)).docs;
    const week = isoWeekKey(utcDay(date));
    const tasks = openTasks(docs, scanDocs(docs, TRILIUM_CONFIG, noon(date)));
    const group = (task: (typeof tasks)[number]) => task.period === date ? "today" : task.horizon === "overdue" ? "overdue" : task.period === week ? "week" : null;
    const listed = tasks.filter((task) => group(task) !== null);
    const ids = new Set(listed.map((task) => `${task.noteId}/${task.listItemId}`));
    return listed
        .filter((task) => !task.parentListItemId || !ids.has(`${task.noteId}/${task.parentListItemId}`))
        .map((task) => ({
            group: group(task), noteId: task.noteId, listItemId: task.listItemId, text: task.text, period: task.period,
            section: task.section, critical: task.critical,
            fate: group(task) === "week" ? { stay: week } : { forward: targetDay }
        }));
}

/** What a day's candidates are checked against: its plan, the week's items, the live keys and what is already suggested or dismissed there. */
async function dayFacts(store: NoteStore, date: string, now: Date) {
    const plan = await readPlan(store, "day", date, now);
    const weekKey = isoWeekKey(utcDay(date));
    const weekPlan = await readPlan(store, "week", weekKey, now);
    const live = liveKeys((await loadJournal(store)).docs, now);
    const exclude = [ ...plan.dismissed, ...plan.suggested.flatMap((task) => keysOf(task.text)) ];
    const evening = plan.sections.some((section) => EVENING_SECTIONS.has(normName(section.name ?? "")) && section.tasks.some(isLive));
    return { plan, week: { key: weekKey, tasks: mainTasks(weekPlan) }, live, exclude, evening };
}

/** The live top-level tasks of a plan, the Important block first, then in his order. */
export function mainTasks(plan: PlanView): PlanTask[] {
    return [ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ].filter((task) => isLive(task) && task.parent === null);
}

const isLive = (task: PlanTask) => task.state === "open" || task.state === "in_progress";

/** A candidate as the step reports it: `Get X done` (a week item keeps its own text) with its reason in words. */
export function present(candidate: Candidate) {
    const { subject, reason, keys: _keys, ...rest } = candidate;
    const because = reason.kind === "handoff"
        ? reason.days === null
            ? t("caius.daily.because_handoff_unknown", { status: reason.status })
            : t("caius.daily.because_handoff", { status: reason.status, count: reason.days })
        : reason.kind === "ask"
            ? t("caius.daily.because_ask", { author: reason.author, weekday: weekdayName(dayKey(new Date(reason.created))) })
            : t("caius.daily.because_week");
    return { text: reason.kind === "week" ? subject : t("caius.daily.get_done", { subject }), because, ...rest };
}

/** The weekday of a `YYYY-MM-DD`, from the server catalogue: "Monday". */
export function weekdayName(date: string): string {
    return t(`weekdays.${WEEKDAYS[utcDay(date).getUTCDay()]}`);
}

const WEEKDAYS = [ "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday" ];

export function localDay(date: string): Date {
    return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/** Noon of the day, local: the moment lanes are worked out from when closing that day. */
function noon(date: string): Date {
    const at = localDay(date);
    at.setHours(12);
    return at;
}

function utcDay(date: string): Date {
    return new Date(`${date}T00:00:00Z`);
}

export function dayKey(at: Date): string {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
