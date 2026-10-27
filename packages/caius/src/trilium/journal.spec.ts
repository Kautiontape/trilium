import { describe, it, expect, beforeAll } from 'vitest';
import { scanDocs, type ScanResult } from '../index/index.js';
import { loadJournal, type JournalLoad } from './journal.js';
import { TRILIUM_CONFIG } from './config.js';
import { openTasks } from './open.js';
import type { NoteReader, StoreNote } from './store.js';

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
