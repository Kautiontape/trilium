import "./sheets.css";

import { Capacitor } from "@capacitor/core";
import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import { useEffect, useState } from "preact/hooks";

import type { Explanation, PlanTask, TaskRef } from "../lib/caius.js";
import { addMonths, addWeeks, dayLabel, monthLabel, nextWorkdayKey, periodLabel, addDays, weekLabel, weekOf } from "../lib/day.js";
import type { Reminder } from "../lib/local.js";
import { cancelReminder, inQuietHours, scheduleReminder } from "../lib/notify.js";
import { reminderChoices, whenLabel } from "../lib/remind.js";
import { api, appNow, connection, holdWrite, messageOf, refOf, reminders, runWrite, saveReminders, settings, snack, today } from "../lib/store.js";
import { Button, Chip, closeSheet, haptic, openSheet, SheetAction, SheetTitle } from "./ui.js";

/** Where a task sits, for the sheet's subtitle and a reminder's second line: `Today · Work`. */
export function whereOf(task: PlanTask, periodKey?: string) {
    const key = periodKey ?? today.value?.key;
    const day = key && key === today.value?.key ? "Today" : key ? periodLabel(key) : "";
    return [ day, task.critical ? "Important" : task.section ].filter(Boolean).join(" · ");
}

// ---- Actions -----------------------------------------------------------------------------------

export function markDone(task: PlanTask) {
    const ref = refOf(task);
    if (!ref) {
        return;
    }
    haptic("confirm");
    closeSheet();
    holdWrite(ref, "done", `Done: ${task.text}`, () => api().setState([ { ...ref, state: "done" } ]));
}

export function startDoing(task: PlanTask) {
    const ref = refOf(task);
    if (!ref) {
        return;
    }
    closeSheet();
    void runWrite(() => api().setState([ { ...ref, state: "doing" } ]));
}

export function forwardTask(task: PlanTask, to: string, onDeck?: boolean) {
    const ref = refOf(task);
    if (!ref) {
        return;
    }
    haptic("tick");
    closeSheet();
    holdWrite(ref, "forwarded", `Forwarded to ${periodLabel(to)}`,
        () => api().forward([ { ...ref, to, ...(onDeck === undefined ? {} : { onDeck }) } ]));
}

export function acceptSuggestion(task: PlanTask, placement?: { section?: string; critical?: boolean }) {
    const ref = refOf(task);
    if (!ref) {
        return;
    }
    haptic("confirm");
    closeSheet();
    void runWrite(() => api().accept([ { ...ref, ...placement } ]));
}

export function dismissSuggestion(task: PlanTask) {
    const ref = refOf(task);
    if (!ref) {
        return;
    }
    closeSheet();
    holdWrite(ref, "dismissed", `Dismissed: ${task.text}`, () => api().dismiss([ ref ]));
}

/** The swipe-right on a Suggested row: Accept, through the heading list when the day has more than one heading. */
export function acceptFromSwipe(task: PlanTask) {
    const headings = listHeadings();
    if (headings.length > 1) {
        openSheet(<AcceptSheet task={task} headings={headings} />);
    } else {
        acceptSuggestion(task);
    }
}

function listHeadings() {
    return (today.value?.plan.sections ?? [])
        .filter((s) => s.name && s.kind !== "deck" && !/^(meetings|context)$/i.test(s.name))
        .map((s) => s.name as string);
}

// ---- The task sheet ----------------------------------------------------------------------------

/** What can be done to one task. It offers only what applies: Doing is hidden while Doing, a finished task gets only Why. */
export function TaskSheet({ task, periodKey, suggested }: { task: PlanTask; periodKey?: string; suggested?: boolean }) {
    const live = task.state === "open" || task.state === "in_progress";
    const next = today.value ? nextWorkdayKey(today.value.key) : null;
    const offline = today.value?.offline;
    const conn = connection.value;
    return (
        <>
            <SheetTitle title={task.text} sub={[ whereOf(task, periodKey), task.estMinutes ? `~${formatEstimate(task.estMinutes)}` : null, task.state === "in_progress" ? "Doing" : null ].filter(Boolean).join(" · ")} />
            {offline && <p class="sheet-note">Offline: actions wait until the server is back.</p>}
            {!offline && suggested && live && (
                <>
                    <SheetAction glyph="add" tone="clay" label="Accept" onClick={() => acceptFromSwipe(task)} />
                    <SheetAction glyph="!" tone="clay" label="Accept as Important" onClick={() => acceptSuggestion(task, { critical: true })} />
                    <SheetAction glyph="close" label="Dismiss" onClick={() => dismissSuggestion(task)} />
                </>
            )}
            {!offline && !suggested && live && (
                <>
                    <SheetAction glyph="check" tone="moss" label="Done" onClick={() => markDone(task)} />
                    {task.state !== "in_progress" && <SheetAction glyph="◐" tone="clay" label="Doing" onClick={() => startDoing(task)} />}
                    {next && <SheetAction glyph="arrow_forward" tone="dusk" label="Forward" detail={`${dayLabel(next)} ▸`} onClick={() => openSheet(<ForwardSheet task={task} />)} />}
                    <SheetAction glyph="alarm" label="Remind me" detail="▸" onClick={() => openSheet(<RemindSheet task={task} periodKey={periodKey} />)} />
                </>
            )}
            <SheetAction glyph="help" label="Why is this here?" onClick={() => openSheet(<ExplainSheet task={task} />)} />
            {conn && <SheetAction glyph="open_in_new" label="Open in Trilium" onClick={() => openInTrilium(conn.url, task.noteId)} />}
            {!offline && !suggested && live && <SheetAction glyph="close" tone="berry" label="Drop…" onClick={() => openSheet(<DropSheet task={task} />)} />}
        </>
    );
}

function openInTrilium(url: string, noteId: string) {
    const link = `${url}/#root/${encodeURIComponent(noteId)}`;
    if (Capacitor.isNativePlatform()) {
        // The WebView hands a navigation off its own host to the system browser.
        window.location.href = link;
    } else {
        window.open(link, "_blank", "noopener");
    }
}

function AcceptSheet({ task, headings }: { task: PlanTask; headings: string[] }) {
    return (
        <>
            <SheetTitle title="Accept under" sub={task.text} />
            {headings.map((name) => <SheetAction key={name} glyph="▸" label={name} onClick={() => acceptSuggestion(task, { section: name })} />)}
            <SheetAction glyph="!" tone="clay" label="Important" onClick={() => acceptSuggestion(task, { critical: true })} />
        </>
    );
}

// ---- Forward -----------------------------------------------------------------------------------

/**
 * Where to forward a task: the next workday first, then tomorrow when it isn't one, next week,
 * next month, or a picked day, week or month. On a day, Would like puts the copy on its On deck
 * and Need to on its list; left alone, the task keeps its placement.
 */
export function ForwardSheet({ task, from }: { task: PlanTask; from?: string }) {
    const base = from ?? today.value?.key ?? "";
    const [ placement, setPlacement ] = useState<boolean | undefined>(undefined);
    const [ picking, setPicking ] = useState<"day" | "week" | "month" | null>(null);
    const [ picked, setPicked ] = useState("");
    if (!base) {
        return null;
    }
    const next = nextWorkdayKey(base);
    const tomorrow = addDays(base, 1);
    const nextWeek = addWeeks(weekOf(base), 1);
    const nextMonth = addMonths(base.slice(0, 7), 1);
    const go = (to: string) => forwardTask(task, to, /^\d{4}-\d{2}-\d{2}$/.test(to) ? placement : undefined);

    return (
        <>
            <SheetTitle title="Forward" sub={task.text} />
            <div class="chip-row" role="group" aria-label="On a day">
                <Chip selected={placement === true} onClick={() => setPlacement(placement === true ? undefined : true)}>Would like</Chip>
                <Chip selected={placement === false} onClick={() => setPlacement(placement === false ? undefined : false)}>Need to</Chip>
            </div>
            <SheetAction glyph="arrow_forward" tone="dusk" label={dayLabel(next)} detail="next workday" onClick={() => go(next)} />
            {tomorrow !== next && <SheetAction glyph="arrow_forward" label={`Tomorrow · ${dayLabel(tomorrow)}`} onClick={() => go(tomorrow)} />}
            <SheetAction glyph="arrow_forward" label="Next week" detail={weekLabel(nextWeek).split(" · ")[1]} onClick={() => go(nextWeek)} />
            <SheetAction glyph="arrow_forward" label="Next month" detail={monthLabel(nextMonth)} onClick={() => go(nextMonth)} />
            <SheetAction glyph="…" label="Pick a date…" onClick={() => setPicking(picking ? null : "day")} />
            {picking && (
                <div class="picker">
                    <div class="chip-row">
                        {(["day", "week", "month"] as const).map((kind) => (
                            <Chip key={kind} selected={picking === kind} onClick={() => { setPicking(kind); setPicked(""); }}>
                                {kind === "day" ? "Day" : kind === "week" ? "Week" : "Month"}
                            </Chip>
                        ))}
                    </div>
                    <input
                        class="field"
                        type={picking === "day" ? "date" : picking === "week" ? "week" : "month"}
                        min={picking === "day" ? addDays(base, 1) : undefined}
                        value={picked}
                        onInput={(e) => setPicked((e.target as HTMLInputElement).value)}
                        aria-label="Forward to"
                    />
                    <Button kind="primary" disabled={!validKey(picked)} onClick={() => go(picked.toUpperCase().replace("-W", "-W"))}>
                        Forward to {validKey(picked) ? periodLabel(picked.toUpperCase()) : "…"}
                    </Button>
                </div>
            )}
        </>
    );
}

function validKey(key: string) {
    return /^\d{4}-\d{2}-\d{2}$/.test(key) || /^\d{4}-W\d{2}$/i.test(key) || /^\d{4}-\d{2}$/.test(key);
}

// ---- Drop --------------------------------------------------------------------------------------

const DROP_REASONS = [ "Not needed", "Someone else has it", "Won't get to it" ];

/** Drop asks why, and goes at once: it is never on a swipe and needs no Undo. */
export function DropSheet({ task }: { task: PlanTask }) {
    const [ reason, setReason ] = useState("");
    const ref = refOf(task);
    return (
        <>
            <SheetTitle title="Drop" sub={task.text} />
            <div class="chip-row">
                {DROP_REASONS.map((r) => <Chip key={r} selected={reason === r} onClick={() => setReason(r)}>{r}</Chip>)}
            </div>
            <input class="field" type="text" placeholder="Or say why…" value={DROP_REASONS.includes(reason) ? "" : reason}
                onInput={(e) => setReason((e.target as HTMLInputElement).value)} aria-label="Why" />
            <Button kind="primary" class="btn-berry" disabled={!reason.trim() || !ref} onClick={() => {
                if (!ref) {
                    return;
                }
                closeSheet();
                void runWrite(() => api().setState([ { ...ref, state: "cancelled", reason: reason.trim() } ])).then((ok) => {
                    if (ok) {
                        snack.value = { text: `Dropped: ${reason.trim()}` };
                    }
                });
            }}>Drop it</Button>
        </>
    );
}

// ---- Why is this here? -------------------------------------------------------------------------

export function ExplainSheet({ task }: { task: PlanTask }) {
    const [ answer, setAnswer ] = useState<Explanation | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    useEffect(() => {
        const ref = refOf(task);
        if (!ref) {
            setError("This task has no id yet, so Caius can't place it.");
            return;
        }
        api().explain(ref).then(setAnswer, (e) => setError(messageOf(e)));
    }, [ task ]);
    return (
        <>
            <SheetTitle title="Why is this here?" sub={task.text} />
            {!answer && !error && <p class="ink-2">Asking Caius…</p>}
            {error && <p class="sheet-error">{error}</p>}
            {answer && (
                <div class="explain">
                    <p>{answer.summary ?? (answer.error === "not_found" ? "Caius can't find this task any more." : "No reason given.")}</p>
                    {answer.lane && <p class="mono ink-2">lane {answer.lane}</p>}
                    {answer.rule && <p class="mono ink-2">{answer.rule}</p>}
                </div>
            )}
        </>
    );
}

// ---- Remind me ---------------------------------------------------------------------------------

/** A reminder on this phone about a task: In 1 h, This evening, Tomorrow at standup, or a picked time. */
export function RemindSheet({ task, periodKey }: { task: PlanTask; periodKey?: string }) {
    const now = appNow();
    const rhythm = today.value?.rhythm;
    const choices = reminderChoices(now, settings.value.workEndOverride || rhythm?.workEnd || "18:00", settings.value.standupOverride || rhythm?.start || "09:30");
    const [ picked, setPicked ] = useState("");
    const [ confirmQuiet, setConfirmQuiet ] = useState<Date | null>(null);
    const ref = refOf(task);

    const set = (at: Date, force = false) => {
        if (!force && rhythm && inQuietHours(at, settings.value, rhythm)) {
            setConfirmQuiet(at);
            return;
        }
        addReminder({ at: at.toISOString(), text: task.text, source: "task", ...(ref ? { task: { ...ref, where: whereOf(task, periodKey) } } : {}) });
        closeSheet();
        snack.value = { text: `Reminder set: ${whenLabel(at, now)}` };
    };

    return (
        <>
            <SheetTitle title="Remind me" sub={task.text} />
            {confirmQuiet ? (
                <div class="quiet-confirm">
                    <p>This is in quiet hours. Ring anyway?</p>
                    <div class="chip-row">
                        <Button kind="primary" onClick={() => set(confirmQuiet, true)}>Ring anyway</Button>
                        <Button kind="quiet" onClick={() => setConfirmQuiet(null)}>Pick another time</Button>
                    </div>
                </div>
            ) : (
                <>
                    {choices.map((c) => <SheetAction key={c.label} glyph="alarm" label={c.label} detail={whenLabel(c.at, now)} onClick={() => set(c.at)} />)}
                    <div class="picker">
                        <input class="field" type="datetime-local" value={picked} onInput={(e) => setPicked((e.target as HTMLInputElement).value)} aria-label="Pick a time" />
                        <Button kind="primary" disabled={!picked || new Date(picked) <= now} onClick={() => set(new Date(picked))}>Set</Button>
                    </div>
                </>
            )}
        </>
    );
}

/** Saves a reminder and schedules its notification. */
export function addReminder(fields: Omit<Reminder, "id">) {
    const id = 1000 + Math.floor(Math.random() * 1_000_000);
    const reminder: Reminder = { id, ...fields };
    saveReminders([ ...reminders.value, reminder ].sort((a, b) => a.at.localeCompare(b.at)));
    void scheduleReminder(reminder);
    return reminder;
}

export function removeReminder(id: number) {
    saveReminders(reminders.value.filter((r) => r.id !== id));
    void cancelReminder(id);
}

export type { TaskRef };
