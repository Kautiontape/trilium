// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it, vi } from "vitest";

import type { NestData, StepAnswers } from "../lib/replies.js";
import { NestCards } from "./NestCards.js";

const nests: NestData[] = [
    { ref: "n1", under: { listItemId: "m1", ref: "t3", text: "Standup" }, items: [ { id: "a", text: "Ana's ask" }, { id: "b", text: "Ben's ask" } ], because: "Put 2 answers under Standup? Ana and Ben are in it." }
];

describe("NestCards", () => {
    it("shows the sentence and the items, and Yes and Skip pick and clear", () => {
        const root = document.createElement("div");
        document.body.append(root);
        const update = vi.fn();
        const show = (answers: StepAnswers) => act(() => render(<NestCards items={nests} answers={answers} update={update} disabled={false} />, root));
        show({});
        expect(root.textContent).toContain("Put 2 answers under Standup? Ana and Ben are in it.");
        expect(root.textContent).toContain("Ana's ask");
        expect(root.textContent).toContain("Ben's ask");
        const chips = () => [ ...root.querySelectorAll<HTMLElement>(".chip") ];
        expect(chips().map((c) => c.textContent)).toEqual([ "Yes", "Skip" ]);

        act(() => chips()[0].click());
        expect(update).toHaveBeenLastCalledWith({ nests: { 0: "yes" } });
        show({ nests: { 0: "yes" } });
        act(() => chips()[0].click());
        expect(update).toHaveBeenLastCalledWith({ nests: { 0: null } });
        act(() => chips()[1].click());
        expect(update).toHaveBeenLastCalledWith({ nests: { 0: "skip" } });
        act(() => render(null, root));
        root.remove();
    });
});
