import { effect, signal } from "@preact/signals";

import type { ChatKind } from "./lib/chat.js";
import { type ChatSlot, storeChat } from "./lib/chats.js";

/** Where the app is: one of the four bottom-bar destinations, with a ritual or Settings over it. */
export type Tab = "today" | "plan" | "ask" | "reminders";

export const tab = signal<Tab>("today");
/**
 * The ritual, full screen over the tabs, for the day it is about; `noteId` reopens its chat note.
 * `minimized` hides it behind the mini bar while it stays mounted.
 */
export const ritual = signal<{ kind: "plan" | "winddown"; date: string; noteId?: string; minimized?: boolean } | null>(null);
export const settingsOpen = signal(false);
/** True from Connect until the notifications question is answered, so first run stays on its screens. */
export const onboarding = signal(false);
/** Set from Quick add's FAB, the app shortcut and the notification; App opens the sheet. */
export const quickAddRequested = signal(0);
/** Bumped when the app comes back to the front, so a chat that was streaming asks the server where its turn is. */
export const resumed = signal(0);
/** False while the app is in the background, between Capacitor's `pause` and `resume`. */
export const appVisible = signal(true);
/** A reply typed into a chat notification, sent by the `useChat` of that slot and note once it is ready. */
export const pendingReply = signal<{ slot: ChatSlot; noteId: string; text: string } | null>(null);

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

/** Opens a ritual; the same ritual already open, minimized or not, is shown again with its chat. */
export function openRitual(kind: "plan" | "winddown", date: string, noteId?: string) {
    const open = ritual.value;
    if (open?.kind === kind && open.date === date) {
        restoreRitual();
    } else {
        ritual.value = { kind, date, noteId };
    }
}

/** Hides the ritual behind the mini bar, its chat still mounted, so its turn and its answers carry on. */
export function minimizeRitual() {
    if (ritual.value) {
        ritual.value = { ...ritual.value, minimized: true };
    }
}

export function restoreRitual() {
    if (ritual.value) {
        ritual.value = { ...ritual.value, minimized: false };
    }
}

/** Closes the ritual and forgets its chat, so the next start doesn't reopen it. */
export function closeRitual() {
    ritual.value = null;
    storeChat("ritual", null);
}

export function openSettings() {
    settingsOpen.value = true;
}

/** What the mini bar shows of a chat. */
export interface ChatActivity {
    kind: ChatKind;
    title: string;
    /** Starting or streaming a turn. */
    working: boolean;
    /** Streaming a turn; its end off screen makes the reply `unseen`. */
    streaming: boolean;
    line: string;
    /** A turn ended while the chat was off screen, and the chat hasn't been shown since. */
    unseen: boolean;
}

export const CHAT_TITLES: Record<ChatKind, string> = { plan: "Plan my day", winddown: "Wind down", ask: "Ask" };

/** Each chat's activity, published by `useChat`; a slot is empty before the chat has anything to show. */
export const chatActivity = signal<Partial<Record<ChatSlot, ChatActivity>>>({});

/** Sets a chat's activity, or clears it with null. */
export function publishActivity(slot: ChatSlot, next: Omit<ChatActivity, "title" | "unseen"> | null) {
    const { [slot]: prev, ...rest } = chatActivity.value;
    if (!next) {
        chatActivity.value = rest;
        return;
    }
    const ended = !!prev?.streaming && !next.streaming;
    const unseen = !chatOnScreen(slot) && (!!prev?.unseen || ended);
    chatActivity.value = { ...rest, [slot]: { ...next, title: CHAT_TITLES[next.kind], unseen } };
}

/** Whether the chat in `slot` is on screen: the ritual not minimized, or the Ask tab with nothing over it. */
export function chatOnScreen(slot: ChatSlot) {
    if (settingsOpen.value) {
        return false;
    }
    const ritualShown = !!ritual.value && !ritual.value.minimized;
    return slot === "ritual" ? ritualShown : !ritualShown && tab.value === "ask";
}

effect(() => {
    const all = chatActivity.value;
    for (const slot of [ "ritual", "ask" ] as const) {
        const activity = all[slot];
        if (activity?.unseen && chatOnScreen(slot)) {
            chatActivity.value = { ...chatActivity.value, [slot]: { ...activity, unseen: false } };
        }
    }
});
