import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readInputs } from "./index.js";
import { adfToText, asksIn, isHandoffStatus, overriddenKeys } from "./jira.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const TOKEN = "tok-not-a-real-secret";
const ENV = { JIRA_BASE_URL: "https://example.atlassian.net/", JIRA_EMAIL: "sam@example.com", JIRA_TOKEN: TOKEN };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira/${name}.json`, import.meta.url), "utf8"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Answers from the recorded files, paging comments three at a time like a small Jira would. */
function fakeJira() {
    const calls: URL[] = [];
    const headers: Array<Record<string, string>> = [];
    const doFetch = (async (input: URL, init?: { headers?: Record<string, string> }) => {
        calls.push(input);
        headers.push(init?.headers ?? {});
        const { pathname, searchParams } = input;
        if (pathname === "/rest/api/3/myself") return json(fixture("myself"));
        if (pathname === "/rest/api/3/search/jql") {
            if (searchParams.get("jql")?.startsWith("assignee = currentUser() AND statusCategory")) {
                return json(fixture(searchParams.get("nextPageToken") ? "search-assigned-page2" : "search-assigned-page1"));
            }
            return json(fixture("search-involved"));
        }
        const comments = /issue\/([A-Z]+-\d+)\/comment$/.exec(pathname);
        if (comments) {
            const all = fixture(`comments-${comments[1]}`);
            const startAt = Number(searchParams.get("startAt"));
            return json({ total: all.total, comments: all.comments.slice(startAt, startAt + 3) });
        }
        const changelog = /issue\/([A-Z]+-\d+)\/changelog$/.exec(pathname);
        if (changelog) return json(fixture(`changelog-${changelog[1]}`));
        return json({}, 404);
    }) as unknown as typeof fetch;
    return { doFetch, calls, headers };
}

/** Runs `caius_inputs` with no calendar feeds set, and drops that source's `not_configured` entry. */
async function run(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV, context?: string[]) {
    const result = await readInputs({ date: "2026-10-27", context }, { fetch: fetchImpl, env, now: () => NOW });
    return { ...result, errors: result.errors.filter((e) => e.source === "jira") };
}

describe("caius_inputs Jira", () => {
    it("lists hand-off tickets with their days in status, across pages", async () => {
        const jira = fakeJira();
        const { jira: result, errors } = await run(jira.doFetch);

        expect(errors).toEqual([]);
        expect(result.handoff.map((t) => [ t.key, t.daysInStatus ])).toEqual([
            [ "ZAP-101", 6 ],   // the changelog's last move into Dev Verify
            [ "ZAP-103", 3 ],
            [ "ZAP-110", 2 ],   // no changelog entry: statuscategorychangedate
            [ "ZAP-111", 3 ]    // QA Testing
        ]);
        expect(result.handoff[0]).toMatchObject({
            summary: "Verify the export retry on staging",
            status: "Dev Verify",
            resolution: null,
            url: "https://example.atlassian.net/browse/ZAP-101",
            assignee: "Sam Example",
            updated: "2026-10-26T20:30:00.000Z"
        });
        const second = jira.calls.filter((u) => u.pathname.endsWith("/search/jql") && u.searchParams.has("nextPageToken"));
        expect(second).toHaveLength(1);
        // The window is relative to Jira's clock; the exact 7 days are applied in code.
        expect(jira.calls.some((u) => u.searchParams.get("jql")?.includes("updated >= -8d"))).toBe(true);
        expect(jira.headers[0].Authorization).toBe(`Basic ${Buffer.from(`sam@example.com:${TOKEN}`).toString("base64")}`);
    });

    it("keeps comments that mention or ask the user after their own last comment", async () => {
        const { jira } = await run(fakeJira().doFetch);

        // ZAP-105: the 13 Oct question is old, the 22 Oct comment is the user's own, the 25 Oct
        // update neither asks nor mentions. ZAP-106's question came before the user's reply.
        expect(jira.asks.map((a) => [ a.ticket.key, a.author, a.created ])).toEqual([
            [ "ZAP-105", "Riley Sample", "2026-10-24T15:20:00.000Z" ],
            [ "ZAP-105", "Jordan Placeholder", "2026-10-25T18:00:00.000Z" ],
            [ "ZAP-104", "Riley Sample", "2026-10-26T19:30:00.000Z" ]
        ]);
        expect(jira.asks[0].excerpt.length).toBeGreaterThan(190);
        expect(jira.asks[0].excerpt.length).toBeLessThanOrEqual(200);
        expect(jira.asks[0].excerpt.endsWith("…")).toBe(true);
        expect(jira.asks[0].excerpt.startsWith("Can you confirm the staging bucket name before Friday? The release notes")).toBe(true);
        expect(jira.asks[1].excerpt).toBe("@Sam Example the rollout note is in the runbook now.");
    });

    it("reports tickets Jira calls done, and lets a Context line reopen one", async () => {
        const plain = await run(fakeJira().doFetch);
        // ZAP-107 is Done too, but neither a hand-off nor the subject of an ask.
        expect(plain.jira.done).toEqual([ "ZAP-103", "ZAP-104" ]);

        const reopened = await run(fakeJira().doFetch, ENV, [ "zap-103 is open; Jira's Done is a mistake", "ZAP-102 was reopened" ]);
        expect(reopened.jira.done).toEqual([ "ZAP-104" ]);
        expect(reopened.jira.handoff.find((t) => t.key === "ZAP-103")?.overridden).toBe(true);
        expect(reopened.jira.handoff.find((t) => t.key === "ZAP-101")?.overridden).toBeUndefined();
    });

    it("answers an error entry and empty lists for a 401, a missing setting or a timeout, without leaking the token", async () => {
        const unauthorized = await run((async () => json({ message: "nope" }, 401)) as unknown as typeof fetch);
        expect(unauthorized.errors).toEqual([ { source: "jira", error: "http_401" } ]);
        expect(unauthorized.jira).toEqual({ handoff: [], asks: [], done: [] });

        const missing = await run(fakeJira().doFetch, { ...ENV, JIRA_TOKEN: undefined });
        expect(missing.errors).toEqual([ { source: "jira", error: "not_configured" } ]);

        const timedOut = await run((async () => { throw new DOMException("took too long", "TimeoutError"); }) as unknown as typeof fetch);
        expect(timedOut.errors).toEqual([ { source: "jira", error: "timeout" } ]);

        expect(JSON.stringify([ unauthorized, missing, timedOut ])).not.toContain(TOKEN);
    });
});

describe("caius_inputs Jira under strain", () => {
    const withFixtures = (override: (url: URL) => Response | undefined) => {
        const base = fakeJira();
        return (async (input: URL, init?: never) => override(input) ?? base.doFetch(input, init)) as unknown as typeof fetch;
    };
    const runWith = (fetchImpl: typeof fetch, sleeps: number[] = []) =>
        readInputs({ date: "2026-10-27" }, { fetch: fetchImpl, env: ENV, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } });

    it("retries a 503 or 429 once, waiting for Retry-After up to five seconds", async () => {
        for (const [ header, waited ] of [ [ "2", 2000 ], [ "30", 5000 ], [ undefined, 1000 ] ] as const) {
            let hits = 0;
            const sleeps: number[] = [];
            const result = await runWith(withFixtures((url) => {
                if (url.pathname !== "/rest/api/3/myself" || hits++ > 0) return undefined;
                return new Response("{}", { status: 503, headers: header ? { "Retry-After": header } : {} });
            }), sleeps);
            expect(result.errors.filter((e) => e.source === "jira")).toEqual([]);
            expect(sleeps).toEqual([ waited ]);
        }

        const twice = await runWith(withFixtures((url) => url.pathname === "/rest/api/3/myself" ? new Response("{}", { status: 429 }) : undefined));
        expect(twice.errors.filter((e) => e.source === "jira")).toEqual([ { source: "jira", error: "http_429" } ]);
    });

    it("keeps going when one ticket's comments or changelog fail, and says so once each", async () => {
        const result = await runWith(withFixtures((url) =>
            /ZAP-105\/comment$|ZAP-101\/changelog$/.test(url.pathname) ? new Response("{}", { status: 500 }) : undefined
        ));
        const jiraErrors = result.errors.filter((e) => e.source === "jira").map((e) => e.error).sort();
        expect(jiraErrors).toEqual([ "asks_partial", "handoff_partial" ]);
        expect(result.jira.asks.map((a) => a.ticket.key)).toEqual([ "ZAP-104" ]);
        expect(result.jira.handoff.find((t) => t.key === "ZAP-101")?.daysInStatus).toBeNull();
        expect(result.jira.handoff.find((t) => t.key === "ZAP-103")?.daysInStatus).toBe(3);
    });

    it("names a cap that bites, fetching comments four at a time", async () => {
        const many = Array.from({ length: 90 }, (_, i) => ({ key: `ZAP-${500 + i}`, fields: { summary: "x", status: { name: "In Progress" }, updated: "2026-10-26T10:00:00.000-0400" } }));
        let inFlight = 0;
        let peak = 0;
        const result = await runWith((async (input: URL) => {
            const { pathname, searchParams } = input;
            if (pathname === "/rest/api/3/myself") return new Response(JSON.stringify({ accountId: "acc-sam-0001" }));
            if (pathname === "/rest/api/3/search/jql") {
                const assigned = searchParams.get("jql")?.startsWith("assignee = currentUser() AND statusCategory");
                // The assigned search never ends; the involved one returns 90 tickets.
                return new Response(JSON.stringify(assigned
                    ? { issues: many.slice(0, 5), nextPageToken: "more" }
                    : { issues: many, isLast: true }));
            }
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;
            return new Response(JSON.stringify({ total: 0, comments: [], values: [] }));
        }) as unknown as typeof fetch);

        const codes = result.errors.filter((e) => e.source === "jira").map((e) => e.error).sort();
        expect(codes).toEqual([ "asks_truncated", "search_truncated" ]);
        expect(peak).toBe(4);
    });
});

describe("Jira helpers", () => {
    it("matches hand-off statuses in full and ignoring case", () => {
        const waiting = [ "dev verify", "Code Review", "READY FOR QA", "qa testing", "Pending Feedback" ];
        expect(waiting.every(isHandoffStatus)).toBe(true);
        expect([ "QA", "In Progress", "Ready To Work", "Dev Verify Later" ].some(isHandoffStatus)).toBe(false);
    });

    it("reads a ticket key together with the word open, not reopened", () => {
        expect([ ...overriddenKeys([ "ZAP-2590 is open", "SUR-7 and CM-12: open", "ZIS-3 reopened", "no key here, open" ]) ]).toEqual([ "ZAP-2590", "SUR-7", "CM-12" ]);
        expect([ ...overriddenKeys([ "ZAP-1 is not open", "ZAP-2 isn't open", "ZAP-3 is no longer open", "ZAP-4 isn’t open", "ZAP-5 is NOT open" ]) ]).toEqual([]);
        expect([ ...overriddenKeys([ "ZAP-6 is open, not blocked" ]) ]).toEqual([ "ZAP-6" ]);
    });

    it("flattens Atlassian Document Format to one line", () => {
        const body = { type: "doc", content: [
            { type: "paragraph", content: [ { type: "text", text: "Hello " }, { type: "mention", attrs: { id: "x", text: "@Sam" } } ] },
            { type: "bulletList", content: [ { type: "listItem", content: [ { type: "paragraph", content: [ { type: "text", text: "one" } ] } ] } ] }
        ] };
        expect(adfToText(body)).toBe("Hello @Sam one");
    });

    it("ignores comments on a ticket with no question, mention or newer than the user's last comment", () => {
        const ticket = { key: "A-1" } as never;
        const plain = (text: string) => ({ type: "doc", content: [ { type: "paragraph", content: [ { type: "text", text } ] } ] });
        const comments = [
            { created: "2026-10-26T10:00:00.000+0000", author: { accountId: "other", displayName: "O" }, body: plain("Done?") },
            { created: "2026-10-26T11:00:00.000+0000", author: { accountId: "me", displayName: "Me" }, body: plain("yes") }
        ];
        expect(asksIn(ticket, comments, "me", new Date("2026-10-20T00:00:00Z"))).toEqual([]);
        expect(asksIn(ticket, comments.slice(0, 1), "me", new Date("2026-10-20T00:00:00Z"))).toHaveLength(1);
    });
});
