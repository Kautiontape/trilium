// A day's calendar events as the Meetings block's clock lines, and the pairs that overlap.

/** The part of a calendar event the Meetings block reads. `start` and `end` are `HH:MM`. */
export interface MeetingEvent {
  start: string;
  end: string;
  title: string;
  attendees: string[];
  allDay: boolean;
  declined: boolean;
  overlap?: boolean;
}

const MAX_NAMES = 4;

/**
 * One `HH:MM Title (Sam, Riley)` line per timed meeting, in start order: the first names of up to
 * four attendees, and ` (overlaps)` on a meeting that overlaps another. Declined and all-day events
 * are left out, and so is a line identical to an earlier one.
 */
export function meetingLines(events: MeetingEvent[]): string[] {
  const lines = timed(events).map((event) => {
    const names = [...new Set(event.attendees.map((name) => name.trim().split(/\s+/)[0] ?? '').filter(Boolean))].slice(0, MAX_NAMES);
    return `${event.start} ${event.title.trim()}${names.length ? ` (${names.join(', ')})` : ''}${event.overlap ? ' (overlaps)' : ''}`;
  });
  return [...new Set(lines)];
}

/** Each pair of timed meetings that overlap, with `at` the later start. Back-to-back meetings don't overlap. */
export function overlapPairs(events: MeetingEvent[]): { first: string; second: string; at: string }[] {
  const meetings = timed(events);
  const pairs: { first: string; second: string; at: string }[] = [];
  for (const [i, a] of meetings.entries()) {
    for (const b of meetings.slice(i + 1)) {
      if (a.start < b.end && b.start < a.end) pairs.push({ first: a.title, second: b.title, at: b.start > a.start ? b.start : a.start });
    }
  }
  return pairs;
}

function timed(events: MeetingEvent[]): MeetingEvent[] {
  return events.filter((event) => !event.allDay && !event.declined).sort((a, b) => a.start.localeCompare(b.start));
}
