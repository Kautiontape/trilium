// Project axis (§5). Explicit beats inferred:
//   :[[X]] override → from: origin's project → path-inferred → null (orphan).

import type { ParsedTask } from '../core/index.js';
import { matchGlob, capture } from './glob.js';
import { type Config } from './config.js';
import { type Derived } from './types.js';

export interface ProjectContext {
  /** Resolve a wikilinked note name to its project, for from: backrefs. */
  projectOfNote?: (note: string) => string | null;
}

const CAPTURE_RE = /^\{(seg1|filename|folder)\}$/;

/** Path-infer a project from project_mapping, or null if no rule matches. */
function pathInferred(file: string, config: Config): Derived | null {
  for (const rule of config.project_mapping) {
    if (!matchGlob(rule.match, file)) continue;
    const value = CAPTURE_RE.test(rule.project)
      ? capture(rule.project, rule.match, file)
      : rule.project;
    if (!value) continue;
    return {
      value,
      rule: `path-inferred (${rule.match})`,
      source: `${file} → ${rule.project}=${value}`,
    };
  }
  return null;
}

/** Resolve the project for a task. Returns null value for orphans (first-class). */
export function resolveProject(
  task: ParsedTask,
  file: string,
  config: Config,
  ctx?: ProjectContext,
): Derived {
  // 1. explicit override on the line
  const override = task.tokens.find((t) => t.kind === 'project');
  if (override && override.kind === 'project') {
    return {
      value: override.project,
      rule: 'override :[[…]]',
      source: override.raw,
    };
  }

  // 2. from: backref — a moved task keeps its origin's project
  const from = task.tokens.find((t) => t.kind === 'from');
  if (from && from.kind === 'from' && ctx?.projectOfNote) {
    const originProject = ctx.projectOfNote(from.note);
    if (originProject) {
      return {
        value: originProject,
        rule: 'from: backref (origin project)',
        source: `${from.raw} → ${originProject}`,
      };
    }
  }

  // 3. path-inferred from this file's location
  const inferred = pathInferred(file, config);
  if (inferred) return inferred;

  // 4. orphan
  return { value: null, rule: 'orphan', source: 'no project rule matched' };
}
