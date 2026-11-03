import { describe, expect, it } from 'vitest';
import { firstTaskOf, projectPicks, readProjectPicks, type ProjectNote } from './projects.js';
import { fakeTrilium, li, periodNote, ul } from './helpers.js';

const project = (noteId: string, title: string, labels: Record<string, string>, content = ''): ProjectNote => ({
  ...periodNote(noteId, 'status', 'active'),
  title,
  attributes: Object.entries(labels).map(([name, value]) => ({ type: 'label' as const, name, value })),
  content,
});

describe('firstTaskOf', () => {
  it('is the first unchecked to-do item, skipping checked and cancelled ones', () => {
    const html = '<p>Notes</p>' + ul(li('a', 'Done thing', { checked: true }), li('b', 'Dropped', { checked: true, state: 'cancelled' }), li('c', 'Sand the <b>desk</b> &amp; stain it'), li('d', 'Later'));
    expect(firstTaskOf(html)).toBe('Sand the desk & stain it');
  });
  it('falls back to the first line starting with a ballot box', () => {
    expect(firstTaskOf('<p>Plan</p><p>☐ Draft the outline</p><p>☐ Second</p>')).toBe('Draft the outline');
    expect(firstTaskOf('<p>Nothing to do</p>')).toBeNull();
    expect(firstTaskOf('')).toBeNull();
  });
  it('cuts a long task at a word, with an ellipsis, within 60 characters', () => {
    const long = firstTaskOf(ul(li('a', 'Write the first chapter of the book about the long walk across the whole country')))!;
    expect(long).toBe('Write the first chapter of the book about the long walk…');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(firstTaskOf(ul(li('a', 'x'.repeat(80))))!.length).toBe(60);
    expect(firstTaskOf(ul(li('a', 'y'.repeat(60))))).toBe('y'.repeat(60));
  });
});

describe('projectPicks', () => {
  const notes = [
    project('p1', 'Zine', { priorityGroup: 'growth', priority: '2' }, ul(li('a', 'Fold the pages'))),
    project('p2', 'Bike', { priorityGroup: 'Recharge', priority: '1' }),
    project('p3', 'Piano', { priorityGroup: 'Growth', priority: '1' }, '<p>☐ Scales</p>'),
    project('p4', 'Apple tree', { priorityGroup: 'GROWTH' }),
    project('p5', 'Taxes', { priorityGroup: 'Foundation', priority: '1' }),
    project('p6', 'Ant farm', { priorityGroup: 'growth', priority: '2' }),
  ];

  it('keeps the area, orders by priority then title with no priority last', () => {
    expect(projectPicks(notes, 'growth').map((p) => p.project)).toEqual(['Piano', 'Ant farm', 'Zine', 'Apple tree']);
    expect(projectPicks(notes, 'recharge').map((p) => p.noteId)).toEqual(['p2']);
  });
  it('words each pick with the first task when there is one', () => {
    const [piano, , zine, tree] = projectPicks(notes, 'growth');
    expect(piano).toEqual({ area: 'growth', project: 'Piano', noteId: 'p3', firstTask: 'Scales', text: 'Piano: Scales' });
    expect(zine).toMatchObject({ firstTask: 'Fold the pages', text: 'Zine: Fold the pages' });
    expect(tree).toMatchObject({ firstTask: null, text: 'Apple tree' });
  });
});

describe('readProjectPicks', () => {
  it('searches active projects with a group and reads the content of those in the area', async () => {
    const piano = project('p3', 'Piano', { priorityGroup: 'Growth' });
    const taxes = project('p9', 'Taxes', { priorityGroup: 'Foundation' });
    const f = fakeTrilium({ p3: [piano, '<p>☐ Scales</p>'], p9: [taxes, ul(li('a', 'File'))] });
    const queries: string[] = [];
    f.api.search = async (q) => { queries.push(q); return [piano, taxes]; };
    expect(await readProjectPicks(f.api, 'growth')).toEqual([{ area: 'growth', project: 'Piano', noteId: 'p3', firstTask: 'Scales', text: 'Piano: Scales' }]);
    expect(queries).toEqual(['#status=active #priorityGroup']);
  });
});
