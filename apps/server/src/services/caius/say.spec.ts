import { describe, expect, it } from "vitest";

import { inHisVoice, sayOf } from "./say.js";

describe("inHisVoice", () => {
    it("rewrites a line that starts 'Shawn <verb>s' as the verb's -ing form, and leaves a line without his name alone", () => {
        expect(inHisVoice("Shawn takes Incident Review over Vendor Onboarding at 11:00")).toEqual({ text: "Taking Incident Review over Vendor Onboarding at 11:00" });
        expect(inHisVoice("Shawn covers the release")).toEqual({ text: "Covering the release" });
        expect(inHisVoice("shawn runs standup")).toEqual({ text: "Running standup" });
        expect(inHisVoice("Shawn goes to the dentist at 3")).toEqual({ text: "Going to the dentist at 3" });
        expect(inHisVoice("ZAP-2590 is open")).toEqual({ text: "ZAP-2590 is open" });
        expect(inHisVoice("Shawnee office is closed")).toEqual({ text: "Shawnee office is closed" });
    });

    it("refuses any other line that names him, so the agent rewords it", () => {
        for (const text of [ "Riley plans the release with Shawn", "Shawn is out Friday", "Shawn has the demo", "Shawn's call moved", "Shawn takes the call; Shawn presents" ]) {
            expect(inHisVoice(text), text).toEqual({ error: expect.stringContaining("his voice") });
        }
    });
});

/** What `say` must never hold: a list item id, a ref, a line or overlap id, or an ISO date. */
const ID = /\be[0-9a-f]{8,}|\b[oclxdw]\d+\b|\b[lo][0-9a-f]{10}\b|\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}/;

describe("sayOf", () => {
    it("Wed 17:45: what was ticked, moved and added, in one sentence, with no ids", () => {
        const say = sayOf({
            written: [
                { kind: "done", id: "e111aaaaaaaa", text: "ZAP-111 Check the invoice export in QA", status: "written" },
                { kind: "done", id: "e101aaaaaaaa", text: "ZAP-101 Verify the export retry on staging", status: "written" },
                { kind: "done", id: "ebagaaaaaaaa", text: "Pack the climbing gym bag", status: "written" },
                { kind: "fate", id: "edaveaaaaaaa", text: "Message Dave about the lights", detail: "2026-11-05", status: "written" },
                { kind: "finished", id: "ZAP-111", status: "written" },
                { kind: "finished", id: "ZAP-101", status: "written" },
                { kind: "evening", text: "Laundry", status: "written" },
                { kind: "context", text: "Taking Incident Review over Vendor Onboarding at 11:00", status: "written" },
                { kind: "header", detail: "2026-11-04", status: "written" }
            ],
            skipped: []
        }, { day: "2026-11-05" });
        expect(say).toBe("ZAP-111, ZAP-101 and Pack the climbing gym bag are done, Message Dave about the lights moved to Thu 5 Nov, "
            + "Laundry is on Thursday evening and 'Taking Incident Review over Vendor Onboarding at 11:00' is noted.");
        expect(say).not.toMatch(ID);
    });

    it("Plan my day: the accepts and the order, a second sentence for what was skipped, and nothing for what was already there", () => {
        const say = sayOf({
            written: [
                { kind: "accept", id: "ZAP-110", text: "Get ZAP-110 Fix the importer done", status: "written" },
                { kind: "accept", id: "ZAP-101", text: "Get ZAP-101 Verify the export retry done", status: "written" },
                { kind: "place", id: "ZAP-101", text: "Get ZAP-101 Verify the export retry done", detail: "first", status: "written" },
                { kind: "move", id: "e110aaaaaaaa", text: "ZAP-110 Fix the importer", detail: "after", anchor: "ZAP-101 Verify the export retry", status: "written" },
                { kind: "suggested", id: "ZAP-105", text: "Get ZAP-105 Confirm the bucket done", status: "written" },
                { kind: "meetings", status: "unchanged" },
                { kind: "brief", status: "written" }
            ],
            skipped: [
                { kind: "evening", text: "just mom", reason: "calendar_event", detail: "Call Mom" },
                { kind: "done", text: "the export", reason: "ambiguous", detail: "ZAP-111 Check the export; ZAP-101 Verify the export retry" },
                { kind: "done", id: "e999aaaaaaaa", reason: "not_offered" }
            ]
        }, { day: "2026-11-02" });
        expect(say).toBe("ZAP-110 and ZAP-101 are on your list, ZAP-101 is first, ZAP-110 is after ZAP-101, ZAP-105 is in Suggested and the brief is written. "
            + "Call Mom is already on the calendar, 'the export' is unchanged since it could be ZAP-111 or ZAP-101 and one task wasn't found.");
        expect(say).not.toMatch(ID);
    });

    it("names an item that changed since the step, with or without its text", () => {
        expect(sayOf({ written: [], skipped: [ { kind: "accept", text: "Get ZAP-170 Check the report done", reason: "stale" }, { kind: "accept", reason: "stale" } ] }, { day: "2026-11-02" }))
            .toBe("ZAP-170 changed since you saw it, so it stays as it was and one task changed since you saw it.");
    });

    it("says so when nothing needed writing", () => {
        expect(sayOf({ written: [ { kind: "brief", status: "unchanged" } ], skipped: [] }, { day: "2026-11-02" })).toBe("Everything was already in place.");
    });
});
