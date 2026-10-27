import type { State, TaskLine, Token } from './types.js';

/** Canonical checkbox glyph per state — the exact inverse of STATE_BY_GLYPH in
 * parse-line.ts (the parser also accepts `X` for `done`, which we normalize to
 * lowercase `x`). */
const GLYPH: Record<State, string> = {
  open: ' ',
  in_progress: '/',
  done: 'x',
  cancelled: '-',
  tombstone: '>',
};

/**
 * Render a parsed task back to its source line — the exact inverse of
 * parseTaskLine for any well-formed line (round-trip is byte-identical).
 *
 * Unchanged tokens echo their captured `raw`; only tokens a patch has marked
 * `changed` (B2) are regenerated from their typed fields. Each token and the
 * block id is emitted with a single leading space, matching the parser's
 * whitespace-delimited trailing-token grammar (§3.3).
 */
export function renderTaskLine(t: TaskLine): string {
  // Each trailing token is whitespace-delimited; render with a single leading
  // space. Text (if any) comes first, then tokens, then the block id.
  const parts: string[] = [];
  if (t.text) parts.push(t.text);
  for (const tok of t.tokens) parts.push(tok.changed ? renderToken(tok) : tok.raw);
  if (t.blockId) parts.push(`^${t.blockId}`);
  const body = parts.join(' ');
  const checkbox = `${t.indentText}${t.marker} [${GLYPH[t.state]}]`;
  // Omit the space after the checkbox when there is nothing to follow it, so a
  // bare `- [x]` round-trips canonically (no dangling trailing space).
  return body ? `${checkbox} ${body}` : checkbox;
}

/** Regenerate a token's `raw` from its typed fields (used when `changed`). */
function renderToken(tok: Token): string {
  switch (tok.kind) {
    case 'importance':
      return '!'.repeat(tok.tier);
    case 'estimate': {
      const m = tok.minutes;
      if (m % 60 === 0) return `~${m / 60}h`;
      if (m > 60) return `~${Math.floor(m / 60)}h${m % 60}m`;
      return `~${m}m`;
    }
    case 'due':
      return `*${tok.date}`;
    case 'done':
      return `done:${tok.date}`;
    case 'project':
      return `:[[${tok.project}]]`;
    case 'from':
      return tok.blockId ? `from:[[${tok.note}#^${tok.blockId}]]` : `from:[[${tok.note}]]`;
    case 'moved':
      return `moved:[[${tok.note}#^${tok.blockId}]]`;
    case 'recurrence':
      return `&${tok.rule}`;
  }
}
