import { HTMLElement, parse } from 'node-html-parser';
import { parseClock } from '../inputs/capacity.js';
import { clockOf, stripMarker } from './areas.js';
import { backLinkOf } from './forward-html.js';
import { apply, descriptionOf, findItem, inProseSection, isTask, itemState, sectionOf, spanEnd, tokenZoneStart, tokenZoneStartInHtml } from './html-util.js';
import { taskKeys } from './keys.js';
import type { StateSymbols } from './markdown.js';
import { escapeHtml } from './plan-html.js';
import { isSuggestedName } from './sections.js';

export type RewordProblem = 'not_found' | 'not_live' | 'moved' | 'cancelled' | 'suggested' | 'empty';
export interface DroppedLink { text: string; href: string }

/**
 * The task `id` with its words replaced by `text`. The task keeps its area marker, its estimate
 * and other trailing tokens, its "from …" and "scheduled …" trail, its sub-items and its state;
 * its clock stays unless `text` starts with one. A link whose text survives in the new words
 * stays on it; the others are listed in `dropped`, and `droppedKeys` names the Jira keys lost.
 */
export function rewordTask(
  html: string,
  id: string,
  text: string,
  states: StateSymbols,
):
  | { ok: true; html: string; unchanged: boolean; dropped: DroppedLink[]; droppedKeys: string[] }
  | { ok: false; reason: RewordProblem } {
  const root = parse(html, { comment: true });
  const li = findItem(root, id);
  if (!li || !isTask(li)) return { ok: false, reason: 'not_found' };
  const span = descriptionOf(li);
  if (!span) return { ok: false, reason: 'not_found' };
  if (inProseSection(root, li)) return { ok: false, reason: 'not_live' };
  if (isSuggestedName(sectionOf(root, li))) return { ok: false, reason: 'suggested' };
  if (li.getAttribute('data-trilium-task-state') === '_rescheduled') return { ok: false, reason: 'moved' };
  const state = itemState(li, states);
  if (state === 'rescheduled') return { ok: false, reason: 'moved' };
  if (state === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (state === 'other') return { ok: false, reason: 'not_live' };

  const words = newWords(text);
  if (!words) return { ok: false, reason: 'empty' };

  const start = html.indexOf('>', span.range[0] + 5 + span.rawAttrs.length) + 1;
  const inner = html.slice(start, spanEnd(html, span));
  const { markerEnd, clockEnd } = leadingRun(inner);
  const tailStart = tailStartOf(html, inner, start, span, clockEnd);
  const prefix = inner.slice(0, clockOf(words) ? markerEnd : clockEnd);
  const zoneStart = start + clockEnd;
  const links = span.querySelectorAll('a').filter((a) => a.range[0] >= zoneStart && a.range[1] <= start + tailStart);
  const { markup, dropped } = linkWords(html, words, links);
  const spacer = prefix && !/(?:\s|&nbsp;)$/.test(prefix) ? ' ' : '';
  const result = apply(html, [{ start, end: start + tailStart, text: `${prefix}${spacer}${markup}` }]);
  if (result === html) return { ok: true, html, unchanged: true, dropped: [], droppedKeys: [] };
  return { ok: true, html: result, unchanged: false, dropped, droppedKeys: lostKeys(span, result, id) };
}

/** `text` without its marker and trailing tokens: the task keeps its own. */
function newWords(text: string): string {
  const bare = stripMarker(text.trim());
  // Padded, so a text that is only tokens (`~30m`) still reads them as tokens.
  return bare.slice(0, Math.max(0, tokenZoneStart(` ${bare}`) - 1)).trim();
}

const SPACE = '(?:\\s|&nbsp;)';

/** Where the marker and the clock end in a description's inner HTML, spaces included. */
function leadingRun(inner: string): { markerEnd: number; clockEnd: number } {
  const run = inner.slice(0, inner.includes('<') ? inner.indexOf('<') : undefined);
  const marker = new RegExp(`^${SPACE}*(?:(?:🌱|🔋)\\uFE0F?${SPACE}*)?`, 'u').exec(run);
  const markerEnd = marker ? marker[0].length : 0;
  const clock = new RegExp(`^([0-2]\\d:[0-5]\\d)${SPACE}+`).exec(run.slice(markerEnd));
  const clockEnd = clock && parseClock(clock[1] ?? '') !== undefined ? markerEnd + clock[0].length : markerEnd;
  return { markerEnd, clockEnd };
}

/** The offset in `inner` where the kept tail starts: its own leading space, then the trail or the tokens. */
function tailStartOf(html: string, inner: string, start: number, span: HTMLElement, clockEnd: number): number {
  const trail = trailChildren(span).map((el) => el.range[0] - start);
  const firstTrail = trail.length ? Math.min(...trail) : inner.length;
  const masked = inner.slice(0, firstTrail).replace(/&nbsp;/g, '      ');
  let at = Math.min(firstTrail, tokenZoneStartInHtml(masked));
  const space = new RegExp(`${SPACE}+$`).exec(inner.slice(0, at));
  if (space) at -= space[0].length;
  return Math.max(at, clockEnd);
}

/** The "from …" link and any `<em>scheduled <a href="#root/…">…</a></em>` the task carries. */
function trailChildren(span: HTMLElement): HTMLElement[] {
  const back = backLinkOf(span);
  const scheduled = span.querySelectorAll('em').filter((em) => em.text.includes('scheduled') && em.querySelector('a[href^="#root/"]'));
  return back ? [back, ...scheduled] : scheduled;
}

/** `words` escaped, each old link rewritten as its original open tag around the first free match of its text. */
function linkWords(html: string, words: string, links: HTMLElement[]): { markup: string; dropped: DroppedLink[] } {
  const claims: { from: number; to: number; open: string }[] = [];
  const dropped: DroppedLink[] = [];
  for (const a of links) {
    const label = a.text.trim();
    const from = label ? freeMatch(words, label, claims) : -1;
    if (from < 0) {
      dropped.push({ text: label, href: a.getAttribute('href') ?? '' });
      continue;
    }
    const open = html.slice(a.range[0], html.indexOf('>', a.range[0] + 2 + a.rawAttrs.length) + 1);
    claims.push({ from, to: from + label.length, open });
  }
  claims.sort((x, y) => x.from - y.from);
  let markup = '';
  let at = 0;
  for (const c of claims) {
    markup += `${escapeHtml(words.slice(at, c.from))}${c.open}${escapeHtml(words.slice(c.from, c.to))}</a>`;
    at = c.to;
  }
  return { markup: markup + escapeHtml(words.slice(at)), dropped };
}

function freeMatch(words: string, label: string, claims: { from: number; to: number }[]): number {
  for (let i = words.indexOf(label); i >= 0; i = words.indexOf(label, i + 1)) {
    if (!claims.some((c) => i < c.to && i + label.length > c.from)) return i;
  }
  return -1;
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** The Jira keys of the old description that the reworded one lacks, in order. */
function lostKeys(oldSpan: HTMLElement, html: string, id: string): string[] {
  const li = findItem(parse(html, { comment: true }), id);
  const next = li && descriptionOf(li);
  const keysOf = (el: HTMLElement) => taskKeys(el.text, el.querySelectorAll('a').map((a) => a.getAttribute('href') ?? '')).filter((k) => JIRA_KEY.test(k));
  const kept = new Set(next ? keysOf(next) : []);
  return [...new Set(keysOf(oldSpan).filter((k) => !kept.has(k)))];
}
