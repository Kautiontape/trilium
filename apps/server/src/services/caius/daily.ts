/**
 * The steps of the two planning conversations, `caius_winddown` and `caius_planday`. Each step
 * reads the notes again and answers `{ step, data, question, next }`: the facts, the exact question
 * for the agent to ask (null when there is nothing to ask) and the step after it. No state is kept
 * outside the notes, apart from the inputs cache the service holds.
 */

import {
    type Candidate,
    type ContextEntry,
    contextNotes,
    dayCandidates,
    DEFAULT_ESTIMATE,
    findPeriodNote,
    formatHours,
    gatherContext,
    isoWeekKey,
    keysOf,
    label,
    lastWorkday,
    layoutWork,
    liveKeys,
    loadJournal,
    meetingLines,
    nextWorkday,
    normName,
    type NoteStore,
    openTasks,
    overlapPairs,
    type PlanTask,
    type PlanView,
    readPlan,
    type Rhythm,
    scanDocs,
    sectionOf,
    TRILIUM_CONFIG
} from "@triliumnext/caius";
import { t } from "i18next";

import { PLANNED_AT_LABEL, SKIP_CATCHUP_LABEL, findBrief } from "./brief.js";
import { isInputWarning } from "./inputs/index.js";
import { overriddenKeys } from "./inputs/jira.js";
import type { CaiusInputs } from "./inputs/types.js";

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
        const { eveningMinutes } = facts;
        const plannedMinutes = facts.plan.capacity.totalMinutes - eveningMinutes;
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
            capacity: { plannedMinutes, eveningMinutes, candidateMinutes, targetMinutes, bookedRatio: read.inputs.capacity.bookedRatio },
            overlaps, evening, errors: read.inputs.errors, ...summary
        }, questions.length ? questions.join(" ") : null, "context");
    }

    // A line in force today that lapses before the target day and keeps a ticket open: Jira's own
    // answer is not consulted, since it covers only tickets that are hand-offs or have an ask.
    const today = await deps.locked("caius_winddown", () => gatherContext(deps.store, date));
    const keep = today.context
        .filter((line) => line.until !== undefined && line.until < targetDay)
        .map((line) => ({ kind: "keep" as const, line: line.text, until: line.until, keys: [ ...overriddenKeys([ line.text ]) ] }))
        .filter((line) => line.keys.length)
        .map((line) => ({ ...line, question: t("caius.daily.keep", { line: line.line }) }));
    const targetWeek = isoWeekKey(utcDay(targetDay));
    const carry = carryLines(today.context, targetDay, read.context);
    const noticed = [ ...keep, ...carry ];
    const sameWeek = isoWeekKey(utcDay(date)) === targetWeek;
    const questions = [ ...keep.map((n) => n.question), ...(carry.length ? [ carryQuestion(carry.map((c) => c.line), sameWeek) ] : []) ];
    const question = questions.length ? [ ...questions, t("caius.daily.context", { day: weekdayName(targetDay) }) ].join(" ") : null;
    return reply(read.standing, { context: read.context, targetWeek, noticed }, question, null);
}

export type PlanDayStep = "catchup" | "inputs" | "brief";

/** Share of the work window booked by meetings above which Plan my day offers to move a task. */
const HEAVY_RATIO = 0.6;
/** Longest work-bar label before it is cut. */
const LABEL_LENGTH = 24;

export async function planDay(deps: StepDeps, { date, step, refresh }: { date: string; step: PlanDayStep; refresh?: boolean }) {
    const reply = (standing: Standing, data: object, question: string | null, next: PlanDayStep | null) => ({
        step, date, data, question, next,
        standing: standing.markdown, ...(standing.missing ? { standingMissing: standing.missing } : {})
    });

    if (step === "catchup") {
        const { standing, catchup: { lastWorkday: last, skipped, tasks } } = await deps.locked("caius_planday", async () => ({
            standing: await deps.standing(),
            catchup: await catchupOf(deps.store, date, deps.now)
        }));
        const question = tasks.length
            ? t("caius.daily.catchup", { weekday: weekdayName(last), count: tasks.length })
            : null;
        return reply(standing, { lastWorkday: last, moveTo: date, skipped, tasks }, question, "inputs");
    }

    const read = await deps.dayRead(date, refresh);
    const calendarFailed = read.inputs.errors.some((e) => e.source === "calendar" && !isInputWarning(e.error));

    if (step === "inputs") {
        const facts = await deps.locked("caius_planday", async () => {
            const day = await dayFacts(deps.store, date, deps.now);
            const brief = day.plan.noteId ? await findBrief(deps.store, day.plan.noteId, date) : null;
            const lastContext = await gatherContext(deps.store, dayKey(lastWorkday(localDay(date))));
            return { ...day, plannedAt: brief ? label(brief, PLANNED_AT_LABEL) ?? null : null, lastContext: lastContext.context };
        });
        const since = facts.plannedAt ? localMoment(facts.plannedAt) : undefined;
        const candidates = dayCandidates({ jira: read.inputs.jira, week: facts.week, live: facts.live, exclude: facts.exclude, since }).map(present);
        const lines = calendarFailed ? null : meetingLines(read.inputs.calendar);
        const meetings = lines
            ? { lines, current: facts.plan.meetings, changed: lines.join("\n") !== facts.plan.meetings.join("\n") }
            : { lines: null, current: facts.plan.meetings, changed: false };
        const overlaps = overlapPairs(read.inputs.calendar);
        const last = mainTasks(facts.plan).filter((task) => !task.critical).at(-1);
        const nextDay = dayKey(nextWorkday(localDay(date)));
        const heavy = read.inputs.capacity.bookedRatio > HEAVY_RATIO && last?.listItemId;
        const forwardSuggestion = heavy && last ? { noteId: last.noteId, listItemId: last.listItemId, text: last.text, to: nextDay } : null;
        // Run every morning, whatever the catch-up answer was, so a missed wind-down doesn't let a line lapse.
        // The day being planned is in the week its lines go to, so the question never says "next week".
        const carry = carryLines(facts.lastContext, date, read.context);
        const questions = [
            ...overlaps.map((pair) => t("caius.daily.overlap", { first: pair.first, second: pair.second, time: pair.at })),
            ...(forwardSuggestion ? [ t("caius.daily.heavy", {
                percent: Math.round(read.inputs.capacity.bookedRatio * 100), task: forwardSuggestion.text, day: weekdayName(nextDay)
            }) ] : []),
            ...(carry.length ? [ carryQuestion(carry.map((c) => c.line), true) ] : [])
        ];
        return reply(read.standing, {
            plannedAt: facts.plannedAt, candidates, meetings, overlaps, capacity: read.inputs.capacity,
            targetWeek: isoWeekKey(utcDay(date)), carry,
            context: read.context, forwardSuggestion, errors: read.inputs.errors
        }, questions.length ? questions.join(" ") : null, "brief");
    }

    const plan = await deps.locked("caius_planday", () => readPlan(deps.store, "day", date, deps.now));
    const { start, end, workEnd, from } = read.rhythm;
    // The drawing takes whatever the feeds returned; only the Meetings block refuses a partial calendar.
    const events = read.inputs.calendar
        .filter((e) => !e.allDay && !e.declined && e.end > start && e.start < end)
        .map((e) => ({ start: e.start < start ? start : e.start, end: e.end > end ? end : e.end, title: e.title, ...(e.overlap ? { overlap: true } : {}) }));
    const eveningSections = new Set(plan.sections.filter((section) => EVENING_SECTIONS.has(normName(section.name ?? ""))).map((section) => section.name));
    const { work, unplaced } = layoutWork({ start, end, workEnd }, events, mainTasks(plan).map((task) => ({
        label: workLabel(task.text), minutes: task.estMinutes ?? DEFAULT_ESTIMATE, evening: eveningSections.has(task.section)
    })));
    const header = { start, end, workEnd, events, work };
    const coordinates = read.rhythm.latitude === undefined ? {} : { latitude: read.rhythm.latitude, longitude: read.rhythm.longitude };
    return reply(read.standing, {
        day: { start, end, workEnd, from },
        header,
        unplaced,
        briefRules: sectionOf(read.standing.markdown, "Brief rules"),
        shape: {
            date, headline: "",
            acts: [ { range: "", text: "" }, { range: "", text: "" }, { range: "", text: "" } ],
            picks: [],
            sections: [ { title: t("caius.daily.follow_up"), markdown: "" }, { title: t("caius.daily.heads_up"), markdown: "" } ],
            header,
            ...coordinates
        },
        errors: read.inputs.errors
    }, null, null);
}

/**
 * What Plan my day offers to move to `date`: the live top-level tasks of the last workday, or none
 * once the day note carries `#caiusSkipCatchup=<date>`, or when the last workday's note is protected
 * or not a text note, since Caius cannot read it. Answers the day note too, without creating it.
 * The caller holds the lock.
 */
export async function catchupOf(store: NoteStore, date: string, now: Date) {
    const last = dayKey(lastWorkday(localDay(date)));
    const note = await findPeriodNote(store, "day", date);
    const skipped = !!note?.attributes.some((a) => a.type === "label" && a.name === SKIP_CATCHUP_LABEL && a.value === date);
    const lastNote = skipped ? undefined : await findPeriodNote(store, "day", last);
    const readable = !lastNote || (lastNote.type === "text" && !lastNote.isProtected);
    const tasks = skipped || !readable ? [] : mainTasks(await readPlan(store, "day", last, now))
        .map(({ noteId, listItemId, text, section, critical }) => ({ noteId, listItemId, text, section, critical }));
    return { lastWorkday: last, note, skipped, tasks };
}

/**
 * The lines in force on an earlier day (`inForce`) that `day` won't read, to offer to carry into
 * `day`'s week note: from a note `contextNotes(day)` leaves out, with no `until` or one not before
 * `day`, and not already read on `day` from a note it reads (`dayContext`, its Context in force).
 * Last week's note counts as unread: on a Monday it is read for that day only.
 */
function carryLines(inForce: ContextEntry[], day: string, dayContext: ContextEntry[]) {
    const reads = new Set(contextNotes(day).filter((n) => !n.oneDay).map((n) => `${n.period}:${n.key}`));
    const readThen = new Set(dayContext.filter((line) => reads.has(`${line.period}:${line.key}`)).map((line) => sameText(line.text)));
    return inForce
        .filter((line) => !reads.has(`${line.period}:${line.key}`) && (line.until === undefined || line.until >= day) && !readThen.has(sameText(line.text)))
        .map((line) => ({ kind: "carry" as const, line: line.text, ...(line.until ? { until: line.until } : {}) }));
}

/** Lines named in the carry question before the rest are counted; the step's data lists them all. */
const CARRY_NAMED = 4;

/**
 * The one carry question, naming the lines: "Carry 'A' and 'B' into next week?", or, when the next
 * workday is in the same week, "Keep 'A' going?".
 */
export function carryQuestion(lines: string[], sameWeek: boolean): string {
    const quoted = lines.map((line) => `'${line}'`);
    const named = quoted.slice(0, CARRY_NAMED);
    const list = quoted.length > CARRY_NAMED
        ? t("caius.daily.list_more", { head: named.join(", "), count: quoted.length - CARRY_NAMED })
        : named.length > 1
            ? t("caius.daily.list_and", { head: named.slice(0, -1).join(", "), last: named.at(-1) })
            : named[0] ?? "";
    return sameWeek ? t("caius.daily.carry_day", { lines: list }) : t("caius.daily.carry_week", { lines: list });
}

/** A work bar's label: the task's first Jira key, else its text cut to `LABEL_LENGTH`. */
function workLabel(text: string): string {
    const key = keysOf(text).find((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k));
    const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
    return key ?? (plain.length > LABEL_LENGTH ? `${plain.slice(0, LABEL_LENGTH - 1).trimEnd()}…` : plain);
}

/** `YYYY-MM-DDTHH:mm:ss` as local time. */
function localMoment(stamp: string): Date | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(stamp);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) : undefined;
}

/**
 * The live tasks the wind-down of `date` closes: those in its day note, the overdue ones and those
 * in its ISO week note, each with its proposed fate: the target day for the first two, and for a
 * week task its week, or the target day's week when the week ends first. A sub-item goes with its
 * listed parent.
 */
async function stillOpen(store: NoteStore, date: string, targetDay: string) {
    const docs = (await loadJournal(store)).docs;
    const week = isoWeekKey(utcDay(date));
    const targetWeek = isoWeekKey(utcDay(targetDay));
    const tasks = openTasks(docs, scanDocs(docs, TRILIUM_CONFIG, noon(date)));
    const group = (task: (typeof tasks)[number]) => task.period === date ? "today" : task.horizon === "overdue" ? "overdue" : task.period === week ? "week" : null;
    const listed = tasks.filter((task) => group(task) !== null);
    const ids = new Set(listed.map((task) => `${task.noteId}/${task.listItemId}`));
    return listed
        .filter((task) => !task.parentListItemId || !ids.has(`${task.noteId}/${task.parentListItemId}`))
        .map((task) => ({
            group: group(task), noteId: task.noteId, listItemId: task.listItemId, text: task.text, period: task.period,
            section: task.section, critical: task.critical,
            fate: group(task) !== "week" ? { forward: targetDay } : week === targetWeek ? { stay: week } : { forward: targetWeek }
        }));
}

/**
 * What a day's candidates are checked against: its plan, the week's items, the live keys and what
 * is already suggested or dismissed there, plus whether the evening (Evening or Recharge) has a task
 * and how many minutes it holds, which are not work.
 */
async function dayFacts(store: NoteStore, date: string, now: Date) {
    const plan = await readPlan(store, "day", date, now);
    const weekKey = isoWeekKey(utcDay(date));
    const weekPlan = await readPlan(store, "week", weekKey, now);
    const live = liveKeys((await loadJournal(store)).docs, now);
    const exclude = [ ...plan.dismissed, ...plan.suggested.flatMap((task) => keysOf(task.text)) ];
    const eveningTasks = plan.sections.filter((section) => EVENING_SECTIONS.has(normName(section.name ?? ""))).flatMap((section) => section.tasks)
        .filter((task) => isLive(task) && task.text.trim() !== "");
    // As the plan's capacity counts them: a task with live sub-items counts through them, and an
    // empty to-do is not a task.
    const parents = new Set(eveningTasks.filter((task) => task.parent !== null).map((task) => task.parent));
    const eveningMinutes = eveningTasks.filter((task) => !parents.has(task.text)).reduce((sum, task) => sum + (task.estMinutes ?? DEFAULT_ESTIMATE), 0);
    return { plan, week: { key: weekKey, tasks: mainTasks(weekPlan) }, live, exclude, evening: eveningTasks.length > 0, eveningMinutes };
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

const sameText = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

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
