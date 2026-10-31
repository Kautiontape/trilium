import "./ui.css";

import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { signal } from "@preact/signals";
import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";

import type { PlanTask } from "../lib/caius.js";
import { type HeldState, settings, snack } from "../lib/store.js";

export function Button({ kind = "secondary", children, class: className, ...rest }: {
    kind?: "primary" | "secondary" | "quiet" | "danger";
    children: ComponentChildren;
} & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
    return <button type="button" class={`btn btn-${kind} ${className ?? ""}`} {...rest}>{children}</button>;
}

export function Chip({ selected, children, ...rest }: { selected?: boolean; children: ComponentChildren } & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
    return <button type="button" class={`chip${selected ? " selected" : ""}`} aria-pressed={selected} {...rest}>{children}</button>;
}

export function Card({ children, class: className, tone }: { children: ComponentChildren; class?: string; tone?: "clay" | "dusk" | "ochre" | "moss" }) {
    return <section class={`card ${tone ? `card-${tone}` : ""} ${className ?? ""}`}>{children}</section>;
}

/** A task's state as its glyph: ○ open, ◐ Doing, ● Done, → forwarded, ✕ dropped. Never colour alone. */
export function StateGlyph({ state, held }: { state: PlanTask["state"]; held?: HeldState }) {
    const shown = held === "done" ? "done" : held === "forwarded" ? "rescheduled" : state;
    const glyph = shown === "done" ? "●" : shown === "in_progress" ? "◐" : shown === "rescheduled" ? "→" : shown === "cancelled" ? "✕" : "○";
    return <span class={`glyph glyph-${shown}`} aria-hidden="true">{glyph}</span>;
}

/** `~45m`, or an ochre `~?` when the task has no estimate. */
export function Est({ minutes }: { minutes: number | null }) {
    if (minutes === null) {
        return <span class="mono est est-missing" title="No estimate: counted at 30 m">~?</span>;
    }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return <span class="mono est">~{h ? `${h}h` : ""}{m || !h ? `${m}m` : ""}</span>;
}

export function Snackbar() {
    const current = snack.value;
    useEffect(() => {
        if (!current || current.action?.label === "Undo") {
            return;
        }
        const timer = setTimeout(() => {
            if (snack.value === current) {
                snack.value = null;
            }
        }, current.tone === "error" ? 6000 : 3500);
        return () => clearTimeout(timer);
    }, [ current ]);
    if (!current) {
        return null;
    }
    return (
        <div class={`snackbar${current.tone === "error" ? " snackbar-error" : ""}`} role="status">
            <span>{current.text}</span>
            {current.action && <button type="button" onClick={current.action.run}>{current.action.label}</button>}
        </div>
    );
}

// ---- Sheets ------------------------------------------------------------------------------------

/** The bottom sheet on screen, if any. Opening one replaces the last: sheets don't stack. */
export const sheet = signal<ComponentChildren | null>(null);

export function openSheet(content: ComponentChildren) {
    sheet.value = content;
}

export function closeSheet() {
    sheet.value = null;
}

export function SheetHost() {
    const content = sheet.value;
    if (!content) {
        return null;
    }
    return (
        <div class="sheet-scrim" onClick={(e) => e.target === e.currentTarget && closeSheet()}>
            <div class="sheet" role="dialog" aria-modal="true">
                <div class="sheet-handle" aria-hidden="true" />
                {content}
            </div>
        </div>
    );
}

export function SheetTitle({ title, sub }: { title: string; sub?: string }) {
    return (
        <header class="sheet-title">
            <h2>{title}</h2>
            {sub && <p class="ink-2">{sub}</p>}
        </header>
    );
}

/** One row of a sheet's action list: a glyph, a label and an optional detail on the right. */
export function SheetAction({ glyph, label, detail, tone, onClick }: {
    glyph: string;
    label: string;
    detail?: string;
    tone?: "moss" | "clay" | "berry" | "dusk";
    onClick: () => void;
}) {
    return (
        <button type="button" class={`sheet-action${tone ? ` tone-${tone}` : ""}`} onClick={onClick}>
            <span class="sheet-action-glyph" aria-hidden="true">{glyph}</span>
            <span class="sheet-action-label">{label}</span>
            {detail && <span class="sheet-action-detail mono">{detail}</span>}
        </button>
    );
}

// ---- Haptics -----------------------------------------------------------------------------------

/** The design's haptics: confirm on Done and Write it, a tick on Forward and a swipe threshold, reject on failure. */
export function haptic(kind: "confirm" | "tick" | "reject") {
    if (!settings.value.haptics) {
        return;
    }
    const run = kind === "confirm"
        ? Haptics.notification({ type: NotificationType.Success })
        : kind === "reject"
            ? Haptics.notification({ type: NotificationType.Error })
            : Haptics.impact({ style: ImpactStyle.Light });
    run.catch(() => undefined);
}
