// The Morning Brief's HTML: the header note, the brief's body, and the day note's include-note of
// the header. The markup matches what CKEditor stores, so the editor loads it without changing it.

import { parse } from 'node-html-parser';
import { escapeHtml } from './plan-html.js';

/** An include-note block showing note `noteId` in full, as CKEditor's `includeNote` downcasts it. */
export function includeNote(noteId: string): string {
  return `<section class="include-note" data-note-id="${escapeHtml(noteId)}" data-box-size="full">&nbsp;</section>`;
}

/**
 * `html` with an include-note of `noteId` at the very top, unless one of that note is already
 * anywhere in it. Nothing else changes.
 */
export function withInclude(html: string, noteId: string): string {
  const present = parse(html, { comment: true })
    .querySelectorAll('section.include-note')
    .some((section) => section.getAttribute('data-note-id') === noteId);
  return present ? html : includeNote(noteId) + html;
}

export interface BriefAct {
  range: string;
  text: string;
}

/** The header note: the date line, the headline, the drawing and the three acts as one table row. */
export function headerHtml(header: { dateLine: string; headline: string; image: { src: string; alt: string }; acts: BriefAct[] }): string {
  const cells = header.acts
    .map((act) => `<td><p><strong>${escapeHtml(act.range)}</strong></p><p>${escapeHtml(act.text)}</p></td>`)
    .join('');
  return (
    `<p>${escapeHtml(header.dateLine)}</p><h2>${escapeHtml(header.headline)}</h2>` +
    `<p><img src="${escapeHtml(header.image.src)}" alt="${escapeHtml(header.image.alt).replace(/"/g, '&quot;')}"></p>` +
    `<figure class="table"><table><tbody><tr>${cells}</tr></tbody></table></figure>`
  );
}

/**
 * The brief's body: the header's include-note, the picks as plain bullets under `picksTitle`, then
 * each section under its own heading. A section's `html` is trusted (rendered from markdown).
 */
export function briefBodyHtml(brief: { headerNoteId: string; picksTitle: string; picks: string[]; sections: { title: string; html: string }[] }): string {
  const picks = brief.picks.length ? `<ul>${brief.picks.map((pick) => `<li>${escapeHtml(pick)}</li>`).join('')}</ul>` : '';
  const sections = brief.sections.map((section) => `<h2>${escapeHtml(section.title)}</h2>${section.html}`).join('');
  return `${includeNote(brief.headerNoteId)}<h2>${escapeHtml(brief.picksTitle)}</h2>${picks}${sections}`;
}
