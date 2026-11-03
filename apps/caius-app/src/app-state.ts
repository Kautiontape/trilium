import { signal } from "@preact/signals";

import { storeChat } from "./lib/chats.js";

/** Where the app is: one of the four bottom-bar destinations, with a ritual or Settings over it. */
export type Tab = "today" | "plan" | "ask" | "reminders";

export const tab = signal<Tab>("today");
/** The ritual on screen, full screen over the tabs, for the day it is about; `noteId` reopens its chat note. */
export const ritual = signal<{ kind: "plan" | "winddown"; date: string; noteId?: string } | null>(null);
export const settingsOpen = signal(false);
/** True from Connect until the notifications question is answered, so first run stays on its screens. */
export const onboarding = signal(false);
/** Set from Quick add's FAB, the app shortcut and the notification; App opens the sheet. */
export const quickAddRequested = signal(0);
/** Bumped when the app comes back to the front, so a chat that was streaming asks the server where its turn is. */
export const resumed = signal(0);

/**
 * Runs `action` with the server's today, now or as soon as Today has been read. A shortcut or a
 * notification button that starts the app cold arrives before the first read of Today.
 */
export function withDay(action: (day: string) => void, day: string | undefined) {
    if (day) {
        action(day);
    } else {
        waiting.push(action);
    }
}

/** Runs the actions that waited for `day`, once each. */
export function runWaiting(day: string) {
    const actions = waiting;
    waiting = [];
    for (const action of actions) {
        action(day);
    }
}

let waiting: ((day: string) => void)[] = [];

export function openRitual(kind: "plan" | "winddown", date: string, noteId?: string) {
    ritual.value = { kind, date, noteId };
}

/** Closes the ritual and forgets its chat, so the next start doesn't reopen it. */
export function closeRitual() {
    ritual.value = null;
    storeChat("ritual", null);
}

export function openSettings() {
    settingsOpen.value = true;
}
