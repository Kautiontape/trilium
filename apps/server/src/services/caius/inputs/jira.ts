/**
 * The Jira half of `caius_inputs`: the user's hand-off tickets, the comments that ask something
 * of them, and which of those tickets Jira calls done. It talks to Jira Cloud's REST v3 with
 * basic auth and takes `fetch`, the environment and the clock as arguments, so a spec runs it on
 * recorded responses. It imports nothing from Trilium.
 */

import type { HandoffTicket, JiraAsk, JiraInputs, JiraTicket } from "./types.js";

/** Statuses that mean a ticket is waiting on its assignee. Compared case-insensitively and in full. */
export const HANDOFF_STATUSES = [ "Code Review", "Dev Verify", "Ready For QA", "QA Testing", "Pending Feedback" ];

export const JIRA_TIMEOUT_MS = 10_000;
const ASK_WINDOW_DAYS = 7;
const EXCERPT_LENGTH = 200;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const MAX_ASK_TICKETS = 80;
const CONCURRENCY = 4;
const RETRY_STATUSES = [ 429, 502, 503, 504 ];
const MAX_RETRY_WAIT_MS = 5000;
const DAY_MS = 86_400_000;
const TICKET_FIELDS = "summary,status,resolution,assignee,updated,statuscategorychangedate";

export interface JiraDeps {
    fetch: typeof fetch;
    env: Record<string, string | undefined>;
    now: () => Date;
    /** Waits before a retry; defaults to a timer. */
    sleep?: (ms: number) => Promise<void>;
}

/** A failure with a stable code, such as `http_401`, `timeout` or `not_configured`. It never carries a URL or a header. */
export class JiraError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

interface Config {
    baseUrl: string;
    authorization: string;
}

interface RawIssue {
    key: string;
    fields: {
        summary?: string;
        status?: { name?: string; statusCategory?: { key?: string } };
        resolution?: { name?: string } | null;
        assignee?: { displayName?: string } | null;
        updated?: string;
        statuscategorychangedate?: string;
    };
}

interface RawComment {
    created: string;
    author?: { accountId?: string; displayName?: string };
    body?: unknown;
}

interface SearchPage {
    issues?: RawIssue[];
    nextPageToken?: string;
    isLast?: boolean;
}

/** What `readJira` found, and the non-fatal problems (`asks_truncated`, `asks_partial`, …) met on the way. */
export interface JiraRead {
    inputs: JiraInputs;
    warnings: string[];
}

export async function readJira(deps: JiraDeps, context: string[] = []): Promise<JiraRead> {
    const config = readConfig(deps.env);
    const api = jiraApi(config, deps.fetch, deps.sleep ?? sleep);
    const now = deps.now();
    const warnings = new Set<string>();

    // The identity and the two searches are fatal; everything per ticket is not.
    const me = await api.get<{ accountId: string }>("/rest/api/3/myself");
    const assigned = await search(api, "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
    const since = new Date(now.getTime() - ASK_WINDOW_DAYS * DAY_MS);
    // `-8d` on Jira's clock always covers the 7 days measured on ours; `asksIn` applies the exact cutoff.
    const involved = await search(
        api,
        "(assignee = currentUser() OR watcher = currentUser() OR comment ~ currentUser()) AND updated >= -8d ORDER BY updated DESC"
    );
    if (assigned.truncated || involved.truncated) warnings.add("search_truncated");

    const handoffIssues = assigned.issues.filter(isHandoff);
    const handoff = await mapPool(handoffIssues, async (issue): Promise<HandoffTicket> => {
        try {
            return { ...toTicket(config, issue), daysInStatus: await daysInStatus(api, issue, now) };
        } catch {
            warnings.add("handoff_partial");
            return { ...toTicket(config, issue), daysInStatus: null };
        }
    });

    if (involved.issues.length > MAX_ASK_TICKETS) warnings.add("asks_truncated");
    const scanned = involved.issues.slice(0, MAX_ASK_TICKETS);
    const found = await mapPool(scanned, async (issue): Promise<JiraAsk[]> => {
        try {
            return asksIn(toTicket(config, issue), await allComments(api, issue.key), me.accountId, since);
        } catch {
            warnings.add("asks_partial");
            return [];
        }
    });
    const asks = found.flat();

    // Done is judged only for tickets the result offers: the hand-offs and those with an ask.
    const finished = new Set<string>();
    const offered = new Set([ ...handoffIssues.map((i) => i.key), ...asks.map((a) => a.ticket.key) ]);
    for (const issue of [ ...assigned.issues, ...scanned ]) {
        if (offered.has(issue.key) && isDone(issue)) finished.add(issue.key);
    }

    const overridden = overriddenKeys(context);
    const mark = <T extends JiraTicket>(ticket: T): T => overridden.has(ticket.key) ? { ...ticket, overridden: true } : ticket;
    return {
        inputs: {
            handoff: handoff.map(mark),
            asks: asks.map((ask) => ({ ...ask, ticket: mark(ask.ticket) })),
            done: [ ...finished ].filter((key) => !overridden.has(key))
        },
        warnings: [ ...warnings ]
    };
}

/** Maps `items` with at most `CONCURRENCY` calls in flight, keeping their order. */
async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return results;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The keys that a Context line calls open, such as "ZAP-2590 is open; Jira's Done is a mistake". */
export function overriddenKeys(context: string[]): Set<string> {
    const keys = new Set<string>();
    for (const line of context) {
        if (!saysOpen(line)) continue;
        for (const [ key ] of line.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/gi)) keys.add(key.toUpperCase());
    }
    return keys;
}

/** Whether the line has the word "open" that is not negated ("not open", "isn't open", "no longer open"). */
function saysOpen(line: string): boolean {
    for (const match of line.matchAll(/\bopen\b/gi)) {
        if (!/(?:\bnot|\bno longer|n['’]t)\s+$/i.test(line.slice(0, match.index))) return true;
    }
    return false;
}

/** Whether a status is one of `HANDOFF_STATUSES`, ignoring case. */
export function isHandoffStatus(status: string): boolean {
    const wanted = status.trim().toLowerCase();
    return HANDOFF_STATUSES.some((name) => name.toLowerCase() === wanted);
}

/** The comments among `comments` that ask the user something, newest information first as Jira returns it. */
export function asksIn(ticket: JiraTicket, comments: RawComment[], myAccountId: string, since: Date): JiraAsk[] {
    let lastOwn = Number.NEGATIVE_INFINITY;
    for (const comment of comments) {
        if (comment.author?.accountId === myAccountId) lastOwn = Math.max(lastOwn, timeOf(comment.created));
    }

    const asks: JiraAsk[] = [];
    for (const comment of comments) {
        const created = timeOf(comment.created);
        if (comment.author?.accountId === myAccountId) continue;
        if (created < since.getTime() || created <= lastOwn) continue;
        const text = adfToText(comment.body);
        if (!mentions(comment.body, myAccountId) && !/\?[\s"')\]]*$/.test(text)) continue;
        asks.push({
            ticket,
            author: comment.author?.displayName ?? "unknown",
            created: new Date(created).toISOString(),
            excerpt: excerpt(text)
        });
    }
    return asks;
}

/** Flattens an Atlassian Document Format body to one line of plain text. */
export function adfToText(node: unknown): string {
    return flatten(node).replace(/\s+/g, " ").trim();
}

function flatten(node: unknown): string {
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object") return "";
    const { type, text, attrs, content } = node as { type?: string; text?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (type === "text") return text ?? "";
    if (type === "mention" || type === "emoji") return String(attrs?.text ?? "");
    if (type === "inlineCard") return String(attrs?.url ?? "");
    if (type === "hardBreak") return " ";
    const inner = (content ?? []).map(flatten).join(type === "doc" || !isInline(content) ? " " : "");
    return ` ${inner} `;
}

function isInline(content: unknown[] | undefined): boolean {
    return (content ?? []).every((child) => {
        const type = (child as { type?: string }).type;
        return type === "text" || type === "mention" || type === "emoji" || type === "inlineCard" || type === "hardBreak";
    });
}

function mentions(node: unknown, accountId: string): boolean {
    if (!node || typeof node !== "object") return false;
    const { type, attrs, content } = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
    if (type === "mention" && attrs?.id === accountId) return true;
    return (content ?? []).some((child) => mentions(child, accountId));
}

function excerpt(text: string): string {
    return text.length <= EXCERPT_LENGTH ? text : `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function readConfig(env: JiraDeps["env"]): Config {
    const { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_TOKEN: token } = env;
    if (!baseUrl || !email || !token) throw new JiraError("not_configured");
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
    };
}

function jiraApi(config: Config, doFetch: typeof fetch, wait: (ms: number) => Promise<void>) {
    const request = async (url: URL): Promise<Response> => {
        try {
            return await doFetch(url, {
                headers: { Authorization: config.authorization, Accept: "application/json" },
                signal: AbortSignal.timeout(JIRA_TIMEOUT_MS)
            });
        } catch (e) {
            throw new JiraError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
        }
    };

    return {
        async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
            const url = new URL(config.baseUrl + path);
            for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
            let response = await request(url);
            if (RETRY_STATUSES.includes(response.status)) {
                await response.body?.cancel();
                const seconds = Number(response.headers.get("Retry-After"));
                await wait(Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000));
                response = await request(url);
            }
            if (!response.ok) throw new JiraError(`http_${response.status}`);
            try {
                return await response.json() as T;
            } catch {
                throw new JiraError("bad_response");
            }
        }
    };
}

type Api = ReturnType<typeof jiraApi>;

/** Every issue the JQL matches, following `nextPageToken` (`/search/jql` replaced the `startAt` search). `truncated` is set when `MAX_PAGES` ended it early. */
async function search(api: Api, jql: string): Promise<{ issues: RawIssue[]; truncated: boolean }> {
    const issues: RawIssue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const params: Record<string, string | number> = { jql, fields: TICKET_FIELDS, maxResults: PAGE_SIZE };
        if (nextPageToken) params.nextPageToken = nextPageToken;
        const result = await api.get<SearchPage>("/rest/api/3/search/jql", params);
        issues.push(...(result.issues ?? []));
        nextPageToken = result.nextPageToken;
        if (result.isLast || !nextPageToken) return { issues, truncated: false };
    }
    return { issues, truncated: true };
}

async function allComments(api: Api, key: string): Promise<RawComment[]> {
    const comments: RawComment[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const result = await api.get<{ comments?: RawComment[]; total?: number }>(
            `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
            { startAt: comments.length, maxResults: 100, orderBy: "created" }
        );
        const batch = result.comments ?? [];
        comments.push(...batch);
        if (batch.length === 0 || comments.length >= (result.total ?? 0)) break;
    }
    return comments;
}

/** Days since the ticket entered its current status, from the changelog; the status category date is the fallback. */
async function daysInStatus(api: Api, issue: RawIssue, now: Date): Promise<number | null> {
    const status = issue.fields.status?.name ?? "";
    let since: number | undefined;
    for (let seen = 0, page = 0; page < MAX_PAGES; page++) {
        const result = await api.get<{ values?: Array<{ created: string; items?: Array<{ field?: string; toString?: string }> }>; total?: number }>(
            `/rest/api/3/issue/${encodeURIComponent(issue.key)}/changelog`,
            { startAt: seen, maxResults: 100 }
        );
        const values = result.values ?? [];
        for (const history of values) {
            if (history.items?.some((item) => item.field === "status" && item.toString?.toLowerCase() === status.toLowerCase())) {
                since = timeOf(history.created);
            }
        }
        seen += values.length;
        if (values.length === 0 || seen >= (result.total ?? 0)) break;
    }
    const entered = since ?? (issue.fields.statuscategorychangedate ? timeOf(issue.fields.statuscategorychangedate) : Number.NaN);
    return Number.isNaN(entered) ? null : Math.max(0, Math.floor((now.getTime() - entered) / DAY_MS));
}

function isHandoff(issue: RawIssue): boolean {
    return isHandoffStatus(issue.fields.status?.name ?? "");
}

function isDone(issue: RawIssue): boolean {
    return !!issue.fields.resolution || issue.fields.status?.statusCategory?.key === "done";
}

function toTicket(config: Config, issue: RawIssue): JiraTicket {
    return {
        key: issue.key,
        summary: issue.fields.summary ?? "",
        status: issue.fields.status?.name ?? "",
        resolution: issue.fields.resolution?.name ?? null,
        url: `${config.baseUrl}/browse/${issue.key}`,
        assignee: issue.fields.assignee?.displayName ?? null,
        updated: issue.fields.updated ? new Date(timeOf(issue.fields.updated)).toISOString() : ""
    };
}

/** Parses Jira's `2026-10-26T09:15:00.000-0400`, whose offset has no colon. */
function timeOf(stamp: string): number {
    return Date.parse(stamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

