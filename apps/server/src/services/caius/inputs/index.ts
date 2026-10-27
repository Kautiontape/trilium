/**
 * `caius_inputs`: what the day's planning needs from outside the notes. Jira and the calendar
 * are read independently, so a source that fails adds an entry to `errors` and the others still
 * return. It reads no notes and takes no `withCaiusLock`, since holding the lock across network
 * calls would stall the Plan tab.
 */

import { dayCapacity } from "@triliumnext/caius";

import type { InputsInput } from "../schemas.js";
import { readCalendar } from "./calendar.js";
import { JiraError, type JiraDeps, readJira } from "./jira.js";
import type { CaiusInputs, CalendarEvent, InputError, JiraInputs } from "./types.js";

export type { CaiusInputs } from "./types.js";

export type InputsDeps = JiraDeps;

/**
 * Whether an `errors` entry is a warning, after which the source still answered: a cap that bit
 * (`*_truncated`), some tickets unread (`*_partial`), a search Jira only answered without one of its
 * clauses (`*_narrowed`) or an unknown time zone read as local time.
 */
export function isInputWarning(error: string): boolean {
    return /_(?:truncated|partial|narrowed|unknown_tz)$/.test(error);
}

export async function readInputs(input: InputsInput, deps: InputsDeps = defaultDeps()): Promise<CaiusInputs> {
    const errors: InputError[] = [];
    const [ jiraRead, calendarRead ] = await Promise.allSettled([
        readJira(deps, input.context),
        readCalendar(deps, input.date)
    ]);

    let jira: JiraInputs = { handoff: [], asks: [], done: [] };
    if (jiraRead.status === "fulfilled") {
        jira = jiraRead.value.inputs;
        for (const warning of jiraRead.value.warnings) errors.push({ source: "jira", error: warning });
    } else {
        const reason = jiraRead.reason;
        errors.push({ source: "jira", error: reason instanceof JiraError ? reason.code : "unexpected" });
    }

    let calendar: CalendarEvent[] = [];
    if (calendarRead.status === "fulfilled") {
        calendar = calendarRead.value.events;
        errors.push(...calendarRead.value.errors);
    } else {
        errors.push({ source: "calendar", error: "unexpected" });
    }

    return {
        date: input.date,
        jira,
        calendar,
        capacity: dayCapacity(calendar, { workStart: input.workStart, workEnd: input.workEnd }),
        errors
    };
}

function defaultDeps(): InputsDeps {
    return { fetch: globalThis.fetch, env: process.env, now: () => new Date() };
}
