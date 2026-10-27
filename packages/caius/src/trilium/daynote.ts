// The day note's Meetings block: replacing it in a note's HTML, and writing it to a day note.

import { parse, type HTMLElement } from 'node-html-parser';
import { apply, elements, isCriticalAside, isHeading, type Edit } from './html-util.js';
import { escapeHtml } from './plan-html.js';
import { findPeriodNote, isPeriodKey } from './plan-read.js';
import { proseKind } from './sections.js';
import type { NoteStore } from './store.js';

/**
 * The block under `### Meetings` in a note's HTML, replaced with a plain bullet list of `lines`
 * (text escaped). The block runs to the next heading of the same or a higher level, or to the
 * Important block; everything past it is untouched. With no Meetings heading, one is added at the
 * top, below a leading include-note section if there is one.
 */
export function replaceMeetings(html: string, lines: string[]): string {
  const root = parse(html, { comment: true });
  const top = elements(root);
  const list = lines.length ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '';
  const heading = top.findIndex((el) => isHeading(el) && proseKind(el.text) === 'meetings');
  const edits: Edit[] = [];

  if (heading >= 0) {
    const level = Number(top[heading]!.tagName[1]);
    const end = top.findIndex((el, i) => i > heading && ((isHeading(el) && Number(el.tagName[1]) <= level) || isCriticalAside(el)));
    const start = top[heading]!.range[1];
    edits.push({ start, end: end < 0 ? html.length : top[end]!.range[0], text: list });
  } else {
    const first = top[0];
    const at = first && isIncludeNote(first) ? first.range[1] : 0;
    edits.push({ start: at, end: at, text: `<h3>Meetings</h3>${list}` });
  }
  return apply(html, edits);
}

function isIncludeNote(el: HTMLElement): boolean {
  return el.tagName === 'SECTION' && el.classList.contains('include-note');
}

export type MeetingsResult =
  | { date: string; status: 'updated'; writtenNoteId: string; detail?: string }
  | { date: string; status: 'unchanged'; writtenNoteId: string }
  | { date: string; status: 'dry-run'; writtenNoteId: string; before: string; after: string }
  | { date: string; status: 'skipped'; reason: 'bad_request' | 'unreadable' | 'edited'; detail?: string };

/**
 * Replaces the Meetings block of a day note with `lines` (see `replaceMeetings`). The write is a
 * compare-and-swap against the HTML it was built from. A missing day note is created from the
 * template, except on a dry run, which creates nothing and answers the change it would make.
 */
export async function setMeetings(api: NoteStore, req: { date: string; lines: string[] }, opts: { dryRun?: boolean } = {}): Promise<MeetingsResult> {
  const { date, lines } = req;
  if (!isPeriodKey('day', date) || !Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    return { date, status: 'skipped', reason: 'bad_request', detail: 'date must be a YYYY-MM-DD that exists and lines a list of strings' };
  }
  let note = await findPeriodNote(api, 'day', date);
  let created = false;
  if (!note && !opts.dryRun) {
    note = await api.calendarDay(date);
    created = true;
  }
  if (note && (note.type !== 'text' || note.isProtected)) {
    return { date, status: 'skipped', reason: 'unreadable', detail: 'note is protected or not a text note' };
  }

  const before = note ? await api.content(note.noteId) : '';
  const after = replaceMeetings(before, lines);
  const noteId = note?.noteId ?? 'NEW-NOTE';
  if (opts.dryRun) return { date, status: 'dry-run', writtenNoteId: noteId, before, after };
  if (after === before) return { date, status: 'unchanged', writtenNoteId: noteId };
  if (!(await api.putContent(noteId, after, before))) {
    return { date, status: 'skipped', reason: 'edited', detail: `${date} changed meanwhile; nothing written` };
  }
  return { date, status: 'updated', writtenNoteId: noteId, ...(created ? { detail: 'created the day note' } : {}) };
}
