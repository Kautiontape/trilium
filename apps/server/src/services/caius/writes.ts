/**
 * The writes that both the single-purpose tools and the apply tools make. None takes the Caius lock:
 * the caller holds it.
 */

import {
    addContext,
    dismissTasks,
    findPeriodNote,
    FINISHED_LABEL,
    isoWeekKey,
    keysOf,
    label,
    loadJournal,
    nextWorkday,
    type NoteStore,
    PERIODS,
    renderDayTerrain,
    type StoreNote,
    suggestedTasks
} from "@triliumnext/caius";

import { SKIP_CATCHUP_LABEL } from "./brief.js";
import { dateLabel, dayKey, localDay } from "./daily.js";
import type { ContextAddInput, HeaderDay } from "./schemas.js";
import { putAttachment, setLabel } from "./store.js";
import type { DayWeather } from "./weather.js";

export const TERRAIN_TITLE = "terrain.svg";

/**
 * Adds a Context line; one given a date that `weekPlace` sends to a week goes to that week's note.
 * With `tomorrow` (Plan my day), "tomorrow" in a day's line is the next workday: the line goes to
 * that day, with the day's name in place of the word, and starts on it.
 */
export async function contextAddOn(store: NoteStore, { dryRun, ...given }: ContextAddInput, now: Date, opts: { tomorrow?: boolean } = {}) {
    const next = opts.tomorrow && given.date && /\btomorrow\b/i.test(given.text) ? dayKey(nextWorkday(localDay(given.date))) : null;
    const req = next ? { ...given, date: next, text: given.text.replace(/\btomorrow\b/gi, dateLabel(next) ?? next) } : given;
    const place = req.date === undefined ? null : weekPlace(req.text, req.date);
    const until = req.until ?? place?.until;
    const from = place?.from ?? (next && place ? next : undefined);
    const target = place ? { week: place.week, text: req.text, ...(from ? { from } : {}), ...(until ? { until } : {}) } : req;
    return { result: await addContext(store, target, { dryRun, now }), moved: place !== null };
}

/** Writes each line he kept to the week note of `date`, the day planned or wound down to. */
export async function contextKeepOn(store: NoteStore, date: string, lines: { text: string; until?: string }[], opts: { dryRun?: boolean; now: Date }) {
    const week = isoWeekKey(new Date(`${date}T00:00:00Z`));
    const results: (Awaited<ReturnType<typeof addContext>> & { week: string })[] = [];
    for (const line of lines) {
        results.push({ week, ...await addContext(store, { week, ...line }, opts) });
    }
    return results;
}

/** Labels the day note `#caiusSkipCatchup=<date>`, creating the note if missing. */
export async function skipCatchupOn(store: NoteStore, date: string) {
    const existing = await findPeriodNote(store, "day", date);
    const note = existing ?? await store.calendarDay(date);
    if (note.isProtected) {
        return { date, error: "bad_request", detail: `The day note for ${date} is protected` };
    }
    const labelled = note.attributes.some((a) => a.type === "label" && a.name === SKIP_CATCHUP_LABEL && a.value === date);
    if (!labelled) setLabel(note.noteId, SKIP_CATCHUP_LABEL, date);
    return { date, noteId: note.noteId, status: labelled ? "unchanged" : "updated", created: !existing };
}

/**
 * Labels a day or week note `#caiusFinished=<key>` for each key not on it yet, and dismisses the
 * Suggested items naming a key on day notes from `from` on.
 */
export async function finishedOn(store: NoteStore, keys: string[], note: StoreNote, from: string, now: Date) {
    if (label(note, PERIODS.day.label) === undefined && label(note, PERIODS.week.label) === undefined) {
        return { error: "bad_request", detail: `Note '${note.noteId}' is not a day or week note` };
    }
    if (note.isProtected) {
        return { error: "bad_request", detail: `Note '${note.noteId}' is protected` };
    }
    const fresh = [ ...new Set(keys) ].filter((key) => !note.attributes.some((a) => a.type === "label" && a.name === FINISHED_LABEL && a.value === key));
    for (const key of fresh) await store.addLabel(note.noteId, FINISHED_LABEL, key);
    // The Plan tab offers what is in Suggested, so the key's items there go too, from today on.
    const docs = (await store.search("#calendarRoot")).length ? (await loadJournal(store)).docs : [];
    const offered = suggestedTasks(docs, now)
        .filter((task) => PERIODS.day.pattern.test(task.period) && task.period >= from && keysOf(task.text).some((key) => keys.includes(key)))
        .flatMap((task) => task.listItemId ? [ { noteId: task.noteId, listItemId: task.listItemId } ] : []);
    const dismissed = offered.length ? await dismissTasks(store, offered) : [];
    return { noteId: note.noteId, keys, status: fresh.length ? "updated" : "unchanged", dismissed };
}

/** Draws the day on a note as its `terrain.svg` attachment, created or updated. */
export function drawHeader(noteId: string, day: HeaderDay, weather: DayWeather | undefined) {
    const svg = renderDayTerrain({ ...day, ...(weather ? { weather } : {}) });
    return putAttachment(noteId, { role: "image", mime: "image/svg+xml", title: TERRAIN_TITLE, content: svg });
}

const WEEKDAY = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*";
const WEEKDAYS_FROM_MONDAY = [ "mon", "tue", "wed", "thu", "fri", "sat", "sun" ];

/**
 * Where a Context line written for `date` goes when it isn't about that day alone: the week note to
 * write it to, and the day it ends on when the line itself doesn't say. Null keeps it on the day.
 * - A clock time, or today, tonight, this morning, this afternoon or this evening: the day.
 * - Next week: next week's note. A weekday range ("Thu-Fri"): from its first day until its last, in
 *   this week, or next week when its first day is already past.
 * - This week, all week, or until a weekday or a date: this week's, with no end of its own.
 * - A ticket key: this week's, with no end, so "ZAP-2590 is open" doesn't lapse.
 * - A person's or a one-day state (is open, out, off or down; away, on leave, covering, freeze,
 *   on PTO, vacation or holiday): this week's, ending on `date`.
 */
export function weekPlace(text: string, date: string): { week: string; from?: string; until?: string } | null {
    if (/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?[ap]m\b|\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i.test(text)) return null;
    const at = new Date(`${date}T00:00:00Z`);
    const week = isoWeekKey(at);
    if (/\bnext week\b/i.test(text)) return { week: isoWeekKey(new Date(at.getTime() + 7 * 86_400_000)) };
    const range = new RegExp(`\\b(${WEEKDAY})\\s*(?:-|–|to)\\s*(${WEEKDAY})\\b`, "i").exec(text);
    if (range?.[1] && range[2]) {
        // Looking forward: a range already past in this week is next week's.
        let from = weekdayOf(date, range[1]);
        if (from < date) from = new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
        return { week: isoWeekKey(new Date(`${from}T00:00:00Z`)), from, until: weekdayOf(from, range[2]) };
    }
    const untilWhen = new RegExp(`\\buntil\\s+(?:${WEEKDAY}\\b|\\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d)`, "i");
    if (/\b(?:this week|all week)\b/i.test(text) || untilWhen.test(text)) return { week };
    if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(text)) return { week };
    const state = /\b(?:is|are)\s+(?:open|out|off|down|away)\b|['’]s\s+(?:out|off|down|away)\b|\b(?:away|on leave|covering|freeze|on PTO|on vacation|on holiday)\b/i;
    return state.test(text) ? { week, until: date } : null;
}

/** The date of `weekday` ("Fri", "friday") in the ISO week of `date`. */
function weekdayOf(date: string, weekday: string): string {
    const at = new Date(`${date}T00:00:00Z`);
    const monday = at.getTime() - ((at.getUTCDay() + 6) % 7) * 86_400_000;
    const index = WEEKDAYS_FROM_MONDAY.indexOf(weekday.slice(0, 3).toLowerCase());
    return new Date(monday + Math.max(0, index) * 86_400_000).toISOString().slice(0, 10);
}
