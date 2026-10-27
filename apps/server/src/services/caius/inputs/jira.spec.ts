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
        expect(jira.headers[0].Authorization).toBe(`Basic ${Buffer.from(`sam@example.com:${TOKEN}`).toString("base64")}`);
    });

    it("keeps comments that mention or ask the user after their own last comment", async () => {
        const { jira } = await run(fakeJira().doFetch);

        // ZAP-105: the 13 Oct question is old, the 22 Oct comment is the user's own, the 25 Oct
        // update neither asks nor mentions. ZAP-106's question came before the user's reply.
        expect(jira.asks.map((a) => [ a.ticket.key, a.author, a.created ])).toEqual([
            [ "ZAP-105", "Riley Sample", "2026-10-24T15:20:00.000Z" ],
            [ "ZAP-105", "Jordan Placeholder", "2026-10-25T18:00:00.000Z" ]
        ]);
        expect(jira.asks[0].excerpt.length).toBeGreaterThan(190);
        expect(jira.asks[0].excerpt.length).toBeLessThanOrEqual(200);
        expect(jira.asks[0].excerpt.endsWith("…")).toBe(true);
        expect(jira.asks[0].excerpt.startsWith("Can you confirm the staging bucket name before Friday? The release notes")).toBe(true);
        expect(jira.asks[1].excerpt).toBe("@Sam Example the rollout note is in the runbook now.");
    });

    it("reports tickets Jira calls done, and lets a Context line reopen one", async () => {
        const plain = await run(fakeJira().doFetch);
        expect(plain.jira.done).toEqual([ "ZAP-103", "ZAP-104" ]);

        const reopened = await run(fakeJira().doFetch, ENV, [ "ZAP-103 is open; Jira's Done is a mistake", "ZAP-102 was reopened" ]);
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
