import { nextWorkday } from "@triliumnext/caius/src/workday.js";

/**
 * Dates as keys (`YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`) and the labels the app shows for them. Which
 * day is today is always the server's (`caius_plan`'s key); these only step and name keys, in the
 * shape of Caius's own `…Label` strings ("Wed 4 Nov").
 */

const WEEKDAYS = [ "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" ];
const MONTHS = [ "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" ];

/** A day key as a local date at midnight. */
export function dateOf(key: string) {
    return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}

export function keyOf(date: Date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(key: string, days: number) {
    const date = dateOf(key);
    date.setDate(date.getDate() + days);
    return keyOf(date);
}

export function nextWorkdayKey(key: string) {
    return keyOf(nextWorkday(dateOf(key)));
}

/** `Wed 4 Nov`. */
export function dayLabel(key: string) {
    const date = dateOf(key);
    return `${WEEKDAYS[date.getDay()].slice(0, 3)} ${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;
}

/** `Wednesday`. */
export function weekdayName(key: string) {
    return WEEKDAYS[dateOf(key).getDay()];
}

/** `YYYY-Www` of a day key: the year and number of its week's Thursday. */
export function weekOf(key: string) {
    const date = dateOf(key);
    const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 3 - ((date.getDay() + 6) % 7));
    const jan1 = new Date(thursday.getFullYear(), 0, 1);
    const week = Math.floor((Math.round((thursday.getTime() - jan1.getTime()) / 86_400_000)) / 7) + 1;
    return `${thursday.getFullYear()}-W${pad(week)}`;
}

/** The Monday of an ISO week key, as a day key. */
export function mondayOf(week: string) {
    const year = Number(week.slice(0, 4));
    const jan4 = new Date(year, 0, 4);
    const monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + (Number(week.slice(6)) - 1) * 7);
    return keyOf(monday);
}

export function addWeeks(week: string, weeks: number) {
    return weekOf(addDays(mondayOf(week), weeks * 7));
}

export function addMonths(month: string, months: number) {
    const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + months, 1);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** `Week 45 · 2 – 8 Nov`. */
export function weekLabel(week: string) {
    const monday = mondayOf(week);
    const sunday = addDays(monday, 6);
    const [ m, s ] = [ dateOf(monday), dateOf(sunday) ];
    const range = m.getMonth() === s.getMonth()
        ? `${m.getDate()} – ${s.getDate()} ${MONTHS[s.getMonth()].slice(0, 3)}`
        : `${m.getDate()} ${MONTHS[m.getMonth()].slice(0, 3)} – ${s.getDate()} ${MONTHS[s.getMonth()].slice(0, 3)}`;
    return `Week ${Number(week.slice(6))} · ${range}`;
}

/** `November 2026`. */
export function monthLabel(month: string) {
    return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** Any period key's label: a day, a week or a month. */
export function periodLabel(key: string) {
    if (/^\d{4}-W\d{2}$/.test(key)) {
        return weekLabel(key).split(" · ")[0];
    }
    if (/^\d{4}-\d{2}$/.test(key)) {
        return monthLabel(key);
    }
    return dayLabel(key);
}

/** `HH:MM` to minutes after midnight, or null. */
export function clockMinutes(clock: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function hhmm(minutes: number) {
    return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

/** A Meetings bullet, `09:30 Standup` or `09:30–10:00 Standup`, as times and a title; 30 minutes when no end is given. */
export function parseMeeting(line: string): { start: string; end: string; title: string } | null {
    const match = /^(\d{1,2}:\d{2})(?:\s*[–-]\s*(\d{1,2}:\d{2}))?\s+(.*)$/.exec(line.trim());
    if (!match) {
        return null;
    }
    const start = clockMinutes(match[1]);
    if (start === null) {
        return null;
    }
    const end = match[2] ? clockMinutes(match[2]) : null;
    return { start: hhmm(start), end: hhmm(end !== null && end > start ? end : start + 30), title: match[3] };
}

/** `1h 30m`, `45m`, as the design writes durations in prose. */
export function duration(minutes: number) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h && m ? `${h} h ${m} m` : h ? `${h} h` : `${m} m`;
}

function pad(n: number) {
    return String(n).padStart(2, "0");
}
