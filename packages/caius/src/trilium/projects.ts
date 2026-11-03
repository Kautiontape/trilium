// Picks from active projects: a project labelled `#priorityGroup=Growth` or `Recharge` offers an hour
// of its next step as a candidate for that area. Pure on notes already read; `readProjectPicks` reads them.

import { parse } from 'node-html-parser';
import type { Area } from './areas.js';
import { descriptionOf, isTask, ownLabel } from './html-util.js';
import { label, type NoteReader, type StoreNote } from './store.js';

/** An active project note with its content, as stored. */
export type ProjectNote = StoreNote & { content: string };

export interface ProjectPick {
  area: Exclude<Area, 'foundation'>;
  project: string;
  noteId: string;
  /** The project's next unchecked step, cut short, or null when the note has none. */
  firstTask: string | null;
  /** The candidate's words: `<project>: <firstTask>`. */
  text: string;
}

/** The longest a first task runs in a pick, ellipsis included. */
const MAX_TASK = 60;

/** `text` cut at a word to fit `MAX_TASK`, with an ellipsis. */
function shorten(text: string): string {
  if (text.length <= MAX_TASK) return text;
  const room = text.slice(0, MAX_TASK - 1);
  const space = room.lastIndexOf(' ');
  const cut = text[MAX_TASK - 1] === ' ' || space < 1 ? room : room.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** The first unchecked to-do item of a note's HTML, else its first line starting with `☐ `, trimmed; or null. */
export function firstTaskOf(html: string): string | null {
  const root = parse(html);
  for (const li of root.querySelectorAll('li')) {
    const box = ownLabel(li)?.querySelector('input[type=checkbox]');
    if (!isTask(li) || !box || box.hasAttribute('checked') || li.getAttribute('data-trilium-task-state') === 'cancelled') continue;
    const text = descriptionOf(li)?.text.replace(/\s+/g, ' ').trim();
    if (text) return shorten(text);
  }
  const lines = parse(html.replace(/<\/(?:p|li|div|h[1-6])>|<br\s*\/?>/gi, '\n')).text.split('\n');
  const line = lines.map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.startsWith('☐ '));
  const text = line?.slice(2).trim();
  return text ? shorten(text) : null;
}

const priorityOf = (note: StoreNote) => {
  const n = Number(label(note, 'priority'));
  return label(note, 'priority')?.trim() && Number.isFinite(n) ? n : Infinity;
};

/**
 * The active projects whose `#priorityGroup` is `area` (ignoring case), each as a candidate of about an
 * hour on its next step, ordered by `#priority` (a number, none last) and then by title.
 */
export function projectPicks(notes: ProjectNote[], area: Exclude<Area, 'foundation'>): ProjectPick[] {
  return notes
    .filter((note) => label(note, 'priorityGroup')?.trim().toLowerCase() === area)
    .sort((a, b) => (priorityOf(a) === priorityOf(b) ? 0 : priorityOf(a) < priorityOf(b) ? -1 : 1) || a.title.localeCompare(b.title))
    .map((note) => {
      const firstTask = firstTaskOf(note.content);
      return { area, project: note.title, noteId: note.noteId, firstTask, text: `${note.title}${firstTask ? `: ${firstTask}` : ''}` };
    });
}

/** `projectPicks` for the active projects (`#status=active #priorityGroup`) found in the store. */
export async function readProjectPicks(api: NoteReader, area: Exclude<Area, 'foundation'>): Promise<ProjectPick[]> {
  const found = await api.search('#status=active #priorityGroup');
  const matching = found.filter((note) => label(note, 'priorityGroup')?.trim().toLowerCase() === area);
  const notes = await Promise.all(
    matching.map(async (note): Promise<ProjectNote> => ({ ...note, content: note.type === 'text' && !note.isProtected ? await api.content(note.noteId) : '' })),
  );
  return projectPicks(notes, area);
}
