import "./reminders.css";

import { CAIUS_EFFORTS } from "@triliumnext/commons/src/lib/caius_openers.js";

import { settingsOpen } from "../app-state.js";
import { Button, Card, Chip, Icon } from "../components/ui.js";
import { forgetConnection } from "../lib/connection.js";
import { hostOf } from "../lib/http.js";
import type { Settings as SettingsShape } from "../lib/local.js";
import { sendTestNotification } from "../lib/notify.js";
import { connection, saveSettings, serverStatus, settings, snack, today } from "../lib/store.js";

/** The connection (with Sign out), the theme, Caius's thinking, haptics and a test notification. */
export function Settings() {
    const s = settings.value;
    const conn = connection.value;
    const update = (patch: Partial<SettingsShape>) => saveSettings({ ...s, ...patch });
    return (
        <div class="screen settings">
            <header class="today-head">
                <div>
                    <h1>Settings</h1>
                </div>
                <button type="button" class="icon-btn" aria-label="Close" onClick={() => { settingsOpen.value = false; }}><Icon name="close" /></button>
            </header>

            <Card>
                <div class="label-caps">Server</div>
                <p class="mono">{conn ? hostOf(conn.url) : "Not connected"}</p>
                <p class="ink-2">
                    {serverStatus.value === null
                        ? "Caius over MCP. Rituals and Ask need the Caius server update."
                        : serverStatus.value?.enabled ? "Caius is on." : "Checking Caius…"}
                    {today.value ? ` Today is ${today.value.label}.` : ""}
                </p>
                <p class="ink-2">The token is in this phone's keystore and is never shown.</p>
                <Button kind="danger" onClick={() => void forgetConnection().then(() => {
                    connection.value = null;
                    today.value = null;
                    serverStatus.value = undefined;
                    settingsOpen.value = false;
                })}>Sign out</Button>
            </Card>

            <Card>
                <div class="label-caps">Theme</div>
                <div class="chip-row">
                    {(["system", "light", "dark"] as const).map((t) => (
                        <Chip key={t} selected={s.theme === t} onClick={() => update({ theme: t })}>{t === "system" ? "System" : t === "light" ? "Light" : "Dark"}</Chip>
                    ))}
                </div>
            </Card>

            <Card>
                <div class="label-caps">Caius's thinking</div>
                <div class="chip-row">
                    {CAIUS_EFFORTS.map((e) => (
                        <Chip key={e} selected={s.caiusEffort === e} onClick={() => update({ caiusEffort: e })}>{e === "low" ? "Low" : e === "medium" ? "Medium" : "High"}</Chip>
                    ))}
                </div>
                <p class="ink-2">How long Caius thinks before answering in a chat. Low answers soonest; High takes about twice as long. Tap the line above a reply to read the thinking.</p>
            </Card>

            <Card>
                <label class="toggle-row settings-toggle">
                    <div class="reminder-body">
                        <div>Haptics</div>
                        <div class="ink-2 reminder-sub">On Done, Forward and Write it</div>
                    </div>
                    <input type="checkbox" role="switch" class="switch" checked={s.haptics} onChange={(e) => update({ haptics: (e.target as HTMLInputElement).checked })} />
                </label>
            </Card>

            <Card>
                <div class="label-caps">Notifications</div>
                <p class="ink-2">For reminders to ring on time in Doze, exempt Caius from battery optimisation in Android's settings. It is never required.</p>
                <Button onClick={() => void sendTestNotification().then((sent) => {
                    snack.value = { text: sent ? "A test nudge arrives in 5 seconds." : "Notifications only work in the app on the phone." };
                })}>Send a test nudge</Button>
            </Card>
        </div>
    );
}
