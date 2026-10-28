/** The shapes `caius_inputs` returns. */

import type { DayCapacity } from "@triliumnext/caius";

export interface InputError {
    source: "jira" | "calendar";
    error: string;
}

export interface JiraTicket {
    key: string;
    summary: string;
    status: string;
    resolution: string | null;
    url: string;
    assignee: string | null;
    updated: string;
    /** True when a Context line says the ticket is open, whatever Jira says. */
    overridden?: true;
}

export interface HandoffTicket extends JiraTicket {
    daysInStatus: number | null;
}

export interface JiraAsk {
    ticket: JiraTicket;
    author: string;
    created: string;
    /** The Jira comment's id, which `#caiusRaised` records once a brief has raised it. */
    commentId: string;
    excerpt: string;
}

export interface JiraInputs {
    handoff: HandoffTicket[];
    asks: JiraAsk[];
    done: string[];
}

export interface CalendarEvent {
    start: string;
    end: string;
    title: string;
    attendees: string[];
    allDay: boolean;
    declined: boolean;
    /** The indexes of the feeds that carry the event, in `CAIUS_ICAL_URLS` order. */
    source: number[];
    overlap?: true;
}

export interface CaiusInputs {
    date: string;
    jira: JiraInputs;
    calendar: CalendarEvent[];
    capacity: DayCapacity;
    errors: InputError[];
}
