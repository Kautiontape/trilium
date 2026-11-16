// HTML transforms for sub-tasks: add a new task under another, nest a task under
// another or under a new parent, and lift a sub-item back out. One level only. A
// sub-list is a `ul.todo-list` right after the parent's label, as CKEditor saves it.
// Same rules as plan-html: node-html-parser finds positions, edits are spliced into
// the original string, everything else stays as stored.

import { HTMLElement, parse } from 'node-html-parser';
import { DEFAULT_STATE_SYMBOLS, type StateSymbols } from './markdown.js';
import { isOnDeckName, isSuggestedName } from './sections.js';
import { apply, descriptionOf, elements, findItem, inCriticalAside, inProseSection, isHeading, isTask, isTodoList, itemState, sectionOf, type Edit } from './html-util.js';

export type NestProblem = 'not_found' | 'not_live' | 'too_deep' | 'bad_request';
export type NestFailure = { ok: false; reason: NestProblem; detail?: string };
export type NestResult = { ok: true; html: string; unchanged: boolean } | NestFailure;

/** `html` with `markup`, a ready `<li>`, as the last sub-item of the top-level task `parentId`, which is open, doing or done. */
export function addUnder(html: string, markup: string, parentId: string, states: StateSymbols = DEFAULT_STATE_SYMBOLS): NestResult {
  const root = parse(html, { comment: true });
  const parent = findItem(root, parentId);
  if (!parent || !isTask(parent)) return refuse('not_found', `no task ${parentId}`);
  const problem = parentProblem(root, parent, states);
  if (problem) return problem;
  return { ok: true, html: apply(html, [subItemEdit(html, parent, markup)]), unchanged: false };
}

/**
 * `html` with the live top-level task `id`, which has no sub-items, moved to the end of the
 * sub-list of the top-level task `parentId`, which is open, doing or done; `unchanged` when it is
 * a sub-item of that task already. A list the task leaves empty goes, and an On deck heading with
 * it. An Important task stays in the Important block. The item's problems are reported first.
 */
export function nestUnder(html: string, id: string, parentId: string, states: StateSymbols): NestResult {
  if (id === parentId) return refuse('bad_request', `${id} cannot go under itself`);
  const root = parse(html, { comment: true });
  const li = findItem(root, id);
  if (!li || !isTask(li)) return refuse('not_found', `no task ${id}`);
  const parent = findItem(root, parentId);
  if (!parent || !isTask(parent)) return refuse('not_found', `no task ${parentId}`);
  if (parentItem(li) === parent) return { ok: true, html, unchanged: true };
  const problem = itemProblem(root, li, states) ?? parentProblem(root, parent, states) ?? importantProblem(li, parent);
  if (problem) return problem;
  const markup = html.slice(li.range[0], li.range[1]);
  return { ok: true, html: apply(html, [...leaveEdits(html, root, [li]), subItemEdit(html, parent, markup)]), unchanged: false };
}

/**
 * `html` with a new parent, `parentMarkup` (a ready `<li>` with no sub-list), where the first of
 * `ids` stood, and the tasks `ids` under it in that order. Each task must pass `nestUnder`'s
 * checks for the item; the new parent is Important when the first task is. `unchanged` when the
 * tasks are sub-items of one task with `parentMarkup`'s words already, in that order.
 */
export function nestNew(html: string, ids: string[], parentMarkup: string, states: StateSymbols): NestResult {
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) return refuse('bad_request', `${twice} is named twice`);
  if (!/^<li[\s>]/.test(parentMarkup) || !parentMarkup.endsWith('</li>')) throw new Error('the new parent must be one <li>');
  const root = parse(html, { comment: true });
  const items: HTMLElement[] = [];
  for (const id of ids) {
    const li = findItem(root, id);
    if (!li || !isTask(li)) return refuse('not_found', `no task ${id}`);
    items.push(li);
  }
  if (nestedAlready(items, parentMarkup)) return { ok: true, html, unchanged: true };
  for (const li of items) {
    const problem = itemProblem(root, li, states);
    if (problem) return problem;
  }
  const [first, ...rest] = items;
  if (!first) return refuse('bad_request', 'give the tasks to nest');
  const outside = rest.find((li) => inCriticalAside(li) && !inCriticalAside(first));
  if (outside) return refuse('bad_request', `${idOf(outside)} is Important and ${idOf(first)} is not`);
  const sub = newList(items.map((li) => html.slice(li.range[0], li.range[1])).join(''));
  const made = parentMarkup.slice(0, -'</li>'.length) + sub + '</li>';
  return { ok: true, html: apply(html, [{ start: first.range[0], end: first.range[1], text: made }, ...leaveEdits(html, root, rest)]), unchanged: false };
}

/** `html` with the sub-item `id` moved to right after its parent, in the parent's list. A sub-list it leaves empty goes. */
export function liftOut(html: string, id: string): NestResult {
  const root = parse(html, { comment: true });
  const li = findItem(root, id);
  if (!li || !isTask(li)) return refuse('not_found', `no task ${id}`);
  const parent = parentItem(li);
  const list = li.parentNode;
  if (!parent || !list) return refuse('bad_request', `${id} is not a sub-item`);
  const problem = placeProblem(root, li);
  if (problem) return problem;
  const [start, end] = lis(list).length === 1 ? list.range : li.range;
  const markup = html.slice(li.range[0], li.range[1]);
  return { ok: true, html: apply(html, [{ start, end, text: '' }, insertAt(parent.range[1], markup)]), unchanged: false };
}

const refuse = (reason: NestProblem, detail: string): NestFailure => ({ ok: false, reason, detail });
const idOf = (li: HTMLElement) => li.getAttribute('data-list-item-id') ?? '';
const lis = (list: HTMLElement) => elements(list).filter((c) => c.tagName === 'LI');
const newList = (items: string) => `<ul class="todo-list">${items}</ul>`;
const insertAt = (at: number, text: string): Edit => ({ start: at, end: at, text });
const levelOf = (h: HTMLElement) => Number(h.tagName[1]);

/** The item `li` is a sub-item of, or null for a top-level item. */
function parentItem(li: HTMLElement): HTMLElement | null {
  const up = li.parentNode?.parentNode;
  return up instanceof HTMLElement && up.tagName === 'LI' ? up : null;
}

/** Whether `items` are sub-items of one task whose words are `parentMarkup`'s, in document order. */
function nestedAlready(items: HTMLElement[], parentMarkup: string): boolean {
  const parent = items[0] ? parentItem(items[0]) : null;
  const words = wordsOf(parse(parentMarkup).querySelector('li'));
  if (!parent || words === undefined || wordsOf(parent) !== words) return false;
  let last = -1;
  for (const li of items) {
    if (parentItem(li) !== parent || li.range[0] <= last) return false;
    last = li.range[0];
  }
  return true;
}

const wordsOf = (li: HTMLElement | null) => (li ? descriptionOf(li)?.text.replace(/\s+/g, ' ').trim() : undefined);

/** What keeps the task `li` from going under another: it must be a live top-level task with no sub-items, outside Meetings, Context and Suggested. */
function itemProblem(root: HTMLElement, li: HTMLElement, states: StateSymbols): NestFailure | null {
  const id = idOf(li);
  if (parentItem(li)) return refuse('bad_request', `${id} is a sub-item: lift it out first`);
  if (li.querySelector('li')) return refuse('too_deep', `${id} has sub-items of its own`);
  const place = placeProblem(root, li);
  if (place) return place;
  const state = itemState(li, states);
  return state === 'open' || state === 'doing' ? null : refuse('not_live', `${id} is ${state}`);
}

/**
 * What keeps the task `parent` from taking a sub-item: it must be a top-level task outside
 * Meetings, Context and Suggested, and open, doing or done.
 */
function parentProblem(root: HTMLElement, parent: HTMLElement, states: StateSymbols): NestFailure | null {
  if (parentItem(parent)) return refuse('too_deep', `${idOf(parent)} is a sub-item: one level only`);
  const place = placeProblem(root, parent);
  if (place) return place;
  const state = itemState(parent, states);
  return state === 'open' || state === 'doing' || state === 'done' ? null : refuse('not_live', `parent ${idOf(parent)} is not open, doing or done`);
}

function placeProblem(root: HTMLElement, li: HTMLElement): NestFailure | null {
  if (inProseSection(root, li)) return refuse('bad_request', `${idOf(li)} is in Meetings or Context, not a task`);
  if (isSuggestedName(sectionOf(root, li))) return refuse('bad_request', `${idOf(li)} is in Suggested: accept it first`);
  return null;
}

function importantProblem(li: HTMLElement, parent: HTMLElement): NestFailure | null {
  return inCriticalAside(li) && !inCriticalAside(parent) ? refuse('bad_request', `${idOf(li)} is Important and ${idOf(parent)} is not`) : null;
}

/** `markup` at the end of the parent's sub-list, or in a new sub-list right before the parent's `</li>`. */
function subItemEdit(html: string, parent: HTMLElement, markup: string): Edit {
  const sub = elements(parent).find(isTodoList);
  return sub ? insertAt(closeOf(html, sub, '</ul>'), markup) : insertAt(closeOf(html, parent, '</li>'), newList(markup));
}

function closeOf(html: string, el: HTMLElement, close: string): number {
  const at = el.range[1] - close.length;
  if (html.slice(at, el.range[1]) !== close) throw new Error(`unexpected markup at the end of a ${el.tagName.toLowerCase()}`);
  return at;
}

/**
 * The edits that take the top-level tasks `items` out of their lists, as `lift()` in plan-html does
 * for one: a list they leave empty goes, and an On deck heading with nothing else under it.
 */
function leaveEdits(html: string, root: HTMLElement, items: HTMLElement[]): Edit[] {
  const edits: Edit[] = [];
  for (const list of new Set(items.map((li) => li.parentNode))) {
    if (!list) continue;
    const leaving = items.filter((li) => li.parentNode === list);
    if (lis(list).every((c) => leaving.includes(c))) {
      const heading = loneDeckHeading(html, root, list);
      edits.push({ start: heading ? heading.range[0] : list.range[0], end: list.range[1], text: '' });
    } else for (const li of leaving) edits.push({ start: li.range[0], end: li.range[1], text: '' });
  }
  return edits;
}

/**
 * The On deck heading right above `list` when the list is all its section holds, as
 * `loneHeading` in plan-html finds it: nothing but spaces between them, and nothing after the
 * list before a heading of the same level or higher.
 */
function loneDeckHeading(html: string, root: HTMLElement, list: HTMLElement): HTMLElement | null {
  if (list.parentNode !== root) return null;
  const top = elements(root);
  const at = top.indexOf(list);
  const heading = top[at - 1];
  const next = top[at + 1];
  if (!heading || !isHeading(heading) || !isOnDeckName(heading.text)) return null;
  if (html.slice(heading.range[1], list.range[0]).trim()) return null;
  if (next && !(isHeading(next) && levelOf(next) <= levelOf(heading))) return null;
  if (html.slice(list.range[1], next?.range[0] ?? html.length).trim()) return null;
  return heading;
}
