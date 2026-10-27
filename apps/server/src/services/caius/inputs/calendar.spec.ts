import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readInputs } from "./index.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const FEEDS = [ "https://calendar.example.com/ical/secret-token-aaa/work.ics", "https://mail.example.net/dav/secret-token-bbb/personal.ics" ];
const ENV = {
    CAIUS_ICAL_URLS: FEEDS.join(","),
    JIRA_BASE_URL: "https://example.atlassian.net",
    JIRA_EMAIL: "sam@example.com",
    JIRA_TOKEN: "tok-not-a-real-secret"
};

const ics = (name: string) => readFileSync(new URL(`../fixtures/ical/${name}.ics`, import.meta.url), "utf8");
const jiraFixture = (name: string) => readFileSync(new URL(`../fixtures/jira/${name}.json`, import.meta.url), "utf8");

function fakeNetwork(overrides: Partial<Record<string, () => Response>> = {}) {
    return (async (input: URL | string) => {
        const url = new URL(input);
        const override = overrides[url.href];
        if (override) return override();
        if (url.href === FEEDS[0]) return new Response(ics("work"));
        if (url.href === FEEDS[1]) return new Response(ics("personal"));
        if (url.pathname === "/rest/api/3/myself") return new Response(jiraFixture("myself"));
        if (url.pathname === "/rest/api/3/search/jql") return new Response(jiraFixture("search-involved"));
        if (url.pathname.endsWith("/comment")) return new Response(JSON.stringify({ total: 0, comments: [] }));
        if (url.pathname.endsWith("/changelog")) return new Response(JSON.stringify({ total: 0, values: [] }));
        return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
}

const run = (date: string, env: Record<string, string | undefined> = ENV, doFetch = fakeNetwork()) =>
    readInputs({ date }, { fetch: doFetch, env, now: () => NOW });

const summary = (events: Awaited<ReturnType<typeof run>>["calendar"]) =>
    events.map((e) => `${e.start}-${e.end} ${e.title}`);

describe("caius_inputs calendar", () => {
    beforeEach(() => {
        vi.stubEnv("TZ", "America/New_York");
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("lists the day's events in local time, from recurrences, an override and UTC times", async () => {
        const { calendar } = await run("2026-10-27");

        // The weekly Planning Sync has an EXDATE on the 27th, the Customer Call instance moved
        // from 11:00 to 15:00, and the cancelled Kickoff is not an event.
        expect(summary(calendar)).toEqual([
            "00:00-24:00 Office Closed for Training",
            "08:00-09:00 Dentist",
            "12:00-12:30 Corporate Team Meeting",
            "13:00-14:00 Architecture Review",
            "13:30-14:30 Budget Check-in",
            "14:30-15:00 Hallway Chat",
            "15:00-15:30 Customer Call",
            "16:00-17:00 Vendor Demo",
            "17:00-17:30 Sprint Retro"
        ]);
        expect(calendar[0]).toMatchObject({ allDay: true, declined: false, source: [ 0 ] });
        expect(calendar.find((e) => e.title === "Vendor Demo")).toMatchObject({
            attendees: [ "Sam Example", "Riley Sample" ], declined: true, allDay: false, source: [ 0, 1 ]
        });
        expect(calendar.find((e) => e.title === "Sprint Retro")).toMatchObject({ attendees: [ "sam", "jordan" ], declined: false });
    });

    it("shows the recurring meeting on a day without the EXDATE, at its usual time", async () => {
        const { calendar } = await run("2026-10-20");
        expect(summary(calendar)).toContain("10:00-10:30 Weekly Planning Sync");
        expect(summary(calendar)).toContain("11:00-11:30 Customer Call");
        expect(summary(calendar)).not.toContain("15:00-15:30 Customer Call");
    });

    it("moves a recurring instance onto another day, and off its original one", async () => {
        // The Architecture Review of Tue 3 Nov was moved to Wed 28 Oct, 09:00.
        expect(summary((await run("2026-10-28")).calendar)).toEqual([ "09:00-10:00 Architecture Review" ]);
        const original = summary((await run("2026-11-03")).calendar);
        expect(original).toContain("10:00-10:30 Weekly Planning Sync");
        expect(original.filter((line) => line.includes("Architecture Review"))).toEqual([]);
    });

    it("merges the same meeting across feeds and within one feed", async () => {
        const { calendar } = await run("2026-10-27");
        const copies = calendar.filter((e) => e.title === "Corporate Team Meeting");
        expect(copies).toHaveLength(1);
        expect(copies[0].source).toEqual([ 0, 1 ]);
        expect(calendar.find((e) => e.title === "Dentist")?.source).toEqual([ 1 ]);
        // Vendor Demo's second copy has no RSVP; the decline in the first still holds.
        expect(calendar.find((e) => e.title === "Vendor Demo")).toMatchObject({ source: [ 0, 1 ], declined: true });
    });

    it("flags overlapping meetings on both, and not back-to-back or declined ones", async () => {
        const { calendar } = await run("2026-10-27");
        const flagged = calendar.filter((e) => e.overlap).map((e) => e.title);
        expect(flagged).toEqual([ "Architecture Review", "Budget Check-in" ]);
        // Hallway Chat runs back-to-back with Budget Check-in and Customer Call; Vendor Demo is declined.
    });

    it("works out capacity from the day's meetings, leaving out the declined one", async () => {
        const busy = await run("2026-10-27");
        // 12:00-12:30, 13:00-15:30 (four meetings, two overlapping) and 17:00-17:30.
        expect(busy.capacity).toEqual({ windowMinutes: 480, bookedMinutes: 210, openMinutes: 270, targetMinutes: 176, bookedRatio: 0.4375 });

        const empty = await run("2026-10-31");
        expect(empty.calendar).toEqual([]);
        expect(empty.capacity).toEqual({ windowMinutes: 480, bookedMinutes: 0, openMinutes: 480, targetMinutes: 240, bookedRatio: 0 });
    });

    it("still returns the calendar when Jira answers 401, and Jira when a feed fails, naming neither URL", async () => {
        const jiraDown = await run("2026-10-27", ENV, fakeNetwork({
            "https://example.atlassian.net/rest/api/3/myself": () => new Response("{}", { status: 401 })
        }));
        expect(jiraDown.errors).toEqual([ { source: "jira", error: "http_401" } ]);
        expect(jiraDown.calendar.length).toBeGreaterThan(0);

        const feedDown = await run("2026-10-27", ENV, fakeNetwork({ [FEEDS[0]]: () => new Response("no", { status: 403 }) }));
        expect(feedDown.errors).toEqual([ { source: "calendar", error: "feed_0_http_403" } ]);
        expect(summary(feedDown.calendar)).toEqual([ "08:00-09:00 Dentist", "12:00-12:30 Corporate Team Meeting", "16:00-17:00 Vendor Demo" ]);
        expect(feedDown.jira.handoff.map((t) => t.key)).toEqual([ "ZAP-101" ]);

        const badFeed = await run("2026-10-27", ENV, fakeNetwork({ [FEEDS[1]]: () => new Response("not a calendar") }));
        expect(badFeed.errors).toEqual([ { source: "calendar", error: "feed_1_parse" } ]);

        const unset = await run("2026-10-27", { ...ENV, CAIUS_ICAL_URLS: undefined });
        expect(unset.errors).toEqual([ { source: "calendar", error: "not_configured" } ]);

        expect(JSON.stringify([ jiraDown, feedDown, badFeed ])).not.toMatch(/secret-token/);
    });

    it("treats the attendee at CAIUS_USER_EMAILS, as well as JIRA_EMAIL, as the user", async () => {
        const other = await run("2026-10-27", { ...ENV, JIRA_EMAIL: "someone@example.org", CAIUS_USER_EMAILS: "Sam@Example.com" });
        expect(other.calendar.find((e) => e.title === "Vendor Demo")?.declined).toBe(true);

        const nobody = await run("2026-10-27", { ...ENV, JIRA_EMAIL: "someone@example.org" });
        expect(nobody.calendar.find((e) => e.title === "Vendor Demo")?.declined).toBe(false);
    });
});
