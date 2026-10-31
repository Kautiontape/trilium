import "./connect.css";

import { readRhythm } from "@triliumnext/caius/src/daily/standing.js";
import { useState } from "preact/hooks";

import { onboarding } from "../app-state.js";
import { Button, Card } from "../components/ui.js";
import { caiusApi } from "../lib/caius.js";
import { type Connection, normalizeServerUrl, saveConnection } from "../lib/connection.js";
import { HttpError, hostOf, UnreachableError } from "../lib/http.js";
import { askForNotifications } from "../lib/notify.js";
import { connection, messageOf, refreshToday, serverStatus } from "../lib/store.js";

type Check =
    | { ok: true; conn: Connection; caiusOn: boolean | null; journal: boolean; rhythm: string }
    | { ok: false; title: string; detail: string };

/**
 * First run: the server URL and an ETAPI token. Test checks that the server accepts the token,
 * whether Caius's phone routes are there, that a Journal exists, and reads the Rhythm. Nothing is
 * prefilled: the URL is his to type. The token goes to the Keystore-backed storage and is never
 * shown again.
 */
export function Connect({ initialUrl, onDone }: { initialUrl?: string; onDone?: () => void }) {
    const [ url, setUrl ] = useState(initialUrl ?? "");
    const [ token, setToken ] = useState("");
    const [ testing, setTesting ] = useState(false);
    const [ check, setCheck ] = useState<Check | null>(null);
    const [ step, setStep ] = useState<"connect" | "notify">("connect");

    const test = async () => {
        const server = normalizeServerUrl(url);
        if (!server) {
            setCheck({ ok: false, title: "That isn't a server address", detail: "Type it as https://your-server or host:port." });
            return;
        }
        const conn = { url: server, token: token.trim() };
        setTesting(true);
        setCheck(null);
        try {
            const caius = caiusApi(conn);
            await caius.appInfo();
            const status = await caius.status();
            const plan = await caius.plan("day");
            const catchup = await caius.catchup(plan.key).catch(() => null);
            const r = readRhythm(catchup?.standing ?? null);
            setCheck({
                ok: true,
                conn,
                caiusOn: status ? status.enabled : null,
                journal: !!plan.key,
                rhythm: `standup ${r.start}, work ends ${r.workEnd}, bed ${r.end}`
            });
        } catch (e) {
            if (e instanceof UnreachableError) {
                setCheck({ ok: false, title: "Can't reach the server", detail: `Nothing answered at ${hostOf(server)}. Is Tailscale on? If the server uses its own certificate authority, install it on the phone once (Settings → Security → Encryption & credentials → Install a certificate → CA certificate).` });
            } else if (e instanceof HttpError && e.status === 401) {
                setCheck({ ok: false, title: "The token didn't work", detail: "Make one in Trilium: Options → ETAPI → Create new token, and paste it here." });
            } else {
                setCheck({ ok: false, title: "Caius didn't answer", detail: messageOf(e) });
            }
        } finally {
            setTesting(false);
        }
    };

    const connect = async (conn: Connection, caiusOn: boolean | null) => {
        await saveConnection(conn);
        if (!onDone) {
            onboarding.value = true;
        }
        connection.value = conn;
        serverStatus.value = caiusOn === null ? null : undefined;
        void refreshToday();
        if (onDone) {
            onDone();
        } else {
            setStep("notify");
        }
    };

    if (step === "notify") {
        return <NotifyAsk onDone={() => {
            onboarding.value = false;
        }} />;
    }

    return (
        <div class="screen connect">
            <header class="connect-head">
                <h1>Connect to Trilium</h1>
                <p class="ink-2">once, at first run</p>
            </header>
            <label class="connect-field">
                <span class="label-caps">Server</span>
                <input class="field" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellcheck={false}
                    placeholder="https://your-trilium-server" value={url}
                    onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
            </label>
            <label class="connect-field">
                <span class="label-caps">ETAPI token</span>
                <input class="field mono" type="password" autoCapitalize="off" autoCorrect="off" spellcheck={false}
                    placeholder="Paste the token" value={token}
                    onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
            </label>
            <p class="ink-2 connect-hint">Make one in Trilium: Options → ETAPI → Create new token. It stays in this phone's keystore and is never shown again.</p>
            <Button kind="primary" disabled={testing || !url.trim() || !token.trim()} onClick={() => void test()}>
                {testing ? "Testing…" : "Test and connect"}
            </Button>
            {check?.ok && (
                <Card tone="moss" class="connect-result">
                    <p><strong>● Connected</strong></p>
                    <p>{check.caiusOn === null ? "Caius works over MCP. Rituals and Ask need the Caius server update." : check.caiusOn ? "Caius is on" : "Caius is off on the server"}</p>
                    <p>{check.journal ? "Journal found" : "No Journal yet"}</p>
                    <p class="mono">Rhythm: {check.rhythm}</p>
                    <Button kind="primary" onClick={() => void connect(check.conn, check.caiusOn)}>Continue</Button>
                </Card>
            )}
            {check && !check.ok && (
                <Card tone="ochre" class="connect-result">
                    <p><strong>{check.title}</strong></p>
                    <p>{check.detail}</p>
                </Card>
            )}
        </div>
    );
}

/** After Connect: asks for notifications on a screen that shows what one looks like. No means a banner in Reminders, nothing more. */
function NotifyAsk({ onDone }: { onDone: () => void }) {
    return (
        <div class="screen connect">
            <header class="connect-head">
                <h1>Nudges</h1>
                <p class="ink-2">At most three a day, and the reminders you set.</p>
            </header>
            <div class="sample-notification" aria-label="A sample notification">
                <div class="mono ink-2">◆ Caius · Rituals · 09:40</div>
                <p><strong>No plan yet.</strong> Standup is at 10:00.</p>
                <div class="sample-actions"><span>Plan my day</span><span>In 30 min</span></div>
            </div>
            <Button kind="primary" onClick={() => void askForNotifications().finally(onDone)}>Allow notifications</Button>
            <Button kind="quiet" onClick={onDone}>Not now</Button>
        </div>
    );
}
