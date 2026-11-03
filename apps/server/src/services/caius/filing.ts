/**
 * Where a new task goes in a day note: under the time block it names, else by its area. Growth and
 * Recharge go under Evening; Foundation goes under Morning when the note has that heading, else at
 * the end of the main list (`undefined`).
 */

import { type Area, type Block, blockOf, findPeriodNote, type NoteStore } from "@triliumnext/caius";

/** Whether the day note of `date` has a heading for `block`, Morning or Afternoon however it is dressed. */
export async function hasBlock(store: NoteStore, date: string, block: Block): Promise<boolean> {
    const note = await findPeriodNote(store, "day", date);
    if (!note || note.type !== "text" || note.isProtected) return false;
    const html = await store.content(note.noteId);
    return [ ...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi) ].some((m) => blockOf((m[1] ?? "").replace(/<[^>]+>/g, "")) === block);
}

/** The time block a new task of `area` is filed under on `date`: `given` when he names one, else by its area; `undefined` for the end of the main list. */
export async function blockFor(store: NoteStore, date: string, area: Area, given?: Block): Promise<Block | undefined> {
    if (given) return given;
    if (area !== "foundation") return "evening";
    return await hasBlock(store, date, "morning") ? "morning" : undefined;
}
