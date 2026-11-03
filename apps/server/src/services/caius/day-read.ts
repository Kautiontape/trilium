/**
 * The day read: what a day holds and how it weighs, from its frame (`DayFrame`) and its plan. The
 * steps' capacity and Growth sentences and the views take their figures from it, so they agree.
 */

import { type ContextEntry, dayLoad, type DayLoad, isoWeekKey, liveMinutes, type NoteStore, type PlanTask, type PlanView, readPlan, type Rhythm } from "@triliumnext/caius";

import { drawnNamesOf, FOCUS_LABEL } from "./brief.js";
import { type DayFrame, dayLabels, deckTasks, drawnEvents, failedCalendar, focusFor, mainTasks, meetingsOf, rolloverOf, withBooked, workBlocks } from "./daily.js";
import type { InputError } from "./inputs/types.js";
import { slipsOf, trails } from "./trail.js";

/** A day as `readDay` reads it. Plain data, so a tool can return it as it is. */
export interface DayView {
    date: string;
    plan: PlanView;
    meetings: ReturnType<typeof meetingsOf>;
    capacity: CapacityFigures;
    growth: GrowthFigures;
    /** The day's one over figure (`dayLoadOf`), which `caius_plan` and the steps give too. */
    load: DayLoad;
    /** The drawing's events and the list laid out between them (`workBlocks`), with the brief's names. */
    layout: {
        events: ReturnType<typeof drawnEvents>;
        groups: ReturnType<typeof workBlocks>["groups"];
        unplaced: ReturnType<typeof workBlocks>["unplaced"];
    };
    /** How many times each live list and On deck task moved on from a day note, by `listItemId`. */
    slips: Record<string, number>;
    /** The Context lines in force on the day. */
    context: ContextEntry[];
    calendarFailed: boolean;
    errors: InputError[];
}

/** The capacity block's figures: what `capacityOf` words for the chat. */
export interface CapacityFigures {
    windowMinutes: number;
    bookedMinutes: number;
    openMinutes: number;
    targetMinutes: number;
    plannedMinutes: number;
    bookedRatio: number;
    focus: { min: number; max: number };
}

/** The Growth figures: what `growthOf` words for the chat. */
export interface GrowthFigures {
    minutes: number;
    target: Rhythm["targets"]["growth"];
    over: boolean;
}

/**
 * The day `date` from `frame` (`dayFrame` or `dayRead`, read before the lock) and its `plan`. The
 * caller holds the lock, since the brief's names and the trail come from the store.
 */
export async function readDay(store: NoteStore, frame: DayFrame, plan: PlanView, { date, now }: { date: string; now: Date }): Promise<DayView> {
    const names = await drawnNamesOf(store, date);
    const all = await trails(store, now);
    const { start, end, workEnd, noon } = frame.rhythm;
    const events = drawnEvents(frame, names);
    const { groups, unplaced } = workBlocks(plan, { start, end, workEnd, noon }, events, date, now, rolloverOf(frame.rhythm), names);
    const slips: Record<string, number> = Object.fromEntries([ ...mainTasks(plan), ...deckTasks(plan) ].flatMap(({ noteId, listItemId, text }): [string, number][] =>
        listItemId ? [ [ listItemId, slipsOf(all, { noteId, listItemId, text }) ] ] : []));
    const stated = failedCalendar(frame) ? await statedFocus(store, date) : null;
    return {
        date, plan, meetings: meetingsOf(frame), capacity: capacityFigures(frame, plan, stated), growth: growthFigures(frame, plan), load: dayLoadOf(frame, plan, { stated }),
        layout: { events, groups, unplaced }, slips, context: frame.context, calendarFailed: failedCalendar(frame), errors: frame.inputs.errors
    };
}

/**
 * The day's capacity: the work window, what the meetings book of it and leave open (less the time a
 * Growth or Recharge task pinned to a clock books), the Foundation focus target, the work planned
 * and `focus` (`dayFocus`, given `stated`), the figure the Plan tab shows too.
 */
export function capacityFigures(frame: DayFrame, plan: PlanView, stated: Range | null = null): CapacityFigures {
    // The meetings are what the figures call booked; a Growth task pinned in the day shrinks the open time and the target, not the meetings.
    const sized = withBooked(frame, plan);
    const { windowMinutes, openMinutes, targetMinutes, bookedRatio } = sized.inputs.capacity;
    const { bookedMinutes } = frame.inputs.capacity;
    return { windowMinutes, bookedMinutes, openMinutes, targetMinutes, plannedMinutes: plan.capacity.totalMinutes, bookedRatio, focus: dayFocus(frame, plan, stated) };
}

/**
 * The day's one over figure (`dayLoad`): the list's Foundation minutes, with `incoming.list` added,
 * against the focus figure (`dayFocus`), and On deck's Foundation minutes, with `incoming.onDeck`, apart.
 */
export function dayLoadOf(frame: DayFrame, plan: PlanView, { stated = null, incoming = { list: 0, onDeck: 0 } }: { stated?: Range | null; incoming?: { list: number; onDeck: number } } = {}): DayLoad {
    const focus = dayFocus(frame, plan, stated);
    return dayLoad({
        foundation: plan.capacity.areas.foundation.minutes + incoming.list,
        // The whole On deck, so a parent counts through its live sub-items as plan-read counts it.
        onDeck: liveMinutes(plan.onDeck, "foundation") + incoming.onDeck,
        growth: plan.capacity.areas.growth.minutes,
        recharge: mainTasks(plan).filter((task) => task.area === "recharge" && task.text.trim() !== "").length
    }, { focus, growthTarget: frame.rhythm.targets.growth });
}

/**
 * The day's focus figure, which every focus on a day reads: `focusFor` the day with its pinned tasks
 * booked (`withBooked`), or with a failed calendar `stated` (the day's `#caiusFocus`), else the
 * Rhythm's Foundation target.
 */
export function dayFocus(frame: DayFrame, plan: PlanView, stated: Range | null = null): Range {
    return failedCalendar(frame) ? stated ?? frame.rhythm.targets.foundation : focusFor(withBooked(frame, plan));
}

/**
 * A day plan's capacity as `caius_plan` gives it: the target and Foundation's target are the focus
 * figure, Growth's the Rhythm's Growth target, `load` the one over figure (`dayLoadOf`) and
 * `calendarFailed` whether the focus is the stated or the Rhythm's one rather than the meetings'.
 */
export function dayCapacityOf(frame: DayFrame, plan: PlanView, stated: Range | null) {
    const load = dayLoadOf(frame, plan, { stated });
    const { focus } = load.foundation;
    const { areas } = plan.capacity;
    return {
        ...plan.capacity, target: focus,
        areas: { ...areas, foundation: { ...areas.foundation, target: focus }, growth: { ...areas.growth, target: frame.rhythm.targets.growth } },
        load, calendarFailed: failedCalendar(frame)
    };
}

/** The focus the steps stated for `date` (`#caiusFocus`, `min-max` in minutes), or null. The caller holds the lock. */
export async function statedFocus(store: NoteStore, date: string): Promise<Range | null> {
    const [ value ] = await dayLabels(store, date, FOCUS_LABEL);
    const [ min, max ] = (value ?? "").split("-").map(Number);
    return value && min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/** The live minutes of Growth tasks on the list, with `incoming` added, against the Rhythm's Growth target. */
export function growthFigures(frame: DayFrame, plan: PlanView, incoming = 0): GrowthFigures {
    const minutes = plan.capacity.areas.growth.minutes + incoming;
    const target = frame.rhythm.targets.growth;
    return { minutes, target, over: minutes > target.max };
}

/** Several days as `readDays` reads them, with the week row above them. Plain data. */
export interface DaysRead {
    from: string;
    days: { date: string; workday: boolean; day: DayView }[];
    week: {
        key: string;
        /** The week note's live top-level tasks: the ones not yet pulled to a day. */
        tasks: PlanTask[];
        /** The week's Foundation minutes: the week note's own items plus the lists of the requested days in that week, against the week's target. */
        foundation: { minutes: number; target: { min: number; max: number } | null };
    };
}

/** What `readDays` needs from the service: a day's frame (reads its own notes, so never under the lock) and the lock. */
export interface DaysDeps {
    store: NoteStore;
    dayFrame: (date: string) => Promise<DayFrame>;
    locked: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * `count` days from `from`: each day's `readDay`, and the plan of the ISO week of `from` (when the
 * days span two weeks, the week row is the first one's and counts only the days in it). The frames are read first and the plans
 * under one lock. A day without a note reads as empty, with its meetings. The caller keeps `count` within 2 to 7.
 */
export async function readDays(deps: DaysDeps, from: string, count: number, now: Date): Promise<DaysRead> {
    const dates = Array.from({ length: count }, (_, index) => addDays(from, index));
    const frames = await Promise.all(dates.map((date) => deps.dayFrame(date)));
    const key = isoWeekKey(new Date(`${from}T00:00:00Z`));
    return deps.locked("caius_days", async () => {
        const weekPlan = await readPlan(deps.store, "week", key, now);
        const days: DaysRead["days"] = [];
        for (const [ index, date ] of dates.entries()) {
            const frame = frames[index];
            if (!frame) throw new Error(`no frame for ${date}`);
            const plan = await readPlan(deps.store, "day", date, now);
            const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
            days.push({ date, workday: weekday !== 0 && weekday !== 6, day: await readDay(deps.store, frame, plan, { date, now }) });
        }
        const inWeek = days.filter(({ date }) => isoWeekKey(new Date(`${date}T00:00:00Z`)) === key);
        const minutes = weekPlan.capacity.areas.foundation.minutes + inWeek.reduce((sum, { day }) => sum + day.plan.capacity.areas.foundation.minutes, 0);
        return { from, days, week: { key, tasks: mainTasks(weekPlan), foundation: { minutes, target: weekPlan.capacity.target } } };
    });
}

type Range = { min: number; max: number };

function addDays(date: string, days: number): string {
    return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
