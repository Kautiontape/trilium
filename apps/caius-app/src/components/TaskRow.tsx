import "./task_row.css";

import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";

import type { PlanTask } from "../lib/caius.js";
import { held, taskKey } from "../lib/store.js";
import { Est, haptic, StateGlyph } from "./ui.js";

/**
 * A task row: its state glyph, words, estimate and a line of detail. Swipe right and left run the
 * row's two quick actions (Done and Forward on a task, Accept and Dismiss on a suggestion); the
 * threshold ticks once. A tap opens the task sheet. Rows of finished tasks don't swipe.
 */
export function TaskRow({ task, variant = "list", detail, top, onOpen, right, left, trailing }: {
    task: PlanTask;
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
    const { text, forwardedTo } = displayText(task.text);
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
                        {text}
                    </div>
                    {forwardedTo ? <div class="task-row-detail">Forwarded → {forwardedTo}</div> : detail && <div class="task-row-detail">{detail}</div>}
                </div>
                {trailing ?? (live ? <Est minutes={task.estMinutes} /> : null)}
            </div>
        </div>
    );
}

/**
 * A task's words as the row shows them. A forwarded task (state `tombstone`) keeps Caius's marker
 * in its text, `_scheduled [Thu 5 Nov](#root/…)_`; the row shows the day it went to instead, and
 * links as their labels.
 */
export function displayText(raw: string): { text: string; forwardedTo: string | null } {
    const marker = /\s*_?(?:re)?scheduled\s+\[([^\]]+)\]\([^)]*\)_?/i.exec(raw);
    const rest = marker ? raw.replace(marker[0], "").replace(/\s~\d+(?:h\d+m|h|m)\b/g, "") : raw;
    return { text: rest.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim(), forwardedTo: marker ? marker[1] : null };
}

export interface SwipeAction {
    label: string;
    tone: "moss" | "dusk" | "clay" | "berry";
    run: () => void;
}
