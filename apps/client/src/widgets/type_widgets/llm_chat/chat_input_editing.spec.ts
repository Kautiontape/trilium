import {
    AttributeEditor as CKEditorAttributeEditor,
    CHAT_INPUT_PLUGINS,
} from "@triliumnext/ckeditor5";
import { _getModelData, _setModelData } from "ckeditor5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    insertNewBlock,
    isSelectionInCodeBlock,
    leaveBlockQuoteFromEmptyLine,
    outdentListItemAtStart,
} from "./chat_input_editing.js";
import { editorHtmlToMarkdown } from "./chat_input_markdown.js";

// Runs the real CKEditor (our chat plugin set) under happy-dom and asserts the model, so the
// list/code Enter behavior is verified deterministically rather than by hand in the app.
describe("chat input editing", () => {
    let editor: Awaited<ReturnType<typeof CKEditorAttributeEditor.create>>;

    beforeAll(async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await CKEditorAttributeEditor.create(el, {
            extraPlugins: CHAT_INPUT_PLUGINS,
            licenseKey: "GPL",
        });
    });

    afterAll(async () => {
        await editor.destroy();
    });

    describe("insertNewBlock", () => {
        it("splits a non-empty list item into a new item (so lists can be built)", () => {
            _setModelData(
                editor.model,
                '<paragraph listIndent="0" listItemId="a" listType="bulleted">item[]</paragraph>',
            );
            insertNewBlock(editor);
            expect(
                (_getModelData(editor.model).match(/listItemId=/g) ?? [])
                    .length,
            ).toBe(2);
        });

        it("leaves the list from an empty item (so the list can be exited)", () => {
            _setModelData(
                editor.model,
                '<paragraph listIndent="0" listItemId="a" listType="bulleted">[]</paragraph>',
            );
            insertNewBlock(editor);
            expect(_getModelData(editor.model)).not.toContain("listItemId");
        });

        it("adds a newline (soft break) inside a code block", () => {
            _setModelData(
                editor.model,
                '<codeBlock language="plaintext">foo[]</codeBlock>',
            );
            insertNewBlock(editor);
            const data = _getModelData(editor.model);
            expect(data).toContain("softBreak");
            expect(data).toContain("codeBlock");
        });

        it("keeps a single blank line in a code block instead of leaving (only exits after two)", () => {
            _setModelData(
                editor.model,
                '<codeBlock language="plaintext">foo<softBreak></softBreak>[]</codeBlock>',
            );
            insertNewBlock(editor);
            const data = _getModelData(editor.model);
            // Still in the block (no paragraph created), with a second line break — so a blank line can precede more code.
            expect(data).toContain("codeBlock");
            expect(data).not.toContain("<paragraph>");
            expect((data.match(/<softBreak>/g) ?? []).length).toBe(2);
        });

        it("leaves the code block after two trailing blank lines (so the fence can be exited)", () => {
            _setModelData(
                editor.model,
                '<codeBlock language="plaintext">foo<softBreak></softBreak><softBreak></softBreak>[]</codeBlock>',
            );
            insertNewBlock(editor);
            const data = _getModelData(editor.model);
            // Caret ends up in a fresh paragraph after the block, which keeps its content but drops the blank lines.
            expect(data).toContain("<paragraph>[]</paragraph>");
            expect(data).toContain("foo</codeBlock>");
            expect(data).not.toContain("softBreak");
        });

        it("leaves a block quote from an empty quote line (so the quote can be exited)", () => {
            _setModelData(
                editor.model,
                "<blockQuote><paragraph>quoted</paragraph><paragraph>[]</paragraph></blockQuote>",
            );
            insertNewBlock(editor);
            // The empty line leaves the quote and the caret lands in it, after the quote.
            expect(_getModelData(editor.model)).toBe(
                "<blockQuote><paragraph>quoted</paragraph></blockQuote><paragraph>[]</paragraph>",
            );
        });

        it("splits a quote line into a new quote line when the line has text", () => {
            _setModelData(
                editor.model,
                "<blockQuote><paragraph>quoted[]</paragraph></blockQuote>",
            );
            insertNewBlock(editor);
            expect(_getModelData(editor.model)).toBe(
                "<blockQuote><paragraph>quoted</paragraph><paragraph>[]</paragraph></blockQuote>",
            );
        });

        it("splits the quote around an empty line in its middle", () => {
            _setModelData(
                editor.model,
                "<blockQuote><paragraph>a</paragraph><paragraph>[]</paragraph><paragraph>b</paragraph></blockQuote>",
            );
            insertNewBlock(editor);
            expect(_getModelData(editor.model)).toBe(
                "<blockQuote><paragraph>a</paragraph></blockQuote><paragraph>[]</paragraph><blockQuote><paragraph>b</paragraph></blockQuote>",
            );
        });

        it("splits a plain paragraph into a new paragraph", () => {
            _setModelData(editor.model, "<paragraph>hello[]</paragraph>");
            insertNewBlock(editor);
            expect(
                (_getModelData(editor.model).match(/<paragraph/g) ?? []).length,
            ).toBe(2);
        });
    });

    describe("isSelectionInCodeBlock", () => {
        it("is true inside a code block and false elsewhere", () => {
            _setModelData(
                editor.model,
                '<codeBlock language="plaintext">foo[]</codeBlock>',
            );
            expect(isSelectionInCodeBlock(editor)).toBe(true);
            _setModelData(editor.model, "<paragraph>foo[]</paragraph>");
            expect(isSelectionInCodeBlock(editor)).toBe(false);
        });
    });

    describe("outdentListItemAtStart", () => {
        it("leaves the list from the start of an item (instead of merging into the previous one)", () => {
            _setModelData(
                editor.model,
                '<paragraph listIndent="0" listItemId="a" listType="bulleted">[]item</paragraph>',
            );
            expect(outdentListItemAtStart(editor)).toBe(true);
            expect(_getModelData(editor.model)).not.toContain("listItemId");
        });

        it("does nothing when the caret is not at the start of the item", () => {
            _setModelData(
                editor.model,
                '<paragraph listIndent="0" listItemId="a" listType="bulleted">it[]em</paragraph>',
            );
            expect(outdentListItemAtStart(editor)).toBe(false);
            expect(_getModelData(editor.model)).toContain("listItemId");
        });

        it("does nothing outside a list", () => {
            _setModelData(editor.model, "<paragraph>[]text</paragraph>");
            expect(outdentListItemAtStart(editor)).toBe(false);
        });
    });
    describe("leaveBlockQuoteFromEmptyLine (Backspace)", () => {
        it("turns an empty quote line into a normal line, where CKEditor would merge it into the line above", () => {
            _setModelData(
                editor.model,
                "<blockQuote><paragraph>quoted</paragraph><paragraph>[]</paragraph></blockQuote>",
            );
            expect(leaveBlockQuoteFromEmptyLine(editor, { backspace: true })).toBe(true);
            expect(_getModelData(editor.model)).toBe(
                "<blockQuote><paragraph>quoted</paragraph></blockQuote><paragraph>[]</paragraph>",
            );
        });

        it("leaves the quote's first line to CKEditor, which can take back the `> ` just typed", () => {
            _setModelData(editor.model, "<blockQuote><paragraph>[]</paragraph></blockQuote>");
            expect(leaveBlockQuoteFromEmptyLine(editor, { backspace: true })).toBe(false);
            // Shift+Enter still leaves from it.
            expect(leaveBlockQuoteFromEmptyLine(editor)).toBe(true);
            expect(_getModelData(editor.model)).toBe("<paragraph>[]</paragraph>");
        });

        it("does nothing on a quote line with text, outside a quote, or in a list inside a quote", () => {
            _setModelData(editor.model, "<blockQuote><paragraph>a</paragraph><paragraph>quoted[]</paragraph></blockQuote>");
            expect(leaveBlockQuoteFromEmptyLine(editor, { backspace: true })).toBe(false);
            _setModelData(editor.model, "<paragraph>a</paragraph><paragraph>[]</paragraph>");
            expect(leaveBlockQuoteFromEmptyLine(editor, { backspace: true })).toBe(false);
            _setModelData(
                editor.model,
                '<blockQuote><paragraph>a</paragraph><paragraph listIndent="0" listItemId="x" listType="bulleted">[]</paragraph></blockQuote>',
            );
            expect(leaveBlockQuoteFromEmptyLine(editor, { backspace: true })).toBe(false);
        });

        it("ends the quote where he left it: `> Quoted quoted quoted`, Shift+Enter, Backspace, `normal normal normal`", () => {
            _setModelData(editor.model, "<blockQuote><paragraph>Quoted quoted quoted[]</paragraph></blockQuote>");
            insertNewBlock(editor); // Shift+Enter
            expect(leaveBlockQuoteFromEmptyLine(editor, { backspace: true })).toBe(true); // Backspace
            editor.model.change((writer) => {
                writer.insertText("normal normal normal", editor.model.document.selection.getFirstPosition()!);
            });
            expect(editorHtmlToMarkdown(editor.getData())).toBe("> Quoted quoted quoted\n\nnormal normal normal");
        });

        it("ends the quote the same way with Shift+Enter twice", () => {
            _setModelData(editor.model, "<blockQuote><paragraph>Quoted quoted quoted[]</paragraph></blockQuote>");
            insertNewBlock(editor);
            insertNewBlock(editor);
            editor.model.change((writer) => {
                writer.insertText("normal normal normal", editor.model.document.selection.getFirstPosition()!);
            });
            expect(editorHtmlToMarkdown(editor.getData())).toBe("> Quoted quoted quoted\n\nnormal normal normal");
        });
    });
});
