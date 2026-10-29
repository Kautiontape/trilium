import { describe, it, expect, beforeAll } from 'vitest';
import { scanDocs, type ScanResult } from '../index/index.js';
import { loadJournal, type JournalLoad } from './journal.js';
import { TRILIUM_CONFIG } from './config.js';
import { openTasks } from './open.js';
import { duplicateWarnings, findPeriodNote, findPeriodNotes, readDuplicatePlans } from './plan-read.js';
import { oldestFirst, type NoteReader, type StoreNote } from './store.js';

const now = new Date(2026, 9, 26); // Mon 26 Oct 2026, ISO week 44

const note = (noteId: string, labels: Record<string, string>, extra: Partial<StoreNote> = {}): StoreNote => ({
  noteId,
  title: noteId,
  type: 'text',
  isProtected: false,
  parentNoteIds: [],
  childNoteIds: [],
  attributes: Object.entries(labels).map(([name, value]) => ({ type: 'label' as const, name, value })),
  utcDateModified: '2026-10-26 08:00:00.000Z',
  ...extra,
});

const list = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const todoItem = (id: string, text: string, checked = false) =>
  `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox"${checked ? ' checked="checked"' : ''} disabled="disabled"><span class="todo-list__label__description">${text}</span></label></li>`;

const notes: Record<string, StoreNote> = {
  root: note('root', { calendarRoot: '' }),
  month: note('month', { monthNote: '2026-10' }, { childNoteIds: ['week'] }),
  week: note('week', { weekNote: '2026-W44' }, { childNoteIds: ['today', 'past'] }),
  today: note('today', { dateNote: '2026-10-26' }, { childNoteIds: ['child', 'brief', 'secret'] }),
  past: note('past', { dateNote: '2026-10-19' }),
  child: note('child', {}, { title: 'Prep / notes' }),
  brief: note('brief', { morningBrief: '2026-10-26' }),
  secret: note('secret', {}, { isProtected: true }),
};

const content: Record<string, string> = {
  month: list('[ ] Month task'),
  week: list('[ ] Week task'),
  today: list('[ ] Today task', '[x] Done today'),
  past: `<ul class="todo-list">${todoItem('e1', 'Left behind')}${todoItem('e2', 'Done before', true)}</ul>${list('[>] Moved on')}`,
  child: list('[/] Child task'),
  brief: list('[ ] Brief line that must not be indexed'),
};

const fake: NoteReader = {
  async search(query) {
    if (query === '#calendarRoot') return [notes.root!];
    return ['month', 'week', 'today', 'past'].map((id) => notes[id]!);
  },
  async note(id) {
    if (id === '_taskStates') throw new Error('not here');
    const n = notes[id];
    if (!n) throw new Error(`no note ${id}`);
    return n;
  },
  async content(id) {
    return content[id] ?? '';
  },
  async putContent(): Promise<boolean> {
    throw new Error('read-only fake');
  },
  async calendarDay() {
    throw new Error('read-only fake');
  },
};

let load: JournalLoad;
let result: ScanResult;

beforeAll(async () => {
  load = await loadJournal(fake);
  result = scanDocs(load.docs, TRILIUM_CONFIG, now);
});

const horizon = (text: string) => result.tasks.find((t) => t.text === text)?.horizon;

describe('loadJournal', () => {
  it('names periodic notes by their label and children under them', () => {
    expect(load.docs.map((d) => d.path)).toEqual([
      'Journal/Daily/2026-10-19.md',
      'Journal/Daily/2026-10-26.md',
      'Journal/Daily/2026-10-26/2026-10-26 Prep - notes.md',
      'Journal/Monthly/2026-10.md',
      'Journal/Weekly/2026-W44.md',
    ]);
    expect(load.docs.find((d) => d.path.endsWith('Prep - notes.md'))?.noteId).toBe('child');
  });

  it('skips the brief and protected notes', () => {
    expect(load.skipped).toEqual({ protected: 1, brief: 1, nonText: 0 });
    expect(result.tasks.some((t) => t.text.startsWith('Brief line'))).toBe(false);
  });
});

describe('Trilium horizons', () => {
  it('classifies by period relative to now', () => {
    expect(horizon('Today task')).toBe('today');
    expect(horizon('Child task')).toBe('today');
    expect(horizon('Week task')).toBe('week');
    expect(horizon('Month task')).toBe('orbit');
    expect(horizon('Left behind')).toBe('overdue');
  });

  it('counts only live tasks in the funnel', () => {
    expect(result.report.funnel).toMatchObject({ today: 2, week: 1, orbit: 1, overdue: 1 });
    expect(result.report.byState.tombstone).toBe(1);
  });
});

describe('openTasks', () => {
  it('lists live tasks with their note id, period and parent', () => {
    const open = openTasks(load.docs, result);
    expect(open.map((t) => t.text).sort()).toEqual(['Child task', 'Left behind', 'Month task', 'Today task', 'Week task']);
    const behind = open.find((t) => t.text === 'Left behind')!;
    expect(behind).toMatchObject({ noteId: 'past', period: '2026-10-19', horizon: 'overdue', state: 'open', parent: null });
    expect(open.find((t) => t.text === 'Child task')).toMatchObject({ noteId: 'child', period: '2026-10-26' });
    expect(open.find((t) => t.text === 'Week task')?.period).toBe('2026-W44');
  });

  it('carries each task\'s list-item id, or null when its li has none', () => {
    const open = openTasks(load.docs, result);
    expect(open.find((t) => t.text === 'Left behind')?.listItemId).toBe('e1');
    expect(open.find((t) => t.text === 'Today task')?.listItemId).toBeNull();
  });
});

describe('a period with two notes', () => {
  // The newer note comes first in the search, as Trilium's own search can return it.
  const dupes: Record<string, StoreNote> = {
    root: note('root', { calendarRoot: '' }),
    newer: note('newer', { dateNote: '2026-10-28', caiusWoundDown: '2026-10-28T18:00:00' }, { utcDateCreated: '2026-10-28 19:00:00.000Z' }),
    older: note('older', { dateNote: '2026-10-28' }, { utcDateCreated: '2026-10-28 07:00:00.000Z' }),
  };
  const html: Record<string, string> = {
    newer: `<ul class="todo-list">${todoItem('n1', 'Stray task')}</ul>`,
    older: `<ul class="todo-list">${todoItem('o1', 'Real task')}</ul>`,
  };
  const reader: NoteReader = {
    ...fake,
    async search(query) {
      if (query === '#calendarRoot') return [dupes.root!];
      return [dupes.newer!, dupes.older!];
    },
    async note(id) {
      if (id === '_taskStates') throw new Error('not here');
      return dupes[id]!;
    },
    async content(id) {
      return html[id] ?? '';
    },
  };

  it('is the older note, whatever the search returns first or the newer one carries', async () => {
    expect((await findPeriodNote(reader, 'day', '2026-10-28'))?.noteId).toBe('older');
    expect((await findPeriodNotes(reader, 'day', '2026-10-28')).map((n) => n.noteId)).toEqual(['older', 'newer']);
    expect(await duplicateWarnings(reader, [{ period: 'day', key: '2026-10-28' }, { period: 'day', key: '2026-10-28' }])).toEqual([
      '2026-10-28 has a second day note newer; using the older older.',
    ]);
  });

  it('gives the older note the period\'s path and reads the newer as part of the period, so its open tasks still count', async () => {
    const loaded = await loadJournal(reader);
    expect(loaded.docs.map((d) => [d.path, d.noteId])).toEqual([
      ['Journal/Daily/2026-10-28.md', 'older'],
      ['Journal/Daily/2026-10-28/2026-10-28 (newer).md', 'newer'],
    ]);
    const open = openTasks(loaded.docs, scanDocs(loaded.docs, TRILIUM_CONFIG, new Date(2026, 9, 28, 12)));
    expect(open.map((t) => [t.text, t.noteId, t.period, t.horizon])).toEqual([
      ['Real task', 'older', '2026-10-28', 'today'],
      ['Stray task', 'newer', '2026-10-28', 'today'],
    ]);
  });

  it('reads the newer note\'s plan apart, for counting its leftovers', async () => {
    const [plan, ...rest] = await readDuplicatePlans(reader, 'day', '2026-10-28', new Date(2026, 9, 28, 12));
    expect(rest).toEqual([]);
    expect(plan?.noteId).toBe('newer');
    expect(plan?.sections.flatMap((s) => s.tasks).map((t) => t.listItemId)).toEqual(['n1']);
  });

  it('sorts a note without a creation time last', () => {
    expect(oldestFirst([{ noteId: 'a' }, { noteId: 'b', utcDateCreated: '2026-10-28 19:00:00.000Z' }]).map((n) => n.noteId)).toEqual(['b', 'a']);
  });
});
