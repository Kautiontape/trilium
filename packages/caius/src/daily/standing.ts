// The standing note (`#assistantContext`, "How I work"), read as markdown: its sections, and the
// day's span from the Rhythm section.

import { normName } from '../trilium/sections.js';

export const DEFAULT_START = '10:00';
export const DEFAULT_END = '23:00';
export const DEFAULT_WORK_END = '18:00';

export interface Rhythm {
  /** Standup, `HH:MM`: where the day starts. */
  start: string;
  /** Bedtime, `HH:MM`: where the day ends. */
  end: string;
  /** Where work ends and the evening begins, `HH:MM`. */
  workEnd: string;
  /** For the weather, when the Rhythm gives them as numbers. */
  latitude?: number;
  longitude?: number;
  /** Which values came from the note and which are defaults. */
  from: Record<'start' | 'end' | 'workEnd', 'rhythm' | 'default'>;
}

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
 * the day is read 12 hours later. A value the section doesn't give, or one that still doesn't come
 * after those points, is the default: 10:00, 23:00 and 18:00. Coordinates written as
 * `47.61, -122.33` on the location line are read too.
 */
export function readRhythm(markdown: string | null): Rhythm {
  const lines = (sectionOf(markdown, 'Rhythm') ?? '').split('\n');
  const after = (pattern: RegExp) => {
    for (const line of lines) {
      const at = line.search(pattern);
      const time = at < 0 ? null : TIME.exec(line.slice(at));
      if (time) return { minutes: minutesOf(time), meridiem: !!time[3] };
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
  const workEnd = later(after(/work ends|end of work|stop work|finish work/i), [startAt]);
  const end = later(after(/bedtime/i), [startAt, workEnd ?? toMinutes(DEFAULT_WORK_END)]);
  const located = lines.filter((line) => /location|weather/i.test(line)).map((line) => COORDINATES.exec(line)).find(Boolean);
  const latitude = located ? Number(located[1]) : NaN;
  const longitude = located ? Number(located[2]) : NaN;
  return {
    start: start === null ? DEFAULT_START : hhmm(start),
    end: end === null ? DEFAULT_END : hhmm(end),
    workEnd: workEnd === null ? DEFAULT_WORK_END : hhmm(workEnd),
    ...(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : {}),
    from: { start: start === null ? 'default' : 'rhythm', end: end === null ? 'default' : 'rhythm', workEnd: workEnd === null ? 'default' : 'rhythm' },
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
