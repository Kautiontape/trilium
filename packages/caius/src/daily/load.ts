// The day's load: how many minutes each area holds against its limit, and the one "over" figure.
// Pure arithmetic with no store, so the phone redraws a meter with the server's own numbers.

import type { Area } from '../trilium/areas.js';
import type { PlanTask } from '../trilium/plan-read.js';

/** Minutes assumed for a live task with no `~est` token. */
export const DEFAULT_ESTIMATE = 30;

type Range = { min: number; max: number };
type Countable = Pick<PlanTask, 'state' | 'text' | 'estMinutes' | 'parent'> & { area?: Area };

export interface DayLoad {
  foundation: { minutes: number; focus: Range; over: boolean; overMinutes: number };
  /** `overWith` is how far over `focus.max` the day would be with On deck added. */
  onDeck: { minutes: number; overWith: number };
  growth: { minutes: number; target: Range; over: boolean };
  recharge: { count: number };
}

/**
 * Minutes of the live top-level work, of one `area` when given. A task with live sub-items counts
 * through them, not twice; an unestimated one counts `DEFAULT_ESTIMATE`; an empty to-do is a blank
 * checkbox and counts nothing, nor makes its parent a parent.
 */
export function liveMinutes(tasks: Countable[], area?: Area): number {
  const live = tasks.filter((t) => (t.state === 'open' || t.state === 'in_progress') && t.text.trim() !== '');
  const parents = new Set(live.filter((t) => t.parent !== null).map((t) => t.parent));
  return live
    .filter((t) => !parents.has(t.text) && (area === undefined || t.area === area))
    .reduce((n, t) => n + (t.estMinutes ?? DEFAULT_ESTIMATE), 0);
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
