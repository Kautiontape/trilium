import { describe, it, expect } from 'vitest';
import { htmlToMarkdownWithIds } from './markdown.js';
import { headingsByLine, neutralizeSuggested, normName, sectionKind } from './sections.js';
import { isPeriodKey, readPlan } from './plan-read.js';
import { openTasks, suggestedTasks } from './open.js';
import { scanDocs } from '../index/index.js';
import { TRILIUM_CONFIG } from './config.js';
import { buildDoc } from './journal.js';
import { critical, fakeTrilium, li, periodNote, STATES, ul } from './helpers.js';

const now = new Date(2026, 9, 26);

describe('isPeriodKey', () => {
  it('accepts only days, ISO weeks and months that exist', () => {
    const valid = (kind: 'day' | 'week' | 'month', keys: string[]) => keys.filter((k) => isPeriodKey(kind, k));
    expect(valid('day', ['2026-02-28', '2028-02-29', '2026-12-31', '2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-01'])).toEqual([
      '2026-02-28',
      '2028-02-29',
      '2026-12-31',
    ]);
    // 2020 and 2026 start on a Wednesday in a leap year and on a Thursday: 53 weeks. 2025 has 52.
    expect(valid('week', ['2026-W01', '2026-W53', '2020-W53', '2025-W52', '2025-W53', '2026-W54', '2026-W00', '2026-W1'])).toEqual([
      '2026-W01',
      '2026-W53',
      '2020-W53',
      '2025-W52',
    ]);
    expect(valid('month', ['2026-01', '2026-12', '2026-13', '2026-00', '2026-1'])).toEqual(['2026-01', '2026-12']);
    expect(isPeriodKey('day', '2026-W05')).toBe(false);
  });
});

describe('section names', () => {
  it('match ignoring case, emoji and spacing', () => {
    expect(normName('🌅  Morning ')).toBe('morning');
    expect(sectionKind('☀️ AFTERNOON')).toBe('slot');
    expect(sectionKind('Evening')).toBe('slot');
    expect(sectionKind('🌱 Growth')).toBe('area');
    expect(sectionKind('Foundation')).toBe('area');
    expect(sectionKind('re charge')).toBe('area');
    expect(sectionKind('Work')).toBe('group');
    expect(sectionKind(null)).toBe('group');
  });
  it('treats the Important heading as an ordinary group', () => {
    expect(sectionKind('Important')).toBe('group');
  });
});

describe('critical block', () => {
  const html = '<h2>Tasks</h2>' + critical(li('ec', 'Must happen')) + '<h3>Work</h3>' + ul(li('ew', 'Ordinary ~30m'));

  it('adds a !!! token to tasks inside an Important block, only in the derived markdown', () => {
    const { markdown, critical: lines } = htmlToMarkdownWithIds(html, STATES);
    expect(markdown).toContain('- [ ] Must happen !!!');
    expect(markdown).toContain('- [ ] Ordinary ~30m');
    expect([...lines]).toHaveLength(1);
    expect(html).not.toContain('!!!');
  });
  it('does not treat other admonitions or an Important heading as critical', () => {
    const other = '<h2>Important</h2><aside class="admonition note">' + ul(li('en', 'Noted')) + '</aside>';
    expect(htmlToMarkdownWithIds(other, STATES).critical.size).toBe(0);
  });
  it('replaces a smaller trailing importance mark', () => {
    const h = critical(li('ec', 'Urgent !'));
    expect(htmlToMarkdownWithIds(h, STATES).markdown).toContain('Urgent !!!');
  });
});

describe('Suggested', () => {
  const md = '## Work\n- [ ] A\n## Suggested\n- [ ] S1\n    - [ ] S1a\n## Later\n- [ ] B';
  it('strips checkboxes only under the Suggested heading, keeping line numbers', () => {
    const { text, suggested } = neutralizeSuggested(md);
    expect(text.split('\n')).toEqual(['## Work', '- [ ] A', '## Suggested', '- S1', '    - S1a', '## Later', '- [ ] B']);
    expect([...suggested]).toEqual([3, 4]);
  });
  it('maps each line to its nearest heading', () => {
    expect(headingsByLine(md)).toEqual(['Work', 'Work', 'Suggested', 'Suggested', 'Suggested', 'Later', 'Later']);
  });
});

const dayHtml =
  '<h2>☑️ Tasks</h2>' +
  critical(li('ec1', 'Ship the thing ~1h')) +
  '<h3>Morning</h3>' +
  ul(li('em1', 'First open ~30m'), li('em2', 'Finished', { checked: true }), li('em3', 'Underway ~15m', { state: 'doing' })) +
  '<h3>Growth</h3>' +
  ul(li('eg1', 'Learn it ~45m', { sub: ul(li('eg1a', 'Step one ~10m')) })) +
  '<h3>Errands</h3>' +
  ul(li('ee1', 'No estimate')) +
  '<h2>Suggested</h2>' +
  ul(li('es1', 'Maybe do this ~2h'));

describe('readPlan (day)', () => {
  const seed = { d: [periodNote('d', 'dateNote', '2026-10-26', { attributes: [{ type: 'label', name: 'dateNote', value: '2026-10-26' }, { type: 'label', name: 'caiusDismissed', value: 'ZAP-9' }] }), dayHtml] as [ReturnType<typeof periodNote>, string] };

  it('returns critical first, sections in order with kinds, top3, suggested lane and dismissed keys', async () => {
    const v = await readPlan(fakeTrilium(seed).api, 'day', '2026-10-26', now);
    expect(v.noteId).toBe('d');
    expect(v.critical.map((t) => t.text)).toEqual(['Ship the thing']);
    expect(v.critical[0]).toMatchObject({ noteId: 'd', listItemId: 'ec1', state: 'open', estMinutes: 60, parent: null });
    expect(v.sections.map((s) => [s.name, s.kind])).toEqual([
      ['Morning', 'slot'],
      ['Growth', 'area'],
      ['Errands', 'group'],
    ]);
    expect(v.sections[0]!.tasks.map((t) => [t.text, t.state])).toEqual([
      ['First open', 'open'],
      ['Finished', 'done'],
      ['Underway', 'in_progress'],
    ]);
    expect(v.sections[1]!.tasks[1]).toMatchObject({ text: 'Step one', parent: 'Learn it', parentListItemId: 'eg1' });
    expect(v.sections[1]!.tasks[0]).toMatchObject({ text: 'Learn it', parentListItemId: null });
    expect(v.top3.map((t) => t.text)).toEqual(['First open', 'Underway', 'Learn it']);
    expect(v.suggested.map((t) => t.text)).toEqual(['Maybe do this']);
    expect(v.dismissed).toEqual(['ZAP-9']);
  });

  it('counts capacity from live tasks only, unestimated at 30m, leaving Suggested out', async () => {
    const { capacity } = await readPlan(fakeTrilium(seed).api, 'day', '2026-10-26', now);
    // critical 60 + First 30 + Underway 15 + Step one 10 (Learn it has a live sub-item) = 115; 1 unestimated
    expect(capacity).toMatchObject({ plannedMinutes: 115, estimatedCount: 4, unestimatedCount: 1, unestimatedMinutes: 30, totalMinutes: 145 });
    expect(capacity.horizons).toEqual({ today: 6 });
    expect(capacity.target).toEqual({ min: 180, max: 240 });
  });

  it('leaves empty to-do items out of capacity', async () => {
    const html = '<h3>Work</h3>' + ul(li('t1', 'Estimated ~45m'), li('t2', 'No estimate'), li('t3', '   '));
    const f = fakeTrilium({ d: [periodNote('d', 'dateNote', '2026-10-26'), html] });
    const { capacity } = await readPlan(f.api, 'day', '2026-10-26', now);
    expect(capacity).toMatchObject({ plannedMinutes: 45, estimatedCount: 1, unestimatedCount: 1, unestimatedMinutes: 30, totalMinutes: 75 });
  });

  it('keeps a parent task counted when its only sub-item is empty', async () => {
    const html = '<h3>Work</h3>' + ul(li('p1', 'Write report ~2h', { sub: ul(li('p1a', '')) }));
    const { capacity } = await readPlan(fakeTrilium({ d: [periodNote('d', 'dateNote', '2026-10-26'), html] }).api, 'day', '2026-10-26', now);
    expect(capacity).toMatchObject({ plannedMinutes: 120, estimatedCount: 1, unestimatedCount: 0, totalMinutes: 120 });
  });

  it('gives noteId null for a missing note and never creates one', async () => {
    const f = fakeTrilium(seed);
    const v = await readPlan(f.api, 'day', '2026-10-27', now);
    expect(v).toMatchObject({ noteId: null, critical: [], sections: [], top3: [], suggested: [], dismissed: [] });
    expect(f.log).toEqual([]);
  });

  it('reads week and month notes with the same shape', async () => {
    const f = fakeTrilium({ w: [periodNote('w', 'weekNote', '2026-W44'), '<h3>Work</h3>' + ul(li('ew', 'Week thing ~2h'))], m: [periodNote('m', 'monthNote', '2026-10'), ul(li('em', 'Month thing'))] });
    const w = await readPlan(f.api, 'week', '2026-W44', now);
    expect(w.sections[0]!.tasks[0]).toMatchObject({ text: 'Week thing', estMinutes: 120 });
    expect(w.capacity.horizons).toEqual({ week: 1 });
    expect(w.capacity.target).toEqual({ min: 720, max: 900 });
    const m = await readPlan(f.api, 'month', '2026-10', now);
    expect(m.capacity.target).toBeNull();
    expect(m.sections[0]!.name).toBeNull();
  });
});

describe('open-trilium fields', () => {
  const doc = buildDoc(periodNote('d', 'dateNote', '2026-10-26'), 'Journal/Daily/2026-10-26.md', dayHtml, STATES);
  const result = scanDocs([doc], TRILIUM_CONFIG, now);

  it('adds section, kind, critical and rank, and leaves Suggested out of the funnel', () => {
    const tasks = openTasks([doc], result);
    expect(tasks.some((t) => t.text === 'Maybe do this')).toBe(false);
    expect(result.report.funnel).toEqual({ today: 6 });
    const first = tasks.find((t) => t.text === 'First open')!;
    expect(first).toMatchObject({ section: 'Morning', sectionKind: 'slot', critical: false, horizon: 'today' });
    expect(tasks.find((t) => t.critical)).toMatchObject({ text: 'Ship the thing', rank: 0 });
    expect(first.rank).toBe(1);
    // existing fields are still there
    expect(first).toMatchObject({ noteId: 'd', listItemId: 'em1', period: '2026-10-26', state: 'open', parent: null, parentListItemId: null });
    expect(tasks.find((t) => t.text === 'Step one')).toMatchObject({ parent: 'Learn it', parentListItemId: 'eg1' });
  });
  it('lists Suggested tasks as their own lane', () => {
    expect(suggestedTasks([doc], now)).toMatchObject([{ text: 'Maybe do this', section: 'Suggested', horizon: null, listItemId: 'es1' }]);
  });
});

describe('period search', () => {
  it('quotes the label value, since Trilium reads a bare 2026-10-26 as arithmetic', async () => {
    const f = fakeTrilium({});
    const seen: string[] = [];
    const search = f.api.search;
    f.api.search = async (q, a) => (seen.push(q), search(q, a));
    await readPlan(f.api, 'day', '2026-10-26', now);
    await readPlan(f.api, 'week', '2026-W44', now);
    expect(seen).toEqual(['#dateNote="2026-10-26"', '#weekNote="2026-W44"']);
  });
});
