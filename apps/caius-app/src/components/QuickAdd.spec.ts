import { describe, expect, it } from "vitest";

import { dayHint } from "./QuickAdd.js";

describe("dayHint", () => {
    it("offers the day, week or month the text names, with the word to strip", () => {
        expect(dayHint("Order the shelf brackets thu", "2026-11-04")).toMatchObject({ label: "Thu 5 Nov", target: { kind: "onDeck", date: "2026-11-05" } });
        expect(dayHint("call the bank on Monday", "2026-11-04")).toMatchObject({ label: "Mon 9 Nov", target: { kind: "onDeck", date: "2026-11-09" } });
        expect(dayHint("plan the offsite next week", "2026-11-04")).toMatchObject({ label: "Week 46", target: { kind: "week", week: "2026-W46" } });
        expect(dayHint("renew it next month", "2026-11-04")?.target).toEqual({ kind: "month", month: "2026-12" });
        expect("call the bank on Monday".replace(dayHint("call the bank on Monday", "2026-11-04")?.word ?? "", "")).toBe("call the bank on ");
        expect(dayHint("thumbtacks", "2026-11-04")).toBeNull();
    });
});

describe("displayText", () => {
    it("shows a forwarded task's day instead of Caius's marker, and links as their labels", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect(displayText("Pair on the seed data ~30m _scheduled [Thu 5 Nov](#root/xZTuVVFJcsxn)_"))
            .toEqual({ text: "Pair on the seed data", forwardedTo: "Thu 5 Nov" });
        expect(displayText("Get [QRS-2041](https://jira.example/QRS-2041) reviewed")).toEqual({ text: "Get QRS-2041 reviewed", forwardedTo: null });
    });

    it("leaves out a copy's \"from …\" link and keeps its other links", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect(displayText("Count the seats [QRS-7](https://jira.example/QRS-7) [from 2026-08-11 Pilot call](#root/abcDEF123456)"))
            .toEqual({ text: "Count the seats QRS-7", forwardedTo: null });
        expect(displayText("Read [from the top](https://example.com/guide)")).toEqual({ text: "Read from the top", forwardedTo: null });
    });

    it("drops a leading area marker and clock, and hands back the marker's area", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect(displayText("🌱 Read the ballot")).toEqual({ text: "Read the ballot", forwardedTo: null, area: "growth" });
        expect(displayText("🔋 14:30 Vincent relink ~30m")).toEqual({ text: "Vincent relink ~30m", forwardedTo: null, area: "recharge" });
        expect(displayText("09:30 Standup prep")).toEqual({ text: "Standup prep", forwardedTo: null });
        expect(displayText("Plan 10:30 slots").area).toBeUndefined();
    });

    it("shows the day a forwarded task went to when the editor has saved its marker", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect.soft(displayText("Pair on the seed data ~30m _scheduled_ [_Thu 5 Nov_](#root/xZTuVVFJcsxn)"))
            .toEqual({ text: "Pair on the seed data", forwardedTo: "Thu 5 Nov" });
        expect.soft(displayText("Pair on the seed data ~30m _scheduled_\u00a0[05 - Thursday](#root/xZTuVVFJcsxn)"))
            .toEqual({ text: "Pair on the seed data", forwardedTo: "05 - Thursday" });
        expect.soft(displayText("Pair on the seed data _scheduled_").forwardedTo).toBeNull();
    });

    it("reads only Caius's marker, and the latest of several", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect.soft(displayText("Read the scheduled [runbook](https://wiki.example/x)"))
            .toEqual({ text: "Read the scheduled runbook", forwardedTo: null });
        expect.soft(displayText("Tidy unscheduled [x](#root/a)").forwardedTo).toBeNull();
        expect.soft(displayText("Pair on the seed data _scheduled [Tue](#root/a)_ _scheduled [Wed](#root/b)_"))
            .toEqual({ text: "Pair on the seed data", forwardedTo: "Wed" });
    });

    it("keeps the user's own scheduled words, and only a lower-case marker with its leading underscore counts", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect.soft(displayText("Prep for the scheduled [Q4 planning](#root/q4)"))
            .toEqual({ text: "Prep for the scheduled Q4 planning", forwardedTo: null });
        expect.soft(displayText("un_scheduled [x](#root/a)").forwardedTo).toBeNull();
        expect.soft(displayText("word_scheduled [x](#root/a)").forwardedTo).toBeNull();
        expect.soft(displayText("_Scheduled [Tue](#root/a)_").forwardedTo).toBeNull();
        expect.soft(displayText("_scheduled_ [from Mon](#root/m)").forwardedTo).toBeNull();
    });

    it("keeps the user's own estimate and refuses a \"from\" link whether or not it is italic", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect.soft(displayText("Block ~2h for the review _scheduled [Tue](#root/x)_"))
            .toEqual({ text: "Block ~2h for the review", forwardedTo: "Tue" });
        expect.soft(displayText("Pair on the seed data _scheduled [Thu 5 Nov](#root/x)_"))
            .toEqual({ text: "Pair on the seed data", forwardedTo: "Thu 5 Nov" });
        expect.soft(displayText("_scheduled_ [_from Mon_](#root/m)").forwardedTo).toBeNull();
        expect.soft(displayText("_scheduled_ [from Mon](#root/m)").forwardedTo).toBeNull();
    });

describe("displayText's emphasis", () => {
    it("drops **bold**, *italic* and _italic_ markers and keeps their words, but not an underscore inside a word", async () => {
        const { displayText } = await import("./TaskRow.js");
        expect(displayText("**Drop off the mail-in ballot.** [from Thu 29 Oct](#root/HwEzPVPRECFu)").text).toBe("Drop off the mail-in ballot.");
        expect(displayText("Read *the* runbook, _then_ run snake_case_job").text).toBe("Read the runbook, then run snake_case_job");
    });
});
});
