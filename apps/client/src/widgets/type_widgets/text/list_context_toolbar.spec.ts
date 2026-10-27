import type { ClassicEditor } from "@triliumnext/ckeditor5";
import {
    ButtonView, ClassicEditor as RealClassicEditor, Essentials, Heading, Indent, List, Paragraph,
    TodoList
} from "ckeditor5";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    notes: {} as Record<string, unknown>,
    isCaiusEnabled: vi.fn(async () => true),
    show: vi.fn()
}));

vi.mock("@triliumnext/ckeditor5", () => ({ ButtonView }));
vi.mock("../../../components/app_context.js", () => ({ default: {} }));
vi.mock("../../../menus/context_menu.js", () => ({ default: { show: h.show } }));
vi.mock("../../../services/froca.js", () => ({ default: { notes: h.notes } }));
vi.mock("../../../services/caius.js", () => ({
    caiusApi: {},
    caiusWrite: vi.fn(),
    describeSkip: vi.fn(),
    findOpenEditors: () => [],
    flushEditors: vi.fn(),
    forgetCaiusStatus: vi.fn(),
    isCaiusEnabled: h.isCaiusEnabled,
    wasCaiusEnabled: () => true
}));
vi.mock("../../../services/dialog.js", () => ({ default: {} }));
vi.mock("../../../services/toast.js", () => ({ default: {} }));
vi.mock("../../../services/i18n.js", () => ({ t: (key: string) => key }));

import type { CommandNames } from "../../../components/app_context.js";
import type { MenuItem } from "../../../menus/context_menu.js";
import { buildTaskActionItems, findTaskAtSelection } from "../../../menus/task_actions.js";
import { setEditorNoteId } from "../../react/NoteStore.js";
import {
    attachListContextToolbar, createTaskToolbarButton, isSelectionInList, isSelectionInTodo,
    LIST_CONTEXT_PINNED_CLASS, type TaskToolbarButton
} from "./list_context_toolbar.js";

interface FakeView {
    name: string;
    classes: string[];
    destroyed: boolean;
    extendTemplate(definition: { attributes: { class: string[] } }): void;
    destroy(): void;
}

function makeView(name: string): FakeView {
    return {
        name,
        classes: [],
        destroyed: false,
        extendTemplate(definition) {
            this.classes.push(...definition.attributes.class);
        },
        destroy() {
            this.destroyed = true;
        }
    };
}

function block(inList: boolean, listType = "bulleted") {
    return {
        hasAttribute: (name: string) => name === "listItemId" && inList,
        getAttribute: (name: string) => (name === "listType" && inList ? listType : undefined)
    };
}

/**
 * The slice of an editor the controller touches: an array-backed toolbar collection, a component
 * factory handing out fresh views, and a document whose `change` event the test fires by hand.
 */
function fakeEditor(initialItems: string[], isAvailable: (name: string) => boolean = () => true) {
    const items: FakeView[] = initialItems.map(makeView);
    const listeners: (() => void)[] = [];
    let blocks = [block(false)];
    const editor = {
        state: "ready",
        ui: {
            componentFactory: { has: isAvailable, create: makeView },
            view: {
                toolbar: {
                    items: {
                        add(view: FakeView, index: number = items.length) {
                            items.splice(index, 0, view);
                        },
                        remove(view: FakeView) {
                            const index = items.indexOf(view);
                            if (index >= 0) {
                                items.splice(index, 1);
                            }
                        }
                    }
                }
            }
        },
        model: {
            document: {
                on(event: string, callback: () => void) {
                    if (event === "change") listeners.push(callback);
                },
                off(event: string, callback: () => void) {
                    if (event === "change") listeners.splice(listeners.indexOf(callback), 1);
                },
                selection: { getSelectedBlocks: () => blocks[Symbol.iterator]() }
            }
        }
    };
    return {
        editor,
        asEditor: editor as unknown as ClassicEditor,
        names: () => items.map((view) => view.name),
        items,
        listenerCount: () => listeners.length,
        /** Moves the caret into or out of a list and fires the document's `change`. */
        setInList(inList: boolean) {
            blocks = [block(inList)];
            for (const callback of [...listeners]) callback();
        }
    };
}

describe("isSelectionInList", () => {
    it("is true when any selected block is a list item, of whichever list type", () => {
        const selection = (blocks: ReturnType<typeof block>[]) => ({
            getSelectedBlocks: () => blocks[Symbol.iterator]()
        });
        expect(isSelectionInList(selection([]))).toBe(false);
        expect(isSelectionInList(selection([block(false), block(false)]))).toBe(false);
        expect(isSelectionInList(selection([block(false), block(true)]))).toBe(true);
    });
});

describe("isSelectionInTodo", () => {
    it("is true only when the first selected block is a todo item", () => {
        const selection = (blocks: ReturnType<typeof block>[]) => ({
            getSelectedBlocks: () => blocks[Symbol.iterator]()
        });
        expect(isSelectionInTodo(selection([]))).toBe(false);
        expect(isSelectionInTodo(selection([block(true)]))).toBe(false);
        expect(isSelectionInTodo(selection([block(false), block(true, "todo")]))).toBe(false);
        expect(isSelectionInTodo(selection([block(true, "todo"), block(false)]))).toBe(true);
    });
});

describe("attachListContextToolbar", () => {
    const TOOLBAR = [
        "heading", "bold", "|", "bulletedList", "todoList", "|", "outdent", "indent", "undo"
    ];

    it("pins outdent and indent to the front while the caret is in a list, and restores the bar when it leaves", () => {
        const fake = fakeEditor(TOOLBAR);
        const onPinned = vi.fn();
        attachListContextToolbar(fake.asEditor, { onPinned });

        // Prose: the bar is untouched, but the controller is listening.
        expect(fake.names()).toEqual(TOOLBAR);
        expect(fake.listenerCount()).toBe(1);
        expect(onPinned).not.toHaveBeenCalled();

        fake.setInList(true);
        expect(fake.names()).toEqual(["outdent", "indent", ...TOOLBAR]);
        expect(onPinned).toHaveBeenCalledTimes(1);
        // The pinned views carry the class the stylesheet keys off, set before their first render.
        const [pinnedOutdent, pinnedIndent] = [fake.items[0], fake.items[1]];
        expect(pinnedOutdent.classes).toEqual([LIST_CONTEXT_PINNED_CLASS]);
        expect(pinnedIndent.classes).toEqual([LIST_CONTEXT_PINNED_CLASS]);

        // Moving around inside the list neither duplicates the group nor re-announces it.
        fake.setInList(true);
        expect(fake.names()).toEqual(["outdent", "indent", ...TOOLBAR]);
        expect(onPinned).toHaveBeenCalledTimes(1);

        fake.setInList(false);
        expect(fake.names()).toEqual(TOOLBAR);

        // Coming back reuses the same views rather than minting new ones.
        fake.setInList(true);
        expect(onPinned).toHaveBeenCalledTimes(2);
        expect(fake.names()).toEqual(["outdent", "indent", ...TOOLBAR]);
        expect(fake.items[0]).toBe(pinnedOutdent);
        expect(fake.items[1]).toBe(pinnedIndent);
    });

    it("pins the group straight away when the editor starts with the caret in a list", () => {
        const fake = fakeEditor(TOOLBAR);
        fake.setInList(true);
        attachListContextToolbar(fake.asEditor);
        expect(fake.names()).toEqual(["outdent", "indent", ...TOOLBAR]);
    });

    it("detaching unpins, destroys the views and stops listening", () => {
        const fake = fakeEditor(TOOLBAR);
        const detach = attachListContextToolbar(fake.asEditor);
        fake.setInList(true);
        const pinnedViews = [fake.items[0], fake.items[1]];

        detach();
        expect(fake.names()).toEqual(TOOLBAR);
        expect(pinnedViews.every((view) => view.destroyed)).toBe(true);
        expect(fake.listenerCount()).toBe(0);
        fake.setInList(true);
        expect(fake.names()).toEqual(TOOLBAR);
    });

    it("leaves a destroyed editor alone when detaching, since its toolbar is already gone", () => {
        const fake = fakeEditor(TOOLBAR);
        const detach = attachListContextToolbar(fake.asEditor);
        fake.setInList(true);
        fake.editor.state = "destroyed";

        detach();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.names()).toEqual(["outdent", "indent", ...TOOLBAR]);
        expect(fake.items[0].destroyed).toBe(false);
    });

    it("pins only the entries the editor can build, and does nothing when it can build none", () => {
        const partial = fakeEditor(TOOLBAR, (name) => name === "indent");
        attachListContextToolbar(partial.asEditor);
        partial.setInList(true);
        expect(partial.names()).toEqual(["indent", ...TOOLBAR]);

        const none = fakeEditor(TOOLBAR, () => false);
        const detach = attachListContextToolbar(none.asEditor);
        expect(none.listenerCount()).toBe(0);
        none.setInList(true);
        expect(none.names()).toEqual(TOOLBAR);
        detach();

        const noToolbar = fakeEditor(TOOLBAR);
        (noToolbar.editor.ui.view as { toolbar?: unknown }).toolbar = undefined;
        attachListContextToolbar(noToolbar.asEditor);
        expect(noToolbar.listenerCount()).toBe(0);
    });
});

describe("the Task button", () => {
    let editor: RealClassicEditor;
    const asEditor = () => editor as unknown as ClassicEditor;
    const OUTDENT = "Decrease indent";
    const INDENT = "Increase indent";
    const TOOLBAR = [ "Bulleted List", "To-do List", OUTDENT, INDENT ];

    const content = [
        "<h2>Morning</h2>",
        "<ul class=\"todo-list\"><li data-list-item-id=\"eopen\"><label class=\"todo-list__label\"><input type=\"checkbox\" disabled><span class=\"todo-list__label__description\">open task</span></label></li></ul>",
        "<ul><li data-list-item-id=\"ebull\">bullet</li></ul>",
        "<p>plain</p>",
        "<h2>Suggested</h2>",
        "<ul class=\"todo-list\"><li data-list-item-id=\"esugg\"><label class=\"todo-list__label\"><input type=\"checkbox\" disabled><span class=\"todo-list__label__description\">idea</span></label></li></ul>"
    ].join("");

    beforeAll(async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await RealClassicEditor.create(el, {
            plugins: [ Essentials, Paragraph, Heading, List, TodoList, Indent ],
            toolbar: [ "bulletedList", "todoList", "outdent", "indent" ],
            licenseKey: "GPL"
        });
        setEditorNoteId(editor, "day");
    });

    afterAll(async () => {
        await editor.destroy();
    });

    /** Every controller a test attached, detached after it even when it fails half-way. */
    let detaches: (() => void)[] = [];
    afterEach(() => {
        for (const detach of detaches) detach();
        detaches = [];
        editor.disableReadOnlyMode("caius-write");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        h.isCaiusEnabled.mockResolvedValue(true);
        h.notes.day = dayNote([ "dateNote" ]);
        editor.setData(content);
        caretIn("plain");
    });

    function labels() {
        return Array.from(editor.ui.view.toolbar.items).map((item) =>
            (item instanceof ButtonView ? item.label : item.constructor.name));
    }

    /** Puts the caret at the start of the block whose list item id, or text, is `key`. */
    function caretIn(key: string) {
        const root = editor.model.document.getRoot();
        const found = root && Array.from(root.getChildren()).find((child) => child.is("element")
            && (child.getAttribute("listItemId") === key || textOf(child) === key));
        if (!found?.is("element")) throw new Error(`No block ${key}`);
        editor.model.change((writer) => writer.setSelection(found, 0));
    }

    async function attach(
        button: Promise<TaskToolbarButton | null> = createTaskToolbarButton(asEditor())
    ) {
        const onPinned = vi.fn();
        const detach = track(attachListContextToolbar(asEditor(), {
            onPinned, taskButton: button
        }));
        const resolved = await button;
        return { detach, onPinned, resolved };
    }

    function track(detach: () => void) {
        detaches.push(detach);
        return detach;
    }

    function deferred() {
        let resolve: (button: TaskToolbarButton | null) => void = () => {};
        const promise = new Promise<TaskToolbarButton | null>((done) => { resolve = done; });
        return { promise, resolve };
    }

    it("pins Task ahead of outdent and indent in a Journal todo item, and only there", async () => {
        const { detach, onPinned } = await attach();
        expect(labels()).toEqual(TOOLBAR);

        caretIn("eopen");
        expect(labels()).toEqual([ "caius.task", OUTDENT, INDENT, ...TOOLBAR ]);
        expect(onPinned).toHaveBeenCalledTimes(1);
        const taskButton = editor.ui.view.toolbar.items.get(0);
        expect(taskButton?.element?.classList.contains(LIST_CONTEXT_PINNED_CLASS)).toBe(true);

        caretIn("ebull");
        expect(labels()).toEqual([ OUTDENT, INDENT, ...TOOLBAR ]);
        caretIn("plain");
        expect(labels()).toEqual(TOOLBAR);
        detach();
    });

    it("stays off outside the Journal, in a read-only editor and while Caius is off", async () => {
        h.notes.day = dayNote([]);
        const outside = await attach();
        caretIn("eopen");
        expect(labels()).toEqual([ OUTDENT, INDENT, ...TOOLBAR ]);
        outside.detach();

        h.notes.day = dayNote([ "dateNote" ]);
        const locked = await attach();
        expect(labels()[0]).toBe("caius.task");
        // A caius write locks the editor and reloads it; unlocking moves no caret.
        editor.enableReadOnlyMode("caius-write");
        expect(labels()).toEqual([ OUTDENT, INDENT, ...TOOLBAR ]);
        editor.disableReadOnlyMode("caius-write");
        expect(labels()).toEqual([ "caius.task", OUTDENT, INDENT, ...TOOLBAR ]);
        locked.detach();

        h.isCaiusEnabled.mockResolvedValue(false);
        const off = await attach();
        expect(off.resolved).toBeNull();
        expect(labels()).toEqual([ OUTDENT, INDENT, ...TOOLBAR ]);
        off.detach();
    });

    it("goes first when Caius answers after the list controls are pinned, or a bullet turns into a todo", async () => {
        const late = deferred();
        caretIn("eopen");
        const onPinned = vi.fn();
        const detach = track(attachListContextToolbar(asEditor(), {
            onPinned, taskButton: late.promise
        }));
        expect(labels()).toEqual([ OUTDENT, INDENT, ...TOOLBAR ]);
        expect(onPinned).toHaveBeenCalledTimes(1);

        late.resolve(await createTaskToolbarButton(asEditor()));
        await vi.waitFor(() =>
            expect(labels()).toEqual([ "caius.task", OUTDENT, INDENT, ...TOOLBAR ]));
        expect(onPinned).toHaveBeenCalledTimes(2);

        caretIn("ebull");
        expect(labels()).toEqual([ OUTDENT, INDENT, ...TOOLBAR ]);
        editor.execute("todoList");
        expect(labels()).toEqual([ "caius.task", OUTDENT, INDENT, ...TOOLBAR ]);
        detach();
    });

    it("unpins and destroys the button on detach, including one that resolves afterwards", async () => {
        caretIn("eopen");
        const { detach, resolved } = await attach();
        if (!resolved) throw new Error("No button");
        const destroy = vi.spyOn(resolved.view, "destroy");
        detach();
        expect(labels()).toEqual(TOOLBAR);
        expect(destroy).toHaveBeenCalled();

        const late = deferred();
        const lateDetach = attachListContextToolbar(asEditor(), { taskButton: late.promise });
        lateDetach();
        const button = await createTaskToolbarButton(asEditor());
        if (!button) throw new Error("No button");
        const lateDestroy = vi.spyOn(button.view, "destroy");
        late.resolve(button);
        await vi.waitFor(() => expect(lateDestroy).toHaveBeenCalled());
        caretIn("eopen");
        expect(labels()).toEqual(TOOLBAR);
    });

    it("opens the task actions as a bottom sheet when tapped", async () => {
        const { detach, resolved } = await attach();
        if (!resolved) throw new Error("No button");

        caretIn("esugg");
        resolved.view.fire("execute");
        expect(h.show).toHaveBeenCalledTimes(1);
        type ShowOptions = { items: MenuItem<CommandNames>[]; forcePositionOnMobile?: boolean };
        const [ [ options ] ] = h.show.mock.calls as [ [ ShowOptions ] ];
        const target = findTaskAtSelection(asEditor() as never);
        if (!target) throw new Error("No task");
        expect(titles(options.items)).toEqual(titles(buildTaskActionItems(target)));
        expect(titles(options.items)).toContainEqual(
            [ "caius.accept", [ "Morning", "separator", "caius.accept_critical" ] ]);
        expect(options.forcePositionOnMobile).toBeUndefined();

        // A tap after the caret has left the task (the button is gone by then) opens nothing.
        caretIn("plain");
        resolved.view.fire("execute");
        expect(h.show).toHaveBeenCalledTimes(1);
        detach();
    });
});

/** A day note stand-in carrying `labels`. */
function dayNote(labels: string[]) {
    return { hasOwnedLabel: (name: string) => labels.includes(name), getParentNotes: () => [] };
}

function textOf(element: { getChildren(): Iterable<unknown> }) {
    let text = "";
    for (const child of element.getChildren()) {
        const node = child as { is(type: string): boolean; data?: string };
        if (node.is("$text")) text += node.data ?? "";
    }
    return text;
}

function titles(items: MenuItem<CommandNames>[]): unknown[] {
    return items.map((item) => ("title" in item
        ? (("items" in item && item.items) ? [ item.title, titles(item.items) ] : item.title)
        : item.kind));
}

