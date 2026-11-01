import type { TaskOrigin } from "@triliumnext/caius/src/trilium/origin-html.js";

export type { TaskOrigin };

/** What the task tray's From block shows. */
export interface OriginView {
    noteId: string;
    /** "Pilot call · 2026-08-11", or a Journal note's "Tue 28 Apr"; null for the task's own note. */
    heading: string | null;
    /** "part of: Prepare the release" or "under Follow-ups". */
    place: string | null;
    neighbours: string[];
    lead: string | null;
}

/**
 * The From block for a task, or null when there is nothing to add: no origin (an older server, or
 * none found), or a task written where it is that sits under no other item, whose heading and
 * neighbours the screen already shows.
 */
export function originView(origin: TaskOrigin | null | undefined, taskNoteId: string): OriginView | null {
    if (!origin || (origin.noteId === taskNoteId && !origin.parent)) {
        return null;
    }
    const own = origin.noteId === taskNoteId;
    const under = origin.headings.at(-1);
    return {
        noteId: origin.noteId,
        heading: own ? null : sourceName(origin),
        place: origin.parent ? `part of: ${origin.parent}` : under ? `under ${under}` : null,
        // A task's own note is on screen already: only its parent is news.
        neighbours: origin.matched && !own ? origin.neighbours : [],
        lead: origin.matched && !own ? origin.lead : null
    };
}

/** A Journal note by its period ("Tue 28 Apr"), any other by its title, with the day it was made unless the title has a date. */
function sourceName(origin: TaskOrigin): string {
    if (origin.date && !/^\d{4}-\d{2}-\d{2}$/.test(origin.date)) {
        return origin.date;
    }
    return origin.date && !/\d{4}-\d{2}-\d{2}/.test(origin.title) ? `${origin.title} · ${origin.date}` : origin.title;
}
