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
    dayCapacity,
    DEFAULT_ESTIMATE,
    EVENING_REASON,
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
import { createHash } from "crypto";
import { t } from "i18next";

import { ANSWERED_LABEL, ASK_SEEN_LABEL, ASKED_LABEL, BRIEF_LABEL, DECLINED_LABEL, findBrief, HELD_GROUP_LABEL, HELD_LABEL, NOT_TODAY_LABEL, PLANNED_AT_LABEL, RAISED_LABEL, SKIP_CATCHUP_LABEL, WOUND_DOWN_LABEL } from "./brief.js";
import { flagOverlaps } from "./inputs/calendar.js";
import { isInputWarning } from "./inputs/index.js";
import { overriddenKeys } from "./inputs/jira.js";
import type { CaiusInputs } from "./inputs/types.js";
import { numbered, refOf, withRefs } from "./refs.js";
import { heldQuestion } from "./say.js";

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
const FRIDAY = 5;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export async function windDown(deps: StepDeps, { date, step, refresh, older }: { date: string; step: WindDownStep; refresh?: boolean; older?: boolean }) {
    const targetDay = windDownTarget(date, deps.now);
    const reply = (standing: Standing, data: Record<string, unknown>, question: string | null, next: WindDownStep | null) => fitted({
        ...withDateLabels({ step, date, targetDay, targetDayName: weekdayName(targetDay), data, question, next }),
        standing: standing.markdown, ...(standing.missing ? { standingMissing: standing.missing } : {})
    });

    if (step === "open") {
        const { standing, open, held } = await deps.locked("caius_winddown", async () => {
            const items = await stillOpen(deps.store, date, targetDay);
            return { standing: await deps.standing(), open: items, held: await allHeld(deps.store) };
        });
        // Jira is asked about the items' own tickets, so an item it calls done can be named as such.
        const keys = open.items.map((item) => keysOf(item.text)[0]).filter((key): key is string => !!key && JIRA_KEY.test(key));
        const done = keys.length ? new Set((await deps.dayRead(targetDay, refresh, keys)).inputs.jira.done) : new Set<string>();
        // A held item gets no fate until he says which, so it is asked about instead of sent on.
        const items = open.items.map((item) => ({
            ...item, ...(done.has(keysOf(item.text)[0] ?? "") ? { jiraDone: true } : {}), ...(item.listItemId && held.has(item.listItemId) ? { fate: { held: true } } : {})
        }));
        const which = heldQuestion(items.filter((item) => item.listItemId && held.has(item.listItemId)).map(({ text, period }) => ({ text, period })));
        const question = items.length ? [ t("caius.daily.open", { day: weekdayName(targetDay) }), ...(which ? [ which ] : []) ].join(" ") : null;
        // The older backlog is a Friday matter, or one he asks about; on other nights it isn't mentioned.
        const { olderCount, oldestDate, ...rest } = open;
        const backlog = older || utcDay(date).getUTCDay() === FRIDAY ? { olderCount, oldestDate } : {};
        return reply(standing, { ...rest, ...backlog, ...namedDays(date, targetDay), items: withRefs(items, "o", (item) => item.listItemId), ...(items.length ? {} : { summary: t("caius.daily.nothing_open") }) }, question, "next");
    }

    const read = await deps.dayRead(targetDay, refresh);
    if (step === "next") {
        const { facts, candidates, jira, asks } = await deps.locked("caius_winddown", () => nextOffer(deps.store, targetDay, deps.now, read));
        const { plannedMinutes, candidateMinutes, over, overlaps, askEvening } = asks;
        const targetMinutes = read.inputs.capacity.targetMinutes;
        const evening = { hasTask: facts.evening };
        const calendarFailed = failedCalendar(read);
        const questions = [
            ...(over > 0 ? [ t("caius.daily.over", { day: weekdayName(targetDay), hours: Math.max(0.5, Math.round(over / 30) / 2) }) ] : []),
            ...overlaps.map((pair) => t("caius.daily.overlap", { first: pair.first, second: pair.second, time: pair.at })),
            ...(askEvening ? [ t("caius.daily.evening") ] : [])
        ];
        const summary = calendarFailed
            ? { summary: t("caius.daily.capacity_unknown", { day: weekdayName(targetDay) }) }
            : questions.length ? {} : {
                summary: t("caius.daily.fits", { day: weekdayName(targetDay), planned: formatHours(plannedMinutes + candidateMinutes), focus: focusText(focusOf(read.inputs.capacity)) })
            };
        return reply(read.standing, {
            list: withRefs(listItems(facts.plan), "l", (item) => item.listItemId),
            candidates: withRefs(candidates, "c", (candidate) => candidate.candidateId),
            capacity: capacityOf(read, plannedMinutes),
            overlaps, evening, followUps: followUpsOf(jira), errors: read.inputs.errors, ...summary
        }, questions.length ? questions.join(" ") : null, "context");
    }

    const { keep, carry } = await deps.locked("caius_winddown", () => closingLines(deps.store, date, targetDay, read));
    const targetWeek = isoWeekKey(utcDay(targetDay));
    const noticed = withRefs([ ...keep, ...carry ], "x", (line) => line.lineId);
    const sameWeek = isoWeekKey(utcDay(date)) === targetWeek;
    const questions = [ ...keep.map((n) => n.question), ...(carry.length ? [ carryQuestion(carry.map((c) => c.line), sameWeek) ] : []) ];
    // The question set always ends with the one line that lets him add something.
    const question = [ ...questions, t("caius.daily.context", { day: weekdayName(targetDay) }) ].join(" ");
    return reply(read.standing, { context: read.context, targetWeek, keepDate: targetDay, noticed }, question, null);
}

/**
 * What the wind-down's `next` step offers for `targetDay`, which `caius_winddown_apply` reads again:
 * the day's facts, the candidates, the Jira answer its follow-ups come from and what it asks
 * (`asks`). A raised ask stays on offer; only the Follow up leaves it out (`unraised`). The caller
 * holds the lock.
 */
export async function nextOffer(store: NoteStore, targetDay: string, now: Date, read: DayRead) {
    const facts = await dayFacts(store, targetDay, now);
    const { fresh, followed } = splitAsks(read.inputs.jira, await seenAsks(store, targetDay), facts.live);
    const candidates = onOffer(dayCandidates({ jira: fresh, week: facts.week, live: facts.live, exclude: facts.exclude }).map(present), facts);
    const asked = new Set(await dayLabels(store, targetDay, ASKED_LABEL));
    return {
        facts, candidates, jira: unraised(followed, facts.raised), asks: nextAsks(read, facts, candidates, asked), offeredAsks: offeredAsks(fresh, candidates)
    };
}

/**
 * The questions the wind-down asks about `targetDay`, each only while `asked` (its `#caiusAsked`
 * values) doesn't hold it: how far the day is over the focus target (as `heavy`), its overlaps and,
 * when its evening has no task, the evening.
 */
function nextAsks(read: DayRead, facts: { plan: PlanView; evening: boolean }, candidates: { minutes: number }[], asked: Set<string>) {
    const plannedMinutes = workMinutes(facts);
    const candidateMinutes = candidates.reduce((sum, c) => sum + c.minutes, 0);
    // Without the calendar, the target is that of a day with no meetings, so the day is not weighed.
    const over = failedCalendar(read) || asked.has(HEAVY_ID) ? 0 : plannedMinutes + candidateMinutes - read.inputs.capacity.targetMinutes;
    const overlaps = overlapPairs(read.inputs.calendar).map((pair) => ({ ...pair, overlapId: overlapIdOf(pair) })).filter((pair) => !asked.has(pair.overlapId));
    return { plannedMinutes, candidateMinutes, over, overlaps, askEvening: !facts.evening && !asked.has(EVENING_ID) };
}

/** The `#caiusAsked` values of what the wind-down's `next` step asks, answered once the apply runs. */
export function nextAsked(asks: ReturnType<typeof nextAsks>): string[] {
    // Recorded as `heavy` on purpose: the next morning doesn't ask about the day's load a second time.
    return [ ...asks.overlaps.map((pair) => pair.overlapId), ...(asks.over > 0 ? [ HEAVY_ID ] : []), ...(asks.askEvening ? [ EVENING_ID ] : []) ];
}

/**
 * The lines the wind-down of `date` asks about, neither asked that day nor on the last workday:
 * `keep`, a line in force today that lapses before `targetDay` and keeps a ticket open (Jira's own
 * answer is not consulted, since `done` leaves out every key a Context line calls open), and `carry`,
 * a line `targetDay` won't read. The caller holds the lock.
 */
export async function closingLines(store: NoteStore, date: string, targetDay: string, read: DayRead) {
    const today = await gatherContext(store, date);
    const asked = await askedAbout(store, date);
    const keep = today.context
        .filter((line) => line.until !== undefined && line.until < targetDay)
        .map((line) => ({ kind: "keep" as const, line: line.text, lineId: lineIdOf(line.text), until: line.until, keys: [ ...overriddenKeys([ line.text ]) ] }))
        .filter((line) => line.keys.length && !asked.has(line.lineId))
        .map((line) => ({ ...line, question: t("caius.daily.keep", { line: line.line }) }));
    return { keep, carry: carryLines(today.context, targetDay, read.context).filter((line) => !asked.has(line.lineId)) };
}

/**
 * The day a wind-down of `date` works against: the next workday after it, or today when that has
 * already passed (a catch-up's Review of an older day), the next workday when today is a weekend.
 */
export function windDownTarget(date: string, now: Date): string {
    const next = dayKey(nextWorkday(localDay(date)));
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    const today = weekend ? dayKey(nextWorkday(now)) : dayKey(now);
    return next < today ? today : next;
}

/**
 * The days, weeks and months he can name in an answer, so a day he says maps to a date without the
 * agent working one out: the workdays from `first` to the end of the week after `date`'s, those two
 * ISO weeks, and `date`'s month and the next two. Each day has a ref (`d1`), and `days` ends with the
 * two weeks as he names them, `w1` "later this week" and `w2` "next week". Each gets its display
 * string from `withDateLabels`.
 */
export function namedDays(date: string, first: string): { days: NamedDay[]; weeks: { week: string }[]; months: { month: string }[] } {
    const monday = utcDay(periodSpan("week", isoWeekKey(utcDay(date))).start);
    const end = dayKey(new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 11));
    const days: { date: string }[] = [];
    for (let at = localDay(first); dayKey(at) <= end; at = nextWorkday(at)) days.push({ date: dayKey(at) });
    const weeks = [ 0, 7 ].map((offset) => ({ week: isoWeekKey(new Date(monday.getTime() + offset * 86_400_000)) }));
    const months = [ 0, 1, 2 ].map((offset) => {
        const at = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + offset, 1));
        return { month: at.toISOString().slice(0, 7) };
    });
    const [ thisWeek, nextWeek ] = weeks;
    const inWords = [
        ...(thisWeek ? [ { ref: "w1", week: thisWeek.week, name: t("caius.daily.later_this_week") } ] : []),
        ...(nextWeek ? [ { ref: "w2", week: nextWeek.week, name: t("caius.daily.next_week") } ] : [])
    ];
    return { days: [ ...numbered(days, "d"), ...inWords ], weeks, months };
}

/** A day an answer can name by its ref (`d1`), or a week by its ref and his words (`w1`, "later this week"). */
export type NamedDay = { date: string; ref: string } | { week: string; ref: string; name: string };

export type PlanDayStep = "catchup" | "inputs" | "brief";

/** Share of the work window booked by meetings from which a day is heavy: Plan my day weighs its work against the focus target. */
const HEAVY_RATIO = 0.5;
/** Longest work-bar label before it is cut. */
const LABEL_LENGTH = 24;

export async function planDay(deps: StepDeps, { date, step, refresh, answered }: { date: string; step: PlanDayStep; refresh?: boolean; answered?: { evening?: string[]; keep?: string[] } }) {
    const reply = (standing: Standing, data: Record<string, unknown>, question: string | null, next: PlanDayStep | null) => fitted({
        ...withDateLabels({ step, date, data, question, next }),
        standing: standing.markdown, ...(standing.missing ? { standingMissing: standing.missing } : {})
    });
    // A later day is planned on its own morning; a missed earlier one can still be planned.
    const today = dayKey(deps.now);
    if (date > today) {
        return { step, date, error: "not_today", detail: t("caius.daily.not_today", { day: weekdayName(date), today }) };
    }

    if (step === "catchup") {
        const { standing, catchup: { lastWorkday: last, days, skipped, tasks, held } } = await deps.locked("caius_planday", async () => ({
            standing: await deps.standing(),
            catchup: await catchupOf(deps.store, date, deps.now)
        }));
        const names = days.filter((day) => tasks.some((task) => task.period === day)).map((day) => catchupDayName(day, date));
        const moving = !tasks.length ? null : names.length > 1
            ? t("caius.daily.catchup_days", { weekdays: t("caius.daily.list_and", { head: names.slice(0, -1).join(", "), last: names.at(-1) }), count: tasks.length })
            : t("caius.daily.catchup", { weekday: names[0] ?? catchupDayName(last, date), count: tasks.length });
        // A task an ambiguous answer held is asked about on its own, as `say` asks it; no catch-up moves it.
        const question = [ moving, heldQuestion(held.map(({ text, period }) => ({ text, period }))) ].filter((q) => q !== null).join(" ") || null;
        return reply(standing, {
            lastWorkday: last, days, oldestDay: days[0] ?? null, moveTo: date, skipped, tasks: withRefs(tasks, "o", (task) => task.listItemId),
            ...(held.length ? { held: withRefs(held, "o", (task) => task.listItemId) } : {})
        }, question, "inputs");
    }

    const read = await deps.dayRead(date, refresh);
    const calendarFailed = failedCalendar(read);

    if (step === "inputs") {
        const offer = await deps.locked("caius_planday", () => planOffer(deps.store, date, deps.now, read));
        const { day: facts, plannedAt, candidates, jira, headsUp, overlaps, forwardSuggestion, fits } = offer;
        // What he already answered in this conversation is not asked again.
        // A kept line can be given by its words, its lineId or its ref.
        const kept = new Set(answered?.keep ?? []);
        const carry = offer.carry.filter((line) => !kept.has(line.lineId) && !kept.has(refOf("x", line.lineId)) && ![ ...kept ].some((said) => lineIdOf(said) === line.lineId));
        const askEvening = offer.askEvening && answered?.evening === undefined;
        const lines = calendarFailed ? null : meetingLines(read.inputs.calendar);
        const meetings = lines
            ? { lines, current: facts.plan.meetings, changed: lines.join("\n") !== facts.plan.meetings.join("\n") }
            : { lines: null, current: facts.plan.meetings, changed: false };
        const nextDay = dayKey(nextWorkday(localDay(date)));
        // The day being planned is in the week its lines go to, so the question never says "next week".
        const questions = [
            ...overlaps.map((pair) => t("caius.daily.overlap", { first: pair.first, second: pair.second, time: pair.at })),
            ...(forwardSuggestion ? [ t("caius.daily.heavy", {
                percent: Math.round(read.inputs.capacity.bookedRatio * 100), task: forwardSuggestion.text, day: weekdayName(nextDay)
            }) ] : []),
            ...(carry.length ? [ carryQuestion(carry.map((c) => c.line), true) ] : []),
            ...(askEvening ? [ t("caius.daily.evening") ] : [])
        ];
        return reply(read.standing, {
            plannedAt, list: withRefs(listItems(facts.plan), "l", (item) => item.listItemId), candidates: withRefs(candidates, "c", (candidate) => candidate.candidateId), meetings, overlaps,
            capacity: capacityOf(read, workMinutes(facts)), ...namedDays(date, nextDay),
            targetWeek: isoWeekKey(utcDay(date)), keepDate: date, carry: withRefs(carry, "x", (line) => line.lineId),
            context: read.context, forwardSuggestion, followUps: followUpsOf(jira), headsUp, evening: offer.evening, errors: read.inputs.errors, ...(fits ? { summary: fits } : {}),
            ...planFromOf(date, deps.now, read.rhythm.start)
        }, questions.length ? questions.join(" ") : null, "brief");
    }

    const { plan, raised, seen, live } = await deps.locked("caius_planday", async () => ({
        plan: await readPlan(deps.store, "day", date, deps.now),
        raised: await raisedAsks(deps.store, deps.now, date),
        seen: await seenAsks(deps.store, date),
        live: liveKeys((await loadJournal(deps.store)).docs, deps.now)
    }));
    const followUps = followUpsOf(unraised(splitAsks(read.inputs.jira, seen, live).followed, raised));
    const { start, end, workEnd, from } = read.rhythm;
    const events = drawnEvents(read);
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
            sections: [
                { title: t("caius.daily.follow_up"), markdown: followUps.map((f) => `- ${f.sentence}`).join("\n") },
                { title: t("caius.daily.heads_up"), markdown: "" }
            ],
            header,
            followUps: followUps.map(({ key, commentId }) => ({ key, commentId })),
            ...coordinates
        },
        errors: read.inputs.errors
    }, null, null);
}

/** A catch-up day as the question names it: by weekday in the week of `date`, with its date in an earlier week ("Fri 30 Oct"). */
function catchupDayName(day: string, date: string): string {
    return isoWeekKey(utcDay(day)) < isoWeekKey(utcDay(date)) ? dateLabel(day) ?? day : weekdayName(day);
}

/**
 * What the `inputs` step offers for `date`, which `caius_plan_apply` reads again to resolve his
 * answers: the day's facts, when it was last planned, the candidates new since then and the lines
 * to carry, each line with its `lineId`. Runs every morning, whatever the catch-up answer was, so a
 * missed wind-down doesn't let a line lapse. The caller holds the lock.
 */
export async function planOffer(store: NoteStore, date: string, now: Date, read: DayRead) {
    const day = await dayFacts(store, date, now);
    const brief = day.plan.noteId ? await findBrief(store, day.plan.noteId, date) : null;
    const lastContext = (await gatherContext(store, dayKey(lastWorkday(localDay(date))))).context;
    const plannedAt = brief ? label(brief, PLANNED_AT_LABEL) ?? null : null;
    const since = plannedAt ? localMoment(plannedAt) : undefined;
    const { fresh, followed } = splitAsks(read.inputs.jira, await seenAsks(store, date), day.live);
    const jira = unraised(followed, day.raised);
    const candidates = onOffer(dayCandidates({ jira: fresh, week: day.week, live: day.live, exclude: day.exclude, since }).map(present), day);
    const asked = await askedAbout(store, date);
    // An overlap, the heavy day's move or the evening is asked once for its day: a refresh asks only what's new.
    const askedToday = new Set(await dayLabels(store, date, ASKED_LABEL));
    const overlaps = overlapPairs(read.inputs.calendar).map((pair) => ({ ...pair, overlapId: overlapIdOf(pair) })).filter((pair) => !askedToday.has(pair.overlapId));
    // On a heavy day the work is weighed against the focus target: over it, the last work task is
    // offered to move; within it, the day is said to fit. Neither asks for more work.
    const list = listOf(day.plan);
    const work = mainTasks(day.plan).filter((_task, i) => !list[i]?.evening);
    const last = work.filter((task) => !task.critical).at(-1);
    const heavy = read.inputs.capacity.bookedRatio >= HEAVY_RATIO;
    const over = workMinutes(day) > read.inputs.capacity.targetMinutes;
    const forwardSuggestion = heavy && over && last?.listItemId && !askedToday.has(HEAVY_ID)
        ? { noteId: last.noteId, listItemId: last.listItemId, text: last.text, to: dayKey(nextWorkday(localDay(date))) }
        : null;
    const labels = list.filter((task) => !task.evening).map((task) => task.label);
    const fits = heavy && !over && labels.length
        ? t("caius.daily.heavy_fits", { tasks: labels.length > 1 ? t("caius.daily.list_and", { head: labels.slice(0, -1).join(", "), last: labels.at(-1) }) : labels[0], count: labels.length })
        : null;
    // His answer to an overlap is news for the day it is about, as a line whose range starts that day is.
    const declined = (await dayLabels(store, date, DECLINED_LABEL)).flatMap((value) => value.split("|").slice(2).join("|") || []);
    const headsUp = [
        ...headsUpOf(day.plan.meetings, failedCalendar(read) ? null : meetingLines(read.inputs.calendar)),
        ...read.context.filter((line) => line.from === date || (line.period === "day" && line.key === date && declined.some((title) => line.text.includes(title))))
            .map((line) => line.text)
    ];
    return {
        day, plannedAt, candidates, carry: carryLines(lastContext, date, read.context).filter((line) => !asked.has(line.lineId)), jira, headsUp,
        overlaps, forwardSuggestion, fits, askEvening: !askedToday.has(EVENING_ID), offeredAsks: offeredAsks(fresh, candidates),
        evening: eveningOf(day, read)
    };
}

/**
 * The day's evening as the steps show it: his evening tasks, the calendar's evening events and
 * `suggestion`, the Suggested line the plan's apply writes while the evening has neither. The line
 * is his standing note's evening rule ("something away from screens, a chore or a Recharge item"),
 * sized by its evening minutes; it is null without a rule, or once it is in the day's Suggested or
 * dismissed there.
 */
function eveningOf(day: Awaited<ReturnType<typeof dayFacts>>, read: DayRead) {
    const tasks = listOf(day.plan).filter((task) => task.evening).map((task) => task.text);
    const events = eveningEventTitles(read);
    const rule = eveningRule(read.standing.markdown);
    const line = rule ? `${rule.text}: because ${EVENING_REASON} (~${rule.minutes}m)` : null;
    const taken = new Set([ ...day.plan.dismissed, ...day.plan.suggested.flatMap((task) => keysOf(task.text)) ]);
    const suggestion = line && !tasks.length && !events.length && !keysOf(line).some((key) => taken.has(key)) ? line : null;
    return { tasks, events, suggestion };
}

/** The titles of the day's timed calendar events that start at or after the end of work. */
export function eveningEventTitles(read: DayRead): string[] {
    return read.inputs.calendar.filter((e) => !e.allDay && !e.declined && e.start >= read.rhythm.workEnd).map((e) => e.title);
}

/**
 * The standing note's evening rule, from the Rhythm line "Evening: something away from screens, a
 * chore or a Recharge item.", with its first letter capitalized, and the evening's minutes from
 * "45–60 minutes in the evening" (the lower figure), else the default estimate. Null without the rule.
 */
export function eveningRule(markdown: string | null): { text: string; minutes: number } | null {
    const rhythm = sectionOf(markdown, "Rhythm") ?? "";
    const rule = /\bEvening:\s*([^.\n]+)/i.exec(rhythm)?.[1]?.trim();
    if (!rule) return null;
    const minutes = /(\d+)\s*(?:[–-]\s*\d+\s*)?minutes in the evening/i.exec(rhythm)?.[1];
    return { text: `${rule.charAt(0).toUpperCase()}${rule.slice(1)}`, minutes: minutes ? Number(minutes) : DEFAULT_ESTIMATE };
}

/**
 * The day's one capacity block, which the steps show and their questions weigh: the work window,
 * what the meetings book of it and leave open, the focus target and the work planned, with `focus`,
 * the figure the Plan tab shows too, and `sentence`, the block in words for the chat.
 */
function capacityOf(read: DayRead, plannedMinutes: number) {
    const { windowMinutes, bookedMinutes, openMinutes, targetMinutes, bookedRatio } = read.inputs.capacity;
    const focus = focusOf(read.inputs.capacity);
    const words = { booked: formatHours(bookedMinutes), open: formatHours(openMinutes), planned: formatHours(plannedMinutes), focus: focusText(focus) };
    const sentence = t(plannedMinutes ? "caius.daily.capacity_line" : "caius.daily.capacity_line_empty", words);
    return { windowMinutes, bookedMinutes, openMinutes, targetMinutes, plannedMinutes, bookedRatio, focus, sentence };
}

/** The day's focus as the Plan tab's day target reads it: 3 to 4 hours, or less when the meetings leave less. */
const DAY_FOCUS = { min: 180, max: 240 };

/**
 * The focus figure of a day, which the chat and the Plan tab both show: the method's 3 to 4 hours,
 * or, when the meetings leave less, the day's target rounded to the quarter hour.
 */
export function focusOf(capacity: { targetMinutes: number }): { min: number; max: number } {
    if (capacity.targetMinutes >= DAY_FOCUS.min) return DAY_FOCUS;
    const minutes = Math.round(capacity.targetMinutes / 15) * 15;
    return { min: minutes, max: minutes };
}

/** A focus figure in words: "3–4 h" or "2 h". */
export function focusText(focus: { min: number; max: number }): string {
    return focus.min === focus.max ? formatHours(focus.min) : t("caius.daily.focus_range", { min: focus.min / 60, max: focus.max / 60 });
}

/** The minutes of work on a day's list: the plan's capacity total, which leaves the evening out. */
function workMinutes(facts: { plan: PlanView }): number {
    return facts.plan.capacity.totalMinutes;
}

/** The `#caiusAsked` value of the heavy day's question. */
export const HEAVY_ID = "heavy";
/** The `#caiusAsked` value of the evening question. */
export const EVENING_ID = "evening";

/** An overlap's id for `#caiusAsked`: a hash of its two meetings and its time. */
export function overlapIdOf(pair: { first: string; second: string; at: string }): string {
    return `o${createHash("sha1").update(`${pair.first}\n${pair.second}\n${pair.at}`).digest("hex").slice(0, 10)}`;
}

/**
 * The calendar's Heads-up lines: what changed since the day's Meetings block was written, a meeting
 * moved, added or gone. Nothing on the first plan of a day, when there is no block to compare.
 * `planOffer` adds the Context lines whose range starts that day.
 */
export function headsUpOf(current: string[], lines: string[] | null): string[] {
    if (!lines || !current.length) return [];
    const parse = (line: string) => {
        const m = /^(\d{2}:\d{2}) (.*)$/.exec(line);
        return m?.[1] && m[2] ? { at: m[1], title: m[2].replace(/(\s*\([^)]*\))+$/, ""), line } : null;
    };
    const was = current.map(parse).filter((m) => m !== null);
    const now = lines.map(parse).filter((m) => m !== null);
    const out: string[] = [];
    for (const meeting of now) {
        const before = was.find((m) => m.title === meeting.title);
        if (!before) out.push(t("caius.daily.heads_up_new", { line: meeting.line }));
        else if (before.at !== meeting.at && !was.some((m) => m.title === meeting.title && m.at === meeting.at)) {
            out.push(t("caius.daily.heads_up_moved", { title: meeting.title, time: meeting.at }));
        }
    }
    for (const meeting of was) {
        if (!now.some((m) => m.title === meeting.title)) out.push(t("caius.daily.heads_up_gone", { line: meeting.line }));
    }
    return out;
}

/**
 * The lineIds asked about on `date` or on the last workday before it (`#caiusAsked`), which are not
 * asked again: a line he let pass on Monday is not raised on Tuesday. The caller holds the lock.
 */
async function askedAbout(store: NoteStore, date: string): Promise<Set<string>> {
    return new Set([ ...await dayLabels(store, date, ASKED_LABEL), ...await dayLabels(store, dayKey(lastWorkday(localDay(date))), ASKED_LABEL) ]);
}

/** The values of the label `name` on the day note of `date`; none without the note. The caller holds the lock. */
export async function dayLabels(store: NoteStore, date: string, name: string): Promise<string[]> {
    const note = await findPeriodNote(store, "day", date);
    return note?.attributes.filter((a) => a.type === "label" && a.name === name).map((a) => a.value) ?? [];
}

/**
 * `inputs` with the meetings he isn't taking declined: each `#caiusDeclined` value on the day note,
 * `overlapId|start|title`, names one event by its start and title. The Meetings block, the drawing
 * and the overlaps leave them out, and the capacity is read again.
 */
export function withTaken(inputs: CaiusInputs, declined: string[], rhythm: { start: string; workEnd: string }): CaiusInputs {
    const out = declined.map(declinedEvent).filter((event) => event !== null);
    if (!out.length) return inputs;
    const calendar = flagOverlaps(inputs.calendar.map(({ overlap: _overlap, ...event }) =>
        out.some((each) => each.start === event.start && each.title === normName(event.title)) ? { ...event, declined: true } : event));
    return { ...inputs, calendar, capacity: dayCapacity(calendar, { workStart: rhythm.start, workEnd: rhythm.workEnd }) };
}

/** A `#caiusDeclined` value as the overlap it answered and the event it declines, by start and title; null for one of another shape. */
export function declinedEvent(value: string): { overlapId: string; start: string; title: string } | null {
    const [ overlapId, start, ...title ] = value.split("|");
    return overlapId && start && title.length ? { overlapId, start, title: normName(title.join("|")) } : null;
}

/**
 * The day's calendar as the drawing takes it: timed events he hasn't declined, clipped to the day's
 * span. It takes whatever the feeds returned; only the Meetings block refuses a partial calendar.
 */
export function drawnEvents(read: DayRead) {
    const { start, end } = read.rhythm;
    return read.inputs.calendar
        .filter((e) => !e.allDay && !e.declined && e.end > start && e.start < end)
        .map((e) => ({ start: e.start < start ? start : e.start, end: e.end > end ? end : e.end, title: e.title, ...(e.overlap ? { overlap: true } : {}) }));
}

/** Workdays the catch-up looks back at most. */
const CATCHUP_DAYS = 5;

/**
 * What Plan my day offers to move to `date`: the live top-level tasks of every workday since the
 * last closed one, oldest first, at most `CATCHUP_DAYS` back. The walk passes a day with no note or
 * no tasks at all (an untouched template), and stops at a closed day: one that had tasks and has
 * none live; one with nothing live that was wound down (`#caiusWoundDown`), recorded a skip
 * (`#caiusSkipCatchup`) or has a brief; one protected or not a text note, since Caius cannot read
 * it; or, after taking its tasks, one that recorded a skip, which covered the days before it. None once the day note carries
 * `#caiusSkipCatchup=<date>`. A task held on its day (`#caiusHeld`), any day before `date`, is in
 * `held`, not `tasks`, and its day in `days`: no catch-up moves it, and every morning asks about it. Answers the day note too, without creating it. The caller holds the lock.
 */
export async function catchupOf(store: NoteStore, date: string, now: Date) {
    const last = dayKey(lastWorkday(localDay(date)));
    const note = await findPeriodNote(store, "day", date);
    const skipped = !!note?.attributes.some((a) => a.type === "label" && a.name === SKIP_CATCHUP_LABEL && a.value === date);
    const days: string[] = [];
    type Task = { noteId: string; listItemId: string | null; text: string; section: string | null; critical: boolean; period: string };
    const tasks: Task[] = [];
    const held: Task[] = [];
    // A hold can name an item on another day than the one it was given on, so it is read Journal-wide.
    const holding = await allHeld(store);
    for (let at = localDay(date), i = 0; !skipped && i < CATCHUP_DAYS; i++) {
        at = lastWorkday(at);
        const key = dayKey(at);
        const dayNote = await findPeriodNote(store, "day", key);
        if (!dayNote) continue;
        if (dayNote.type !== "text" || dayNote.isProtected) break;
        const plan = await readPlan(store, "day", key, now);
        const live = mainTasks(plan).map(({ noteId, listItemId, text, section, critical }) => ({ noteId, listItemId, text, section, critical, period: key }));
        const woundDown = label(dayNote, WOUND_DOWN_LABEL) !== undefined;
        const skippedHere = dayNote.attributes.some((a) => a.type === "label" && a.name === SKIP_CATCHUP_LABEL);
        if (!live.length) {
            // A day he planned, skipped from or wound down was looked at, so the walk ends there.
            if (woundDown || skippedHere || topLevel(plan).length || await findBrief(store, dayNote.noteId, key)) break;
            continue;
        }
        days.unshift(key);
        // A task an ambiguous wind-down answer held stays on its day until he says which.
        tasks.unshift(...live.filter((task) => !task.listItemId || !holding.has(task.listItemId)));
        held.unshift(...live.filter((task) => task.listItemId && holding.has(task.listItemId)));
        if (skippedHere) break;
    }
    // A held task is asked about every morning until he names it, however long ago its day was closed;
    // a day he skipped the catch-up of is quiet until the next. Only the notes the held items live on are read.
    const periods = skipped ? [] : [ ...new Set([ ...holding.values() ].map((hold) => hold.period)) ];
    for (const period of periods) {
        const kind = periodKind(period);
        // A day's own items are its plan, not its catch-up; a week or month item counts from its first day, since `2027-W45` sorts after every date.
        if (!kind || (kind === "day" ? period >= date : periodStart(period) > date)) continue;
        const periodNote = await findPeriodNote(store, kind, period);
        if (!periodNote || periodNote.type !== "text" || periodNote.isProtected) continue;
        for (const task of mainTasks(await readPlan(store, kind, period, now))) {
            if (!task.listItemId || holding.get(task.listItemId)?.period !== period || held.some((h) => h.listItemId === task.listItemId)) continue;
            held.push({ noteId: task.noteId, listItemId: task.listItemId, text: task.text, section: task.section, critical: task.critical, period });
            if (kind === "day" && !days.includes(period)) days.push(period);
        }
    }
    days.sort();
    held.sort((a, b) => a.period.localeCompare(b.period));
    // A held item's question is answered in full on the day its hold was given on.
    const heldOn = held.map((task) => holding.get(task.listItemId ?? "")?.on ?? "").filter((day) => day !== "").sort()[0] ?? null;
    return { lastWorkday: last, days, note, skipped, tasks, held, heldOn };
}

/**
 * Every list item held (`#caiusHeld`) anywhere in the Journal, with the period of the note it lives
 * on and the day the hold was given on. The caller holds the lock.
 */
export async function allHeld(store: NoteStore): Promise<Map<string, { period: string; on: string }>> {
    const held = new Map<string, { period: string; on: string }>();
    for (const note of await store.search(`#${HELD_LABEL}`)) {
        const day = label(note, PERIODS.day.label) ?? "";
        for (const a of note.attributes) {
            if (a.type !== "label" || a.name !== HELD_LABEL) continue;
            const { id, period } = heldValueOf(a.value);
            held.set(id, { period: period ?? day, on: day });
        }
    }
    return held;
}

/**
 * A `#caiusHeld` value, `<listItemId>@<period>`, as the item's id and the period of the note it lives
 * on. A value without a period, from before periods were kept, gives null.
 */
export function heldValueOf(value: string): { id: string; period: string | null } {
    const at = value.lastIndexOf("@");
    const period = at > 0 ? value.slice(at + 1) : "";
    return periodKind(period) ? { id: value.slice(0, at), period } : { id: value, period: null };
}

/** The kind of a day, ISO week or month key, or null for anything else. */
function periodKind(key: string): "day" | "week" | "month" | null {
    return ([ "day", "week", "month" ] as const).find((kind) => PERIODS[kind].pattern.test(key)) ?? null;
}

/** The day notes that carry a hold (`#caiusHeld` or `#caiusHeldGroup`), by their day. The caller holds the lock. */
export async function heldDays(store: NoteStore): Promise<string[]> {
    const days = new Set<string>();
    for (const name of [ HELD_LABEL, HELD_GROUP_LABEL ]) {
        for (const note of await store.search(`#${name}`)) {
            const day = label(note, PERIODS.day.label);
            if (day) days.add(day);
        }
    }
    return [ ...days ];
}

/** A plan's top-level tasks in any state. */
function topLevel(plan: PlanView): PlanTask[] {
    return [ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ].filter((task) => task.parent === null && task.text.trim() !== "");
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
        .map((line) => ({ kind: "carry" as const, line: line.text, lineId: lineIdOf(line.text), ...(line.until ? { until: line.until } : {}) }));
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
 * planned, as `KEY:commentId`: a refresh of that day's own brief raises them again. An ask he
 * answered in Chat (`#caiusAnswered`, on any day) is in it for good. The caller holds the lock.
 */
async function raisedAsks(store: NoteStore, now: Date, day: string): Promise<Set<string>> {
    const since = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - RAISED_DAYS));
    const raised = new Set<string>();
    for (const note of await store.search(`#${ANSWERED_LABEL}`)) {
        for (const a of note.attributes) if (a.type === "label" && a.name === ANSWERED_LABEL) raised.add(a.value);
    }
    for (const note of await store.search(`#${RAISED_LABEL}`)) {
        const date = label(note, BRIEF_LABEL);
        if (!date || date < since || date >= day) continue;
        for (const a of note.attributes) if (a.type === "label" && a.name === RAISED_LABEL) raised.add(a.value);
    }
    return raised;
}

/**
 * The asks offered as candidates for a day before `day`, as `KEY:commentId` (`#caiusAskSeen` on its
 * note). The caller holds the lock.
 */
async function seenAsks(store: NoteStore, day: string): Promise<Set<string>> {
    const seen = new Set<string>();
    for (const note of await store.search(`#${ASK_SEEN_LABEL}`)) {
        const date = label(note, PERIODS.day.label);
        if (!date || date >= day) continue;
        for (const a of note.attributes) if (a.type === "label" && a.name === ASK_SEEN_LABEL) seen.add(a.value);
    }
    return seen;
}

/**
 * `jira` split by each ticket's latest ask: `fresh` holds the asks not offered on an earlier day
 * (`seen`), which are candidates, and `followed` those that were, which only the Follow up raises.
 * An ask whose ticket is `live` on a list was accepted, so it is no Follow up.
 */
export function splitAsks(jira: CaiusInputs["jira"], seen: Set<string>, live: Map<string, unknown>): { fresh: CaiusInputs["jira"]; followed: CaiusInputs["jira"] } {
    const old = new Set(latestAsks(jira.asks).filter((ask) => seen.has(`${ask.ticket.key}:${ask.commentId}`)).map((ask) => ask.ticket.key));
    return {
        fresh: { ...jira, asks: jira.asks.filter((ask) => !old.has(ask.ticket.key)) },
        followed: { ...jira, asks: jira.asks.filter((ask) => old.has(ask.ticket.key) && !live.has(ask.ticket.key)) }
    };
}

/** The `#caiusAskSeen` values of the asks among `candidates`: each ticket's latest ask in `fresh`. */
function offeredAsks(fresh: CaiusInputs["jira"], candidates: { candidateId: string; kind: string }[]): string[] {
    const offered = new Set(candidates.filter((candidate) => candidate.kind === "ask").map((candidate) => candidate.candidateId));
    return latestAsks(fresh.asks).filter((ask) => offered.has(ask.ticket.key)).map((ask) => `${ask.ticket.key}:${ask.commentId}`);
}

/** `jira` without the asks of a ticket whose latest ask is in `raised`: one with a newer comment stays. */
export function unraised(jira: CaiusInputs["jira"], raised: Set<string>): CaiusInputs["jira"] {
    const quiet = new Set(latestAsks(jira.asks).filter((ask) => raised.has(`${ask.ticket.key}:${ask.commentId}`)).map((ask) => ask.ticket.key));
    return { ...jira, asks: jira.asks.filter((ask) => !quiet.has(ask.ticket.key)) };
}

/**
 * What Follow up may raise: the latest ask per ticket, oldest first, each with the `sentence` the
 * brief writes as it is. A closed ticket's asks never reach here (`withoutClosed`).
 */
export function followUpsOf(jira: CaiusInputs["jira"]) {
    return latestAsks(jira.asks).map((ask) => ({
        key: ask.ticket.key, commentId: ask.commentId, author: ask.author, created: ask.created, excerpt: ask.excerpt, url: ask.ticket.url,
        sentence: t("caius.daily.follow_up_line", {
            author: ask.author, weekday: weekdayName(dayKey(new Date(ask.created))), excerpt: shortExcerpt(ask.excerpt), key: ask.ticket.key
        })
    }));
}

/** Longest excerpt a follow-up quotes before it is cut at a word. */
const EXCERPT_CHARS = 100;

/** `text` on one line, cut at the last word that fits in `EXCERPT_CHARS`, with an ellipsis. */
function shortExcerpt(text: string): string {
    return cutAtWord(text.replace(/\s+/g, " ").trim(), EXCERPT_CHARS);
}

/** `line` as it is when it fits in `max` characters, else cut at the last word that fits, with one ellipsis after it. */
function cutAtWord(line: string, max: number): string {
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    const word = cut.lastIndexOf(" ");
    return `${(word > 0 ? cut.slice(0, word) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export function latestAsks(asks: CaiusInputs["jira"]["asks"]) {
    const latest = new Map<string, CaiusInputs["jira"]["asks"][number]>();
    for (const ask of asks) {
        const seen = latest.get(ask.ticket.key);
        if (!seen || Date.parse(ask.created) > Date.parse(seen.created)) latest.set(ask.ticket.key, ask);
    }
    return [ ...latest.values() ].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

/** Whether the day's calendar could not be read: an error that is not a warning. */
export function failedCalendar(read: DayRead): boolean {
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

/**
 * The main list as the drawing and the picks read it: each live task's bar label, text, minutes,
 * keys and whether it is an evening task.
 */
export function listOf(plan: PlanView) {
    const eveningSections = new Set(plan.sections.filter((section) => EVENING_SECTIONS.has(normName(section.name ?? ""))).map((section) => section.name));
    return mainTasks(plan).map((task) => ({
        label: workLabel(withoutMoveLinks(task.text)), text: plainText(withoutMoveLinks(task.text)), minutes: task.estMinutes ?? DEFAULT_ESTIMATE,
        evening: eveningSections.has(task.section), keys: keysOf(withoutMoveLinks(task.text))
    }));
}

/** The day's list as the steps show it, for an answer to name by `listItemId`: each live task's id, its plain text and whether it is an evening task. */
export function listItems(plan: PlanView) {
    const evening = listOf(plan);
    return mainTasks(plan).flatMap((task, i) => task.listItemId
        ? [ { listItemId: task.listItemId, text: plainText(withoutMoveLinks(task.text)), evening: evening[i]?.evening ?? false } ]
        : []);
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

/** A task's markdown without the `[from Friday 30](#root/…)` and `_scheduled [Tuesday 3](#root/…)_` links a forward adds. */
export function withoutMoveLinks(text: string): string {
    return text.replace(/\s*(?:\[from [^\]]*\]\(#root\/[^)]*\)|_scheduled \[[^\]]*\]\(#root\/[^)]*\)_)/g, "").trim();
}

/** A task's text without its links' markup. */
export function plainText(text: string): string {
    return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
}

/** A work bar's label: the task's first Jira key, else its text cut to `LABEL_LENGTH`. */
function workLabel(text: string): string {
    const key = keysOf(text).find((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k));
    const plain = plainText(text);
    return key ?? (plain.length > LABEL_LENGTH ? cutAtWord(plain, LABEL_LENGTH - 1) : plain);
}

/**
 * `planFrom`, where the plan of a day already under way starts: the next quarter hour from now on
 * `date` when it is today and that is after `start`, as the work bars are laid out; else nothing.
 */
export function planFromOf(date: string, now: Date, start: string): { planFrom?: string } {
    const from = quarterAfter(now);
    return date === dayKey(now) && from > start ? { planFrom: from } : {};
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
export async function stillOpen(store: NoteStore, date: string, targetDay: string) {
    const docs = (await loadJournal(store)).docs;
    const week = isoWeekKey(utcDay(date));
    const targetWeek = isoWeekKey(utcDay(targetDay));
    const recent = new Set(closingPeriods(date).recent);
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

/**
 * Where a wind-down that closes on `targetDay` proposes an open item of `period` goes: a week item to
 * the target week, anything else to `targetDay`; null for an item of the target week, which stays.
 */
export function proposedForward(period: string, targetDay: string): string | null {
    if (!PERIODS.week.pattern.test(period)) return targetDay;
    const targetWeek = isoWeekKey(utcDay(targetDay));
    return period === targetWeek ? null : targetWeek;
}

/** The periods a wind-down of `date` closes: the day, the last `RECENT_WORKDAYS` workdays before it and its ISO week. */
export function closingPeriods(date: string): { recent: string[]; all: Set<string> } {
    const recent: string[] = [];
    for (let at = localDay(date), i = 0; i < RECENT_WORKDAYS; i++) {
        at = lastWorkday(at);
        recent.push(dayKey(at));
    }
    return { recent, all: new Set([ date, ...recent, isoWeekKey(utcDay(date)) ]) };
}

/** The first day of a day, ISO week or month key. */
function periodStart(key: string): string {
    const kind = PERIODS.day.pattern.test(key) ? "day" : PERIODS.week.pattern.test(key) ? "week" : "month";
    return periodSpan(kind, key).start;
}

/**
 * What a day's candidates are checked against: its plan, the week's items, the live keys, what is
 * already suggested or dismissed there and what Shawn closed lately (`closedKeys`), plus whether
 * the evening (Evening or Recharge) has a task.
 */
export async function dayFacts(store: NoteStore, date: string, now: Date) {
    const plan = await readPlan(store, "day", date, now);
    const weekKey = isoWeekKey(utcDay(date));
    const weekPlan = await readPlan(store, "week", weekKey, now);
    const { docs } = await loadJournal(store);
    const live = liveKeys(docs, now);
    const closed = await closedKeys(store, docs, now);
    const exclude = [ ...plan.dismissed, ...plan.suggested.flatMap((task) => keysOf(task.text)), ...closed ];
    const eveningTasks = plan.sections.filter((section) => EVENING_SECTIONS.has(normName(section.name ?? ""))).flatMap((section) => section.tasks)
        .filter((task) => isLive(task) && task.text.trim() !== "");
    const notToday = new Set(await dayLabels(store, date, NOT_TODAY_LABEL));
    const putOffBefore = new Set(await dayLabels(store, dayKey(lastWorkday(localDay(date))), NOT_TODAY_LABEL));
    return {
        plan, week: { key: weekKey, tasks: mainTasks(weekPlan) }, live, exclude, closed, notToday, putOffBefore, raised: await raisedAsks(store, now, date),
        evening: eveningTasks.length > 0
    };
}

/**
 * `candidates` without those he put off for the day (`#caiusNotToday` on its note), which come back
 * on the next workday, and a week item he put off on the last workday, which comes back two workdays
 * after he put it off.
 */
function onOffer<C extends { candidateId: string; kind: string }>(candidates: C[], facts: { notToday: Set<string>; putOffBefore: Set<string> }): C[] {
    return candidates.filter((candidate) => !facts.notToday.has(candidate.candidateId)
        && !(candidate.kind === "week" && facts.putOffBefore.has(candidate.candidateId)));
}

/** The live top-level tasks of a plan, the Important block first, then in his order. */
export function mainTasks(plan: PlanView): PlanTask[] {
    return [ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ].filter((task) => isLive(task) && task.parent === null);
}

const isLive = (task: PlanTask) => task.state === "open" || task.state === "in_progress";

/**
 * A candidate as the step reports it: its `candidateId` (its first key: the ticket, or a hash of a
 * week item's text), its `kind` (`handoff`, `ask` or `week`), `Get X done` (an ask is "Answer
 * {author}'s question on {KEY}", ~15m; a week item keeps its own text) with its reason in words, and for a ticket the `key` and `title` that
 * `caius_add` takes with `because` and `minutes`. A week item carries the `noteId` and `listItemId`
 * to forward instead.
 */
export function present(candidate: Candidate) {
    const { subject, reason, keys, ...rest } = candidate;
    const ticket = reason.kind === "week" ? {} : { key: candidate.source, title: subject.slice(candidate.source.length).trim() || subject };
    const because = reason.kind === "handoff"
        ? reason.days === null
            ? t("caius.daily.because_handoff_unknown", { status: reason.status })
            : t("caius.daily.because_handoff", { status: reason.status, count: reason.days })
        : reason.kind === "ask"
            ? t("caius.daily.because_ask", { author: reason.author, weekday: weekdayName(dayKey(new Date(reason.created))) })
            : t("caius.daily.because_week");
    const text = reason.kind === "week" ? subject
        : reason.kind === "ask" ? t("caius.daily.answer_ask", { author: reason.author, key: candidate.source })
            : t("caius.daily.get_done", { subject });
    return {
        candidateId: keys[0] ?? candidate.source, kind: reason.kind, text, ...ticket, because, ...rest,
        ...(reason.kind === "ask" ? { minutes: ASK_MINUTES } : {})
    };
}

/** The size of answering an ask. */
const ASK_MINUTES = 15;

/**
 * A Context line's id in the step data: a hash of its text as `sameContext` compares it, so two
 * copies of one line share it.
 */
export function lineIdOf(text: string): string {
    return `l${createHash("sha1").update(sameContext(text)).digest("hex").slice(0, 10)}`;
}

/**
 * `value` with a `<field>Label` beside every field that holds a day (`Thu 5 Nov`), an ISO week
 * (`the week of Mon 2 Nov`) or a month (`April 2027`), at any depth, so the agent never works out a weekday itself.
 */
export function withDateLabels<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => withDateLabels(item)) as T;
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [ key, field ] of Object.entries(value)) {
        out[key] = withDateLabels(field);
        const label = typeof field === "string" ? dateLabel(field) : null;
        if (label !== null && !(`${key}Label` in value)) out[`${key}Label`] = label;
    }
    return out as T;
}

/** A day as `Thu 5 Nov`, an ISO week as `the week of Mon 2 Nov`, a month as `April 2027`, anything else null. */
export function dateLabel(key: string): string | null {
    if (PERIODS.day.pattern.test(key)) {
        const at = utcDay(key);
        return t("caius.daily.day_label", {
            weekday: t(`caius.short.weekdays.${WEEKDAYS[at.getUTCDay()]}`),
            day: at.getUTCDate(),
            month: t(`caius.short.months.${MONTHS[at.getUTCMonth()]}`)
        });
    }
    if (PERIODS.week.pattern.test(key)) return t("caius.daily.week_label", { monday: dateLabel(periodSpan("week", key).start) });
    return PERIODS.month.pattern.test(key)
        ? t("caius.daily.month_label", { month: t(`months.${MONTHS[Number(key.slice(5, 7)) - 1]}`), year: key.slice(0, 4) })
        : null;
}

const MONTHS = [ "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december" ];

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
