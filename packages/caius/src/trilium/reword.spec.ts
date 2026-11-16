import { describe, it, expect } from 'vitest';
import { fakeTrilium, li, periodNote, STATES, ul } from './helpers.js';
import { rewordTasks } from './reword.js';

const DAY = '2026-10-26';
const base = { states: STATES };
const seed = (html: string) => ({ d: [periodNote('d', 'dateNote', DAY), html] as [ReturnType<typeof periodNote>, string] });
const puts = (log: string[]) => log.filter((l) => l.startsWith('put'));
const JIRA = '<a href="https://jira.example.com/browse/ABC-12">ABC-12</a>';
const req = (listItemId: string, text: string) => ({ noteId: 'd', listItemId, text });
const text = (id: string, doc: string | undefined) => new RegExp(`data-list-item-id="${id}".*?description">(.*?)</span>`).exec(doc ?? '')?.[1];

describe('rewordTasks', () => {
  const html = '<h2>Tasks</h2>' + ul(li('e1', `🌱 Write the draft ${JIRA} ~30m`), li('e2', 'Two'), li('e3', 'Three'));

  it('rewords the tasks of one note in a single write and reports what a link lost', async () => {
    const f = fakeTrilium(seed(html));
    const out = await rewordTasks(f.api, [req('e1', 'Draft the summary for Ana'), req('e2', 'Second'), req('e3', 'Three')], base);
    expect(out.map((r) => r.status)).toEqual(['updated', 'updated', 'unchanged']);
    expect(out[0]).toMatchObject({ dropped: [{ text: 'ABC-12', href: 'https://jira.example.com/browse/ABC-12' }], droppedKeys: ['ABC-12'] });
    expect(out[1]).not.toHaveProperty('dropped');
    expect(out[2]).not.toHaveProperty('dropped');
    expect(out[2]).not.toHaveProperty('droppedKeys');
    expect(text('e1', f.html.d)).toBe('🌱 Draft the summary for Ana ~30m');
    expect(text('e2', f.html.d)).toBe('Second');
    expect(puts(f.log)).toEqual(['put d']);
  });

  it('dry run writes nothing and carries the change on the first result', async () => {
    const f = fakeTrilium(seed(html));
    const out = await rewordTasks(f.api, [req('e2', 'Second'), req('e3', 'Third')], { ...base, dryRun: true });
    expect(out[0]).toMatchObject({ status: 'updated', dryRun: true, changes: [{ noteId: 'd', role: 'target' }] });
    expect(out[1]).toMatchObject({ status: 'updated', dryRun: true, changes: undefined });
    expect(puts(f.log)).toEqual([]);
  });

  it('reports edited when the note changes between the read and the write', async () => {
    const f = fakeTrilium(seed(html));
    const put = f.api.putContent;
    f.api.putContent = async (id, body, expected) => { f.html.d += '<p>x</p>'; return put(id, body, expected); };
    expect((await rewordTasks(f.api, [req('e2', 'Second')], base))[0]).toMatchObject({ status: 'skipped', reason: 'edited' });
  });

  it('reports a failed put, a protected note and a bad request', async () => {
    const g = fakeTrilium(seed(html), { failPut: 'd' });
    expect((await rewordTasks(g.api, [req('e2', 'Second')], base))[0].status).toBe('failed');
    const out = await rewordTasks(fakeTrilium(seed(html)).api, [req('', 'x'), req('e1', '  ')], base);
    expect(out.map((r) => 'reason' in r && r.reason)).toEqual(['bad_request', 'bad_request']);
  });

  it('skips with a reason a person can read', async () => {
    const doc =
      `<h2>Tasks</h2>${ul(li('t1', 'Live'), li('r1', 'Moved', { state: '_rescheduled' }), li('c1', 'Gone', { state: 'cancelled' }))}` +
      `<h3>Meetings</h3>${ul(li('m1', 'Standup'))}<h2>Suggested</h2>${ul(li('g1', 'Get it done'))}`;
    const f = fakeTrilium(seed(doc));
    const out = await rewordTasks(f.api, ['zz', 'm1', 'r1', 'c1', 'g1'].map((id) => req(id, 'New')).concat(req('t1', '🌱 ~30m')), base);
    expect(out.map((r) => [r.status === 'skipped' && r.reason, r.status === 'skipped' && r.detail])).toEqual([
      ['not_found', undefined],
      ['not_live', 'only a task on a list can be reworded'],
      ['moved', 'a moved copy is history: reword the copy it was moved to'],
      ['cancelled', 'a cancelled task is history'],
      ['suggested', 'a Suggested item keeps its "Get X done" shape: accept it first'],
      ['bad_request', 'no words left once the marker and estimate are taken off'],
    ]);
    expect(puts(f.log)).toEqual([]);
  });
});
