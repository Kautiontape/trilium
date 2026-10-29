// Synthetic Trilium HTML and a fake note store, shared by the planning tests.
// Nothing here is real note text.

import { oldestFirst, type NoteStore, type StoreNote } from './store.js';

export const STATES = new Map([
  ['doing', '/'],
  ['cancelled', '-'],
  ['_rescheduled', '>'],
]);

export const li = (id: string, text: string, o: { checked?: boolean; state?: string; sub?: string } = {}) =>
  `<li data-list-item-id="${id}"${o.state ? ` data-trilium-task-state="${o.state}" title="${o.state === 'doing' ? 'Doing' : o.state}"` : ''}>` +
  `<label class="todo-list__label"><input type="checkbox"${o.checked ? ' checked="checked"' : ''} disabled="disabled">` +
  `<span class="todo-list__label__description">${text}</span></label>${o.sub ?? ''}</li>`;
export const ul = (...items: string[]) => `<ul class="todo-list">${items.join('')}</ul>`;
export const critical = (...items: string[]) => `<aside class="admonition important">${ul(...items)}</aside>`;
export const TEMPLATE = '<h2>☑️ Tasks</h2><ul><li data-list-item-id="etemplate">[…]</li></ul>';

export const periodNote = (noteId: string, name: string, key: string, extra: Partial<StoreNote> = {}): StoreNote => ({
  noteId,
  title: key,
  type: 'text',
  isProtected: false,
  parentNoteIds: [],
  childNoteIds: [],
  attributes: [{ type: 'label', name, value: key }],
  utcDateModified: '2026-10-26 08:00:00.000Z',
  utcDateCreated: '2026-10-26 08:00:00.000Z',
  ...extra,
});

export interface Fake {
  api: NoteStore;
  html: Record<string, string>;
  notes: Record<string, StoreNote>;
  /** Every write in order: `put id`, `label id name=value`, `create day …`. A put that lost its compare-and-swap is not one. */
  log: string[];
}

/**
 * A fake with a Journal: `notes` maps noteId → [note, html]. Creating a day, week or month
 * makes a note whose content is the Journal template.
 */
export function fakeTrilium(
  seed: Record<string, [StoreNote, string]>,
  o: { template?: string; failPut?: string; onPut?: (noteId: string) => void } = {},
): Fake {
  const notes: Record<string, StoreNote> = {};
  const html: Record<string, string> = {};
  for (const [id, [n, h]] of Object.entries(seed)) {
    notes[id] = n;
    html[id] = h;
  }
  const log: string[] = [];
  const template = o.template ?? TEMPLATE;
  const create = (name: string, key: string) => {
    log.push(`create ${name}=${key}`);
    const n = periodNote(`new-${key}`, name, key);
    notes[n.noteId] = n;
    html[n.noteId] = template;
    return n;
  };
  const period = (name: string, key: string) =>
    oldestFirst(Object.values(notes).filter((n) => n.attributes.some((a) => a.name === name && a.value === key)))[0];
  const api: NoteStore = {
    async search(q) {
      if (q === '#calendarRoot') return [periodNote('root', 'calendarRoot', '')];
      const m = /^#(\w+)="?([^"]+)"?$/.exec(q);
      if (m) return Object.values(notes).filter((n) => n.attributes.some((a) => a.name === m[1] && a.value === m[2]));
      return Object.values(notes).filter((n) => n.attributes.some((a) => ['dateNote', 'weekNote', 'monthNote'].includes(a.name)));
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
      o.onPut?.(id);
      if (expected !== undefined && (html[id] ?? '') !== expected) return false;
      log.push(`put ${id}`);
      if (o.failPut === id) throw new Error('HTTP 500');
      html[id] = body;
      return true;
    },
    // As the server's store: the oldest of a period's notes, created only when it has none.
    async calendarDay(date) {
      return period('dateNote', date) ?? create('dateNote', date);
    },
    async calendarWeek(week) {
      return period('weekNote', week) ?? create('weekNote', week);
    },
    async calendarMonth(month) {
      return period('monthNote', month) ?? create('monthNote', month);
    },
    async addLabel(noteId, name, value) {
      log.push(`label ${noteId} ${name}=${value}`);
      notes[noteId] = { ...notes[noteId]!, attributes: [...notes[noteId]!.attributes, { type: 'label', name, value }] };
    },
  };
  return { api, html, notes, log };
}
