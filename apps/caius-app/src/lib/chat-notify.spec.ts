import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionPerformed } from "@capacitor/local-notifications";

import { appVisible, chatActivity, type ChatActivity, minimizeRitual, openRitual, pendingReply, publishActivity, restoreRitual, ritual, settingsOpen, tab } from "../app-state.js";
import { chatNotice, type ChatScene, chatTarget, openChat, repliedNotice, startChatNotifications } from "./chat-notify.js";
import { storeChat } from "./chats.js";
import { CHAT_IDS } from "./notify.js";
import { snack } from "./store.js";

const working = (line: string) => ({ kind: "winddown" as const, working: true, streaming: true, line });
const replied = (line: string) => ({ kind: "winddown" as const, working: false, streaming: false, line });

function activity(kind: ChatActivity["kind"], fields: Partial<ChatActivity>): ChatActivity {
    const title = kind === "ask" ? "Ask" : kind === "plan" ? "Plan my day" : "Wind down";
    return { kind, title, working: false, streaming: false, line: "", unseen: false, ...fields };
}

function scene(fields: Partial<ChatScene>): ChatScene {
    return { activity: {}, onScreen: { ritual: false, ask: false }, visible: true, ...fields };
}

beforeEach(() => {
    ritual.value = null;
    tab.value = "today";
    settingsOpen.value = false;
    appVisible.value = true;
    chatActivity.value = {};
    pendingReply.value = null;
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key)
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("chatNotice", () => {
    it("shows nothing while no chat works", () => {
        expect(chatNotice(scene({}))).toBeNull();
        expect(chatNotice(scene({ activity: { ritual: activity("winddown", { line: "All done." }) } }))).toBeNull();
    });

    it("names the working chat and its latest line, even when that chat is on screen with the app visible", () => {
        expect(chatNotice(scene({ activity: { ritual: activity("winddown", { working: true, streaming: true, line: "Three left open" }) } })))
            .toEqual({ title: "Caius is thinking…", body: "Wind down · Three left open" });
        expect(chatNotice(scene({
            activity: { ask: activity("ask", { working: true, line: "Caius is reading the Journal…" }) },
            onScreen: { ritual: false, ask: true },
            visible: true
        }))).toEqual({ title: "Caius is thinking…", body: "Ask · Caius is reading the Journal…" });
    });
});

describe("repliedNotice", () => {
    const streaming = { ritual: activity("winddown", { working: true, streaming: true, line: "Three left" }) };
    const ended = { ritual: activity("winddown", { line: "Sleep well." }) };
    const posted = {
        id: CHAT_IDS.replied, title: "Caius replied", body: "Sleep well.", channelId: "caius",
        actionTypeId: "caius-reply", smallIcon: "ic_stat_caius", extra: { chat: "ritual" }
    };

    it("posts a reply that ends with the app hidden or its chat off screen", () => {
        expect(repliedNotice(streaming, scene({ activity: ended, onScreen: { ritual: true, ask: false }, visible: false })))
            .toEqual({ slot: "ritual", notification: posted });
        expect(repliedNotice(streaming, scene({ activity: ended, onScreen: { ritual: false, ask: false } })))
            .toEqual({ slot: "ritual", notification: posted });

        const ask = { ask: activity("ask", { working: true, streaming: true, line: "…" }) };
        expect(repliedNotice(ask, scene({ activity: { ask: activity("ask", { line: "Two meetings." }) } })))
            .toEqual({ slot: "ask", notification: { ...posted, body: "Two meetings.", extra: { chat: "ask" } } });
    });

    it("posts nothing for a chat on screen with the app visible, a reopen that never streamed, or a chat that closed", () => {
        expect(repliedNotice(streaming, scene({ activity: ended, onScreen: { ritual: true, ask: false } }))).toBeNull();
        const reopening = { ritual: activity("winddown", { working: true, line: "Caius is thinking…" }) };
        expect(repliedNotice(reopening, scene({ activity: ended }))).toBeNull();
        expect(repliedNotice(streaming, scene({ activity: {}, visible: false }))).toBeNull();
        expect(repliedNotice(ended, scene({ activity: ended, visible: false }))).toBeNull();
    });
});

describe("startChatNotifications", () => {
    const service = {
        startForegroundService: vi.fn(() => Promise.resolve()),
        updateForegroundService: vi.fn(() => Promise.resolve()),
        stopForegroundService: vi.fn(() => Promise.resolve())
    };
    const notifications = {
        schedule: vi.fn(() => Promise.resolve({ notifications: [] })),
        cancel: vi.fn(() => Promise.resolve())
    };
    let stop: () => void = () => undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        stop = startChatNotifications({ service, notifications });
    });

    afterEach(() => {
        stop();
        vi.useRealTimers();
    });

    const shown = (body: string) => ({
        id: CHAT_IDS.working, title: "Caius is thinking…", body, smallIcon: "ic_stat_caius",
        notificationChannelId: "caius-working", serviceType: 1, silent: true
    });

    it("starts the service with a turn, updates it at most once a second with the last line, and stops it after", () => {
        openRitual("winddown", "2026-11-03");
        publishActivity("ritual", working("Reading"));
        expect(service.startForegroundService).toHaveBeenCalledTimes(1);
        expect(service.startForegroundService).toHaveBeenLastCalledWith(shown("Wind down · Reading"));

        publishActivity("ritual", working("Three left"));
        publishActivity("ritual", working("Three left open"));
        expect(service.updateForegroundService).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(service.updateForegroundService).toHaveBeenCalledTimes(1);
        expect(service.updateForegroundService).toHaveBeenLastCalledWith(shown("Wind down · Three left open"));

        vi.advanceTimersByTime(1500);
        publishActivity("ritual", working("Two on deck"));
        expect(service.updateForegroundService).toHaveBeenCalledTimes(2);
        expect(service.updateForegroundService).toHaveBeenLastCalledWith(shown("Wind down · Two on deck"));

        publishActivity("ritual", working("One more"));
        publishActivity("ritual", replied("Sleep well."));
        expect(service.stopForegroundService).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2000);
        expect(service.updateForegroundService).toHaveBeenCalledTimes(2);
        expect(service.startForegroundService).toHaveBeenCalledTimes(1);
        expect(notifications.schedule).not.toHaveBeenCalled();
    });

    it("posts the reply that lands out of sight, and cancels it once that chat shows with the app visible", () => {
        openRitual("winddown", "2026-11-03");
        minimizeRitual();
        publishActivity("ritual", working("Reading"));
        publishActivity("ritual", replied("Sleep well."));
        expect(service.stopForegroundService).toHaveBeenCalledTimes(1);
        expect(notifications.schedule).toHaveBeenCalledTimes(1);
        expect(notifications.schedule).toHaveBeenLastCalledWith({ notifications: [ expect.objectContaining({ id: CHAT_IDS.replied, body: "Sleep well.", extra: { chat: "ritual" } }) ] });
        expect(notifications.cancel).not.toHaveBeenCalled();
        restoreRitual();
        expect(notifications.cancel).toHaveBeenCalledTimes(1);
        expect(notifications.cancel).toHaveBeenLastCalledWith({ notifications: [ { id: CHAT_IDS.replied } ] });

        appVisible.value = false;
        publishActivity("ritual", working("Again"));
        publishActivity("ritual", replied("Done."));
        expect(notifications.schedule).toHaveBeenCalledTimes(2);
        publishActivity("ritual", replied("Done, and saved."));
        expect(notifications.cancel).toHaveBeenCalledTimes(1);
        appVisible.value = true;
        expect(notifications.cancel).toHaveBeenCalledTimes(2);
    });
});

describe("a chat notification's tap or button", () => {
    const action = (actionId: string, extra: Record<string, unknown>, inputValue?: string) =>
        ({ actionId, inputValue, notification: { id: CHAT_IDS.replied, title: "Caius replied", body: "…", extra } }) as ActionPerformed;

    it("targets its chat, with the inline reply's words, and leaves the other notifications alone", () => {
        expect(chatTarget(action("tap", { chat: "ritual" }))).toEqual({ slot: "ritual" });
        expect(chatTarget(action("open", { chat: "ask" }))).toEqual({ slot: "ask" });
        expect(chatTarget(action("reply", { chat: "ask" }, "  Move it to Friday. "))).toEqual({ slot: "ask", reply: "Move it to Friday." });
        expect(chatTarget(action("reply", { chat: "ritual" }, "   "))).toEqual({ slot: "ritual" });
        expect(chatTarget(action("tap", { nudge: "plan" }))).toBeNull();
        expect(chatTarget(action("done", { reminderId: 3 }))).toBeNull();
        expect(chatTarget(action("tap", { chat: "other" }))).toBeNull();
    });

    it("shows the ritual, restored or reopened from its stored chat, and queues the reply for it", () => {
        storeChat("ritual", { noteId: "n1", kind: "winddown", date: "2026-11-03", effort: "medium" });
        openRitual("winddown", "2026-11-03", "n1");
        minimizeRitual();
        settingsOpen.value = true;
        openChat({ slot: "ritual", reply: "Yes." });
        expect(ritual.value).toMatchObject({ kind: "winddown", noteId: "n1", minimized: false });
        expect(settingsOpen.value).toBe(false);
        expect(pendingReply.value).toEqual({ slot: "ritual", noteId: "n1", text: "Yes." });

        pendingReply.value = null;
        ritual.value = null;
        storeChat("ritual", { noteId: "n2", kind: "plan", date: "2026-11-03", effort: "medium" });
        openChat({ slot: "ritual", reply: "Go on." });
        expect(ritual.value).toEqual({ kind: "plan", date: "2026-11-03", noteId: "n2" });
        expect(pendingReply.value).toEqual({ slot: "ritual", noteId: "n2", text: "Go on." });
    });

    it("shows Ask from under the ritual, and queues the reply for Ask with or without a stored chat", () => {
        storeChat("ask", { noteId: "a1", kind: "ask", date: "2026-11-03", effort: "medium" });
        openRitual("plan", "2026-11-03");
        openChat({ slot: "ask", reply: "Thanks." });
        expect(tab.value).toBe("ask");
        expect(ritual.value?.minimized).toBe(true);
        expect(pendingReply.value).toEqual({ slot: "ask", noteId: "a1", text: "Thanks." });

        storeChat("ask", null);
        openChat({ slot: "ask", reply: "Hello?" });
        expect(pendingReply.value).toEqual({ slot: "ask", noteId: null, text: "Hello?" });
    });

    it("says a reply to a closed ritual wasn't sent, and queues nothing", () => {
        snack.value = null;
        openChat({ slot: "ritual", reply: "Hello?" });
        expect(ritual.value).toBeNull();
        expect(pendingReply.value).toBeNull();
        expect(snack.value).toEqual({ text: "Your reply wasn't sent: that chat is closed.", tone: "error" });

        snack.value = null;
        openChat({ slot: "ritual" });
        expect(snack.value).toBeNull();
    });
});
