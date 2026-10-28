// The Context in force for a day: the Context sections of the day note, the last three workday
// notes, the current week note and, on a Monday, last week's. A day note's line without an
// `until` holds on that day only. Read-only; never creates a note.

import { lastWorkday } from '../workday.js';
import { buildDoc, loadStateSymbols } from './journal.js';
import { findPeriodNote, isoWeekKey, periodPath, type PeriodKind } from './plan-read.js';
import type { NoteReader } from './store.js';
import { parseContext, periodSpan, sameContext, type ContextLine } from './until.js';

export interface ContextEntry extends ContextLine {
  /** The kind and key of the note the line is in. */
  period: 'day' | 'week';
  key: string;
  noteId: string;
}

const WORKDAYS_BACK = 3;
const DAY_MS = 86_400_000;

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The notes `gatherContext` reads for `date`: the ISO week note, last week's on a Monday (marked
 * `oneDay`, since it is read on that Monday only), the day note and the last three workday notes.
 */
export function contextNotes(date: string): { period: 'day' | 'week'; key: string; oneDay?: true }[] {
  const day = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const days = [date];
  for (let at = day, i = 0; i < WORKDAYS_BACK; i++) {
    at = lastWorkday(at);
    days.push(dayKey(at));
  }
  const utc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  return [
    { period: 'week', key: isoWeekKey(new Date(utc)) },
    ...(day.getDay() === 1 ? [{ period: 'week' as const, key: isoWeekKey(new Date(utc - 7 * DAY_MS)), oneDay: true as const }] : []),
    ...days.map((key) => ({ period: 'day' as const, key })),
  ];
}

/**
 * Context lines in force on `date` (`YYYY-MM-DD`), from the notes `contextNotes` names. A line whose
 * `(until …)` date is before `date` is dropped, and so is an earlier day note's line without an
 * `until`, which holds on its own day only and so takes no part in the comparison below. When the same text is in several notes, the
 * newest note's line is kept (compared by `sameContext`): a day note is dated by its day, a week note by its Monday, and a
 * day note beats a week note that starts the same day. The result is newest first. `pending` holds
 * the lines whose range starts later, for a writer to tell a duplicate.
 */
export async function gatherContext(api: NoteReader, date: string): Promise<{ date: string; context: ContextEntry[]; pending: ContextEntry[] }> {
  const states = await loadStateSymbols(api);
  const sources = contextNotes(date)
    .map(({ period, key }) => ({ period, key, dated: period === 'week' ? periodSpan('week', key).start : key }))
    .sort((a, b) => (a.dated === b.dated ? Number(a.period === 'day') - Number(b.period === 'day') : a.dated < b.dated ? -1 : 1));

  // Oldest first, so that a later note's line replaces an earlier one with the same text.
  const kept = new Map<string, { entry: ContextEntry; expired: boolean }>();
  const pending = new Map<string, ContextEntry>();
  for (const { period, key, dated } of sources) {
    const note = await findPeriodNote(api, period as PeriodKind, key);
    if (!note || note.type !== 'text' || note.isProtected) continue;
    const doc = buildDoc(note, periodPath(period, key), await api.content(note.noteId), states);
    // Expired lines take part, so that a newer note ending a line hides the older open-ended copy;
    // within one note an in force line is read last and so beats an expired copy.
    const { context, expiredContext, pendingContext } = parseContext(doc.contextLines, dated, date);
    for (const line of pendingContext) pending.set(sameContext(line.text), { ...line, period, key, noteId: note.noteId });
    const oneDayOver = (line: ContextLine) => period === 'day' && key < date && line.until === undefined;
    for (const [expired, lines] of [[true, expiredContext], [false, context]] as const) {
      for (const line of lines) {
        if (oneDayOver(line)) continue;
        const id = sameContext(line.text);
        kept.delete(id);
        kept.set(id, { entry: { ...line, period, key, noteId: note.noteId }, expired });
      }
    }
  }
  const context = [...kept.values()].reverse().filter((k) => !k.expired).map((k) => k.entry);
  const inForce = new Set(context.map((line) => sameContext(line.text)));
  return { date, context, pending: [...pending.entries()].filter(([id]) => !inForce.has(id)).map(([, line]) => line) };
}
