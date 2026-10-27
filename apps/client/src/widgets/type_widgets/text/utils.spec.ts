import { _getModelData, _setModelData, ClassicEditor, Essentials, Paragraph } from "ckeditor5";
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
import { loadIncludedNote, setDataKeepingSelection } from "./utils";

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

describe("setDataKeepingSelection", () => {
    let editor: ClassicEditor;

    beforeAll(async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await ClassicEditor.create(el, {
            plugins: [ Essentials, Paragraph ],
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

    it("keeps a collapsed caret where it was, without an undo step or a data change", () => {
        _setModelData(editor.model, "<paragraph>first</paragraph><paragraph>sec[]ond</paragraph>");
        let dataChanges = 0;
        const countChange = () => dataChanges++;
        editor.model.document.on("change:data", countChange);

        const result = reload("<p>first, edited on the server</p><p>second</p>");
        editor.model.document.off("change:data", countChange);

        expect(result).toBe(
            "<paragraph>first, edited on the server</paragraph><paragraph>sec[]ond</paragraph>"
        );
        // The one data change is setData() itself.
        expect(dataChanges).toBe(1);
        expect(editor.commands.get("undo")?.isEnabled).toBe(false);
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
});
