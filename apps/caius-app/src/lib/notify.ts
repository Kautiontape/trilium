import { Capacitor } from "@capacitor/core";
import { type ActionPerformed, LocalNotifications, type LocalNotificationSchema } from "@capacitor/local-notifications";

import { clockMinutes, duration, hhmm, keyOf, nextWorkdayKey } from "./day.js";
import type { Reminder, Settings } from "./local.js";
import type { TodayData } from "./store.js";

/**
 * Phone notifications, all scheduled on the phone from the state it last read: Caius's nudges
 * (Plan my day or the catch-up, Wind down, over capacity: at most three a day) and the reminders
 * he sets. The plugin keeps the schedule across reboots itself. Every refresh of Today rebuilds the
 * nudges, so one that is no longer true (planned on the desktop) is cancelled when the app opens.
 */

export const CHANNELS = [
    { id: "rituals", name: "Rituals", description: "Plan my day, the catch-up and Wind down", importance: 3 },
    { id: "warnings", name: "Warnings", description: "Over capacity", importance: 3 },
    { id: "reminders", name: "Reminders", description: "Reminders you set", importance: 4 },
    { id: "sync", name: "Sync", description: "Captures waiting for the server", importance: 2 }
] as const;

/** Notification ids: the nudges have fixed ids, so scheduling one again replaces it. */
export const NUDGE_IDS = { plan: 11, winddown: 12, overcap: 13, nextPlan: 14 } as const;

/** In 30 min / In 1 h bring a nudge back once, under a fixed id of its own, so a later read of Today can cancel it. */
export const SNOOZE_IDS = { plan: 111, winddown: 112 } as const;

export async function setUpNotifications(onAction: (action: ActionPerformed) => void) {
    if (!Capacitor.isNativePlatform()) {
        return;
    }
    for (const channel of CHANNELS) {
        await LocalNotifications.createChannel({ ...channel, visibility: 1, vibration: channel.importance >= 3 });
    }
    await LocalNotifications.registerActionTypes({
        types: [
            { id: "plan", actions: [ { id: "plan", title: "Plan my day" }, { id: "later30", title: "In 30 min" } ] },
            { id: "catchup", actions: [ { id: "moveall", title: "Move all to today" }, { id: "plan", title: "Plan my day" }, { id: "skip", title: "Skip" } ] },
            { id: "winddown", actions: [ { id: "winddown", title: "Wind down" }, { id: "later60", title: "In 1 h" } ] },
            { id: "overcap", actions: [ { id: "open", title: "Open Today" } ] },
            { id: "reminder-task", actions: [ { id: "done", title: "Done" }, { id: "snooze", title: "Snooze 15 min" }, { id: "tomorrow", title: "Tomorrow" } ] },
            { id: "reminder", actions: [ { id: "snooze", title: "Snooze 15 min" }, { id: "tomorrow", title: "Tomorrow" } ] }
        ]
    });
    await LocalNotifications.addListener("localNotificationActionPerformed", onAction);
}

export async function notificationsAllowed(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) {
        return false;
    }
    return (await LocalNotifications.checkPermissions()).display === "granted";
}

export async function askForNotifications(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) {
        return false;
    }
    return (await LocalNotifications.requestPermissions()).display === "granted";
}

/**
 * The nudges Today calls for, as notifications to schedule. Pure, for the spec. Besides today's,
 * the next workday's morning nudge is scheduled ahead, so it exists even if the app isn't opened
 * after a wind-down; opening the app on that day reads the state again and replaces it.
 */
export function plannedNudges(data: TodayData, settings: Settings, now: Date): LocalNotificationSchema[] {
    if (data.offline) {
        return [];
    }
    const standup = clockMinutes(settings.standupOverride || data.rhythm.start) ?? 10 * 60;
    const workEnd = clockMinutes(settings.workEndOverride || data.rhythm.workEnd) ?? 18 * 60;
    const on = (day: string, minutes: number) => new Date(`${day}T${hhmm(minutes)}:00`);
    const nudges: LocalNotificationSchema[] = [];
    const state = data.nudge?.state;
    const catchupTasks = data.catchup && !data.catchup.data.skipped ? data.catchup.data.tasks : [];

    if (isWorkday(data.key) && keyOf(now) === data.key) {
        if (settings.nudgePlan && state !== "planned" && state !== "wound_down") {
            const when = on(data.key, Math.max(0, standup - 20));
            if (catchupTasks.length && data.catchup?.question) {
                nudges.push(nudge(NUDGE_IDS.plan, "rituals", "catchup", "Caius", data.catchup.question, when));
            } else if (state === "unplanned") {
                nudges.push(nudge(NUDGE_IDS.plan, "rituals", "plan", "No plan yet.", `Standup is at ${hhmm(standup)}.`, when));
            }
        }

        if (settings.nudgeWinddown && state !== "wound_down") {
            const open = data.plan.sections.flatMap((s) => s.tasks).filter((t) => t.state === "open" || t.state === "in_progress").length
                + data.plan.critical.filter((t) => t.state === "open" || t.state === "in_progress").length;
            const onDeck = data.plan.onDeck.filter((t) => t.state === "open").length;
            nudges.push(nudge(NUDGE_IDS.winddown, "rituals", "winddown", "Wind down when you're ready.",
                `${open} open, ${onDeck} on deck.`, on(data.key, workEnd)));
        }

        const target = data.plan.capacity.target;
        if (settings.nudgeOvercap && target && data.plan.capacity.totalMinutes > target.max) {
            const over = data.plan.capacity.totalMinutes - target.max;
            nudges.push(nudge(NUDGE_IDS.overcap, "warnings", "overcap", "Over capacity",
                `Today is ${duration(over)} over ${duration(target.min).replace(/ h$/, "")}–${duration(target.max)}.`, on(data.key, standup)));
        }
    }

    if (settings.nudgePlan) {
        const next = nextWorkdayKey(data.key);
        nudges.push(nudge(NUDGE_IDS.nextPlan, "rituals", "plan", "Plan my day", `Standup is at ${hhmm(standup)}.`, on(next, Math.max(0, standup - 20))));
    }

    return nudges.filter((n) => n.schedule?.at && n.schedule.at > now);
}

/** The snoozed nudges that are no longer true: the morning one once the day is planned, both once it is wound down. */
export function staleSnoozes(state: string | undefined): number[] {
    if (state === "wound_down") {
        return [ SNOOZE_IDS.plan, SNOOZE_IDS.winddown ];
    }
    return state === "planned" ? [ SNOOZE_IDS.plan ] : [];
}

/**
 * Replaces the scheduled nudges with the ones Today calls for now. Offline, Today is the snapshot,
 * so the schedule is left as it was.
 */
export async function scheduleNudges(data: TodayData, settings: Settings, now: Date) {
    if (data.offline || !Capacitor.isNativePlatform() || !(await notificationsAllowed())) {
        return;
    }
    const cancel = [ ...Object.values(NUDGE_IDS), ...staleSnoozes(data.nudge?.state) ];
    await LocalNotifications.cancel({ notifications: cancel.map((id) => ({ id })) });
    const nudges = plannedNudges(data, settings, now);
    if (nudges.length) {
        await LocalNotifications.schedule({ notifications: nudges });
    }
}

/** In 30 min / In 1 h: the nudge comes back once, then stops. */
export async function snoozeNudge(kind: "plan" | "winddown", title: string, body: string, minutes: number) {
    if (!Capacitor.isNativePlatform()) {
        return;
    }
    await LocalNotifications.schedule({
        notifications: [ nudge(SNOOZE_IDS[kind], "rituals", kind, title, body, new Date(Date.now() + minutes * 60_000)) ]
    });
}

/** Schedules (or replaces) one reminder he set. Reminders ring at the exact time, quiet hours or not, once he chose to. */
export async function scheduleReminder(reminder: Reminder) {
    if (!Capacitor.isNativePlatform()) {
        return;
    }
    await LocalNotifications.schedule({
        notifications: [ {
            id: reminder.id,
            title: reminder.text,
            body: reminder.task ? reminder.task.where : reminder.source === "ask" ? "From Ask" : "Reminder",
            channelId: "reminders",
            actionTypeId: reminder.task ? "reminder-task" : "reminder",
            schedule: { at: new Date(reminder.at), allowWhileIdle: true },
            extra: { reminderId: reminder.id },
            smallIcon: "ic_stat_caius"
        } ]
    });
}

export async function cancelReminder(id: number) {
    if (Capacitor.isNativePlatform()) {
        await LocalNotifications.cancel({ notifications: [ { id } ] });
    }
}

/** A test nudge a few seconds from now, from Settings. */
export async function sendTestNotification() {
    if (!Capacitor.isNativePlatform()) {
        return false;
    }
    await LocalNotifications.schedule({
        notifications: [ nudge(99, "rituals", "plan", "No plan yet.", "Standup is soon. This is a test.", new Date(Date.now() + 5000)) ]
    });
    return true;
}

/** Whether `at` falls inside quiet hours: the settings' range, or bedtime to 30 minutes before standup. */
export function inQuietHours(at: Date, settings: Settings, rhythm: { start: string; end: string }) {
    const from = clockMinutes(settings.quietFrom) ?? ((clockMinutes(rhythm.end) ?? 23 * 60) % (24 * 60));
    const to = clockMinutes(settings.quietTo) ?? Math.max(0, (clockMinutes(settings.standupOverride || rhythm.start) ?? 10 * 60) - 30);
    const minutes = at.getHours() * 60 + at.getMinutes();
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function nudge(id: number, channelId: string, actionTypeId: string, title: string, body: string, at: Date): LocalNotificationSchema {
    return { id, title, body, channelId, actionTypeId, schedule: { at, allowWhileIdle: true }, extra: { nudge: actionTypeId }, smallIcon: "ic_stat_caius" };
}

function isWorkday(key: string) {
    const day = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))).getDay();
    return day !== 0 && day !== 6;
}

