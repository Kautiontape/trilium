// Section structure of a note's derived markdown: which heading sits above each
// line, what kind of section it is, and which task lines fall under "Suggested".
// Pure string work, shared by journal loading, the day view and open-trilium.

export type SectionKind = 'slot' | 'area' | 'group';

const SLOTS = new Set(['morning', 'afternoon', 'evening']);
const AREAS = new Set(['foundation', 'growth', 'recharge']);

/** Lower-case letters and digits only, so emoji, spacing and punctuation never matter. */
export function normName(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

export function sectionKind(name: string | null): SectionKind {
  const n = name === null ? '' : normName(name);
  return SLOTS.has(n) ? 'slot' : AREAS.has(n) ? 'area' : 'group';
}

export function isSuggestedName(name: string | null): boolean {
  return name !== null && normName(name) === 'suggested';
}

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

/** Per line: the text of the nearest heading at or above it, or null before any heading. */
export function headingsByLine(markdown: string): (string | null)[] {
  let current: string | null = null;
  return markdown.split('\n').map((line) => {
    const m = HEADING.exec(line);
    if (m) current = m[1] || null;
    return current;
  });
}

const TASK_MARK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[.\]\s+/;

/**
 * The markdown the scanner should see: task lines under the Suggested heading lose
 * their checkbox, so they never reach a horizon or capacity. Line numbers don't move.
 * `suggested` holds the 0-based lines that were task lines.
 */
export function neutralizeSuggested(markdown: string): { text: string; suggested: Set<number> } {
  const headings = headingsByLine(markdown);
  const suggested = new Set<number>();
  const text = markdown
    .split('\n')
    .map((line, i) => {
      if (!isSuggestedName(headings[i]!) || HEADING.test(line) || !TASK_MARK.test(line)) return line;
      suggested.add(i);
      return line.replace(TASK_MARK, '$1');
    })
    .join('\n');
  return { text, suggested };
}
