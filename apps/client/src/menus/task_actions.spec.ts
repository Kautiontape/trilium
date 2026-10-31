import { ClassicEditor, Essentials, Heading, List, Paragraph, TodoList } from "ckeditor5";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    notes: {} as Record<string, unknown>,
    caiusWrite: vi.fn(),
    api: {
        setState: vi.fn(async () => []),
        forward: vi.fn(async () => []),
        accept: vi.fn(async () => []),
        dismiss: vi.fn(async () => []),
        explain: vi.fn()
    },
    isCaiusEnabled: vi.fn(async () => true),
    openPeriodNoteIds: vi.fn((key: string) => (key === "2026-10-28" ? [ "tomorrow" ] : [])),
    wasCaiusEnabled: vi.fn(() => true),
    startCaiusConversation: vi.fn(async () => {}),
    prompt: vi.fn(),
    showMessage: vi.fn(),
    showError: vi.fn(),
    tabManager: {
        getNoteContexts: vi.fn(() => [] as unknown[]),
        getActiveContext: vi.fn(() => null as unknown)
    }
}));

vi.mock("../components/app_context.js", () => ({ default: { tabManager: h.tabManager } }));
vi.mock("../services/froca.js", () => ({ default: { notes: h.notes } }));
vi.mock("../services/caius.js", () => ({
    caiusNow: () => new Date(),
    startCaiusConversation: h.startCaiusConversation,
    caiusApi: h.api,
    caiusWrite: h.caiusWrite,
    describeSkip: (reason: string) => `skip:${reason}`,
    findOpenEditors: () => [],
    flushEditors: vi.fn(),
    forgetCaiusStatus: vi.fn(),
    isCaiusEnabled: h.isCaiusEnabled,
    openPeriodNoteIds: h.openPeriodNoteIds,
    wasCaiusEnabled: h.wasCaiusEnabled
}));
vi.mock("../services/dialog.js", () => ({ default: { prompt: h.prompt } }));
vi.mock("../services/toast.js", () => ({ default: { showMessage: h.showMessage, showError: h.showError } }));
vi.mock("../services/i18n.js", () => ({ t: (key: string) => key }));

import type { CKTextEditor } from "@triliumnext/ckeditor5";

import type { CommandNames } from "../components/app_context.js";
import type FNote from "../entities/fnote.js";
import { setEditorNoteId } from "../widgets/react/NoteStore.js";
import type { MenuCommandItem, MenuItem } from "./context_menu.js";
import {
    buildTaskActionItems, buildTaskActionsMenuItem, findTaskAtElement, findTaskAtSelection,
    isForwardKey, isJournalNote, isOverJournalTask, nextMonthKey, nextWeekKey, runDayCommand, runTaskCommand,
    type TaskTarget, tomorrowKey
} from "./task_actions.js";

/** A note stand-in carrying `labels`, under parents carrying theirs. */
function fakeNote(labels: string[], parents: FNote[] = []) {
    return {
        hasOwnedLabel: (name: string) => labels.includes(name),
        getParentNotes: () => parents
    } as unknown as FNote;
}

/** Titles of `items`, with a submenu as `[title, [children]]` and a separator as `"--"`. */
function outline(items: MenuItem<CommandNames>[]): unknown[] {
    return items.map((item) => {
        if ("kind" in item) return item.kind === "separator" ? "--" : item.kind;
        return item.items ? [ item.title, outline(item.items) ] : item.title;
    });
}

function findItem(items: MenuItem<CommandNames>[], ...path: string[]): MenuCommandItem<CommandNames> {
    const [ title, ...rest ] = path;
    const item = items.find((candidate) => "title" in candidate && candidate.title === title) as MenuCommandItem<CommandNames> | undefined;
    if (!item) throw new Error(`No item ${title}`);
    return rest.length ? findItem(item.items ?? [], ...rest) : item;
}

const click = (item: MenuCommandItem<CommandNames>) => item.handler?.(item, {} as never);

function target(overrides: Partial<TaskTarget> = {}): TaskTarget {
    return { noteId: "day", listItemId: "eaaa", state: "open", inSuggested: false, headers: [ "Morning", "Work" ], ...overrides };
}

const STATE_ACTIONS = [ "caius.doing", "caius.done", [ "caius.forward", [
    "caius.forward_tomorrow", "caius.forward_next_week", "caius.forward_next_month", "--", "caius.forward_pick"
] ], "caius.drop" ];

describe("buildTaskActionItems", () => {
    it("offers the state actions that still apply to a live task", () => {
        expect(outline(buildTaskActionItems(target()))).toEqual([ ...STATE_ACTIONS, "--", "caius.explain" ]);
        expect(outline(buildTaskActionItems(target({ state: "doing" })))).toEqual([
            ...STATE_ACTIONS.slice(1), "--", "caius.explain"
        ]);
    });

    it("offers no state action on a closed task", () => {
        for (const state of [ "done", "cancelled", "rescheduled", "other" ] as const) {
            expect(outline(buildTaskActionItems(target({ state })))).toEqual([ "caius.explain" ]);
        }
    });

    it("offers Accept into each heading or Critical, and Dismiss, under Suggested", () => {
        expect(outline(buildTaskActionItems(target({ inSuggested: true })))).toEqual([
            ...STATE_ACTIONS, "--",
            [ "caius.accept", [ "Morning", "Work", "--", "caius.accept_critical" ] ], "caius.dismiss",
            "--", "caius.explain"
        ]);
        expect(outline(buildTaskActionItems(target({ inSuggested: true, headers: [], state: "done" })))).toEqual([
            [ "caius.accept", [ "caius.accept_critical" ] ], "caius.dismiss", "--", "caius.explain"
        ]);
    });

    describe("actions", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            // Runs the request the way `caiusWrite` would, with a known blobId.
            h.caiusWrite.mockImplementation(async (_noteId: string, call: (blobId: string) => Promise<unknown>) => call("blob1"));
        });

        it("writes through caiusWrite with the expected blobId", async () => {
            await click(findItem(buildTaskActionItems(target()), "caius.done"));
            expect(h.caiusWrite).toHaveBeenCalledWith("day", expect.any(Function), "caius.set_done");
            expect(h.api.setState).toHaveBeenCalledWith([
                { noteId: "day", listItemId: "eaaa", state: "done", reason: undefined, expectedBlobId: "blob1" }
            ]);

            await click(findItem(buildTaskActionItems(target({ inSuggested: true })), "caius.accept", "Work"));
            expect(h.api.accept).toHaveBeenCalledWith([
                { noteId: "day", listItemId: "eaaa", section: "Work", expectedBlobId: "blob1" }
            ]);

            await click(findItem(buildTaskActionItems(target({ inSuggested: true })), "caius.accept", "caius.accept_critical"));
            expect(h.api.accept).toHaveBeenLastCalledWith([
                { noteId: "day", listItemId: "eaaa", critical: true, expectedBlobId: "blob1" }
            ]);
        });

        it("forwards to tomorrow, or to a picked day, week or month", async () => {
            vi.useFakeTimers({ toFake: [ "Date" ] });
            vi.setSystemTime(new Date(2026, 9, 27, 23, 30));
            try {
                await click(findItem(buildTaskActionItems(target()), "caius.forward", "caius.forward_tomorrow"));
                expect(h.api.forward).toHaveBeenLastCalledWith([
                    { noteId: "day", listItemId: "eaaa", to: "2026-10-28", expectedBlobId: "blob1" }
                ]);
                // Tomorrow's day note is open, so its editor is locked and saved too.
                expect(h.caiusWrite).toHaveBeenLastCalledWith(
                    "day", expect.any(Function), "caius.forwarded", { alsoLock: [ "tomorrow" ] });

                h.prompt.mockResolvedValueOnce(" 2026-W45 ");
                await click(findItem(buildTaskActionItems(target()), "caius.forward", "caius.forward_pick"));
                expect(h.prompt).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: "2026-10-28" }));
                expect(h.api.forward).toHaveBeenLastCalledWith([ expect.objectContaining({ to: "2026-W45" }) ]);
                expect(h.caiusWrite).toHaveBeenLastCalledWith(
                    "day", expect.any(Function), "caius.forwarded", { alsoLock: [] });

                h.prompt.mockResolvedValueOnce("next tuesday");
                await click(findItem(buildTaskActionItems(target()), "caius.forward", "caius.forward_pick"));
                expect(h.showError).toHaveBeenCalledWith("caius.forward_pick_invalid");
                expect(h.api.forward).toHaveBeenCalledTimes(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it("drops only with a reason", async () => {
            const drop = findItem(buildTaskActionItems(target()), "caius.drop");

            h.prompt.mockResolvedValueOnce(null);
            await click(drop);
            h.prompt.mockResolvedValueOnce("   ");
            await click(drop);
            expect(h.caiusWrite).not.toHaveBeenCalled();
            expect(h.showError).toHaveBeenCalledWith("caius.drop_reason_required");

            h.prompt.mockResolvedValueOnce(" not needed ");
            await click(drop);
            expect(h.api.setState).toHaveBeenCalledWith([
                { noteId: "day", listItemId: "eaaa", state: "cancelled", reason: "not needed", expectedBlobId: "blob1" }
            ]);
        });

        it("explains, saying to save first when the item is not found", async () => {
            h.api.explain.mockResolvedValueOnce({
                lane: "overdue", rule: "r1", source: "past day 2026-10-20 vs now", daysLate: 7,
                summary: "Overdue by 7 days: it's in the day note for Tuesday 20 October, which is past."
            });
            await click(findItem(buildTaskActionItems(target()), "caius.explain"));
            expect(h.api.explain).toHaveBeenCalledWith("day", "eaaa");
            expect(h.showMessage).toHaveBeenCalledWith(
                "Overdue by 7 days: it's in the day note for Tuesday 20 October, which is past.",
                10_000, "bx bx-help-circle"
            );

            h.api.explain.mockResolvedValueOnce({ error: "not_found" });
            await click(findItem(buildTaskActionItems(target()), "caius.explain"));
            expect(h.showMessage).toHaveBeenLastCalledWith("skip:not_found", 5000, "bx bx-info-circle");
        });
    });
});

describe("reading the task from the editor", () => {
    let editor: ClassicEditor;
    let domRoot: HTMLElement;

    const content = [
        "<h2>Morning</h2>",
        "<ul class=\"todo-list\">",
        "<li data-list-item-id=\"eopen\"><label class=\"todo-list__label\"><input type=\"checkbox\" disabled><span class=\"todo-list__label__description\">open task</span></label></li>",
        "<li data-list-item-id=\"edone\"><label class=\"todo-list__label\"><input type=\"checkbox\" checked disabled><span class=\"todo-list__label__description\">done task</span></label></li>",
        "</ul>",
        "<h2>Suggested</h2>",
        "<ul class=\"todo-list\">",
        "<li data-list-item-id=\"esugg\"><label class=\"todo-list__label\"><input type=\"checkbox\" disabled><span class=\"todo-list__label__description\">suggested</span></label>",
        "<ul class=\"todo-list\"><li data-list-item-id=\"enest\"><label class=\"todo-list__label\"><input type=\"checkbox\" disabled><span class=\"todo-list__label__description\">nested</span></label></li></ul>",
        "</li></ul>",
        "<ul><li data-list-item-id=\"ebull\">bullet</li></ul>",
        "<p>plain</p>"
    ].join("");

    beforeAll(async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await ClassicEditor.create(el, {
            plugins: [ Essentials, Paragraph, Heading, List, TodoList ],
            licenseKey: "GPL",
            taskStates: [
                { name: "doing", title: "Doing", markdownSymbol: "/", isCompleted: false, icon: "bx" },
                { name: "_rescheduled", title: "Rescheduled", markdownSymbol: ">", isCompleted: true, icon: "bx" }
            ]
        } as never);
        editor.model.schema.extend("$block", { allowAttributes: "taskState" });
        const root = editor.editing.view.getDomRoot();
        if (!root) throw new Error("No DOM root");
        domRoot = root;
        setEditorNoteId(editor, "day");
    });

    afterAll(async () => {
        await editor.destroy();
    });

    beforeEach(() => {
        editor.setData(content);
        h.notes.day = fakeNote([ "dateNote" ]);
        h.wasCaiusEnabled.mockReturnValue(true);
    });

    const item = (id: string) => {
        const li = domRoot.querySelector(`li[data-list-item-id="${id}"]`);
        if (!li) throw new Error(`No item ${id}`);
        return li;
    };

    function blockOf(id: string) {
        const root = editor.model.document.getRoot();
        const block = root && Array.from(root.getChildren()).find((child) =>
            child.is("element") && child.getAttribute("listItemId") === id);
        if (!block?.is("element")) throw new Error(`No block ${id}`);
        return block;
    }

    it("maps a click anywhere in a todo item to that item", () => {
        const description = item("eopen").querySelector(".todo-list__label__description");
        const checkbox = item("edone").querySelector("input");
        const nestedText = item("enest").querySelector(".todo-list__label__description")?.firstChild?.parentElement;
        if (!description || !checkbox || !nestedText) throw new Error("Missing DOM");

        expect(findTaskAtElement(description)).toEqual({
            noteId: "day", listItemId: "eopen", state: "open", inSuggested: false, headers: [ "Morning" ]
        });
        expect(findTaskAtElement(checkbox)).toMatchObject({ listItemId: "edone", state: "done" });
        expect(findTaskAtElement(item("esugg"))).toMatchObject({ listItemId: "esugg", inSuggested: true });
        expect(findTaskAtElement(nestedText)).toMatchObject({ listItemId: "enest", inSuggested: true });
    });

    it("ignores bulleted items, paragraphs, a locked editor and notes outside the Journal", () => {
        const paragraph = domRoot.querySelector("p:last-child");
        if (!paragraph) throw new Error("No paragraph");

        expect(findTaskAtElement(item("ebull"))).toBeNull();
        expect(findTaskAtElement(paragraph)).toBeNull();
        expect(isOverJournalTask(paragraph)).toBe(false);
        expect(isOverJournalTask(item("eopen"))).toBe(true);

        editor.enableReadOnlyMode("test");
        expect(findTaskAtElement(item("eopen"))).toBeNull();
        editor.disableReadOnlyMode("test");

        // A failed status probe is asked again from a right-click on a task, and only there.
        h.wasCaiusEnabled.mockReturnValue(false);
        h.isCaiusEnabled.mockClear();
        expect(isOverJournalTask(paragraph)).toBe(false);
        expect(h.isCaiusEnabled).not.toHaveBeenCalled();
        expect(isOverJournalTask(item("eopen"))).toBe(false);
        expect(h.isCaiusEnabled).toHaveBeenCalled();
        h.wasCaiusEnabled.mockReturnValue(true);

        h.notes.day = fakeNote([]);
        expect(findTaskAtElement(item("eopen"))).toBeNull();
    });

    it("offers a heading with odd spacing as a section the server matches, and skips an emoji Suggested", async () => {
        editor.setData([
            "<h2>  Deep&nbsp;&nbsp; Work </h2>",
            "<h2>💡 Suggested</h2>",
            "<ul class=\"todo-list\"><li data-list-item-id=\"eodd\"><label class=\"todo-list__label\"><input type=\"checkbox\" disabled><span class=\"todo-list__label__description\">idea</span></label></li></ul>"
        ].join(""));
        const found = findTaskAtElement(item("eodd"));
        expect(found).toMatchObject({ inSuggested: true });
        expect(found?.headers).toHaveLength(1);
        if (!found) throw new Error("No task");

        const heading = found.headers[0] ?? "";
        h.caiusWrite.mockImplementation(async (_noteId: string, call: (blobId: string) => Promise<unknown>) => call("blob1"));
        h.api.accept.mockClear();
        await click(findItem(buildTaskActionItems(found), "caius.accept", heading));
        const [ [ [ sent ] ] ] = h.api.accept.mock.calls as unknown as [ [ [ { section: string } ] ] ];
        expect(sent.section).toBe(heading);
        // The library's `normName()`: case and anything but letters and digits are ignored.
        expect(sent.section.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase()).toBe("deepwork");
    });

    it("reads custom states through their markdown symbol", () => {
        editor.model.change((writer) => {
            writer.setAttribute("taskState", "doing", blockOf("eopen"));
            writer.setAttribute("taskState", "_rescheduled", blockOf("esugg"));
        });

        expect(findTaskAtElement(item("eopen"))).toMatchObject({ state: "doing" });
        expect(findTaskAtElement(item("esugg"))).toMatchObject({ state: "rescheduled" });
    });

    it("reads the item at the caret", () => {
        editor.model.change((writer) => writer.setSelection(blockOf("enest"), 2));
        expect(findTaskAtSelection(editor as unknown as CKTextEditor)).toMatchObject({ listItemId: "enest", inSuggested: true });

        editor.enableReadOnlyMode("caius-write");
        expect(findTaskAtSelection(editor as unknown as CKTextEditor)).toBeNull();
        editor.disableReadOnlyMode("caius-write");

        editor.model.change((writer) => writer.setSelection(blockOf("ebull"), 0));
        expect(findTaskAtSelection(editor as unknown as CKTextEditor)).toBeNull();
    });

    it("builds the Task submenu only while Caius is on", async () => {
        await expect(buildTaskActionsMenuItem(item("eopen"))).resolves.toMatchObject({ title: "caius.task" });

        h.isCaiusEnabled.mockResolvedValueOnce(false);
        await expect(buildTaskActionsMenuItem(item("eopen"))).resolves.toBeNull();
    });

    describe("runTaskCommand", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            h.caiusWrite.mockImplementation(async (_noteId: string, call: (blobId: string) => Promise<unknown>) => call("blob1"));
            const context = { ntxId: "ntx1", note: { type: "text" }, getTextEditor: async () => editor };
            h.tabManager.getNoteContexts.mockReturnValue([ context ]);
        });

        it("acts on the item at the caret", async () => {
            editor.model.change((writer) => writer.setSelection(blockOf("eopen"), 1));
            await runTaskCommand("done", "ntx1");
            expect(h.api.setState).toHaveBeenCalledWith([ expect.objectContaining({ listItemId: "eopen", state: "done" }) ]);
        });

        it("does nothing but say why when Caius is off or the caret is not on a task", async () => {
            h.isCaiusEnabled.mockResolvedValueOnce(false);
            await runTaskCommand("done", "ntx1");
            expect(h.showMessage).toHaveBeenLastCalledWith("caius.disabled", 3000, "bx bx-info-circle");

            editor.model.change((writer) => writer.setSelection(blockOf("ebull"), 0));
            await runTaskCommand("doing", "ntx1");
            expect(h.showMessage).toHaveBeenLastCalledWith("caius.no_task_at_caret", 3000, "bx bx-info-circle");
            expect(h.caiusWrite).not.toHaveBeenCalled();
        });
    });
});

describe("isJournalNote", () => {
    it("accepts a day, week or month note and their children", () => {
        expect(isJournalNote(fakeNote([ "dateNote" ]))).toBe(true);
        expect(isJournalNote(fakeNote([ "weekNote" ]))).toBe(true);
        expect(isJournalNote(fakeNote([], [ fakeNote([ "monthNote" ]) ]))).toBe(true);
        expect(isJournalNote(fakeNote([ "yearNote" ], [ fakeNote([]) ]))).toBe(false);
    });
});

describe("forward keys", () => {
    it("computes tomorrow, next week and next month in local time", () => {
        expect(tomorrowKey(new Date(2026, 11, 31, 23, 59))).toBe("2027-01-01");
        expect(tomorrowKey(new Date(2026, 1, 28, 0, 1))).toBe("2026-03-01");

        // The week of Monday 2024-12-30 belongs to 2025, whose first Thursday it holds.
        expect(nextWeekKey(new Date(2024, 11, 23))).toBe("2025-W01");
        expect(nextWeekKey(new Date(2026, 11, 27))).toBe("2026-W53");
        expect(nextWeekKey(new Date(2027, 0, 1))).toBe("2027-W01");
        expect(nextWeekKey(new Date(2026, 9, 27))).toBe("2026-W45");

        expect(nextMonthKey(new Date(2026, 11, 15))).toBe("2027-01");
        expect(nextMonthKey(new Date(2026, 0, 31))).toBe("2026-02");
    });

    it("recognizes a day, an ISO week or a month", () => {
        for (const key of [ "2026-10-28", "2026-W01", "2026-W53", "2026-11" ]) {
            expect(isForwardKey(key)).toBe(true);
        }
        for (const key of [ "2026-13", "2026-W54", "2026-W00", "2026-10-32", "26-10-28", "tomorrow" ]) {
            expect(isForwardKey(key)).toBe(false);
        }
    });
});

describe("runDayCommand", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: [ "Date" ] });
        vi.setSystemTime(new Date(2026, 10, 4, 9, 0));
    });
    afterEach(() => vi.useRealTimers());

    it("starts the conversation for today by the Caius clock, or toasts while Caius is off", async () => {
        await runDayCommand("plan");
        expect(h.startCaiusConversation).toHaveBeenLastCalledWith("Plan my day 2026-11-04");
        await runDayCommand("winddown");
        expect(h.startCaiusConversation).toHaveBeenLastCalledWith("Wind down 2026-11-04");

        h.isCaiusEnabled.mockResolvedValueOnce(false);
        await runDayCommand("plan");
        expect(h.showMessage).toHaveBeenCalledWith("caius.disabled", 3000, "bx bx-info-circle");
        expect(h.startCaiusConversation).toHaveBeenCalledTimes(2);
    });
});
