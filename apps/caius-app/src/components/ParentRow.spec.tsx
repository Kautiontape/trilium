// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PlanTask } from "../lib/caius.js";
import { held } from "../lib/store.js";
import { groupedRows, ParentRow } from "./ParentRow.js";
import { TaskRow } from "./TaskRow.js";

let root: HTMLElement;

function task(listItemId: string, text: string, rest: Partial<PlanTask> = {}): PlanTask {
    return {
        noteId: "day1", listItemId, text, state: "open", estMinutes: null, parent: null, parentListItemId: null,
        section: null, critical: false, area: "foundation", block: null, at: null, ...rest
    };
}

const sub = (id: string, rest: Partial<PlanTask> = {}) => task(id, `Step ${id}`, { parent: "Fix things", parentListItemId: "p", ...rest });

const row = (t: PlanTask, trailing?: preact.ComponentChildren) => <TaskRow key={t.listItemId} task={t} trailing={trailing} />;

function mount(parent: PlanTask, subs: PlanTask[]) {
    act(() => render(<ParentRow parent={parent} subs={subs} row={row} />, root));
}

const chevron = () => root.querySelector<HTMLButtonElement>(".parent-chevron");
const count = () => root.querySelector(".parent-count")?.textContent;
const rows = () => root.querySelectorAll(".task-row").length;

beforeEach(() => {
    localStorage.clear();
    held.value = {};
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

describe("ParentRow", () => {
    const parent = task("p", "Fix things");
    const subs = [ sub("a", { state: "done" }), sub("b"), sub("c", { state: "in_progress" }), sub("x", { state: "cancelled" }) ];

    it("folds to one row with done/total of its open, doing and done sub-items", () => {
        mount(parent, subs);
        expect(count()).toBe("1/3");
        expect(rows()).toBe(1);
        expect(chevron()?.getAttribute("aria-expanded")).toBe("false");
        expect(chevron()?.getAttribute("aria-label")).toBeTruthy();
    });

    it("opens its sub-items under the row with the chevron, and keeps that per device", () => {
        mount(parent, subs);
        act(() => chevron()?.click());
        expect(chevron()?.getAttribute("aria-expanded")).toBe("true");
        expect(rows()).toBe(5);
        expect(JSON.parse(localStorage.getItem("caius.openParents") ?? "[]")).toEqual([ "day1/p" ]);

        act(() => render(null, root));
        mount(parent, subs);
        expect(chevron()?.getAttribute("aria-expanded")).toBe("true");
        expect(rows()).toBe(5);

        act(() => chevron()?.click());
        expect(rows()).toBe(1);
        expect(JSON.parse(localStorage.getItem("caius.openParents") ?? "[]")).toEqual([]);
    });

    it("starts folded when the stored list cannot be read", () => {
        localStorage.setItem("caius.openParents", "{not json");
        mount(parent, subs);
        expect(rows()).toBe(1);
    });

    it("reads 'N open' when the parent is done and sub-items are still open", () => {
        mount({ ...parent, state: "done" }, [ sub("a", { state: "done" }), sub("b"), sub("c", { state: "in_progress" }) ]);
        expect(count()).toBe("2 open");
        act(() => render(null, root));
        held.value = { "day1/p": "done" };
        mount(parent, subs);
        expect(count()).toBe("2 open");
        act(() => render(null, root));
        mount({ ...parent, state: "done" }, [ sub("a", { state: "done" }) ]);
        expect(count()).toBe("1/1");
    });

    it("does not open the parent's sheet when the chevron is tapped", () => {
        let opened = 0;
        const open = (t: PlanTask, trailing?: preact.ComponentChildren) => <TaskRow key={t.listItemId} task={t} trailing={trailing} onOpen={() => opened++} />;
        act(() => render(<ParentRow parent={parent} subs={subs} row={open} />, root));
        act(() => chevron()?.click());
        expect(opened).toBe(0);
    });
});

describe("groupedRows", () => {
    it("renders a parent with its sub-items as one ParentRow and a sub-item without its parent as a plain row", () => {
        const list = [ task("p", "Fix things"), sub("a"), sub("b"), task("z", "Alone"), task("o", "Orphan step", { parent: "Gone", parentListItemId: "gone" }) ];
        act(() => render(<>{groupedRows(list, row)}</>, root));
        expect(root.querySelectorAll(".parent-chevron")).toHaveLength(1);
        expect(rows()).toBe(3);
        expect(root.textContent).toContain("Orphan step");
        expect(root.textContent).not.toContain("Step a");
    });
});
