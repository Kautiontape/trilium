/**
 * The trail of a task: every copy of it across the day, week and month notes, in the order the
 * task moved through them. The Item view, the Slipping view and the wind-down's park read it, so
 * they count the same moves.
 */

import { bareText, loadJournal, type NoteStore, scanDocs, TRILIUM_CONFIG, type TriliumDoc } from "@triliumnext/caius";

import { copyKey, fromOf, plainText, SCHEDULED, withoutMoveLinks } from "./daily.js";

export type TrailPeriodKind = "day" | "week" | "month";

/** One copy of a task: where it sits, its state, and whether it moved on from there. */
export interface TrailCopy {
    kind: TrailPeriodKind;
    /** The period key: `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM`. */
    period: string;
    noteId: string;
    listItemId: string | null;
    state: string;
    /** True for a tombstone or a copy marked `_scheduled [..](#root/..)_`; false for where the task lives now. */
    movedOn: boolean;
}

export interface Trail {
    /** The `trailKey` every copy shares. */
    key: string;
    /** Oldest period first; a moved copy comes before the live one in the same period. */
    copies: TrailCopy[];
    /** How many copies moved on from a day note. */
    slips: number;
}

export type Trails = Map<string, Trail>;

type ScanResult = ReturnType<typeof scanDocs>;

/** The item a trail is looked up for. */
export interface TrailItem {
    noteId: string;
    listItemId: string | null;
    text: string;
}

/** The trail of every task in the journal, by `trailKey`. The caller holds the lock. */
export async function trails(store: NoteStore, now: Date): Promise<Trails> {
    return trailsOf((await loadJournal(store)).docs, now);
}

/** The trail of every task in `docs`, the Journal a caller already loaded, by `trailKey`; `scan` is `docs` scanned as of `now`. */
export function trailsOf(docs: TriliumDoc[], now: Date, scan: ScanResult = scanDocs(docs, TRILIUM_CONFIG, now)): Trails {
    const byPath = new Map(docs.map((doc) => [ doc.path, doc ]));
    const result: Trails = new Map();
    for (const task of scan.tasks) {
        const doc = byPath.get(task.file);
        const where = doc && periodOf(task.file);
        if (!doc || !where) continue;
        const key = trailKey(task.text, doc.noteId);
        const movedOn = task.state === "tombstone" || SCHEDULED.test(task.text);
        const trail = result.get(key) ?? { key, copies: [], slips: 0 };
        trail.copies.push({ ...where, noteId: doc.noteId, listItemId: doc.itemIds.get(task.line) ?? null, state: task.state, movedOn });
        if (movedOn && where.kind === "day") trail.slips++;
        result.set(key, trail);
    }
    for (const trail of result.values()) trail.copies.sort(byPeriod);
    return result;
}

/** The trail `item` belongs to; undefined when no copy of it is in the journal. */
export function trailOf(all: Trails, item: TrailItem): Trail | undefined {
    return all.get(trailKey(item.text, item.noteId));
}

/** How many times `item` moved on from a day note; a move off a week or month note isn't one. */
export function slipsOf(all: Trails, item: TrailItem): number {
    return trailOf(all, item)?.slips ?? 0;
}

/** The period of a Journal note's path, such as `Journal/Daily/2026-11-03.md`; null outside the Journal. */
export function periodOf(file: string): { kind: TrailPeriodKind; period: string } | null {
    const found = /^Journal\/(Daily|Weekly|Monthly)\/(\d{4}-(?:\d{2}-\d{2}|W\d{2}|\d{2}))(?:\.md|\/)/.exec(file);
    const kind = { Daily: "day", Weekly: "week", Monthly: "month" }[found?.[1] ?? ""] as TrailPeriodKind | undefined;
    return found && kind ? { kind, period: found[2] ?? "" } : null;
}

/**
 * The key every copy of a task shares: `copyKey` of the note its "from" link names (else `noteId`)
 * and its bare words, so an area marker or clock written into one copy keeps it on the trail.
 */
function trailKey(text: string, noteId: string): string {
    return copyKey(fromOf(text) ?? noteId, bareText(plainText(withoutMoveLinks(text))));
}

/** The first day of a period, as `YYYY-MM-DD`: a week starts on its Monday, a month on the 1st. */
function startOf(copy: TrailCopy): string {
    if (copy.kind === "day") return copy.period;
    if (copy.kind === "month") return `${copy.period}-01`;
    const year = Number(copy.period.slice(0, 4));
    const jan4 = Date.UTC(year, 0, 4);
    const firstMonday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
    return new Date(firstMonday + (Number(copy.period.slice(6)) - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
}

function byPeriod(a: TrailCopy, b: TrailCopy): number {
    return startOf(a).localeCompare(startOf(b)) || Number(b.movedOn) - Number(a.movedOn);
}
