// Read one periodic note (day, week or month) as a plan: critical block, tasks
// by section in priority order, the On deck tasks, the Suggested lane, what was dismissed, and
// how much time the live tasks add up to. Read-only; never creates a note.

import { now as clock } from '../clock.js';
import { scanDocs, type IndexedTask } from '../index/index.js';
import { oldestFirst, type NoteReader, type StoreNote } from './store.js';
import { buildDoc, loadStateSymbols, type TriliumDoc } from './journal.js';
import { TRILIUM_CONFIG } from './config.js';
import { headingStacks, headingsByLine, isSuggestedName, normName, sectionKind, type SectionKind } from './sections.js';
import { AREAS, blockOf, clockOf, headingArea, markedArea, type Area, type Block } from './areas.js';
import { parentItemId } from './open.js';
import { parseContext, periodSpan, type ContextLine } from './until.js';

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
export function isoWeekKey(date: Date): string {
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
  /** Its area: its marker, else an area heading above it, else Foundation (see `areaOfTask`). */
  area: Area;
  /** The time block heading above it (Morning, Afternoon, Evening), or null. */
  block: Block | null;
  /** The `HH:MM` its text starts with, which pins it to that time; null when it has none. */
  at: string | null;
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
  /** On a day note, minutes of the live Growth and Recharge tasks, which the counts above leave out: not work. */
  eveningMinutes: number;
  /**
   * Live minutes by area (unestimated at 30) and each area's target. On a day note the counts above
   * are Foundation's; a week's or month's count every area.
   */
  areas: Record<Area, { minutes: number; target: { min: number; max: number } | null }>;
  /** Minutes of the live On deck tasks (unestimated at 30), which the counts above leave out: not committed. */
  onDeckMinutes: number;
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
  /** The tasks under the On deck heading, in any state: intended for the day, tracked, but not on the list until planned. */
  onDeck: PlanTask[];
  suggested: PlanTask[];
  /** Source keys dismissed on this note (`#caiusDismissed`). */
  dismissed: string[];
  capacity: Capacity;
  /** The bullets under `### Meetings`, as written (`10:00 Standup (Sasha)`). */
  meetings: string[];
  /** The Context lines in force on the plan's date. */
  context: ContextLine[];
  /** Context lines whose `(until …)` date is before the plan's date. */
  expiredContext: ContextLine[];
  /** Context lines whose `(from …)` date is after the plan's date. */
  pendingContext: ContextLine[];
}

/** A day's targets for Growth and Recharge; Foundation's is the day's `TARGETS`. */
export const AREA_TARGETS: Record<Exclude<Area, 'foundation'>, { min: number; max: number } | null> = {
  growth: { min: 60, max: 120 },
  recharge: null,
};

/**
 * A task's area: its marker; else the nearest Foundation, Growth or Recharge heading above it (a note
 * laid out by area); else Recharge for a task under an Evening heading on a note with no Morning or
 * Afternoon heading (the evening before time blocks, which was never work); else Foundation.
 */
export function areaOfTask(text: string, headings: string[], timeBlocks: boolean): Area {
  const headed = headings.map(headingArea).findLast((a) => a !== null);
  if (markedArea(text)) return markedArea(text)!;
  if (headed) return headed;
  return !timeBlocks && headings.some((h) => blockOf(h) === 'evening') ? 'recharge' : 'foundation';
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

/**
 * Every note labelled for a period, without creating one, oldest first. Trilium's calendar can make
 * a second note for a period it failed to find; the older one is the period's note, whatever the
 * newer one holds, so callers take the first.
 */
export async function findPeriodNotes(api: NoteReader, period: PeriodKind, key: string): Promise<StoreNote[]> {
  const name = PERIODS[period].label;
  const found = api.periodNotes ? await api.periodNotes(name, key) : await api.search(periodQuery(name, key));
  const exact = found.filter((n) => n.attributes.some((a) => a.type === 'label' && a.name === name && a.value === key));
  return oldestFirst(exact.length ? exact : found);
}

/** Find a periodic note by its label, without creating it: the oldest of several (`findPeriodNotes`). */
export async function findPeriodNote(api: NoteReader, period: PeriodKind, key: string): Promise<StoreNote | null> {
  return (await findPeriodNotes(api, period, key))[0] ?? null;
}

/**
 * A warning for each period that has more than one note: "2026-10-28 has a second day note B; using
 * the older A." Nothing is merged or deleted; the newer note's tasks still count as the period's
 * open tasks (see `loadJournal`). Each period is looked at once.
 */
export async function duplicateWarnings(api: NoteReader, periods: { period: PeriodKind; key: string }[]): Promise<string[]> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const { period, key } of periods) {
    if (seen.has(key) || !isPeriodKey(period, key)) continue;
    seen.add(key);
    const [kept, ...others] = await findPeriodNotes(api, period, key);
    if (!kept || !others.length) continue;
    const ids = others.map((n) => n.noteId).join(', ');
    warnings.push(
      others.length === 1
        ? `${key} has a second ${period} note ${ids}; using the older ${kept.noteId}.`
        : `${key} has ${others.length} more ${period} notes (${ids}); using the oldest ${kept.noteId}.`,
    );
  }
  return warnings;
}

/** The scanner's view of a doc's full text (Suggested items included), one PlanTask per task line. */
export function planTasks(doc: TriliumDoc, now: Date): { tasks: (PlanTask & { line: number; horizon: string | null; live: boolean })[] } {
  const result = scanDocs([{ path: doc.path, text: doc.fullText, mtime: doc.mtime }], TRILIUM_CONFIG, now);
  const headings = headingsByLine(doc.fullText);
  const stacks = headingStacks(doc.fullText);
  const timeBlocks = stacks.some((stack) => stack.some((h) => blockOf(h) === 'morning' || blockOf(h) === 'afternoon'));
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
      area: areaOfTask(t.text, stacks[t.line] ?? [], timeBlocks),
      block: (stacks[t.line] ?? []).map(blockOf).findLast((b) => b !== null) ?? null,
      at: clockOf(t.text),
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
  const isOnDeck = (t: { line: number }) => doc.onDeck.has(t.line);
  const main = all.filter((t) => !isSuggested(t) && !isOnDeck(t));
  const deck = all.filter(isOnDeck);
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

  // A live task with live sub-items counts through its sub-items, not twice. An empty to-do is a
  // blank checkbox, not a task, and neither counts nor makes its parent a parent.
  const countable = main.filter((t) => t.live && t.text.trim() !== '');
  const parents = new Set(countable.filter((t) => t.parent !== null).map((t) => t.parent));
  // Only a day's Growth and Recharge are apart from its work; a week's or month's are planned time.
  const leaves = countable.filter((t) => !parents.has(t.text));
  const apart = (t: { area: Area }) => period === 'day' && t.area !== 'foundation';
  const evening = leaves.filter(apart);
  const counted = leaves.filter((t) => !apart(t));
  const minutesOf = (area: Area) => leaves.filter((t) => t.area === area).reduce((n, t) => n + (t.estMinutes ?? DEFAULT_ESTIMATE), 0);
  const estimated = counted.filter((t) => t.estMinutes !== null);
  const planned = estimated.reduce((n, t) => n + t.estMinutes!, 0);
  const unestimated = counted.length - estimated.length;
  const deckCountable = deck.filter((t) => t.live && t.text.trim() !== '');
  const deckParents = new Set(deckCountable.filter((t) => t.parent !== null).map((t) => t.parent));
  const onDeckMinutes = deckCountable.filter((t) => !deckParents.has(t.text)).reduce((n, t) => n + (t.estMinutes ?? DEFAULT_ESTIMATE), 0);
  const horizons: Record<string, number> = {};
  for (const t of [...main, ...deck].filter((x) => x.live)) horizons[t.horizon ?? 'none'] = (horizons[t.horizon ?? 'none'] ?? 0) + 1;

  return {
    period,
    key,
    noteId: doc.noteId,
    critical: critical.map(strip),
    sections,
    top3,
    onDeck: deck.map(strip),
    suggested: all.filter((t) => isSuggested(t) && t.live).map(strip),
    dismissed,
    capacity: {
      plannedMinutes: planned,
      estimatedCount: estimated.length,
      unestimatedCount: unestimated,
      unestimatedMinutes: unestimated * DEFAULT_ESTIMATE,
      totalMinutes: planned + unestimated * DEFAULT_ESTIMATE,
      eveningMinutes: evening.reduce((n, t) => n + (t.estMinutes ?? DEFAULT_ESTIMATE), 0),
      onDeckMinutes,
      target: TARGETS[period],
      areas: Object.fromEntries(AREAS.map((area) => [
        area,
        { minutes: minutesOf(area), target: period !== 'day' ? null : area === 'foundation' ? TARGETS.day : AREA_TARGETS[area] },
      ])) as Capacity['areas'],
      horizons,
    },
    meetings: doc.meetings,
    ...parseContext(doc.contextLines, periodSpan(period, key).start, planDate(period, key, now)),
  };
}


/**
 * The day Context expires against: the day itself, or `now` when it falls inside the week or
 * month (otherwise the nearer end of it).
 */
function planDate(period: PeriodKind, key: string, now: Date): string {
  const { start, end } = periodSpan(period, key);
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return today < start ? start : today > end ? end : today;
}

function emptyView(period: PeriodKind, key: string): PlanView {
  return {
    period,
    key,
    noteId: null,
    critical: [],
    sections: [],
    top3: [],
    onDeck: [],
    suggested: [],
    dismissed: [],
    capacity: {
      plannedMinutes: 0,
      estimatedCount: 0,
      unestimatedCount: 0,
      unestimatedMinutes: 0,
      totalMinutes: 0,
      eveningMinutes: 0,
      onDeckMinutes: 0,
      target: TARGETS[period],
      areas: Object.fromEntries(AREAS.map((area) => [
        area,
        { minutes: 0, target: period !== 'day' ? null : area === 'foundation' ? TARGETS.day : AREA_TARGETS[area] },
      ])) as Capacity['areas'],
      horizons: {},
    },
    meetings: [],
    context: [],
    expiredContext: [],
    pendingContext: [],
  };
}

/** Read one day, week or month note. A missing note gives an empty view with `noteId: null`. */
export async function readPlan(api: NoteReader, period: PeriodKind, key: string, now: Date = clock()): Promise<PlanView> {
  const note = await findPeriodNote(api, period, key);
  if (!note) return emptyView(period, key);
  if (note.type !== 'text' || note.isProtected) throw new Error(`${period} note ${note.noteId} is protected or not a text note`);
  const states = await loadStateSymbols(api);
  const doc = buildDoc(note, periodPath(period, key), await api.content(note.noteId), states);
  return buildPlanView(period, key, doc, dismissedKeys(note), now);
}

/**
 * The plans of a period's other notes, newer than the one `readPlan` reads (`findPeriodNotes`),
 * each read the same way. A protected or non-text one is left out. Their open tasks are still the
 * period's open tasks, so what counts a period's leftovers counts these too.
 */
export async function readDuplicatePlans(api: NoteReader, period: PeriodKind, key: string, now: Date = clock()): Promise<PlanView[]> {
  const others = (await findPeriodNotes(api, period, key)).slice(1).filter((note) => note.type === 'text' && !note.isProtected);
  if (!others.length) return [];
  const states = await loadStateSymbols(api);
  const plans: PlanView[] = [];
  for (const note of others) {
    const doc = buildDoc(note, `Journal/${PERIODS[period].folder}/${key}/${key} (${note.noteId}).md`, await api.content(note.noteId), states);
    plans.push(buildPlanView(period, key, doc, dismissedKeys(note), now));
  }
  return plans;
}

export { isSuggestedName };
