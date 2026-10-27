import { isPeriodKey, type NoteStore, type StoreAttribute, type StoreNote } from "@triliumnext/caius";
import { attributes as attributeService, type BNote, becca, date_notes as dateNotesService, note_service as noteService, search as searchService, SearchContext } from "@triliumnext/core";

import sql from "../sql.js";

/**
 * A `NoteStore` on becca and the core services, mirroring the ETAPI handlers in
 * `apps/server/src/etapi/` call for call. ETAPI answers 4xx where this throws.
 *
 * The caller provides a `cls.init()` context, as an ETAPI request does. ETAPI also runs each
 * request in `sql.transactional()`, which takes a synchronous callback and so cannot wrap the async
 * planning functions. The members that write run in their own transaction instead, one per call,
 * the same grain as an ETAPI request.
 */
export function createBeccaStore(): NoteStore {
    return {
        async search(query, ancestorNoteId) {
            if (!query.trim()) {
                throw new Error("Search query must not be empty.");
            }

            const context = new SearchContext({ fastSearch: true, ...(ancestorNoteId ? { ancestorNoteId } : {}) });
            const results = searchService.findResultsWithQuery(query, context);
            const notes: StoreNote[] = [];
            for (const result of results) {
                const note = becca.notes[result.noteId];
                if (note) {
                    notes.push(mapNote(note));
                }
            }
            return notes;
        },

        async note(noteId) {
            return mapNote(getNote(noteId));
        },

        async content(noteId) {
            const note = getNote(noteId);
            if (note.isProtected) {
                throw new Error(`Note '${noteId}' is protected and content cannot be read.`);
            }

            return readContent(note);
        },

        async putContent(noteId, html, expected) {
            const note = getNote(noteId);
            if (note.isProtected) {
                throw new Error(`Note '${noteId}' is protected and cannot be modified.`);
            }

            // The comparison and the write share one synchronous transaction, so no other write
            // can land between them.
            const written = sql.transactional(() => {
                if (expected !== undefined && readContent(note) !== expected) {
                    return false;
                }
                noteService.saveRevisionIfNeeded(note);
                note.setContent(html);
                return true;
            });
            if (written) {
                void noteService.asyncPostProcessContent(note, html);
            }
            return written;
        },

        async calendarDay(date) {
            if (!isPeriodKey("day", date)) {
                throw new Error(`Date "${date}" is not valid.`);
            }
            return mapNote(sql.transactional(() => dateNotesService.getDayNote(date)));
        },

        async calendarWeek(week) {
            if (!isPeriodKey("week", week)) {
                throw new Error(`Week "${week}" is not valid.`);
            }

            const note = sql.transactional(() => dateNotesService.getWeekNote(week));
            if (!note) {
                throw new Error(`Week "${week}" not found. Check if week note is enabled.`);
            }
            return mapNote(note);
        },

        async calendarMonth(month) {
            if (!isPeriodKey("month", month)) {
                throw new Error(`Month "${month}" is not valid.`);
            }
            return mapNote(sql.transactional(() => dateNotesService.getMonthNote(month)));
        },

        async addLabel(noteId, name, value) {
            getNote(noteId);
            sql.transactional(() => attributeService.createAttribute({ noteId, type: "label", name, value, isInheritable: false }));
        },
    };
}

let lockTail: Promise<void> = Promise.resolve();

/** How long a call can hold the lock before `withCaiusLock` warns that it is blocking the others. */
export const LOCK_WARN_MS = 30_000;

/**
 * Runs `fn` once every Caius call queued before it has settled, so one call at a time reads and
 * writes the Journal. Every entry point of `service.ts` runs in it, and anything else that drives
 * the library against becca must too. Each call waits inside its own async function, so `fn` runs
 * in the caller's CLS context (`localNowDateTime`, `componentId`). A call that rejects still
 * releases the next one.
 *
 * The lock has no timeout, since releasing it early would let two calls overlap. Instead, a call
 * that holds it for over `LOCK_WARN_MS` logs a warning with its `name`, and logs again when it
 * releases.
 */
export async function withCaiusLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = lockTail;
    let release = () => {};
    lockTail = new Promise((resolve) => {
        release = resolve;
    });
    let acquired = 0;
    let warned = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
        await previous;
        acquired = Date.now();
        watchdog = setTimeout(() => {
            warned = true;
            console.warn(`Caius call ${name} has held the lock for over ${LOCK_WARN_MS / 1000} s; later Caius calls wait for it.`);
        }, LOCK_WARN_MS);
        watchdog.unref();
        return await fn();
    } finally {
        clearTimeout(watchdog);
        if (warned) {
            console.warn(`Caius call ${name} released the lock after ${Math.round((Date.now() - acquired) / 1000)} s.`);
        }
        release();
    }
}

function getNote(noteId: string): BNote {
    const note = becca.getNote(noteId);
    if (!note) {
        throw new Error(`Note '${noteId}' not found.`);
    }
    return note;
}

function readContent(note: BNote): string {
    const content = note.getContent();
    return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

function mapNote(note: BNote): StoreNote {
    return {
        noteId: note.noteId,
        title: note.getTitleOrProtected(),
        type: note.type,
        isProtected: !!note.isProtected,
        parentNoteIds: note.getParentNotes().map((parent) => parent.noteId),
        childNoteIds: note.getChildNotes().map((child) => child.noteId),
        attributes: mapAttributes(note),
        utcDateModified: note.utcDateModified ?? "",
    };
}

/** Labels and relations only: `StoreAttribute` has no room for `label-definition` and the like. */
function mapAttributes(note: BNote): StoreAttribute[] {
    const attributes: StoreAttribute[] = [];
    for (const attr of note.getAttributes()) {
        if (attr.type === "label" || attr.type === "relation") {
            attributes.push({ type: attr.type, name: attr.name, value: attr.value });
        }
    }
    return attributes;
}
