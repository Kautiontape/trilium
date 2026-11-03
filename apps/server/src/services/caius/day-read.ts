/**
 * The day read: what a day holds and how it weighs, from its frame (`DayFrame`) and its plan. The
 * steps' capacity and Growth sentences and the views take their figures from it, so they agree.
 */

import type { ContextEntry, NoteStore, PlanView, Rhythm } from "@triliumnext/caius";

import { drawnNamesOf } from "./brief.js";
import { type DayFrame, deckTasks, drawnEvents, failedCalendar, focusFor, mainTasks, meetingsOf, rolloverOf, withBooked, workBlocks } from "./daily.js";
import type { InputError } from "./inputs/types.js";
import { slipsOf, trails } from "./trail.js";

/** A day as `readDay` reads it. Plain data, so a tool can return it as it is. */
export interface DayView {
    date: string;
    plan: PlanView;
    meetings: ReturnType<typeof meetingsOf>;
    capacity: CapacityFigures;
    growth: GrowthFigures;
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
    return {
        date, plan, meetings: meetingsOf(frame), capacity: capacityFigures(frame, plan), growth: growthFigures(frame, plan),
        layout: { events, groups, unplaced }, slips, context: frame.context, calendarFailed: failedCalendar(frame), errors: frame.inputs.errors
    };
}

/**
 * The day's capacity: the work window, what the meetings book of it and leave open (less the time a
 * Growth or Recharge task pinned to a clock books), the Foundation focus target, the work planned
 * and `focus`, the figure the Plan tab shows too.
 */
export function capacityFigures(frame: DayFrame, plan: PlanView): CapacityFigures {
    // The meetings are what the figures call booked; a Growth task pinned in the day shrinks the open time and the target, not the meetings.
    const sized = withBooked(frame, plan);
    const { windowMinutes, openMinutes, targetMinutes, bookedRatio } = sized.inputs.capacity;
    const { bookedMinutes } = frame.inputs.capacity;
    return { windowMinutes, bookedMinutes, openMinutes, targetMinutes, plannedMinutes: plan.capacity.totalMinutes, bookedRatio, focus: focusFor(sized) };
}

/** The live minutes of Growth tasks on the list, with `incoming` added, against the Rhythm's Growth target. */
export function growthFigures(frame: DayFrame, plan: PlanView, incoming = 0): GrowthFigures {
    const minutes = plan.capacity.areas.growth.minutes + incoming;
    const target = frame.rhythm.targets.growth;
    return { minutes, target, over: minutes > target.max };
}
