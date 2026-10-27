import { describe, it, expect } from 'vitest';
import type { ParsedTask, Token } from '../core/index.js';
import { resolveProject } from './project.js';
import { DEFAULT_CONFIG } from './config.js';

function task(tokens: Token[] = []): ParsedTask {
  return {
    state: 'open',
    live: true,
    text: 'do thing',
    tokens,
    tags: [],
    blockId: null,
    line: 0,
    indent: 0,
    marker: '-',
    indentText: '',
    parentLine: null,
    notes: [],
  };
}

const p = (file: string, t: ParsedTask, ctx?: Parameters<typeof resolveProject>[3]) =>
  resolveProject(t, file, DEFAULT_CONFIG, ctx);

describe('resolveProject — override (:[[X]])', () => {
  it('an explicit override wins over everything', () => {
    const t = task([{ kind: 'project', raw: ':[[Big Refactor]]', project: 'Big Refactor' }]);
    const d = p('02 - Periodic/Daily/2026/06/2026-06-17.md', t);
    expect(d.value).toBe('Big Refactor');
    expect(d.rule).toContain('override');
  });
  it('override beats a path-inferred project', () => {
    const t = task([{ kind: 'project', raw: ':[[Other]]', project: 'Other' }]);
    expect(p('10 - Project/Caius/notes.md', t).value).toBe('Other');
  });
});

describe('resolveProject — path-inferred', () => {
  it('nested project note → first segment ({seg1})', () => {
    expect(p('10 - Project/Caius/sub/notes.md', task()).value).toBe('Caius');
  });
  it('top-level project note → filename', () => {
    expect(p('10 - Project/Quick Win.md', task()).value).toBe('Quick Win');
  });
});

describe('resolveProject — from: backref', () => {
  it('a moved task keeps its origin project', () => {
    const t = task([{ kind: 'from', raw: 'from:[[Caius MOC]]', note: 'Caius MOC', blockId: null }]);
    const d = p('02 - Periodic/Daily/2026/06/2026-06-17.md', t, {
      projectOfNote: (note) => (note === 'Caius MOC' ? 'Caius' : null),
    });
    expect(d.value).toBe('Caius');
    expect(d.rule).toContain('from');
  });
  it('falls through to path inference when origin has no project', () => {
    const t = task([{ kind: 'from', raw: 'from:[[Scratch]]', note: 'Scratch', blockId: null }]);
    const d = p('10 - Project/Caius/notes.md', t, { projectOfNote: () => null });
    expect(d.value).toBe('Caius');
  });
});

describe('resolveProject — orphan', () => {
  it('no override, no from, no path mapping → null (first-class)', () => {
    const d = p('02 - Periodic/Daily/2026/06/2026-06-17.md', task());
    expect(d.value).toBeNull();
    expect(d.rule).toBeTruthy();
  });
});
