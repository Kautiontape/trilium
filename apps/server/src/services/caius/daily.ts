/**
 * The steps of the two planning conversations, `caius_winddown` and `caius_planday`. Each step
 * reads the notes again and answers `{ step, data, question, next }`: the facts, the exact question
 * for the agent to ask (null when there is nothing to ask) and the step after it. No state is kept
 * outside the notes, apart from the inputs cache the service holds.
 */

import {
    type Candidate,
    closedKeys,
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
    PERIODS,
    periodSpan,
    type PlanTask,
    type PlanView,
    readPlan,
    type Rhythm,
    sameContext,
    scanDocs,
    sectionOf,
    TRILIUM_CONFIG
} from "@triliumnext/caius";
import { t } from "i18next";

import { BRIEF_LABEL, PLANNED_AT_LABEL, RAISED_LABEL, SKIP_CATCHUP_LABEL, findBrief } from "./brief.js";
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
    dayRead: (date: string, refresh?: boolean, extraKeys?: string[]) => Promise<DayRead>;
    /** The standing note, read under the lock. */
    standing: () => Promise<Standing>;
}

export type WindDownStep = "open" | "next" | "context";

const EVENING_SECTIONS = new Set([ "evening", "recharge" ]);
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export async function windDown(deps: StepDeps, { date, step, refresh }: { date: string; step: WindDownStep; refresh?: boolean }) {
    const targetDay = dayKey(nextWorkday(localDay(date)));
    const reply = (standing: Standing, data: Record<string, unknown>, question: string | null, next: WindDownStep | null) => fitted({
        step, date, targetDay, targetDayName: weekdayName(targetDay), data, question, next,
        standing: standing.markdown, ...(standing.missing ? { standingMissing: standing.missing } : {})
    });

    if (step === "open") {
        const { standing, open } = await deps.locked("caius_winddown", async () => ({
            standing: await deps.standing(),
            open: await stillOpen(deps.store, date, targetDay)
        }));
        // Jira is asked about the items' own tickets, so an item it calls done can be named as such.
        const keys = open.items.map((item) => keysOf(item.text)[0]).filter((key): key is string => !!key && JIRA_KEY.test(key));
        const done = keys.length ? new Set((await deps.dayRead(targetDay, refresh, keys)).inputs.jira.done) : new Set<string>();
        const items = open.items.map((item) => done.has(keysOf(item.text)[0] ?? "") ? { ...item, jiraDone: true } : item);
        const question = items.length ? t("caius.daily.open", { day: weekdayName(targetDay) }) : null;
        return reply(standing, { ...open, items, ...(items.length ? {} : { summary: t("caius.daily.nothing_open") }) }, question, "next");
    }

    const read = await deps.dayRead(targetDay, refresh);
    if (step === "next") {
        const facts = await deps.locked("caius_winddown", () => dayFacts(deps.store, targetDay, deps.now));
        const jira = unraised(read.inputs.jira, facts.raised);
        const candidates = dayCandidates({ jira, week: facts.week, live: facts.live, exclude: facts.exclude }).map(present);
        const { eveningMinutes } = facts;
        const plannedMinutes = facts.plan.capacity.totalMinutes - eveningMinutes;
        const candidateMinutes = candidates.reduce((sum, c) => sum + c.minutes, 0);
        const targetMinutes = read.inputs.capacity.targetMinutes;
        const overlaps = overlapPairs(read.inputs.calendar);
        const evening = { hasTask: facts.evening };
        // Without the calendar, the target is that of a day with no meetings, so the day is not weighed.
        const calendarFailed = failedCalendar(read);
        const over = calendarFailed ? 0 : plannedMinutes + candidateMinutes - targetMinutes;
        const questions = [
            ...(over > 0 ? [ t("caius.daily.over", { day: weekdayName(targetDay), hours: Math.max(0.5, Math.round(over / 30) / 2) }) ] : []),
            ...overlaps.map((pair) => t("caius.daily.overlap", { first: pair.first, second: pair.second, time: pair.at })),
            ...(evening.hasTask ? [] : [ t("caius.daily.evening") ])
        ];
        const summary = calendarFailed
            ? { summary: t("caius.daily.capacity_unknown", { day: weekdayName(targetDay) }) }
            : questions.length ? {} : {
                summary: t("caius.daily.fits", { day: weekdayName(targetDay), planned: formatHours(plannedMinutes + candidateMinutes), focus: formatHours(targetMinutes) })
            };
        return reply(read.standing, {
            candidates,
            capacity: { plannedMinutes, eveningMinutes, candidateMinutes, targetMinutes, bookedRatio: read.inputs.capacity.bookedRatio },
            overlaps, evening, followUps: followUpsOf(jira), errors: read.inputs.errors, ...summary
        }, questions.length ? questions.join(" ") : null, "context");
    }

    // A line in force today that lapses before the target day and keeps a ticket open: Jira's own
    // answer is not consulted, since `done` leaves out every key a Context line calls open.
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
    return reply(read.standing, { context: read.context, targetWeek, keepDate: targetDay, noticed }, question, null);
}

export type PlanDayStep = "catchup" | "inputs" | "brief";

/** Share of the work window booked by meetings above which Plan my day offers to move a task. */
const HEAVY_RATIO = 0.6;
/** Longest work-bar label before it is cut. */
const LABEL_LENGTH = 24;

export async function planDay(deps: StepDeps, { date, step, refresh }: { date: string; step: PlanDayStep; refresh?: boolean }) {
    const reply = (standing: Standing, data: Record<string, unknown>, question: string | null, next: PlanDayStep | null) => fitted({
        step, date, data, question, next,
        standing: standing.markdown, ...(standing.missing ? { standingMissing: standing.missing } : {})
    });
    // A later day is planned on its own morning; a missed earlier one can still be planned.
    const today = dayKey(deps.now);
    if (date > today) {
        return { step, date, error: "not_today", detail: t("caius.daily.not_today", { day: weekdayName(date), today }) };
    }

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
    const calendarFailed = failedCalendar(read);

    if (step === "inputs") {
        const facts = await deps.locked("caius_planday", async () => {
            const day = await dayFacts(deps.store, date, deps.now);
            const brief = day.plan.noteId ? await findBrief(deps.store, day.plan.noteId, date) : null;
            const lastContext = await gatherContext(deps.store, dayKey(lastWorkday(localDay(date))));
            return { ...day, plannedAt: brief ? label(brief, PLANNED_AT_LABEL) ?? null : null, lastContext: lastContext.context };
        });
        const since = facts.plannedAt ? localMoment(facts.plannedAt) : undefined;
        const jira = unraised(read.inputs.jira, facts.raised);
        const candidates = dayCandidates({ jira, week: facts.week, live: facts.live, exclude: facts.exclude, since }).map(present);
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
            targetWeek: isoWeekKey(utcDay(date)), keepDate: date, carry,
            context: read.context, forwardSuggestion, followUps: followUpsOf(jira), errors: read.inputs.errors
        }, questions.length ? questions.join(" ") : null, "brief");
    }

    const { plan, raised } = await deps.locked("caius_planday", async () => ({
        plan: await readPlan(deps.store, "day", date, deps.now),
        raised: await raisedAsks(deps.store, deps.now, date)
    }));
    const followUps = followUpsOf(unraised(read.inputs.jira, raised));
    const { start, end, workEnd, from } = read.rhythm;
    // The drawing takes whatever the feeds returned; only the Meetings block refuses a partial calendar.
    const events = read.inputs.calendar
        .filter((e) => !e.allDay && !e.declined && e.end > start && e.start < end)
        .map((e) => ({ start: e.start < start ? start : e.start, end: e.end > end ? end : e.end, title: e.title, ...(e.overlap ? { overlap: true } : {}) }));
    const { work, unplaced } = workBlocks(plan, { start, end, workEnd }, events, date, deps.now);
    const header = { start, end, workEnd, events, work };
    const coordinates = read.rhythm.latitude === undefined ? {} : { latitude: read.rhythm.latitude, longitude: read.rhythm.longitude };
    return reply(read.standing, {
        day: { start, end, workEnd, from },
        list: listOf(plan).map(({ keys: _keys, ...task }) => task),
        header,
        unplaced,
        briefRules: sectionOf(read.standing.markdown, "Brief rules"),
        followUps,
        shape: {
            date, headline: "",
            acts: [ { range: "", text: "" }, { range: "", text: "" }, { range: "", text: "" } ],
            picks: [],
            sections: [ { title: t("caius.daily.follow_up"), markdown: "" }, { title: t("caius.daily.heads_up"), markdown: "" } ],
            header,
            followUps: followUps.map(({ key, commentId }) => ({ key, commentId })),
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
 * Last week's note counts as unread: on a Monday it is read for that day only. A day note's line
 * without an `until` holds on its own day only, so it is never carried.
 */
function carryLines(inForce: ContextEntry[], day: string, dayContext: ContextEntry[]) {
    const reads = new Set(contextNotes(day).filter((n) => !n.oneDay).map((n) => `${n.period}:${n.key}`));
    const readThen = new Set(dayContext.filter((line) => reads.has(`${line.period}:${line.key}`)).map((line) => sameContext(line.text)));
    return inForce
        .filter((line) => !(line.period === "day" && line.until === undefined))
        .filter((line) => !reads.has(`${line.period}:${line.key}`) && (line.until === undefined || line.until >= day) && !readThen.has(sameContext(line.text)))
        .map((line) => ({ kind: "carry" as const, line: line.text, ...(line.until ? { until: line.until } : {}) }));
}

/**
 * The longest step reply, as JSON. The sidebar agent's CLI keeps a larger tool result in a file it
 * can't read back, which broke every wind-down in T13A.
 */
export const MAX_REPLY_CHARS = 20_000;

/**
 * `reply` with its longest `data` lists cut from the end until its JSON is at most
 * `MAX_REPLY_CHARS`, and `data.omitted` counting what each list lost.
 */
export function fitted<R extends { data: Record<string, unknown> }>(reply: R): R {
    let size = JSON.stringify(reply).length;
    if (size <= MAX_REPLY_CHARS) return reply;
    const data: Record<string, unknown> = { ...reply.data };
    const omitted: Record<string, number> = {};
    while (size > MAX_REPLY_CHARS) {
        const [ field, list ] = Object.entries(data)
            .filter((entry): entry is [ string, unknown[] ] => Array.isArray(entry[1]) && entry[1].length > 0)
            .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0] ?? [];
        if (!field || !list) break;
        const cut = Math.max(1, Math.ceil(list.length * (size - MAX_REPLY_CHARS + 100) / JSON.stringify(list).length));
        data[field] = list.slice(0, list.length - cut);
        omitted[field] = (omitted[field] ?? 0) + Math.min(cut, list.length);
        data.omitted = omitted;
        size = JSON.stringify({ ...reply, data }).length;
    }
    return { ...reply, data };
}

/** Days a raised ask stays out of the follow-ups and candidates, unless a newer comment comes. */
const RAISED_DAYS = 7;

/**
 * The asks raised by briefs dated in the last `RAISED_DAYS` days and before `day`, the day being
 * planned, as `KEY:commentId`: a refresh of that day's own brief raises them again. The caller holds
 * the lock.
 */
async function raisedAsks(store: NoteStore, now: Date, day: string): Promise<Set<string>> {
    const since = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - RAISED_DAYS));
    const raised = new Set<string>();
    for (const note of await store.search(`#${RAISED_LABEL}`)) {
        const date = label(note, BRIEF_LABEL);
        if (!date || date < since || date >= day) continue;
        for (const a of note.attributes) if (a.type === "label" && a.name === RAISED_LABEL) raised.add(a.value);
    }
    return raised;
}

/** `jira` without the asks of a ticket whose latest ask is in `raised`: one with a newer comment stays. */
function unraised(jira: CaiusInputs["jira"], raised: Set<string>): CaiusInputs["jira"] {
    const quiet = new Set(latestAsks(jira.asks).filter((ask) => raised.has(`${ask.ticket.key}:${ask.commentId}`)).map((ask) => ask.ticket.key));
    return { ...jira, asks: jira.asks.filter((ask) => !quiet.has(ask.ticket.key)) };
}

/** What Follow up may raise: the latest ask per ticket, a done ticket's too, oldest first. */
function followUpsOf(jira: CaiusInputs["jira"]) {
    return latestAsks(jira.asks).map((ask) => ({
        key: ask.ticket.key, commentId: ask.commentId, author: ask.author, created: ask.created, excerpt: ask.excerpt,
        url: ask.ticket.url, ...(jira.done.includes(ask.ticket.key) ? { done: true } : {})
    }));
}

function latestAsks(asks: CaiusInputs["jira"]["asks"]) {
    const latest = new Map<string, CaiusInputs["jira"]["asks"][number]>();
    for (const ask of asks) {
        const seen = latest.get(ask.ticket.key);
        if (!seen || Date.parse(ask.created) > Date.parse(seen.created)) latest.set(ask.ticket.key, ask);
    }
    return [ ...latest.values() ].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

/** Whether the day's calendar could not be read: an error that is not a warning. */
function failedCalendar(read: DayRead): boolean {
    return read.inputs.errors.some((e) => e.source === "calendar" && !isInputWarning(e.error));
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

/**
 * The day's work bars: the main list in his order, laid out between `events` from standup, or from
 * the time now when `date` is today.
 */
export function workBlocks(plan: PlanView, day: { start: string; end: string; workEnd: string }, events: { start: string; end: string }[], date: string, now: Date) {
    const notBefore = date === dayKey(now) ? quarterAfter(now) : undefined;
    return layoutWork({ ...day, notBefore }, events, listOf(plan).map(({ label: bar, minutes, evening }) => ({ label: bar, minutes, evening })));
}

/** The main list as the drawing and the picks read it: each live task's bar label, text, minutes, keys and whether it is an evening task. */
function listOf(plan: PlanView) {
    const eveningSections = new Set(plan.sections.filter((section) => EVENING_SECTIONS.has(normName(section.name ?? ""))).map((section) => section.name));
    return mainTasks(plan).map((task) => ({
        label: workLabel(task.text), text: plainText(task.text), minutes: task.estMinutes ?? DEFAULT_ESTIMATE,
        evening: eveningSections.has(task.section), keys: keysOf(task.text)
    }));
}

/**
 * The picks that name a live task of the main list, in the list's order, and those that don't. A
 * pick names a task by a Jira key they share, or by holding the task's text.
 */
export function listPicks<P extends { text: string }>(plan: PlanView, picks: P[]): { kept: P[]; dropped: P[] } {
    const list = listOf(plan);
    const jira = (keys: string[]) => keys.filter((key) => /^[A-Z][A-Z0-9]+-\d+$/.test(key));
    const placeOf = (pick: P) => list.findIndex((task) => jira(keysOf(pick.text)).some((key) => task.keys.includes(key))
        || (task.text !== "" && sameText(pick.text).includes(sameText(task.text))));
    const placed = picks.map((pick) => ({ pick, at: placeOf(pick) }));
    return {
        kept: placed.filter(({ at }) => at >= 0).sort((a, b) => a.at - b.at).map(({ pick }) => pick),
        dropped: placed.filter(({ at }) => at < 0).map(({ pick }) => pick)
    };
}

/** A task's text without its links' markup. */
function plainText(text: string): string {
    return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
}

/** A work bar's label: the task's first Jira key, else its text cut to `LABEL_LENGTH`. */
function workLabel(text: string): string {
    const key = keysOf(text).find((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k));
    const plain = plainText(text);
    return key ?? (plain.length > LABEL_LENGTH ? `${plain.slice(0, LABEL_LENGTH - 1).trimEnd()}…` : plain);
}

/** The local time of `at` rounded up to the quarter hour, `HH:MM`; at most `23:59`. */
function quarterAfter(at: Date): string {
    const minutes = Math.min(23 * 60 + 59, Math.ceil((at.getHours() * 60 + at.getMinutes()) / 15) * 15);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `YYYY-MM-DDTHH:mm:ss` as local time. */
function localMoment(stamp: string): Date | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(stamp);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) : undefined;
}

/** Workdays before the closed day whose leftovers the wind-down lists one by one. */
const RECENT_WORKDAYS = 3;

/**
 * The live tasks the wind-down of `date` closes, each with its proposed fate: those in its day note
 * (`today`), in the notes of the last `RECENT_WORKDAYS` workdays (`recent`) and in its ISO week
 * note (`week`), in that order. The target day is the fate of the first two; a week task's is its
 * week, or the target day's week when the week ends first. A sub-item goes with its listed parent.
 * Older overdue tasks are only counted, with the start of the oldest one's period.
 */
async function stillOpen(store: NoteStore, date: string, targetDay: string) {
    const docs = (await loadJournal(store)).docs;
    const week = isoWeekKey(utcDay(date));
    const targetWeek = isoWeekKey(utcDay(targetDay));
    const recent = new Set<string>();
    for (let at = localDay(date), i = 0; i < RECENT_WORKDAYS; i++) {
        at = lastWorkday(at);
        recent.add(dayKey(at));
    }
    const tasks = openTasks(docs, scanDocs(docs, TRILIUM_CONFIG, noon(date)));
    const group = (task: (typeof tasks)[number]) => task.period === date ? "today"
        : recent.has(task.period) ? "recent"
            : task.period === week ? "week"
                : task.horizon === "overdue" ? "older" : null;
    const grouped = tasks.filter((task) => group(task) !== null);
    const ids = new Set(grouped.map((task) => `${task.noteId}/${task.listItemId}`));
    const top = grouped.filter((task) => !task.parentListItemId || !ids.has(`${task.noteId}/${task.parentListItemId}`));
    const older = top.filter((task) => group(task) === "older");
    const items = top
        .filter((task) => group(task) !== "older")
        .sort((a, b) => GROUPS.indexOf(group(a) ?? "") - GROUPS.indexOf(group(b) ?? ""))
        .map((task) => ({
            group: group(task), noteId: task.noteId, listItemId: task.listItemId, text: task.text, period: task.period,
            section: task.section, critical: task.critical,
            fate: group(task) !== "week" ? { forward: targetDay } : week === targetWeek ? { stay: week } : { forward: targetWeek }
        }));
    const oldestDate = older.map((task) => periodStart(task.period)).sort()[0] ?? null;
    return { items, olderCount: older.length, oldestDate };
}

const GROUPS = [ "today", "recent", "week" ];

/** The first day of a day, ISO week or month key. */
function periodStart(key: string): string {
    const kind = PERIODS.day.pattern.test(key) ? "day" : PERIODS.week.pattern.test(key) ? "week" : "month";
    return periodSpan(kind, key).start;
}

/**
 * What a day's candidates are checked against: its plan, the week's items, the live keys, what is
 * already suggested or dismissed there and what Shawn closed lately (`closedKeys`), plus whether
 * the evening (Evening or Recharge) has a task and how many minutes it holds, which are not work.
 */
async function dayFacts(store: NoteStore, date: string, now: Date) {
    const plan = await readPlan(store, "day", date, now);
    const weekKey = isoWeekKey(utcDay(date));
    const weekPlan = await readPlan(store, "week", weekKey, now);
    const { docs } = await loadJournal(store);
    const live = liveKeys(docs, now);
    const exclude = [ ...plan.dismissed, ...plan.suggested.flatMap((task) => keysOf(task.text)), ...await closedKeys(store, docs, now) ];
    const eveningTasks = plan.sections.filter((section) => EVENING_SECTIONS.has(normName(section.name ?? ""))).flatMap((section) => section.tasks)
        .filter((task) => isLive(task) && task.text.trim() !== "");
    // As the plan's capacity counts them: a task with live sub-items counts through them, and an
    // empty to-do is not a task.
    const parents = new Set(eveningTasks.filter((task) => task.parent !== null).map((task) => task.parent));
    const eveningMinutes = eveningTasks.filter((task) => !parents.has(task.text)).reduce((sum, task) => sum + (task.estMinutes ?? DEFAULT_ESTIMATE), 0);
    return {
        plan, week: { key: weekKey, tasks: mainTasks(weekPlan) }, live, exclude, raised: await raisedAsks(store, now, date),
        evening: eveningTasks.length > 0, eveningMinutes
    };
}

/** The live top-level tasks of a plan, the Important block first, then in his order. */
export function mainTasks(plan: PlanView): PlanTask[] {
    return [ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ].filter((task) => isLive(task) && task.parent === null);
}

const isLive = (task: PlanTask) => task.state === "open" || task.state === "in_progress";

/**
 * A candidate as the step reports it: its `kind` (`handoff`, `ask` or `week`), `Get X done` (a week
 * item keeps its own text) with its reason in words, and for a ticket the `key` and `title` that
 * `caius_add` takes with `because` and `minutes`. A week item carries the `noteId` and `listItemId`
 * to forward instead.
 */
export function present(candidate: Candidate) {
    const { subject, reason, keys: _keys, ...rest } = candidate;
    const ticket = reason.kind === "week" ? {} : { key: candidate.source, title: subject.slice(candidate.source.length).trim() || subject };
    const because = reason.kind === "handoff"
        ? reason.days === null
            ? t("caius.daily.because_handoff_unknown", { status: reason.status })
            : t("caius.daily.because_handoff", { status: reason.status, count: reason.days })
        : reason.kind === "ask"
            ? t("caius.daily.because_ask", { author: reason.author, weekday: weekdayName(dayKey(new Date(reason.created))) })
            : t("caius.daily.because_week");
    return { kind: reason.kind, text: reason.kind === "week" ? subject : t("caius.daily.get_done", { subject }), ...ticket, because, ...rest };
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
