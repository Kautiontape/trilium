/**
 * `EditableText` around a real CKEditor (the watchdog wrapper is replaced by a stub that builds one
 * from `ckeditor5`): the `saveNoteDetailNow` command.
 */
import { deferred } from "@triliumnext/commons";
import type { ClassicEditor } from "ckeditor5";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import Component from "../../../components/component";
import NoteContext from "../../../components/note_context";
import type FNote from "../../../entities/fnote";
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
    const initialContent = "<p>first</p><p>second</p>";
    const noteA = buildNote({ title: "Note A", type: "text", content: initialContent });
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
        await vi.waitFor(() => expect(editor().getData()).toBe(initialContent));
    }

    function editor() {
        if (!created.editor) throw new Error("Editor not created yet");
        return created.editor;
    }

    function cleanup() {
        render(null, container);
        container.remove();
    }

    return { noteA, parent, show, editor, cleanup };
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
});

function getRoot(editor: ClassicEditor) {
    const root = editor.model.document.getRoot();
    if (!root) throw new Error("No root");
    return root;
}
