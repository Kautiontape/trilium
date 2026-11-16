// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanTask } from "../lib/caius.js";
import { callTool } from "../lib/mcp.js";
import { connection, flushHeld, held, refreshing, snack } from "../lib/store.js";
import { markDone } from "./sheets.js";

vi.mock("../lib/mcp.js", () => ({ callTool: vi.fn() }));

function task(listItemId: string, text: string): PlanTask {
    return {
        noteId: "day1", listItemId, text, state: "open", estMinutes: null, parent: null, parentListItemId: null,
        section: "Tasks", critical: false, area: "foundation", block: null, at: null
    };
}

describe("markDone's parent toast", () => {
    beforeEach(() => {
        connection.value = { url: "https://caius.example", token: "t" };
        refreshing.value = true;
        vi.mocked(callTool).mockReset();
    });

    afterEach(() => {
        connection.value = null;
        refreshing.value = false;
        snack.value = null;
        held.value = {};
    });

    it("offers to tick the parent after the last sub-item's tick, and ticks it only on the tap", async () => {
        vi.mocked(callTool).mockResolvedValue({ results: [ { status: "updated", parentComplete: { noteId: "day1", listItemId: "p", text: "Prepare the standup notes for Monday morning" } } ] });
        markDone(task("a", "Step a"));
        expect(snack.value?.action?.label).toBe("Undo");

        await flushHeld();
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(snack.value?.action?.label).toBe("Mark Prepare the standup not… done");

        snack.value?.action?.run();
        await flushHeld();
        expect(callTool).toHaveBeenCalledTimes(2);
        expect(callTool).toHaveBeenLastCalledWith(expect.anything(), "caius_set_state", { items: [ { noteId: "day1", listItemId: "p", state: "done" } ] });
    });

    it("shows no toast when the result has no parentComplete", async () => {
        vi.mocked(callTool).mockResolvedValue({ results: [ { status: "updated" } ] });
        markDone(task("a", "Step a"));
        await flushHeld();
        expect(snack.value).toBeNull();
    });
});
