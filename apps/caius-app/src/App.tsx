import "./app.css";

import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { ActionPerformed } from "@capacitor/local-notifications";
import { useEffect, useRef } from "preact/hooks";

import { chatActivity, closeRitual, minimizeRitual, onboarding, openRitual, quickAddRequested, resumed, ritual, runWaiting, settingsOpen, tab, type Tab, withDay } from "./app-state.js";
import { MiniChat } from "./components/MiniChat.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { closeSheet, Icon, type IconName, openSheet, sheet, SheetHost, Snackbar } from "./components/ui.js";
import { readStoredChats } from "./lib/chats.js";
import { loadConnection } from "./lib/connection.js";
import type { Reminder } from "./lib/local.js";
import { nextWorkdayKey } from "./lib/day.js";
import { scheduleNudges, scheduleReminder, setUpNotifications, snoozeNudge } from "./lib/notify.js";
import { api, appNow, connection, flushHeld, refreshToday, reminders, runWrite, saveReminders, settings, today } from "./lib/store.js";
import { Ask, Ritual } from "./screens/Chat.js";
import { Connect } from "./screens/Connect.js";
import { Plan } from "./screens/Plan.js";
import { Reminders } from "./screens/Reminders.js";
import { Settings } from "./screens/Settings.js";
import { Today } from "./screens/Today.js";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
    { id: "today", label: "Today", icon: "today" },
    { id: "plan", label: "Plan", icon: "calendar_view_week" },
    { id: "ask", label: "Ask", icon: "forum" },
    { id: "reminders", label: "Reminders", icon: "notifications" }
];

let booted: Promise<void> | null = null;

/**
 * The tabs, with the ritual and Settings over them. The ritual and Ask stay mounted while hidden, so
 * a turn keeps streaming and the answers gathered in a step card's pill stay.
 */
export function App() {
    // Ask mounts on its first visit, since `useChat` reads `serverStatus` as it mounts, and stays mounted
    // after; keyed by the day, it starts fresh on a new one.
    const askVisited = useRef(false);
    useEffect(() => {
        booted ??= boot();
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        const theme = settings.value.theme;
        if (theme === "system") {
            delete root.dataset.theme;
        } else {
            root.dataset.theme = theme;
        }
    }, [ settings.value.theme ]);

    useEffect(() => {
        if (quickAddRequested.value) {
            openSheet(<QuickAdd />);
        }
    }, [ quickAddRequested.value ]);

    useEffect(() => {
        const data = today.value;
        if (data) {
            void scheduleNudges(data, settings.value, appNow());
        }
    }, [ today.value, settings.value ]);

    useEffect(() => {
        if (today.value) {
            runWaiting(today.value.key);
        }
    }, [ today.value?.key ]);

    if (connection.value === undefined) {
        return null;
    }
    if (!connection.value || onboarding.value) {
        return <><Connect /><Snackbar /></>;
    }
    const open = ritual.value;
    askVisited.current ||= tab.value === "ask";

    return (
        <>
            <div class="shell" hidden={settingsOpen.value || (!!open && !open.minimized)}>
                <main class="shell-main">
                    {tab.value === "today" && <Today />}
                    {tab.value === "plan" && <Plan />}
                    {askVisited.current && <div key={today.value?.key} class="ask-host" hidden={tab.value !== "ask"}><Ask /></div>}
                    {tab.value === "reminders" && <Reminders />}
                </main>
                <MiniChat />
                {(tab.value === "today" || tab.value === "plan") && (
                    <button type="button" class="fab" aria-label="Add a task" onClick={() => openSheet(<QuickAdd />)}><Icon name="add" size={28} /></button>
                )}
                <nav class="nav">
                    {TABS.map((t) => (
                        <button key={t.id} type="button" class={`nav-item${tab.value === t.id ? " active" : ""}`}
                            aria-current={tab.value === t.id ? "page" : undefined} onClick={() => { tab.value = t.id; }}>
                            <span class="nav-glyph"><Icon name={t.icon} /></span>
                            <span class="nav-label">{t.label}</span>
                        </button>
                    ))}
                </nav>
            </div>
            {open && (
                <div key={`${open.kind}:${open.date}`} class="ritual-host" hidden={settingsOpen.value || open.minimized}>
                    <Ritual kind={open.kind} date={open.date} noteId={open.noteId} minimized={!!open.minimized} />
                </div>
            )}
            {settingsOpen.value && <Settings />}
            <SheetHost />
            <Snackbar />
        </>
    );
}

/**
 * Loads the connection, reopens the ritual that was on screen, and wires the platform's back
 * button, app lifecycle, shortcuts and notification actions.
 */
async function boot() {
    connection.value = await loadConnection();
    if (connection.value) {
        void refreshToday();
        const stored = readStoredChats().ritual;
        if (stored && stored.kind !== "ask") {
            openRitual(stored.kind, stored.date, stored.noteId);
        }
    }

    if (!Capacitor.isNativePlatform()) {
        applyLaunchUrl(window.location.href);
        return;
    }

    await setUpNotifications(onNotificationAction).catch(() => undefined);
    await CapApp.addListener("backButton", () => {
        if (sheet.value) {
            closeSheet();
        } else if (settingsOpen.value) {
            settingsOpen.value = false;
        } else if (ritual.value && !ritual.value.minimized) {
            // A running turn goes on behind the mini bar instead of being dropped.
            if (chatActivity.value.ritual?.working) {
                minimizeRitual();
            } else {
                closeRitual();
            }
        } else if (tab.value !== "today") {
            tab.value = "today";
        } else {
            void CapApp.minimizeApp();
        }
    });
    await CapApp.addListener("pause", () => void flushHeld());
    await CapApp.addListener("resume", () => {
        resumed.value++;
        if (connection.value) {
            void refreshToday();
        }
    });
    await CapApp.addListener("appUrlOpen", ({ url }) => applyLaunchUrl(url));
    const launch = await CapApp.getLaunchUrl();
    if (launch?.url) {
        applyLaunchUrl(launch.url);
    }
}

/** App shortcuts open `caius://add`, `caius://plan`, `caius://winddown` and `caius://ask`. */
function applyLaunchUrl(url: string) {
    const target = /caius:\/\/(\w+)/.exec(url)?.[1] ?? new URL(url).searchParams.get("open");
    const day = today.value?.key;
    switch (target) {
        case "add":
            quickAddRequested.value++;
            break;
        case "plan":
            withDay((d) => openRitual("plan", d), day);
            break;
        case "winddown":
            withDay((d) => openRitual("winddown", d), day);
            break;
        case "ask":
            tab.value = "ask";
            break;
    }
}

/** What a tap on a notification or one of its buttons does: the same thing as the button in the app. */
function onNotificationAction({ actionId, notification }: ActionPerformed) {
    const extra = (notification.extra ?? {}) as { nudge?: string; reminderId?: number };
    const day = today.value?.key;
    if (extra.reminderId !== undefined) {
        const reminder = reminders.value.find((r) => r.id === extra.reminderId);
        if (!reminder) {
            return;
        }
        if (actionId === "done" && reminder.task) {
            const { noteId, listItemId } = reminder.task;
            void runWrite(() => api().setState([ { noteId, listItemId, state: "done" } ]));
        }
        if (actionId === "snooze" || actionId === "tomorrow") {
            withDay((d) => moveReminder(reminder, actionId, d), day);
            return;
        }
        saveReminders(reminders.value.filter((r) => r.id !== reminder.id));
        return;
    }

    withDay((d) => runNudgeAction(actionId, notification, d), day);
}

/** Snooze 15 min, or Tomorrow at standup on the next workday. */
function moveReminder(reminder: Reminder, actionId: string, day: string) {
    const [ hour, minute ] = (settings.value.standupOverride || today.value?.rhythm.start || "09:30").split(":").map(Number);
    const at = actionId === "snooze"
        ? new Date(appNow().getTime() + 15 * 60_000)
        : new Date(`${nextWorkdayKey(day)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
    const moved = { ...reminder, at: at.toISOString() };
    saveReminders(reminders.value.map((r) => r.id === moved.id ? moved : r));
    void scheduleReminder(moved);
}

/** A nudge's button, or a tap on the nudge itself: the same as the button in the app. */
function runNudgeAction(actionId: string, notification: ActionPerformed["notification"], day: string) {
    const extra = (notification.extra ?? {}) as { nudge?: string };
    switch (actionId) {
        case "plan":
            openRitual("plan", day);
            break;
        case "winddown":
            openRitual("winddown", day);
            break;
        case "moveall": {
            const catchup = today.value?.catchup;
            if (catchup?.data.tasks.length) {
                void runWrite(() => api().forward(catchup.data.tasks.map((t) => ({ noteId: t.noteId, listItemId: t.listItemId, to: catchup.data.moveTo }))));
            }
            break;
        }
        case "skip":
            void runWrite(() => api().skipCatchup(day));
            break;
        case "later30":
        case "later60":
            void snoozeNudge(extra.nudge === "winddown" ? "winddown" : "plan", notification.title, notification.body, actionId === "later30" ? 30 : 60);
            break;
        default:
            tab.value = "today";
            if (extra.nudge === "plan" || extra.nudge === "catchup") openRitual("plan", day);
            if (extra.nudge === "winddown") openRitual("winddown", day);
    }
}
