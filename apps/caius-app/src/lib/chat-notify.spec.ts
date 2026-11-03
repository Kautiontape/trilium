import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appVisible, chatActivity, type ChatActivity, openRitual, publishActivity, ritual, settingsOpen, tab } from "../app-state.js";
import { chatNotice, type ChatScene, startChatNotifications } from "./chat-notify.js";
import { CHAT_IDS } from "./notify.js";

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
    });
});
