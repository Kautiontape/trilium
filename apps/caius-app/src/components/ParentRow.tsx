import "./parent_row.css";

import { parentsOf } from "@triliumnext/caius/src/daily/load.js";
import type { ViewTask } from "@triliumnext/caius/src/daily/views.js";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

import type { PlanTask } from "../lib/caius.js";
import { readLocalList, writeLocal } from "../lib/local.js";
import { held, taskKey } from "../lib/store.js";
import { Est } from "./ui.js";

const OPEN_KEY = "openParents";

type AnyTask = PlanTask | ViewTask;

/** Draws one task as the screen's row; `trailing` replaces the row's own estimate. */
export type RowRenderer<T extends AnyTask> = (task: T, trailing?: ComponentChildren) => ComponentChildren;

/**
 * A parent as one row: its count and a chevron in the row's trailing slot, and its sub-items under
 * it, each drawn by `row`, once the chevron opens it. Which parents are open is kept on the phone
 * under `taskKey(parent)`; a parent starts folded.
 */
export function ParentRow<T extends AnyTask>({ parent, subs, row }: { parent: T; subs: T[]; row: RowRenderer<T> }) {
    const key = taskKey(parent);
    const [ open, setOpen ] = useState(() => readLocalList<string>(OPEN_KEY).includes(key));
    const toggle = (e: Event) => {
        e.stopPropagation();
        const next = !open;
        const keys = readLocalList<string>(OPEN_KEY).filter((k) => k !== key);
        writeLocal(OPEN_KEY, next ? [ ...keys, key ] : keys);
        setOpen(next);
    };
    const finished = parent.state === "done" || held.value[key] === "done";
    const live = !finished && (parent.state === "open" || parent.state === "in_progress") && !held.value[key];
    const trailing = (
        <>
            {live && <Est minutes={parent.estMinutes} />}
            <span class="parent-count mono">{countOf(parent, subs, finished)}</span>
            <button
                type="button"
                class={`parent-chevron${open ? " open" : ""}`}
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} sub-items of ${bareLabel(parent.text)}`}
                onClick={toggle}
                onPointerDown={(e) => e.stopPropagation()}
            >
                <span aria-hidden="true">▾</span>
            </button>
        </>
    );
    return (
        <div class="parent-group">
            {row(parent, trailing)}
            {open && <div class="parent-subs">{subs.map((sub) => row(sub))}</div>}
        </div>
    );
}

/**
 * `tasks` as the screen's rows: a task with sub-items in the list is a `ParentRow`, its sub-items
 * sit under it, and a sub-item whose parent is not in the list is a plain row.
 */
export function groupedRows<T extends AnyTask>(tasks: T[], row: RowRenderer<T>): ComponentChildren[] {
    const parents = parentsOf(tasks);
    const subs = new Map<T, T[]>();
    for (const [ sub, parent ] of parents) {
        subs.set(parent, [ ...(subs.get(parent) ?? []), sub ]);
    }
    return tasks
        .filter((task) => !parents.has(task))
        .map((task) => {
            const children = subs.get(task);
            return children
                ? <ParentRow key={taskKey(task)} parent={task} subs={children} row={row} />
                : row(task);
        });
}

/** `done/total` of the sub-items that are open, doing or done, or `N open` once the parent itself is done with some still open. */
function countOf(parent: AnyTask, subs: AnyTask[], finished: boolean) {
    const counted = subs.filter((s) => s.state === "open" || s.state === "in_progress" || s.state === "done");
    const open = counted.filter((s) => s.state !== "done").length;
    if (finished && open > 0) {
        return `${open} open`;
    }
    return `${counted.length - open}/${counted.length}`;
}

function bareLabel(text: string) {
    return text.replace(/[*_]/g, "").trim();
}
