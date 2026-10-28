// The planning writes: add, accept, dismiss, done, start, drop. Each works on one
// Trilium note's HTML (positions found with node-html-parser, edits spliced into
// the string) and follows `forward`'s safety rules: build the new HTML in memory,
// write it as a compare-and-swap against the HTML it was built from and drop the
// write if the note changed, never call the calendar endpoints on a dry run, and
// be safe to run twice.

import { now as clock } from '../clock.js';
import { proseKind } from './sections.js';
import { scanDocs } from '../index/index.js';
import { newListItemId, tokenZoneStart } from './html-util.js';
import { scanTokens } from '../core/index.js';
import { loadJournal, loadStateSymbols } from './journal.js';
import { TRILIUM_CONFIG } from './config.js';
import type { NoteChange } from './forward.js';
import type { StoreNote, NoteStore } from './store.js';
import { JIRA_BASE, markdownLinks, parseEstimate, parseSource, taskKeys } from './keys.js';
import {
  asListTask,
  escapeHtml,
  inspectSuggested,
  itemMarkup,
  inProseById,
  placeInMainList,
  placeTask,
  setTaskState,
  suggestedItems,
  takeSuggested,
  type StateAction,
  type Target,
} from './plan-html.js';
import { DISMISSED_LABEL, PERIODS, dismissedKeys, findPeriodNote, isPeriodKey, type PeriodKind } from './plan-read.js';
import type { StateSymbols } from './markdown.js';

export interface AddRequest {
  /** Exactly one of date (YYYY-MM-DD), week (YYYY-Www) or month (YYYY-MM). */
  date?: string;
  week?: string;
  month?: string;
  /** Exactly one of section, critical or suggested. */
  section?: string;
  critical?: boolean;
  suggested?: boolean;
  text: string;
  /** A Jira key, or a URL; written into the task as a link and used to spot duplicates. */
  source?: string;
  /** `30m`, `2h`, `1h30m`. */
  est?: string;
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

export type PlanSkip =
  | 'not_found'
  | 'not_live'
  | 'not_suggested'
  | 'prose_section'
  | 'already_done'
  | 'already_doing'
  | 'already_cancelled'
  | 'duplicate'
  | 'dismissed'
  | 'edited'
  | 'bad_request'
  | 'unreadable'
  /** Reported by a host that checks the note's version before it calls the library. */
  | 'stale';

export type PlanResult<R> = R &
  (
    | {
        status: 'added' | 'accepted' | 'dismissed' | 'updated';
        detail?: string;
        dryRun?: boolean;
        /** The note written (add: the day, week or month note). */
        writtenNoteId?: string;
        listItemId?: string;
        /** The source key (add, dismiss). */
        key?: string;
        /** done/start/drop: the state the task is now in. */
        state?: string;
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

function targetOf(req: AddRequest): Target | string {
  const given = [req.section !== undefined, !!req.critical, !!req.suggested].filter(Boolean).length;
  if (given !== 1) return 'give exactly one of section, critical, suggested';
  if (req.critical) return { kind: 'critical' };
  if (req.suggested) return { kind: 'suggested' };
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
    if (isProseTarget(target)) return skip(req, 'prose_section', PROSE_DETAIL);
    const est = req.est === undefined ? null : parseEstimate(req.est);
    if (req.est !== undefined && !est) return skip(req, 'bad_request', 'est must look like 30m, 2h or 1h30m');
    const source = req.source === undefined ? null : parseSource(req.source);
    if (req.source !== undefined && !source) return skip(req, 'bad_request', 'source must be a Jira key or an http(s) URL');

    const note = await findPeriodNote(api, when.period, when.key);
    if (note) {
      const problem = usable(note);
      if (problem) return skip(req, 'unreadable', problem);
    }

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

    const after = placeTask(html, markup, target);
    if (inProseById(after, id)) return skip(req, 'prose_section', PROSE_DETAIL);
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

const validItem = (r: ItemRequest | AcceptRequest) => !!r.noteId && !!r.listItemId;

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
    const after = target ? placeTask(taken.html, markup, target, req.position) : placeInMainList(taken.html, markup);
    if (inProseById(after, req.listItemId)) return skip(req, 'prose_section', PROSE_DETAIL);
    if (opts.dryRun) {
      return { ...req, status: 'accepted', dryRun: true, listItemId: req.listItemId, changes: [{ noteId: req.noteId, role: 'target', before: html, after }] };
    }
    if (!(await api.putContent(req.noteId, after, html))) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    return { ...req, status: 'accepted', listItemId: req.listItemId };
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
    if (opts.dryRun) {
      return { ...req, status: 'updated', dryRun: true, state: RESULT_STATE[action], changes: [{ noteId: req.noteId, role: 'target', before: html, after: r.html }] };
    }
    if (!(await api.putContent(req.noteId, r.html, html))) return skip(req, 'edited', 'note changed meanwhile; nothing written');
    return { ...req, status: 'updated', state: RESULT_STATE[action] };
  });
}

export { JIRA_BASE };
