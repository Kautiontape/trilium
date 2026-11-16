// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import type { PlanTask } from "../lib/caius.js";
import { held, today, type TodayData } from "../lib/store.js";
import { Today } from "./Today.js";

function task(listItemId: string, text: string, rest: Partial<PlanTask> = {}): PlanTask {
    return {
        noteId: "day1", listItemId, text, state: "open", estMinutes: null, parent: null, parentListItemId: null,
        section: "Tasks", critical: false, area: "foundation", block: null, at: null, ...rest
    };
}

describe("Today", () => {
    afterEach(() => {
        today.value = null;
        held.value = {};
    });

    it("renders a section's parent as one folded row with its count", () => {
        const tasks = [
            task("p", "Fix things", { estMinutes: 15 }),
            task("a", "Step a", { parent: "Fix things", parentListItemId: "p", state: "done" }),
            task("b", "Step b", { parent: "Fix things", parentListItemId: "p" }),
            task("z", "Alone")
        ];
        today.value = {
            key: "2026-11-16", label: "Mon 16 Nov", asOf: "2026-11-16T09:00:00", offline: false, nudge: null, catchup: null,
            rhythm: { start: "09:00", end: "23:00", workEnd: "18:00" },
            plan: {
                critical: [], top3: [], onDeck: [], suggested: [], context: [], meetings: [], capacity: { totalMinutes: 0, unestimatedCount: 0, onDeckMinutes: 0 },
                sections: [ { name: "Tasks", kind: "tasks", tasks } ], drawn: null
            }
        } as unknown as TodayData;
        const root = document.createElement("div");
        document.body.append(root);
        act(() => render(<Today />, root));
        expect(root.querySelectorAll(".list-group .parent-chevron")).toHaveLength(1);
        expect(root.querySelector(".list-group .parent-count")?.textContent).toBe("1/2");
        expect(root.querySelectorAll(".list-group .task-row")).toHaveLength(2);
        expect(root.querySelector(".list-group")?.textContent).not.toContain("Step a");
        act(() => render(null, root));
        root.remove();
    });
});
