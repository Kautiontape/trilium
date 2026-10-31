import "./ui.css";

import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import addSvg from "@material-symbols/svg-300/rounded/add.svg?raw";
import alarmSvg from "@material-symbols/svg-300/rounded/alarm.svg?raw";
import arrowforwardSvg from "@material-symbols/svg-300/rounded/arrow_forward.svg?raw";
import arrowupwardSvg from "@material-symbols/svg-300/rounded/arrow_upward.svg?raw";
import calendarviewweekSvg from "@material-symbols/svg-300/rounded/calendar_view_week.svg?raw";
import checkSvg from "@material-symbols/svg-300/rounded/check.svg?raw";
import closeSvg from "@material-symbols/svg-300/rounded/close.svg?raw";
import editsquareSvg from "@material-symbols/svg-300/rounded/edit_square.svg?raw";
import forumSvg from "@material-symbols/svg-300/rounded/forum.svg?raw";
import helpSvg from "@material-symbols/svg-300/rounded/help.svg?raw";
import notificationsSvg from "@material-symbols/svg-300/rounded/notifications.svg?raw";
import openinnewSvg from "@material-symbols/svg-300/rounded/open_in_new.svg?raw";
import refreshSvg from "@material-symbols/svg-300/rounded/refresh.svg?raw";
import settingsSvg from "@material-symbols/svg-300/rounded/settings.svg?raw";
import todaySvg from "@material-symbols/svg-300/rounded/today.svg?raw";
import { signal } from "@preact/signals";
import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";

import type { PlanTask } from "../lib/caius.js";
import { flushHeld, type HeldState, settings, snack } from "../lib/store.js";

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
    const shown = held === "done" ? "done" : held === "forwarded" || state === "tombstone" ? "rescheduled" : state;
    const glyph = shown === "done" ? "●" : shown === "in_progress" ? "◐" : shown === "rescheduled" ? "→" : shown === "cancelled" ? "✕" : "○";
    return <span class={`glyph glyph-${shown}`} aria-hidden="true">{glyph}</span>;
}

/** `~45m`, or an ochre `~?` when the task has no estimate. */
export function Est({ minutes }: { minutes: number | null }) {
    if (minutes === null) {
        return <span class="mono est est-missing" title="No estimate: counted at 30 m">~?</span>;
    }
    return <span class="mono est">~{formatEstimate(minutes)}</span>;
}

export function Snackbar() {
    const current = snack.value;
    const overSheet = !!sheet.value;
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
        <div class={`snackbar${current.tone === "error" ? " snackbar-error" : ""}${overSheet ? " snackbar-top" : ""}`} role="status">
            <span>{current.text}</span>
            {current.action && <button type="button" onClick={current.action.run}>{current.action.label}</button>}
        </div>
    );
}

// ---- Icons -------------------------------------------------------------------------------------

/** Material Symbols Rounded, weight 300, drawn in the text colour. Task states keep their own glyphs. */
export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
    return <span class="icon" aria-hidden="true" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}

export type IconName = keyof typeof ICONS;

export function isIconName(name: string): name is IconName {
    return name in ICONS;
}

const ICONS = {
    add: addSvg,
    alarm: alarmSvg,
    arrow_forward: arrowforwardSvg,
    arrow_upward: arrowupwardSvg,
    calendar_view_week: calendarviewweekSvg,
    check: checkSvg,
    close: closeSvg,
    edit_square: editsquareSvg,
    forum: forumSvg,
    help: helpSvg,
    notifications: notificationsSvg,
    open_in_new: openinnewSvg,
    refresh: refreshSvg,
    settings: settingsSvg,
    today: todaySvg,
};

// ---- Sheets ------------------------------------------------------------------------------------

/** The bottom sheet on screen, if any. Opening one replaces the last: sheets don't stack. */
export const sheet = signal<ComponentChildren | null>(null);

/**
 * Opens a sheet. A write held behind Undo is sent now, as a second held write would send it, and
 * the notice goes, so it can't sit over the sheet's last actions; an error stays, shown at the top.
 */
export function openSheet(content: ComponentChildren) {
    void flushHeld();
    if (snack.value?.tone !== "error") {
        snack.value = null;
    }
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
    /** An icon's name, or a state glyph such as ◐. */
    glyph: string;
    label: string;
    detail?: string;
    tone?: "moss" | "clay" | "berry" | "dusk";
    onClick: () => void;
}) {
    return (
        <button type="button" class={`sheet-action${tone ? ` tone-${tone}` : ""}`} onClick={onClick}>
            <span class="sheet-action-glyph" aria-hidden="true">{isIconName(glyph) ? <Icon name={glyph} /> : glyph}</span>
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
