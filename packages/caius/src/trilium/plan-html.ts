// HTML transforms for the planning writes: place a task (under a header, in the
// critical block or under Suggested), move or remove a Suggested item, and set a
// task's state. Same rules as forward-html: node-html-parser finds positions,
// edits are spliced into the original string, everything else stays as stored.

import { parse, HTMLElement } from 'node-html-parser';
import type { StateSymbols } from './markdown.js';
import { isOnDeckName, isSuggestedName, normName, proseKind, ProseTracker } from './sections.js';
import {
  apply,
  checkboxEdit,
  descriptionOf,
  elements,
  findItem,
  isCriticalAside,
  inCriticalAside,
  inProseSection,
  isHeading,
  isIncludeNote,
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

export type Target = { kind: 'section'; name: string } | { kind: 'critical' } | { kind: 'suggested' } | { kind: 'onDeck' };

/** The heading On deck is written under, as Caius creates it. */
export const ON_DECK = 'On deck';

/** Whether a heading closes the note: On deck or Suggested, which new headers go above. */
const isTailName = (name: string) => isSuggestedName(name) || isOnDeckName(name);

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

/** Whether the item with this id sits inside a Meetings or Context section of `html`. */
export function inProseById(html: string, id: string): boolean {
  const root = parse(html, { comment: true });
  const li = findItem(root, id);
  return !!li && inProseSection(root, li);
}

/** True when the note has a committed task (outside Suggested and On deck), so an untouched template can be told apart. */
function hasRealTasks(root: HTMLElement): boolean {
  return root.querySelectorAll('li').some((li) => isTask(li) && !isTailName(sectionOf(root, li) ?? '') && !inProseSection(root, li));
}

/** Where a new section goes: just above On deck, else above Suggested, else at the end; null for the end. */
function tailStart(top: HTMLElement[]): HTMLElement | null {
  return top.find((e) => isHeading(e) && isOnDeckName(e.text)) ?? top.find((e) => isHeading(e) && isSuggestedName(e.text)) ?? null;
}

/** Level for a header Caius creates: one below the template's lone title, else the level in use. */
function newHeaderLevel(top: HTMLElement[]): number {
  const heads = top.filter((e) => isHeading(e) && !isTailName(e.text));
  if (!heads.length) return 2;
  if (heads.length === 1) return normName(heads[0]!.text) === 'tasks' ? Math.min(levelOf(heads[0]!) + 1, 6) : levelOf(heads[0]!);
  return Math.max(...heads.map(levelOf));
}

/** A paragraph or plain list whose only text is the template's `[…]`. */
const isFiller = (el: HTMLElement) => isPlaceholder(el) || (el.tagName === 'P' && /^\[(…|\.{3})\]$/.test(el.text.trim()));

/**
 * Where a new Important block goes: below a leading include-note and any Meetings and Context
 * blocks, just above the first other content.
 */
function importantBlockAt(top: HTMLElement[]): number {
  let at = 0;
  const tracker = new ProseTracker();
  for (const [i, el] of top.entries()) {
    if (i === 0 && isIncludeNote(el)) at = el.range[1];
    else if (isHeading(el)) {
      tracker.enter(el.text, levelOf(el));
      if (!tracker.kind) break;
      at = el.range[1];
    } else if (tracker.kind) at = el.range[1];
    else break;
  }
  return at;
}

/**
 * Put a ready-made `<li>` into the note. Section: the list under the matching
 * header (created, above On deck or Suggested, if missing). Critical: the Important block
 * (created at the top if missing). On deck: its list, the section created just above Suggested
 * (at its level) when missing. Suggested: its list, with the section kept
 * last. An untouched template's `[…]` placeholder is replaced by the first
 * real task, but left alone when only On deck or Suggested is being filled.
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
  if (target.kind === 'section' && isOnDeckName(target.name)) target = { kind: 'onDeck' };

  if (target.kind === 'critical') {
    const aside = top.find(isCriticalAside);
    const list = aside && elements(aside).find(isTodoList);
    if (aside && list) edits.push(insertInList(html, list, item, position));
    else if (aside) {
      // The template's `[…]` stands in for the first task, so it goes when that arrives.
      for (const filler of elements(aside).filter(isFiller)) edits.push({ start: filler.range[0], end: filler.range[1], text: '' });
      edits.push(insertAt(aside.range[1] - '</aside>'.length, newList(item)));
    } else edits.push(insertAt(importantBlockAt(top), `<aside class="admonition important">${newList(item)}</aside>`));
  } else if (target.kind === 'onDeck') {
    const deckIdx = top.findIndex((e) => isHeading(e) && isOnDeckName(e.text));
    if (deckIdx >= 0) intoHeading(deckIdx);
    else {
      const suggested = top[suggestedIdx];
      const level = suggested ? levelOf(suggested) : newHeaderLevel(top);
      edits.push(insertAt(suggested ? suggested.range[0] : html.length, `<h${level}>${ON_DECK}</h${level}>${newList(item)}`));
    }
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
      const at = tailStart(top)?.range[0] ?? html.length;
      edits.push(insertAt(at, `<h${level}>${escapeHtml(target.name.trim())}</h${level}>${newList(item)}`));
    }
  }

  if (target.kind !== 'suggested' && target.kind !== 'onDeck' && placeholder && placeholder !== replaced && !hasRealTasks(root)) {
    edits.push({ start: placeholder.range[0], end: placeholder.range[1], text: '' });
  }
  return apply(html, edits);
}

/**
 * Where `forward` puts a copy: an On deck item (`section` On deck) in the target's On deck; the
 * list under the header with the same name; for an Evening or
 * Recharge task, any evening heading, else a new `### <name>` above On deck or Suggested;
 * else the first task list outside the critical block, the evening, On deck, Suggested, Meetings and Context (an Important
 * item goes to the target's Important block instead), else a new
 * "Tasks" list (above the evening, On deck or Suggested). An untouched template's placeholder is
 * replaced rather than left above the new list.
 */
export function placeForwarded(html: string, item: string, section: string | null, important = false): string {
  if (section !== null && isOnDeckName(section)) return placeTask(html, item, { kind: 'onDeck' });
  if (important) return placeTask(html, item, { kind: 'critical' });
  const root = parse(html, { comment: true });
  const top = elements(root);
  const intoFound = (found: { list?: HTMLElement; placeholder?: HTMLElement }, headingEnd: number): string => {
    if (found.list) return apply(html, [insertInList(html, found.list, item)]);
    if (found.placeholder) return apply(html, [{ start: found.placeholder.range[0], end: found.placeholder.range[1], text: newList(item) }]);
    return apply(html, [insertAt(headingEnd, newList(item))]);
  };

  if (section) {
    const tracker = new ProseTracker();
    const i = top.findIndex((e) => {
      if (!isHeading(e)) return false;
      tracker.enter(e.text, levelOf(e));
      return norm(e.text) === norm(section) && !isTailName(e.text) && !tracker.kind;
    });
    if (i >= 0) return intoFound(scanSection(top, i), top[i]!.range[1]);
    // An evening task stays in the evening: under any Evening or Recharge heading, else a new one.
    if (EVENING_NAMES.has(normName(section))) {
      const evening = top.findIndex((e) => isHeading(e) && EVENING_NAMES.has(normName(e.text)));
      if (evening >= 0) return intoFound(scanSection(top, evening), top[evening]!.range[1]);
      const block = `<h3>${escapeHtml(section.trim())}</h3>${newList(item)}`;
      const tail = tailStart(top);
      return tail ? apply(html, [insertAt(tail.range[0], block)]) : html + block;
    }
  }

  // The first list of his work: not On deck, Suggested, Meetings, Context or the evening, which a
  // task of the day never falls into unasked.
  let apart = false;
  const tracker = new ProseTracker();
  for (const el of top) {
    if (isHeading(el)) {
      apart = isTailName(el.text) || EVENING_NAMES.has(normName(el.text));
      tracker.enter(el.text, levelOf(el));
    } else if (tracker.kind) continue;
    else if (!apart && isTodoList(el)) return apply(html, [insertInList(html, el, item)]);
    else if (!apart && isPlaceholder(el)) return apply(html, [{ start: el.range[0], end: el.range[1], text: newList(item) }]);
  }
  // His main Tasks heading with no list under it takes one; else a new Tasks list goes above the
  // evening, On deck and Suggested.
  const main = mainHeadingIndex(top);
  if (main >= 0) return intoFound(scanSection(top, main), top[main]!.range[1]);
  const evening = top.find((e) => isHeading(e) && EVENING_NAMES.has(normName(e.text)));
  const tail = tailStart(top);
  const at = evening && (!tail || evening.range[0] < tail.range[0]) ? evening : tail;
  const block = NEW_TASKS_SECTION + newList(item);
  return at ? apply(html, [insertAt(at.range[0], block)]) : html + block;
}

/** Headings of the evening, whose tasks aren't work, so an accepted item never lands under one unasked. */
const EVENING_NAMES = new Set(['evening', 'recharge']);

/**
 * Where an accepted item goes when no section is named: the end of his main list, the first task
 * list right under the main Tasks heading (the first `h2` that is not Suggested, Meetings, Context
 * or an evening heading), made under that heading when it has none. Without such a heading, where
 * `forward` would put it.
 */
export function placeInMainList(html: string, item: string): string {
  const root = parse(html, { comment: true });
  const top = elements(root);
  const i = mainHeadingIndex(top);
  const heading = top[i];
  if (!heading) return placeForwarded(html, item, null);
  const found = scanSection(top, i);
  if (found.list) return apply(html, [insertInList(html, found.list, item)]);
  if (found.placeholder) return apply(html, [{ start: found.placeholder.range[0], end: found.placeholder.range[1], text: newList(item) }]);
  return apply(html, [insertAt(heading.range[1], newList(item))]);
}

/** Where an item of his main list goes: first, or before or after another item of it. */
export type MainListPlace = { first: true } | { before: string } | { after: string };

/**
 * `html` with the item `id` of his main list (the list `placeInMainList` adds to) moved to `place`,
 * `unchanged` when it is there already. The item and the item it is placed by must both be in that
 * list, as top-level items.
 */
export function moveInMainList(html: string, id: string, place: MainListPlace): { ok: true; html: string; unchanged: boolean } | { ok: false; reason: 'not_in_main_list' } {
  const root = parse(html, { comment: true });
  const top = elements(root);
  const heading = mainHeadingIndex(top);
  const list = heading >= 0 ? scanSection(top, heading).list : undefined;
  const items = list ? elements(list).filter((c) => c.tagName === 'LI') : [];
  const byId = (itemId: string) => items.find((c) => c.getAttribute('data-list-item-id') === itemId);
  const li = byId(id);
  const anchor = 'first' in place ? items[0] : byId('before' in place ? place.before : place.after);
  if (!list || !li || !anchor) return { ok: false, reason: 'not_in_main_list' };
  const others = items.filter((c) => c !== li);
  const at = 'after' in place ? others.indexOf(anchor) + 1 : 'first' in place ? 0 : others.indexOf(anchor);
  if (items.indexOf(li) === at) return { ok: true, html, unchanged: true };
  const markup = html.slice(li.range[0], li.range[1]);
  const next = others[at];
  const edit = insertAt(next ? next.range[0] : (others.at(-1)?.range[1] ?? li.range[1]), markup);
  return { ok: true, html: apply(html, [{ start: li.range[0], end: li.range[1], text: '' }, edit]), unchanged: false };
}

/** The index in `top` of the main Tasks heading: the first `h2` that is not Suggested, Meetings, Context or an evening heading. */
function mainHeadingIndex(top: HTMLElement[]): number {
  return top.findIndex((e) => e.tagName === 'H2' && !isTailName(e.text) && !proseKind(e.text) && !EVENING_NAMES.has(normName(e.text)));
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

/**
 * A Suggested item's markup as a task of his list: `Get X done: because Y (~30m)` becomes `X ~30m`,
 * and an ask's `X: because Y (~15m)` becomes `X ~15m`, keeping the markup inside X, such as a key's
 * link, so the estimate is a token again. A non-breaking space reads as a space. Markup of any
 * other shape comes back unchanged.
 */
export function asListTask(markup: string): string {
  const inSpan = '(?:(?!</span>)[\\s\\S])';
  // CKEditor saves some spaces as &nbsp;, so the description is read with plain spaces.
  const description = new RegExp(`<span class="todo-list__label__description">${inSpan}*</span>`);
  const spaced = markup.replace(description, (span) => span.replace(/&nbsp;|\u00a0/g, ' '));
  const wrapped = new RegExp(`(<span class="todo-list__label__description">)Get\\s+(${inSpan}*?)\\s+done: because ${inSpan}*\\(~(\\d+)m\\)\\s*(</span>)`);
  const plain = new RegExp(`(<span class="todo-list__label__description">)(${inSpan}*?\\S): because ${inSpan}*\\(~(\\d+)m\\)\\s*(</span>)`);
  const shape = [wrapped, plain].find((pattern) => pattern.test(spaced));
  return shape
    ? spaced.replace(shape, (_, open: string, subject: string, minutes: string, close: string) => `${open}${subject} ~${minutes}m${close}`)
    : markup;
}

/** Remove a Suggested item (and its list, if it was the last one, and the heading, if nothing else is under it). */
export function takeSuggested(html: string, id: string): ({ ok: true; html: string } & SuggestedItem) | { ok: false; reason: TakeProblem } {
  const root = parse(html, { comment: true });
  const found = suggestedLi(root, id);
  if (!('li' in found)) return { ok: false, reason: found.reason };
  const { li } = found;
  const list = li.parentNode as HTMLElement;
  const only = elements(list).filter((c) => c.tagName === 'LI').length === 1;
  const heading = only ? loneHeading(html, root, list, isSuggestedName) : null;
  const [start, end] = heading ? [heading.range[0], list.range[1]] : only ? list.range : li.range;
  return { ok: true, html: apply(html, [{ start, end, text: '' }]), ...itemFacts(html, li) };
}

export type DeckProblem = 'not_found' | 'not_live' | 'not_on_deck';

/**
 * Take a top-level task off the On deck list, unchanged (its id, text, state and sub-items), to put
 * on his list: its list goes when it was the last item, and the heading when nothing else is under it.
 */
export function takeOnDeck(html: string, id: string, states: StateSymbols): { ok: true; html: string; markup: string } | { ok: false; reason: DeckProblem } {
  const root = parse(html, { comment: true });
  const li = findItem(root, id);
  if (!li || !isTask(li)) return { ok: false, reason: 'not_found' };
  const nested = li.parentNode?.parentNode;
  if (nested instanceof HTMLElement && nested.tagName === 'LI') return { ok: false, reason: 'not_on_deck' };
  if (inProseSection(root, li) || inCriticalAside(li) || !isOnDeckName(sectionOf(root, li))) return { ok: false, reason: 'not_on_deck' };
  const state = itemState(li, states);
  if (state !== 'open' && state !== 'doing') return { ok: false, reason: 'not_live' };
  const list = li.parentNode as HTMLElement;
  const only = elements(list).filter((c) => c.tagName === 'LI').length === 1;
  const heading = only ? loneHeading(html, root, list, isOnDeckName) : null;
  const [start, end] = heading ? [heading.range[0], list.range[1]] : only ? list.range : li.range;
  return { ok: true, html: apply(html, [{ start, end, text: '' }]), markup: html.slice(li.range[0], li.range[1]) };
}

/**
 * The heading (`named`: Suggested or On deck) right above `list` when the list is all its section holds: nothing but
 * spaces between them, and nothing after the list before a heading of the same level or higher.
 */
function loneHeading(html: string, root: HTMLElement, list: HTMLElement, named: (name: string) => boolean): HTMLElement | null {
  if (list.parentNode !== root) return null;
  const top = elements(root);
  const at = top.indexOf(list);
  const heading = top[at - 1];
  const next = top[at + 1];
  if (!heading || !isHeading(heading) || !named(heading.text)) return null;
  if (html.slice(heading.range[1], list.range[0]).trim()) return null;
  if (next && !(isHeading(next) && levelOf(next) <= levelOf(heading))) return null;
  if (html.slice(list.range[1], next?.range[0] ?? html.length).trim()) return null;
  return heading;
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
