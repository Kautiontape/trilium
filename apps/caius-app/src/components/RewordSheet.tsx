import "./reword_sheet.css";

import { useEffect, useRef, useState } from "preact/hooks";

import type { PlanTask } from "../lib/caius.js";
import { api, holdReword, refOf } from "../lib/store.js";
import { displayText } from "./TaskRow.js";
import { Button, closeSheet, SheetTitle } from "./ui.js";

/** Edits a task's words: Save holds the reword behind Undo, and the server keeps the rest of the line. */
export function RewordSheet({ task }: { task: PlanTask }) {
    const original = displayText(task.text).text;
    const [ text, setText ] = useState(original);
    const input = useRef<HTMLTextAreaElement>(null);
    const words = text.trim();
    const canSave = words !== "" && words !== original;

    useEffect(() => {
        input.current?.focus();
    }, []);

    const save = () => {
        const ref = refOf(task);
        if (!ref || !canSave) {
            return;
        }
        closeSheet();
        holdReword(ref, words, () => api().reword([ { ...ref, text: words } ]));
    };

    return (
        <div class="reword-sheet">
            <SheetTitle title="Edit" />
            <textarea
                ref={input}
                class="field reword-sheet-text"
                rows={3}
                value={text}
                aria-label="Task words"
                onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        save();
                    }
                }}
            />
            <Button kind="primary" disabled={!canSave} onClick={save}>Save</Button>
        </div>
    );
}
