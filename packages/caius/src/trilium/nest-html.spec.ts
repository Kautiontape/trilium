import { describe, it, expect } from 'vitest';
import { addUnder, liftOut, nestNew, nestUnder, type NestResult } from './nest-html.js';
import { itemMarkup } from './plan-html.js';
import { buildDoc } from './journal.js';
import { planTasks } from './plan-read.js';
import { critical, li, periodNote, STATES, ul } from './helpers.js';

const now = new Date(2026, 10, 16);
const standup = (sub?: string) => li('eP', '09:30 Standup ~15m', { sub });
const ana = li('eA', 'Answer Ana');
const ben = li('eB', 'Answer Ben');
const report = li('eX', 'Write the report');
const fix = (id: string, key: string) => li(id, `Fix ${key}`);
const fixes = itemMarkup('eN', 'Caius fixes ~15m');
const fixesOf = (...items: string[]) => li('eN', 'Caius fixes ~15m', { sub: ul(...items) });

const written = (result: NestResult): string => {
  if (!result.ok) throw new Error(`refused: ${result.reason} ${result.detail ?? ''}`);
  return result.html;
};

/** Each task's list item id with its parent's, as the planner reads the note back. */
const parents = (html: string) =>
  planTasks(buildDoc(periodNote('d', 'dateNote', '2026-11-16'), 'Journal/Daily/2026-11-16.md', html, STATES), now).tasks.map((t) => [
    t.listItemId,
    t.parentListItemId,
  ]);

describe('addUnder', () => {
  it("writes the sub-list CKEditor saves, right after the parent's label", () => {
    const html =
      '<ul class="todo-list"><li data-list-item-id="eP"><label class="todo-list__label"><input type="checkbox" disabled="disabled">' +
      '<span class="todo-list__label__description">09:30 Standup ~15m</span></label></li></ul>';
    expect(addUnder(html, itemMarkup('eA', 'Answer Ana'), 'eP')).toEqual({
      ok: true,
      unchanged: false,
      html:
        '<ul class="todo-list"><li data-list-item-id="eP"><label class="todo-list__label"><input type="checkbox" disabled="disabled">' +
        '<span class="todo-list__label__description">09:30 Standup ~15m</span></label>' +
        '<ul class="todo-list"><li data-list-item-id="eA"><label class="todo-list__label"><input type="checkbox" disabled="disabled">' +
        '<span class="todo-list__label__description">Answer Ana</span></label></li></ul></li></ul>',
    });
  });

  it('adds at the end of the sub-list a parent has, leaving the rest as stored', () => {
    const keep = '<p>keep &amp; <b>me</b>  </p>';
    const out = written(addUnder('<h3>Morning</h3>' + ul(standup(ul(ana)), report) + keep, ben, 'eP'));
    expect(out).toBe('<h3>Morning</h3>' + ul(standup(ul(ana, ben)), report) + keep);
    expect(parents(out)).toEqual([
      ['eP', null],
      ['eA', 'eP'],
      ['eB', 'eP'],
      ['eX', null],
    ]);
  });

  it('refuses a missing parent, a sub-item, and a parent in Suggested or Meetings', () => {
    const html =
      '<h2>Meetings</h2>' + ul(li('eM', '09:30 Standup')) + '<h2>Tasks</h2>' + ul(standup(ul(ana))) +
      '<ul><li data-list-item-id="eT">Plain bullet</li></ul><h2>Suggested</h2>' + ul(li('eS', 'Maybe'));
    expect(['enope', 'eT', 'eA', 'eS', 'eM'].map((id) => addUnder(html, ben, id))).toMatchObject([
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'too_deep' },
      { ok: false, reason: 'bad_request' },
      { ok: false, reason: 'bad_request' },
    ]);
  });

  it('refuses a cancelled or moved parent, naming it, and takes a done or doing one', () => {
    const html = ul(li('eK', 'Call Ben', { state: 'cancelled' }), li('eR', 'Book the room', { state: '_rescheduled' }), li('eD', '09:30 Standup', { checked: true }));
    expect(['eK', 'eR'].map((parentId) => addUnder(html, ben, parentId, STATES))).toMatchObject([
      { ok: false, reason: 'not_live', detail: expect.stringContaining('eK') },
      { ok: false, reason: 'not_live', detail: expect.stringContaining('eR') },
    ]);
    expect(addUnder(html, ben, 'eD', STATES)).toMatchObject({ ok: true, unchanged: false });
    const doing = li('eP', '09:30 Standup ~15m', { state: 'doing' });
    expect(addUnder(ul(doing), ben, 'eP')).toEqual({ ok: true, html: ul(li('eP', '09:30 Standup ~15m', { state: 'doing', sub: ul(ben) })), unchanged: false });
  });
});

describe('nestUnder', () => {
  it("moves an item after its parent, or before it, into the parent's sub-list", () => {
    const out = written(nestUnder(ul(standup(), ana, report), 'eA', 'eP', STATES));
    expect(out).toBe(ul(standup(ul(ana)), report));
    expect(parents(out)).toEqual([
      ['eP', null],
      ['eA', 'eP'],
      ['eX', null],
    ]);
    expect(nestUnder(ul(ana, standup()), 'eA', 'eP', STATES)).toEqual({ ok: true, html: ul(standup(ul(ana))), unchanged: false });
  });

  it("moves an item from another heading's list, which goes when emptied, before or after the parent", () => {
    const later = '<h3>Morning</h3>' + ul(standup()) + '<h3>Afternoon</h3>' + ul(ana);
    expect(written(nestUnder(later, 'eA', 'eP', STATES))).toBe('<h3>Morning</h3>' + ul(standup(ul(ana))) + '<h3>Afternoon</h3>');

    const earlier = '<h3>Morning</h3>' + ul(ana, report) + '<h3>Afternoon</h3>' + ul(standup());
    const out = written(nestUnder(earlier, 'eA', 'eP', STATES));
    expect(out).toBe('<h3>Morning</h3>' + ul(report) + '<h3>Afternoon</h3>' + ul(standup(ul(ana))));
    expect(parents(out)).toEqual([
      ['eX', null],
      ['eP', null],
      ['eA', 'eP'],
    ]);

    const alone = '<h3>Morning</h3>' + ul(ana) + '<h3>Afternoon</h3>' + ul(standup());
    expect(written(nestUnder(alone, 'eA', 'eP', STATES))).toBe('<h3>Morning</h3><h3>Afternoon</h3>' + ul(standup(ul(ana))));
  });

  it('takes an On deck item into the day, the heading going with its emptied list', () => {
    const suggested = '<h2>Suggested</h2>' + ul(li('eS', 'Maybe'));
    const html = '<h2>Tasks</h2>' + ul(standup()) + '<h2>On deck</h2>' + ul(ana) + suggested;
    expect(written(nestUnder(html, 'eA', 'eP', STATES))).toBe('<h2>Tasks</h2>' + ul(standup(ul(ana))) + suggested);
  });

  it('adds after the sub-items there, keeping the state, and a re-run changes nothing', () => {
    const doing = li('eA', 'Answer Ana', { state: 'doing' });
    const out = written(nestUnder(ul(standup(ul(ben)), doing), 'eA', 'eP', STATES));
    expect(out).toBe(ul(standup(ul(ben, doing))));
    expect(nestUnder(out, 'eA', 'eP', STATES)).toEqual({ ok: true, html: out, unchanged: true });
  });

  it('puts any item under an Important parent, but keeps an Important item in the Important block', () => {
    const html = critical(li('eC', 'Ship ABC-12')) + '<h3>Morning</h3>' + ul(standup(), ana);
    const out = written(nestUnder(html, 'eA', 'eC', STATES));
    expect(out).toBe(critical(li('eC', 'Ship ABC-12', { sub: ul(ana) })) + '<h3>Morning</h3>' + ul(standup()));
    expect(parents(out)).toEqual([
      ['eC', null],
      ['eA', 'eC'],
      ['eP', null],
    ]);
    expect(nestUnder(html, 'eC', 'eP', STATES)).toMatchObject({ ok: false, reason: 'bad_request' });
  });

  it('refuses a missing, finished, nested, prose or Suggested item or parent, and two levels', () => {
    const html =
      '<h2>Meetings</h2>' + ul(li('eM', '09:30 Standup')) + '<h2>Tasks</h2>' +
      ul(
        standup(ul(ana, ben)),
        li('eQ', 'Plan the week', { sub: ul(li('eQ1', 'Pick three', { checked: true })) }),
        li('eD', 'Send ABC-12', { checked: true }),
        li('eK', 'Call Ben', { state: 'cancelled' }),
        li('eO', 'Book the room'),
      ) +
      '<h2>Suggested</h2>' + ul(li('eS', 'Maybe'));
    const cases: [string, string, string][] = [
      ['enope', 'eP', 'not_found'],
      ['eO', 'enope', 'not_found'],
      ['eD', 'eP', 'not_live'],
      ['eK', 'eP', 'not_live'],
      ['eO', 'eA', 'too_deep'],
      ['eQ', 'eP', 'too_deep'],
      ['eO', 'eO', 'bad_request'],
      ['eS', 'eP', 'bad_request'],
      ['eO', 'eS', 'bad_request'],
      ['eM', 'eP', 'bad_request'],
      ['eO', 'eM', 'bad_request'],
      ['eA', 'eQ', 'bad_request'],
    ];
    expect(cases.map(([id, parentId]) => nestUnder(html, id, parentId, STATES))).toMatchObject(cases.map(([, , reason]) => ({ ok: false, reason })));
    expect(['eA', 'eB'].map((id) => nestUnder(html, id, 'eP', STATES))).toEqual([
      { ok: true, html, unchanged: true },
      { ok: true, html, unchanged: true },
    ]);
  });

  it('refuses a cancelled or moved parent, naming it, and takes a done one', () => {
    const cancelled = li('eK', 'Call Ben', { state: 'cancelled' });
    const moved = li('eR', 'Book the room', { state: '_rescheduled' });
    const html = ul(cancelled, moved, li('eD', '09:30 Standup', { checked: true }), ana);
    expect(['eK', 'eR'].map((parentId) => nestUnder(html, 'eA', parentId, STATES))).toMatchObject([
      { ok: false, reason: 'not_live', detail: expect.stringContaining('eK') },
      { ok: false, reason: 'not_live', detail: expect.stringContaining('eR') },
    ]);
    expect(written(nestUnder(html, 'eA', 'eD', STATES))).toBe(ul(cancelled, moved, li('eD', '09:30 Standup', { checked: true, sub: ul(ana) })));
  });
});

describe('nestNew', () => {
  it('makes the parent where the first item stood, with the items under it in the order given', () => {
    const html = '<h3>Morning</h3>' + ul(report, fix('e1', 'ABC-12'), fix('e2', 'ABC-13')) + '<h3>Afternoon</h3>' + ul(fix('e3', 'ABC-14'));
    const out = written(nestNew(html, ['e2', 'e3', 'e1'], fixes, STATES));
    expect(out).toBe('<h3>Morning</h3>' + ul(report, fixesOf(fix('e2', 'ABC-13'), fix('e3', 'ABC-14'), fix('e1', 'ABC-12'))) + '<h3>Afternoon</h3>');
    expect(parents(out)).toEqual([
      ['eX', null],
      ['eN', null],
      ['e2', 'eN'],
      ['e3', 'eN'],
      ['e1', 'eN'],
    ]);
  });

  it('reports unchanged when the tasks are already under a parent of those words, in that order', () => {
    const html =
      '<h3>Morning</h3>' +
      ul(report, fixesOf(fix('e2', 'ABC-13'), fix('e3', 'ABC-14'), fix('e1', 'ABC-12')), li('eY', 'Plan the week', { sub: ul(fix('e4', 'ABC-15')) }));
    const again = itemMarkup('eZ', '  Caius   fixes ~15m ');
    expect([['e2', 'e3', 'e1'], ['e2', 'e1']].map((ids) => nestNew(html, ids, again, STATES))).toEqual([
      { ok: true, html, unchanged: true },
      { ok: true, html, unchanged: true },
    ]);
    expect([['e1', 'e2'], ['e2', 'e4']].map((ids) => nestNew(html, ids, again, STATES))).toMatchObject([
      { ok: false, reason: 'bad_request' },
      { ok: false, reason: 'bad_request' },
    ]);
    expect(nestNew(html, ['e2', 'e3', 'e1'], itemMarkup('eZ', 'Other fixes'), STATES)).toMatchObject({ ok: false, reason: 'bad_request' });
  });

  it('empties a later list of several items in one go', () => {
    const html = '<h3>Morning</h3>' + ul(fix('e1', 'ABC-12')) + '<h3>Afternoon</h3>' + ul(fix('e2', 'ABC-13'), fix('e3', 'ABC-14'));
    expect(nestNew(html, ['e1', 'e2', 'e3'], fixes, STATES)).toEqual({
      ok: true,
      unchanged: false,
      html: '<h3>Morning</h3>' + ul(fixesOf(fix('e1', 'ABC-12'), fix('e2', 'ABC-13'), fix('e3', 'ABC-14'))) + '<h3>Afternoon</h3>',
    });
  });

  it('puts the parent in the Important block when the first item is there, never an Important item outside it', () => {
    const html = critical(fix('e1', 'ABC-12')) + '<h3>Morning</h3>' + ul(fix('e2', 'ABC-13'));
    expect(written(nestNew(html, ['e1', 'e2'], fixes, STATES))).toBe(critical(fixesOf(fix('e1', 'ABC-12'), fix('e2', 'ABC-13'))) + '<h3>Morning</h3>');
    expect(nestNew(html, ['e2', 'e1'], fixes, STATES)).toMatchObject({ ok: false, reason: 'bad_request', detail: expect.stringContaining('e1') });
  });

  it("refuses the whole nest when an item fails nestUnder's checks, naming it", () => {
    const html =
      '<h3>Morning</h3>' +
      ul(fix('e1', 'ABC-12'), li('eD', 'Send ABC-13', { checked: true }), li('eQ', 'Plan the week', { sub: ul(li('eQ1', 'Pick three')) })) +
      '<h2>Suggested</h2>' + ul(li('eS', 'Maybe'));
    const cases: [string[], string][] = [
      [['e1', 'enope'], 'not_found'],
      [['e1', 'eD'], 'not_live'],
      [['e1', 'eQ'], 'too_deep'],
      [['e1', 'eQ1'], 'bad_request'],
      [['e1', 'eS'], 'bad_request'],
      [['e1', 'e1'], 'bad_request'],
    ];
    expect(cases.map(([ids]) => nestNew(html, ids, fixes, STATES))).toMatchObject(
      cases.map(([ids, reason]) => ({ ok: false, reason, detail: expect.stringContaining(ids[1] ?? '') })),
    );
    expect(nestNew(html, [], fixes, STATES)).toMatchObject({ ok: false, reason: 'bad_request' });
  });
});

describe('liftOut', () => {
  it('moves a sub-item to right after its parent', () => {
    const cy = li('eC', 'Answer Cy');
    const out = written(liftOut(ul(standup(ul(ana, ben, cy)), report), 'eB'));
    expect(out).toBe(ul(standup(ul(ana, cy)), ben, report));
    expect(parents(out)).toEqual([
      ['eP', null],
      ['eA', 'eP'],
      ['eC', 'eP'],
      ['eB', null],
      ['eX', null],
    ]);
  });

  it('drops the sub-list it empties, and lifts a finished sub-item too', () => {
    const done = li('eA', 'Answer Ana', { checked: true });
    expect(liftOut(ul(standup(ul(done))), 'eA')).toEqual({ ok: true, html: ul(standup(), done), unchanged: false });
  });

  it('refuses a missing item, a top-level one, and a sub-item in Suggested or Meetings', () => {
    const html =
      '<h2>Meetings</h2>' + ul(li('eM', '09:30 Standup', { sub: ul(li('eM1', 'Notes')) })) + '<h2>Tasks</h2>' + ul(standup(ul(ana))) +
      '<h2>Suggested</h2>' + ul(li('eS', 'Maybe', { sub: ul(li('eS1', 'First step')) }));
    expect(['enope', 'eP', 'eS1', 'eM1'].map((id) => liftOut(html, id))).toMatchObject([
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'bad_request' },
      { ok: false, reason: 'bad_request' },
      { ok: false, reason: 'bad_request' },
    ]);
  });
});
