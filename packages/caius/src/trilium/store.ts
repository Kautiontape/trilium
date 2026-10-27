// The note store the planning code depends on. etapiClient() adapts ETAPI to it;
// a host that owns the notes can implement it directly.

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
}

export interface NoteReader {
  search(query: string, ancestorNoteId?: string): Promise<StoreNote[]>;
  note(noteId: string): Promise<StoreNote>;
  content(noteId: string): Promise<string>;
  /** Replace a note's content with raw HTML (no markdown conversion). */
  putContent(noteId: string, html: string): Promise<void>;
  /** The day note for YYYY-MM-DD; Trilium creates it if it doesn't exist yet. */
  calendarDay(date: string): Promise<StoreNote>;
}

/** The planning commands also create period notes and add labels. */
export interface NoteStore extends NoteReader {
  /** The week note for YYYY-Www; Trilium creates it if it doesn't exist yet. */
  calendarWeek(week: string): Promise<StoreNote>;
  /** The month note for YYYY-MM; Trilium creates it if it doesn't exist yet. */
  calendarMonth(month: string): Promise<StoreNote>;
  /** Add a (possibly repeated) label to a note. */
  addLabel(noteId: string, name: string, value: string): Promise<void>;
}

export function label(note: StoreNote, name: string): string | undefined {
  return note.attributes.find((a) => a.type === 'label' && a.name === name)?.value;
}
