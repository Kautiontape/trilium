import type { ClassicEditor } from "@triliumnext/ckeditor5";
import { describe, expect, it, vi } from "vitest";

import { attachListContextToolbar, isSelectionInList, LIST_CONTEXT_PINNED_CLASS } from "./list_context_toolbar.js";

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

function block(inList: boolean) {
    return { hasAttribute: (name: string) => name === "listItemId" && inList };
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
