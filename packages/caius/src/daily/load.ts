// The day's load: how many minutes each area holds against its limit, and the one "over" figure.
// Pure arithmetic with no store, so the phone redraws a meter with the server's own numbers.

import type { Area } from '../trilium/areas.js';
import type { PlanTask } from '../trilium/plan-read.js';

/** Minutes assumed for a live task with no `~est` token. */
export const DEFAULT_ESTIMATE = 30;

type Range = { min: number; max: number };
type Countable = Pick<PlanTask, 'state' | 'text' | 'estMinutes' | 'parent' | 'listItemId' | 'parentListItemId' | 'at'> & {
  noteId?: string;
  area?: Area;
};

export interface DayLoad {
  foundation: { minutes: number; focus: Range; over: boolean; overMinutes: number };
  /** `overWith` is how far over `focus.max` the day would be with On deck added. */
  onDeck: { minutes: number; overWith: number };
  growth: { minutes: number; target: Range; over: boolean };
  recharge: { count: number };
}

/** One counted unit: a live task whose parent is not live, with the minutes it adds. */
export interface Unit<T extends Countable = Countable> {
  task: T;
  minutes: number;
  /** Leaves of the unit that carry an estimate. */
  estimated: number;
  /** Leaves of the unit that fell back to `DEFAULT_ESTIMATE`. */
  unestimated: number;
}

export interface CountOptions<T extends Countable = Countable> {
  /** The day's meeting lines (`09:30 Standup (Ana)`); a parent pinned to one of their clocks counts 0. */
  meetings?: string[];
  /** Each sub-item mapped to its parent, as `parentsOf` returns; default is `parentsOf` over the live tasks. */
  parents?: Map<T, T>;
}

/**
 * The counted units of `tasks`: each live, non-empty task whose parent is not live. A task without
 * live sub-items counts its estimate, else `DEFAULT_ESTIMATE`. A parent pinned to a meeting's clock
 * counts 0, one with an estimate of its own counts that, and any other counts the sum of its live
 * sub-items by the same rules.
 */
export function countUnits<T extends Countable>(tasks: T[], opts: CountOptions<T> = {}): Unit<T>[] {
  const live = tasks.filter(isLive);
  const liveSet = new Set(live);
  const parents = opts.parents ?? parentsOf(live);
  const children = new Map<T, T[]>();
  const units: T[] = [];
  for (const task of live) {
    const parent = parents.get(task);
    if (parent === undefined || !liveSet.has(parent)) {
      units.push(task);
    } else {
      children.set(parent, [...(children.get(parent) ?? []), task]);
    }
  }
  const clocks = new Set((opts.meetings ?? []).map(clockKey).filter((c) => c !== null));

  const count = (task: T): Omit<Unit<T>, 'task'> => {
    const kids = children.get(task) ?? [];
    const own = task.estMinutes;
    if (kids.length === 0) {
      return own !== null
        ? { minutes: own, estimated: 1, unestimated: 0 }
        : { minutes: DEFAULT_ESTIMATE, estimated: 0, unestimated: 1 };
    }
    const at = clockKey(task.at);
    if (at !== null && clocks.has(at)) return { minutes: 0, estimated: 0, unestimated: 0 };
    if (own !== null) return { minutes: own, estimated: 1, unestimated: 0 };
    const sum = { minutes: 0, estimated: 0, unestimated: 0 };
    for (const kid of kids) {
      const c = count(kid);
      sum.minutes += c.minutes;
      sum.estimated += c.estimated;
      sum.unestimated += c.unestimated;
    }
    return sum;
  };
  return units.map((task) => ({ task, ...count(task) }));
}

/**
 * Minutes of the live work, of one `area` when given: the sum of `countUnits`, each unit in its own
 * area (a family counts in its parent's). An empty to-do is a blank checkbox and counts nothing, nor
 * makes its parent a parent.
 */
export function liveMinutes<T extends Countable>(tasks: T[], area?: Area, opts?: CountOptions<T>): number {
  return countUnits(tasks, opts)
    .filter((u) => area === undefined || u.task.area === area)
    .reduce((n, u) => n + u.minutes, 0);
}

/** The minutes `countUnits` gives `task` when it is a unit of `tasks`, else its own estimate or the default. */
export function unitMinutes<T extends Countable>(task: T, tasks: T[], opts?: CountOptions<T>): number {
  return countUnits(tasks, opts).find((u) => u.task === task)?.minutes ?? task.estMinutes ?? DEFAULT_ESTIMATE;
}

/**
 * Each sub-item of `tasks` mapped to its parent task: the task of the same note whose `listItemId`
 * is its `parentListItemId`, or, without that id, the nearest earlier task of the note with the
 * words in `parent`.
 */
export function parentsOf<T extends Countable>(tasks: T[]): Map<T, T> {
  const parents = new Map<T, T>();
  for (const [index, task] of tasks.entries()) {
    const parent = task.parentListItemId !== null
      ? tasks.find((t) => t.noteId === task.noteId && t.listItemId === task.parentListItemId)
      : task.parent !== null
        ? tasks.slice(0, index).findLast((t) => t.noteId === task.noteId && t.text === task.parent)
        : undefined;
    if (parent !== undefined) parents.set(task, parent);
  }
  return parents;
}

/** The day's load from its minutes. On deck never counts toward `over`; `recharge` is a count of things. */
export function dayLoad(
  minutes: { foundation: number; onDeck: number; growth: number; recharge: number },
  limits: { focus: Range; growthTarget: Range },
): DayLoad {
  const { focus, growthTarget } = limits;
  return {
    foundation: {
      minutes: minutes.foundation,
      focus,
      over: minutes.foundation > focus.max,
      overMinutes: Math.max(0, minutes.foundation - focus.max),
    },
    onDeck: { minutes: minutes.onDeck, overWith: Math.max(0, minutes.foundation + minutes.onDeck - focus.max) },
    growth: { minutes: minutes.growth, target: growthTarget, over: minutes.growth > growthTarget.max },
    recharge: { count: minutes.recharge },
  };
}

function isLive(t: Countable): boolean {
  return (t.state === 'open' || t.state === 'in_progress') && t.text.trim() !== '';
}

/** `HH:MM` of a leading clock in `text`, hour padded to two digits; null when there is none. */
function clockKey(text: string | null): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?!\d)/.exec(text ?? '');
  return m ? `${(m[1] ?? '').padStart(2, '0')}:${m[2]}` : null;
}
