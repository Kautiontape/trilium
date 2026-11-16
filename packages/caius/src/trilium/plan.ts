// The planning writes: add, accept, dismiss, done, start, drop. Each works on one
// Trilium note's HTML (positions found with node-html-parser, edits spliced into
// the string) and follows `forward`'s safety rules: build the new HTML in memory,
// write it as a compare-and-swap against the HTML it was built from and drop the
// write if the note changed, never call the calendar endpoints on a dry run, and
// be safe to run twice.

import { parse } from 'node-html-parser';
import { now as clock } from '../clock.js';
import { proseKind } from './sections.js';
import { scanDocs } from '../index/index.js';
import { findItem, newListItemId, tokenZoneStart } from './html-util.js';
import { addUnder, liftOut, nestNew, nestUnder, type NestResult } from './nest-html.js';
import { scanTokens } from '../core/index.js';
import { loadJournal, loadStateSymbols } from './journal.js';
import { TRILIUM_CONFIG } from './config.js';
import type { NoteChange } from './forward.js';
import { inspectItem } from './forward-html.js';
import type { StoreNote, NoteStore } from './store.js';
import { JIRA_BASE, markdownLinks, parseEstimate, parseSource, taskKeys } from './keys.js';
import {
  asListTask,
  escapeHtml,
  inspectSuggested,
  itemMarkup,
  inProseById,
  moveInMainList,
  placeForwarded,
  placeInDay,
  placeInMainList,
  placeProblem,
  placeTask,
  setTaskArea,
  setTaskEstimate,
  setTaskState,
  suggestedItems,
  takeOnDeck,
  takeSuggested,
  type DayPlace,
  type StateAction,
  type Target,
} from './plan-html.js';
import { DISMISSED_LABEL, PERIODS, dismissedKeys, findPeriodNote, isPeriodKey, type PeriodKind } from './plan-read.js';
import type { StateSymbols } from './markdown.js';
import { AREAS, withArea, type Area } from './areas.js';

export interface AddRequest {
  /** Exactly one of date (YYYY-MM-DD), week (YYYY-Www) or month (YYYY-MM). */
  date?: string;
  week?: string;
  month?: string;
  /** Exactly one of section, critical, suggested or onDeck. */
  section?: string;
  critical?: boolean;
  suggested?: boolean;
  /** A day only: the On deck section, intended for the day but not committed. */
  onDeck?: boolean;
  text: string;
  /** A Jira key, or a URL; written into the task as a link and used to spot duplicates. */
  source?: string;
  /** `30m`, `2h`, `1h30m`. */
  est?: string;
  /** A list item id in the target note: the task becomes its last sub-item. Needs no section, critical or onDeck. */
  under?: string;
}

export interface AcceptRequest {
  noteId: string;
  listItemId: string;
  /** At most one of section or critical; with neither, the end of his main list. */
  section?: string;
  critical?: boolean;
  /** 1-based place in the destination list; default the end. */
  position?: number;
}

export interface ItemRequest {
  noteId: string;
  listItemId: string;
  /** drop only. */
  reason?: string;
}

/** An On deck task put on his list: the end of his main list, or first, before or after an item of it, or the Important block. */
export interface CommitRequest {
  noteId: string;
  listItemId: string;
  first?: boolean;
  before?: string;
  after?: string;
  critical?: boolean;
}

export interface MoveRequest {
  noteId: string;
  listItemId: string;
  /** Exactly one of first, before or after: the place in his main list. */
  first?: boolean;
  before?: string;
  after?: string;
}

export type PlanSkip =
  | 'not_found'
  | 'not_in_main_list'
  | 'not_live'
  | 'not_suggested'
  | 'not_on_deck'
  | 'prose_section'
  | 'already_done'
  | 'already_doing'
  | 'already_cancelled'
  | 'duplicate'
  | 'dismissed'
  | 'edited'
  | 'bad_request'
  /** The item or its parent is in another note: forward it first. */
  | 'other_note'
  /** Nesting under a sub-item. */
  | 'too_deep'
  | 'unreadable'
  /** Reported by a host that checks the note's version before it calls the library. */
  | 'stale';

export type PlanResult<R> = R &
  (
    | {
        status: 'added' | 'accepted' | 'dismissed' | 'updated' | 'moved' | 'unchanged';
        detail?: string;
        dryRun?: boolean;
        /** The note written (add: the day, week or month note). */
        writtenNoteId?: string;
        listItemId?: string;
        /** place under: the task the item now sits under (the given id, or the new parent's). */
        parentListItemId?: string;
        /** The source key (add, dismiss). */
        key?: string;
        /** done/start/drop: the state the task is now in. */
        state?: string;
        /** done: the parent whose last live sub-item this tick closed; it is left as it is. */
        parentComplete?: { noteId: string; listItemId: string; text: string };
        changes?: NoteChange[];
      }
    | { status: 'skipped'; reason: PlanSkip; detail?: string }
    | { status: 'failed'; error: string }
  );

export interface PlanOptions {
  dryRun?: boolean;
  /** Overrides for tests. */
  states?: StateSymbols;
  newId?: () => string;
}

type Done<R> = PlanResult<R>;

const skip = <R>(req: R, reason: PlanSkip, detail?: string): Done<R> => ({ ...req, status: 'skipped', reason, detail }) as Done<R>;
const failed = <R>(req: R, e: unknown): Done<R> =>
  ({ ...req, status: 'failed', error: e instanceof Error ? e.message : String(e) }) as Done<R>;

async function eachSequentially<Q, R>(reqs: Q[], fn: (req: Q) => Promise<Done<Q>>): Promise<Done<Q>[]> {
  const out: Done<Q>[] = [];
  for (const req of reqs) {
    try {
      out.push(await fn(req));
    } catch (e) {
      out.push(failed(req, e));
    }
  }
  return out;
}

function usable(note: StoreNote): string | null {
  return note.type !== 'text' || note.isProtected ? 'note is protected or not a text note' : null;
}

const isProseTarget = (target: Target) => target.kind === 'section' && proseKind(target.name) !== null;
const PROSE_DETAIL = 'Meetings and Context hold plain bullets, never tasks';

const symbolId = (states: StateSymbols, symbol: string) => [...states].find(([, s]) => s === symbol)?.[0];

// ---- add -----------------------------------------------------------------

const PERIOD_FIELDS = { day: 'date', week: 'week', month: 'month' } as const;

function periodOf(req: AddRequest): { period: PeriodKind; key: string } | string {
  const given = (['day', 'week', 'month'] as const).filter((p) => req[PERIOD_FIELDS[p]] !== undefined);
  if (given.length !== 1) return 'give exactly one of date, week, month';
  const period = given[0]!;
  const key = req[PERIOD_FIELDS[period]]!;
  return isPeriodKey(period, key) ? { period, key } : `${PERIOD_FIELDS[period]} must be a ${PERIODS[period].shape} that exists`;
}

function targetOf(req: AddRequest): Target | string | null {
  if (req.under !== undefined) {
    const others = [req.section !== undefined, !!req.critical, !!req.suggested, !!req.onDeck].some(Boolean);
    if (typeof req.under !== 'string' || !req.under) return 'under is a list item id';
    return others ? 'under takes no section, critical, suggested or onDeck' : null;
  }
  const given = [req.section !== undefined, !!req.critical, !!req.suggested, !!req.onDeck].filter(Boolean).length;
  if (given !== 1) return 'give exactly one of section, critical, suggested, onDeck';
  if (req.critical) return { kind: 'critical' };
  if (req.suggested) return { kind: 'suggested' };
  if (req.onDeck) return req.date !== undefined ? { kind: 'onDeck' } : 'only a day note has an On deck section';
  return req.section!.trim() ? { kind: 'section', name: req.section!.trim() } : 'section name is empty';
}

/** The task's description HTML: text, the source as a link, then the estimate (last, so it stays a token). */
function describe(req: AddRequest, source: NonNullable<ReturnType<typeof parseSource>> | null, est: string | null): string {
  const raw = req.text.trim();
  // Text the caller gave may already end in tokens (`~30m`, `!`); the link goes before them.
  const cut = tokenZoneStart(raw);
  let body = escapeHtml(raw.slice(0, cut));
  const tokens = escapeHtml(raw.slice(cut));
  if (source) {
    const link = `<a href="${escapeHtml(source.url)}">${escapeHtml(source.label)}</a>`;
    // A Jira key already in the text becomes the link; otherwise the link follows the text.
    body = source.jira && body.includes(source.jira) ? body.replace(source.jira, link) : `${body} ${link}`;
  }
  const hasEst = scanTokens(raw).tokens.some((t) => t.kind === 'estimate');
  return body + tokens + (est && !hasEst ? ` ~${est}` : '');
}

/** Live task keys across the whole Journal (Suggested items excluded), key → "period: text". */
async function journalKeys(api: NoteStore, now: Date): Promise<Map<string, string>> {
  const load = await loadJournal(api);
  const scan = scanDocs(load.docs, TRILIUM_CONFIG, now);
  const keys = new Map<string, string>();
  for (const t of scan.tasks) {
    if (!t.live) continue;
    const links = markdownLinks(t.text);
    const where = `${t.file.replace(/^Journal\/\w+\//, '').replace(/\.md$/, '')}: ${links.text}`;
    for (const k of taskKeys(links.text, links.urls)) if (!keys.has(k)) keys.set(k, where);
  }
  return keys;
}

export async function addTasks(api: NoteStore, reqs: AddRequest[], opts: PlanOptions & { now?: Date } = {}): Promise<Done<AddRequest>[]> {
  const now = opts.now ?? clock();
  let journal: Map<string, string> | null = null;
  const newId = opts.newId ?? newListItemId;

  return eachSequentially(reqs, async (req) => {
    if (typeof req.text !== 'string' || !req.text.trim()) return skip(req, 'bad_request', 'text is required');
    const when = periodOf(req);
    if (typeof when === 'string') return skip(req, 'bad_request', when);
    const target = targetOf(req);
    if (typeof target === 'string') return skip(req, 'bad_request', target);
    if (target && isProseTarget(target)) return skip(req, 'prose_section', PROSE_DETAIL);
    const est = req.est === undefined ? null : parseEstimate(req.est);
    if (req.est !== undefined && !est) return skip(req, 'bad_request', 'est must look like 30m, 2h or 1h30m');
    const source = req.source === undefined ? null : parseSource(req.source);
    if (req.source !== undefined && !source) return skip(req, 'bad_request', 'source must be a Jira key or an http(s) URL');

    const note = await findPeriodNote(api, when.period, when.key);
    if (note) {
      const problem = usable(note);
      if (problem) return skip(req, 'unreadable', problem);
    }
    if (req.under !== undefined && !note) return skip(req, ...(await missingParent(api, req.under, null)));

    // Keys: the source's, if given; otherwise from the text.
    const keys = source ? source.keys : taskKeys(req.text.trim(), []);
    const key = keys[0]!;

    const dismissed = note ? dismissedKeys(note) : [];
    const hit = keys.find((k) => dismissed.includes(k));
    if (hit) return skip(req, 'dismissed', `${hit} was dismissed on this ${when.period} note`);

    journal ??= await journalKeys(api, now);
    const open = keys.map((k) => journal!.get(k)).find((x) => x !== undefined);
    if (open) return skip(req, 'duplicate', `already open in ${open}`);
    let html = note ? await api.content(note.noteId) : '';
    if (note) {
      const sameNote = suggestedItems(html).find((s) => keys.some((k) => taskKeys(s.text, s.hrefs).includes(k)));
      if (sameNote) return skip(req, 'duplicate', `already suggested on this ${when.period} note: ${sameNote.text}`);
    }

    const id = newId();
    const markup = itemMarkup(id, describe(req, source, est));
    let target_: StoreNote | null = note;
    let created = false;
    if (!note) {
      if (!opts.dryRun) {
        target_ =
          when.period === 'day' ? await api.calendarDay(when.key) : when.period === 'week' ? await api.calendarWeek(when.key) : await api.calendarMonth(when.key);
        const problem = usable(target_);
        if (problem) return skip(req, 'unreadable', problem);
        created = true;
        html = await api.content(target_.noteId);
      }
    }

    let after: string;
    if (target) after = placeTask(html, markup, target);
    else {
      const nested = addUnder(html, markup, req.under ?? '', opts.states ?? (await loadStateSymbols(api)));
      if (!nested.ok) return skip(req, ...(await nestRefusal(api, nested, req.under ?? '', html, note?.noteId ?? null)));
      after = nested.html;
    }
    if (target && inProseById(after, id)) return skip(req, 'prose_section', PROSE_DETAIL);
    const noteId = target_?.noteId ?? 'NEW-NOTE';
    const track = () => {
      const where = `${when.key}: ${req.text.trim()}`;
      for (const k of keys) journal!.set(k, where);
    };

    if (opts.dryRun) {
      track();
      return {
        ...req,
        status: 'added',
        dryRun: true,
        writtenNoteId: noteId,
        listItemId: id,
        key,
        detail: note ? undefined : `${when.key} has no ${when.period} note yet; a real run would create it from the template`,
        changes: [{ noteId, role: 'target', before: html, after }],
      };
    }
    if (!(await api.putContent(target_!.noteId, after, html))) return skip(req, 'edited', `${when.key} changed meanwhile; nothing written`);
    track();
    return {
      ...req,
      status: 'added',
      writtenNoteId: target_!.noteId,
      listItemId: id,
      key,
      detail: created ? `created the ${when.period} note` : undefined,
    };
  });
}

// ---- accept / dismiss ----------------------------------------------------

async function loadNote(api: NoteStore, noteId: string): Promise<{ note: StoreNote } | { problem: string }> {
  const note = await api.note(noteId);
  const problem = usable(note);
  return problem ? { problem } : { note };
}

const validItem = (r: ItemRequest | AcceptRequest | MoveRequest) => !!r.noteId && !!r.listItemId;

/**
 * The reason a Suggested evening item gives, "X: because the evening has nothing planned (~45m)":
 * accepting it without a section puts it under the evening's heading, not in his main list.
 */
export const EVENING_REASON = 'the evening has nothing planned';

export async function acceptTasks(api: NoteStore, reqs: AcceptRequest[], opts: PlanOptions = {}): Promise<Done<AcceptRequest>[]> {
  return eachSequentially(reqs, async (req) => {
    if (!validItem(req)) return skip(req, 'bad_request', 'need noteId and listItemId');
    const given = [req.section !== undefined, !!req.critical].filter(Boolean).length;
    if (given > 1) return skip(req, 'bad_request', 'give at most one of section, critical');
    if (req.position !== undefined && (!Number.isInteger(req.position) || req.position < 1)) return skip(req, 'bad_request', 'position must be 1 or more');
    if (req.position !== undefined && !given) return skip(req, 'bad_request', 'position needs a section or critical');
    // With neither, the item joins the end of his main list (`placeInMainList`).
    const target: Target | null = req.critical ? { kind: 'critical' } : req.section !== undefined ? { kind: 'section', name: req.section.trim() } : null;
    if (target?.kind === 'section' && !target.name) return skip(req, 'bad_request', 'section name is empty');
    if (target && isProseTarget(target)) return skip(req, 'prose_section', PROSE_DETAIL);

    const loaded = await loadNote(api, req.noteId);
    if ('problem' in loaded) return skip(req, 'unreadable', loaded.problem);
    const html = await api.content(req.noteId);
    const taken = takeSuggested(html, req.listItemId);
    if (!taken.ok) return skip(req, taken.reason, taken.reason === 'not_suggested' ? 'only an item under Suggested can be accepted (already accepted?)' : undefined);
    const markup = asListTask(taken.markup);
    // An evening suggestion stays in the evening: under any Evening or Recharge heading, else a new Evening one.
    const after = target ? placeTask(taken.html, markup, target, req.position)
      : taken.text.includes(`: because ${EVENING_REASON} (`) ? placeForwarded(taken.html, markup, 'Evening')
        : placeInMainList(taken.html, markup);
    if (inProseById(after, req.listItemId)) return skip(req, 'prose_section', PROSE_DETAIL);
    if (opts.dryRun) {
      return { ...req, status: 'accepted', dryRun: true, listItemId: req.listItemId, changes: [{ noteId: req.noteId, role: 'target', before: html, after }] };
    }
    if (!(await api.putContent(req.noteId, after, html))) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    return { ...req, status: 'accepted', listItemId: req.listItemId };
  });
}

/**
 * Puts On deck tasks on his list, each the same item (id, text, state, sub-items): into the
 * Important block, or at the end of his main list and then first, before or after an item of it.
 * An item already off the deck and live is `unchanged`, so a re-run writes nothing.
 */
export async function commitTasks(api: NoteStore, reqs: CommitRequest[], opts: PlanOptions = {}): Promise<Done<CommitRequest>[]> {
  const states = opts.states ?? (await loadStateSymbols(api));
  return eachSequentially(reqs, async (req) => {
    if (!validItem(req)) return skip(req, 'bad_request', 'need noteId and listItemId');
    const given = [!!req.first, req.before !== undefined, req.after !== undefined, !!req.critical].filter(Boolean).length;
    if (given > 1) return skip(req, 'bad_request', 'give at most one of first, before, after or critical');
    const loaded = await loadNote(api, req.noteId);
    if ('problem' in loaded) return skip(req, 'unreadable', loaded.problem);
    const html = await api.content(req.noteId);
    const taken = takeOnDeck(html, req.listItemId, states);
    if (!taken.ok) {
      if (taken.reason !== 'not_on_deck') return skip(req, taken.reason);
      return inspectItem(html, req.listItemId, states).ok ? { ...req, status: 'unchanged', detail: 'already on the list' } : skip(req, 'not_on_deck');
    }
    let after = req.critical ? placeTask(taken.html, taken.markup, { kind: 'critical' }) : placeInMainList(taken.html, taken.markup);
    const place = req.first ? { first: true as const } : req.before !== undefined ? { before: req.before } : req.after !== undefined ? { after: req.after } : null;
    if (place) {
      const moved = moveInMainList(after, req.listItemId, place);
      if (!moved.ok) return skip(req, moved.reason, 'the item it is placed by must be in his main list');
      after = moved.html;
    }
    if (opts.dryRun) return { ...req, status: 'moved', dryRun: true, changes: [{ noteId: req.noteId, role: 'target', before: html, after }] };
    if (!(await api.putContent(req.noteId, after, html))) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    return { ...req, status: 'moved' };
  });
}

/** Moves items of his main list: first, or before or after another item of it. */
export async function moveTasks(api: NoteStore, reqs: MoveRequest[], opts: PlanOptions = {}): Promise<Done<MoveRequest>[]> {
  return eachSequentially(reqs, async (req) => {
    if (!validItem(req)) return skip(req, 'bad_request', 'need noteId and listItemId');
    const place = req.first ? { first: true as const } : req.before !== undefined ? { before: req.before } : req.after !== undefined ? { after: req.after } : null;
    const given = [!!req.first, req.before !== undefined, req.after !== undefined].filter(Boolean).length;
    if (!place || given !== 1) return skip(req, 'bad_request', 'give exactly one of first, before or after');
    if (req.before === req.listItemId || req.after === req.listItemId) return skip(req, 'bad_request', 'an item is placed by another item');
    const loaded = await loadNote(api, req.noteId);
    if ('problem' in loaded) return skip(req, 'unreadable', loaded.problem);
    const html = await api.content(req.noteId);
    const moved = moveInMainList(html, req.listItemId, place);
    if (!moved.ok) return skip(req, moved.reason, 'the item and the one it is placed by must both be in his main list');
    if (moved.unchanged) return { ...req, status: 'unchanged' };
    if (opts.dryRun) return { ...req, status: 'moved', dryRun: true, changes: [{ noteId: req.noteId, role: 'target', before: html, after: moved.html }] };
    if (!(await api.putContent(req.noteId, moved.html, html))) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    return { ...req, status: 'moved' };
  });
}

export async function dismissTasks(api: NoteStore, reqs: ItemRequest[], opts: PlanOptions = {}): Promise<Done<ItemRequest>[]> {
  return eachSequentially(reqs, async (req) => {
    if (!validItem(req)) return skip(req, 'bad_request', 'need noteId and listItemId');
    const loaded = await loadNote(api, req.noteId);
    if ('problem' in loaded) return skip(req, 'unreadable', loaded.problem);
    const html = await api.content(req.noteId);
    const found = inspectSuggested(html, req.listItemId);
    if (!found.ok) return skip(req, found.reason, found.reason === 'not_suggested' ? 'only an item under Suggested can be dismissed' : undefined);
    const key = taskKeys(found.text, found.hrefs)[0]!;
    const taken = takeSuggested(html, req.listItemId);
    if (!taken.ok) return skip(req, taken.reason);
    const labelled = dismissedKeys(loaded.note).includes(key);
    if (opts.dryRun) {
      return {
        ...req,
        status: 'dismissed',
        dryRun: true,
        key,
        detail: labelled ? `#${DISMISSED_LABEL}=${key} is already on the note` : `would add #${DISMISSED_LABEL}=${key}`,
        changes: [{ noteId: req.noteId, role: 'target', before: html, after: taken.html }],
      };
    }
    // The label goes on before the content, so this re-read keeps an edit made before then from leaving a label behind.
    if ((await api.content(req.noteId)) !== html) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    // Label first: if the PUT then fails, the item is still there but already dismissed, and a re-run finishes.
    if (!labelled) await api.addLabel(req.noteId, DISMISSED_LABEL, key);
    if (!(await api.putContent(req.noteId, taken.html, html))) {
      return skip(req, 'edited', 'note changed after the dismissal label was added; the item is still listed, so re-run to remove it');
    }
    return { ...req, status: 'dismissed', key };
  });
}

// ---- done / start / drop -------------------------------------------------

const RESULT_STATE: Record<StateAction, string> = { done: 'done', start: 'doing', drop: 'cancelled' };

export async function setStates(
  api: NoteStore,
  action: StateAction,
  reqs: ItemRequest[],
  opts: PlanOptions = {},
): Promise<Done<ItemRequest>[]> {
  const states = opts.states ?? (await loadStateSymbols(api));
  return eachSequentially(reqs, async (req) => {
    if (!validItem(req)) return skip(req, 'bad_request', 'need noteId and listItemId');
    if (action === 'drop' && !req.reason?.trim()) return skip(req, 'bad_request', 'drop needs a reason');
    const loaded = await loadNote(api, req.noteId);
    if ('problem' in loaded) return skip(req, 'unreadable', loaded.problem);
    const html = await api.content(req.noteId);
    const r = setTaskState(html, req.listItemId, action, {
      states,
      doingId: symbolId(states, '/'),
      cancelledId: symbolId(states, '-'),
      reason: req.reason,
    });
    if (!r.ok) return skip(req, r.reason, r.from ? `the task is ${r.from}` : undefined);
    const parentComplete = r.parentComplete && { parentComplete: { noteId: req.noteId, ...r.parentComplete } };
    if (opts.dryRun) {
      return { ...req, status: 'updated', dryRun: true, state: RESULT_STATE[action], ...parentComplete, changes: [{ noteId: req.noteId, role: 'target', before: html, after: r.html }] };
    }
    if (!(await api.putContent(req.noteId, r.html, html))) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    return { ...req, status: 'updated', state: RESULT_STATE[action], ...parentComplete };
  });
}

// ---- area --------------------------------------------------------------

/** A task to give an area: Foundation (no marker), Growth or Recharge. */
export interface AreaRequest {
  noteId: string;
  listItemId: string;
  area: Area;
}

/**
 * Give each task the marker of its area, or none for Foundation. The tasks of one note are changed
 * together and written once, as a compare-and-swap against the HTML they were built from; if the
 * note changed meanwhile, none of them is written and each reports `edited`.
 */
export async function setAreas(api: NoteStore, reqs: AreaRequest[], opts: PlanOptions = {}): Promise<Done<AreaRequest>[]> {
  const out = new Map<AreaRequest, Done<AreaRequest>>();
  const byNote = new Map<string, AreaRequest[]>();
  for (const req of reqs) {
    if (!validItem(req) || !AREAS.includes(req.area)) out.set(req, skip(req, 'bad_request', 'need noteId, listItemId and an area'));
    else byNote.set(req.noteId, [...(byNote.get(req.noteId) ?? []), req]);
  }
  for (const [noteId, group] of byNote) {
    try {
      const loaded = await loadNote(api, noteId);
      if ('problem' in loaded) {
        for (const req of group) out.set(req, skip(req, 'unreadable', loaded.problem));
        continue;
      }
      const before = await api.content(noteId);
      let after = before;
      const changed: AreaRequest[] = [];
      for (const req of group) {
        const r = setTaskArea(after, req.listItemId, req.area);
        if (!r.ok) out.set(req, skip(req, r.reason));
        else if (r.unchanged) out.set(req, { ...req, status: 'unchanged' });
        else {
          after = r.html;
          changed.push(req);
        }
      }
      if (!changed.length) continue;
      if (opts.dryRun) {
        changed.forEach((req, i) => out.set(req, { ...req, status: 'updated', dryRun: true, changes: i ? undefined : [{ noteId, role: 'target', before, after }] }));
      } else if (!(await api.putContent(noteId, after, before))) {
        for (const req of changed) out.set(req, skip(req, 'edited', 'note changed meanwhile; nothing written'));
      } else for (const req of changed) out.set(req, { ...req, status: 'updated' });
    } catch (e) {
      for (const req of group) if (!out.has(req)) out.set(req, failed(req, e));
    }
  }
  return reqs.map((req) => out.get(req)!);
}

// ---- estimate ----------------------------------------------------------

/** A task to give an estimate: a whole number of minutes from 5 to 600. */
export interface EstimateRequest {
  noteId: string;
  listItemId: string;
  minutes: number;
}

/**
 * Give each task its `~` estimate. The tasks of one note are changed together and written once, as
 * `setAreas` writes them; if the note changed meanwhile, none of them is written and each reports
 * `edited`. A parent takes its own estimate.
 */
export async function setEstimates(api: NoteStore, reqs: EstimateRequest[], opts: PlanOptions = {}): Promise<Done<EstimateRequest>[]> {
  const states = opts.states ?? (await loadStateSymbols(api));
  const out = new Map<EstimateRequest, Done<EstimateRequest>>();
  const byNote = new Map<string, EstimateRequest[]>();
  for (const req of reqs) {
    if (!validItem(req)) out.set(req, skip(req, 'bad_request', 'need noteId and listItemId'));
    else if (!Number.isInteger(req.minutes) || req.minutes < 5 || req.minutes > 600) out.set(req, skip(req, 'bad_request', 'minutes is a whole number from 5 to 600'));
    else byNote.set(req.noteId, [...(byNote.get(req.noteId) ?? []), req]);
  }
  for (const [noteId, group] of byNote) {
    try {
      const loaded = await loadNote(api, noteId);
      if ('problem' in loaded) {
        for (const req of group) out.set(req, skip(req, 'unreadable', loaded.problem));
        continue;
      }
      const before = await api.content(noteId);
      let after = before;
      const changed: EstimateRequest[] = [];
      for (const req of group) {
        const r = setTaskEstimate(after, req.listItemId, req.minutes, states);
        if (!r.ok) out.set(req, skip(req, r.reason));
        else if (r.unchanged) out.set(req, { ...req, status: 'unchanged' });
        else {
          after = r.html;
          changed.push(req);
        }
      }
      if (!changed.length) continue;
      if (opts.dryRun) {
        for (const [i, req] of changed.entries()) {
          out.set(req, { ...req, status: 'updated', dryRun: true, changes: i ? undefined : [{ noteId, role: 'target', before, after }] });
        }
      } else if (!(await api.putContent(noteId, after, before))) {
        for (const req of changed) out.set(req, skip(req, 'edited', 'note changed meanwhile; nothing written'));
      } else for (const req of changed) out.set(req, { ...req, status: 'updated' });
    } catch (e) {
      for (const req of group) if (!out.has(req)) out.set(req, failed(req, e));
    }
  }
  return reqs.map((req) => out.get(req) ?? failed(req, 'no result'));
}

// ---- place -------------------------------------------------------------

/** A task to move within its note: into a time block, On deck or onto the list, and before or after an item there. */
export interface PlaceRequest extends DayPlace {
  noteId: string;
  listItemId: string;
  /** Nest the task, with its own sub-items, under a list item of its note (an id), or under a new parent made where the first item stood. */
  under?: string | NewParent;
  /** Lift a sub-item to its parent's level, right after the parent. */
  out?: true;
}

/**
 * Move each task within its note (see `placeInDay`); a move to another note is `forwardTasks`. The
 * tasks of one note are moved in order and written once, as `setAreas` writes them; if the note
 * changed meanwhile, none of them is written and each reports `edited`.
 */
export async function placeTasks(api: NoteStore, reqs: PlaceRequest[], opts: PlanOptions = {}): Promise<Done<PlaceRequest>[]> {
  const newId = opts.newId ?? newListItemId;
  const states = opts.states ?? (await loadStateSymbols(api));
  const out = new Map<PlaceRequest, Done<PlaceRequest>>();
  const byNote = new Map<string, PlaceRequest[]>();
  for (const req of reqs) {
    const nesting = req.under !== undefined || req.out !== undefined;
    const problem = !validItem(req) ? 'need noteId and listItemId' : nestProblem(req.listItemId, req) ?? (nesting ? null : placeProblem(req.listItemId, req));
    if (problem) out.set(req, skip(req, 'bad_request', problem));
    else byNote.set(req.noteId, [...(byNote.get(req.noteId) ?? []), req]);
  }
  for (const [noteId, group] of byNote) {
    try {
      const loaded = await loadNote(api, noteId);
      if ('problem' in loaded) {
        for (const req of group) out.set(req, skip(req, 'unreadable', loaded.problem));
        continue;
      }
      const before = await api.content(noteId);
      let after = before;
      const changed: PlaceRequest[] = [];
      const parents = new Map<PlaceRequest, string>();
      const parentOf = (req: PlaceRequest) => (parents.has(req) ? { parentListItemId: parents.get(req) } : {});
      for (const req of group) {
        if (out.has(req) || changed.includes(req)) continue;
        let r: NestResult | { ok: true; html: string; unchanged: boolean } | { ok: false; reason: PlanSkip; detail?: string };
        let members = [req];
        if (typeof req.under === 'object') {
          const key = parentKey(req.under);
          members = group.filter((q) => typeof q.under === 'object' && parentKey(q.under) === key);
          const pid = newId();
          r = nestNew(after, members.map((q) => q.listItemId), parentMarkup(pid, req.under), states);
          if (r.ok) for (const q of members) parents.set(q, pid);
        } else if (typeof req.under === 'string') {
          r = nestUnder(after, req.listItemId, req.under, states);
          if (r.ok) parents.set(req, req.under);
        } else if (req.out) r = liftOut(after, req.listItemId);
        else r = placeInDay(after, req.listItemId, req, states);
        if (!r.ok) {
          const [reason, detail] = typeof req.under === 'string' ? await nestRefusal(api, r as Extract<NestResult, { ok: false }>, req.under, after, noteId) : [r.reason, r.detail];
          for (const q of members) out.set(q, skip(q, reason, detail));
        } else if (r.unchanged) {
          for (const q of members) {
            const parent = parents.get(q) && typeof q.under === 'object' ? parentIdOf(after, q.listItemId) : parents.get(q);
            out.set(q, { ...q, status: 'unchanged', ...(parent && { parentListItemId: parent }) });
          }
        } else {
          after = r.html;
          changed.push(...members);
        }
      }
      if (!changed.length) continue;
      if (opts.dryRun) {
        for (const [i, req] of changed.entries()) {
          out.set(req, { ...req, status: 'moved', dryRun: true, ...parentOf(req), changes: i ? undefined : [{ noteId, role: 'target', before, after }] });
        }
      } else if (!(await api.putContent(noteId, after, before))) {
        for (const req of changed) out.set(req, skip(req, 'edited', 'note changed meanwhile; nothing written'));
      } else for (const req of changed) out.set(req, { ...req, status: 'moved', ...parentOf(req) });
    } catch (e) {
      for (const req of group) if (!out.has(req)) out.set(req, failed(req, e));
    }
  }
  return reqs.map((req) => out.get(req) ?? failed(req, 'no result'));
}

// ---- nesting helpers ---------------------------------------------------

/** Why `id` is not in the note `noteId`: `other_note` naming the Journal note that has it, else `not_found`. */
async function missingParent(api: NoteStore, id: string, noteId: string | null): Promise<['other_note' | 'not_found', string]> {
  const load = await loadJournal(api);
  const doc = load.docs.find((d) => d.noteId !== noteId && [...d.itemIds.values()].includes(id));
  if (!doc) return ['not_found', `no task ${id}`];
  const where = doc.path.replace(/^Journal\/\w+\//, '').replace(/\.md$/, '') || doc.noteId;
  return ['other_note', `${id} is in ${where} (note ${doc.noteId}); forward it into this note first`];
}

/** The skip for a refused nest: `nest-html`'s reason, or `other_note` when the parent `under` is in another note. */
async function nestRefusal(
  api: NoteStore,
  r: Extract<NestResult, { ok: false }>,
  under: string | null,
  html: string,
  noteId: string | null,
): Promise<[PlanSkip, string | undefined]> {
  if (r.reason === 'not_found' && under !== null && !findItem(parse(html, { comment: true }), under)) return missingParent(api, under, noteId);
  return [r.reason, r.detail];
}

type NewParent = { text: string; est?: string; area?: Area };

/** What is wrong with the nesting fields of a place request, or null; `placeProblem` checks the rest. */
function nestProblem(id: string, req: PlaceRequest): string | null {
  const { under, out } = req;
  if (under === undefined && out === undefined) return null;
  const given = [req.block !== undefined, req.onDeck !== undefined, req.before !== undefined || req.after !== undefined, under !== undefined, out !== undefined];
  if (given.filter(Boolean).length !== 1) return 'give exactly one of block, onDeck, before or after, under or out';
  if (out !== undefined && out !== true) return 'out is true';
  if (typeof under === 'string') return !under ? 'under is a list item id' : under === id ? 'an item cannot go under itself' : null;
  if (under) {
    if (typeof under.text !== 'string' || !under.text.trim()) return 'under.text is required';
    if (under.est !== undefined && !parseEstimate(under.est)) return 'est must look like 30m, 2h or 1h30m';
    if (under.area !== undefined && !AREAS.includes(under.area)) return 'area must be foundation, growth or recharge';
  }
  return null;
}

const parentKey = (u: NewParent) => JSON.stringify([u.text, u.est ?? null, u.area ?? null]);

function parentMarkup(id: string, u: NewParent): string {
  const est = u.est === undefined ? '' : ` ~${parseEstimate(u.est)}`;
  const text = escapeHtml(u.text.trim());
  return itemMarkup(id, (u.area === undefined ? text : withArea(text, u.area)) + est);
}

/** The id of the task whose sub-list holds `id`, or undefined. */
function parentIdOf(html: string, id: string): string | undefined {
  const holder = findItem(parse(html, { comment: true }), id)?.parentNode?.parentNode;
  return holder && 'getAttribute' in holder ? (holder as { getAttribute(n: string): string | undefined }).getAttribute('data-list-item-id') : undefined;
}

export { JIRA_BASE };
