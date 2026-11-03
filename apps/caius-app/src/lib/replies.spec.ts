import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { applyChunk, type AssistantTurn, type ChatChunk, sseParser, stepOf } from "./chat.js";
import { stepPicks, stepReply } from "./replies.js";

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
            ...(next ? stepReply(next, { candidates: { 0: "take" } }) : [])
        ].join(" ");
        expect(reply).toMatch(/^Leftovers: "[^"]+" is done; "[^"]+" goes on Thu 5 Nov's list; "[^"]+" drop it: Sam has it; /);
        expect(reply).toContain(`"${((next?.data.candidates ?? []) as { text: string }[])[0]?.text}": take it`);
    });

    it("words Plan my day's On deck, candidates and unmarked tasks, and the catch-up only once picked", () => {
        const inputs = {
            ritual: "plan" as const, step: "inputs", data: {
                onDeck: [ { text: "Sketch the copy", fate: { list: true } }, { text: "Write the report", fate: { forward: "2026-W45", forwardLabel: "the week of Mon 2 Nov" } } ],
                candidates: [ { text: "Get ZAP-2041 reviewed", kind: "jira", sourceLabel: "Jira" } ],
                unmarked: [ { ref: "u1", text: "The ballot" }, { ref: "u2", text: "Vincent relink" }, { ref: "u3", text: "Pay the invoice" } ]
            }
        };
        expect(stepReply(inputs, {})).toEqual([
            `On deck: "Sketch the copy" goes on today's list; "Write the report" goes to the week of Mon 2 Nov.`,
            `Candidates: "Get ZAP-2041 reviewed": not taken, goes to Suggested.`
        ]);
        expect(stepReply(inputs, { areas: { 0: "growth", 1: "recharge", 2: "foundation" } }).slice(2)).toEqual([
            "The ballot is Growth.", "Vincent relink is Recharge.", "Pay the invoice is work."
        ]);
        const catchup = { ritual: "plan" as const, step: "catchup", data: { tasks: [ { text: "Book the dentist" } ] } };
        expect(stepReply(catchup, {})).toEqual([]);
        expect(stepReply(catchup, { catchup: "move all to today" })).toEqual([ "Catch-up: move all to today." ]);
    });
});

describe("stepPicks", () => {
    const inputs = {
        ritual: "plan" as const, step: "inputs", data: {
            onDeck: [ { text: "Sketch the copy", fate: { list: true } }, { text: "Write the report", fate: { forward: "2026-11-03", forwardLabel: "Tue 3 Nov", onDeck: true } } ],
            candidates: [ { text: "Get ZAP-2041 reviewed", kind: "jira" }, { text: "Clean up the branch notes", kind: "week" } ],
            unmarked: [ { ref: "u1", text: "The ballot" } ]
        }
    };

    it("lists only what he tapped, and counts every item the card offers", () => {
        expect(stepPicks(inputs, {})).toEqual({ picks: [], total: 5 });
        const { picks, total } = stepPicks(inputs, {
            fates: { 0: { kind: "proposed" }, 1: { kind: "drop", reason: "Sam has it" } },
            candidates: { 0: "take", 1: null },
            areas: { 0: "growth" }
        });
        expect(total).toBe(5);
        expect(picks.map(({ what, choice }) => [ what, choice ])).toEqual([
            [ "Write the report", "Drop: Sam has it" ],
            [ "Get ZAP-2041 reviewed", "Take" ],
            [ "The ballot", "Growth" ]
        ]);
    });

    it("undoes one tap and leaves the others", () => {
        const answers = { fates: { 1: { kind: "list" as const } }, candidates: { 0: "take" as const, 1: "dismiss" as const } };
        const [ , take ] = stepPicks(inputs, answers).picks;
        const after = { ...answers, ...take.undo };
        expect(stepPicks(inputs, after).picks.map((p) => p.what)).toEqual([ "Write the report", "Clean up the branch notes" ]);
    });

    it("counts the catch-up and the Context lines", () => {
        const catchup = { ritual: "plan" as const, step: "catchup", data: { tasks: [ { text: "Book the dentist" } ] } };
        expect(stepPicks(catchup, {})).toEqual({ picks: [], total: 0 });
        expect(stepPicks(catchup, { catchup: "skip the catch-up" })).toMatchObject({ picks: [ { what: "Catch-up", choice: "Skip" } ], total: 1 });
        const context = { ritual: "winddown" as const, step: "context", data: { context: [ { text: "Sam is out" }, { text: "Release on Thursday" } ] } };
        expect(stepPicks(context, { context: { 1: "end" } })).toMatchObject({ picks: [ { what: "Release on Thursday", choice: "Let it end" } ], total: 2 });
    });
});
