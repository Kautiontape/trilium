// @vitest-environment happy-dom
import { dayLoad } from "@triliumnext/caius/src/daily/load.js";
import type { DayViewData, ViewTask } from "@triliumnext/caius/src/daily/views.js";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DayView } from "./DayView.js";

let root: HTMLElement;

function row(listItemId: string, text: string, rest: Partial<ViewTask> = {}): ViewTask {
    return {
        noteId: "day1", listItemId, ref: `v${listItemId}`, text, state: "open", estMinutes: 20, parent: null, parentListItemId: null,
        section: null, critical: false, area: "foundation", block: null, at: null, period: { kind: "day", key: "2026-11-03" },
        place: "list", slips: 0, ...rest
    };
}

beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

describe("DayView", () => {
    it("lists a parent and its open sub-item, and not the closed sub-item sent for the recount", () => {
        const data: DayViewData = {
            date: "2026-11-03", dateLabel: "Tue 3 Nov", openOn: null, calendarFailed: false,
            load: dayLoad({ foundation: 20, onDeck: 0, growth: 0, recharge: 0 }, { focus: { min: 180, max: 240 }, growthTarget: { min: 30, max: 60 } }),
            capacity: { windowMinutes: 480, bookedMinutes: 0, openMinutes: 480 },
            span: { start: "09:00", noon: "12:00", workEnd: "17:00", end: "23:00" },
            meetings: [], meetingLines: [], drawn: null, unplacedMinutes: 0, context: [],
            tasks: [
                row("rv", "Review the draft", { estMinutes: null }),
                row("a", "Read the intro", { state: "done", hidden: true, parent: "Review the draft", parentListItemId: "rv" }),
                row("b", "Check the figures", { parent: "Review the draft", parentListItemId: "rv" })
            ]
        };
        act(() => render(<DayView data={data} answers={{}} />, root));
        expect(root.textContent).toContain("Check the figures");
        expect(root.textContent).toContain("Review the draft");
        expect(root.textContent).not.toContain("Read the intro");
    });
});
