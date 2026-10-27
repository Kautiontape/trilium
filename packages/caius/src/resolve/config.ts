// Resolution config (§7). Baked defaults for the real vault; a JSON override
// file may be supplied later. Glob semantics live in ./glob.ts.

export interface PeriodicHorizonRule {
  match: string;
  /** date-fns-style format token; granularity is inferred (D/W/M). */
  date: string;
  by_date: { current: string; future: string; past: string };
}

export interface StaticHorizonRule {
  match: string;
  horizon: string;
}

export type HorizonRule = PeriodicHorizonRule | StaticHorizonRule;

export function isPeriodicRule(r: HorizonRule): r is PeriodicHorizonRule {
  return 'date' in r;
}

export interface ProjectRule {
  match: string;
  /** literal, or a capture token: {seg1} | {filename} | {folder}. */
  project: string;
}

export interface Config {
  indent: { tab_width: number };
  capacity: { workday_minutes: number };
  horizon_mapping: HorizonRule[];
  horizon_default: string;
  project_mapping: ProjectRule[];
  excluded: string[];
  obsidian: { vault: string; advancedUri: boolean };
  /** Where quick-add capture appends new tasks. A `string` is a static
   * vault-relative path (e.g. an Inbox note); `null` means "use today's daily
   * note, computed dynamically at capture time" (see `defaultCaptureNote`). */
  captureNote: string | null;
}

/** The default capture note for a given moment: today's Daily periodic note,
 * `02 - Periodic/Daily/YYYY/MM/YYYY-MM-DD.md` (zero-padded month/day), matching
 * the Daily horizon folder structure. Used when neither the request nor the
 * config pins an explicit capture note. */
export function defaultCaptureNote(now: Date): string {
  const yyyy = String(now.getFullYear()).padStart(4, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `02 - Periodic/Daily/${yyyy}/${mm}/${yyyy}-${mm}-${dd}.md`;
}

/** The concrete §7 configuration for `/home/shawn/documents/obsidian/Main`. */
export const DEFAULT_CONFIG: Config = {
  indent: { tab_width: 4 },
  capacity: { workday_minutes: 480 },
  horizon_mapping: [
    {
      match: '02 - Periodic/Daily/**/*.md',
      date: 'YYYY-MM-DD',
      by_date: { current: 'today', future: 'week', past: 'overdue' },
    },
    {
      match: '02 - Periodic/Weekly/**/*.md',
      date: 'GGGG-[W]WW',
      by_date: { current: 'week', future: 'orbit', past: 'overdue' },
    },
    {
      match: '02 - Periodic/Monthly/**/*.md',
      date: 'YYYY-MM',
      by_date: { current: 'orbit', future: 'planning_ahead', past: 'overdue' },
    },
    { match: '10 - Project/**/*.md', horizon: 'someday' },
    { match: '20 - Area/**/*.md', horizon: 'someday' },
  ],
  horizon_default: 'someday',
  project_mapping: [
    { match: '10 - Project/*/**/*.md', project: '{seg1}' },
    { match: '10 - Project/*.md', project: '{filename}' },
  ],
  obsidian: { vault: 'Main', advancedUri: false },
  captureNote: null,
  excluded: [
    '01 - Inbox/**',
    '30 - Resources/**',
    '80 - Archive/**',
    '90 - Maintenance/**',
    '91 - Testing/**',
    '95 - System/**',
    '99 - Scripts/**',
    '99 - Templates/**',
    '.obsidian/**',
    '.trash/**',
  ],
};
