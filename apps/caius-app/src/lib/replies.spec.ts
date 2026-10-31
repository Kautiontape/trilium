import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { applyChunk, type AssistantTurn, type ChatChunk, sseParser, stepOf } from "./chat.js";
import { stepReply } from "./replies.js";

/** The steps of turn 1 of the recorded Wind down: open, next and context, as the server sent them. */
function recordedSteps() {
    const wire = readFileSync(new URL("./fixtures/chat-winddown.sse", import.meta.url), "utf-8").split(/^### .*$/m).filter((t) => t.trim())[0];
    let turn: AssistantTurn = { id: "t", blocks: [], done: false };
    sseParser((data) => {
        turn = applyChunk(turn, JSON.parse(data) as ChatChunk);
    })(`${wire}\n\n`);
    return turn.blocks.flatMap((b) => b.type === "tool_call" ? [ stepOf(b.toolCall) ] : []).filter((s) => s !== null);
}

describe("stepReply", () => {
    it("names every leftover and every candidate with its fate when nothing was tapped", () => {
        const steps = recordedSteps();
        const reply = steps.flatMap((step) => stepReply(step, {})).join(" ");
        const open = steps.find((s) => s.step === "open");
        const next = steps.find((s) => s.step === "next");
        const items = (open?.data.items ?? []) as { text: string }[];
        const candidates = (next?.data.candidates ?? []) as { text: string; kind: string; sourceLabel: string }[];
        expect(items.length).toBeGreaterThan(0);
        expect(candidates.length).toBeGreaterThan(0);

        for (const item of items) {
            expect(reply).toContain(`"${item.text}"`);
        }
        expect(reply).toContain(`"Ship the phone API report" goes on Thu 5 Nov's list`);
        expect(reply).toContain(`"Fix the plan tab refresh" goes to Thu 5 Nov's On deck`);
        for (const candidate of candidates) {
            expect(reply).toContain(`"${candidate.text}": not taken, ${candidate.kind === "week" ? `stays on ${candidate.sourceLabel}` : "goes to Suggested"}`);
        }
        expect(reply).toContain("Evening: nothing.");
        expect(reply).toContain(`"Phone alpha week" stays as it is (until Sat 7 Nov); nothing to add for Thu 5 Nov.`);
        expect(reply.toLowerCase()).not.toContain("looks right");
        expect(reply).not.toContain("as you said");
    });

    it("puts his taps in place of the defaults and keeps every other item explicit", () => {
        const steps = recordedSteps();
        const open = steps.find((s) => s.step === "open");
        const next = steps.find((s) => s.step === "next");
        const reply = [
            ...(open ? stepReply(open, { fates: { 0: { kind: "done" }, 1: { kind: "day", label: "Thu 5 Nov", onDeck: false }, 2: { kind: "drop", reason: "Sam has it" } } }) : []),
            ...(next ? stepReply(next, { candidates: { 0: "take" }, evening: "nothing tonight" }) : [])
        ].join(" ");
        expect(reply).toMatch(/^Leftovers: "[^"]+" is done; "[^"]+" goes on Thu 5 Nov's list; "[^"]+" drop it: Sam has it; /);
        expect(reply).toContain(`"${((next?.data.candidates ?? []) as { text: string }[])[0]?.text}": take it`);
        expect(reply).toContain("Evening: nothing tonight.");
    });

    it("words Plan my day's On deck, candidates and evening, and the catch-up only once picked", () => {
        const inputs = {
            ritual: "plan" as const, step: "inputs", data: {
                onDeck: [ { text: "Sketch the copy", fate: { list: true } }, { text: "Write the report", fate: { forward: "2026-W45", forwardLabel: "the week of Mon 2 Nov" } } ],
                candidates: [ { text: "Get ZAP-2041 reviewed", kind: "jira", sourceLabel: "Jira" } ],
                evening: { tasks: [ "Laundry" ] }
            }
        };
        expect(stepReply(inputs, {})).toEqual([
            `On deck: "Sketch the copy" goes on today's list; "Write the report" goes to the week of Mon 2 Nov.`,
            `Candidates: "Get ZAP-2041 reviewed": not taken, goes to Suggested.`,
            `Evening: "Laundry" as it is, nothing else.`
        ]);
        const catchup = { ritual: "plan" as const, step: "catchup", data: { tasks: [ { text: "Book the dentist" } ] } };
        expect(stepReply(catchup, {})).toEqual([]);
        expect(stepReply(catchup, { catchup: "move all to today" })).toEqual([ "Catch-up: move all to today." ]);
    });
});
