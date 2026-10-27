/**
 * What a Caius forward writes, saved again by a real CKEditor with the fork's link, reference link,
 * italic and task state plugins: what `EditableText` stores the next time the note is saved.
 */
import { hasCopy, insertCopy, markRescheduled } from "@triliumnext/caius";
import ItalicAsEmPlugin from "@triliumnext/ckeditor5/src/plugins/italic_as_em.js";
import ReferenceLink from "@triliumnext/ckeditor5/src/plugins/referencelink.js";
import TodoListMultistateEditing from "@triliumnext/ckeditor5/src/plugins/todo_list_multistate/todo_list_multistate_editing.js";
import { ClassicEditor, Essentials, Heading, Italic, Link, List, Paragraph, TodoList } from "ckeditor5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const STATES = new Map([ [ "doing", "/" ], [ "cancelled", "-" ], [ "_rescheduled", ">" ] ]);
const SOURCE = "<h3>Work</h3><ul class=\"todo-list\"><li data-list-item-id=\"eone\"><label class=\"todo-list__label\">"
    + "<input type=\"checkbox\" disabled=\"disabled\">"
    + "<span class=\"todo-list__label__description\">Ship &amp; tell</span></label></li></ul>";

describe("a Caius forward saved by the editor", () => {
    let editor: ClassicEditor;

    beforeAll(async () => {
        // `ReferenceLink` asks for a note's title when it renders or saves a reference link.
        vi.stubGlobal("glob", {
            getReferenceLinkTitleSync: () => "26 - Monday",
            getComponentByEl: () => ({ loadReferenceLinkTitle: () => {} })
        });
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await ClassicEditor.create(el, {
            plugins: [
                Essentials, Paragraph, Heading, List, TodoList, TodoListMultistateEditing,
                Italic, ItalicAsEmPlugin, Link, ReferenceLink
            ],
            licenseKey: "GPL",
            taskStates: [
                { name: "doing", title: "Doing", markdownSymbol: "/", isCompleted: false, icon: "bx" },
                { name: "_rescheduled", title: "Rescheduled", markdownSymbol: ">", isCompleted: true, icon: "bx" }
            ]
        } as never);
    });

    afterAll(async () => {
        await editor.destroy();
    });

    function save(html: string) {
        editor.setData(html);
        return editor.getData();
    }

    it("keeps the italic \"scheduled\" link's text and target, which the library still reads", () => {
        const marked = markRescheduled(SOURCE, "eone", { targetNoteId: "tgtnote", targetLabel: "Tuesday 27", states: STATES });
        if (!marked.ok) throw new Error(marked.reason);

        const saved = save(marked.html);
        expect(saved).toContain("<em>scheduled </em><a href=\"#root/tgtnote\"><em>Tuesday 27</em></a>");
        expect(saved).not.toContain("reference-link");
        expect(save(saved)).toBe(saved);
        expect(markRescheduled(saved, "eone", { targetNoteId: "tgtnote", targetLabel: "Tuesday 27", states: STATES }))
            .toEqual({ ok: false, reason: "already_moved", scheduledTo: [ "tgtnote" ] });
    });

    it("keeps the copy's \"from\" link, which the library still recognises as the copy", () => {
        const copied = insertCopy("<h3>Work</h3>", SOURCE, "eone", { sourceNoteId: "srcnote", sourceLabel: "Monday 26", states: STATES });
        if (!copied.ok) throw new Error(copied.reason);

        const saved = save(copied.html);
        expect(saved).toContain("Ship &amp; tell <a href=\"#root/srcnote\">from Monday 26</a>");
        expect(hasCopy(saved, SOURCE, "eone", "srcnote")).toBe(true);
    });

    it("still reads the reference links written before, after the editor has replaced their text", () => {
        const old = SOURCE.replace("Ship &amp; tell", "Ship &amp; tell <em>scheduled <a class=\"reference-link\" href=\"#root/tgtnote\">Tuesday 27</a></em>")
            .replace("<li data-list-item-id=\"eone\">", "<li data-list-item-id=\"eone\" data-trilium-task-state=\"_rescheduled\">");
        const saved = save(old);
        expect(saved).toContain("<em>scheduled&nbsp;</em><a class=\"reference-link\" href=\"#root/tgtnote\">26 - Monday</a>");
        expect(markRescheduled(saved, "eone", { targetNoteId: "tgtnote", targetLabel: "Tuesday 27", states: STATES }))
            .toMatchObject({ reason: "already_moved", scheduledTo: [ "tgtnote" ] });

        const oldCopy = SOURCE.replace("Ship &amp; tell", "Ship &amp; tell <a class=\"reference-link\" href=\"#root/srcnote\">from Monday 26</a>")
            .replace("eone", "ecopy");
        expect(hasCopy(save(oldCopy), SOURCE, "eone", "srcnote")).toBe(true);
    });
});
