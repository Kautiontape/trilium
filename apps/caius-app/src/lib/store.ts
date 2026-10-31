import { signal } from "@preact/signals";
import { readRhythm, type Rhythm } from "@triliumnext/caius/src/daily/standing.js";

import { type CaiusApi, caiusApi, type CaiusStatus, type CatchupStep, type Nudge, type PlanTask, type PlanView, type TaskRef, type WriteResult, writeProblem } from "./caius.js";
import type { Connection } from "./connection.js";
import { clockMinutes, nextWorkdayKey } from "./day.js";
import { HttpError, hostOf, UnreachableError } from "./http.js";
import { type Capture, type CaptureTarget, DEFAULT_SETTINGS, readLocal, readLocalList, type Reminder, type Settings, writeLocal } from "./local.js";
import { McpError } from "./mcp.js";

/** What Today shows: the server's day, its plan, the catch-up and the Rhythm. */
export interface TodayData {
    /** The server's today, `YYYY-MM-DD` (from `caius_plan`). */
    key: string;
    /** Caius's label for it, `Wed 4 Nov`. */
    label: string;
    plan: PlanView;
    catchup: CatchupStep | null;
    rhythm: Rhythm;
    /** The nudge state; null on a server without the phone routes. */
    nudge: Nudge | null;
    /** When this was read, ISO. */
    asOf: string;
    /** Shown from the snapshot because the server couldn't be reached. */
    offline: boolean;
}

/** The saved connection: undefined until it has been read from storage, null when there is none. */
export const connection = signal<Connection | null | undefined>(undefined);
/** The `/etapi/caius/status` answer: undefined before the probe, null on a server without the phone routes. */
export const serverStatus = signal<CaiusStatus | null | undefined>(undefined);
export const today = signal<TodayData | null>(null);
export const todayError = signal<string | null>(null);
export const refreshing = signal(false);
export const settings = signal<Settings>(readLocal("settings", DEFAULT_SETTINGS));
export const reminders = signal<Reminder[]>(readLocalList<Reminder>("reminders"));
export const outbox = signal<Capture[]>(readLocalList<Capture>("outbox"));
export const snack = signal<Snack | null>(null);
/** Tasks with a write held behind Undo, by `noteId/listItemId`, and the state they show meanwhile. */
export const held = signal<Record<string, HeldState>>({});
/** Bumped after every write, so open lists read again. */
export const revision = signal(0);

export interface Snack {
    text: string;
    action?: { label: string; run: () => void };
    tone?: "error";
}

export type HeldState = "done" | "forwarded" | "dismissed";

/** The gap between the server's dev clock and the phone's, in ms; 0 without a dev clock. */
let clockOffset = 0;

/** The time Caius means by now: the phone's clock, or the server's when it runs a dev clock. */
export function appNow() {
    return new Date(Date.now() + clockOffset);
}

export function api(): CaiusApi {
    const conn = connection.value;
    if (!conn) {
        throw new Error("Not connected.");
    }
    return caiusApi(conn);
}

/** Probes the phone routes once per connection. */
export async function probeServer() {
    const status = await api().status();
    serverStatus.value = status;
    if (status?.now) {
        clockOffset = new Date(status.now).getTime() - Date.now();
    }
    return status;
}

/** Reads Today from the server; offline, shows the last snapshot with actions off. */
export async function refreshToday() {
    if (refreshing.value) {
        return;
    }
    refreshing.value = true;
    try {
        if (serverStatus.value === undefined) {
            await probeServer();
        }
        await flushOutbox();
        const caius = api();
        const plan = await caius.plan("day");
        const [ catchup, nudge ] = await Promise.all([
            caius.catchup(plan.key).catch(() => null),
            serverStatus.value ? caius.nudge(plan.key).catch(() => null) : Promise.resolve(null)
        ]);
        const data: TodayData = {
            key: plan.key,
            label: catchup?.dateLabel ?? plan.key,
            plan,
            catchup,
            rhythm: readRhythm(catchup?.standing ?? null),
            nudge,
            asOf: appNow().toISOString(),
            offline: false
        };
        today.value = data;
        todayError.value = null;
        writeLocal("snapshot", data);
    } catch (e) {
        todayError.value = messageOf(e);
        if (e instanceof UnreachableError) {
            const snapshot = readLocal<TodayData | null>("snapshot", null);
            if (snapshot?.plan) {
                today.value = { ...snapshot, offline: true };
            }
        }
    } finally {
        refreshing.value = false;
    }
}

/** A user-facing sentence for an error, in Caius's words where there is one. */
export function messageOf(e: unknown): string {
    if (e instanceof UnreachableError) {
        return `Can't reach ${hostOf(e.url)}. Is Tailscale on?`;
    }
    if (e instanceof HttpError) {
        return e.status === 401 ? "The server didn't accept the token." : e.message;
    }
    if (e instanceof McpError) {
        return e.message;
    }
    return e instanceof Error ? e.message : String(e);
}

export function taskKey(task: TaskRef | PlanTask) {
    return `${task.noteId}/${task.listItemId ?? ""}`;
}

export function refOf(task: PlanTask): TaskRef | null {
    return task.listItemId ? { noteId: task.noteId, listItemId: task.listItemId } : null;
}

// ---- Writes ------------------------------------------------------------------------------------

interface HeldWrite {
    key: string;
    timer: ReturnType<typeof setTimeout>;
    send: () => Promise<void>;
}

let pending: HeldWrite | null = null;

/**
 * Holds a write for 4 seconds behind an Undo snackbar, showing `state` on the row meanwhile.
 * Caius can't reopen a task or take back a forward, so Undo is the only way back. A second
 * held write sends the first at once.
 */
export function holdWrite(task: TaskRef, state: HeldState, text: string, send: () => Promise<unknown>) {
    void flushHeld();
    const key = taskKey(task);
    held.value = { ...held.value, [key]: state };
    const write: HeldWrite = {
        key,
        timer: setTimeout(() => void flushHeld(), 4000),
        send: async () => {
            await runWrite(send);
            const { [key]: _gone, ...rest } = held.value;
            held.value = rest;
        }
    };
    pending = write;
    snack.value = {
        text,
        action: {
            label: "Undo",
            run: () => {
                if (pending === write) {
                    clearTimeout(write.timer);
                    pending = null;
                    const { [key]: _undone, ...rest } = held.value;
                    held.value = rest;
                }
                snack.value = null;
            }
        }
    };
}

/** Sends the write held behind Undo now: when its time is up, or the app goes to the background. */
export async function flushHeld() {
    const write = pending;
    if (!write) {
        return;
    }
    pending = null;
    clearTimeout(write.timer);
    if (snack.value?.action?.label === "Undo") {
        snack.value = null;
    }
    await write.send();
}

/** Runs a write, reports a problem in the snackbar, and reads Today again. */
export async function runWrite(send: () => Promise<unknown>): Promise<boolean> {
    try {
        const result = await send();
        const problem = result && typeof result === "object" ? writeProblem(result as WriteResult) : null;
        if (problem) {
            snack.value = { text: problem, tone: "error" };
        }
        return !problem;
    } catch (e) {
        snack.value = { text: messageOf(e), tone: "error" };
        return false;
    } finally {
        revision.value++;
        void refreshToday();
    }
}

// ---- Captures ----------------------------------------------------------------------------------

/** Where Quick add puts a task by default: today's On deck, or the next workday's once today is wound down or past the end of work. */
export function defaultCaptureTarget(data: TodayData, now = appNow()): CaptureTarget {
    const woundDown = data.nudge?.state === "wound_down";
    const workEnd = clockMinutes(settings.value.workEndOverride || data.rhythm.workEnd) ?? 18 * 60;
    const minutes = now.getHours() * 60 + now.getMinutes();
    const pastWork = data.key === localKey(now) && minutes >= workEnd;
    return { kind: "onDeck", date: woundDown || pastWork ? nextWorkdayKey(data.key) : data.key };
}

function localKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Queues a capture and tries to send it. It stays in the outbox until the server has it. */
export async function capture(text: string, target: CaptureTarget, est?: string) {
    const item: Capture = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, est, target, createdAt: new Date().toISOString() };
    outbox.value = [ ...outbox.value, item ];
    writeLocal("outbox", outbox.value);
    return sendCapture(item);
}

/** Sends every waiting capture, oldest first; stops at the first that can't reach the server. */
export async function flushOutbox() {
    for (const item of [ ...outbox.value ]) {
        const result = await sendCapture(item);
        if (result.status === "waiting") {
            return;
        }
    }
}

async function sendCapture(item: Capture): Promise<{ status: "added" | "duplicate" | "waiting" | "failed"; detail?: string }> {
    try {
        const result = await api().add([ { ...addTarget(item.target), text: item.text, ...(item.est ? { est: item.est } : {}) } ]);
        const first = result.results?.[0];
        removeCapture(item.id);
        revision.value++;
        if (first?.status === "skipped" && first.reason === "duplicate") {
            return { status: "duplicate", detail: first.detail };
        }
        if (first && first.status !== "added") {
            return { status: "failed", detail: first.detail ?? first.reason ?? first.status };
        }
        return { status: "added" };
    } catch (e) {
        if (e instanceof UnreachableError) {
            return { status: "waiting" };
        }
        removeCapture(item.id);
        return { status: "failed", detail: messageOf(e) };
    }
}

function removeCapture(id: string) {
    outbox.value = outbox.value.filter((c) => c.id !== id);
    writeLocal("outbox", outbox.value);
}

/** The heading Caius's own template gives a new period note's list; `caius_add` makes it when the note has none. */
const LIST_HEADING = "☑️ Tasks";

/** A capture's place as `caius_add` takes it: every item needs a heading, the Important block or On deck. A picked day is a gathering point, so its On deck. */
export function addTarget(target: CaptureTarget) {
    switch (target.kind) {
        case "onDeck": return { date: target.date, onDeck: true };
        case "list": return { date: target.date, section: target.section ?? LIST_HEADING };
        case "critical": return { date: target.date, critical: true };
        case "week": return { week: target.week, section: LIST_HEADING };
        case "month": return { month: target.month, section: LIST_HEADING };
        case "day": return { date: target.date, onDeck: true };
    }
}

export function saveSettings(next: Settings) {
    settings.value = next;
    writeLocal("settings", next);
}

export function saveReminders(next: Reminder[]) {
    reminders.value = next;
    writeLocal("reminders", next);
}
