import { type ActionPerformed, LocalNotifications, type LocalNotificationSchema, type LocalNotificationsPlugin } from "@capacitor/local-notifications";
import { type ForegroundServicePlugin, ForegroundService, type ServiceType } from "@capawesome-team/capacitor-android-foreground-service";
import { effect } from "@preact/signals";

import { appVisible, type ChatActivity, chatActivity, chatOnScreen, minimizeRitual, openRitual, pendingReply, restoreRitual, ritual, settingsOpen, tab } from "../app-state.js";
import { type ChatSlot, readStoredChats } from "./chats.js";
import { CHAT_IDS } from "./notify.js";
import { snack } from "./store.js";

/**
 * A Caius chat turn's notifications. While a turn runs, an Android foreground service keeps the app
 * alive to stream while hidden, and its ongoing notification shows the turn's latest line. A reply
 * that lands out of sight posts "Caius replied", with an inline reply that starts the next turn.
 */

/** What the notifications are decided from: each chat's activity, which chats are on screen, and whether the app is. */
export interface ChatScene {
    activity: Partial<Record<ChatSlot, ChatActivity>>;
    onScreen: Record<ChatSlot, boolean>;
    visible: boolean;
}

export interface ChatNotice {
    title: string;
    body: string;
}

/** The plugin calls the notifications make, so the spec can stand in for them. */
export interface ChatNotifyPlugins {
    service: Pick<ForegroundServicePlugin, "startForegroundService" | "updateForegroundService" | "stopForegroundService">;
    notifications: Pick<LocalNotificationsPlugin, "schedule" | "cancel">;
}

/** The chat a notification's tap or button shows, and the words typed into its inline reply. */
export interface ChatTarget {
    slot: ChatSlot;
    reply?: string;
}

/**
 * The ongoing notification while a chat works, the ritual's first. It shows even with the chat on
 * screen, since the foreground service behind it is what keeps the app alive once it is hidden.
 */
export function chatNotice(scene: ChatScene): ChatNotice | null {
    const working = SLOTS.map((slot) => scene.activity[slot]).find((a) => a?.working);
    return working ? { title: "Caius is thinking…", body: `${working.title} · ${working.line}` } : null;
}

/**
 * The "Caius replied" notification for a turn that ended between `prev` and `scene` while the app
 * was hidden or its chat off screen. Only a turn that streamed ends one, as in `publishActivity`, so
 * reopening a finished chat posts nothing.
 */
export function repliedNotice(prev: ChatScene["activity"], scene: ChatScene): { slot: ChatSlot; notification: LocalNotificationSchema } | null {
    for (const slot of SLOTS) {
        const next = scene.activity[slot];
        if (!prev[slot]?.streaming || !next || next.working || (scene.visible && scene.onScreen[slot])) {
            continue;
        }
        return {
            slot,
            notification: {
                id: CHAT_IDS.replied, title: "Caius replied", body: next.line, channelId: "caius",
                actionTypeId: "caius-reply", smallIcon: "ic_stat_caius", extra: { chat: slot }
            }
        };
    }
    return null;
}

/**
 * Follows `chatActivity` and `appVisible` with the notifications: the foreground service started with
 * a turn, updated at most once a second as its line changes, and stopped once no chat works; the
 * replied notification posted as a turn ends out of sight, and cancelled once its chat shows with
 * the app visible. Returns the stop function.
 */
export function startChatNotifications(plugins: ChatNotifyPlugins = { service: ForegroundService, notifications: LocalNotifications }): () => void {
    const ongoing = ongoingNotice(plugins.service);
    let prev: ChatScene["activity"] = {};
    let posted: ChatSlot | null = null;
    const dispose = effect(() => {
        const scene = currentScene();
        ongoing.show(chatNotice(scene));
        const replied = repliedNotice(prev, scene);
        prev = scene.activity;
        if (replied) {
            posted = replied.slot;
            plugins.notifications.schedule({ notifications: [ replied.notification ] }).catch(() => undefined);
        } else if (posted && scene.visible && scene.onScreen[posted]) {
            posted = null;
            plugins.notifications.cancel({ notifications: [ { id: CHAT_IDS.replied } ] }).catch(() => undefined);
        }
    });
    return () => {
        dispose();
        ongoing.show(null);
    };
}

/** The chat a tap or button on a chat notification is for, or null for any other notification. */
export function chatTarget({ actionId, inputValue, notification }: ActionPerformed): ChatTarget | null {
    const chat = (notification.extra as { chat?: unknown } | undefined)?.chat;
    if (chat !== "ritual" && chat !== "ask") {
        return null;
    }
    const reply = actionId === "reply" ? inputValue?.trim() : undefined;
    return reply ? { slot: chat, reply } : { slot: chat };
}

/**
 * Shows the target's chat: the ritual restored, or reopened from its stored chat after a cold start;
 * Ask on its tab. A reply waits in `pendingReply` for the stored chat note, so it is sent to no other
 * chat; a chat that can't take it puts it in its box. A reply to a ritual that is closed shows a snack.
 */
export function openChat({ slot, reply }: ChatTarget) {
    const stored = readStoredChats()[slot];
    settingsOpen.value = false;
    if (slot === "ask") {
        minimizeRitual();
        tab.value = "ask";
    } else if (ritual.value) {
        restoreRitual();
    } else if (stored && stored.kind !== "ask") {
        openRitual(stored.kind, stored.date, stored.noteId);
    }
    if (!reply) {
        return;
    }
    if (slot === "ritual" && !ritual.value) {
        snack.value = { text: "Your reply wasn't sent: that chat is closed.", tone: "error" };
        return;
    }
    pendingReply.value = { slot, noteId: stored?.noteId ?? null, text: reply };
}

const SLOTS: ChatSlot[] = [ "ritual", "ask" ];
const UPDATE_EVERY_MS = 1000;
/** `foregroundServiceType="dataSync"` in the manifest; the plugin's `ServiceType` names only location and microphone. */
const DATA_SYNC = 1 as ServiceType;

function currentScene(): ChatScene {
    return {
        activity: chatActivity.value,
        onScreen: { ritual: chatOnScreen("ritual"), ask: chatOnScreen("ask") },
        visible: appVisible.value
    };
}

/**
 * The foreground service's notification, throttled: a change within a second of the last update
 * waits for a trailing update, which sends the newest notice.
 */
function ongoingNotice(service: ChatNotifyPlugins["service"]) {
    let running = false;
    let sent: ChatNotice | null = null;
    let latest: ChatNotice | null = null;
    let sentAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const options = (notice: ChatNotice) => ({
        id: CHAT_IDS.working, ...notice, smallIcon: "ic_stat_caius",
        notificationChannelId: "caius-working", serviceType: DATA_SYNC, silent: true
    });
    const flush = () => {
        timer = null;
        if (running && latest && !sameNotice(latest, sent)) {
            sent = latest;
            sentAt = Date.now();
            service.updateForegroundService(options(latest)).catch(() => undefined);
        }
    };

    return {
        show(notice: ChatNotice | null) {
            latest = notice;
            if (!notice) {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (running) {
                    running = false;
                    sent = null;
                    service.stopForegroundService().catch(() => undefined);
                }
                return;
            }
            if (!running) {
                running = true;
                sent = notice;
                sentAt = Date.now();
                service.startForegroundService(options(notice)).catch(() => undefined);
                return;
            }
            if (sameNotice(notice, sent) || timer) {
                return;
            }
            const wait = sentAt + UPDATE_EVERY_MS - Date.now();
            if (wait <= 0) {
                flush();
            } else {
                timer = setTimeout(flush, wait);
            }
        }
    };
}

function sameNotice(a: ChatNotice, b: ChatNotice | null) {
    return a.title === b?.title && a.body === b.body;
}
