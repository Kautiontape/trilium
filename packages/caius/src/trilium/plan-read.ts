// Read one periodic note (day, week or month) as a plan: critical block, tasks
// by section in priority order, the Suggested lane, what was dismissed, and
// how much time the live tasks add up to. Read-only; never creates a note.

import { scanDocs, type IndexedTask } from '../index/index.js';
import { label, type NoteReader, type StoreNote } from './store.js';
import { buildDoc, loadStateSymbols, type TriliumDoc } from './journal.js';
import { TRILIUM_CONFIG } from './config.js';
import { headingsByLine, isSuggestedName, sectionKind, type SectionKind } from './sections.js';
import { parentItemId } from './open.js';

export type PeriodKind = 'day' | 'week' | 'month';

export const PERIODS = {
  day: { label: 'dateNote', folder: 'Daily', pattern: /^\d{4}-\d{2}-\d{2}$/, shape: 'YYYY-MM-DD' },
  week: { label: 'weekNote', folder: 'Weekly', pattern: /^\d{4}-W\d{2}$/, shape: 'YYYY-Www' },
  month: { label: 'monthNote', folder: 'Monthly', pattern: /^\d{4}-\d{2}$/, shape: 'YYYY-MM' },
} as const;

/**
 * Whether `key` names a period that exists: a calendar day, a month 01–12, or an ISO week the
 * year has (`2026-W53` exists, `2025-W53` doesn't). The key is parsed and formatted back, and
 * must come out the same.
 */
export function isPeriodKey(kind: PeriodKind, key: string): boolean {
  if (!PERIODS[kind].pattern.test(key)) return false;
  const year = Number(key.slice(0, 4));
  if (kind === 'week') {
    const jan4 = Date.UTC(year, 0, 4);
    const firstMonday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    return isoWeekKey(new Date(firstMonday + (Number(key.slice(6)) - 1) * 7 * DAY_MS)) === key;
  }
  const date = new Date(Date.UTC(year, Number(key.slice(5, 7)) - 1, kind === 'day' ? Number(key.slice(8)) : 1));
  return date.toISOString().slice(0, key.length) === key;
}

const DAY_MS = 86_400_000;

/** `YYYY-Www` for a UTC date: the year and number of its week's Thursday. */
function isoWeekKey(date: Date): string {
  const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const DISMISSED_LABEL = 'caiusDismissed';
/** Minutes assumed for a live task with no `~est` token. */
export const DEFAULT_ESTIMATE = 30;

export interface PlanTask {
  noteId: string;
  /** The `<li data-list-item-id>` to pass to the write commands; null if the item has none. */
  listItemId: string | null;
  state: IndexedTask['state'];
  text: string;
  estMinutes: number | null;
  /** The parent task's text when this is a sub-item. */
  parent: string | null;
  /** The parent task's list item id when this is a sub-item and the parent has one. */
  parentListItemId: string | null;
  /** Nearest heading above the task, null before any heading. */
  section: string | null;
  critical: boolean;
}

export interface PlanSection {
  name: string | null;
  kind: SectionKind;
  tasks: PlanTask[];
}

export interface Capacity {
  /** Minutes from `~est` tokens on live tasks. */
  plannedMinutes: number;
  estimatedCount: number;
  unestimatedCount: number;
  /** unestimatedCount x 30 */
  unestimatedMinutes: number;
  totalMinutes: number;
  /** Suggested range for this period (minutes), null when there is none (a month). */
  target: { min: number; max: number } | null;
  /** Live tasks by horizon (today, week, orbit, overdue, …). */
  horizons: Record<string, number>;
}

export interface PlanView {
  period: PeriodKind;
  key: string;
  /** null when the note doesn't exist (reading never creates it). */
  noteId: string | null;
  critical: PlanTask[];
  sections: PlanSection[];
  top3: PlanTask[];
  suggested: PlanTask[];
  /** Source keys dismissed on this note (`#caiusDismissed`). */
  dismissed: string[];
  capacity: Capacity;
}

const TARGETS: Record<PeriodKind, { min: number; max: number } | null> = {
  day: { min: 180, max: 240 },
  week: { min: 720, max: 900 },
  month: null,
};

export function periodPath(period: PeriodKind, key: string): string {
  return `Journal/${PERIODS[period].folder}/${key}.md`;
}

export function dismissedKeys(note: Pick<StoreNote, 'attributes'>): string[] {
  return note.attributes.filter((a) => a.type === 'label' && a.name === DISMISSED_LABEL).map((a) => a.value);
}

/** The search for a periodic note. The value must be quoted: Trilium reads a bare `2026-10-26` as arithmetic. */
export function periodQuery(labelName: string, key: string): string {
  return `#${labelName}="${key}"`;
}

/** Find a periodic note by its label, without creating it. */
export async function findPeriodNote(api: NoteReader, period: PeriodKind, key: string): Promise<StoreNote | null> {
  const found = await api.search(periodQuery(PERIODS[period].label, key));
  return found.find((n) => label(n, PERIODS[period].label) === key) ?? found[0] ?? null;
}

/** The scanner's view of a doc's full text (Suggested items included), one PlanTask per task line. */
export function planTasks(doc: TriliumDoc, now: Date): { tasks: (PlanTask & { line: number; horizon: string | null; live: boolean })[] } {
  const result = scanDocs([{ path: doc.path, text: doc.fullText, mtime: doc.mtime }], TRILIUM_CONFIG, now);
  const headings = headingsByLine(doc.fullText);
  const byRowid = new Map(result.tasks.map((t) => [t.rowid, t]));
  return {
    tasks: result.tasks.map((t) => ({
      noteId: doc.noteId,
      listItemId: doc.itemIds.get(t.line) ?? null,
      state: t.state,
      text: t.text,
      estMinutes: t.estMinutes,
      parent: t.parentRowid === null ? null : (byRowid.get(t.parentRowid)?.text ?? null),
      parentListItemId: parentItemId(doc, t.parentRowid === null ? undefined : byRowid.get(t.parentRowid)),
      section: headings[t.line] ?? null,
      critical: doc.critical.has(t.line),
      line: t.line,
      horizon: doc.suggested.has(t.line) ? null : t.horizon,
      live: t.live,
    })),
  };
}

const strip = ({ line: _l, horizon: _h, live: _v, ...task }: PlanTask & { line: number; horizon: string | null; live: boolean }): PlanTask => task;

export function buildPlanView(period: PeriodKind, key: string, doc: TriliumDoc, dismissed: string[], now: Date): PlanView {
  const all = planTasks(doc, now).tasks;
  const isSuggested = (t: { line: number }) => doc.suggested.has(t.line);
  const main = all.filter((t) => !isSuggested(t));
  const critical = main.filter((t) => t.critical);

  const sections: PlanSection[] = [];
  for (const t of main.filter((x) => !x.critical)) {
    let s = sections[sections.length - 1];
    if (!s || s.name !== t.section) {
      s = { name: t.section, kind: sectionKind(t.section), tasks: [] };
      sections.push(s);
    }
    s.tasks.push(strip(t));
  }

  const isLive = (t: { live: boolean }) => t.live;
  const top3 = main.filter((t) => !t.critical && t.parent === null && isLive(t)).slice(0, 3).map(strip);

  // A live task with live sub-items counts through its sub-items, not twice.
  const parents = new Set(main.filter((t) => t.live && t.parent !== null).map((t) => t.parent));
  const counted = main.filter((t) => t.live && !parents.has(t.text));
  const estimated = counted.filter((t) => t.estMinutes !== null);
  const planned = estimated.reduce((n, t) => n + t.estMinutes!, 0);
  const unestimated = counted.length - estimated.length;
  const horizons: Record<string, number> = {};
  for (const t of main.filter((x) => x.live)) horizons[t.horizon ?? 'none'] = (horizons[t.horizon ?? 'none'] ?? 0) + 1;

  return {
    period,
    key,
    noteId: doc.noteId,
    critical: critical.map(strip),
    sections,
    top3,
    suggested: all.filter((t) => isSuggested(t) && t.live).map(strip),
    dismissed,
    capacity: {
      plannedMinutes: planned,
      estimatedCount: estimated.length,
      unestimatedCount: unestimated,
      unestimatedMinutes: unestimated * DEFAULT_ESTIMATE,
      totalMinutes: planned + unestimated * DEFAULT_ESTIMATE,
      target: TARGETS[period],
      horizons,
    },
  };
}

function emptyView(period: PeriodKind, key: string): PlanView {
  return {
    period,
    key,
    noteId: null,
    critical: [],
    sections: [],
    top3: [],
    suggested: [],
    dismissed: [],
    capacity: {
      plannedMinutes: 0,
      estimatedCount: 0,
      unestimatedCount: 0,
      unestimatedMinutes: 0,
      totalMinutes: 0,
      target: TARGETS[period],
      horizons: {},
    },
  };
}

/** Read one day, week or month note. A missing note gives an empty view with `noteId: null`. */
export async function readPlan(api: NoteReader, period: PeriodKind, key: string, now: Date = new Date()): Promise<PlanView> {
  const note = await findPeriodNote(api, period, key);
  if (!note) return emptyView(period, key);
  if (note.type !== 'text' || note.isProtected) throw new Error(`${period} note ${note.noteId} is protected or not a text note`);
  const states = await loadStateSymbols(api);
  const doc = buildDoc(note, periodPath(period, key), await api.content(note.noteId), states);
  return buildPlanView(period, key, doc, dismissedKeys(note), now);
}

export { isSuggestedName };
