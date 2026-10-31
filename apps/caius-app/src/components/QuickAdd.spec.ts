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
        expect(displayText("Get [ZAP-2041](https://jira.example/ZAP-2041) reviewed")).toEqual({ text: "Get ZAP-2041 reviewed", forwardedTo: null });
    });
});
