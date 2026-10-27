// Full-vault scan (M3, §6). Walk → parse → resolve axes → reconcile by ^id →
// integrity flags. Pure of SQLite: returns an in-memory ScanResult that the DB
// layer persists. Identity reconciliation runs after all files are parsed.

import { createHash } from 'node:crypto';
import { parseDocument, type ParsedTask, type State } from '../core/index.js';
import { now as clock } from '../clock.js';
import { resolveHorizon, resolveProject, type Config, type ProjectContext, type Grain, type Bucket } from '../resolve/index.js';

export interface IndexedTask {
  rowid: number;
  blockId: string | null;
  file: string;
  line: number;
  state: State;
  live: boolean;
  text: string;
  importance: number;
  estMinutes: number | null;
  due: string | null;
  done: string | null;
  project: string | null;
  horizon: string | null;
  grain: Grain | null;
  bucket: Bucket | null;
  area: string | null; // deferred (D3) — always null in Phase 1
  parentRowid: number | null;
  tokens: { kind: string; raw: string }[];
  notes: string[]; // attached non-task note lines (trimmed), in source order
  derivations: { axis: string; value: string | null; rule: string; source: string }[];
}

export interface Flag {
  taskRowid: number;
  kind: string;
  detail: string;
  severity: 'info' | 'warn' | 'error';
}

export interface FileRecord {
  path: string;
  mtime: number;
  hash: string;
}

export interface ScanReport {
  fileCount: number;
  taskCount: number;
  liveCount: number;
  byState: Record<State, number>;
  byHorizon: Record<string, number>; // all tasks (raw index distribution)
  funnel: Record<string, number>; // live tasks only — the actionable funnel
  withProject: number;
  orphans: number;
  flagCount: number;
  byFlag: Record<string, number>;
}

export interface ScanResult {
  files: FileRecord[];
  tasks: IndexedTask[];
  flags: Flag[];
  report: ScanReport;
}

const EMPTY_STATES: Record<State, number> = {
  open: 0,
  in_progress: 0,
  done: 0,
  cancelled: 0,
  tombstone: 0,
};

function tokenValue(t: { kind: string }, key: string): unknown {
  return (t as Record<string, unknown>)[key];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/** One indexable document: a vault-relative path, its text and its mtime (ms).
 * A file on disk is one; so is a Trilium note given a virtual path. */
export interface VaultDoc {
  path: string;
  text: string;
  mtime: number;
}

/** Parse → resolve → reconcile over already-read documents. Pure of I/O. */
export function scanDocs(docs: VaultDoc[], config: Config, now: Date = clock()): ScanResult {
  const files: FileRecord[] = [];
  const tasks: IndexedTask[] = [];
  const parses: ParsedTask[] = []; // parallel to tasks, for the resolve pass

  // (file,line) → rowid, for parent linkage after all tasks are collected.
  const rowidByKey = new Map<string, number>();
  // basename → project, for from: backref resolution.
  const projectByNote = new Map<string, string>();

  let nextRowid = 1;

  for (const { path: rel, text, mtime } of docs) {
    files.push({
      path: rel,
      mtime,
      hash: createHash('sha1').update(text).digest('hex'),
    });

    const parsed = parseDocument(text, { tabWidth: config.indent.tab_width });
    for (const pt of parsed) {
      const rowid = nextRowid++;
      rowidByKey.set(`${rel}\n${pt.line}`, rowid);

      const est = pt.tokens.find((t) => t.kind === 'estimate');
      const due = pt.tokens.find((t) => t.kind === 'due');
      const done = pt.tokens.find((t) => t.kind === 'done');
      const imp = pt.tokens.find((t) => t.kind === 'importance');

      tasks.push({
        rowid,
        blockId: pt.blockId,
        file: rel,
        line: pt.line,
        state: pt.state,
        live: pt.live,
        text: pt.text,
        importance: imp ? (tokenValue(imp, 'tier') as number) : 0,
        estMinutes: est ? (tokenValue(est, 'minutes') as number) : null,
        due: due ? (tokenValue(due, 'date') as string) : null,
        done: done ? (tokenValue(done, 'date') as string) : null,
        project: null,
        horizon: null,
        grain: null,
        bucket: null,
        area: null,
        parentRowid: null, // filled below
        tokens: pt.tokens.map((t) => ({ kind: t.kind, raw: t.raw })),
        notes: pt.notes,
        derivations: [],
      });
      parses.push(pt);
    }
  }

  // Resolve axes. from: backrefs read an origin note's project from projectByNote,
  // which is seeded incrementally as path-inferred projects are resolved.
  const ctx: ProjectContext = { projectOfNote: (note) => projectByNote.get(note) ?? null };
  tasks.forEach((t, i) => {
    const pt = parses[i]!;
    const horizon = resolveHorizon(t.file, now, config);
    const project = resolveProject(pt, t.file, config, ctx);
    t.horizon = horizon.value;
    t.grain = horizon.grain;
    t.bucket = horizon.bucket;
    t.project = project.value;
    t.derivations.push(
      { axis: 'horizon', value: horizon.value, rule: horizon.rule, source: horizon.source },
      { axis: 'grain', value: horizon.grain, rule: `grain ${horizon.grain ?? 'none'} · bucket ${horizon.bucket ?? 'n/a'}`, source: horizon.source },
      { axis: 'project', value: project.value, rule: project.rule, source: project.source },
    );
    if (project.value) projectByNote.set(basename(t.file), project.value);

    // parent linkage
    if (pt.parentLine !== null) {
      t.parentRowid = rowidByKey.get(`${t.file}\n${pt.parentLine}`) ?? null;
    }
  });

  const flags = reconcile(tasks);
  const report = buildReport(files, tasks, flags);
  return { files, tasks, flags, report };
}

/** Global reconciliation by ^id + pointer integrity (§6). */
function reconcile(tasks: IndexedTask[]): Flag[] {
  const flags: Flag[] = [];

  // ≥2 live tasks sharing one block id ⇒ invariant_violation (informational).
  const liveById = new Map<string, IndexedTask[]>();
  for (const t of tasks) {
    if (t.blockId && t.live) {
      (liveById.get(t.blockId) ?? liveById.set(t.blockId, []).get(t.blockId)!).push(t);
    }
  }
  for (const [id, group] of liveById) {
    if (group.length < 2) continue;
    for (const t of group) {
      const others = group.filter((o) => o !== t).map((o) => `${o.file}:${o.line + 1}`);
      flags.push({
        taskRowid: t.rowid,
        kind: 'invariant_violation',
        detail: `live ^${id} also at ${others.join(', ')}`,
        severity: 'info',
      });
    }
  }

  // Pointer integrity. (Net-new in this vault; structurally present.)
  const noteBasenames = new Set(tasks.map((t) => basename(t.file)));
  const taskIdsByNote = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (!t.blockId) continue;
    const k = basename(t.file);
    (taskIdsByNote.get(k) ?? taskIdsByNote.set(k, new Set()).get(k)!).add(t.blockId);
  }

  for (const t of tasks) {
    const moved = t.tokens.find((tok) => tok.kind === 'moved');
    const from = t.tokens.find((tok) => tok.kind === 'from');
    for (const ref of [moved, from]) {
      if (!ref) continue;
      const note = parseRefNote(ref.raw);
      if (note && !noteBasenames.has(note)) {
        flags.push({
          taskRowid: t.rowid,
          kind: 'dangling_ref',
          detail: `${ref.kind}: target note "${note}" not found`,
          severity: 'warn',
        });
      }
    }
    // [>] with a present-but-broken moved: pointer ⇒ broken_pointer.
    if (t.state === 'tombstone' && moved) {
      const note = parseRefNote(moved.raw);
      const targetId = parseRefBlockId(moved.raw);
      if (note && noteBasenames.has(note) && targetId && !(taskIdsByNote.get(note)?.has(targetId))) {
        flags.push({
          taskRowid: t.rowid,
          kind: 'broken_pointer',
          detail: `moved:[[${note}#^${targetId}]] target id not found`,
          severity: 'warn',
        });
      }
    }
  }

  return flags;
}

function parseRefNote(raw: string): string | null {
  const m = raw.match(/\[\[([^\]#]+)/);
  return m ? m[1]!.trim() : null;
}

function parseRefBlockId(raw: string): string | null {
  const m = raw.match(/#\^([A-Za-z0-9_-]+)/);
  return m ? m[1]! : null;
}

function buildReport(files: FileRecord[], tasks: IndexedTask[], flags: Flag[]): ScanReport {
  const byState: Record<State, number> = { ...EMPTY_STATES };
  const byHorizon: Record<string, number> = {};
  const funnel: Record<string, number> = {};
  const byFlag: Record<string, number> = {};
  let withProject = 0;
  let liveCount = 0;
  for (const t of tasks) {
    byState[t.state] += 1;
    const h = t.horizon ?? 'unknown';
    byHorizon[h] = (byHorizon[h] ?? 0) + 1;
    if (t.live) {
      liveCount += 1;
      funnel[h] = (funnel[h] ?? 0) + 1;
    }
    if (t.project) withProject += 1;
  }
  for (const f of flags) byFlag[f.kind] = (byFlag[f.kind] ?? 0) + 1;
  return {
    fileCount: files.length,
    taskCount: tasks.length,
    liveCount,
    byState,
    byHorizon,
    funnel,
    withProject,
    orphans: tasks.length - withProject,
    flagCount: flags.length,
    byFlag,
  };
}
