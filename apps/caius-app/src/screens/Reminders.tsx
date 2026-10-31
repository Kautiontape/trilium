import "./reminders.css";

import { useEffect, useState } from "preact/hooks";

import { openSettings } from "../app-state.js";
import { removeReminder } from "../components/sheets.js";
import { Button, Card, Icon } from "../components/ui.js";
import { clockMinutes, hhmm } from "../lib/day.js";
import type { Settings } from "../lib/local.js";
import { askForNotifications, notificationsAllowed } from "../lib/notify.js";
import { whenLabel } from "../lib/remind.js";
import { appNow, reminders, saveSettings, serverStatus, settings, today } from "../lib/store.js";

/**
 * What will buzz, and when: his own reminders first, then Caius's nudges as switches, with their
 * times read from the standing note's Rhythm and overridable on this phone, then quiet hours.
 */
export function Reminders() {
    const s = settings.value;
    const rhythm = today.value?.rhythm;
    const now = appNow();
    const [ allowed, setAllowed ] = useState<boolean | null>(null);
    useEffect(() => {
        void notificationsAllowed().then(setAllowed);
    }, []);
    const update = (patch: Partial<Settings>) => saveSettings({ ...s, ...patch });
    const standup = s.standupOverride || rhythm?.start || "10:00";
    const workEnd = s.workEndOverride || rhythm?.workEnd || "18:00";
    const planAt = hhmm(Math.max(0, (clockMinutes(standup) ?? 600) - 20));
    const upcoming = reminders.value.filter((r) => new Date(r.at) > new Date(now.getTime() - 3_600_000));

    return (
        <div class="screen reminders">
            <header class="today-head">
                <div>
                    <h1>Reminders</h1>
                    <p class="ink-2">on this phone</p>
                </div>
                <button type="button" class="icon-btn" aria-label="Settings" onClick={openSettings}><Icon name="settings" /></button>
            </header>

            {allowed === false && (
                <Card tone="ochre">
                    <p class="banner-text">Notifications are off for Caius, so nothing here will ring.</p>
                    <Button onClick={() => void askForNotifications().then(setAllowed)}>Allow notifications</Button>
                </Card>
            )}

            <section class="list-group">
                <h2 class="label-caps">Upcoming</h2>
                <div class="rows">
                    {upcoming.length === 0 && <p class="empty-row ink-2">Nothing set. Set one from a task's sheet, Quick add, or by asking: "remind me at 3 to…".</p>}
                    {upcoming.map((r) => (
                        <div key={r.id} class="reminder-row">
                            <span class="reminder-glyph"><Icon name="alarm" /></span>
                            <div class="reminder-body">
                                <div>{r.text}</div>
                                <div class="ink-2 reminder-sub">{whenLabel(new Date(r.at), now)} · {r.task ? r.task.where : r.source === "ask" ? "from Ask" : "reminder"}</div>
                            </div>
                            <button type="button" class="icon-btn" aria-label={`Remove ${r.text}`} onClick={() => removeReminder(r.id)}><Icon name="close" /></button>
                        </div>
                    ))}
                </div>
            </section>

            <section class="list-group">
                <h2 class="label-caps">Caius nudges <span class="mono">max 3 a day</span></h2>
                <div class="rows">
                    <Toggle label="Plan my day" detail={`${planAt} if no plan · catch-up with it`} checked={s.nudgePlan} onChange={(v) => update({ nudgePlan: v })} />
                    <Toggle label="Wind down" detail={`${workEnd} if not wound down`} checked={s.nudgeWinddown} onChange={(v) => update({ nudgeWinddown: v })} />
                    <Toggle label="Over capacity" detail="at standup, once" checked={s.nudgeOvercap} onChange={(v) => update({ nudgeOvercap: v })} />
                </div>
                {serverStatus.value === null && <p class="list-foot ink-2">This server has no nudge state yet, so Plan my day nudges only for a catch-up, and Wind down at the end of work.</p>}
            </section>

            <section class="list-group">
                <h2 class="label-caps">Times</h2>
                <div class="rows">
                    <TimeRow label="Standup" value={s.standupOverride} fallback={rhythm?.start} onChange={(v) => update({ standupOverride: v })} />
                    <TimeRow label="End of work" value={s.workEndOverride} fallback={rhythm?.workEnd} onChange={(v) => update({ workEndOverride: v })} />
                    <TimeRow label="Quiet from" value={s.quietFrom} fallback={rhythm?.end ? hhmm((clockMinutes(rhythm.end) ?? 0) % 1440) : undefined} onChange={(v) => update({ quietFrom: v })} />
                    <TimeRow label="Quiet until" value={s.quietTo} fallback={hhmm(Math.max(0, (clockMinutes(standup) ?? 600) - 30))} onChange={(v) => update({ quietTo: v })} />
                </div>
                <p class="list-foot ink-2">Empty follows the Rhythm in your standing note. Weekends carry your own reminders only.</p>
            </section>
        </div>
    );
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void }) {
    return (
        <label class="toggle-row">
            <div class="reminder-body">
                <div>{label}</div>
                <div class="ink-2 reminder-sub mono">{detail}</div>
            </div>
            <input type="checkbox" role="switch" class="switch" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        </label>
    );
}

function TimeRow({ label, value, fallback, onChange }: { label: string; value: string; fallback?: string; onChange: (value: string) => void }) {
    return (
        <label class="toggle-row">
            <div class="reminder-body">
                <div>{label}</div>
                {!value && fallback && <div class="ink-2 reminder-sub">from the Rhythm</div>}
            </div>
            <input type="time" class="time-field mono" value={value || fallback || ""} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />
        </label>
    );
}
