/**
 * The calendar half of `caius_inputs`: the events of one day from secret iCal feeds, including
 * recurring events (RRULE, EXDATE) and moved instances (RECURRENCE-ID). Times are the server's
 * local time. A feed's URL is a secret, so errors and results name a feed by its index only.
 */

import type ICALType from "ical.js";

import type { CalendarEvent, InputError } from "./types.js";

export const FEED_TIMEOUT_MS = 10_000;

export interface CalendarDeps {
    fetch: typeof fetch;
    env: Record<string, string | undefined>;
}

type Ical = typeof ICALType;
type IcalComponent = InstanceType<Ical["Component"]>;
type IcalEvent = InstanceType<Ical["Event"]>;
type IcalTime = InstanceType<Ical["Time"]>;

interface Occurrence {
    start: Date;
    end: Date;
    allDay: boolean;
    title: string;
    attendees: string[];
    declined: boolean;
    /** The event names a TZID the feed has no VTIMEZONE for. */
    unknownZone: boolean;
}

export async function readCalendar(deps: CalendarDeps, date: string): Promise<{ events: CalendarEvent[]; errors: InputError[] }> {
    const urls = (deps.env.CAIUS_ICAL_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
    if (urls.length === 0) return { events: [], errors: [ { source: "calendar", error: "not_configured" } ] };

    const mod = await import("ical.js");
    const ICAL: Ical = (mod as { default?: Ical }).default ?? (mod as unknown as Ical);
    const me = userAddresses(deps.env);
    const [ year, month, day ] = date.split("-").map(Number);
    const dayStart = new Date(year, month - 1, day);
    const dayEnd = new Date(year, month - 1, day + 1);

    const errors: InputError[] = [];
    const events: CalendarEvent[] = [];
    for (const [ index, url ] of urls.entries()) {
        let text: string;
        try {
            text = await fetchFeed(deps.fetch, url);
        } catch (e) {
            errors.push({ source: "calendar", error: `feed_${index}_${e instanceof Error ? e.message : "network"}` });
            continue;
        }
        try {
            const occurrences = occurrencesOn(ICAL, text, dayStart, dayEnd, me);
            for (const occurrence of occurrences) events.push(toEvent(occurrence, dayStart, dayEnd, index));
            if (occurrences.some((occurrence) => occurrence.unknownZone)) {
                errors.push({ source: "calendar", error: `feed_${index}_unknown_tz` });
            }
        } catch {
            errors.push({ source: "calendar", error: `feed_${index}_parse` });
        }
    }

    return { events: flagOverlaps(mergeDuplicates(events)), errors };
}

/** The user's addresses, for finding their own PARTSTAT: `JIRA_EMAIL` and the comma-separated `CAIUS_USER_EMAILS`. */
function userAddresses(env: CalendarDeps["env"]): Set<string> {
    const addresses = [ env.JIRA_EMAIL ?? "", ...(env.CAIUS_USER_EMAILS ?? "").split(",") ];
    return new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
}

async function fetchFeed(doFetch: typeof fetch, url: string): Promise<string> {
    let response: Response;
    try {
        response = await doFetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    } catch (e) {
        throw new Error(isTimeout(e) ? "timeout" : "network");
    }
    if (!response.ok) throw new Error(`http_${response.status}`);
    try {
        return await response.text();
    } catch (e) {
        throw new Error(isTimeout(e) ? "timeout" : "network");
    }
}

function isTimeout(e: unknown): boolean {
    return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/** Every occurrence of every event in the feed that overlaps the day. */
function occurrencesOn(ICAL: Ical, text: string, dayStart: Date, dayEnd: Date, me: Set<string>): Occurrence[] {
    const root = new ICAL.Component(ICAL.parse(text));
    const defined = new Set<string>();
    for (const zone of root.getAllSubcomponents("vtimezone")) {
        ICAL.TimezoneService.register(zone);
        defined.add(String(zone.getFirstPropertyValue("tzid")));
    }

    const masters = new Map<string, IcalComponent[]>();
    const overrides = new Map<string, IcalComponent[]>();
    const cancelled = new Map<string, Array<number | undefined>>();
    for (const vevent of root.getAllSubcomponents("vevent")) {
        const uid = String(vevent.getFirstPropertyValue("uid"));
        const isOverride = vevent.hasProperty("recurrence-id");
        if (vevent.getFirstPropertyValue("status") === "CANCELLED") {
            // A cancelled instance is not an event, but its slot stays out of the master's expansion.
            if (isOverride) cancelled.set(uid, [ ...(cancelled.get(uid) ?? []), new ICAL.Event(vevent).recurrenceId?.toUnixTime() ]);
            continue;
        }
        const bucket = isOverride ? overrides : masters;
        bucket.set(uid, [ ...(bucket.get(uid) ?? []), vevent ]);
    }

    const found: Occurrence[] = [];
    const add = (event: IcalEvent, start: IcalTime, end: IcalTime) => {
        const occurrence = describe(event, start, end, me, usesUnknownZone(event.component, defined));
        if (occurrence.end > dayStart && occurrence.start < dayEnd) found.push(occurrence);
    };

    for (const [ uid, vevents ] of masters) {
        // A moved instance carries the master's UID and a RECURRENCE-ID: the master skips the
        // original slot and the override stands as an event of its own.
        const moved = new Set([
            ...(overrides.get(uid) ?? []).map((v) => new ICAL.Event(v).recurrenceId?.toUnixTime()),
            ...(cancelled.get(uid) ?? [])
        ]);
        for (const vevent of vevents) {
            const event = new ICAL.Event(vevent);
            if (!event.isRecurring()) {
                add(event, event.startDate, event.endDate);
                continue;
            }
            const expansion = event.iterator();
            for (let next = expansion.next(); next; next = expansion.next()) {
                if (next.toJSDate() >= dayEnd) break;
                if (moved.has(next.toUnixTime())) continue;
                const details = event.getOccurrenceDetails(next);
                add(event, details.startDate, details.endDate);
            }
        }
    }
    for (const vevents of overrides.values()) {
        for (const vevent of vevents) {
            const event = new ICAL.Event(vevent);
            add(event, event.startDate, event.endDate);
        }
    }
    return found;
}

function describe(event: IcalEvent, start: IcalTime, end: IcalTime, me: Set<string>, unknownZone: boolean): Occurrence {
    const attendees = event.attendees.map((attendee) => {
        const address = String(attendee.getFirstValue() ?? "").replace(/^mailto:/i, "");
        const name = parameter(attendee, "cn");
        return { address: address.toLowerCase(), name: name || address.split("@")[0], partstat: parameter(attendee, "partstat") };
    });
    const mine = attendees.find((attendee) => me.has(attendee.address));
    return {
        start: start.toJSDate(),
        end: end.toJSDate(),
        allDay: start.isDate,
        title: event.summary || "(no title)",
        attendees: attendees.map((attendee) => attendee.name).filter(Boolean),
        declined: mine?.partstat.toUpperCase() === "DECLINED",
        unknownZone
    };
}

/** Whether the event's start or end names a TZID that is neither UTC nor a VTIMEZONE of its feed. */
function usesUnknownZone(vevent: IcalComponent, defined: Set<string>): boolean {
    return [ "dtstart", "dtend" ].some((name) => {
        const zone = vevent.getFirstProperty(name)?.getParameter("tzid");
        return typeof zone === "string" && zone !== "UTC" && !defined.has(zone);
    });
}

function parameter(property: InstanceType<Ical["Property"]>, name: string): string {
    const value = property.getParameter(name);
    return (Array.isArray(value) ? value[0] : value) ?? "";
}

function toEvent(occurrence: Occurrence, dayStart: Date, dayEnd: Date, source: number): CalendarEvent {
    return {
        start: occurrence.allDay ? "00:00" : clock(occurrence.start, dayStart, dayEnd),
        end: occurrence.allDay ? "24:00" : clock(occurrence.end, dayStart, dayEnd),
        title: occurrence.title,
        attendees: occurrence.attendees,
        allDay: occurrence.allDay,
        declined: occurrence.declined,
        source: [ source ]
    };
}

/** `HH:MM` local time, held to the day: earlier reads `00:00`, later `24:00`. */
function clock(at: Date, dayStart: Date, dayEnd: Date): string {
    if (at <= dayStart) return "00:00";
    if (at >= dayEnd) return "24:00";
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** One event per title and start, with the feeds that carry it merged. Declined if any copy says so, since a copy without the user's RSVP is not an acceptance. */
function mergeDuplicates(events: CalendarEvent[]): CalendarEvent[] {
    const merged = new Map<string, CalendarEvent>();
    for (const event of events) {
        const key = `${event.start}|${event.title.trim().toLowerCase()}`;
        const kept = merged.get(key);
        if (!kept) {
            merged.set(key, { ...event, attendees: [ ...event.attendees ], source: [ ...event.source ] });
            continue;
        }
        kept.source = [ ...new Set([ ...kept.source, ...event.source ]) ].sort((a, b) => a - b);
        kept.attendees = [ ...new Set([ ...kept.attendees, ...event.attendees ]) ];
        kept.declined = kept.declined || event.declined;
        kept.allDay = kept.allDay || event.allDay;
        if (event.end > kept.end) kept.end = event.end;
    }
    return [ ...merged.values() ].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/** Marks every pair of non-declined timed events that overlap; back-to-back events don't. */
function flagOverlaps(events: CalendarEvent[]): CalendarEvent[] {
    const timed = events.filter((event) => !event.allDay && !event.declined);
    for (const [ i, a ] of timed.entries()) {
        for (const b of timed.slice(i + 1)) {
            if (a.start < b.end && b.start < a.end) {
                a.overlap = true;
                b.overlap = true;
            }
        }
    }
    return events;
}
