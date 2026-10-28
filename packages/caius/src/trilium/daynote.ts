// The Meetings and Context blocks of day and week notes: replacing the Meetings block, adding a
// Context line, and writing either to a note.

import { parse, type HTMLElement } from 'node-html-parser';
import { now as clock } from '../clock.js';
import { gatherContext, type ContextEntry } from './context.js';
import { apply, elements, isCriticalAside, isHeading, isIncludeNote, isTodoList, type Edit } from './html-util.js';
import { escapeHtml } from './plan-html.js';
import { findPeriodNote, isPeriodKey, readPlan } from './plan-read.js';
import { normName, proseKind, type ProseKind } from './sections.js';
import type { NoteStore, StoreNote } from './store.js';
import { parseContext, periodSpan, sameContext } from './until.js';

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
  const block = proseBlock(top, html, 'meetings');
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

/**
 * The span under the Meetings or Context heading, the top-level elements in it, and the text and id
 * of each bullet. It ends at a heading of the same or a higher level, the other section's heading of
 * any level, or the Important block.
 */
function proseBlock(top: HTMLElement[], html: string, kind: ProseKind): { start: number; end: number; inside: HTMLElement[]; texts: string[]; ids: (string | undefined)[] } | null {
  const heading = top.findIndex((el) => isHeading(el) && proseKind(el.text) === kind);
  const headingEl = top[heading];
  if (!headingEl) return null;
  const level = Number(headingEl.tagName[1]);
  const other = kind === 'meetings' ? 'context' : 'meetings';
  const ends = (el: HTMLElement) => isCriticalAside(el)
    || (isHeading(el) && normName(el.text) !== '' && (Number(el.tagName[1]) <= level || proseKind(el.text) === other));
  const next = top.findIndex((el, i) => i > heading && ends(el));
  const nextEl = top[next];
  const inside = top.slice(heading + 1, next < 0 ? undefined : next);
  const items = inside.flatMap((el) => el.querySelectorAll('li'));
  return {
    start: headingEl.range[1],
    end: nextEl ? nextEl.range[0] : html.length,
    inside,
    texts: items.map((li) => li.text.replace(/\s+/g, ' ').trim()),
    ids: items.map((li) => li.getAttribute('data-list-item-id')),
  };
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
  const current = proseBlock(elements(parse(before, { comment: true })), before, 'meetings');
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

/**
 * `html` with `line` (text, escaped) as one more plain bullet under `### Context`: at the end of the
 * last plain list in the block, or in a new list at its end. With no Context heading, one is added
 * below the Meetings block, else below a leading include-note, else at the top.
 */
export function addContextLine(html: string, line: string): string {
  const top = elements(parse(html, { comment: true }));
  const item = `<li>${escapeHtml(line)}</li>`;
  const block = proseBlock(top, html, 'context');
  if (block) {
    const list = block.inside.filter((el) => el.tagName === 'UL' && !isTodoList(el)).pop();
    if (list && html.slice(list.range[1] - '</ul>'.length, list.range[1]) === '</ul>') {
      const at = list.range[1] - '</ul>'.length;
      return apply(html, [{ start: at, end: at, text: item }]);
    }
    return apply(html, [{ start: block.end, end: block.end, text: `<ul>${item}</ul>` }]);
  }
  const meetings = proseBlock(top, html, 'meetings');
  const first = top[0];
  const at = meetings ? meetings.end : first && isIncludeNote(first) ? first.range[1] : 0;
  return apply(html, [{ start: at, end: at, text: `<h3>Context</h3><ul>${item}</ul>` }]);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `YYYY-MM-DD` as the `(until …)` text a Context line carries, `Fri 6 Nov`, with the year added
 * when `parseContext` would otherwise read it as another year from a note dated `noteDate`.
 */
export function formatUntil(until: string, noteDate: string): string {
  const day = new Date(`${until}T00:00:00Z`);
  const short = `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  const read = parseContext([`x (until ${short})`], noteDate).context[0]?.until;
  return read === until ? short : `${short} ${day.getUTCFullYear()}`;
}

export type ContextAddResult =
  | { status: 'added' | 'updated'; writtenNoteId: string; line: string; detail?: string }
  | { status: 'dry-run'; writtenNoteId: string; line: string; before: string; after: string; detail?: string }
  | { status: 'skipped'; reason: 'bad_request' | 'unreadable' | 'edited' | 'duplicate'; detail?: string };

/**
 * Adds one Context line to a day note (`date`) or an ISO week note (`week`), with ` (until Fri 6 Nov)`
 * when `until` is given. Text already in force there is skipped as `duplicate`: for a day, anything
 * `gatherContext` returns for it (the week note's lines included); for a week, the week note's own
 * lines in force. The text is compared by `sameContext`: ignoring case, spacing and trailing punctuation. A missing note is created from the
 * template, except on a dry run. The write is a compare-and-swap.
 */
export async function addContext(
  api: NoteStore,
  req: { date?: string; week?: string; text: string; from?: string; until?: string },
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<ContextAddResult> {
  const period = req.date !== undefined ? 'day' : 'week';
  const key = req.date ?? req.week ?? '';
  if ((req.date === undefined) === (req.week === undefined) || !isPeriodKey(period, key)) {
    return { status: 'skipped', reason: 'bad_request', detail: 'give exactly one of date (YYYY-MM-DD) or week (YYYY-Www) that exists' };
  }
  const { context, expiredContext, pendingContext } = parseContext([req.text], periodSpan(period, key).start);
  const parsed = context[0] ?? expiredContext[0] ?? pendingContext[0];
  const text = parsed?.text ?? '';
  const until = req.until ?? parsed?.until;
  const from = req.from ?? parsed?.from;
  const noteDate = periodSpan(period, key).start;
  if (!text) return { status: 'skipped', reason: 'bad_request', detail: 'text is required' };
  if (until !== undefined && (!isPeriodKey('day', until) || until < noteDate)) {
    return { status: 'skipped', reason: 'bad_request', detail: `until must be a YYYY-MM-DD on or after ${noteDate}` };
  }
  if (from !== undefined && (!isPeriodKey('day', from) || (until !== undefined && from > until))) {
    return { status: 'skipped', reason: 'bad_request', detail: 'from must be a YYYY-MM-DD on or before until' };
  }

  let note: StoreNote | null = await findPeriodNote(api, period, key);
  if (note && (note.type !== 'text' || note.isProtected)) {
    return { status: 'skipped', reason: 'unreadable', detail: 'note is protected or not a text note' };
  }
  const inForce = period === 'day'
    ? (await gatherContext(api, key)).context
    : (await readPlan(api, 'week', key, opts.now ?? clock())).context;
  const hit = inForce.find((line) => sameContext(line.text) === sameContext(text));
  if (hit) {
    const longer = hit.until !== undefined && (until === undefined || hit.until < until);
    if (!longer) return { status: 'skipped', reason: 'duplicate', detail: `already in force: ${hit.text}` };
    // The copy in force ends sooner. In the note asked for, its `(until …)` is rewritten where it
    // stands. In another note, which can stop being read before the new date (an older day, last
    // week), the line is written to the note asked for instead, where it is the newer copy.
    const where = 'noteId' in hit ? (hit as ContextEntry) : note ? { period: 'week' as const, key, noteId: note.noteId } : null;
    if (where && where.noteId === note?.noteId) {
      return extendUntil(api, where, hit.text, hit.from ?? from, until, opts.dryRun);
    }
  }

  const line = contextLine(text, from, until, noteDate);
  let created = false;
  if (!note && !opts.dryRun) {
    note = period === 'day' ? await api.calendarDay(key) : await api.calendarWeek(key);
    created = true;
  }
  const before = note ? await api.content(note.noteId) : '';
  const after = addContextLine(before, line);
  const noteId = note?.noteId ?? 'NEW-NOTE';
  if (opts.dryRun) {
    const detail = note ? undefined : `${key} has no ${period} note yet; this is a diff against an empty note, and a real run would add the line to the Journal template`;
    return { status: 'dry-run', writtenNoteId: noteId, line, before, after, ...(detail ? { detail } : {}) };
  }
  if (!(await api.putContent(noteId, after, before))) {
    return { status: 'skipped', reason: 'edited', detail: `${key} changed meanwhile; nothing written` };
  }
  return { status: 'added', writtenNoteId: noteId, line, ...(created ? { detail: `created the ${period} note` } : {}) };
}

/** A Context line with its range: `text (from Thu 5 Nov until Fri 6 Nov)`, either end left out when there is none. */
function contextLine(text: string, from: string | undefined, until: string | undefined, noteDate: string): string {
  const ends = [from ? `from ${formatUntil(from, noteDate)}` : '', until ? `until ${formatUntil(until, noteDate)}` : ''].filter(Boolean);
  return ends.length ? `${text} (${ends.join(' ')})` : text;
}

/** Rewrites the `(until …)` of the Context line `text` in a note: to `until`, or away when there is none, keeping its `from`. */
async function extendUntil(
  api: NoteStore,
  where: { period: 'day' | 'week'; key: string; noteId: string },
  text: string,
  from: string | undefined,
  until: string | undefined,
  dryRun?: boolean,
): Promise<ContextAddResult> {
  const noteDate = periodSpan(where.period, where.key).start;
  const line = contextLine(text, from, until, noteDate);
  const before = await api.content(where.noteId);
  const after = setContextLine(before, text, line, noteDate);
  if (after === null) return { status: 'skipped', reason: 'edited', detail: `${where.key} changed meanwhile; nothing written` };
  if (dryRun) return { status: 'dry-run', writtenNoteId: where.noteId, line, before, after };
  if (!(await api.putContent(where.noteId, after, before))) {
    return { status: 'skipped', reason: 'edited', detail: `${where.key} changed meanwhile; nothing written` };
  }
  return { status: 'updated', writtenNoteId: where.noteId, line, detail: `extended the line in ${where.key}` };
}

/**
 * `html` with the Context bullet whose text (without its `(until …)`) is `text` rewritten to `line`,
 * or null when there is no such bullet. `noteDate` resolves a year-less `until`. Of several copies, the one in force longest is rewritten:
 * no `until`, else the latest. The bullet's own markup is kept; only its text changes.
 */
export function setContextLine(html: string, text: string, line: string, noteDate: string): string | null {
  const top = elements(parse(html, { comment: true }));
  const block = proseBlock(top, html, 'context');
  const copies = (block?.inside ?? [])
    .flatMap((el) => el.querySelectorAll('li'))
    .map((item) => {
      const { context, expiredContext, pendingContext } = parseContext([item.text.replace(/\s+/g, ' ').trim()], noteDate);
      return { item, parsed: context[0] ?? expiredContext[0] ?? pendingContext[0] };
    })
    .filter(({ parsed }) => sameContext(parsed?.text ?? '') === sameContext(text));
  // A copy without an until outlasts any with one.
  const longest = copies.reduce<(typeof copies)[number] | undefined>(
    (best, copy) => !best || (best.parsed?.until !== undefined && (copy.parsed?.until === undefined || copy.parsed.until > best.parsed.until)) ? copy : best,
    undefined,
  );
  if (!longest) return null;
  const start = html.indexOf('>', longest.item.range[0]) + 1;
  const end = longest.item.range[1] - '</li>'.length;
  return apply(html, [{ start, end, text: escapeHtml(line) }]);
}
