import type { ClassicEditor, View } from "@triliumnext/ckeditor5";
import taskIcon from "boxicons/svg/regular/bx-task.svg?raw";

import contextMenu from "../../../menus/context_menu.js";
import { buildTaskActionItems, findTaskAtSelection } from "../../../menus/task_actions.js";
import { isCaiusEnabled } from "../../../services/caius.js";
import { t } from "../../../services/i18n.js";

/** Stamped on the pinned Task button, so the stylesheet can mark it off from the rest. */
export const LIST_CONTEXT_PINNED_CLASS = "tn-list-context-pinned";

export interface ListContextToolbarOptions {
    /** Called each time the Task button is pinned, i.e. the caret has just entered a task. */
    onPinned?: () => void;
    /**
     * The Task button from {@link createTaskToolbarButton}, pinned while it applies. It resolves
     * to `null` while Caius is off.
     */
    taskButton?: Promise<TaskToolbarButton | null>;
}

/** A toolbar button pinned while {@link applies} holds. */
export interface TaskToolbarButton {
    view: View;
    applies(): boolean;
}

/** The slice of a model selection that {@link isSelectionInTodo} reads. */
export interface SelectionBlocks {
    getSelectedBlocks(): Iterable<{ getAttribute(key: string): unknown }>;
}

/**
 * Pins the Task button to the front of the editor's toolbar while the caret is in a Journal task,
 * and takes it out again when the caret leaves. The `List ›` row of `ContextToolbar` holds the list
 * controls, but it comes up by itself only as a list starts, so the button goes on the main row.
 *
 * @returns a function that stops listening and takes the button out again.
 */
export function attachListContextToolbar(
    editor: ClassicEditor,
    options: ListContextToolbarOptions = {}
): () => void {
    const toolbar = editor.ui.view.toolbar;
    if (!toolbar || !options.taskButton) {
        return () => {};
    }

    const document = editor.model.document;
    let task: TaskToolbarButton | null = null;
    let isPinned = false;
    let detached = false;
    // `change` fires for selection-only changes as well as for edits, so it also covers turning
    // the current paragraph into a list from the toolbar, where the caret does not move.
    const update = () => {
        const applies = !!task?.applies();
        if (!task || applies === isPinned) {
            return;
        }

        isPinned = applies;
        if (applies) {
            toolbar.items.add(task.view, 0);
            options.onPinned?.();
        } else {
            toolbar.items.remove(task.view);
        }
    };

    void options.taskButton.then((button) => {
        if (!button) {
            return;
        }
        if (detached) {
            button.view.destroy();
            return;
        }

        task = button;
        document.on("change", update);
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
        if (!task) {
            return;
        }
        document.off("change", update);
        editor.off("change:isReadOnly", update);
        // A destroyed editor has torn its toolbar down, and the pinned button with it.
        if (editor.state === "destroyed") {
            return;
        }
        if (isPinned) {
            toolbar.items.remove(task.view);
        }
        task.view.destroy();
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

/** Whether the first block the selection touches is a todo item. */
export function isSelectionInTodo(selection: SelectionBlocks): boolean {
    for (const block of selection.getSelectedBlocks()) {
        return block.getAttribute("listType") === "todo";
    }
    return false;
}
