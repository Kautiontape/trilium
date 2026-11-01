// Where a task came from, read from a note's HTML: the headings above the item, the item it sits
// under, the items beside it and the paragraph before its list. Pure, like forward-html.ts; the
// server reads the notes and adds the source note's title and date.

import { parse, HTMLElement } from 'node-html-parser';
import type { StateSymbols } from './markdown.js';
import { backLinkOf, withoutBackLink } from './forward-html.js';
import { descriptionOf, elements, findItem, isHeading, itemState, norm, tokenZoneStart } from './html-util.js';

/** What the source note's HTML says about a task. */
export interface OriginFields {
  /** Outermost first: [ "Work", "Open items" ]. */
  headings: string[];
  /** The parent item's words when the task was nested. */
  parent: string | null;
  /** Up to `MAX_NEIGHBOURS` sibling items' words, nearest first. */
  neighbours: string[];
  /** The paragraph just before the list, cut to about `LEAD_CHARS`. */
  lead: string | null;
  /** False: the source note was read but no item in it has the task's words (the copy was reworded). */
  matched: boolean;
}

/** Where a task came from, as `caius_explain` answers it. */
export interface TaskOrigin extends OriginFields {
  noteId: string;
  title: string;
  /** A Journal note's period label ("Fri 30 Oct"), else the day the note was made, YYYY-MM-DD. */
  date: string | null;
}

export const MAX_NEIGHBOURS = 3;
export const LEAD_CHARS = 200;

/** Caius's "scheduled Tue 27 Oct" note on a forwarded item, as written or as CKEditor saves it. */
const SCHEDULED = /(?:\s|&nbsp;)*<em>\s*(?:re)?scheduled\b[\s\S]*?<\/em>/g;

/**
 * The task's own words and the note its "from …" link points at; null when the note has no item
 * with that id.
 */
export function taskRef(html: string, id: string): { text: string; from: string | null } | null {
  const li = findItem(parse(html, { comment: true }), id);
  if (!li) return null;
  const span = descriptionOf(li);
  const from = (span && backLinkOf(span)?.getAttribute('href')?.slice('#root/'.length)) || null;
  return { text: itemText(li), from };
}

/**
 * The context of an item in a note: found by its id in its own note, or by its words in the note
 * it was copied from. Of two items with the same words, the one marked rescheduled is the original.
 */
export function originIn(html: string, task: { id: string } | { text: string }, states: StateSymbols): OriginFields {
  const root = parse(html, { comment: true });
  const li = 'id' in task ? findItem(root, task.id) : matchItem(root, task.text, states);
  if (!li) return { headings: [], parent: null, neighbours: [], lead: null, matched: false };
  return { headings: headingsAbove(root, li), parent: parentOf(li), neighbours: neighboursOf(li), lead: leadOf(root, li), matched: true };
}

/** An item's own words: no sub-items, "from …" link, scheduled note or trailing tokens (`~30m`, `!`). */
function itemText(li: HTMLElement): string {
  const span = descriptionOf(li);
  const inner = span
    ? span.innerHTML
    : li.childNodes.filter((n) => !(n instanceof HTMLElement && /^(UL|OL)$/.test(n.tagName))).map((n) => n.toString()).join('');
  const text = parse(withoutBackLink(inner).replace(SCHEDULED, '')).text.replace(/\s+/g, ' ').trim();
  return text.slice(0, tokenZoneStart(text)).trim();
}

function matchItem(root: HTMLElement, text: string, states: StateSymbols): HTMLElement | undefined {
  const want = norm(text);
  if (!want) return undefined;
  const matches = root.querySelectorAll('li').filter((li) => norm(itemText(li)) === want);
  const rescheduled = (li: HTMLElement) => itemState(li, states) === 'rescheduled' || /<em>\s*(?:re)?scheduled\b/.test(descriptionOf(li)?.innerHTML ?? '');
  return matches.find(rescheduled) ?? matches[0];
}

/** The item's block at the top of the note. */
function topBlock(root: HTMLElement, li: HTMLElement): HTMLElement {
  let top: HTMLElement = li;
  while (top.parentNode && top.parentNode !== root) top = top.parentNode as HTMLElement;
  return top;
}

/** The heading above the item, then each heading of a higher level above that. */
function headingsAbove(root: HTMLElement, li: HTMLElement): string[] {
  const siblings = elements(root);
  const headings: string[] = [];
  let level = 7;
  for (let i = siblings.indexOf(topBlock(root, li)) - 1; i >= 0 && level > 1; i--) {
    const el = siblings[i]!;
    if (!isHeading(el) || Number(el.tagName[1]) >= level) continue;
    const text = el.text.replace(/\s+/g, ' ').trim();
    level = Number(el.tagName[1]);
    if (text) headings.unshift(text);
  }
  return headings;
}

function parentOf(li: HTMLElement): string | null {
  const up = li.parentNode?.parentNode;
  return up instanceof HTMLElement && up.tagName === 'LI' ? itemText(up) || null : null;
}

/** The other items of the item's list, nearest first, the one after before the one before. */
function neighboursOf(li: HTMLElement): string[] {
  const items = elements(li.parentNode as HTMLElement).filter((c) => c.tagName === 'LI');
  const at = items.indexOf(li);
  return items
    .map((item, i) => ({ item, distance: Math.abs(i - at) * 2 - (i > at ? 1 : 0) }))
    .filter(({ item }) => item !== li)
    .sort((a, b) => a.distance - b.distance)
    .map(({ item }) => itemText(item))
    .filter(Boolean)
    .slice(0, MAX_NEIGHBOURS);
}

/** The paragraph right before the item's list, skipping empty ones; null when anything else is there. */
function leadOf(root: HTMLElement, li: HTMLElement): string | null {
  const siblings = elements(root);
  for (let i = siblings.indexOf(topBlock(root, li)) - 1; i >= 0; i--) {
    const el = siblings[i]!;
    const text = el.text.replace(/\s+/g, ' ').trim();
    if (el.tagName === 'P' && !text) continue;
    if (el.tagName !== 'P') return null;
    if (text.length <= LEAD_CHARS) return text;
    const cut = text.slice(0, LEAD_CHARS);
    return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : LEAD_CHARS).trimEnd()}…`;
  }
  return null;
}
