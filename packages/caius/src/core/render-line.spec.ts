import { describe, it, expect } from 'vitest';
import { parseTaskLine } from './parse-line.js';
import { renderTaskLine } from './render-line.js';
import type { EstimateToken, ImportanceToken, DueToken, ProjectToken } from './types.js';

const round = (line: string) => renderTaskLine(parseTaskLine(line)!);

describe('renderTaskLine', () => {
  it('byte-identical for unchanged well-formed lines', () => {
    for (const line of [
      '- [ ] plain task',
      '  - [/] in progress ~30m',
      '* [x] done with project :[[Caius]]',
      '+ [-] cancelled !! *2026-07-01',
      '- [ ] with anchor ^abc123',
    ])
      expect(round(line)).toBe(line);
  });

  it('renders changed state via the glyph map', () => {
    const t = parseTaskLine('- [ ] task')!;
    expect(renderTaskLine({ ...t, state: 'done' })).toBe('- [x] task');
  });
});

describe('renderToken (changed tokens regenerate)', () => {
  it('estimate 90 minutes → ~1h30m', () => {
    const t = parseTaskLine('- [ ] task ~30m')!;
    const tok = t.tokens.find((x) => x.kind === 'estimate') as EstimateToken;
    tok.minutes = 90;
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task ~1h30m');
  });

  it('estimate 120 minutes → ~2h', () => {
    const t = parseTaskLine('- [ ] task ~30m')!;
    const tok = t.tokens.find((x) => x.kind === 'estimate') as EstimateToken;
    tok.minutes = 120;
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task ~2h');
  });

  it('estimate 30 minutes → ~30m', () => {
    const t = parseTaskLine('- [ ] task ~1h')!;
    const tok = t.tokens.find((x) => x.kind === 'estimate') as EstimateToken;
    tok.minutes = 30;
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task ~30m');
  });

  it('importance tier 1 → !', () => {
    const t = parseTaskLine('- [ ] task !!!')!;
    const tok = t.tokens.find((x) => x.kind === 'importance') as ImportanceToken;
    tok.tier = 1;
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task !');
  });

  it('importance tier 2 → !!', () => {
    const t = parseTaskLine('- [ ] task !')!;
    const tok = t.tokens.find((x) => x.kind === 'importance') as ImportanceToken;
    tok.tier = 2;
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task !!');
  });

  it('importance tier 3 → !!!', () => {
    const t = parseTaskLine('- [ ] task !')!;
    const tok = t.tokens.find((x) => x.kind === 'importance') as ImportanceToken;
    tok.tier = 3;
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task !!!');
  });

  it('due date changed → *YYYY-MM-DD', () => {
    const t = parseTaskLine('- [ ] task *2026-01-01')!;
    const tok = t.tokens.find((x) => x.kind === 'due') as DueToken;
    tok.date = '2027-03-15';
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task *2027-03-15');
  });

  it('due token constructed inline → *YYYY-MM-DD', () => {
    const t = parseTaskLine('- [ ] task')!;
    const tok: DueToken = { kind: 'due', date: '2026-12-31', raw: '*2026-01-01', changed: true };
    t.tokens.push(tok);
    expect(renderTaskLine(t)).toBe('- [ ] task *2026-12-31');
  });

  it('project changed → :[[Name]]', () => {
    const t = parseTaskLine('- [ ] task :[[OldProject]]')!;
    const tok = t.tokens.find((x) => x.kind === 'project') as ProjectToken;
    tok.project = 'NewProject';
    tok.changed = true;
    expect(renderTaskLine(t)).toBe('- [ ] task :[[NewProject]]');
  });

  it('project token constructed inline → :[[Name]]', () => {
    const t = parseTaskLine('- [ ] task')!;
    const tok: ProjectToken = { kind: 'project', project: 'Caius', raw: ':[[Old]]', changed: true };
    t.tokens.push(tok);
    expect(renderTaskLine(t)).toBe('- [ ] task :[[Caius]]');
  });
});
