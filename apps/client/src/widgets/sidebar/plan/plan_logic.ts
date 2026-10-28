import type FNote from "../../../entities/fnote";
import {
    dayKey, isSuggested, monthKey, nextMonthKey, nextWeekKey, tomorrowKey, weekKey
} from "../../../menus/task_actions";
import type {
    CaiusContextLine, CaiusForwardItem, CaiusPeriodKind, CaiusPlan, CaiusPlanTask, CaiusSetStateItem
} from "../../../services/caius";

/** The period the Plan tab shows: its kind, and any local day inside it. */
export interface ViewedPeriod {
    kind: CaiusPeriodKind;
    anchor: Date;
}

/** The period of a day, week or month note, or of a child of one; today for any other note. */
export function periodOfNote(note: FNote | null | undefined, now: Date): ViewedPeriod {
    for (const candidate of note ? [ note, ...note.getParentNotes() ] : []) {
        for (const [ kind, label ] of PERIOD_LABELS) {
            const anchor = parsePeriodKey(kind, candidate.getOwnedLabelValue(label) ?? "");
            if (anchor) {
                return { kind, anchor };
            }
        }
    }

    return { kind: "day", anchor: startOfDay(now) };
}

const PERIOD_LABELS: [ CaiusPeriodKind, string ][] = [
    [ "day", "dateNote" ], [ "week", "weekNote" ], [ "month", "monthNote" ]
];

/** `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM` for the period. */
export function periodKey({ kind, anchor }: ViewedPeriod) {
    switch (kind) {
        case "day": return dayKey(anchor);
        case "week": return weekKey(anchor);
        case "month": return monthKey(anchor);
    }
}

/** The first local day of the period `key` names, or `null` when `key` names no such period. */
export function parsePeriodKey(kind: CaiusPeriodKind, key: string): Date | null {
    const match = KEY_PATTERNS[kind].exec(key);
    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const second = Number(match[2]);
    let anchor: Date;
    if (kind === "week") {
        // ISO week 1 is the week with 4 January in it.
        const jan4 = new Date(year, 0, 4);
        anchor = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + (second - 1) * 7);
    } else {
        anchor = new Date(year, second - 1, kind === "day" ? Number(match[3]) : 1);
    }

    return periodKey({ kind, anchor }) === key ? anchor : null;
}

const KEY_PATTERNS: Record<CaiusPeriodKind, RegExp> = {
    day: /^(\d{4})-(\d{2})-(\d{2})$/,
    week: /^(\d{4})-W(\d{2})$/,
    month: /^(\d{4})-(\d{2})$/
};

/** The period `delta` periods after `period`, or before it for a negative `delta`. */
export function stepPeriod({ kind, anchor }: ViewedPeriod, delta: number): ViewedPeriod {
    const [ year, month, day ] = [ anchor.getFullYear(), anchor.getMonth(), anchor.getDate() ];
    switch (kind) {
        case "day": return { kind, anchor: new Date(year, month, day + delta) };
        case "week": return { kind, anchor: new Date(year, month, day + 7 * delta) };
        case "month": return { kind, anchor: new Date(year, month + delta, 1) };
    }
}

/**
 * Whether the period is due to be closed: a past one, today from 15:00, or the current week or
 * month. `clockMinutes` is the time of day in the workday, past 24:00 in the small hours.
 */
export function isCloseable(period: ViewedPeriod, now: Date, clockMinutes = now.getHours() * 60 + now.getMinutes()) {
    const key = periodKey(period);
    // Keys of one kind sort in time order as strings.
    const current = periodKey({ kind: period.kind, anchor: now });
    if (period.kind === "day") {
        return key < current || (key === current && clockMinutes >= CLOSE_DAY_FROM_HOUR * 60);
    }

    return key <= current;
}

const CLOSE_DAY_FROM_HOUR = 15;

/** A task's text as the tab shows it: a Markdown link reads as its label alone. */
export function taskLabel(text: string) {
    return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * A Suggested item's label split into what to do and why, at its "because". A size in brackets at
 * the end stays with what to do: "Get X done: because Y (~30m)" reads as "Get X done (~30m)" and
 * "because Y". A label without a "because" after some text is all title.
 */
export function splitReason(label: string): { title: string; reason: string | null } {
    const match = /^(.*?\S):?\s+(because\s.*?)(\s*\(~\d+[hm](?:\d+m)?\))?$/i.exec(label);
    if (!match) {
        return { title: label, reason: null };
    }

    return { title: `${match[1]}${match[3] ?? ""}`, reason: match[2] };
}

export function isLive(task: Pick<CaiusPlanTask, "state">) {
    return task.state === "open" || task.state === "in_progress";
}

/** The tasks of the plan outside Suggested: the critical block, then the sections in order. */
export function planTasks(plan: CaiusPlan) {
    return [ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ];
}

/**
 * The live tasks that need a fate to close the period. A sub-item of a live task, told by its
 * parent's list item id, is left out: its parent's forward or drop carries it along.
 */
export function closeCandidates(plan: CaiusPlan) {
    const live = planTasks(plan).filter(isLive);
    const liveIds = new Set(live.map((task) => task.listItemId).filter((id) => id !== null));
    return live.filter((task) => !task.parentListItemId || !liveIds.has(task.parentListItemId));
}

/**
 * The live tasks without an estimate, counted as `capacity.unestimatedCount` counts them: a task
 * with live sub-items counts through its sub-items instead, an empty to-do is not a task, and an
 * evening task (under Evening or Recharge) is not work.
 */
export function unestimatedTasks(plan: CaiusPlan) {
    const live = planTasks(plan).filter((task) => isLive(task) && task.text.trim() !== "");
    const parents = new Set(live.filter((task) => task.parent !== null).map((task) => task.parent));
    return live.filter((task) => !parents.has(task.text) && task.estMinutes === null && !EVENING_SECTIONS.has(sectionName(task.section)));
}

/** The sections whose tasks are the evening's, as the library's `isEveningName` reads them. */
const EVENING_SECTIONS = new Set([ "evening", "recharge" ]);

/** A heading as the library compares it: lower-case letters and digits only. */
function sectionName(name: string | null) {
    return (name ?? "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** Where the capacity of the plan stands against its target. */
export function capacityStatus({ totalMinutes, target }: CaiusPlan["capacity"]) {
    if (!target) {
        return "none";
    }
    if (totalMinutes < target.min) {
        return "under";
    }

    return totalMinutes > target.max ? "over" : "within";
}

/**
 * The headings of a note's HTML in document order, without Suggested and empty ones: where Accept
 * can put a suggested item.
 */
export function acceptSections(html: string) {
    const document = new DOMParser().parseFromString(html, "text/html");
    // Meetings and Context hold notes, not tasks, down to the next heading of their level or higher.
    const open: { level: number; prose: boolean }[] = [];
    const headings: string[] = [];
    for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
        const name = (heading.textContent ?? "").trim();
        if (!name.replace(/[^\p{L}\p{N}]+/gu, "")) {
            continue;
        }

        const level = Number(heading.tagName[1]);
        while (open.length && (open.at(-1)?.level ?? 0) >= level) {
            open.pop();
        }
        const prose = /^(meetings|context)$/.test(name.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase());
        open.push({ level, prose });
        if (!open.some((entry) => entry.prose) && !isSuggested(name)) {
            headings.push(name);
        }
    }
    return [ ...new Set(headings) ];
}

/** `current` is today, this week or this month, for the kind of period being closed. */
export type FateKind = "current" | "tomorrow" | "next_week" | "next_month" | "drop";

export interface Fate {
    kind: FateKind;
    /** Why the task is dropped; a drop without one is not decided yet. */
    reason?: string;
}

/**
 * The fates for closing the `period` note `key`, in order. A past period also offers the current
 * one, since Tomorrow counts from now and so skips today.
 */
export function closeFates(period: CaiusPeriodKind, key: string, now: Date): FateKind[] {
    const later: FateKind[] = [ "tomorrow", "next_week", "next_month", "drop" ];
    return isPastPeriod(period, key, now) ? [ "current", ...later ] : later;
}

/** Whether the `period` note `key` is over: before the day, week or month `now` falls in. */
export function isPastPeriod(period: CaiusPeriodKind, key: string, now: Date) {
    // Keys of one kind sort by date.
    return key < periodKey({ kind: period, anchor: now });
}

/** Whether a Context line in force on the day `date` lapses before the next workday. */
export function endsSoon(line: Pick<CaiusContextLine, "until">, date: string) {
    const day = parsePeriodKey("day", date);
    return !!line.until && !!day && line.until < dayKey(nextWorkday(day));
}

/** The first workday after `date`, as `nextWorkday` in `packages/caius/src/workday.ts` steps. */
function nextWorkday(date: Date) {
    const day = startOfDay(date);
    do {
        day.setDate(day.getDate() + 1);
    } while (day.getDay() === 0 || day.getDay() === 6);
    return day;
}

/**
 * The note a forwarding fate sends a task to, counted from `now` as the task menu counts it;
 * `period` is the kind of period being closed, which `current` stays in.
 */
export function fateTarget(kind: Exclude<FateKind, "drop">, now: Date, period: CaiusPeriodKind) {
    switch (kind) {
        case "current": return periodKey({ kind: period, anchor: now });
        case "tomorrow": return tomorrowKey(now);
        case "next_week": return nextWeekKey(now);
        case "next_month": return nextMonthKey(now);
    }
}

/** The fates of `fates` whose task is still among `candidates`; a refresh can drop a task. */
export function listedFates(
    fates: Record<string, Fate>, candidates: { listItemId?: string | null }[]
) {
    const listed = new Set(candidates.map((task) => task.listItemId));
    return Object.fromEntries(Object.entries(fates)
        .filter(([ listItemId ]) => listed.has(listItemId)));
}

export function isDecided(fate: Fate | undefined) {
    return !!fate && (fate.kind !== "drop" || !!fate.reason?.trim());
}

/**
 * The writes that carry out the decided fates of the tasks of `noteId`, keyed by list item id: one
 * `forward` call for every forwarding fate, since each item names its own target, and one
 * `set-state` call for the drops.
 */
export function groupFates(
    noteId: string, fates: Record<string, Fate>, now: Date, period: CaiusPeriodKind
) {
    const forward: CaiusForwardItem[] = [];
    const drop: CaiusSetStateItem[] = [];
    for (const [ listItemId, fate ] of Object.entries(fates)) {
        if (!isDecided(fate)) {
            continue;
        }

        if (fate.kind === "drop") {
            drop.push({ noteId, listItemId, state: "cancelled", reason: fate.reason?.trim() });
        } else {
            forward.push({ noteId, listItemId, to: fateTarget(fate.kind, now, period) });
        }
    }

    return { forward, drop };
}

function startOfDay(date: Date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
