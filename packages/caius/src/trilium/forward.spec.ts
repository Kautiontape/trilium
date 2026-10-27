import { describe, it, expect } from 'vitest';
import { forwardTasks } from './forward.js';
import type { NoteReader, StoreNote } from './store.js';
import { fakeTrilium, li as hli, periodNote, ul as hul } from './helpers.js';

const STATES = new Map([['_rescheduled', '>']]);

const li = (id: string, text: string, checked = false) =>
  `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${checked ? ' checked="checked"' : ''} disabled="disabled"><span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join('')}</ul>`;

const day = (noteId: string, date: string, extra: Partial<StoreNote> = {}): StoreNote => ({
  noteId,
  title: date,
  type: 'text',
  isProtected: false,
  parentNoteIds: [],
  childNoteIds: [],
  attributes: [{ type: 'label', name: 'dateNote', value: date }],
  utcDateModified: '2026-10-26 08:00:00.000Z',
  ...extra,
});

function fake(opts: { onPut?: (id: string) => void; failPut?: string } = {}) {
  const notes: Record<string, StoreNote> = { mon: day('mon', '2026-10-26'), tue: day('tue', '2026-10-27') };
  const html: Record<string, string> = {
    mon: '<h2>☑️ Tasks</h2><h3>Work</h3>' + ul(li('eone', 'Write it'), li('etwo', 'Other')),
    tue: '<h2>☑️ Tasks</h2><h3>Work</h3>' + ul(li('eexisting', 'Already here')),
  };
  const log: string[] = [];
  const api: NoteReader = {
    async search(q) {
      log.push(`search ${q}`);
      const m = /#dateNote="?([^"]+)"?/.exec(q);
      return Object.values(notes).filter((n) => n.attributes[0]?.value === m?.[1]);
    },
    async note(id) {
      const n = notes[id];
      if (!n) throw new Error(`no note ${id}`);
      return n;
    },
    async content(id) {
      return html[id] ?? '';
    },
    async putContent(id, body, expected) {
      opts.onPut?.(id);
      if (expected !== undefined && (html[id] ?? '') !== expected) return false;
      log.push(`put ${id}`);
      if (opts.failPut === id) throw new Error('HTTP 500');
      html[id] = body;
      return true;
    },
    async calendarDay(date) {
      log.push(`calendar ${date}`);
      const found = Object.values(notes).find((n) => n.attributes[0]?.value === date);
      if (found) return found;
      const created = day(`new-${date}`, date);
      notes[created.noteId] = created;
      html[created.noteId] = '';
      return created;
    },
  };
  return { api, html, log, notes };
}

const req = { noteId: 'mon', listItemId: 'eone', to: '2026-10-27' };
let n = 0;
const opts = { states: STATES, newId: () => `enew${++n}` };

describe('forwardTasks', () => {
  it('writes the target first, then the source', async () => {
    const f = fake();
    const [r] = await forwardTasks(f.api, [req], opts);
    expect(r).toMatchObject({ status: 'moved', writtenNoteIds: ['tue', 'mon'] });
    expect(f.log.filter((l) => l.startsWith('put'))).toEqual(['put tue', 'put mon']);
    expect(f.html.tue).toContain('Write it <a href="#root/mon">from Monday 26</a>');
    expect(f.html.mon).toContain('data-trilium-task-state="_rescheduled"');
    expect(f.html.mon).toContain('<em>scheduled <a href="#root/tue">Tuesday 27</a></em>');
    expect(f.html.mon).toContain(li('etwo', 'Other'));
  });

  it('is a no-op when the item is already scheduled for that day', async () => {
    const f = fake();
    await forwardTasks(f.api, [req], opts);
    const after = { ...f.html };
    f.log.length = 0;
    const [again] = await forwardTasks(f.api, [req], opts);
    expect(again).toMatchObject({ status: 'skipped', reason: 'already_moved', detail: 'already scheduled for 2026-10-27' });
    expect(f.log.some((l) => l.startsWith('put'))).toBe(false);
    expect(f.html).toEqual(after);
  });

  it('says so when the item was rescheduled to a different day', async () => {
    const f = fake();
    f.notes.wed = day('wed', '2026-10-28');
    f.html.wed = '';
    await forwardTasks(f.api, [req], opts);
    const [r] = await forwardTasks(f.api, [{ ...req, to: '2026-10-28' }], opts);
    expect(r).toMatchObject({ status: 'skipped', reason: 'already_moved', detail: 'already rescheduled to another day' });
  });

  it('skips with a reason for unknown, closed and same-day items', async () => {
    const f = fake();
    f.html.mon += ul(li('edone', 'Finished', true));
    const rs = await forwardTasks(
      f.api,
      [{ ...req, listItemId: 'enope' }, { ...req, listItemId: 'edone' }, { ...req, to: '2026-10-26' }, { ...req, to: 'tomorrow' }],
      opts,
    );
    expect(rs.map((r) => (r.status === 'skipped' ? r.reason : r.status))).toEqual(['not_found', 'not_live', 'same_day', 'bad_request']);
    expect(f.log.some((l) => l.startsWith('put'))).toBe(false);
  });

  it('aborts without writing when the target changed since the first read', async () => {
    const f = fake({
      onPut: (id) => {
        if (id === 'tue') f.html.tue += '<p>typed meanwhile</p>';
      },
    });
    const [r] = await forwardTasks(f.api, [req], opts);
    expect(r).toMatchObject({ status: 'skipped', reason: 'edited' });
    expect(f.log.some((l) => l.startsWith('put'))).toBe(false);
    expect(f.html.mon).not.toContain('_rescheduled');
  });

  it('leaves the source unmarked when it changed, and the next run finishes without duplicating', async () => {
    let edit = true;
    const f = fake({
      onPut: (id) => {
        if (id === 'mon' && edit) f.html.mon += '<p>typed meanwhile</p>';
      },
    });
    const [r] = await forwardTasks(f.api, [req], opts);
    expect(r).toMatchObject({ status: 'failed' });
    expect(f.log.filter((l) => l.startsWith('put'))).toEqual(['put tue']);
    expect(f.html.mon).not.toContain('_rescheduled');
    edit = false;
    const [retry] = await forwardTasks(f.api, [req], opts);
    expect(retry).toMatchObject({ status: 'moved', detail: 'target already held the copy', writtenNoteIds: ['mon'] });
    expect(f.html.tue.match(/Write it/g)).toHaveLength(1);
    expect(f.html.mon).toContain('_rescheduled');
  });

  it('never marks the source when the target write fails', async () => {
    const f = fake({ failPut: 'tue' });
    const [r] = await forwardTasks(f.api, [req], opts);
    expect(r).toMatchObject({ status: 'failed', error: 'HTTP 500' });
    expect(f.log.filter((l) => l.startsWith('put'))).toEqual(['put tue']);
    expect(f.html.mon).not.toContain('_rescheduled');
  });

  it('handles a batch against the same notes in order', async () => {
    const f = fake();
    const rs = await forwardTasks(f.api, [req, { ...req, listItemId: 'etwo' }], opts);
    expect(rs.map((r) => r.status)).toEqual(['moved', 'moved']);
    expect(f.html.tue).toContain('Write it');
    expect(f.html.tue).toContain('Other');
    expect(f.html.mon.match(/_rescheduled/g)).toHaveLength(2);
  });

  it('a dry run writes nothing, never calls the calendar endpoint, and returns before/after', async () => {
    const f = fake();
    const [r] = await forwardTasks(f.api, [req, { ...req, to: '2026-11-02' }], { ...opts, dryRun: true });
    expect(f.log.some((l) => l.startsWith('put') || l.startsWith('calendar'))).toBe(false);
    expect(r).toMatchObject({ status: 'moved', dryRun: true });
    if (r!.status !== 'moved') throw new Error();
    expect(r.changes![0]).toMatchObject({ role: 'target', noteId: 'tue', before: f.html.tue });
    expect(r.changes![0]!.after).toContain('Write it');
    expect(r.changes![1]!.after).toContain('_rescheduled');
    // A day with no note yet is previewed, not created.
    const missing = (await forwardTasks(f.api, [{ ...req, to: '2026-11-02' }], { ...opts, dryRun: true }))[0]!;
    expect(missing).toMatchObject({ status: 'moved', dryRun: true });
    expect(f.html.mon).not.toContain('_rescheduled');
  });

  it('creates a missing day through the calendar endpoint on a real run', async () => {
    const f = fake();
    const [r] = await forwardTasks(f.api, [{ ...req, to: '2026-11-02' }], opts);
    expect(r).toMatchObject({ status: 'moved' });
    expect(f.log).toContain('calendar 2026-11-02');
    expect(f.html['new-2026-11-02']).toContain('<h2>☑️ Tasks</h2>');
    expect(f.html.mon).toContain('href="#root/new-2026-11-02"');
  });
});

describe('forwardTasks to and from weeks and months', () => {
  const seed = () =>
    fakeTrilium({
      mon: [periodNote('mon', 'dateNote', '2026-10-26'), '<h2>☑️ Tasks</h2><h3>Work</h3>' + hul(hli('eone', 'Write it'))],
      wk: [periodNote('wk', 'weekNote', '2026-W45'), '<h2>☑️ Tasks</h2><h3>Work</h3>' + hul(hli('ewk', 'Week thing'))],
      mo: [periodNote('mo', 'monthNote', '2026-11'), '<h2>☑️ Tasks</h2>' + hul(hli('emo', 'Month thing'))],
      dec: [periodNote('dec', 'monthNote', '2026-12'), '<h2>☑️ Tasks</h2>' + hul(hli('edec', 'December thing'))],
    });
  const go = (f: ReturnType<typeof seed>, noteId: string, listItemId: string, to: string, extra = {}) =>
    forwardTasks(f.api, [{ noteId, listItemId, to }], { states: STATES, newId: () => 'enewid', ...extra });

  it('forwards a day to a week, labelling both links with the note they point at', async () => {
    const f = seed();
    const [r] = await go(f, 'mon', 'eone', '2026-W45');
    expect(r).toMatchObject({ status: 'moved' });
    expect(f.html.mon).toContain('<em>scheduled <a href="#root/wk">week 45</a></em>');
    expect(f.html.wk).toContain('Write it <a href="#root/mon">from Monday 26</a>');
    expect(f.log.filter((l) => l.startsWith('put'))).toEqual(['put wk', 'put mon']);
  });

  it('forwards a day to a month, naming the year only when it differs', async () => {
    const f = seed();
    await go(f, 'mon', 'eone', '2026-11');
    expect(f.html.mon).toContain('>November</a></em>');
    expect(f.html.mo).toContain('from Monday 26</a>');

    const g = seed();
    const [r] = await go(g, 'mon', 'eone', '2027-01');
    expect(r).toMatchObject({ status: 'moved' });
    expect(g.html.mon).toContain('href="#root/new-2027-01">January 2027</a></em>');
    expect(g.html['new-2027-01']).toContain('from Monday 26</a>');
  });

  it('forwards a week or a month down to a day, and a week to a month', async () => {
    const f = seed();
    await go(f, 'wk', 'ewk', '2026-10-28');
    expect(f.html.wk).toContain('scheduled <a href="#root/new-2026-10-28">Wednesday 28</a>');
    expect(f.html['new-2026-10-28']).toContain('Week thing <a href="#root/wk">from week 45</a>');

    const [m] = await go(f, 'mo', 'emo', '2026-W46');
    expect(m).toMatchObject({ status: 'moved' });
    expect(f.html['new-2026-W46']).toContain('from November</a>');

    const g = seed();
    await go(g, 'wk', 'ewk', '2026-12');
    expect(g.html.wk).toContain('>December</a></em>');
    expect(g.html.dec).toContain('from week 45</a>');
    const [y] = await go(g, 'dec', 'edec', '2027-01-04');
    expect(y).toMatchObject({ status: 'moved' });
    expect(g.html['new-2027-01-04']).toContain('from December 2026</a>');
  });

  it('creates a missing month through calendarMonth, and a missing week through calendarWeek', async () => {
    const f = seed();
    await go(f, 'mon', 'eone', '2027-03');
    expect(f.log).toContain('create monthNote=2027-03');
    expect(f.html['new-2027-03']).toContain('Write it');
    expect(f.html['new-2027-03']).not.toContain('[…]');
    const w = seed();
    await go(w, 'mon', 'eone', '2027-W10');
    expect(w.log).toContain('create weekNote=2027-W10');
  });

  it('a dry run for a missing month or week previews against an empty note and creates nothing', async () => {
    const f = seed();
    const [r] = await go(f, 'mon', 'eone', '2027-03', { dryRun: true });
    expect(r).toMatchObject({ status: 'moved', dryRun: true });
    if (r!.status !== 'moved') throw new Error();
    expect(r.detail).toContain('month note');
    expect(r.changes![0]!.before).toBe('');
    expect(r.changes![0]!.after).toContain('Write it');
    expect(r.changes![1]!.after).toContain('March 2027');
    const [w] = await go(f, 'mon', 'eone', '2027-W10', { dryRun: true });
    if (w!.status !== 'moved') throw new Error();
    expect(w.detail).toContain('week note');
    expect(f.log).toEqual([]);
  });

  it('skips a forward to the note the task is already in, whatever its period', async () => {
    const f = seed();
    const rs = await forwardTasks(
      f.api,
      [
        { noteId: 'mon', listItemId: 'eone', to: '2026-10-26' },
        { noteId: 'wk', listItemId: 'ewk', to: '2026-W45' },
        { noteId: 'mo', listItemId: 'emo', to: '2026-11' },
      ],
      { states: STATES },
    );
    expect(rs.map((r) => (r.status === 'skipped' ? r.reason : r.status))).toEqual(['same_day', 'same_day', 'same_day']);
    expect(rs[0]).toMatchObject({ detail: expect.stringContaining('same note') });
    expect(f.log).toEqual([]);
  });

  it('rejects a malformed target', async () => {
    const f = seed();
    const rs = await forwardTasks(f.api, [{ noteId: 'mon', listItemId: 'eone', to: '2026-W5' }, { noteId: 'mon', listItemId: 'eone', to: '2026-13' }], { states: STATES });
    expect(rs.map((r) => (r.status === 'skipped' ? r.reason : r.status))).toEqual(['bad_request', 'bad_request']);
  });

  it("rejects a day, week or month that doesn't exist, and creates nothing", async () => {
    const f = seed();
    const tos = ['2026-02-30', '2025-W53', '2026-13', '2026-00', '2026-W00'];
    const rs = await forwardTasks(f.api, tos.map((to) => ({ noteId: 'mon', listItemId: 'eone', to })), { states: STATES });
    expect(rs.map((r) => (r.status === 'skipped' ? r.reason : r.status))).toEqual(tos.map(() => 'bad_request'));
    expect(f.log).toEqual([]);
    // 2026 has 53 ISO weeks.
    expect((await forwardTasks(f.api, [{ noteId: 'mon', listItemId: 'eone', to: '2026-W53' }], { states: STATES }))[0]).toMatchObject({ status: 'moved' });
  });

  it('replaces the untouched template placeholder in a freshly created period note', async () => {
    const f = seed();
    await go(f, 'mon', 'eone', '2027-W10');
    expect(f.html['new-2027-W10']).not.toContain('[…]');
  });
});
