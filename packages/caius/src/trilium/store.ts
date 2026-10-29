// The note store the planning code depends on. etapiClient() adapts ETAPI to it;
// a host that owns the notes can implement it directly.

import { ensureListItemIds } from './html-util.js';

export interface StoreAttribute {
  type: 'label' | 'relation';
  name: string;
  value: string;
}

export interface StoreNote {
  noteId: string;
  title: string;
  type: string;
  isProtected: boolean;
  parentNoteIds: string[];
  childNoteIds: string[];
  attributes: StoreAttribute[];
  utcDateModified: string;
  /** When the note was made. Of two notes labelled for one period, the older is the period's note. */
  utcDateCreated?: string;
}

export interface NoteReader {
  search(query: string, ancestorNoteId?: string): Promise<StoreNote[]>;
  note(noteId: string): Promise<StoreNote>;
  content(noteId: string): Promise<string>;
  /**
   * Replace a note's content with raw HTML (no markdown conversion). With `expected`, the write is a
   * compare-and-swap: it happens only while the note still holds exactly `expected`, and otherwise
   * writes nothing and resolves false.
   */
  putContent(noteId: string, html: string, expected?: string): Promise<boolean>;
  /** The day note for YYYY-MM-DD; Trilium creates it if it doesn't exist yet. Of two, the older (`oldestFirst`). */
  calendarDay(date: string): Promise<StoreNote>;
  /**
   * Every note labelled `#labelName=key` under the calendar root, archived ones included, as the
   * calendar finds them. Optional: `findPeriodNotes` searches instead when a store has none.
   */
  periodNotes?(labelName: string, key: string): Promise<StoreNote[]>;
}

/** The planning commands also create period notes and add labels. */
export interface NoteStore extends NoteReader {
  /** The week note for YYYY-Www; Trilium creates it if it doesn't exist yet. Of two, the older. */
  calendarWeek(week: string): Promise<StoreNote>;
  /** The month note for YYYY-MM; Trilium creates it if it doesn't exist yet. Of two, the older. */
  calendarMonth(month: string): Promise<StoreNote>;
  /** Add a (possibly repeated) label to a note. */
  addLabel(noteId: string, name: string, value: string): Promise<void>;
}

/**
 * `store` with every `putContent` passed through `ensureListItemIds`, keeping its `expected`, so
 * no list item Caius writes is left without an id.
 */
export function withListItemIds<S extends NoteReader>(store: S, newId?: () => string): S {
  return {
    ...store,
    putContent: (noteId: string, html: string, expected?: string) => store.putContent(noteId, ensureListItemIds(html, newId), expected),
  };
}

/**
 * `notes` oldest first, by `utcDateCreated`, then by `noteId`, so the order never depends on a
 * search's. A note without a creation time sorts last.
 */
export function oldestFirst<N extends Pick<StoreNote, 'noteId' | 'utcDateCreated'>>(notes: N[]): N[] {
  const created = (note: N) => note.utcDateCreated || '\uffff';
  return [...notes].sort((a, b) => created(a).localeCompare(created(b)) || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
}

export function label(note: StoreNote, name: string): string | undefined {
  return note.attributes.find((a) => a.type === 'label' && a.name === name)?.value;
}
