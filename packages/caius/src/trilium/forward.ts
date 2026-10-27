// Forward a task from one Trilium day, week or month note to another, the way Shawn does it by
// hand: the old copy becomes Rescheduled with a "scheduled <day>" note, and an
// open copy appears under the same section of the target day.
//
// Safety, in order: both notes are read; the new HTML is built in memory; each
// write is a compare-and-swap against the HTML it was built from, so a note that
// changed since the read is left alone (the edit guard); the target is written
// before the source, so a failure never leaves a task marked moved with no copy.
// Re-running is safe: an
// item already Rescheduled is skipped, and a copy already sitting in the target
// (a forward that died between the two writes) is not duplicated.

import { label, type NoteReader, type NoteStore, type StoreNote } from './store.js';
import { loadStateSymbols } from './journal.js';
import { isPeriodKey, PERIODS, periodQuery, type PeriodKind } from './plan-read.js';
import { periodLabel, hasCopy, insertCopy, markRescheduled, type ItemProblem } from './forward-html.js';
import type { StateSymbols } from './markdown.js';

export interface ForwardRequest {
  noteId: string;
  listItemId: string;
  /** Target day YYYY-MM-DD, ISO week YYYY-Www or month YYYY-MM. */
  to: string;
}

/** Weeks and months are only needed when a request targets one. */
export type ForwardStore = NoteReader & Partial<Pick<NoteStore, 'calendarWeek' | 'calendarMonth'>>;

/** `stale` is reported by a host that checks the note's version before it calls the library. */
export type SkipReason = ItemProblem | 'edited' | 'same_day' | 'bad_request' | 'unreadable' | 'stale';

export type ForwardResult = ForwardRequest &
  (
    | { status: 'moved'; detail?: string; dryRun?: boolean; changes?: NoteChange[] }
    | { status: 'skipped'; reason: SkipReason; detail?: string }
    | { status: 'failed'; error: string }
  );

export interface NoteChange {
  noteId: string;
  role: 'target' | 'source';
  /** Present only on a dry run. */
  before?: string;
  after?: string;
  /** True when the note needs no write (the target already holds the copy). */
  unchanged?: boolean;
}

export interface ForwardOptions {
  dryRun?: boolean;
  /** Overrides for tests. */
  states?: StateSymbols;
  newId?: () => string;
}

export async function forwardTasks(api: ForwardStore, requests: ForwardRequest[], opts: ForwardOptions = {}): Promise<ForwardResult[]> {
  const states = opts.states ?? (await loadStateSymbols(api));
  const stateId = [...states].find(([, symbol]) => symbol === '>')?.[0] ?? '_rescheduled';
  const periods = new Map<string, StoreNote | null>();

  const period = async (kind: PeriodKind, key: string): Promise<StoreNote | null> => {
    if (periods.has(key)) return periods.get(key)!;
    let note: StoreNote | null;
    if (opts.dryRun) {
      // The calendar endpoint creates missing notes, so a dry run only searches.
      note = (await api.search(periodQuery(PERIODS[kind].label, key)))[0] ?? null;
    } else {
      const create = { day: api.calendarDay, week: api.calendarWeek, month: api.calendarMonth }[kind];
      if (!create) throw new Error(`this store cannot create ${kind} notes`);
      note = await create.call(api, key);
    }
    periods.set(key, note);
    return note;
  };

  const results: ForwardResult[] = [];
  for (const req of requests) {
    try {
      results.push(await forwardOne(api, req, { ...opts, states, stateId }, period));
    } catch (e) {
      results.push({ ...req, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

async function forwardOne(
  api: ForwardStore,
  req: ForwardRequest,
  opts: ForwardOptions & { states: StateSymbols; stateId: string },
  period: (kind: PeriodKind, key: string) => Promise<StoreNote | null>,
): Promise<ForwardResult> {
  const skip = (reason: SkipReason, detail?: string): ForwardResult => ({ ...req, status: 'skipped', reason, detail });
  const kind = periodKind(req.to);
  if (!req.noteId || !req.listItemId || !kind) {
    return skip('bad_request', 'need noteId, listItemId and to as YYYY-MM-DD, YYYY-Www or YYYY-MM');
  }

  const source = await api.note(req.noteId);
  if (source.type !== 'text' || source.isProtected) return skip('unreadable', 'source is protected or not a text note');
  const target = await period(kind, req.to);
  if (target && target.noteId === source.noteId) return skip('same_day', 'same note: the task is already in that note');
  if (target && (target.type !== 'text' || target.isProtected)) return skip('unreadable', 'target is protected or not a text note');

  const sourceHtml = await api.content(source.noteId);
  // A dry run for a day that doesn't exist yet previews against an empty note.
  const targetHtml = target ? await api.content(target.noteId) : '';
  const targetId = target?.noteId ?? `NEW-${kind.toUpperCase()}-NOTE`;

  const sourceKey = periodKey(source);
  const sourceLabel = sourceKey ? periodLabel(sourceKey, yearOf(req.to)) : source.title;
  const base = { states: opts.states, stateId: opts.stateId };

  const marked = markRescheduled(sourceHtml, req.listItemId, {
    ...base,
    targetNoteId: targetId,
    targetLabel: periodLabel(req.to, sourceKey ? yearOf(sourceKey) : undefined),
  });
  if (!marked.ok) {
    if (marked.reason === 'already_moved') {
      const here = marked.scheduledTo.includes(targetId);
      return skip('already_moved', here ? `already scheduled for ${req.to}` : 'already rescheduled to another day');
    }
    return skip(marked.reason);
  }

  const alreadyCopied = hasCopy(targetHtml, sourceHtml, req.listItemId, source.noteId);
  let newTarget = targetHtml;
  if (!alreadyCopied) {
    const inserted = insertCopy(targetHtml, sourceHtml, req.listItemId, {
      ...base,
      sourceNoteId: source.noteId,
      sourceLabel,
      newId: opts.newId,
    });
    if (!inserted.ok) return skip(inserted.reason);
    newTarget = inserted.html;
  }

  if (opts.dryRun) {
    return {
      ...req,
      status: 'moved',
      dryRun: true,
      detail: target ? undefined : `${req.to} has no ${kind} note yet; a real run would create it`,
      changes: [
        { noteId: targetId, role: 'target', before: targetHtml, after: newTarget, unchanged: alreadyCopied },
        { noteId: source.noteId, role: 'source', before: sourceHtml, after: marked.html },
      ],
    };
  }

  // Target first, each behind its own guard.
  if (!alreadyCopied && !(await api.putContent(target!.noteId, newTarget, targetHtml))) {
    return skip('edited', `${req.to} changed while forwarding; nothing written`);
  }
  if (!(await api.putContent(source.noteId, marked.html, sourceHtml))) {
    return {
      ...req,
      status: 'failed',
      error: alreadyCopied
        ? 'source note changed while forwarding; nothing written'
        : 'source note changed after the copy was written; re-run to finish marking it',
    };
  }
  return { ...req, status: 'moved', detail: alreadyCopied ? 'target already held the copy' : undefined };
}

/** The period a `to` value names, or null when it isn't a day, ISO week or month that exists. */
function periodKind(to: string | undefined): PeriodKind | null {
  return (['day', 'week', 'month'] as const).find((kind) => isPeriodKey(kind, to ?? '')) ?? null;
}

/** The day, week or month a note stands for, from its label. */
function periodKey(note: StoreNote): string | undefined {
  return label(note, 'dateNote') ?? label(note, 'weekNote') ?? label(note, 'monthNote');
}

const yearOf = (key: string) => Number(key.slice(0, 4));
