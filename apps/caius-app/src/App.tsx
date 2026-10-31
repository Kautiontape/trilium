import "./app.css";

import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { ActionPerformed } from "@capacitor/local-notifications";
import { useEffect } from "preact/hooks";

import { onboarding, openRitual, quickAddRequested, ritual, runWaiting, settingsOpen, tab, type Tab, withDay } from "./app-state.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { closeSheet, Icon, type IconName, openSheet, sheet, SheetHost, Snackbar } from "./components/ui.js";
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

export function App() {
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
    if (settingsOpen.value) {
        return <><Settings /><Snackbar /></>;
    }
    if (ritual.value) {
        return <><Ritual kind={ritual.value.kind} date={ritual.value.date} /><SheetHost /><Snackbar /></>;
    }

    return (
        <div class="shell">
            <main class="shell-main">
                {tab.value === "today" && <Today />}
                {tab.value === "plan" && <Plan />}
                {tab.value === "ask" && <Ask />}
                {tab.value === "reminders" && <Reminders />}
            </main>
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
            <SheetHost />
            <Snackbar />
        </div>
    );
}

/** Loads the connection, wires the platform's back button, app lifecycle, shortcuts and notification actions. */
async function boot() {
    connection.value = await loadConnection();
    if (connection.value) {
        void refreshToday();
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
        } else if (ritual.value) {
            ritual.value = null;
        } else if (tab.value !== "today") {
            tab.value = "today";
        } else {
            void CapApp.minimizeApp();
        }
    });
    await CapApp.addListener("pause", () => void flushHeld());
    await CapApp.addListener("resume", () => {
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
