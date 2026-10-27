// Shared pieces of the HTML transforms (forward, add, accept, dismiss, done,
// start, drop). Day notes are CKEditor HTML: node-html-parser finds elements and
// their source ranges, and every change is spliced into the original string, so
// markup we don't touch stays byte-for-byte as Trilium stored it.

import { randomBytes } from 'node:crypto';
import { HTMLElement, parse } from 'node-html-parser';
import { scanTokens } from '../core/index.js';
import type { StateSymbols } from './markdown.js';
import { ProseTracker } from './sections.js';

export function newListItemId(): string {
  return `e${randomBytes(16).toString('hex')}`;
}

/**
 * Give every `<li>` of a `<ul>` or `<ol>` that has no `data-list-item-id` a new one, placed first
 * on the tag as CKEditor writes it. CKEditor invents a random id for such an item on every load,
 * so Caius stores one instead. The rest of the string is left byte for byte.
 */
export function ensureListItemIds(html: string, newId: () => string = newListItemId): string {
  const missing = itemsWithoutIds(parse(html, { comment: true }));
  if (!missing.length) return html;
  return apply(
    html,
    missing.map((li) => {
      const start = li.range[0];
      const end = html.indexOf('>', start + 3 + li.rawAttrs.length) + 1;
      const rest = html.slice(start + 3, end).replace(attrRe('data-list-item-id'), '');
      return { start, end, text: `${html.slice(start, start + 3)} data-list-item-id="${newId()}"${rest}` };
    }),
  );
}

/** The own text of each list item `ensureListItemIds` would give an id, in document order. */
export function listItemsWithoutIds(html: string): string[] {
  return itemsWithoutIds(parse(html, { comment: true })).map((li) => {
    const own = descriptionOf(li)?.text ?? li.childNodes.filter((n) => !(n instanceof HTMLElement && /^(UL|OL)$/.test(n.tagName))).map((n) => n.text).join('');
    return own.replace(/\s+/g, ' ').trim();
  });
}

/** List items without a `data-list-item-id`. An empty one counts as missing, as it does for CKEditor. */
function itemsWithoutIds(root: HTMLElement): HTMLElement[] {
  return root.querySelectorAll('li').filter((li) => {
    const parent = li.parentNode;
    return parent instanceof HTMLElement && (parent.tagName === 'UL' || parent.tagName === 'OL') && !li.getAttribute('data-list-item-id');
  });
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function apply(html: string, edits: Edit[]): string {
  let out = html;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export const elements = (el: HTMLElement): HTMLElement[] => el.childNodes.filter((n): n is HTMLElement => n instanceof HTMLElement);
export const isHeading = (el: HTMLElement) => /^H[1-6]$/.test(el.tagName);
export const isTodoList = (el: HTMLElement) => el.tagName === 'UL' && el.classList.contains('todo-list');
export const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function findItem(root: HTMLElement, id: string): HTMLElement | undefined {
  return root.querySelectorAll('li').find((li) => li.getAttribute('data-list-item-id') === id);
}

export function ownLabel(li: HTMLElement): HTMLElement | undefined {
  return elements(li).find((c) => c.tagName === 'LABEL');
}

export function descriptionOf(li: HTMLElement): HTMLElement | undefined {
  return ownLabel(li)?.querySelector('span.todo-list__label__description') ?? undefined;
}

export function isTask(li: HTMLElement): boolean {
  const parent = li.parentNode;
  return parent instanceof HTMLElement && isTodoList(parent) && !!ownLabel(li)?.querySelector('input[type=checkbox]');
}

/** Open or in progress: no state and unchecked, or a state whose symbol is ` ` or `/`. */
export function isLive(li: HTMLElement, states: StateSymbols): boolean {
  if (!isTask(li)) return false;
  const state = li.getAttribute('data-trilium-task-state');
  if (state) {
    const symbol = states.get(state);
    return symbol === ' ' || symbol === '/';
  }
  return !ownLabel(li)!.querySelector('input[type=checkbox]')!.hasAttribute('checked');
}


/** The heading text above the item's top-level block, or null before any heading. */
export function sectionOf(root: HTMLElement, li: HTMLElement): string | null {
  let top: HTMLElement = li;
  while (top.parentNode && top.parentNode !== root) top = top.parentNode as HTMLElement;
  const siblings = elements(root);
  for (let i = siblings.indexOf(top) - 1; i >= 0; i--) {
    if (isHeading(siblings[i]!)) return siblings[i]!.text.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** Whether the item sits under a Meetings or Context heading (down to the next of that level or higher). */
export function inProseSection(root: HTMLElement, li: HTMLElement): boolean {
  let top: HTMLElement = li;
  while (top.parentNode && top.parentNode !== root) top = top.parentNode as HTMLElement;
  const tracker = new ProseTracker();
  for (const el of elements(root)) {
    if (el === top) break;
    if (isHeading(el)) tracker.enter(el.text, Number(el.tagName[1]));
  }
  return tracker.kind !== null && !isCriticalAside(top);
}

export const attrRe = (name: string) => new RegExp(`\\s+${name}(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=[\\s>/])`);

/** Rewrite an `<li …>` open tag: optionally a new id, and the state/title attributes. */
export function rewriteOpenTag(
  html: string,
  li: HTMLElement,
  change: { id?: string; state?: { id: string; title: string } | null },
): Edit {
  const start = li.range[0];
  const end = html.indexOf('>', start + 3 + li.rawAttrs.length) + 1;
  let tag = html.slice(start, end);
  if (change.state !== undefined) tag = tag.replace(attrRe('data-trilium-task-state'), '').replace(attrRe('title'), '');
  const extra = change.state ? ` data-trilium-task-state="${change.state.id}" title="${change.state.title}"` : '';
  tag = tag.replace(attrRe('data-list-item-id'), (m) => (change.id ? ` data-list-item-id="${change.id}"` : m) + extra);
  return { start, end, text: tag };
}

/** Set (or clear) the checked attribute on the item's own checkbox. */
export function checkboxEdit(html: string, li: HTMLElement, checked: boolean): Edit | null {
  const input = ownLabel(li)?.querySelector('input[type=checkbox]');
  if (!input) return null;
  const [start, end] = input.range;
  const tag = html.slice(start, end);
  const has = /\schecked(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>/])/.test(tag);
  if (checked === has) return null;
  const text = checked
    ? tag.replace(/(type=(?:"checkbox"|'checkbox'|checkbox))/, '$1 checked="checked"')
    : tag.replace(/\schecked(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>/])/, '');
  return { start, end, text };
}

export function spanEnd(html: string, span: HTMLElement): number {
  const at = span.range[1] - '</span>'.length;
  if (html.slice(at, span.range[1]) !== '</span>') throw new Error('unexpected markup after task text');
  return at;
}


export function liveDescendants(li: HTMLElement, states: StateSymbols): HTMLElement[] {
  return li.querySelectorAll('li').filter((d) => d !== li && isLive(d, states));
}

/** `<aside class="admonition important">`: the critical block. */
/** Whether the item is inside the Important block. */
export function inCriticalAside(li: HTMLElement): boolean {
  for (let n = li.parentNode as HTMLElement | null; n; n = n.parentNode as HTMLElement | null) {
    if (n.tagName && isCriticalAside(n)) return true;
  }
  return false;
}

/** The include-note section a day note starts with. */
export function isIncludeNote(el: HTMLElement): boolean {
  return el.tagName === 'SECTION' && el.classList.contains('include-note');
}

export function isCriticalAside(el: HTMLElement): boolean {
  return el.tagName === 'ASIDE' && el.classList.contains('admonition') && el.classList.contains('important');
}

/** The template's untouched list: a plain `<ul>` whose only item is `[…]`. */
export function isPlaceholder(el: HTMLElement): boolean {
  if (el.tagName !== 'UL' || isTodoList(el)) return false;
  const items = elements(el).filter((c) => c.tagName === 'LI');
  return items.length === 1 && elements(el).length === 1 && /^\[(…|\.{3})\]$/.test(items[0]!.text.trim());
}

export type ItemState = 'open' | 'doing' | 'done' | 'cancelled' | 'rescheduled' | 'other';

/** The task's state from its state attribute (via the live symbols) or its checkbox. */
export function itemState(li: HTMLElement, states: StateSymbols): ItemState {
  const attr = li.getAttribute('data-trilium-task-state');
  if (attr) {
    const symbol = states.get(attr);
    return symbol === ' ' ? 'open' : symbol === '/' ? 'doing' : symbol === '-' ? 'cancelled' : symbol === '>' ? 'rescheduled' : symbol === 'x' ? 'done' : 'other';
  }
  return ownLabel(li)?.querySelector('input[type=checkbox]')?.hasAttribute('checked') ? 'done' : 'open';
}

/**
 * Where the trailing-token zone (`~30m`, `!!`, `*2026-10-27`, …) starts in a
 * plain string, found with the same right-to-left scan the parser uses. Anything
 * appended to the task should go here, so the tokens stay trailing.
 */
export function tokenZoneStart(text: string): number {
  return scanTokens(`X${text}`).text.length - 1;
}

/** The same boundary inside a description's inner HTML: tokens live in the text after the last tag. */
export function tokenZoneStartInHtml(innerHtml: string): number {
  const tail = innerHtml.lastIndexOf('>') + 1;
  const decoded = innerHtml.slice(tail).replace(/&amp;/g, '&');
  const rest = decoded.slice(0, tokenZoneStart(decoded));
  return tail + rest.length + (rest.split('&').length - 1) * 4;
}
