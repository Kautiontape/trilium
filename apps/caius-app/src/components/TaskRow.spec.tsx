// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlanTask } from "../lib/caius.js";
import { held } from "../lib/store.js";
import { TaskRow } from "./TaskRow.js";

let root: HTMLElement;

function task(rest: Partial<PlanTask> = {}): PlanTask {
    return {
        noteId: "day1", listItemId: "a", text: "Pair on the seed data _scheduled [Tue 3 Nov](#root/abc123)_",
        state: "open", estMinutes: null, parent: null, parentListItemId: null,
        section: null, critical: false, area: "foundation", block: null, at: null, ...rest
    };
}

beforeEach(() => {
    held.value = {};
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

describe("TaskRow's forwarded detail", () => {
    it("says Forwarded only for a moved task, and strips the marker in every state", () => {
        act(() => render(<TaskRow task={task({ state: "tombstone" })} detail="Open detail" />, root));
        expect(root.querySelector(".task-row-detail")?.textContent).toBe("Forwarded → Tue 3 Nov");
        expect(root.querySelector(".task-row-text")?.textContent).toBe("Pair on the seed data");

        act(() => render(<TaskRow task={task({ state: "open" })} detail="Open detail" />, root));
        expect(root.textContent).not.toContain("Forwarded");
        expect(root.querySelector(".task-row-detail")?.textContent).toBe("Open detail");
        expect(root.querySelector(".task-row-text")?.textContent).toBe("Pair on the seed data");
    });
});
