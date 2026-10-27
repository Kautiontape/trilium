import type { CKTextEditor, ModelElement, ModelNode } from "@triliumnext/ckeditor5";
import { DEFAULT_TASK_STATES, type TaskStateDef } from "@triliumnext/commons";

import appContext, { type CommandNames } from "../components/app_context.js";
import type FNote from "../entities/fnote.js";
import {
    caiusApi, type CaiusConversation, caiusNow, caiusOpener, type CaiusTaskState, caiusWrite, describeSkip,
    type EditableElement, findOpenEditors, flushEditors, forgetCaiusStatus, isCaiusEnabled, openPeriodNoteIds,
    startCaiusConversation, wasCaiusEnabled
} from "../services/caius.js";
import dialog from "../services/dialog.js";
import froca from "../services/froca.js";
import { t } from "../services/i18n.js";
import toast from "../services/toast.js";
import { getEditorNoteId } from "../widgets/react/NoteStore.js";
import type { MenuItem } from "./context_menu.js";

/** A task's state as Caius reads it: from the task state's markdown symbol, else the checkbox. */
export type TaskState = "open" | "doing" | "done" | "cancelled" | "rescheduled" | "other";

/** The todo item an action applies to, read from the editor model. */
export interface TaskTarget {
    noteId: string;
    listItemId: string;
    state: TaskState;
    /** Whether the nearest heading above the item is "Suggested". */
    inSuggested: boolean;
    /** The note's headings, in order, without "Suggested": where Accept can put the item. */
    headers: string[];
}

/** The task actions bound to commands, which act on the todo item at the caret. */
export type TaskCommand = "done" | "doing" | "forwardTomorrow" | "drop";

/**
 * The task actions that apply to `target`, as `ContextMenu` items. The desktop right-click menu
 * shows them as its Task submenu; the mobile toolbar opens them as a sheet.
 */
export function buildTaskActionItems(target: TaskTarget): MenuItem<CommandNames>[] {
    const items: MenuItem<CommandNames>[] = [];
    const isLive = target.state === "open" || target.state === "doing";

    if (isLive) {
        if (target.state !== "doing") {
            items.push({
                title: t("caius.doing"),
                uiIcon: "bx bx-loader",
                handler: () => void setTaskState(target, "doing")
            });
        }
        items.push({
            title: t("caius.done"),
            uiIcon: "bx bx-check",
            handler: () => void setTaskState(target, "done")
        });
        items.push({
            title: t("caius.forward"),
            uiIcon: "bx bx-right-arrow-alt",
            items: [
                {
                    title: t("caius.forward_tomorrow"),
                    uiIcon: "bx bx-sun",
                    handler: () => void forwardTask(target, tomorrowKey(caiusNow()))
                },
                {
                    title: t("caius.forward_next_week"),
                    uiIcon: "bx bx-calendar-week",
                    handler: () => void forwardTask(target, nextWeekKey(caiusNow()))
                },
                {
                    title: t("caius.forward_next_month"),
                    uiIcon: "bx bx-calendar",
                    handler: () => void forwardTask(target, nextMonthKey(caiusNow()))
                },
                { kind: "separator" },
                {
                    title: t("caius.forward_pick"),
                    uiIcon: "bx bx-calendar-edit",
                    handler: () => void pickDateAndForward(target)
                }
            ]
        });
        items.push({
            title: t("caius.drop"),
            uiIcon: "bx bx-block",
            handler: () => void dropTask(target)
        });
    }

    if (target.inSuggested) {
        if (items.length) {
            items.push({ kind: "separator" });
        }
        items.push({
            title: t("caius.accept"),
            uiIcon: "bx bx-list-plus",
            items: [
                ...target.headers.map((section): MenuItem<CommandNames> => ({
                    title: section,
                    uiIcon: "bx bx-heading",
                    handler: () => void acceptTask(target, { section })
                })),
                ...(target.headers.length ? [ { kind: "separator" } as const ] : []),
                {
                    title: t("caius.accept_critical"),
                    uiIcon: "bx bx-error",
                    handler: () => void acceptTask(target, { critical: true })
                }
            ]
        });
        items.push({
            title: t("caius.dismiss"),
            uiIcon: "bx bx-x",
            handler: () => void dismissTask(target)
        });
    }

    if (items.length) {
        items.push({ kind: "separator" });
    }
    items.push({
        title: t("caius.explain"),
        uiIcon: "bx bx-help-circle",
        handler: () => void explainTask(target)
    });

    return items;
}

/**
 * The right-click menu's "Task" submenu for the todo item under `element`, or `null` when `element`
 * is not in a todo item of an editable Journal note, or Caius is off.
 */
export async function buildTaskActionsMenuItem(
    element: Element
): Promise<MenuItem<CommandNames> | null> {
    const target = findTaskAtElement(element);
    if (!target || !(await isCaiusEnabled())) {
        return null;
    }

    return {
        title: t("caius.task"),
        uiIcon: "bx bx-task",
        className: TASK_ACTIONS_CLASS,
        items: buildTaskActionItems(target)
    };
}

/** The class of the Task submenu's row, by which the browser's menu recognises it. */
export const TASK_ACTIONS_CLASS = "caius-task-actions";

/**
 * Whether a right-click on `element` would show the Task submenu, answered synchronously from the
 * last known Caius status, for the browser's `contextmenu` listener. Over a task while that status
 * is `false`, it asks the server again, so that the next right-click can open the menu.
 */
export function isOverJournalTask(element: Element | null) {
    if (!element || !findTaskAtElement(element)) {
        return false;
    }

    if (!wasCaiusEnabled()) {
        void isCaiusEnabled();
        return false;
    }

    return true;
}

/** Starts Plan my day or Wind down for today by the Caius clock, for the two day commands. */
export async function runDayCommand(kind: CaiusConversation) {
    if (!(await isCaiusEnabled())) {
        toast.showMessage(t("caius.disabled"), 3000, "bx bx-info-circle");
        return;
    }

    await startCaiusConversation(caiusOpener(kind, dayKey(caiusNow())));
}

/** Runs `command` on the todo item at the caret in the note context `ntxId`, or the active one. */
export async function runTaskCommand(command: TaskCommand, ntxId?: string | null) {
    if (!(await isCaiusEnabled())) {
        toast.showMessage(t("caius.disabled"), 3000, "bx bx-info-circle");
        return;
    }

    const { tabManager } = appContext;
    const noteContext = tabManager.getNoteContexts().find((context) => context.ntxId === ntxId)
        ?? tabManager.getActiveContext();
    const editor = noteContext?.note?.type === "text" ? await noteContext.getTextEditor() : null;
    const target = editor ? findTaskAtSelection(editor) : null;
    if (!target) {
        toast.showMessage(t("caius.no_task_at_caret"), 3000, "bx bx-info-circle");
        return;
    }

    switch (command) {
        case "done":
        case "doing":
            await setTaskState(target, command);
            break;
        case "forwardTomorrow":
            await forwardTask(target, tomorrowKey(caiusNow()));
            break;
        case "drop":
            await dropTask(target);
            break;
    }
}

/**
 * The todo item `element` sits in, when that item is in an editable text editor showing a Journal
 * note. Electron reaches `element` through `document.elementFromPoint()`, the browser through the
 * event target.
 */
export function findTaskAtElement(element: Element): TaskTarget | null {
    const domRoot = element.closest<EditableElement>(".ck-editor__editable");
    const editor = domRoot?.ckeditorInstance;
    const listItem = element.closest("li");
    if (!editor || editor.isReadOnly || !listItem || !domRoot.contains(listItem)) {
        return null;
    }

    // The editing model has no element for an `<li>`; its first block starts at the `<li>`'s start.
    const viewPosition = editor.editing.view.domConverter.domPositionToView(listItem, 0);
    const block = viewPosition ? editor.editing.mapper.toModelPosition(viewPosition).parent : null;
    return block?.is("element") ? readJournalTask(editor, block) : null;
}

/**
 * The todo item at the caret of `editor`, when `editor` shows a Journal note. A read-only editor,
 * which includes one a write is still holding, has none.
 */
export function findTaskAtSelection(editor: CKTextEditor): TaskTarget | null {
    if (editor.isReadOnly) {
        return null;
    }

    const block = editor.model.document.selection.getFirstPosition()?.parent;
    return block?.is("element") ? readJournalTask(editor, block) : null;
}

/** Whether `note` is a day, week or month note, or a child of one. */
export function isJournalNote(note: FNote) {
    return [ note, ...note.getParentNotes() ].some((candidate) =>
        JOURNAL_LABELS.some((label) => candidate.hasOwnedLabel(label)));
}

const JOURNAL_LABELS = [ "dateNote", "weekNote", "monthNote" ];

/** Mirrors `TASK_STATE_ATTRIBUTE` in the editor's `todo_list_multistate` plugin. */
const TASK_STATE_ATTRIBUTE = "taskState";

const STATE_BY_SYMBOL: Record<string, TaskState> = {
    " ": "open",
    "/": "doing",
    "x": "done",
    "-": "cancelled",
    ">": "rescheduled"
};

function readJournalTask(editor: CKTextEditor, block: ModelElement): TaskTarget | null {
    const noteId = getEditorNoteId(editor);
    const note = noteId ? froca.notes[noteId] : undefined;
    if (!noteId || !note || !isJournalNote(note)) {
        return null;
    }

    return readTaskTarget(editor, noteId, block);
}

/** Reads the task `block` belongs to, or `null` when `block` is not in a todo item. */
export function readTaskTarget(
    editor: CKTextEditor,
    noteId: string,
    block: ModelElement
): TaskTarget | null {
    const first = firstBlockOfItem(block);
    const listItemId = first.getAttribute("listItemId");
    if (first.getAttribute("listType") !== "todo" || typeof listItemId !== "string") {
        return null;
    }

    const nearest = nearestHeadingBefore(first);
    return {
        noteId,
        listItemId,
        state: readTaskState(editor, first),
        inSuggested: nearest !== null && isSuggested(nearest),
        headers: allHeadings(editor).filter((heading) => !isSuggested(heading))
    };
}

function readTaskState(editor: CKTextEditor, block: ModelElement): TaskState {
    const stateName = block.getAttribute(TASK_STATE_ATTRIBUTE);
    if (typeof stateName === "string") {
        const configured = editor.config.get("taskStates") as TaskStateDef[] | undefined;
        const states = configured ?? DEFAULT_TASK_STATES;
        const symbol = states.find((state) => state.name === stateName)?.markdownSymbol;
        return (symbol !== undefined && STATE_BY_SYMBOL[symbol]) || "other";
    }

    return block.getAttribute("todoListChecked") ? "done" : "open";
}

/** A list item spans every consecutive block that carries its `listItemId`. */
function firstBlockOfItem(block: ModelElement) {
    const listItemId = block.getAttribute("listItemId");
    let first = block;
    while (listItemId !== undefined && isElement(first.previousSibling)
        && first.previousSibling.getAttribute("listItemId") === listItemId) {
        first = first.previousSibling;
    }

    return first;
}

/** The text of the nearest heading above `block`, looking out through its ancestors. */
function nearestHeadingBefore(block: ModelElement) {
    let node: ModelNode | null = block;
    while (node) {
        for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
            if (isHeading(sibling)) {
                return textOf(sibling);
            }
        }
        node = node.parent?.is("element") ? node.parent : null;
    }

    return null;
}

function allHeadings(editor: CKTextEditor) {
    const root = editor.model.document.getRoot();
    const headings = root ? Array.from(root.getChildren()).filter(isHeading).map(textOf) : [];
    return [ ...new Set(headings.filter((heading) => heading.length > 0)) ];
}

function isElement(node: ModelNode | null): node is ModelElement {
    return !!node?.is("element");
}

function isHeading(node: ModelNode): node is ModelElement {
    return isElement(node) && node.name.startsWith("heading");
}

/** Matches the library's `isSuggestedName()`: ignores case and anything but letters and digits. */
export function isSuggested(heading: string) {
    return heading.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase() === "suggested";
}

function textOf(element: ModelElement) {
    let text = "";
    for (const child of element.getChildren()) {
        if (child.is("$text")) {
            text += child.data;
        }
    }

    return text.trim();
}

/** The day after `now`, as `YYYY-MM-DD` in local time. */
export function tomorrowKey(now: Date) {
    return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}

/** The ISO week after the one `now` is in, as `YYYY-Www`. */
export function nextWeekKey(now: Date) {
    return weekKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
}

/** The month after the one `now` is in, as `YYYY-MM`. */
export function nextMonthKey(now: Date) {
    return monthKey(new Date(now.getFullYear(), now.getMonth() + 1, 1));
}

/** The local day of `date`, as `YYYY-MM-DD`. */
export function dayKey(date: Date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The ISO week the local day of `date` is in, as `YYYY-Www`. */
export function weekKey(date: Date) {
    // The ISO week-numbering year is the year of the week's Thursday.
    const daysFromMonday = (date.getDay() + 6) % 7;
    const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysFromMonday + 3);
    const year = thursday.getFullYear();
    const thursdayUtc = Date.UTC(year, thursday.getMonth(), thursday.getDate());
    const dayOfYear = Math.round((thursdayUtc - Date.UTC(year, 0, 1)) / 86_400_000);
    return `${year}-W${pad(Math.floor(dayOfYear / 7) + 1)}`;
}

/** The month the local day of `date` is in, as `YYYY-MM`. */
export function monthKey(date: Date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** Whether `value` is a day (`YYYY-MM-DD`), an ISO week (`YYYY-Www`) or a month (`YYYY-MM`). */
export function isForwardKey(value: string) {
    return FORWARD_KEYS.some((pattern) => pattern.test(value));
}

const FORWARD_KEYS = [
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/,
    /^\d{4}-(0[1-9]|1[0-2])$/
];

function pad(value: number) {
    return String(value).padStart(2, "0");
}

function itemOf(target: TaskTarget) {
    return { noteId: target.noteId, listItemId: target.listItemId };
}

async function setTaskState(target: TaskTarget, state: CaiusTaskState, reason?: string) {
    await caiusWrite(
        target.noteId,
        (expectedBlobId) => caiusApi.setState([
            { ...itemOf(target), state, reason, expectedBlobId }
        ]),
        t(`caius.set_${state}`)
    );
}

async function forwardTask(target: TaskTarget, to: string) {
    await caiusWrite(
        target.noteId,
        (expectedBlobId) => caiusApi.forward([ { ...itemOf(target), to, expectedBlobId } ]),
        t("caius.forwarded", { to }),
        // The client cannot know the target's note id before the call, so it locks any open note
        // that carries the target's period label.
        { alsoLock: openPeriodNoteIds(to) }
    );
}

async function pickDateAndForward(target: TaskTarget) {
    const value = (await dialog.prompt({
        title: t("caius.forward_pick_title"),
        message: t("caius.forward_pick_message"),
        defaultValue: tomorrowKey(caiusNow())
    }))?.trim();
    if (!value) {
        return;
    }

    if (!isForwardKey(value)) {
        toast.showError(t("caius.forward_pick_invalid", { value }));
        return;
    }

    await forwardTask(target, value);
}

async function dropTask(target: TaskTarget) {
    const reason = await dialog.prompt({
        title: t("caius.drop_title"),
        message: t("caius.drop_message")
    });
    if (reason === null) {
        return;
    }

    if (!reason.trim()) {
        toast.showError(t("caius.drop_reason_required"));
        return;
    }

    await setTaskState(target, "cancelled", reason.trim());
}

async function acceptTask(target: TaskTarget, placement: { section: string } | { critical: true }) {
    await caiusWrite(
        target.noteId,
        (expectedBlobId) => caiusApi.accept([
            { ...itemOf(target), ...placement, expectedBlobId }
        ]),
        t("caius.accepted")
    );
}

async function dismissTask(target: TaskTarget) {
    await caiusWrite(
        target.noteId,
        (expectedBlobId) => caiusApi.dismiss([ { ...itemOf(target), expectedBlobId } ]),
        t("caius.dismissed")
    );
}

async function explainTask(target: TaskTarget) {
    const editors = findOpenEditors(target.noteId);
    try {
        if (editors.length) {
            // An item never saved has no `data-list-item-id` in the stored note yet.
            await flushEditors(editors);
        }

        const explanation = await caiusApi.explain(target.noteId, target.listItemId);
        if ("error" in explanation) {
            const message = describeSkip(explanation.error, editors.length > 0);
            toast.showMessage(message, 5000, "bx bx-info-circle");
            return;
        }

        toast.showMessage(explanation.summary, 10_000, "bx bx-help-circle");
    } catch (error) {
        forgetCaiusStatus();
        toast.showError(t("caius.request_failed", { message: String(error) }));
    }
}
