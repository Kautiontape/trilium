import type { ClassicEditor, View } from "@triliumnext/ckeditor5";
import taskIcon from "boxicons/svg/regular/bx-task.svg?raw";

import contextMenu from "../../../menus/context_menu.js";
import { buildTaskActionItems, findTaskAtSelection } from "../../../menus/task_actions.js";
import { isCaiusEnabled } from "../../../services/caius.js";
import { t } from "../../../services/i18n.js";

/**
 * The toolbar entries that matter only while the caret is in a list, in the order they are pinned.
 */
export const LIST_CONTEXT_TOOLBAR_ITEMS = ["outdent", "indent"] as const;

/** Stamped on each pinned button, so the stylesheet can mark the group off from the rest. */
export const LIST_CONTEXT_PINNED_CLASS = "tn-list-context-pinned";

export interface ListContextToolbarOptions {
    /** Called each time a button is pinned, i.e. the caret has just entered a list or a task. */
    onPinned?: () => void;
    /**
     * The Task button from {@link createTaskToolbarButton}, pinned ahead of the list entries while
     * it applies. It resolves to `null` while Caius is off.
     */
    taskButton?: Promise<TaskToolbarButton | null>;
}

/** A toolbar button pinned while {@link applies} holds. */
export interface TaskToolbarButton {
    view: View;
    applies(): boolean;
}

/**
 * The slice of a model selection that {@link isSelectionInList}
 * and {@link isSelectionInTodo} read.
 */
export interface SelectionBlocks {
    getSelectedBlocks(): Iterable<{
        hasAttribute(key: string): boolean;
        getAttribute(key: string): unknown;
    }>;
}

/**
 * Pins the list-only toolbar entries (outdent, indent) to the front of the editor's toolbar for as
 * long as the selection is inside a list, and takes them out again when it leaves. With a
 * `taskButton`, the Task button goes in front of them while the caret is in a Journal task.
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

    const listViews = LIST_CONTEXT_TOOLBAR_ITEMS
        .filter((name) => factory.has(name))
        .map((name) => {
            const view = factory.create(name);
            // Before the first render, which happens when the view joins the toolbar.
            view.extendTemplate({ attributes: { class: [LIST_CONTEXT_PINNED_CLASS] } });
            return view;
        });
    if (listViews.length === 0 && !options.taskButton) {
        return () => {};
    }

    let task: TaskToolbarButton | null = null;
    let pinned: View[] = [];
    let detached = false;
    // `change` fires for selection-only changes as well as for edits, so it also covers turning
    // the current paragraph into a list from the toolbar, where the caret does not move.
    const update = () => {
        const selection = editor.model.document.selection;
        const wanted = [
            ...(task?.applies() ? [ task.view ] : []),
            ...(isSelectionInList(selection) ? listViews : [])
        ];
        const unchanged = wanted.length === pinned.length
            && wanted.every((view, index) => view === pinned[index]);
        if (unchanged) {
            return;
        }

        for (const view of pinned) {
            toolbar.items.remove(view);
        }
        for (const [ index, view ] of wanted.entries()) {
            toolbar.items.add(view, index);
        }
        const added = wanted.some((view) => !pinned.includes(view));
        pinned = wanted;
        if (added) {
            options.onPinned?.();
        }
    };

    const document = editor.model.document;
    document.on("change", update);
    update();

    void options.taskButton?.then((button) => {
        if (!button) {
            return;
        }
        if (detached) {
            button.view.destroy();
            return;
        }

        task = button;
        // A caius write locks the editor while it reloads the note, and the unlock that follows
        // moves no caret, so `change` alone would leave the button hidden.
        editor.on("change:isReadOnly", update);
        update();
    });

    return () => {
        if (detached) {
            return;
        }
        detached = true;
        document.off("change", update);
        if (task) {
            editor.off("change:isReadOnly", update);
        }
        // A destroyed editor has torn its toolbar down, and any pinned views with it; views that
        // were never pinned are unrendered and go with the editor's object graph.
        if (editor.state === "destroyed") {
            return;
        }
        for (const view of pinned) {
            toolbar.items.remove(view);
        }
        for (const view of [ ...listViews, ...(task ? [ task.view ] : []) ]) {
            view.destroy();
        }
    };
}

/**
 * The Task button for the mobile toolbar, which opens the task actions for the todo item at the
 * caret through `contextMenu`, a bottom sheet on mobile. Resolves to `null` while Caius is off.
 */
export async function createTaskToolbarButton(
    editor: ClassicEditor
): Promise<TaskToolbarButton | null> {
    if (!(await isCaiusEnabled())) {
        return null;
    }

    // The editor's chunk is already loaded once an editor exists; a static import would pull it
    // into the mobile layout's startup bundle.
    const { ButtonView } = await import("@triliumnext/ckeditor5");
    const view = new ButtonView(editor.locale);
    view.set({ label: t("caius.task"), icon: taskIcon, withText: true });
    view.extendTemplate({ attributes: { class: [LIST_CONTEXT_PINNED_CLASS] } });
    view.on("execute", () => {
        const target = findTaskAtSelection(editor);
        if (!target) {
            return;
        }

        const rect = view.element?.getBoundingClientRect();
        contextMenu.show({
            x: rect?.left ?? 0,
            y: rect?.top ?? 0,
            items: buildTaskActionItems(target),
            selectMenuItemHandler: () => {}
        });
    });

    return {
        view,
        applies: () => isSelectionInTodo(editor.model.document.selection)
            && findTaskAtSelection(editor) !== null
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

/** Whether the first block the selection touches is a todo item. */
export function isSelectionInTodo(selection: SelectionBlocks): boolean {
    for (const block of selection.getSelectedBlocks()) {
        return block.getAttribute("listType") === "todo";
    }
    return false;
}
