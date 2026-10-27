/**
 * `EditableText` around a real CKEditor (the watchdog wrapper is replaced by a stub that builds one
 * from `ckeditor5`): the `saveNoteDetailNow` command and what a content reload does to the caret.
 */
import { deferred } from "@triliumnext/commons";
import type { ClassicEditor } from "ckeditor5";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import Component from "../../../components/component";
import NoteContext from "../../../components/note_context";
import FBlob from "../../../entities/fblob";
import type FNote from "../../../entities/fnote";
import LoadResults from "../../../services/load_results";
import server from "../../../services/server";
import { buildNote } from "../../../test/easy-froca";
import { ParentComponent } from "../../react/react_utils";
import EditableText from "./EditableText";

/** The CKEditor instance the stub below built most recently. */
const created = vi.hoisted(() => ({ editor: undefined as ClassicEditor | undefined }));

vi.mock("@triliumnext/ckeditor5", () => ({}));
vi.mock("./snippets.js", () => ({ default: async () => [], updateTemplateCache: vi.fn() }));
vi.mock("./CKEditorWithWatchdog", async () => {
    const { useEffect } = await import("preact/hooks");
    const { ClassicEditor, Essentials, Paragraph } = await import("ckeditor5");

    function CKEditorStub({ watchdogRef, onChange, onEditorInitialized }: {
        watchdogRef: { current: unknown };
        onChange: () => void;
        onEditorInitialized?: (editor: ClassicEditor) => void;
    }) {
        useEffect(() => {
            const el = document.createElement("div");
            document.body.appendChild(el);
            const config = { plugins: [ Essentials, Paragraph ], licenseKey: "GPL" };
            const editorPromise = ClassicEditor.create(el, config)
                .then((editor) => {
                    created.editor = editor;
                    watchdogRef.current = { editor };
                    editor.model.document.on("change:data", () => onChange());
                    onEditorInitialized?.(editor);
                    return editor;
                });
            return () => {
                editorPromise.then((editor) => editor.destroy());
            };
        }, []);
        return null;
    }

    return { default: CKEditorStub };
});

vi.stubGlobal("logError", vi.fn());
vi.stubGlobal("logInfo", vi.fn());

function setupHarness() {
    const initialContent = { a: "<p>first</p><p>second</p>", b: "<p>other note</p>" };
    const noteA = buildNote({ title: "Note A", type: "text", content: initialContent.a });
    const noteB = buildNote({ title: "Note B", type: "text", content: initialContent.b });
    const parent = new Component();
    const noteContext = new NoteContext("editable-ntx");
    const container = document.createElement("div");
    document.body.appendChild(container);

    async function show(note: FNote) {
        await act(async () => {
            render(
                <ParentComponent.Provider value={parent}>
                    <EditableText
                        note={note}
                        noteContext={noteContext}
                        ntxId={noteContext.ntxId}
                        parentComponent={parent}
                        viewScope={undefined}
                    />
                </ParentComponent.Provider>,
                container
            );
        });
        const expected = note === noteA ? initialContent.a : initialContent.b;
        await vi.waitFor(() => expect(editor().getData()).toBe(expected));
    }

    function editor() {
        if (!created.editor) throw new Error("Editor not created yet");
        return created.editor;
    }

    /** A write to `note` made elsewhere (ETAPI, another client), as the WebSocket delivers it. */
    async function reloadFromServer(note: FNote, newContent: string) {
        note.getBlob = async () => blobOf(note, newContent);
        const loadResults = new LoadResults([]);
        loadResults.addNoteContent(note.noteId, "other-component");
        await act(async () => {
            await parent.handleEvent("entitiesReloaded", { loadResults });
        });
        await vi.waitFor(() => expect(editor().getData()).toBe(newContent));
    }

    function cleanup() {
        render(null, container);
        container.remove();
    }

    return { noteA, noteB, parent, show, editor, reloadFromServer, cleanup };
}

let cleanupHarness: (() => void) | undefined;
afterEach(() => {
    cleanupHarness?.();
    cleanupHarness = undefined;
    created.editor = undefined;
    vi.restoreAllMocks();
});

describe("EditableText", () => {
    it("resolves saveNoteDetailNow only once the pending change is saved", async () => {
        const harness = setupHarness();
        cleanupHarness = harness.cleanup;
        await harness.show(harness.noteA);

        const put = deferred<void>();
        const putSpy = vi.spyOn(server, "put").mockReturnValue(put);

        const editor = harness.editor();
        editor.model.change((writer) => {
            writer.insertText(" typed", writer.createPositionFromPath(getRoot(editor), [ 0, 5 ]));
        });

        let settled = false;
        // `cuttonote.ts` triggers the command from the editor package, outside `CommandMappings`.
        const triggered = harness.parent.triggerCommand("saveNoteDetailNow" as never);
        const command = Promise.resolve(triggered).then(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);

        put.resolve();
        await command;
        expect(settled).toBe(true);
    });

    it("keeps the caret when the open note reloads, but not across a note switch", async () => {
        const harness = setupHarness();
        cleanupHarness = harness.cleanup;
        await harness.show(harness.noteA);
        vi.spyOn(server, "put").mockResolvedValue(undefined);

        const editor = harness.editor();
        editor.model.change((writer) => {
            writer.setSelection(writer.createPositionFromPath(getRoot(editor), [ 1, 3 ]));
        });

        await harness.reloadFromServer(harness.noteA, "<p>first [server]</p><p>second</p>");
        expect(editor.model.document.selection.getFirstPosition()?.path).toEqual([ 1, 3 ]);

        await harness.show(harness.noteB);
        expect(editor.model.document.selection.getFirstPosition()?.path).toEqual([ 0, 0 ]);
    });
});

function getRoot(editor: ClassicEditor) {
    const root = editor.model.document.getRoot();
    if (!root) throw new Error("No root");
    return root;
}

function blobOf(note: FNote, newContent: string) {
    return new FBlob({
        blobId: `blob-${note.noteId}-${newContent.length}`,
        content: newContent,
        contentLength: newContent.length,
        dateModified: new Date().toISOString(),
        utcDateModified: new Date().toISOString()
    });
}
