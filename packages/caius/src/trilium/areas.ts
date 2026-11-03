// The day's three areas, Foundation (the day job), Growth and Recharge, as a marker at the start of
// a task's text, and the clock that pins a task to a time. One place reads and writes both.

import { parseClock } from '../inputs/capacity.js';

export type Area = 'foundation' | 'growth' | 'recharge';
export const AREAS: Area[] = ['foundation', 'growth', 'recharge'];

/** The marker each area other than Foundation carries; an unmarked task is Foundation. */
export const MARKERS: Record<Exclude<Area, 'foundation'>, string> = { growth: '🌱', recharge: '🔋' };

/** The day's time blocks, in order. */
export type Block = 'morning' | 'afternoon' | 'evening';
export const BLOCKS: Block[] = ['morning', 'afternoon', 'evening'];
export const BLOCK_NAMES: Record<Block, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };

// A marker, with or without the emoji's variation selector, and the space after it.
const MARKER = /^\s*(🌱|🔋)️?\s*/u;
const CLOCK = /^\s*([0-2]\d:[0-5]\d)\s+/;

/** The area a task's text marks, or null when it carries no marker. */
export function markedArea(text: string): Area | null {
  const m = MARKER.exec(text);
  return m ? (m[1] === MARKERS.growth ? 'growth' : 'recharge') : null;
}

/** `text` without its marker. */
export function stripMarker(text: string): string {
  return text.replace(MARKER, '');
}

/** `text` with the marker of `area`, or with none for Foundation, replacing any it had. */
export function withArea(text: string, area: Area): string {
  const bare = stripMarker(text);
  return area === 'foundation' ? bare : `${MARKERS[area]} ${bare}`;
}

/** The `HH:MM` a task's text starts with (after any marker), or null. */
export function clockOf(text: string): string | null {
  const m = CLOCK.exec(stripMarker(text));
  return m && parseClock(m[1]!) !== undefined ? m[1]! : null;
}

/** `text` without its marker or its leading clock: the words to show. */
export function bareText(text: string): string {
  const bare = stripMarker(text);
  return clockOf(bare) ? bare.replace(CLOCK, '') : bare;
}

/** The block a heading names (`Morning`, `🌅 Afternoon`), or null. */
export function blockOf(heading: string | null): Block | null {
  const n = (heading ?? '').replace(/[^\p{L}]+/gu, '').toLowerCase();
  return (BLOCKS as string[]).includes(n) ? (n as Block) : null;
}

/** The area a heading names (`Growth`, `🔋 Recharge`), or null. */
export function headingArea(heading: string | null): Area | null {
  const n = (heading ?? '').replace(/[^\p{L}]+/gu, '').toLowerCase();
  return (AREAS as string[]).includes(n) ? (n as Area) : null;
}
