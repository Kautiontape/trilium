import type { ClassicEditor } from "@triliumnext/ckeditor5";

/**
 * The toolbar entries that matter only while the caret is in a list, in the order they are pinned.
 */
export const LIST_CONTEXT_TOOLBAR_ITEMS = ["outdent", "indent"] as const;

/** Stamped on each pinned button, so the stylesheet can mark the group off from the rest. */
export const LIST_CONTEXT_PINNED_CLASS = "tn-list-context-pinned";

export interface ListContextToolbarOptions {
    /** Called each time the group is pinned, i.e. the caret has just entered a list. */
    onPinned?: () => void;
}

/** The slice of a model selection that {@link isSelectionInList} reads. */
export interface SelectionBlocks {
    getSelectedBlocks(): Iterable<{ hasAttribute(key: string): boolean }>;
}

/**
 * Pins the list-only toolbar entries (outdent, indent) to the front of the editor's toolbar for as
 * long as the selection is inside a list, and takes them out again when it leaves.
 *
 * On a phone the toolbar is a single row wider than the screen, so a button is only as useful as
 * its position: outdent and indent sit near the end, behind a scroll or the overflow dropdown, yet
 * in a checklist they are the two most-used controls, while in prose they matter not at all.
 * Rather than reorder the bar for good, the two are brought to the front only while the caret is
 * in a list. They are fresh views from the component factory, not the originals moved: the toolbar
 * keeps no names for its items, so finding the originals would mean replaying the config against
 * the factory, separator cleanup included. The duplicates left at the original position sit off
 * screen and cost nothing.
 *
 * @returns a function that stops listening and takes the pinned views out again.
 */
export function attachListContextToolbar(
    editor: ClassicEditor,
    options: ListContextToolbarOptions = {}
): () => void {
    const toolbar = editor.ui.view.toolbar;
    const factory = editor.ui.componentFactory;
    if (!toolbar) {
        return () => {};
    }

    const views = LIST_CONTEXT_TOOLBAR_ITEMS
        .filter((name) => factory.has(name))
        .map((name) => {
            const view = factory.create(name);
            // Before the first render, which happens when the view joins the toolbar.
            view.extendTemplate({ attributes: { class: [LIST_CONTEXT_PINNED_CLASS] } });
            return view;
        });
    if (views.length === 0) {
        return () => {};
    }

    let pinned = false;
    const pin = () => {
        views.forEach((view, index) => toolbar.items.add(view, index));
        pinned = true;
        options.onPinned?.();
    };
    const unpin = () => {
        for (const view of views) {
            toolbar.items.remove(view);
        }
        pinned = false;
    };
    // `change` fires for selection-only changes as well as for edits, so it also covers turning
    // the current paragraph into a list from the toolbar, where the caret does not move.
    const update = () => {
        const inList = isSelectionInList(editor.model.document.selection);
        if (inList && !pinned) {
            pin();
        } else if (!inList && pinned) {
            unpin();
        }
    };

    const document = editor.model.document;
    document.on("change", update);
    update();

    return () => {
        document.off("change", update);
        // A destroyed editor has torn its toolbar down, and any pinned views with it; views that
        // were never pinned are unrendered and go with the editor's object graph.
        if (editor.state === "destroyed") {
            return;
        }
        if (pinned) {
            unpin();
        }
        for (const view of views) {
            view.destroy();
        }
    };
}

/** Whether any block the selection touches is a list item, of whichever list type. */
export function isSelectionInList(selection: SelectionBlocks): boolean {
    for (const block of selection.getSelectedBlocks()) {
        if (block.hasAttribute("listItemId")) {
            return true;
        }
    }
    return false;
}
