// Minimal ETAPI client: search, note metadata, note content, and the writes used
// by the planning commands: putContent (raw HTML, stored as-is), the calendar
// endpoints (which create the day, week or month note from the Journal template
// if it's missing) and addLabel. The token
// travels only in the Authorization header. putContent must send text/plain: the
// server's express.text() leaves the body null for any other content type.

export interface EtapiAttribute {
  type: 'label' | 'relation';
  name: string;
  value: string;
}

export interface EtapiNote {
  noteId: string;
  title: string;
  type: string;
  isProtected: boolean;
  parentNoteIds: string[];
  childNoteIds: string[];
  attributes: EtapiAttribute[];
  utcDateModified: string;
}

export interface Etapi {
  search(query: string, ancestorNoteId?: string): Promise<EtapiNote[]>;
  note(noteId: string): Promise<EtapiNote>;
  content(noteId: string): Promise<string>;
  /** Replace a note's content with raw HTML (no markdown conversion). */
  putContent(noteId: string, html: string): Promise<void>;
  /** The day note for YYYY-MM-DD; Trilium creates it if it doesn't exist yet. */
  calendarDay(date: string): Promise<EtapiNote>;
}

/** The planning commands also create period notes and add labels. */
export interface PlanEtapi extends Etapi {
  /** The week note for YYYY-Www; Trilium creates it if it doesn't exist yet. */
  calendarWeek(week: string): Promise<EtapiNote>;
  /** The month note for YYYY-MM; Trilium creates it if it doesn't exist yet. */
  calendarMonth(month: string): Promise<EtapiNote>;
  /** Add a (possibly repeated) label to a note. */
  addLabel(noteId: string, name: string, value: string): Promise<void>;
}

/** `http://localhost:8080` and `https://host` both work; a bare host gets https. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function etapiClient(baseUrl: string, token: string): PlanEtapi {
  const root = `${normalizeBaseUrl(baseUrl)}/etapi`;
  const get = async (path: string): Promise<Response> => {
    const res = await fetch(`${root}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`ETAPI ${path.split('?')[0]}: HTTP ${res.status}`);
    return res;
  };
  return {
    async search(query, ancestorNoteId) {
      const params = new URLSearchParams({ search: query, fastSearch: 'true' });
      if (ancestorNoteId) params.set('ancestorNoteId', ancestorNoteId);
      const body = (await (await get(`/notes?${params}`)).json()) as { results: EtapiNote[] };
      return body.results;
    },
    async note(noteId) {
      return (await (await get(`/notes/${encodeURIComponent(noteId)}`)).json()) as EtapiNote;
    },
    async content(noteId) {
      return (await get(`/notes/${encodeURIComponent(noteId)}/content`)).text();
    },
    async putContent(noteId, html) {
      const path = `/notes/${encodeURIComponent(noteId)}/content`;
      const res = await fetch(`${root}${path}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain; charset=utf-8' },
        body: html,
      });
      if (!res.ok) throw new Error(`ETAPI PUT /notes/:id/content: HTTP ${res.status}`);
    },
    async calendarDay(date) {
      return (await (await get(`/calendar/days/${encodeURIComponent(date)}`)).json()) as EtapiNote;
    },
    async calendarWeek(week) {
      return (await (await get(`/calendar/weeks/${encodeURIComponent(week)}`)).json()) as EtapiNote;
    },
    async calendarMonth(month) {
      return (await (await get(`/calendar/months/${encodeURIComponent(month)}`)).json()) as EtapiNote;
    },
    async addLabel(noteId, name, value) {
      const res = await fetch(`${root}/attributes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ noteId, type: 'label', name, value, isInheritable: false }),
      });
      if (!res.ok) throw new Error(`ETAPI POST /attributes: HTTP ${res.status}`);
    },
  };
}

export function label(note: EtapiNote, name: string): string | undefined {
  return note.attributes.find((a) => a.type === 'label' && a.name === name)?.value;
}
