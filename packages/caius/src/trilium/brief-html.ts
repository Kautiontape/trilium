// The Morning Brief's HTML: the header note, the brief's body, and the day note's include-note of
// the header. The markup matches what CKEditor stores, so the editor loads it without changing it.

import { parse } from 'node-html-parser';
import { apply, elements, isIncludeNote } from './html-util.js';
import { escapeHtml } from './plan-html.js';

/** An include-note block showing note `noteId` in full, as CKEditor's `includeNote` downcasts it. */
export function includeNote(noteId: string): string {
  return `<section class="include-note" data-note-id="${escapeHtml(noteId)}" data-box-size="full">&nbsp;</section>`;
}

/**
 * `html` with an include-note of `noteId` at the very top, unless one of that note is already
 * anywhere in it. A leading include-note whose note `stale` says is gone or replaced (a deleted
 * header) is replaced rather than left above it. Nothing else changes.
 */
export function withInclude(html: string, noteId: string, stale: (id: string) => boolean = () => false): string {
  const root = parse(html, { comment: true });
  const present = root.querySelectorAll('section.include-note').some((section) => section.getAttribute('data-note-id') === noteId);
  if (present) return html;
  const first = elements(root)[0];
  const leading = first && isIncludeNote(first) ? first.getAttribute('data-note-id') : undefined;
  if (first && leading !== undefined && stale(leading)) {
    return apply(html, [{ start: first.range[0], end: first.range[1], text: includeNote(noteId) }]);
  }
  return includeNote(noteId) + html;
}

/** The note id of the include-note the HTML starts with, or null. */
export function leadingInclude(html: string): string | null {
  const first = elements(parse(html, { comment: true }))[0];
  return (first && isIncludeNote(first) && first.getAttribute('data-note-id')) || null;
}

/**
 * `html` without its images: every `<img>`, and a `<figure class="image">` whole. Section text can
 * come from email or Jira, so a remote image in it, such as a tracking pixel, never reaches the brief.
 */
export function withoutImages(html: string): string {
  const root = parse(html, { comment: true });
  const figures = root.querySelectorAll('figure.image');
  const images = root.querySelectorAll('img').filter((img) => !figures.some((figure) => figure.querySelectorAll('img').includes(img)));
  return apply(html, [...figures, ...images].map((el) => ({ start: el.range[0], end: el.range[1], text: '' })));
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
