// The Context in force for a day: the Context sections of the day note, the last three workday
// notes, the current week note and, on a Monday, last week's. Read-only; never creates a note.

import { lastWorkday } from '../workday.js';
import { buildDoc, loadStateSymbols } from './journal.js';
import { findPeriodNote, isoWeekKey, periodPath, type PeriodKind } from './plan-read.js';
import type { NoteReader } from './store.js';
import { parseContext, periodSpan, type ContextLine } from './until.js';

export interface ContextEntry extends ContextLine {
  /** The kind and key of the note the line is in. */
  period: 'day' | 'week';
  key: string;
  noteId: string;
}

const WORKDAYS_BACK = 3;
const DAY_MS = 86_400_000;

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sameText = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Context lines in force on `date` (`YYYY-MM-DD`), from the notes named above. A line whose
 * `(until …)` date is before `date` is dropped. When the same text is in several notes, the
 * newest note's line is kept: a day note is dated by its day, a week note by its Monday, and a
 * day note beats a week note that starts the same day. The result is newest first.
 */
export async function gatherContext(api: NoteReader, date: string): Promise<{ date: string; context: ContextEntry[] }> {
  const day = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const days = [date];
  for (let at = day, i = 0; i < WORKDAYS_BACK; i++) {
    at = lastWorkday(at);
    days.push(dayKey(at));
  }
  const utc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  const weeks = [isoWeekKey(new Date(utc))];
  if (day.getDay() === 1) weeks.push(isoWeekKey(new Date(utc - 7 * DAY_MS)));

  const states = await loadStateSymbols(api);
  const sources = [
    ...weeks.map((key) => ({ period: 'week' as const, key, dated: periodSpan('week', key).start })),
    ...days.map((key) => ({ period: 'day' as const, key, dated: key })),
  ].sort((a, b) => (a.dated === b.dated ? Number(a.period === 'day') - Number(b.period === 'day') : a.dated < b.dated ? -1 : 1));

  // Oldest first, so that a later note's line replaces an earlier one with the same text.
  const kept = new Map<string, ContextEntry>();
  for (const { period, key, dated } of sources) {
    const note = await findPeriodNote(api, period as PeriodKind, key);
    if (!note || note.type !== 'text' || note.isProtected) continue;
    const doc = buildDoc(note, periodPath(period, key), await api.content(note.noteId), states);
    for (const line of parseContext(doc.contextLines, dated, date).context) {
      const id = sameText(line.text);
      kept.delete(id);
      kept.set(id, { ...line, period, key, noteId: note.noteId });
    }
  }
  return { date, context: [...kept.values()].reverse() };
}
