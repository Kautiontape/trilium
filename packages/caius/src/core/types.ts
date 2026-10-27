export type State = 'open' | 'in_progress' | 'done' | 'cancelled' | 'tombstone';

/**
 * Common to every token. `raw` is the exact source text of the token (no leading
 * whitespace). `changed` is set by a patch (B2) when a field is mutated, so the
 * renderer (render-line.ts) regenerates the token instead of echoing `raw`;
 * unchanged tokens always round-trip byte-identically via `raw`.
 */
interface TokenBase {
  raw: string;
  changed?: boolean;
}

export interface ImportanceToken extends TokenBase {
  kind: 'importance';
  tier: 1 | 2 | 3;
}

export interface EstimateToken extends TokenBase {
  kind: 'estimate';
  minutes: number;
}

export interface DueToken extends TokenBase {
  kind: 'due';
  date: string; // ISO YYYY-MM-DD
}

export interface DoneToken extends TokenBase {
  kind: 'done';
  date: string; // ISO YYYY-MM-DD
}

export interface ProjectToken extends TokenBase {
  kind: 'project';
  project: string;
}

export interface FromToken extends TokenBase {
  kind: 'from';
  note: string;
  blockId: string | null; // present for recurrence backrefs (Recurring#^id)
}

export interface MovedToken extends TokenBase {
  kind: 'moved';
  note: string;
  blockId: string;
}

export interface RecurrenceToken extends TokenBase {
  kind: 'recurrence';
  rule: string; // daily | weekly | monthly | mon | … (Phase 2; inert in Phase 1)
}

/** Trailing-metadata tokens, parsed by the right-to-left scan (§3.3–3.4). */
export type Token =
  | ImportanceToken
  | EstimateToken
  | DueToken
  | DoneToken
  | ProjectToken
  | FromToken
  | MovedToken
  | RecurrenceToken;

export interface TaskLine {
  state: State;
  live: boolean;
  text: string;
  tokens: Token[];
  tags: string[];
  blockId: string | null;
  marker: '-' | '*' | '+'; // bullet marker char
  indentText: string; // raw leading whitespace
}

/** A task within a document: its line parse plus structural position (§3.6). */
export interface ParsedTask extends TaskLine {
  line: number; // 0-based line index of the task line
  indent: number; // column indent (tabs expanded)
  parentLine: number | null; // line of the nearest enclosing task, or null
  notes: string[]; // attached non-task lines (trimmed), in source order
}
