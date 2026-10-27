// Trilium Journal → VaultDocs with virtual paths the resolver can classify.
//
// Periodic notes are found by label under the calendar root and named by the
// label's date, so the date-relative horizon (§5, D8) works unchanged:
//   #dateNote=2026-10-26   → Journal/Daily/2026-10-26.md
//   #weekNote=2026-W44     → Journal/Weekly/2026-W44.md
//   #monthNote=2026-10     → Journal/Monthly/2026-10.md
// A periodic note's direct children (not themselves periodic) count as part of
// that period: Journal/Daily/2026-10-26/2026-10-26 <title>.md. Protected notes,
// non-text notes and the morning brief's own notes (#morningBrief) are skipped.

import type { VaultDoc } from '../index/index.js';
import { label, type NoteReader, type StoreNote } from './store.js';
import { htmlToMarkdownWithIds, DEFAULT_STATE_SYMBOLS, type StateSymbols } from './markdown.js';
import { neutralizeSuggested } from './sections.js';

export interface TriliumDoc extends VaultDoc {
  noteId: string;
  /** `text` is what the scanner sees: Suggested items have no checkbox, so they stay out of the funnel. */
  fullText: string;
  /** 0-based lines of task lines under the Suggested heading. */
  suggested: Set<number>;
  /** 0-based lines of tasks inside an Important block (they end in `!!!` in the text). */
  critical: Set<number>;
  /** 0-based line of `text` → the Trilium `data-list-item-id` of the `<li>` it came from. */
  itemIds: Map<number, string>;
}

export interface JournalLoad {
  docs: TriliumDoc[];
  calendarRootId: string;
  skipped: { protected: number; brief: number; nonText: number };
}

const PERIODIC = [
  { label: 'dateNote', folder: 'Daily' },
  { label: 'weekNote', folder: 'Weekly' },
  { label: 'monthNote', folder: 'Monthly' },
] as const;

const SKIP_LABELS = ['morningBrief'];
const CONCURRENCY = 8;

/** stateId → markdown symbol from the live `_taskStates` notes; defaults if unreadable. */
export async function loadStateSymbols(api: NoteReader): Promise<StateSymbols> {
  try {
    const container = await api.note('_taskStates');
    const states = await Promise.all(container.childNoteIds.map((id) => api.note(id)));
    const map = new Map<string, string>();
    for (const s of states) {
      const id = label(s, 'stateId');
      const symbol = label(s, 'markdownSymbol');
      if (id && symbol) map.set(id, symbol);
    }
    return map.size ? map : DEFAULT_STATE_SYMBOLS;
  } catch {
    return DEFAULT_STATE_SYMBOLS;
  }
}

export async function loadJournal(api: NoteReader): Promise<JournalLoad> {
  const roots = await api.search('#calendarRoot');
  const root = roots[0];
  if (!root) throw new Error('no note with #calendarRoot');

  const states = await loadStateSymbols(api);
  const periodic = await api.search(PERIODIC.map((p) => `#${p.label}`).join(' OR '), root.noteId);
  const periodicIds = new Set(periodic.map((n) => n.noteId));
  const skipped = { protected: 0, brief: 0, nonText: 0 };

  // One entry per note to read: the note, and the path it becomes.
  const wanted: { note: StoreNote; path: string }[] = [];
  const taken = new Set<string>();
  const claim = (base: string, noteId: string): string => {
    const path = taken.has(`${base}.md`) ? `${base} (${noteId}).md` : `${base}.md`;
    taken.add(path);
    return path;
  };
  const keep = (note: StoreNote): boolean => {
    if (SKIP_LABELS.some((l) => label(note, l) !== undefined)) {
      skipped.brief++;
      return false;
    }
    if (note.isProtected) {
      skipped.protected++;
      return false;
    }
    if (note.type !== 'text') {
      skipped.nonText++;
      return false;
    }
    return true;
  };

  const childIds: { id: string; dir: string; key: string }[] = [];
  for (const note of periodic) {
    const kind = PERIODIC.find((p) => label(note, p.label) !== undefined);
    const key = kind && label(note, kind.label);
    if (!kind || !key || !keep(note)) continue;
    wanted.push({ note, path: claim(`Journal/${kind.folder}/${key}`, note.noteId) });
    for (const id of note.childNoteIds) {
      if (!periodicIds.has(id)) childIds.push({ id, dir: `Journal/${kind.folder}/${key}`, key });
    }
  }

  const children = await mapLimit(childIds, CONCURRENCY, async (c) => ({ ...c, note: await api.note(c.id) }));
  for (const c of children) {
    if (!keep(c.note)) continue;
    wanted.push({ note: c.note, path: claim(`${c.dir}/${c.key} ${safeName(c.note.title)}`, c.note.noteId) });
  }

  const docs = await mapLimit(wanted, CONCURRENCY, async ({ note, path }): Promise<TriliumDoc> => {
    return buildDoc(note, path, await api.content(note.noteId), states);
  });
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return { docs, calendarRootId: root.noteId, skipped };
}

/** One note's HTML as a document: scanner text, full text, item ids, critical and Suggested lines. */
export function buildDoc(note: StoreNote, path: string, html: string, states: StateSymbols): TriliumDoc {
  const { markdown, itemIds, critical } = htmlToMarkdownWithIds(html, states);
  const { text, suggested } = neutralizeSuggested(markdown);
  return {
    path,
    noteId: note.noteId,
    text,
    fullText: markdown,
    suggested,
    critical,
    itemIds,
    mtime: Date.parse(note.utcDateModified) || 0,
  };
}

function safeName(title: string): string {
  return title.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim() || 'untitled';
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
