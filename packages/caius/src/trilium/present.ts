import type { NoteChange } from './forward.js';

/** What differs between two HTML strings: the tags/text between their common head and tail. */
export function diffSummary(before: string, after: string): { removed: string; added: string } {
  const a = before.split(/(?=<)/);
  const b = after.split(/(?=<)/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.slice(head, a.length - tail).join(''), added: b.slice(head, b.length - tail).join('') };
}

/**
 * A write result for display. A dry run's changes carry the full before/after HTML; unless
 * `html` is set, each is reduced to its diff summary (nothing when the note is unchanged).
 */
export function presentResult<R extends object>(r: R, html = false): R {
  const changes = (r as { changes?: NoteChange[] }).changes;
  if (!changes || html) return r;
  return {
    ...r,
    changes: changes.map((c) => {
      if (c.before === undefined || c.after === undefined) return c;
      const { before, after, ...rest } = c;
      return { ...rest, ...(c.unchanged ? {} : diffSummary(before, after)) };
    }),
  };
}
