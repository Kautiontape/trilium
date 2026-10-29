import type { CKTextEditor } from "@triliumnext/ckeditor5";

/** Whether the editor selection sits inside a code block (where Enter should add a newline, not submit). */
export function isSelectionInCodeBlock(editor: CKTextEditor): boolean {
    return (
        editor.model.document.selection
            .getFirstPosition()
            ?.parent.is("element", "codeBlock") ?? false
    );
}

/**
 * Insert a new block, mirroring the native Enter behavior so lists and blocks can be built (and exited)
 * while plain Enter submits. On an empty block, the gesture leaves the enclosing structure instead of
 * adding another block — the chat routes these gestures through keydown keystrokes, which bypass the
 * List/BlockQuote/CodeBlock handlers that would natively do this on the `enter` view event:
 *  - on an EMPTY list item → leave the list (`outdentList` → paragraph);
 *  - on an EMPTY line in a quote → leave the quote (that line becomes a normal paragraph);
 *  - in a code block, after two trailing blank lines → leave the block; otherwise add a newline;
 *  - otherwise → split into a new list item / paragraph (`enter`).
 *
 * View scrolling is left to the caller so this stays a pure model operation (and testable without layout).
 */
export function insertNewBlock(editor: CKTextEditor): void {
    const block = editor.model.document.selection.getFirstPosition()?.parent;
    const emptyListItem =
        block?.is("element") &&
        block.isEmpty &&
        block.hasAttribute("listItemId");
    if (emptyListItem && editor.commands.get("outdentList")?.isEnabled) {
        editor.execute("outdentList");
        return;
    }
    if (leaveBlockQuoteFromEmptyLine(editor)) {
        return;
    }
    if (isSelectionInCodeBlock(editor)) {
        if (!leaveCodeBlockAfterBlankLines(editor)) {
            editor.execute("shiftEnter");
        }
        return;
    }
    editor.execute("enter");
}

/**
 * When Backspace is pressed at the very start of a list item, leave the list (`outdentList` → paragraph)
 * instead of CKEditor's default, which merges the item into the previous one as a bullet-less
 * continuation block. Returns whether it acted (so the caller can stop the delete).
 */
export function outdentListItemAtStart(editor: CKTextEditor): boolean {
    const selection = editor.model.document.selection;
    const position = selection.getFirstPosition();
    const block = position?.parent;
    if (
        !selection.isCollapsed ||
        !position?.isAtStart ||
        !block?.is("element") ||
        !block.hasAttribute("listItemId")
    ) {
        return false;
    }
    if (!editor.commands.get("outdentList")?.isEnabled) return false;
    editor.execute("outdentList");
    return true;
}

/**
 * When the caret is at the end of a code block preceded by two blank lines (two trailing line breaks),
 * leave the block: consume those blank lines and place the caret in a fresh paragraph after the block.
 * This matches CKEditor's native "two blank lines to end the block" (which only fires on plain Enter),
 * so the chat's Shift/Ctrl/Alt+Enter gestures can exit the fence too — while a single blank line is kept
 * for spacing (so a blank line can precede more code). Returns whether it left the block.
 */
function leaveCodeBlockAfterBlankLines(editor: CKTextEditor): boolean {
    const selection = editor.model.document.selection;
    if (!selection.isCollapsed) return false;
    const position = selection.getLastPosition();
    if (!position?.isAtEnd) return false;
    const codeBlock = position.parent;
    const lastBreak = position.nodeBefore;
    const priorBreak = lastBreak?.previousSibling;
    if (
        !codeBlock.is("element", "codeBlock") ||
        !lastBreak?.is("element", "softBreak") ||
        !priorBreak?.is("element", "softBreak")
    ) {
        return false;
    }
    editor.model.change((writer) => {
        writer.remove(
            writer.createRange(
                writer.createPositionBefore(priorBreak),
                writer.createPositionAfter(lastBreak),
            ),
        );
        const paragraph = writer.createElement("paragraph");
        writer.insert(paragraph, writer.createPositionAfter(codeBlock));
        writer.setSelection(paragraph, "in");
    });
    return true;
}

/**
 * When the caret is on an empty line (an empty paragraph) inside a quote, take that line out of the
 * quote: it becomes a normal paragraph after it, the quote is split around it when the line sits in
 * the middle, and an emptied quote goes away. CKEditor does this natively only on plain Enter and on
 * Backspace in the quote's *first* block; the chat routes Shift/Ctrl/Alt+Enter and Backspace through
 * keystrokes, so both ways out work on any empty quote line: `> quoted`, Shift+Enter, Backspace (or
 * Shift+Enter again), and what follows is no longer quoted. With `backspace`, the quote's first line
 * is left to CKEditor, which leaves the quote too, or takes back the `> ` autoformat just typed.
 * Returns whether it left the quote.
 */
export function leaveBlockQuoteFromEmptyLine(editor: CKTextEditor, { backspace = false } = {}): boolean {
    const selection = editor.model.document.selection;
    const block = selection.getFirstPosition()?.parent;
    if (
        !selection.isCollapsed ||
        !block?.is("element", "paragraph") ||
        !block.isEmpty ||
        block.hasAttribute("listItemId") ||
        !block.parent?.is("element", "blockQuote") ||
        (backspace && !block.previousSibling)
    ) {
        return false;
    }
    if (!editor.commands.get("blockQuote")?.isEnabled) return false;
    editor.execute("blockQuote", { forceValue: false });
    return true;
}
