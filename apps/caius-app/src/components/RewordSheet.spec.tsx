// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { caiusApi, type PlanTask } from "../lib/caius.js";
import { request } from "../lib/http.js";
import { connection, flushHeld, held, rewording, snack, taskKey, today } from "../lib/store.js";
import { RewordSheet } from "./RewordSheet.js";
import { TaskSheet } from "./sheets.js";
import { TaskRow } from "./TaskRow.js";

vi.mock("../lib/http.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../lib/http.js")>(),
    request: vi.fn()
}));

const conn = { url: "https://notes.example.com", token: "tok" };
const task = {
    noteId: "n1",
    listItemId: "li1",
    state: "open",
    text: "🌱 09:00 Review [ABC-12](https://jira.example.com/browse/ABC-12) notes",
    estMinutes: null
} as unknown as PlanTask;
const post = () => vi.mocked(request).mock.calls.filter(([ req ]) => req.url.endsWith("/etapi/caius/apply"));

let root: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(request).mockReset();
    vi.mocked(request).mockImplementation((req) => Promise.resolve(
        req.method === "POST"
            ? { status: 200, text: JSON.stringify({ results: [ { status: "updated" } ] }) }
            : { status: 404, text: "" }
    ));
    connection.value = conn;
    today.value = null;
    held.value = {};
    rewording.value = {};
    snack.value = null;
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(async () => {
    await act(() => flushHeld());
    act(() => render(null, root));
    root.remove();
    vi.useRealTimers();
});

function field() {
    const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(".reword-sheet .field");
    if (!input) {
        throw new Error("no field");
    }
    return input;
}

function save() {
    const button = [ ...root.querySelectorAll<HTMLButtonElement>("button") ].find((b) => b.textContent === "Save");
    if (!button) {
        throw new Error("no Save");
    }
    return button;
}

function type(value: string) {
    act(() => {
        const input = field();
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

describe("RewordSheet", () => {
    it("holds only the words, and disables Save for empty or unchanged words", () => {
        act(() => render(<RewordSheet task={task} />, root));
        expect(field().value).toBe("Review ABC-12 notes");
        expect(save().disabled).toBe(true);
        type("   ");
        expect(save().disabled).toBe(true);
        type("Review ABC-12 notes properly");
        expect(save().disabled).toBe(false);
    });

    it("shows the new words on a live row during the hold, then sends one reword", async () => {
        act(() => render(<><RewordSheet task={task} /><TaskRow task={task} /></>, root));
        type("Review ABC-12 notes properly");
        act(() => save().click());

        expect(rewording.value[taskKey(task)]).toBe("Review ABC-12 notes properly");
        expect(held.value).toEqual({});
        expect(snack.value?.text).toBe("Edited: Review ABC-12 notes properly");
        const row = root.querySelector(".task-row");
        expect(row?.textContent).toContain("Review ABC-12 notes properly");
        expect(row?.className).toContain("state-open");
        expect(post()).toHaveLength(0);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4100);
        });
        expect(post()).toHaveLength(1);
        expect(post()[0][0]).toMatchObject({
            url: "https://notes.example.com/etapi/caius/apply",
            json: { rewords: [ { noteId: "n1", listItemId: "li1", text: "Review ABC-12 notes properly" } ] }
        });
        expect(rewording.value).toEqual({});
    });

    it("sends nothing on Undo and clears the words", async () => {
        act(() => render(<RewordSheet task={task} />, root));
        type("Something else");
        act(() => save().click());
        act(() => snack.value?.action?.run());
        expect(rewording.value).toEqual({});
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(post()).toHaveLength(0);
    });
});

describe("caiusApi reword", () => {
    it("posts the items as JSON with the token, and throws on a non-200", async () => {
        const items = [ { noteId: "n1", listItemId: "li1", text: "New words" } ];
        await expect(caiusApi(conn).reword(items)).resolves.toEqual({ results: [ { status: "updated" } ] });
        expect(vi.mocked(request)).toHaveBeenCalledWith({
            method: "POST",
            url: "https://notes.example.com/etapi/caius/apply",
            headers: { Authorization: "Bearer tok" },
            json: { rewords: items }
        });
        vi.mocked(request).mockResolvedValueOnce({ status: 400, text: "bad" });
        await expect(caiusApi(conn).reword(items)).rejects.toMatchObject({ status: 400 });
    });
});

describe("TaskSheet Edit", () => {
    const labels = (t: PlanTask, suggested = false) => {
        act(() => render(<TaskSheet task={t} suggested={suggested} />, root));
        return [ ...root.querySelectorAll(".sheet-action-label") ].map((e) => e.textContent);
    };

    it("is offered for an open and a done task, not for a suggestion or a cancelled one", () => {
        expect(labels(task)).toContain("Edit");
        expect(labels({ ...task, state: "done" } as PlanTask)).toContain("Edit");
        expect(labels(task, true)).not.toContain("Edit");
        expect(labels({ ...task, state: "cancelled" } as PlanTask)).not.toContain("Edit");
    });
});
