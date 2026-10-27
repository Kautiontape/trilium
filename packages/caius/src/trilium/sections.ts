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

/** The sections that hold plain bullets written by the planner or by the user, never tasks. */
export type ProseKind = 'meetings' | 'context';

export function proseKind(name: string | null): ProseKind | null {
  const n = name === null ? '' : normName(name);
  return n === 'meetings' || n === 'context' ? n : null;
}

/**
 * Follows headings in document order and says which Meetings or Context section the next block
 * is in. A section runs to the next heading of the same or a higher level, so a lower heading
 * inside it stays part of it.
 */
export class ProseTracker {
  private stack: { level: number; kind: ProseKind | null }[] = [];

  enter(name: string | null, level: number): void {
    while (this.stack.length && this.stack[this.stack.length - 1]!.level >= level) this.stack.pop();
    this.stack.push({ level, kind: proseKind(name) });
  }

  get kind(): ProseKind | null {
    return this.stack.find((h) => h.kind)?.kind ?? null;
  }
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Per line: the text of the nearest heading at or above it, or null before any heading. */
export function headingsByLine(markdown: string): (string | null)[] {
  let current: string | null = null;
  return markdown.split('\n').map((line) => {
    const m = HEADING.exec(line);
    if (m) current = m[2] || null;
    return current;
  });
}

/** Per line: the Meetings or Context section it falls in (a heading line itself is outside). */
export function proseKinds(markdown: string): (ProseKind | null)[] {
  const tracker = new ProseTracker();
  return markdown.split('\n').map((line) => {
    const m = HEADING.exec(line);
    if (m) {
      tracker.enter(m[2] || null, m[1]!.length);
      return null;
    }
    return tracker.kind;
  });
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(.*?)\s*$/;

/** The text of each list line in `lines`, with any checkbox dropped. */
export function bulletTexts(lines: string[]): string[] {
  return lines.map((line) => BULLET.exec(line)?.[1]).filter((text): text is string => !!text);
}

const TASK_MARK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[.\]\s+/;

/**
 * The markdown the scanner should see: task lines under the Suggested heading lose
 * their checkbox, so they never reach a horizon or capacity. Line numbers don't move.
 * `suggested` holds the 0-based lines that were task lines.
 */
/**
 * `markdown` with the checkbox taken off every line inside Meetings and Context, so nothing there
 * is a task. Lines in `keep` (the Important block, which can sit under Context) are left alone.
 */
export function neutralizeProse(markdown: string, keep: Set<number>): string {
  const kinds = proseKinds(markdown);
  return markdown
    .split('\n')
    .map((line, i) => (kinds[i] && !keep.has(i) ? line.replace(TASK_MARK, '$1') : line))
    .join('\n');
}

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
