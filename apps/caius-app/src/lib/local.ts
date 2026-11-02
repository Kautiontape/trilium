import { CAIUS_DEFAULT_EFFORT, type CaiusEffort } from "@triliumnext/commons/src/lib/caius_openers.js";

/**
 * Per-phone state that is not secret and needs no sync: settings, the reminders he set, the
 * capture outbox and the last Today, for showing offline. Kept in the WebView's storage; the
 * connection's token never goes here (see `connection.ts`).
 */

export function readLocal<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(`caius.${key}`);
        return raw ? { ...fallbackObject(fallback), ...JSON.parse(raw) } as T : fallback;
    } catch {
        return fallback;
    }
}

export function readLocalList<T>(key: string): T[] {
    try {
        const raw = localStorage.getItem(`caius.${key}`);
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
        return [];
    }
}

export function writeLocal(key: string, value: unknown) {
    try {
        localStorage.setItem(`caius.${key}`, JSON.stringify(value));
    } catch {
        // Storage full or blocked: the value lives until the app closes.
    }
}

function fallbackObject<T>(fallback: T) {
    return typeof fallback === "object" && fallback !== null && !Array.isArray(fallback) ? fallback : {};
}

export interface Settings {
    theme: "system" | "light" | "dark";
    haptics: boolean;
    nudgePlan: boolean;
    nudgeWinddown: boolean;
    nudgeOvercap: boolean;
    /** `HH:MM` overrides of the Rhythm's times, empty to follow the Rhythm. */
    standupOverride: string;
    workEndOverride: string;
    /** Quiet hours, `HH:MM`; empty to follow the Rhythm (bedtime to 30 minutes before standup). */
    quietFrom: string;
    quietTo: string;
    /** How long Caius thinks before answering in a chat. */
    caiusEffort: CaiusEffort;
}

export const DEFAULT_SETTINGS: Settings = {
    theme: "system",
    haptics: true,
    nudgePlan: true,
    nudgeWinddown: true,
    nudgeOvercap: true,
    standupOverride: "",
    workEndOverride: "",
    quietFrom: "",
    quietTo: "",
    caiusEffort: CAIUS_DEFAULT_EFFORT
};

/** A reminder he set: from a task, Quick add or Ask. */
export interface Reminder {
    id: number;
    /** ISO time. */
    at: string;
    text: string;
    source: "task" | "ask" | "add";
    /** The task it is about, so the notification's Done acts on it. */
    task?: { noteId: string; listItemId: string; where: string };
}

/** A capture that hasn't reached the server yet. */
export interface Capture {
    id: string;
    text: string;
    est?: string;
    target: CaptureTarget;
    createdAt: string;
}

export type CaptureTarget =
    | { kind: "onDeck"; date: string }
    | { kind: "list"; date: string; section?: string }
    | { kind: "critical"; date: string }
    | { kind: "week"; week: string }
    | { kind: "month"; month: string }
    | { kind: "day"; date: string };
