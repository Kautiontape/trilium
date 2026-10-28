// Context lines and their `(until …)` expiry, and the dates of a period. Pure string work.

export interface ContextLine {
  text: string;
  /** `YYYY-MM-DD`: the last day the line is in force. */
  until?: string;
}

/**
 * A Context line's text as two copies of it compare: lower case, spacing collapsed and trailing
 * punctuation dropped, so "ZAP-2590 is open." and "zap-2590 is  open" are one line.
 */
export function sameContext(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[\s.!?,;:…]+$/, '').toLowerCase();
}

const UNTIL = /\s*\(\s*until\s+([^()]*?)\s*\)\s*$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 86_400_000;
const MAX_AHEAD_DAYS = 300;

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcMs = (key: string) => Date.parse(`${key}T00:00:00Z`);

/**
 * Splits Context bullets into the lines in force on `planDate` and the expired ones. A trailing
 * `(until Fri 6 Nov)`, `(until 6 Nov)` or `(until 2026-11-06)` is taken off the text and kept as
 * `until`, resolved against `noteDate` (a year-less date is the next occurrence, or the previous when that is over 300 days ahead); any other suffix stays in the text.
 * A line whose `until` is before `planDate` is expired.
 */
export function parseContext(lines: string[], noteDate: string, planDate: string = noteDate): { context: ContextLine[]; expiredContext: ContextLine[] } {
  const context: ContextLine[] = [];
  const expiredContext: ContextLine[] = [];
  for (const line of lines) {
    const match = UNTIL.exec(line);
    const until = match?.[1] ? resolveDate(match[1], noteDate) : null;
    const entry: ContextLine = match && until ? { text: line.slice(0, match.index).trim(), until } : { text: line.trim() };
    (until && until < planDate ? expiredContext : context).push(entry);
  }
  return { context, expiredContext };
}

/** `Fri 6 Nov`, `6 November`, `6 Nov 2026` or `2026-11-06` as `YYYY-MM-DD`, or null. */
function resolveDate(text: string, noteDate: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const named = /^(?:[a-z]{3,9}\.?,?\s+)?(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?$/i.exec(text);
  let year: number | null = null;
  let month: number;
  let day: number;
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])] as [number, number, number];
  } else if (named) {
    month = MONTHS.indexOf((named[2] ?? '').slice(0, 3).toLowerCase());
    day = Number(named[1]);
    year = named[3] ? Number(named[3]) : null;
    if (month < 0) return null;
  } else return null;

  const valid = (y: number) => {
    const d = new Date(Date.UTC(y, month, day));
    return d.getUTCFullYear() === y && d.getUTCMonth() === month && d.getUTCDate() === day ? d.getTime() : null;
  };
  if (year !== null) {
    const ms = valid(year);
    return ms === null ? null : dateKey(ms);
  }
  // A date without a year is the next occurrence on or after the note's date, unless that is over
  // MAX_AHEAD_DAYS away, when it is the previous one ("30 Dec" in a 2 Jan note is last December).
  const base = Number(noteDate.slice(0, 4));
  const near = utcMs(noteDate);
  const next = [base, base + 1, base + 2].map(valid).find((ms): ms is number => ms !== null && ms >= near);
  const previous = [base, base - 1, base - 2].map(valid).find((ms): ms is number => ms !== null && ms < near);
  const pick = next !== undefined && (next - near) / DAY_MS <= MAX_AHEAD_DAYS ? next : (previous ?? next);
  return pick === undefined ? null : dateKey(pick);
}

/** The first and last day of a period, as `YYYY-MM-DD`. */
export function periodSpan(period: 'day' | 'week' | 'month', key: string): { start: string; end: string } {
  if (period === 'day') return { start: key, end: key };
  if (period === 'month') {
    const [year, month] = [Number(key.slice(0, 4)), Number(key.slice(5, 7))];
    return { start: `${key}-01`, end: `${key}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}` };
  }
  const jan4 = Date.UTC(Number(key.slice(0, 4)), 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (Number(key.slice(6)) - 1) * 7 * DAY_MS;
  return { start: dateKey(monday), end: dateKey(monday + 6 * DAY_MS) };
}
