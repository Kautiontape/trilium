// Pure HTML transforms for forwarding a task between Trilium day, week and month notes.
//
// Day notes are CKEditor HTML, so a forward edits that HTML directly (never a
// markdown round trip). node-html-parser finds elements and gives each its
// source range; every change is then spliced into the original string, so all
// markup we don't touch stays byte-for-byte as Trilium stored it.

import { parse, HTMLElement, TextNode, type Node } from 'node-html-parser';
import type { StateSymbols } from './markdown.js';
import { escapeHtml, ON_DECK, placeForwarded } from './plan-html.js';
import { isOnDeckName } from './sections.js';
import {
  apply,
  checkboxEdit,
  descriptionOf,
  elements,
  findItem,
  isLive,
  isTodoList,
  liveDescendants,
  newListItemId,
  rewriteOpenTag,
  sectionOf,
  inCriticalAside,
  inProseSection,
  spanEnd,
  tokenZoneStartInHtml,
  isHeading,
  norm,
  type Edit,
} from './html-util.js';

export { newListItemId };

export type ItemProblem = 'not_found' | 'not_live' | 'already_moved';

export interface MarkOptions {
  /** Note id of the day, week or month the task moves to (the reference link points here). */
  targetNoteId: string;
  /** Link text, e.g. "Tuesday 27" (see periodLabel). */
  targetLabel: string;
  states: StateSymbols;
  /** The Rescheduled state's id and title; Shawn's are `_rescheduled` / "Rescheduled". */
  stateId?: string;
  stateTitle?: string;
}

export interface CopyOptions {
  sourceNoteId: string;
  /** Link text for the "from …" back link, e.g. "Mon 26 Oct" or "week 45". */
  sourceLabel: string;
  /** For a task that already has a back link: the label of the note it points at, to write the link again as a plain one. */
  backLinkLabel?: string;
  states: StateSymbols;
  newId?: () => string;
  /** Where the copy goes: true, the target's On deck; false, the list proper; left out, as the source sits (`toDay`). */
  onDeck?: boolean;
  /** True puts the copy in the target's Important block. */
  critical?: boolean;
  /** Whether the target is a day: only a day has On deck, so an On deck task left to its placement goes to a week's or month's list. */
  toDay?: boolean;
}

export type MarkResult = { ok: true; html: string } | { ok: false; reason: ItemProblem; scheduledTo: string[] };
export type InsertResult =
  | { ok: true; html: string; section: string | null }
  | { ok: false; reason: ItemProblem; scheduledTo: string[] };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_STATE_ID = '_rescheduled';
const DEFAULT_STATE_TITLE = 'Rescheduled';

/** "2026-10-27" → "Tue 27 Oct", as the step data labels a day. */
export function dayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]?.slice(0, 3)}`;
}

/**
 * The short link text for a day, ISO week or month note: "Tue 27 Oct", "week 45",
 * "November". A month in a year other than `inYear` carries it ("January 2027").
 * Anything else comes back as given.
 */
export function periodLabel(key: string, inYear?: number): string {
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `week ${Number(week[2])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month && MONTHS[Number(month[2]) - 1]) {
    const name = MONTHS[Number(month[2]) - 1]!;
    return inYear === undefined || Number(month[1]) === inYear ? name : `${name} ${month[1]}`;
  }
  return dayLabel(key);
}

/**
 * Note ids the internal links after the item's last "scheduled" point at. Reads the plain links
 * written now, the reference links written before, and both as CKEditor saves them.
 */
function scheduledTo(li: HTMLElement): string[] {
  const inner = descriptionOf(li)?.innerHTML ?? '';
  const at = inner.lastIndexOf('scheduled');
  if (at < 0) return [];
  return parse(inner.slice(at))
    .querySelectorAll('a')
    .map((a) => /^#root\/([^/?#]+)$/.exec(a.getAttribute('href') ?? '')?.[1])
    .filter((x): x is string => !!x);
}

/**
 * A plain internal link. CKEditor keeps its text and any italic around it, where a `reference-link`
 * becomes an inline widget that it saves with the target note's title instead.
 */
const noteLink = (noteId: string, label: string) => `<a href="#root/${noteId}">${label}</a>`;

/** Check the lookup shared by both transforms; returns the item or why it can't move. */
function lookup(
  root: HTMLElement,
  id: string,
  states: StateSymbols,
  stateId: string,
): { li: HTMLElement } | { reason: ItemProblem; scheduledTo: string[] } {
  const li = findItem(root, id);
  if (!li) return { reason: 'not_found', scheduledTo: [] };
  if (inProseSection(root, li)) return { reason: 'not_live', scheduledTo: [] };
  if (li.getAttribute('data-trilium-task-state') === stateId) return { reason: 'already_moved', scheduledTo: scheduledTo(li) };
  if (!isLive(li, states)) return { reason: 'not_live', scheduledTo: [] };
  return { li };
}

/** The section an item is shown in: Important for the Important block, else its heading. */
function sectionLabel(root: HTMLElement, li: HTMLElement): string | null {
  return inCriticalAside(li) ? 'Important' : sectionOf(root, li);
}

/** What a caller needs to know about an item without changing anything. */
export function inspectItem(
  html: string,
  id: string,
  states: StateSymbols,
  stateId = DEFAULT_STATE_ID,
): { ok: true; text: string; section: string | null } | { ok: false; reason: ItemProblem; scheduledTo: string[] } {
  const root = parse(html, { comment: true });
  const found = lookup(root, id, states, stateId);
  if (!('li' in found)) return { ok: false, ...found };
  return { ok: true, text: descriptionOf(found.li)?.text.trim() ?? '', section: sectionLabel(root, found.li) };
}

/**
 * Mark an item (and its still-live sub-items) Rescheduled: state attribute,
 * title, checked box, plus a trailing italic "scheduled Tue 27 Oct" note whose
 * link points at the target note.
 */
export function markRescheduled(html: string, id: string, opts: MarkOptions): MarkResult {
  const stateId = opts.stateId ?? DEFAULT_STATE_ID;
  const root = parse(html, { comment: true });
  const found = lookup(root, id, opts.states, stateId);
  if (!('li' in found)) return { ok: false, ...found };
  const { li } = found;
  const state = { id: stateId, title: opts.stateTitle ?? DEFAULT_STATE_TITLE };

  const edits: Edit[] = [];
  for (const item of [li, ...liveDescendants(li, opts.states)]) {
    edits.push(rewriteOpenTag(html, item, { state }));
    const box = checkboxEdit(html, item, true);
    if (box) edits.push(box);
  }
  const span = descriptionOf(li);
  if (span) {
    edits.push({
      start: spanEnd(html, span),
      end: spanEnd(html, span),
      text: ` <em>scheduled ${noteLink(opts.targetNoteId, opts.targetLabel)}</em>`,
    });
  }
  return { ok: true, html: apply(html, edits) };
}

/** The item's HTML as a fresh open copy: new ids, no state, only open sub-items, "from …" link. */
function buildCopy(sourceHtml: string, li: HTMLElement, opts: CopyOptions): string {
  const states = opts.states;
  const snippet = withoutOwnMarks(sourceHtml.slice(li.range[0], li.range[1]));
  const copyRoot = parse(snippet, { comment: true });
  const top = elements(copyRoot)[0]!;
  const newId = opts.newId ?? newListItemId;
  const edits: Edit[] = [];

  const reset = (item: HTMLElement) => {
    // A task that was Doing stays Doing in the copy; any other state resets to open.
    const keepDoing = item.getAttribute('data-trilium-task-state') !== undefined && states.get(item.getAttribute('data-trilium-task-state')!) === '/';
    edits.push(rewriteOpenTag(snippet, item, keepDoing ? { id: newId() } : { id: newId(), state: null }));
    const box = checkboxEdit(snippet, item, false);
    if (box) edits.push(box);
    for (const list of elements(item).filter(isTodoList)) {
      const children = elements(list).filter((c) => c.tagName === 'LI');
      const kept = children.filter((c) => isLive(c, opts.states));
      if (!kept.length) {
        edits.push({ start: list.range[0], end: list.range[1], text: '' });
        continue;
      }
      for (const c of children) {
        if (kept.includes(c)) reset(c);
        else edits.push({ start: c.range[0], end: c.range[1], text: '' });
      }
    }
  };
  reset(top);

  const span = descriptionOf(top);
  // A task forwarded again keeps the link to where it started, so the links don't chain. It is
  // written again as a plain link with today's label: CKEditor shows a `reference-link` as the
  // note's title ("26 - Monday").
  const back = span && backLinkOf(span);
  if (back) {
    const label = opts.backLinkLabel ?? back.text.trim().replace(/^from\s+/, '');
    edits.push({ start: back.range[0], end: back.range[1], text: noteLink(back.getAttribute('href')?.slice('#root/'.length) ?? '', `from ${escapeHtml(label)}`) });
  } else if (span) {
    // Before the trailing tokens (~30m, !, *date), so the parser still reads them.
    const at = spanEnd(snippet, span) - span.innerHTML.length + tokenZoneStartInHtml(span.innerHTML);
    edits.push({ start: at, end: at, text: ` ${noteLink(opts.sourceNoteId, `from ${opts.sourceLabel}`)}` });
  }
  return apply(snippet, edits);
}

/**
 * Copy an item from the source note's HTML into the target note's HTML: into the target's On deck
 * when `onDeck` says so (or, left out, when it comes from On deck and goes to a day), else under
 * the heading with the same name if the target has one, else the target's first
 * task list, else a new "☑️ Tasks" list at the end.
 */
export function insertCopy(targetHtml: string, sourceHtml: string, id: string, opts: CopyOptions & { stateId?: string }): InsertResult {
  const sourceRoot = parse(sourceHtml, { comment: true });
  const found = lookup(sourceRoot, id, opts.states, opts.stateId ?? DEFAULT_STATE_ID);
  if (!('li' in found)) return { ok: false, ...found };
  const section = sectionLabel(sourceRoot, found.li);
  const item = buildCopy(sourceHtml, found.li, opts);
  const important = inCriticalAside(found.li);
  const fromDeck = section !== null && isOnDeckName(section) && !important;
  const deck = opts.critical ? false : (opts.onDeck ?? (fromDeck && opts.toDay === true));
  const placed = deck
    ? placeForwarded(targetHtml, item, ON_DECK)
    : placeForwarded(targetHtml, item, fromDeck ? null : section, important || !!opts.critical);
  return { ok: true, html: placed, section };
}

/**
 * True when the target already holds a copy made from this source note (a half-finished forward):
 * the source's text with a back link to the source, or, for a task that already carries a back
 * link, the same text apart from that link, which the copy writes again.
 */
export function hasCopy(targetHtml: string, sourceHtml: string, id: string, sourceNoteId: string): boolean {
  const source = findItem(parse(sourceHtml, { comment: true }), id);
  const sourceSpan = source && descriptionOf(source);
  if (!sourceSpan) return false;
  const body = withoutMarks(sourceSpan.innerHTML);
  const origin = backLinkOf(sourceSpan)?.getAttribute('href');
  if (origin) {
    // The copy's back link is written again (`buildCopy`), so the rest of the text is compared,
    // and where the link points: a recurring task from another day is not this one's copy.
    return parse(targetHtml, { comment: true })
      .querySelectorAll('li')
      .some((li) => {
        const span = descriptionOf(li);
        return !!span && backLinkOf(span)?.getAttribute('href') === origin && withoutBackLink(span.innerHTML) === withoutBackLink(body);
      });
  }
  // A space or &nbsp;, then a link to the source note with any text: the copy's back link as
  // written, or as CKEditor saved it.
  const link = new RegExp(`(?:\\s|&nbsp;)<a [^>]*href="#root/${sourceNoteId}"[^>]*>[^<]*</a>`);
  return parse(targetHtml, { comment: true })
    .querySelectorAll('li')
    .some((li) => {
      const inner = descriptionOf(li)?.innerHTML;
      return inner !== undefined && link.test(inner) && inner.replace(link, '') === body;
    });
}

/** `html` without the "scheduled" marks of any item's description, and the space before each. */
function withoutOwnMarks(html: string): string {
  const marks = parse(html, { comment: true })
    .querySelectorAll('li')
    .flatMap((item) => {
      const span = descriptionOf(item);
      return span ? scheduledMarksOf(span) : [];
    });
  return withoutMarkRanges(html, marks);
}

/** A description's inner HTML without its "scheduled" marks, and the space before each. */
function withoutMarks(inner: string): string {
  return withoutMarkRanges(inner, scheduledMarksOf(parse(inner)));
}

/** `html` with each mark cut out, with the spaces or `&nbsp;` before it; `marks` are offsets into `html`. */
function withoutMarkRanges(html: string, marks: ScheduledMark[]): string {
  const edits: Edit[] = marks.map((mark) => ({
    start: mark.start - (/(?:\s|&nbsp;)*$/.exec(html.slice(0, mark.start))?.[0].length ?? 0),
    end: mark.end,
    text: '',
  }));
  return apply(html, edits);
}

/** Whether a task's text holds a "from …" link to the note it was forwarded from. */
function hasBackLink(span: HTMLElement): boolean {
  return !!backLinkOf(span);
}

/** A task's "from …" link to the note it was forwarded from. */
export function backLinkOf(span: HTMLElement): HTMLElement | undefined {
  return span.querySelectorAll('a').find((a) => /^#root\/[^/?#]+$/.test(a.getAttribute('href') ?? '') && /^from\s/.test(a.text.trim()));
}

/** A "scheduled" mark in a task's text: the italic word and the link to the note the task moved to. */
export interface ScheduledMark {
  /** The nodes that make up the mark, in order: one `em` as written, else the `em`, any space between and the `a`. */
  nodes: Node[];
  /** Offset of the first node's start in the HTML that was parsed. */
  start: number;
  /** Offset of the last node's end in the HTML that was parsed. */
  end: number;
  /** True when the mark is already in the shape `markRescheduled` writes: `<em>scheduled <a>…</a></em>`. */
  written: boolean;
  noteId: string;
  /** The text inside the link. */
  label: string;
}

const MARK_WORD = /^[\s\u00a0]*(?:re)?scheduled\b/;
const MARK_WORD_ONLY = /^[\s\u00a0]*(?:re)?scheduled[\s\u00a0]*$/;
const NOTE_HREF = /^#root\/([^/?#]+)$/;

/**
 * The "scheduled" marks in a task's text, as written (`<em>scheduled <a href="#root/…">…</a></em>`)
 * and as the editor or a Markdown round trip saves them (`<em>scheduled</em>`, a space or `&nbsp;`,
 * then the link). An italic word with no link after it, with other words before the link, or
 * before the "from …" back link (`backLinkOf`) is not a mark.
 */
export function scheduledMarksOf(span: HTMLElement): ScheduledMark[] {
  const marks: ScheduledMark[] = [];
  for (const em of span.querySelectorAll('em')) {
    const link = em.querySelector('a[href^="#root/"]');
    const found = link ? (writtenMark(em, link) ? { nodes: [em], link, written: true } : undefined) : savedMark(em);
    const noteId = found && NOTE_HREF.exec(found.link.getAttribute('href') ?? '')?.[1];
    if (!found || !noteId || !MARK_WORD.test(em.text) || /^from\s/.test(found.link.text.trim())) continue;
    const first = found.nodes[0];
    const last = found.nodes[found.nodes.length - 1];
    if (!first || !last) continue;
    marks.push({ nodes: found.nodes, start: first.range[0], end: last.range[1], written: found.written, noteId, label: found.link.text.trim() });
  }
  return marks;
}

/** Whether an `em` holds only the word, then the link, then at most whitespace. */
function writtenMark(em: HTMLElement, link: HTMLElement): boolean {
  const text = em.text;
  const at = text.indexOf(link.text);
  return at >= 0 && MARK_WORD_ONLY.test(text.slice(0, at)) && !text.slice(at + link.text.length).trim();
}

/** An `em` that holds only the word, with the link that follows it past any space. */
function savedMark(em: HTMLElement): { nodes: Node[]; link: HTMLElement; written: false } | undefined {
  if (!MARK_WORD_ONLY.test(em.text)) return undefined;
  const siblings = em.parentNode?.childNodes ?? [];
  const after = siblings.slice(siblings.indexOf(em) + 1);
  const nodes: Node[] = [em];
  let next = after[0];
  if (next instanceof TextNode) {
    if (next.rawText.replace(/&nbsp;/g, '').trim()) return undefined;
    nodes.push(next);
    next = after[1];
  }
  if (!(next instanceof HTMLElement) || next.tagName !== 'A') return undefined;
  nodes.push(next);
  return { nodes, link: next, written: false };
}

/** The note id a task's "from …" link points at, or null; `html` is the note, `id` the task's list item id. */
export function backLinkTarget(html: string, id: string): string | null {
  const li = findItem(parse(html, { comment: true }), id);
  const span = li && descriptionOf(li);
  return (span && backLinkOf(span)?.getAttribute('href')?.slice('#root/'.length)) || null;
}

/** `inner` without its "from …" back link, as written or as CKEditor saved it. */
export const withoutBackLink = (inner: string) => inner.replace(/(?:\s|&nbsp;)*<a [^>]*href="#root\/[^"]*"[^>]*>from [^<]*<\/a>/, '').replace(/&nbsp;/g, ' ');
