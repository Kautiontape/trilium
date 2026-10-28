import {
    _getModelData, _setModelData, ClassicEditor, CodeBlock, Essentials, HorizontalLine, List,
    Paragraph, Table
} from "ckeditor5";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type FNote from "../../../entities/fnote";

vi.mock("../../../services/froca", () => ({
    default: { getNote: vi.fn() }
}));
vi.mock("../../../services/link", () => ({
    default: { createLink: vi.fn() }
}));
vi.mock("../../../services/content_renderer", () => ({
    default: { getRenderedContent: vi.fn(), disposeInteractiveContent: vi.fn() }
}));

import content_renderer from "../../../services/content_renderer";
import froca from "../../../services/froca";
import link from "../../../services/link";
import LoadResults from "../../../services/load_results";
import { loadIncludedNote, refreshChangedIncludes, setDataKeepingSelection } from "./utils";

const note = { noteId: "noteY" } as unknown as FNote;

describe("loadIncludedNote", () => {
    beforeEach(() => {
        vi.mocked(froca.getNote).mockResolvedValue(note);
        vi.mocked(link.createLink).mockResolvedValue($('<span class="link"><a href="#">noteY</a></span>'));
        vi.mocked(content_renderer.getRenderedContent).mockResolvedValue({ $renderedContent: $("<p>body</p>"), type: "text" } as never);
        vi.mocked(content_renderer.disposeInteractiveContent).mockReset();
    });

    it("reuses the wrapper element without nesting a second one (editing-view path)", async () => {
        // The editing-view downcast hands us the `.include-note-wrapper` element itself.
        const $el = $('<div class="include-note-wrapper">');

        await loadIncludedNote("noteY", $el, "small");

        const wrappers = $el.find(".include-note-wrapper");
        expect(wrappers.length).toBe(0);
        expect($el.children(".include-note-title").length).toBe(1);
        expect($el.children(".include-note-content").length).toBe(1);
    });

    it("builds a single wrapper inside the section (read-only / refresh path)", async () => {
        // The read-only and refresh paths hand us the outer `section.include-note`.
        const $el = $('<section class="include-note" data-note-id="noteY">');

        await loadIncludedNote("noteY", $el, "small");

        const wrappers = $el.find(".include-note-wrapper");
        expect(wrappers.length).toBe(1);
        expect(wrappers.children(".include-note-title").length).toBe(1);
        expect(wrappers.children(".include-note-content").length).toBe(1);
    });

    it("builds an expandable include (toggle) and degrades the note's own includes to reference links", async () => {
        const $el = $('<div class="include-note-wrapper">');

        await loadIncludedNote("noteY", $el, "expandable");

        // The expandable branch adds a title row with a toggle button.
        expect($el.children(".include-note-title-row").length).toBe(1);
        expect($el.find("button.include-note-toggle").length).toBe(1);
        // The included note is rendered with its own includes reduced to reference links.
        expect(content_renderer.getRenderedContent).toHaveBeenCalledWith(note, { interactive: true, includesAsReferenceLinks: true, mediaEnvironment: "embedded" });
    });

    it("disposes interactive content of a previous render before replacing it", async () => {
        const $el = $('<div class="include-note-wrapper">');

        await loadIncludedNote("noteY", $el, "small");

        expect(content_renderer.disposeInteractiveContent).toHaveBeenCalledWith($el);
    });
});

describe("refreshChangedIncludes", () => {
    beforeEach(() => {
        vi.mocked(froca.getNote).mockReset().mockResolvedValue(note);
        vi.mocked(link.createLink).mockResolvedValue($('<span class="link"><a href="#">noteY</a></span>'));
        vi.mocked(content_renderer.getRenderedContent).mockImplementation(async () => ({
            $renderedContent: $(`<div><p>new body</p><img src="api/attachments/att/image/terrain.svg"><img src="api/attachments/other/image/a.png"></div>`),
            type: "text"
        }) as never);
    });

    it("re-renders the includes whose note's content or attachments changed, in place", async () => {
        const container = document.createElement("div");
        container.innerHTML = `
            <section class="include-note" data-note-id="contentChanged" data-box-size="full"><div class="include-note-wrapper"><p>old body</p></div><div class="ck-widget__selection-handle"></div></section>
            <section class="include-note" data-note-id="attachmentChanged" data-box-size="full"><div class="include-note-wrapper"></div></section>
            <section class="include-note" data-note-id="unchanged" data-box-size="full"><div class="include-note-wrapper"><p>old body</p></div></section>`;
        const loadResults = new LoadResults([]);
        loadResults.addNoteContent("contentChanged", "NA");
        loadResults.addAttachmentRow({ attachmentId: "att", ownerId: "attachmentChanged" } as never);

        await refreshChangedIncludes(container, loadResults);

        expect(vi.mocked(froca.getNote).mock.calls.map(([ noteId ]) => noteId)).toEqual([ "contentChanged", "attachmentChanged" ]);
        const changed = container.querySelector("section[data-note-id=contentChanged]");
        expect(changed?.querySelector(".include-note-wrapper .include-note-content")?.textContent).toBe("new body");
        expect(changed?.querySelector(".ck-widget__selection-handle")).not.toBeNull();
        expect(container.querySelector("section[data-note-id=unchanged]")?.textContent).toBe("old body");

        // The changed attachment keeps its URL, so its image is asked for anew.
        const images = [ ...container.querySelectorAll("section[data-note-id=attachmentChanged] img") ].map((img) => img.getAttribute("src"));
        expect(images[0]).toMatch(/^api\/attachments\/att\/image\/terrain\.svg\?timestamp=\d+$/);
        expect(images[1]).toBe("api/attachments/other/image/a.png");

        // A later render of the include, such as the editor reloading the including note, keeps it.
        const $later = $('<div class="include-note-wrapper">');
        await loadIncludedNote("attachmentChanged", $later, "full");
        expect($later.find("img").first().attr("src")).toBe(images[0]);
    });
});

describe("setDataKeepingSelection", () => {
    let editor: ClassicEditor;

    beforeAll(async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await ClassicEditor.create(el, {
            plugins: [ Essentials, Paragraph, Table, List, CodeBlock, HorizontalLine ],
            licenseKey: "GPL"
        });
    });

    afterAll(async () => {
        await editor.destroy();
    });

    function reload(data: string) {
        setDataKeepingSelection(editor, data);
        return _getModelData(editor.model);
    }

    /** How far `model.document.version` moves, which is the number of operations applied. */
    function operationsApplied(run: () => void) {
        const before = editor.model.document.version;
        run();
        return editor.model.document.version - before;
    }

    it("keeps a collapsed caret where it was, applying no operations beyond setData()", () => {
        const initial = "<paragraph>first</paragraph><paragraph>sec[]ond</paragraph>";
        const data = "<p>first, edited on the server</p><p>second</p>";

        _setModelData(editor.model, initial);
        const plain = operationsApplied(() => editor.setData(data));
        _setModelData(editor.model, initial);
        const keeping = operationsApplied(() => setDataKeepingSelection(editor, data));

        // An operation would fire `change:data` and schedule a save.
        expect(keeping).toBe(plain);
        expect(_getModelData(editor.model)).toBe(
            "<paragraph>first, edited on the server</paragraph><paragraph>sec[]ond</paragraph>"
        );
    });

    it("keeps a backward selection backward", () => {
        _setModelData(editor.model, "<paragraph>one</paragraph><paragraph>two three</paragraph>");
        editor.model.change((writer) => {
            const root = editor.model.document.getRoot();
            if (!root) throw new Error("No root");
            writer.setSelection(writer.createRange(
                writer.createPositionFromPath(root, [ 0, 1 ]),
                writer.createPositionFromPath(root, [ 1, 3 ])
            ), { backward: true });
        });

        expect(reload("<p>one</p><p>two three</p>"))
            .toBe("<paragraph>o[ne</paragraph><paragraph>two] three</paragraph>");
        expect(editor.model.document.selection.isBackward).toBe(true);
    });

    it("clamps a selection the new document is too short for, instead of throwing", () => {
        _setModelData(
            editor.model,
            "<paragraph>a</paragraph><paragraph>b</paragraph><paragraph>long [text] end</paragraph>"
        );

        expect(reload("<p>a</p><p>bc</p>"))
            .toBe("<paragraph>a</paragraph><paragraph>bc[]</paragraph>");

        _setModelData(
            editor.model,
            "<paragraph>a</paragraph><paragraph>a much longer line[]</paragraph>"
        );

        expect(reload("<p>a</p><p>short</p>"))
            .toBe("<paragraph>a</paragraph><paragraph>short[]</paragraph>");
    });

    it("follows its block when blocks are inserted or removed above it", () => {
        _setModelData(editor.model, "<paragraph>a</paragraph><paragraph>b[]c</paragraph>");
        expect(reload("<p>new</p><p>a</p><p>bc</p>"))
            .toBe("<paragraph>new</paragraph><paragraph>a</paragraph><paragraph>b[]c</paragraph>");

        _setModelData(
            editor.model,
            "<paragraph>x</paragraph><paragraph>a</paragraph><paragraph>b[]c</paragraph>"
        );
        expect(reload("<p>a</p><p>bc</p>"))
            .toBe("<paragraph>a</paragraph><paragraph>b[]c</paragraph>");
    });

    it("stays put when only blocks below it change", () => {
        _setModelData(editor.model, "<paragraph>a[]b</paragraph><paragraph>c</paragraph>");
        expect(reload("<p>ab</p><p>c, edited</p><p>new</p>")).toBe(
            "<paragraph>a[]b</paragraph><paragraph>c, edited</paragraph><paragraph>new</paragraph>"
        );
    });

    it("follows a caret in a code block", () => {
        const codeBlock = (text: string) => `<codeBlock language="plaintext">${text}</codeBlock>`;
        _setModelData(editor.model, `<paragraph>p</paragraph>${codeBlock("const[] x")}`);

        const pre = "<pre><code class=\"language-plaintext\">const x</code></pre>";
        expect(reload(`<p>new</p><p>p</p>${pre}`))
            .toBe(`<paragraph>new</paragraph><paragraph>p</paragraph>${codeBlock("const[] x")}`);
    });

    it("follows a list item that moved, by its list item id", () => {
        _setModelData(editor.model, listBlock("a", "alpha") + listBlock("b", "be[]ta"));

        const item = (id: string, text: string) => `<li data-list-item-id="${id}">${text}</li>`;
        const reordered = `<ul>${item("b", "beta")}${item("a", "alpha")}</ul>`;
        expect(reload(reordered)).toBe(listBlock("b", "be[]ta") + listBlock("a", "alpha"));
    });

    it("tells list items with the same text apart by their ids", () => {
        _setModelData(editor.model, listBlock("r1", "Review") + listBlock("r2", "Rev[]iew"));

        const item = (id: string) => `<li data-list-item-id="${id}">Review</li>`;
        expect(reload(`<ul>${item("r3")}${item("r1")}${item("r2")}</ul>`)).toBe(
            listBlock("r3", "Review") + listBlock("r1", "Review") + listBlock("r2", "Rev[]iew")
        );
    });

    it("matches unchanged list items by text when the content has no list item ids", () => {
        _setModelData(
            editor.model,
            `${listBlock("a", "one")}<paragraph>be[]tween</paragraph>${listBlock("b", "two")}`
        );
        reload("<p>new</p><ul><li>one</li></ul><p>between</p><ul><li>two</li></ul>");

        expect(editor.model.document.selection.getFirstPosition()?.path).toEqual([ 2, 2 ]);
    });

    it("lands inside a table that replaced the caret's paragraph", () => {
        _setModelData(editor.model, "<paragraph>a</paragraph><paragraph>b[]c</paragraph>");

        expect(reload(`<p>a</p>${tableHtml("x")}`)).toBe(
            "<paragraph>a</paragraph>"
            + "<table><tableRow><tableCell><paragraph>x[]</paragraph></tableCell></tableRow>"
            + "</table>"
        );
    });

    it("keeps a selected object selected", () => {
        const hr = "<horizontalLine></horizontalLine>";
        _setModelData(editor.model, `<paragraph>a</paragraph>[${hr}]<paragraph>b</paragraph>`);

        expect(reload("<p>new</p><p>a</p><hr><p>b</p>")).toBe(
            `<paragraph>new</paragraph><paragraph>a</paragraph>[${hr}]<paragraph>b</paragraph>`
        );
    });

    it("keeps every selected table cell selected", () => {
        const cell = (text: string) => `<tableCell><paragraph>${text}</paragraph></tableCell>`;
        const table = `<table><tableRow>[${cell("x")}][${cell("y")}]</tableRow></table>`;
        _setModelData(editor.model, `<paragraph>a</paragraph>${table}`);

        expect(reload(`<p>new</p><p>a</p>${tableHtml("x", "y")}`))
            .toBe(`<paragraph>new</paragraph><paragraph>a</paragraph>${table}`);
    });
});

function listBlock(listItemId: string, text: string) {
    const attributes = `listIndent="0" listItemId="${listItemId}" listType="bulleted"`;
    return `<paragraph ${attributes}>${text}</paragraph>`;
}

function tableHtml(...cells: string[]) {
    const row = cells.map((cell) => `<td>${cell}</td>`).join("");
    return `<figure class="table"><table><tbody><tr>${row}</tr></tbody></table></figure>`;
}
