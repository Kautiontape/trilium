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
    suggestedTasks,
    workdayKey
} from "@triliumnext/caius";

import { SKIP_CATCHUP_LABEL, STARTED_LABEL } from "./brief.js";
import { dateLabel, dayKey, localDay } from "./daily.js";
import { overriddenKeys } from "./inputs/jira.js";
import type { ContextAddInput, HeaderDay } from "./schemas.js";
import { putAttachment, removeLabel, setLabel } from "./store.js";
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
 * Starts the calendar date of `at` early: labels its day note `#caiusStarted=<at>`, so the rollover
 * is 00:00 that night. `rollover` is the standing note's own, in minutes. Outside midnight to the
 * rollover it writes nothing. With `back`, removes the label, so the day before is today again.
 */
export async function startDayOn(store: NoteStore, at: Date, rollover: number, back = false) {
    const date = localIso(at).slice(0, 10);
    if (back) {
        const note = await findPeriodNote(store, "day", date);
        const values = (note?.attributes ?? []).filter((a) => a.type === "label" && a.name === STARTED_LABEL).map((a) => a.value);
        if (note) for (const value of values) removeLabel(note.noteId, STARTED_LABEL, value);
        return { status: values.length ? "updated" : "unchanged", ...dayOf(workdayKey(at, rollover)) };
    }
    if (at.getHours() * 60 + at.getMinutes() >= rollover) {
        const today = dayOf(workdayKey(at, rollover));
        const until = clockText(rollover);
        return { status: "skipped", reason: "not_small_hours", ...today, detail: `A day starts early only between 00:00 and ${until}; ${today.dateLabel} is today.` };
    }
    const existing = await findPeriodNote(store, "day", date);
    const note = existing ?? await store.calendarDay(date);
    if (note.isProtected) {
        return { date, error: "bad_request", detail: `The day note for ${date} is protected` };
    }
    const started = note.attributes.some((a) => a.type === "label" && a.name === STARTED_LABEL);
    if (!started) setLabel(note.noteId, STARTED_LABEL, localIso(at));
    return { status: started ? "unchanged" : "updated", ...dayOf(date), noteId: note.noteId, created: !existing };
}

function dayOf(date: string) {
    return { date, dateLabel: dateLabel(date) ?? date };
}

/** A moment as local `YYYY-MM-DDTHH:mm:ss`. */
export function localIso(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Minutes after midnight as `HH:MM`. */
export function clockText(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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
// A full name in any case, or an abbreviation with a capital first letter, so "mon" in an ordinary
// word isn't a day. Saturday and Sunday have no abbreviation: "Sat" and "Sun" are common words. A
// trailing "s" makes a plural, except in "Weds", which is Wednesday.
const DAY_NAME = new RegExp(
    "\\b(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    + "(?:Mon|Tues|Tue|Weds|Wed|Thurs|Thur|Thu|Fri))(s?)\\b", "gi"
);
const FULL_DAY_NAME = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
const DAY_ABBREVIATION = /^(?:Mon|Tues?|Weds?|Thu(?:rs?)?|Fri)$/;
const AFTER_NAME_DATE = /^,?\s+(?:\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/i;
const BEFORE_NAME_WORD = /\b(?:until|till|through|thru|since|from|by|before|after|last|every|back|returns?|returning)\s+(?:(?:next|this|on)\s+)?$/i;
const WEEKDAYS_FROM_MONDAY = [ "mon", "tue", "wed", "thu", "fri", "sat", "sun" ];

/**
 * Where a Context line written for `date` goes when it isn't about that day alone: the week note to
 * write it to, and the day it ends on when the line itself doesn't say. Null keeps it on the day.
 * - A clock time, or today, tonight, this morning, this afternoon or this evening: the day.
 * - Next week: next week's note. A weekday range ("Thu-Fri"): from its first day until its last, in
 *   this week, or next week when its last day is already past.
 * - This week, all week, or until a weekday or a date: this week's, with no end of its own.
 * - One weekday name ("Tuesday", "Tue", "next Tuesday"): that day alone, in this week, or next week
 *   when the day is before `date` or the line says next. A plural, a weekday with a date after it
 *   ("Tue 24 Nov", "Tue Nov 24"), one after until, since, from, back, returns or the like (with next,
 *   this or on between), two or more weekdays that aren't a range, and a line that keeps a ticket
 *   open (so Jira's Done stays overridden) don't count.
 * - A ticket key: this week's, with no end, so "ABC-12 is open" doesn't lapse.
 * - A person's or a one-day state (is open, out, off or down; away, on leave, covering, freeze,
 *   on PTO, vacation or holiday): this week's, ending on `date`.
 */
export function weekPlace(text: string, date: string): { week: string; from?: string; until?: string } | null {
    if (/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?[ap]m\b|\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i.test(text)) return null;
    const at = new Date(`${date}T00:00:00Z`);
    const week = isoWeekKey(at);
    if (/\bnext week\b/i.test(text)) return { week: isoWeekKey(new Date(`${weekLater(date)}T00:00:00Z`)) };
    const range = new RegExp(`\\b(${WEEKDAY})\\s*(?:-|–|to)\\s*(${WEEKDAY})\\b`, "i").exec(text);
    if (range?.[1] && range[2]) {
        // Looking forward: a range whose last day is already past in this week is next week's.
        const until = weekdayOf(date, range[2]);
        const from = weekdayOf(date, range[1]);
        return until < date
            ? { week: isoWeekKey(new Date(`${weekLater(from)}T00:00:00Z`)), from: weekLater(from), until: weekLater(until) }
            : { week, from, until };
    }
    const untilWhen = new RegExp(`\\buntil\\s+(?:${WEEKDAY}\\b|\\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d)`, "i");
    if (/\b(?:this week|all week)\b/i.test(text) || untilWhen.test(text)) return { week };
    const single = singleWeekday(text);
    if (single && overriddenKeys([ text ]).size === 0) {
        const day = weekdayOf(date, single.name);
        const on = single.next || day < date ? weekLater(day) : day;
        return { week: isoWeekKey(new Date(`${on}T00:00:00Z`)), from: on, until: on };
    }
    if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(text)) return { week };
    const state = /\b(?:is|are)\s+(?:open|out|off|down|away)\b|['’]s\s+(?:out|off|down|away)\b|\b(?:away|on leave|covering|freeze|on PTO|on vacation|on holiday)\b/i;
    return state.test(text) ? { week, until: date } : null;
}

/** The date a week after `day`. */
function weekLater(day: string): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
}

/** The one weekday `text` names as a day to place a line on, and whether it follows "next"; else null. */
function singleWeekday(text: string): { name: string; next: boolean } | null {
    const nameOf = (m: RegExpMatchArray) => m[0].slice(0, m[0].length - (m[1] ?? "").length);
    const found = [ ...text.matchAll(DAY_NAME) ].filter((m) => FULL_DAY_NAME.test(nameOf(m)) || DAY_ABBREVIATION.test(nameOf(m)));
    const [ only ] = found;
    if (found.length !== 1 || !only || only[1] !== "") return null;
    const name = nameOf(only);
    const index = only.index ?? 0;
    if (AFTER_NAME_DATE.test(text.slice(index + name.length))) return null;
    const before = text.slice(0, index);
    if (BEFORE_NAME_WORD.test(before)) return null;
    return { name, next: /\bnext\s+$/i.test(before) };
}

/** The date of `weekday` ("Fri", "friday") in the ISO week of `date`. */
function weekdayOf(date: string, weekday: string): string {
    const at = new Date(`${date}T00:00:00Z`);
    const monday = at.getTime() - ((at.getUTCDay() + 6) % 7) * 86_400_000;
    const index = WEEKDAYS_FROM_MONDAY.indexOf(weekday.slice(0, 3).toLowerCase());
    return new Date(monday + Math.max(0, index) * 86_400_000).toISOString().slice(0, 10);
}
