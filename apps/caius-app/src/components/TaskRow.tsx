import "./task_row.css";

import type { ViewTask } from "@triliumnext/caius/src/daily/views.js";
import { type Area, bareText, markedArea } from "@triliumnext/caius/src/trilium/areas.js";
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";

import type { PlanTask } from "../lib/caius.js";
import { held, rewording, taskKey } from "../lib/store.js";
import { Est, haptic, StateGlyph } from "./ui.js";

/**
 * A task row: its state glyph, words, estimate and a line of detail. Swipe right and left run the
 * row's two quick actions (Done and Forward on a task, Accept and Dismiss on a suggestion); the
 * threshold ticks once. A tap opens the task sheet. Rows of finished tasks don't swipe. A view's
 * row (`ViewTask`) also shows the Important mark, its clock, its slip count and its ticket.
 */
export function TaskRow({ task, variant = "list", detail, top, onOpen, right, left, trailing }: {
    task: PlanTask | ViewTask;
    variant?: "list" | "critical" | "onDeck" | "suggested";
    detail?: ComponentChildren;
    /** Its place in the Top 3, if it has one. */
    top?: number;
    onOpen?: () => void;
    right?: SwipeAction;
    left?: SwipeAction;
    trailing?: ComponentChildren;
}) {
    const heldState = held.value[taskKey(task)];
    const live = (task.state === "open" || task.state === "in_progress") && !heldState;
    const [ dx, setDx ] = useState(0);
    const drag = useRef<{ x: number; y: number; id: number; horizontal: boolean | null; ticked: boolean } | null>(null);
    const rowRef = useRef<HTMLDivElement>(null);
    /** Set by a horizontal drag, so the click that ends it doesn't open the sheet. */
    const dragged = useRef(false);

    const threshold = () => (rowRef.current?.offsetWidth ?? 360) * 0.32;

    const onPointerDown = (e: PointerEvent) => {
        dragged.current = false;
        if (!live || (!right && !left)) {
            return;
        }
        drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null, ticked: false };
    };
    const onPointerMove = (e: PointerEvent) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) {
            return;
        }
        const x = e.clientX - d.x;
        const y = e.clientY - d.y;
        if (d.horizontal === null && Math.hypot(x, y) > 8) {
            d.horizontal = Math.abs(x) > Math.abs(y);
            if (d.horizontal) {
                dragged.current = true;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }
        }
        if (!d.horizontal) {
            return;
        }
        const allowed = (x > 0 && right) || (x < 0 && left) ? x : 0;
        setDx(allowed);
        const past = Math.abs(allowed) >= threshold();
        if (past && !d.ticked) {
            haptic("tick");
        }
        d.ticked = past;
    };
    const onPointerUp = () => {
        const d = drag.current;
        drag.current = null;
        if (!d?.horizontal) {
            setDx(0);
            return;
        }
        const action = dx >= threshold() ? right : dx <= -threshold() ? left : undefined;
        setDx(0);
        action?.run();
    };

    const shownState = heldState === "dismissed" ? "cancelled" : task.state;
    const { text: ownText, forwardedTo, area: marked } = displayText(task.text);
    const text = rewording.value[taskKey(task)] ?? ownText;
    const area = task.area && task.area !== "foundation" ? task.area : marked;
    const view = isViewTask(task) ? task : null;
    const slips = view ? slipLabel(view.slips) : null;
    return (
        <div class={`task-row-wrap${dx ? " dragging" : ""}`}>
            {dx > 0 && right && <div class={`swipe-under swipe-right tone-${right.tone}`} aria-hidden="true">{right.label}</div>}
            {dx < 0 && left && <div class={`swipe-under swipe-left tone-${left.tone}`} aria-hidden="true">{left.label}</div>}
            <div
                ref={rowRef}
                class={`task-row variant-${variant} state-${heldState ?? task.state}${task.parent ? " sub" : ""}`}
                style={dx ? { transform: `translateX(${dx}px)` } : undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onClick={() => {
                    if (dragged.current) {
                        dragged.current = false;
                        return;
                    }
                    onOpen?.();
                }}
                role="button"
                tabIndex={0}
            >
                <StateGlyph state={shownState} held={heldState} />
                <div class="task-row-body">
                    <div class="task-row-text">
                        {top !== undefined && <span class="top-mark mono">{top}</span>}
                        {view?.critical && <span class="important-mark" role="img" aria-label="Important">!</span>}
                        {view?.at && <span class="row-clock mono">{view.at}</span>}
                        {area && <span class={`area-dot area-${area}`} role="img" aria-label={area === "growth" ? "Growth" : "Recharge"} />}
                        {text}
                        {slips && <span class="slip-count mono" title={`Moved ${view?.slips} times`}>{slips}</span>}
                        {view?.ticket && <span class="ticket-chip mono">{view.ticket.key}{view.ticket.status && ` · ${view.ticket.status}`}</span>}
                    </div>
                    {forwardedTo && task.state === "tombstone" ? <div class="task-row-detail">Forwarded → {forwardedTo}</div> : detail && <div class="task-row-detail">{detail}</div>}
                </div>
                {trailing ?? (live ? <Est minutes={task.estMinutes} /> : null)}
            </div>
        </div>
    );
}

/**
 * A task's words as the row shows them. A forwarded task (state `tombstone`) keeps Caius's marker
 * in its text, `_scheduled [Thu 5 Nov](#root/…)_` or, once the desktop editor has saved the note,
 * `_scheduled_ [_Thu 5 Nov_](#root/…)`; the row shows the day it went to instead, and links as
 * their labels. A marker is lower case, opens with an underscore that follows no letter, digit
 * or underscore, and links to a `#root/` note other than a "from …" link. So words typed as
 * `scheduled [Q4](#root/a)`, `word_scheduled [x](#root/a)`, a bare `_scheduled_` and
 * `scheduled [docs](https://…)` are not markers. A task forwarded again carries several; every
 * one is left out and the last names the day. A copy's "from …" link to where it came from is
 * left out: on a narrow row it only cuts the task off, and the task tray's From block carries
 * it. An estimate left at the end of the words once the markers are out, the shape older
 * snapshots hold (`… ~30m _scheduled […]_`), is left out; one in the middle is the user's own
 * and stays. A leading area marker and clock are left out too; the marker comes back as `area`
 * for the row to draw as a dot. Bold and italic marks are dropped, their words kept.
 */
export function displayText(raw: string): { text: string; forwardedTo: string | null; area?: Area } {
    const area = markedArea(raw) ?? undefined;
    raw = bareText(raw);
    const markers = [ ...raw.matchAll(FORWARD_MARKER) ];
    const kept = raw.replace(/\s*\[from\s[^\]]*\]\(#root\/[^)]*\)/i, "");
    let rest = kept;
    if (markers.length) {
        for (const marker of markers) {
            rest = rest.replace(marker[0], "");
        }
        rest = rest.replace(/\s~\d+(?:h\d+m|h|m)\s*$/, "");
    }
    const plain = rest.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        // A row is plain text: emphasis keeps its words and loses its marks; an underscore inside a word stays.
        .replace(/\*{1,3}(\S[^*]*?)\*{1,3}/g, "$1")
        .replace(/(?<![\p{L}\p{N}_])_(\S[^_]*?)_(?![\p{L}\p{N}_])/gu, "$1");
    return { text: plain.trim(), forwardedTo: markers.at(-1)?.[1] ?? null, area };
}

/** Caius's forward marker: lower case, opened by an underscore after no letter, digit or `_`. */
const FORWARD_MARKER =
    /\s*(?<![\p{L}\p{N}_])_(?:re)?scheduled_?\s+\[(?!_?from\s)_?([^\]]+?)_?\]\(#root\/[^)]*\)_?/gu;

function isViewTask(task: PlanTask | ViewTask): task is ViewTask {
    return "slips" in task;
}

export interface SwipeAction {
    label: string;
    tone: "moss" | "dusk" | "clay" | "berry";
    run: () => void;
}

/** A row's slip count, `↻3`: shown from 2 moves off day notes, since one move is just a day forwarded. */
export function slipLabel(slips: number): string | null {
    return slips >= 2 ? `↻${slips}` : null;
}
