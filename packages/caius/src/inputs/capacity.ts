/** What a day's meetings leave for focused work. Pure arithmetic; the server supplies the meetings. */

export const DEFAULT_WORK_START = '10:00';
export const DEFAULT_WORK_END = '18:00';
/** The share of open time a person can focus for. */
export const FOCUS_FACTOR = 0.65;
/** The method's ceiling for one day, in minutes. */
export const MAX_TARGET_MINUTES = 240;

export interface DayCapacity {
  windowMinutes: number;
  bookedMinutes: number;
  openMinutes: number;
  targetMinutes: number;
  bookedRatio: number;
}

/** The part of a calendar event capacity reads. `start` and `end` are `HH:MM`. */
export interface CapacityMeeting {
  start: string;
  end: string;
  allDay?: boolean;
  declined?: boolean;
}

export interface CapacityOptions {
  workStart?: string;
  workEnd?: string;
}

/** Minutes after midnight for `HH:MM` (`24:00` is allowed), or `undefined` for anything else. */
export function parseClock(clock: string): number | undefined {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(clock);
  if (!match) return undefined;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes > 24 * 60 ? undefined : minutes;
}

/**
 * Works out the capacity of one day. Booked time is the union of the non-declined, timed
 * meetings clipped to the work window, so overlapping meetings count once and booked time never
 * exceeds the window. The target is `open × FOCUS_FACTOR`, rounded, between 0 and
 * `MAX_TARGET_MINUTES`.
 */
export function dayCapacity(meetings: CapacityMeeting[], options: CapacityOptions = {}): DayCapacity {
  const start = parseClock(options.workStart ?? DEFAULT_WORK_START) ?? 10 * 60;
  const end = parseClock(options.workEnd ?? DEFAULT_WORK_END) ?? 18 * 60;
  const windowMinutes = Math.max(0, end - start);

  const spans: Array<[number, number]> = [];
  for (const meeting of meetings) {
    if (meeting.allDay || meeting.declined) continue;
    const from = parseClock(meeting.start);
    const to = parseClock(meeting.end);
    if (from === undefined || to === undefined) continue;
    const clippedFrom = Math.max(from, start);
    const clippedTo = Math.min(to, end);
    if (clippedTo > clippedFrom) spans.push([clippedFrom, clippedTo]);
  }

  spans.sort((a, b) => a[0] - b[0]);
  let bookedMinutes = 0;
  let reach = -1;
  for (const [from, to] of spans) {
    const counted = Math.max(from, reach);
    if (to > counted) bookedMinutes += to - counted;
    reach = Math.max(reach, to);
  }

  const openMinutes = windowMinutes - bookedMinutes;
  return {
    windowMinutes,
    bookedMinutes,
    openMinutes,
    targetMinutes: Math.min(MAX_TARGET_MINUTES, Math.max(0, Math.round(openMinutes * FOCUS_FACTOR))),
    bookedRatio: windowMinutes === 0 ? 0 : bookedMinutes / windowMinutes
  };
}
