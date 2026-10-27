import type { State, TaskLine } from './types.js';
import { scanTokens } from './tokenize.js';

const STATE_BY_GLYPH: Record<string, State> = {
  ' ': 'open',
  '/': 'in_progress',
  x: 'done',
  X: 'done',
  '-': 'cancelled',
  '>': 'tombstone',
};

const LIVE_STATES: ReadonlySet<State> = new Set<State>(['open', 'in_progress']);

// indent · marker · checkbox glyph · (optional) rest
const TASK_LINE = /^(\s*)([-*+])[ \t]+\[(.)\](?:[ \t]+(.*))?$/;

// A trailing block id: caret-word at end of line, preceded by start-or-whitespace
// so a `#^id` inside `[[ ]]` (preceded by `#`) is never captured (§3.2, D5).
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9_-]+)$/;

// Inline Obsidian tags collected from anywhere in TEXT (§3.5). A tag must start
// with a letter and is preceded by start-or-whitespace (so `#^id`/`C#` don't match).
const TAG = /(?:^|\s)#([A-Za-z][\w/-]*)/g;

export function parseTaskLine(line: string): TaskLine | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const indentText = m[1]!;
  const marker = m[2] as '-' | '*' | '+';
  const state = STATE_BY_GLYPH[m[3]!];
  if (!state) return null; // strict 5-state set (D1) — anything else is not a task

  let rest = (m[4] ?? '').trimEnd();

  let blockId: string | null = null;
  const idM = BLOCK_ID.exec(rest);
  if (idM) {
    blockId = idM[1]!;
    rest = rest.slice(0, idM.index);
  }

  const { text, tokens } = scanTokens(rest);
  const tags = [...text.matchAll(TAG)].map((t) => t[1]!);

  return {
    state,
    live: LIVE_STATES.has(state),
    text,
    tokens,
    tags,
    blockId,
    marker,
    indentText,
  };
}
