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
    attachListContextToolbar, createTaskToolbarButton, isSelectionInTodo,
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
function fakeEditor(initialItems: string[]) {
    const items: FakeView[] = initialItems.map(makeView);
    const listeners: (() => void)[] = [];
    const editorListeners: (() => void)[] = [];
    let blocks = [block(false)];
    const editor = {
        state: "ready",
        on(event: string, callback: () => void) {
            if (event === "change:isReadOnly") editorListeners.push(callback);
        },
        off(event: string, callback: () => void) {
            if (event === "change:isReadOnly") editorListeners.splice(editorListeners.indexOf(callback), 1);
        },
        ui: {
            componentFactory: { has: () => true, create: makeView },
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
        listenerCount: () => listeners.length + editorListeners.length,
        /** Whether the caret is in a todo item, which is where the fake Task button applies. */
        isInTask: () => blocks[0]?.getAttribute("listType") === "todo",
        /** Moves the caret into or out of a todo item and fires the document's `change`. */
        setInTask(inTask: boolean) {
            blocks = [block(inTask, "todo")];
            for (const callback of [...listeners]) callback();
        }
    };
}

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
    const TOOLBAR = [ "undo", "redo", "|", "blockType", "|", "outdent", "indent" ];

    async function attachFake() {
        const fake = fakeEditor(TOOLBAR);
        const task = { view: makeView("task"), applies: fake.isInTask };
        const onPinned = vi.fn();
        const detach = attachListContextToolbar(fake.asEditor, {
            onPinned, taskButton: Promise.resolve(task as unknown as TaskToolbarButton)
        });
        await vi.waitFor(() => expect(fake.listenerCount()).toBe(2));
        return { fake, task, onPinned, detach };
    }

    it("pins only the Task button to the front while it applies, announcing each pin", async () => {
        const { fake, task, onPinned } = await attachFake();
        expect(fake.names()).toEqual(TOOLBAR);

        fake.setInTask(true);
        expect(fake.names()).toEqual([ "task", ...TOOLBAR ]);
        expect(fake.items[0]).toBe(task.view);
        expect(onPinned).toHaveBeenCalledTimes(1);

        // Moving within the task neither pins it twice nor announces it again.
        fake.setInTask(true);
        expect(fake.names()).toEqual([ "task", ...TOOLBAR ]);
        expect(onPinned).toHaveBeenCalledTimes(1);

        fake.setInTask(false);
        expect(fake.names()).toEqual(TOOLBAR);
        fake.setInTask(true);
        expect(fake.items[0]).toBe(task.view);
        expect(onPinned).toHaveBeenCalledTimes(2);
    });

    it("unpins and destroys the button once, however often it is detached", async () => {
        const { fake, task, detach } = await attachFake();
        fake.setInTask(true);

        detach();
        detach();
        expect(fake.names()).toEqual(TOOLBAR);
        expect(task.view.destroyed).toBe(true);
        expect(fake.listenerCount()).toBe(0);
        fake.setInTask(true);
        expect(fake.names()).toEqual(TOOLBAR);
    });

    it("leaves a destroyed editor alone when detaching, since its toolbar is already gone", async () => {
        const { fake, task, detach } = await attachFake();
        fake.setInTask(true);
        fake.editor.state = "destroyed";

        detach();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.names()).toEqual([ "task", ...TOOLBAR ]);
        expect(task.view.destroyed).toBe(false);
    });

    it("does nothing without a toolbar", () => {
        const noToolbar = fakeEditor(TOOLBAR);
        (noToolbar.editor.ui.view as { toolbar?: unknown }).toolbar = undefined;
        attachListContextToolbar(noToolbar.asEditor, {
            taskButton: Promise.resolve({ view: makeView("task"), applies: () => true } as never)
        });
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

    it("pins Task to the front in a Journal todo item, and only there", async () => {
        const { detach, onPinned } = await attach();
        expect(labels()).toEqual(TOOLBAR);

        caretIn("eopen");
        expect(labels()).toEqual([ "caius.task", ...TOOLBAR ]);
        expect(onPinned).toHaveBeenCalledTimes(1);
        const taskButton = editor.ui.view.toolbar.items.get(0);
        expect(taskButton?.element?.classList.contains(LIST_CONTEXT_PINNED_CLASS)).toBe(true);

        caretIn("ebull");
        expect(labels()).toEqual(TOOLBAR);
        caretIn("plain");
        expect(labels()).toEqual(TOOLBAR);
        detach();
    });

    it("stays off outside the Journal, in a read-only editor and while Caius is off", async () => {
        h.notes.day = dayNote([]);
        const outside = await attach();
        caretIn("eopen");
        expect(labels()).toEqual(TOOLBAR);
        outside.detach();

        h.notes.day = dayNote([ "dateNote" ]);
        const locked = await attach();
        expect(labels()[0]).toBe("caius.task");
        // A caius write locks the editor and reloads it; unlocking moves no caret.
        editor.enableReadOnlyMode("caius-write");
        expect(labels()).toEqual(TOOLBAR);
        editor.disableReadOnlyMode("caius-write");
        expect(labels()).toEqual([ "caius.task", ...TOOLBAR ]);
        locked.detach();

        h.isCaiusEnabled.mockResolvedValue(false);
        const off = await attach();
        expect(off.resolved).toBeNull();
        expect(labels()).toEqual(TOOLBAR);
        off.detach();
    });

    it("pins Task when Caius answers late, or when a bullet turns into a todo", async () => {
        const late = deferred();
        caretIn("eopen");
        const onPinned = vi.fn();
        const detach = track(attachListContextToolbar(asEditor(), {
            onPinned, taskButton: late.promise
        }));
        expect(labels()).toEqual(TOOLBAR);
        expect(onPinned).not.toHaveBeenCalled();

        late.resolve(await createTaskToolbarButton(asEditor()));
        await vi.waitFor(() => expect(labels()).toEqual([ "caius.task", ...TOOLBAR ]));
        expect(onPinned).toHaveBeenCalledTimes(1);

        caretIn("ebull");
        expect(labels()).toEqual(TOOLBAR);
        editor.execute("todoList");
        expect(labels()).toEqual([ "caius.task", ...TOOLBAR ]);
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

