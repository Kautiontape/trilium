// Candidates for a day's Suggested section: Jira hand-offs and asks, and the week note's items,
// minus anything already live in the Journal, already suggested or dismissed, and what Shawn has
// closed lately.

import { scanDocs } from '../index/index.js';
import { TRILIUM_CONFIG } from '../trilium/config.js';
import type { TriliumDoc } from '../trilium/journal.js';
import { markdownLinks, taskKeys } from '../trilium/keys.js';
import { DEFAULT_ESTIMATE, DISMISSED_LABEL, PERIODS, type PeriodKind } from '../trilium/plan-read.js';
import { label, type NoteReader, type StoreNote } from '../trilium/store.js';
import { periodSpan } from '../trilium/until.js';

/** The part of a `caius_inputs` ticket the candidates read. */
export interface TicketLike {
  key: string;
  summary: string;
  status: string;
  url: string;
  updated: string;
  overridden?: true;
}

export interface JiraLike {
  handoff: (TicketLike & { daysInStatus: number | null })[];
  asks: { ticket: TicketLike; author: string; created: string }[];
  /** Keys Jira calls done, overridden ones already left out. */
  done: string[];
}

export interface WeekTaskLike {
  noteId: string;
  listItemId: string | null;
  text: string;
  estMinutes: number | null;
}

export type CandidateReason =
  | { kind: 'handoff'; status: string; days: number | null }
  | { kind: 'ask'; author: string; created: string }
  | { kind: 'week'; week: string };

export interface Candidate {
  /** What to get done: `KEY Summary` for a ticket, the task's own text for a week item. */
  subject: string;
  reason: CandidateReason;
  minutes: number;
  /** The Jira key to pass to `caius_add` as `source`, or the week note's key. */
  source: string;
  keys: string[];
  url?: string;
  /** A Context line says the ticket is open, whatever Jira says. */
  overridden?: true;
  /** A week item: the task to forward. */
  noteId?: string;
  listItemId?: string | null;
}

/** A task line's keys, the way `caius_add` and `caius_dismiss` derive them: its Jira keys and links, else a hash of its text. */
export function keysOf(text: string): string[] {
  const links = markdownLinks(text);
  return taskKeys(links.text, links.urls);
}

/** The keys of every live task in the Journal (Suggested items are not tasks), each with the `noteId/listItemId` of the tasks that carry it. */
export function liveKeys(docs: TriliumDoc[], now: Date): Map<string, string[]> {
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const keys = new Map<string, string[]>();
  for (const task of scanDocs(docs, TRILIUM_CONFIG, now).tasks) {
    if (!task.live) continue;
    const doc = byPath.get(task.file);
    const ref = `${doc?.noteId ?? ''}/${doc?.itemIds.get(task.line) ?? ''}`;
    for (const key of keysOf(task.text)) keys.set(key, [...(keys.get(key) ?? []), ref]);
  }
  return keys;
}

/** Days a done or cancelled task, or a dismissal, keeps its key off every list. */
export const CLOSED_DAYS = 14;
/** Days a ticket Shawn called finished keeps its key off every list. */
export const FINISHED_DAYS = 30;
/** On a day note: Shawn said the ticket is finished, as `#caiusFinished=ZAP-101`. */
export const FINISHED_LABEL = 'caiusFinished';

/**
 * The keys never to offer on the day of `now`, whatever Jira says: those of tasks done or
 * cancelled in a Journal note whose period ends no more than `CLOSED_DAYS` before that day, unless
 * the key is live again (a forwarded task's copy); those dismissed on any period note that recent;
 * and those labelled `#caiusFinished` on a period note no more than `FINISHED_DAYS` back. A done
 * mark carries no date, so the note's period dates it; a note of a later period counts too.
 */
export async function closedKeys(store: NoteReader, docs: TriliumDoc[], now: Date): Promise<Set<string>> {
  const since = (days: number) => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  const recent = (period: { kind: PeriodKind; key: string } | null, days: number) => !!period && periodSpan(period.kind, period.key).end >= since(days);
  const live = liveKeys(docs, now);
  const closed = new Set<string>();
  for (const task of scanDocs(docs, TRILIUM_CONFIG, now).tasks) {
    if (task.state !== 'done' && task.state !== 'cancelled') continue;
    if (!recent(pathPeriod(task.file), CLOSED_DAYS)) continue;
    for (const key of keysOf(task.text)) if (!live.has(key)) closed.add(key);
  }
  for (const [name, days] of [[DISMISSED_LABEL, CLOSED_DAYS], [FINISHED_LABEL, FINISHED_DAYS]] as const) {
    for (const note of await store.search(`#${name}`)) {
      if (!recent(notePeriod(note), days)) continue;
      for (const a of note.attributes) if (a.type === 'label' && a.name === name && a.value) closed.add(a.value);
    }
  }
  return closed;
}

/**
 * The candidates for a day, hand-offs first, then asks (the latest per ticket), then week items,
 * each key once. Left out: a ticket Jira calls done (and a week item that names one), anything whose key is in `exclude` (the day's
 * Suggested items and dismissed keys), a ticket live anywhere in `live`, and a week item whose key
 * is live anywhere but in that item itself. With `since`, only what is newer: asks made after it,
 * hand-offs updated after it, and no week items.
 */
export function dayCandidates(o: {
  jira: JiraLike;
  week?: { key: string; tasks: WeekTaskLike[] };
  live: Map<string, string[]>;
  exclude: Iterable<string>;
  since?: Date;
}): Candidate[] {
  const done = new Set(o.jira.done);
  const taken = new Set(o.exclude);
  const after = (stamp: string) => !o.since || Date.parse(stamp) > o.since.getTime();
  const out: Candidate[] = [];
  const offer = (candidate: Candidate, ownRef?: string) => {
    const liveElsewhere = candidate.keys.some((key) => (o.live.get(key) ?? []).some((ref) => ref !== ownRef));
    if (candidate.keys.some((key) => taken.has(key)) || liveElsewhere) return;
    for (const key of candidate.keys) taken.add(key);
    out.push(candidate);
  };
  const ticket = (t: TicketLike, reason: CandidateReason): Candidate => ({
    subject: `${t.key} ${t.summary}`.trim(), reason, minutes: DEFAULT_ESTIMATE, source: t.key, keys: [t.key], url: t.url,
    ...(t.overridden ? { overridden: t.overridden } : {}),
  });

  for (const t of o.jira.handoff) {
    if (!done.has(t.key) && after(t.updated)) offer(ticket(t, { kind: 'handoff', status: t.status, days: t.daysInStatus }));
  }
  const latest = new Map<string, JiraLike['asks'][number]>();
  for (const ask of o.jira.asks) {
    if (done.has(ask.ticket.key) || !after(ask.created)) continue;
    const seen = latest.get(ask.ticket.key);
    if (!seen || Date.parse(ask.created) > Date.parse(seen.created)) latest.set(ask.ticket.key, ask);
  }
  for (const ask of latest.values()) offer(ticket(ask.ticket, { kind: 'ask', author: ask.author, created: ask.created }));
  if (o.week && !o.since) {
    for (const task of o.week.tasks) {
      if (keysOf(task.text).some((key) => done.has(key))) continue;
      offer({
        subject: task.text, reason: { kind: 'week', week: o.week.key }, minutes: task.estMinutes ?? DEFAULT_ESTIMATE,
        source: o.week.key, keys: keysOf(task.text), noteId: task.noteId, listItemId: task.listItemId,
      }, `${task.noteId}/${task.listItemId ?? ''}`);
    }
  }
  return out;
}

/** The period a Journal path belongs to: `Journal/Daily/2026-11-02.md` and its children's paths. */
function pathPeriod(path: string): { kind: PeriodKind; key: string } | null {
  const m = /^Journal\/(Daily|Weekly|Monthly)\/(\d{4}-(?:W\d{2}|\d{2}-\d{2}|\d{2}))(?![\d-])/.exec(path);
  const kind = m && (m[1] === 'Daily' ? 'day' : m[1] === 'Weekly' ? 'week' : 'month');
  return kind && m[2] ? { kind, key: m[2] } : null;
}

/** The period a note is labelled with, if it is a day, week or month note. */
function notePeriod(note: StoreNote): { kind: PeriodKind; key: string } | null {
  for (const kind of ['day', 'week', 'month'] as const) {
    const key = label(note, PERIODS[kind].label);
    if (key && PERIODS[kind].pattern.test(key)) return { kind, key };
  }
  return null;
}

const dayOf = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
