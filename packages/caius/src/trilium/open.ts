// The live (open or in-progress) tasks of a scanned Journal, each with the
// Trilium note it sits in, for callers outside Caius (the daily brief) that
// need "what's still open, and where" without reading the index.

import type { ScanResult } from '../index/index.js';
import { TRILIUM_CONFIG } from './config.js';
import type { TriliumDoc } from './journal.js';
import { headingsByLine, sectionKind, type SectionKind } from './sections.js';
import { scanDocs } from '../index/index.js';

export interface OpenTask {
  noteId: string;
  /** The period the note belongs to: 2026-10-26, 2026-W44 or 2026-10. */
  period: string;
  path: string;
  line: number;
  /** The `<li data-list-item-id>` to pass to `caius forward`; null if the item has none. */
  listItemId: string | null;
  state: 'open' | 'in_progress';
  horizon: string | null;
  text: string;
  /** The parent task's text, when this is a sub-item. */
  parent: string | null;
  /** The parent task's list item id, when this is a sub-item and the parent has one. */
  parentListItemId: string | null;
  /** Nearest heading above the task, null before any heading. */
  section: string | null;
  sectionKind: SectionKind;
  /** Inside an Important block (importance tier 3 in the derived markdown only). */
  critical: boolean;
  /** Under the On deck heading: intended for its day, not committed. */
  onDeck: boolean;
  /** Position in the note's priority order among the tasks listed here: critical first, then document order. */
  rank: number;
}

/** The list item id of `parent`, a task of `doc`, or null without one. */
export function parentItemId(doc: Pick<TriliumDoc, 'itemIds'>, parent: { line: number } | undefined): string | null {
  return parent ? (doc.itemIds.get(parent.line) ?? null) : null;
}

export function openTasks(docs: TriliumDoc[], result: ScanResult): OpenTask[] {
  const noteIdByPath = new Map(docs.map((d) => [d.path, d.noteId]));
  const idsByPath = new Map(docs.map((d) => [d.path, d.itemIds]));
  const textByRowid = new Map(result.tasks.map((t) => [t.rowid, t.text]));
  const taskByRowid = new Map(result.tasks.map((t) => [t.rowid, t]));
  const docByPath = new Map(docs.map((d) => [d.path, d]));
  const headingsByPath = new Map(docs.map((d) => [d.path, headingsByLine(d.fullText)]));
  const tasks = result.tasks
    .filter((t) => t.live)
    .map((t): OpenTask => {
      const section = headingsByPath.get(t.file)?.[t.line] ?? null;
      return {
      noteId: noteIdByPath.get(t.file) ?? '',
      period: t.file.match(/^Journal\/\w+\/([^/]+?)(?:\.md|\/)/)?.[1] ?? '',
      path: t.file,
      line: t.line,
      listItemId: idsByPath.get(t.file)?.get(t.line) ?? null,
      state: t.state as OpenTask['state'],
      horizon: t.horizon,
      text: t.text,
      parent: t.parentRowid === null ? null : (textByRowid.get(t.parentRowid) ?? null),
      parentListItemId: parentItemId(
        { itemIds: idsByPath.get(t.file) ?? new Map() },
        t.parentRowid === null ? undefined : taskByRowid.get(t.parentRowid),
      ),
      section,
      sectionKind: sectionKind(section),
      critical: docByPath.get(t.file)?.critical.has(t.line) ?? false,
      onDeck: docByPath.get(t.file)?.onDeck.has(t.line) ?? false,
      rank: 0,
      };
    });
  // Priority order within each note: critical first, then document order.
  const byNote = new Map<string, OpenTask[]>();
  for (const t of tasks) byNote.set(t.path, [...(byNote.get(t.path) ?? []), t]);
  for (const list of byNote.values()) {
    [...list].sort((a, b) => Number(b.critical) - Number(a.critical) || a.line - b.line).forEach((t, i) => (t.rank = i));
  }
  return tasks;
}

/**
 * Live tasks under each note's Suggested heading, the `suggested` lane. They are
 * left out of `openTasks` (and so of every horizon); this reads them separately.
 */
export function suggestedTasks(docs: TriliumDoc[], now: Date): OpenTask[] {
  const withSuggested = docs.filter((d) => d.suggested.size > 0);
  if (!withSuggested.length) return [];
  const result = scanDocs(
    withSuggested.map((d) => ({ path: d.path, text: d.fullText, mtime: d.mtime })),
    TRILIUM_CONFIG,
    now,
  );
  const byPath = new Map(withSuggested.map((d) => [d.path, d]));
  const textByRowid = new Map(result.tasks.map((t) => [t.rowid, t.text]));
  const taskByRowid = new Map(result.tasks.map((t) => [t.rowid, t]));
  return result.tasks
    .filter((t) => t.live && byPath.get(t.file)!.suggested.has(t.line))
    .map((t, i): OpenTask => {
      const doc = byPath.get(t.file)!;
      const section = headingsByLine(doc.fullText)[t.line] ?? null;
      return {
        noteId: doc.noteId,
        period: t.file.match(/^Journal\/\w+\/([^/]+?)(?:\.md|\/)/)?.[1] ?? '',
        path: t.file,
        line: t.line,
        listItemId: doc.itemIds.get(t.line) ?? null,
        state: t.state as OpenTask['state'],
        horizon: null,
        text: t.text,
        parent: t.parentRowid === null ? null : (textByRowid.get(t.parentRowid) ?? null),
        parentListItemId: parentItemId(doc, t.parentRowid === null ? undefined : taskByRowid.get(t.parentRowid)),
        section,
        sectionKind: sectionKind(section),
        critical: false,
        onDeck: false,
        rank: i,
      };
    });
}

const DAY_MS = 86_400_000;

/**
 * Whole days between the last day of a period (`2026-10-26`, `2026-W44` or
 * `2026-10`) and `now`'s calendar day, never negative. A task in a past period
 * is that many days late; null when the key is not a period.
 */
export function daysLate(period: string, now: Date): number | null {
  const end = periodEnd(period);
  if (end === null) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - end) / DAY_MS));
}

/** The last day of a period as UTC midnight, or null if the key is malformed. */
function periodEnd(period: string): number | null {
  const day = period.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!);
  const month = period.match(/^(\d{4})-(\d{2})$/);
  if (month) return Date.UTC(+month[1]!, +month[2]!, 0);
  const week = period.match(/^(\d{4})-W(\d{2})$/);
  if (week) {
    // ISO week 1 contains 4 January; weeks run Monday to Sunday.
    const jan4 = new Date(Date.UTC(+week[1]!, 0, 4));
    const monday1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS;
    return monday1 + ((+week[2]! - 1) * 7 + 6) * DAY_MS;
  }
  return null;
}
