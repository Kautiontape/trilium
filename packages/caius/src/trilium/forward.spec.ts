import { describe, it, expect } from 'vitest';
import { forwardTasks } from './forward.js';
import type { NoteReader, StoreNote } from './store.js';

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

function fake(opts: { onGetContent?: (id: string, n: number) => void; failPut?: string } = {}) {
  const notes: Record<string, StoreNote> = { mon: day('mon', '2026-10-26'), tue: day('tue', '2026-10-27') };
  const html: Record<string, string> = {
    mon: '<h2>☑️ Tasks</h2><h3>Work</h3>' + ul(li('eone', 'Write it'), li('etwo', 'Other')),
    tue: '<h2>☑️ Tasks</h2><h3>Work</h3>' + ul(li('eexisting', 'Already here')),
  };
  const log: string[] = [];
  const reads: Record<string, number> = {};
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
      reads[id] = (reads[id] ?? 0) + 1;
      opts.onGetContent?.(id, reads[id]!);
      return html[id] ?? '';
    },
    async putContent(id, body) {
      log.push(`put ${id}`);
      if (opts.failPut === id) throw new Error('HTTP 500');
      html[id] = body;
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
    expect(r).toMatchObject({ status: 'moved' });
    expect(f.log.filter((l) => l.startsWith('put'))).toEqual(['put tue', 'put mon']);
    expect(f.html.tue).toContain('Write it <a class="reference-link" href="#root/mon">from Monday 26</a>');
    expect(f.html.mon).toContain('data-trilium-task-state="_rescheduled"');
    expect(f.html.mon).toContain('<em>scheduled <a class="reference-link" href="#root/tue">Tuesday 27</a></em>');
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
    let mutate = false;
    const f = fake({
      onGetContent: (id, count) => {
        if (id === 'tue' && count === 2 && mutate) f.html.tue += '<p>typed meanwhile</p>';
      },
    });
    mutate = true;
    const [r] = await forwardTasks(f.api, [req], opts);
    expect(r).toMatchObject({ status: 'skipped', reason: 'edited' });
    expect(f.log.some((l) => l.startsWith('put'))).toBe(false);
    expect(f.html.mon).not.toContain('_rescheduled');
  });

  it('leaves the source unmarked when it changed, and the next run finishes without duplicating', async () => {
    let edit = true;
    const f = fake({
      onGetContent: (id, count) => {
        if (id === 'mon' && count === 2 && edit) f.html.mon += '<p>typed meanwhile</p>';
      },
    });
    const [r] = await forwardTasks(f.api, [req], opts);
    expect(r).toMatchObject({ status: 'failed' });
    expect(f.log.filter((l) => l.startsWith('put'))).toEqual(['put tue']);
    expect(f.html.mon).not.toContain('_rescheduled');
    edit = false;
    const [retry] = await forwardTasks(f.api, [req], opts);
    expect(retry).toMatchObject({ status: 'moved', detail: 'target already held the copy' });
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
