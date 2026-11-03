import "./ticket_card.css";

import type { ViewTicket } from "@triliumnext/caius/src/daily/views.js";

import { dayLabel } from "../lib/day.js";
import { Card } from "./ui.js";

/**
 * A Jira ticket as Item shows it: its key, status and how long it has been in it, its summary and
 * assignee, then the comment that asks something, else the last one. A ticket Jira couldn't be
 * read for shows its key and the error.
 */
export function TicketCard({ ticket }: { ticket: ViewTicket | { key: string; error: string } }) {
    if ("error" in ticket) {
        return (
            <Card class="ticket-card">
                <div class="ticket-head"><span class="ticket-key mono">{ticket.key}</span></div>
                <p class="ticket-error ink-2">Couldn't read it from Jira: {ticket.error}</p>
            </Card>
        );
    }
    const comment = ticket.ask ?? ticket.lastComment;
    return (
        <Card class="ticket-card">
            <div class="ticket-head">
                <span class="ticket-key mono">{ticket.key}</span>
                <span class={`ticket-status${ticket.done ? " done" : ""}`}>{ticket.status}</span>
                {ticket.daysInStatus !== null && <span class="ticket-age ink-2">{daysWords(ticket.daysInStatus)}</span>}
            </div>
            <p class="ticket-summary">{ticket.summary}</p>
            <p class="ticket-assignee ink-2">{ticket.assignee ?? "Unassigned"}</p>
            {comment && (
                <blockquote class={`ticket-comment${ticket.ask ? " ask" : ""}`}>
                    <span class="ticket-comment-by ink-2">{ticket.ask ? "Asks" : "Last comment"} · {comment.author} · {dayLabel(comment.created.slice(0, 10))}</span>
                    {comment.excerpt}
                </blockquote>
            )}
        </Card>
    );
}

/** `today`, `1 day`, `12 days`: how long the ticket has been in its status. */
function daysWords(days: number) {
    return days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}
