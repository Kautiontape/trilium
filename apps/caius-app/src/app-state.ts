import { signal } from "@preact/signals";

/** Where the app is: one of the four bottom-bar destinations, with a ritual or Settings over it. */
export type Tab = "today" | "plan" | "ask" | "reminders";

export const tab = signal<Tab>("today");
/** The ritual on screen, full screen over the tabs, for the day it is about. */
export const ritual = signal<{ kind: "plan" | "winddown"; date: string } | null>(null);
export const settingsOpen = signal(false);
/** True from Connect until the notifications question is answered, so first run stays on its screens. */
export const onboarding = signal(false);
/** Set from Quick add's FAB, the app shortcut and the notification; App opens the sheet. */
export const quickAddRequested = signal(0);

export function openRitual(kind: "plan" | "winddown", date: string) {
    ritual.value = { kind, date };
}

export function openSettings() {
    settingsOpen.value = true;
}
