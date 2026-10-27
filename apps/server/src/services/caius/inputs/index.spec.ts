import { describe, expect, it } from "vitest";

import { toolInputs } from "../schemas.js";
import { readInputs } from "./index.js";

describe("caius_inputs input", () => {
    it("takes work windows from 00:00 to 24:00 and no minute past it", () => {
        const parse = (workEnd: string) => toolInputs.inputs.safeParse({ date: "2026-10-27", workEnd }).success;
        expect([ "00:00", "23:59", "24:00" ].every(parse)).toBe(true);
        expect([ "24:01", "24:59", "25:00", "9:00", "12:60" ].some(parse)).toBe(false);
    });
});

describe("caius_inputs sources", () => {
    it("reads Jira and the calendar at the same time", async () => {
        let feedRequested!: () => void;
        const feedSeen = new Promise<void>((resolve) => { feedRequested = resolve; });
        const doFetch = (async (input: URL | string) => {
            const url = new URL(input);
            if (url.hostname === "feed.example.com") {
                feedRequested();
                return new Response("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n");
            }
            // Jira answers only once the feed has been asked for: read in turn, this never ends.
            await feedSeen;
            return new Response("{}", { status: 401 });
        }) as unknown as typeof fetch;

        const result = await readInputs({ date: "2026-10-27" }, {
            fetch: doFetch,
            env: { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "a@example.com", JIRA_TOKEN: "t", CAIUS_ICAL_URLS: "https://feed.example.com/a.ics" },
            now: () => new Date("2026-10-27T15:00:00Z")
        });
        expect(result.errors).toEqual([ { source: "jira", error: "http_401" } ]);
    });
});
