import { type ForegroundServicePlugin, ForegroundService, type ServiceType } from "@capawesome-team/capacitor-android-foreground-service";
import { effect } from "@preact/signals";

import { appVisible, type ChatActivity, chatActivity, chatOnScreen } from "../app-state.js";
import type { ChatSlot } from "./chats.js";
import { CHAT_IDS } from "./notify.js";

/**
 * A Caius chat turn's notification. While a turn runs, an Android foreground service keeps the app
 * alive to stream while hidden, and its ongoing notification shows the turn's latest line.
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
 * Follows `chatActivity` and `appVisible` with the foreground service: started with a turn, updated
 * at most once a second as its line changes, stopped once no chat works. Returns the stop function.
 */
export function startChatNotifications(plugins: ChatNotifyPlugins = { service: ForegroundService }): () => void {
    const ongoing = ongoingNotice(plugins.service);
    const dispose = effect(() => {
        ongoing.show(chatNotice(currentScene()));
    });
    return () => {
        dispose();
        ongoing.show(null);
    };
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
