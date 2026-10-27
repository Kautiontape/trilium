// The day note's Meetings block: replacing it in a note's HTML, and writing it to a day note.

import { parse, type HTMLElement } from 'node-html-parser';
import { apply, elements, isCriticalAside, isHeading, type Edit } from './html-util.js';
import { escapeHtml } from './plan-html.js';
import { findPeriodNote, isPeriodKey } from './plan-read.js';
import { normName, proseKind } from './sections.js';
import type { NoteStore } from './store.js';

/**
 * The block under `### Meetings` in a note's HTML, replaced with a plain bullet list of `lines`
 * (text escaped). The block runs to the next heading of the same or a higher level, a Context heading of any
 * level, or the Important block; everything past it is untouched. With no Meetings heading, one is added at the
 * top, below a leading include-note section if there is one. `ids` are the list item ids to give
 * the bullets, by position.
 */
export function replaceMeetings(html: string, lines: string[], ids: (string | undefined)[] = []): string {
  const root = parse(html, { comment: true });
  const top = elements(root);
  const item = (line: string, i: number) => `<li${ids[i] ? ` data-list-item-id="${ids[i]}"` : ''}>${escapeHtml(line)}</li>`;
  const list = lines.length ? `<ul>${lines.map(item).join('')}</ul>` : '';
  const block = meetingsBlock(top, html);
  const edits: Edit[] = [];

  if (block) {
    edits.push({ start: block.start, end: block.end, text: list });
  } else {
    const first = top[0];
    const at = first && isIncludeNote(first) ? first.range[1] : 0;
    edits.push({ start: at, end: at, text: `<h3>Meetings</h3>${list}` });
  }
  return apply(html, edits);
}

/** The span under the Meetings heading, and the text and id of each bullet in it. */
function meetingsBlock(top: HTMLElement[], html: string): { start: number; end: number; texts: string[]; ids: (string | undefined)[] } | null {
  const heading = top.findIndex((el) => isHeading(el) && proseKind(el.text) === 'meetings');
  if (heading < 0) return null;
  const level = Number(top[heading]!.tagName[1]);
  const ends = (el: HTMLElement) => isCriticalAside(el)
    || (isHeading(el) && normName(el.text) !== '' && (Number(el.tagName[1]) <= level || proseKind(el.text) === 'context'));
  const next = top.findIndex((el, i) => i > heading && ends(el));
  const inside = top.slice(heading + 1, next < 0 ? undefined : next);
  const items = inside.flatMap((el) => el.querySelectorAll('li'));
  return {
    start: top[heading]!.range[1],
    end: next < 0 ? html.length : top[next]!.range[0],
    texts: items.map((li) => li.text.replace(/\s+/g, ' ').trim()),
    ids: items.map((li) => li.getAttribute('data-list-item-id')),
  };
}

function isIncludeNote(el: HTMLElement): boolean {
  return el.tagName === 'SECTION' && el.classList.contains('include-note');
}

export type MeetingsResult =
  | { date: string; status: 'updated'; writtenNoteId: string; detail?: string }
  | { date: string; status: 'unchanged'; writtenNoteId: string }
  | { date: string; status: 'dry-run'; writtenNoteId: string; before: string; after: string; detail?: string }
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
  const current = meetingsBlock(elements(parse(before, { comment: true })), before);
  const same = (text: string, i: number) => text === lines[i]?.replace(/\s+/g, ' ').trim();
  const unchanged = current && current.texts.length === lines.length && current.texts.every(same);
  const after = unchanged ? before : replaceMeetings(before, lines, current?.ids);
  const noteId = note?.noteId ?? 'NEW-NOTE';
  if (opts.dryRun) {
    const detail = note ? undefined : `${date} has no day note yet; this is a diff against an empty note, and a real run would add the block to the Journal template`;
    return { date, status: 'dry-run', writtenNoteId: noteId, before, after, ...(detail ? { detail } : {}) };
  }
  if (after === before) return { date, status: 'unchanged', writtenNoteId: noteId };
  if (!(await api.putContent(noteId, after, before))) {
    return { date, status: 'skipped', reason: 'edited', detail: `${date} changed meanwhile; nothing written` };
  }
  return { date, status: 'updated', writtenNoteId: noteId, ...(created ? { detail: 'created the day note' } : {}) };
}
