// The standing note (`#assistantContext`, "How I work"), read as markdown: its sections, and the
// day's span from the Rhythm section.

import { normName } from '../trilium/sections.js';
import { DEFAULT_ROLLOVER } from '../workday.js';

export const DEFAULT_START = '10:00';
export const DEFAULT_END = '23:00';
export const DEFAULT_WORK_END = '18:00';

export interface Rhythm {
  /** Standup, `HH:MM`: where the day starts. */
  start: string;
  /** Bedtime, `HH:MM`: where the day ends. After midnight it counts on from 24: 1:00 AM is `25:00`. */
  end: string;
  /** Where work ends and the evening begins, `HH:MM`. */
  workEnd: string;
  /** When the day rolls over, `HH:MM` (never after standup): until then it is still the day before. */
  rollover: string;
  /** For the weather, when the Rhythm gives them as numbers. */
  latitude?: number;
  longitude?: number;
  /** Which values came from the note and which are defaults. */
  from: Record<'start' | 'end' | 'workEnd' | 'rollover', 'rhythm' | 'default'>;
}

/** The latest the day can roll over, so a clock never runs past 29:59. */
const MAX_ROLLOVER = 6 * 60;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*([ap]\.?m\.?)?(?![\d])/i;
const COORDINATES = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

/**
 * The body of the section headed `name` (compared ignoring case, emoji and spacing), verbatim and
 * trimmed, up to the next heading of the same or a higher level; null when there is none.
 */
export function sectionOf(markdown: string | null, name: string): string | null {
  if (markdown === null) return null;
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => normName(HEADING.exec(line)?.[2] ?? '') === normName(name) && HEADING.test(line));
  if (start < 0) return null;
  const level = HEADING.exec(lines[start] ?? '')?.[1]?.length;
  if (level === undefined) return null;
  const end = lines.findIndex((line, i) => i > start && (HEADING.exec(line)?.[1]?.length ?? 7) <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/**
 * The day's span from the standing note's Rhythm section: the time on the line that names standup
 * (or when work starts), the time after "bedtime", and the time after "work ends" (or "end of
 * work"). An end of work or a bedtime without am or pm that falls at or before an earlier point of
 * the day is read 12 hours later. A bedtime before the rollover is after midnight: 1:00 AM, 00:30 or
 * "midnight" read `25:00`, `24:30` and `24:00`. A value the section doesn't give, or one that still
 * doesn't come after those points, is the default: 10:00, 23:00 and 18:00. The line that names when
 * "the day rolls over" (or "day ends at", "rollover") gives the rollover, 04:00 by default and
 * never after standup. Coordinates written as `47.61, -122.33` on the location line are read too.
 */
export function readRhythm(markdown: string | null): Rhythm {
  const lines = (sectionOf(markdown, 'Rhythm') ?? '').split('\n');
  const after = (pattern: RegExp, midnight = false) => {
    for (const line of lines) {
      const at = line.search(pattern);
      const rest = at < 0 ? '' : line.slice(at);
      const time = TIME.exec(rest);
      if (time) return { minutes: minutesOf(time), meridiem: !!time[3] };
      if (midnight && /\bmidnight\b/i.test(rest)) return { minutes: 0, meridiem: true };
    }
    return null;
  };
  /** `time` in minutes, if it comes after every one of `earlier`, turning an hour without am or pm to the evening when that helps. */
  const later = (time: { minutes: number; meridiem: boolean } | null, earlier: number[]) => {
    if (!time) return null;
    const minutes = !time.meridiem && earlier.some((e) => time.minutes <= e) ? time.minutes + 12 * 60 : time.minutes;
    return minutes < 24 * 60 && earlier.every((e) => minutes > e) ? minutes : null;
  };
  const start = after(/standup|work starts|start of work/i)?.minutes ?? null;
  const startAt = start ?? toMinutes(DEFAULT_START);
  const given = after(/rolls over|roll over|rollover|\b(?:the|my) day ends? at/i, true)?.minutes ?? null;
  const rolloverAt = given !== null && given <= Math.min(startAt, MAX_ROLLOVER) ? given : Math.min(DEFAULT_ROLLOVER, startAt);
  const workEnd = later(after(/work ends|end of work|stop work|finish work/i), [startAt]);
  const bedtime = after(/bedtime/i, true);
  // Twelve without am or pm, "12:30", is half past midnight here.
  const small = bedtime && !bedtime.meridiem && bedtime.minutes >= 12 * 60 && bedtime.minutes < 13 * 60 ? bedtime.minutes - 12 * 60 : bedtime?.minutes ?? null;
  // A bedtime before the rollover is after midnight, so it counts on from 24:00.
  const end = small !== null && small <= rolloverAt && rolloverAt > 0 ? small + 24 * 60 : later(bedtime, [startAt, workEnd ?? toMinutes(DEFAULT_WORK_END)]);
  const located = lines.filter((line) => /location|weather/i.test(line)).map((line) => COORDINATES.exec(line)).find(Boolean);
  const latitude = located ? Number(located[1]) : NaN;
  const longitude = located ? Number(located[2]) : NaN;
  return {
    start: start === null ? DEFAULT_START : hhmm(start),
    end: end === null ? DEFAULT_END : hhmm(end),
    workEnd: workEnd === null ? DEFAULT_WORK_END : hhmm(workEnd),
    rollover: hhmm(rolloverAt),
    ...(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : {}),
    from: { start: start === null ? 'default' : 'rhythm', end: end === null ? 'default' : 'rhythm', workEnd: workEnd === null ? 'default' : 'rhythm', rollover: given !== null && given <= Math.min(startAt, MAX_ROLLOVER) ? 'rhythm' : 'default' },
  };
}

/** A matched time in minutes after midnight, with a trailing am or pm applied. */
function minutesOf(match: RegExpExecArray): number {
  let hour = Number(match[1]);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return hour * 60 + Number(match[2]);
}

const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
