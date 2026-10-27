// HTML transforms for the planning writes: place a task (under a header, in the
// critical block or under Suggested), move or remove a Suggested item, and set a
// task's state. Same rules as forward-html: node-html-parser finds positions,
// edits are spliced into the original string, everything else stays as stored.

import { parse, HTMLElement } from 'node-html-parser';
import type { StateSymbols } from './markdown.js';
import { isSuggestedName, normName, ProseTracker } from './sections.js';
import {
  apply,
  checkboxEdit,
  descriptionOf,
  elements,
  findItem,
  isCriticalAside,
  inProseSection,
  isHeading,
  isPlaceholder,
  isTask,
  isTodoList,
  itemState,
  liveDescendants,
  norm,
  rewriteOpenTag,
  sectionOf,
  spanEnd,
  type Edit,
  type ItemState,
} from './html-util.js';

export type Target = { kind: 'section'; name: string } | { kind: 'critical' } | { kind: 'suggested' };

const NEW_TASKS_SECTION = '<h2>☑️ Tasks</h2>';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A fresh open task item. `description` is trusted HTML (escape the text first). */
export function itemMarkup(id: string, description: string): string {
  return (
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">` +
    `<span class="todo-list__label__description">${description}</span></label></li>`
  );
}

const newList = (item: string) => `<ul class="todo-list">${item}</ul>`;
const levelOf = (h: HTMLElement) => Number(h.tagName[1]);
const insertAt = (at: number, text: string): Edit => ({ start: at, end: at, text });

/** The first task list (or the untouched placeholder) between a heading and the next one. */
function scanSection(top: HTMLElement[], headingIdx: number): { list?: HTMLElement; placeholder?: HTMLElement } {
  for (let j = headingIdx + 1; j < top.length && !isHeading(top[j]!); j++) {
    if (isTodoList(top[j]!)) return { list: top[j]! };
    if (isPlaceholder(top[j]!)) return { placeholder: top[j]! };
  }
  return {};
}

/** Add `item` to a list: at the end, or before the item at 1-based `position`. */
function insertInList(html: string, list: HTMLElement, item: string, position?: number): Edit {
  const items = elements(list).filter((c) => c.tagName === 'LI');
  const before = position !== undefined && position >= 1 ? items[position - 1] : undefined;
  if (before) return insertAt(before.range[0], item);
  const at = list.range[1] - '</ul>'.length;
  if (html.slice(at, list.range[1]) !== '</ul>') throw new Error('unexpected markup after task list');
  return insertAt(at, item);
}

/** True when the note has a task outside Suggested, so an untouched template can be told apart. */
function hasRealTasks(root: HTMLElement): boolean {
  return root.querySelectorAll('li').some((li) => isTask(li) && !isSuggestedName(sectionOf(root, li)) && !inProseSection(root, li));
}

/** Level for a header Caius creates: one below the template's lone title, else the level in use. */
function newHeaderLevel(top: HTMLElement[]): number {
  const heads = top.filter((e) => isHeading(e) && !isSuggestedName(e.text));
  if (!heads.length) return 2;
  if (heads.length === 1) return normName(heads[0]!.text) === 'tasks' ? Math.min(levelOf(heads[0]!) + 1, 6) : levelOf(heads[0]!);
  return Math.max(...heads.map(levelOf));
}

/**
 * Put a ready-made `<li>` into the note. Section: the list under the matching
 * header (created, above Suggested, if missing). Critical: the Important block
 * (created at the top if missing). Suggested: its list, with the section kept
 * last. An untouched template's `[…]` placeholder is replaced by the first
 * real task, but left alone when only Suggested is being filled.
 */
export function placeTask(html: string, item: string, target: Target, position?: number): string {
  const root = parse(html, { comment: true });
  const top = elements(root);
  const edits: Edit[] = [];
  const suggestedIdx = top.findIndex((e) => isHeading(e) && isSuggestedName(e.text));
  const placeholder = top.find(isPlaceholder);
  let replaced: HTMLElement | undefined;

  const intoHeading = (i: number) => {
    const found = scanSection(top, i);
    if (found.list) edits.push(insertInList(html, found.list, item, position));
    else if (found.placeholder) {
      edits.push({ start: found.placeholder.range[0], end: found.placeholder.range[1], text: newList(item) });
      replaced = found.placeholder;
    } else edits.push(insertAt(top[i]!.range[1], newList(item)));
  };

  if (target.kind === 'section' && isSuggestedName(target.name)) target = { kind: 'suggested' };

  if (target.kind === 'critical') {
    const aside = top.find(isCriticalAside);
    const list = aside && elements(aside).find(isTodoList);
    if (aside && list) edits.push(insertInList(html, list, item, position));
    else if (aside) edits.push(insertAt(aside.range[1] - '</aside>'.length, newList(item)));
    else edits.push(insertAt(0, `<aside class="admonition important">${newList(item)}</aside>`));
  } else if (target.kind === 'suggested') {
    if (suggestedIdx >= 0) intoHeading(suggestedIdx);
    else {
      const level = top.filter(isHeading).reduce((m, h) => Math.min(m, levelOf(h)), 2);
      edits.push(insertAt(html.length, `<h${level}>Suggested</h${level}>${newList(item)}`));
    }
  } else {
    const i = top.findIndex((e) => isHeading(e) && normName(e.text) === normName(target.name));
    if (i >= 0) intoHeading(i);
    else {
      const level = newHeaderLevel(top);
      const at = suggestedIdx >= 0 ? top[suggestedIdx]!.range[0] : html.length;
      edits.push(insertAt(at, `<h${level}>${escapeHtml(target.name.trim())}</h${level}>${newList(item)}`));
    }
  }

  if (target.kind !== 'suggested' && placeholder && placeholder !== replaced && !hasRealTasks(root)) {
    edits.push({ start: placeholder.range[0], end: placeholder.range[1], text: '' });
  }
  return apply(html, edits);
}

/**
 * Where `forward` puts a copy: the list under the header with the same name,
 * else the first task list outside the critical block, Suggested, Meetings and Context, else a new
 * "Tasks" list (above Suggested). An untouched template's placeholder is
 * replaced rather than left above the new list.
 */
export function placeForwarded(html: string, item: string, section: string | null): string {
  const root = parse(html, { comment: true });
  const top = elements(root);
  const intoFound = (found: { list?: HTMLElement; placeholder?: HTMLElement }, headingEnd: number): string => {
    if (found.list) return apply(html, [insertInList(html, found.list, item)]);
    if (found.placeholder) return apply(html, [{ start: found.placeholder.range[0], end: found.placeholder.range[1], text: newList(item) }]);
    return apply(html, [insertAt(headingEnd, newList(item))]);
  };

  if (section) {
    const i = top.findIndex((e) => isHeading(e) && norm(e.text) === norm(section) && !isSuggestedName(e.text));
    if (i >= 0) return intoFound(scanSection(top, i), top[i]!.range[1]);
  }

  let inSuggested = false;
  const tracker = new ProseTracker();
  for (const el of top) {
    if (isHeading(el)) {
      inSuggested = isSuggestedName(el.text);
      tracker.enter(el.text, levelOf(el));
    } else if (tracker.kind) continue;
    else if (!inSuggested && isTodoList(el)) return apply(html, [insertInList(html, el, item)]);
    else if (!inSuggested && isPlaceholder(el)) return apply(html, [{ start: el.range[0], end: el.range[1], text: newList(item) }]);
  }
  const suggested = top.find((e) => isHeading(e) && isSuggestedName(e.text));
  const block = NEW_TASKS_SECTION + newList(item);
  return suggested ? apply(html, [insertAt(suggested.range[0], block)]) : html + block;
}

export type TakeProblem = 'not_found' | 'not_live' | 'not_suggested';

/** A task item under the Suggested heading: its markup, text and links. */
export interface SuggestedItem {
  markup: string;
  text: string;
  hrefs: string[];
}

function suggestedLi(root: HTMLElement, id: string): { li: HTMLElement } | { reason: TakeProblem } {
  const li = findItem(root, id);
  if (!li || !isTask(li)) return { reason: 'not_found' };
  if (inProseSection(root, li)) return { reason: 'not_live' };
  const nested = li.parentNode?.parentNode;
  if (nested instanceof HTMLElement && nested.tagName === 'LI') return { reason: 'not_suggested' };
  if (!isSuggestedName(sectionOf(root, li))) return { reason: 'not_suggested' };
  return { li };
}

function itemFacts(html: string, li: HTMLElement): SuggestedItem {
  const span = descriptionOf(li);
  return {
    markup: html.slice(li.range[0], li.range[1]),
    text: span?.text.replace(/\s+/g, ' ').trim() ?? '',
    hrefs: span?.querySelectorAll('a').map((a) => a.getAttribute('href') ?? '').filter((h) => h && !h.startsWith('#')) ?? [],
  };
}

export function inspectSuggested(html: string, id: string): ({ ok: true } & SuggestedItem) | { ok: false; reason: TakeProblem } {
  const root = parse(html, { comment: true });
  const found = suggestedLi(root, id);
  if (!('li' in found)) return { ok: false, reason: found.reason };
  return { ok: true, ...itemFacts(html, found.li) };
}

/** Remove a Suggested item (and its list, if it was the last one). */
export function takeSuggested(html: string, id: string): ({ ok: true; html: string } & SuggestedItem) | { ok: false; reason: TakeProblem } {
  const root = parse(html, { comment: true });
  const found = suggestedLi(root, id);
  if (!('li' in found)) return { ok: false, reason: found.reason };
  const { li } = found;
  const list = li.parentNode as HTMLElement;
  const only = elements(list).filter((c) => c.tagName === 'LI').length === 1;
  const [start, end] = only ? list.range : li.range;
  return { ok: true, html: apply(html, [{ start, end, text: '' }]), ...itemFacts(html, li) };
}

export type StateAction = 'done' | 'start' | 'drop';
export type StateProblem = 'not_found' | 'not_live' | 'already_done' | 'already_doing' | 'already_cancelled';

export interface StateOptions {
  states: StateSymbols;
  /** State ids for Doing and Cancelled; Shawn's are `doing` and `cancelled`. */
  doingId?: string;
  cancelledId?: string;
  /** Required for `drop`: written as a trailing italic. */
  reason?: string;
}

/**
 * Done: checked, no state attribute. Start (Doing): state `doing`, title "Doing".
 * Drop (Cancelled): state `cancelled`, box checked, the reason as a trailing
 * italic; still-live sub-items are cancelled with it.
 */
export function setTaskState(
  html: string,
  id: string,
  action: StateAction,
  opts: StateOptions,
): { ok: true; html: string; from: ItemState } | { ok: false; reason: StateProblem; from?: ItemState } {
  const root = parse(html, { comment: true });
  const li = findItem(root, id);
  if (!li || !isTask(li)) return { ok: false, reason: 'not_found' };
  if (inProseSection(root, li)) return { ok: false, reason: 'not_live' };
  const from = itemState(li, opts.states);
  const same = { done: 'done', start: 'doing', drop: 'cancelled' }[action] as ItemState;
  if (from === same) return { ok: false, reason: `already_${same}` as StateProblem, from };
  if (from !== 'open' && from !== 'doing') return { ok: false, reason: 'not_live', from };
  if (action === 'start' && from !== 'open') return { ok: false, reason: 'not_live', from };

  const doing = { id: opts.doingId ?? 'doing', title: 'Doing' };
  const cancelled = { id: opts.cancelledId ?? 'cancelled', title: 'Cancelled' };
  const edits: Edit[] = [];
  const touch = (item: HTMLElement) => {
    const hasState = item.getAttribute('data-trilium-task-state') !== undefined;
    if (action === 'done') {
      if (hasState) edits.push(rewriteOpenTag(html, item, { state: null }));
      const box = checkboxEdit(html, item, true);
      if (box) edits.push(box);
    } else if (action === 'start') {
      edits.push(rewriteOpenTag(html, item, { state: doing }));
    } else {
      edits.push(rewriteOpenTag(html, item, { state: cancelled }));
      const box = checkboxEdit(html, item, true);
      if (box) edits.push(box);
    }
  };
  touch(li);
  if (action === 'drop') {
    for (const d of liveDescendants(li, opts.states)) touch(d);
    const span = descriptionOf(li);
    if (span) edits.push(insertAt(spanEnd(html, span), ` <em>${escapeHtml((opts.reason ?? '').trim())}</em>`));
  }
  return { ok: true, html: apply(html, edits), from };
}

/** Every task under the Suggested heading that is still open (for same-note duplicate checks). */
export function suggestedItems(html: string): SuggestedItem[] {
  const root = parse(html, { comment: true });
  return root
    .querySelectorAll('li')
    .filter((li) => isTask(li) && !li.getAttribute('data-trilium-task-state') && isSuggestedName(sectionOf(root, li)))
    .filter((li) => !ownChecked(li))
    .map((li) => itemFacts(html, li));
}

const ownChecked = (li: HTMLElement) =>
  elements(li).find((c) => c.tagName === 'LABEL')?.querySelector('input[type=checkbox]')?.hasAttribute('checked') ?? false;
