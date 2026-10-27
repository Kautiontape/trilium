// Minimal ETAPI client implementing NoteStore: search, note metadata, note content,
// and the writes used by the planning commands: putContent (raw HTML, stored as-is),
// the calendar endpoints (which create the day, week or month note from the Journal
// template if it's missing) and addLabel. The token
// travels only in the Authorization header. putContent must send text/plain: the
// server's express.text() leaves the body null for any other content type.

import type { NoteStore, StoreNote } from './store.js';

/** `http://localhost:8080` and `https://host` both work; a bare host gets https. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function etapiClient(baseUrl: string, token: string): NoteStore {
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
      const body = (await (await get(`/notes?${params}`)).json()) as { results: StoreNote[] };
      return body.results;
    },
    async note(noteId) {
      return (await (await get(`/notes/${encodeURIComponent(noteId)}`)).json()) as StoreNote;
    },
    async content(noteId) {
      return (await get(`/notes/${encodeURIComponent(noteId)}/content`)).text();
    },
    async putContent(noteId, html, expected) {
      const path = `/notes/${encodeURIComponent(noteId)}/content`;
      // ETAPI has no conditional PUT, so the compare-and-swap is a read then a write: an edit that
      // lands between the two is overwritten. The window is one round trip.
      if (expected !== undefined && (await (await get(path)).text()) !== expected) return false;
      const res = await fetch(`${root}${path}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain; charset=utf-8' },
        body: html,
      });
      if (!res.ok) throw new Error(`ETAPI PUT /notes/:id/content: HTTP ${res.status}`);
      return true;
    },
    async calendarDay(date) {
      return (await (await get(`/calendar/days/${encodeURIComponent(date)}`)).json()) as StoreNote;
    },
    async calendarWeek(week) {
      return (await (await get(`/calendar/weeks/${encodeURIComponent(week)}`)).json()) as StoreNote;
    },
    async calendarMonth(month) {
      return (await (await get(`/calendar/months/${encodeURIComponent(month)}`)).json()) as StoreNote;
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
