import { Capacitor } from "@capacitor/core";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

/** The server the app talks to and the ETAPI token it uses. */
export interface Connection {
    /** The server's origin, without a trailing slash. */
    url: string;
    token: string;
}

const KEY = "caius.connection";

/**
 * The saved connection. On the phone it lives in `capacitor-secure-storage-plugin`, which encrypts
 * it with a key held in the Android Keystore. In a desktop browser (development only) it lives in
 * `sessionStorage`, so it is gone when the tab closes.
 */
export async function loadConnection(): Promise<Connection | null> {
    try {
        const raw = Capacitor.isNativePlatform()
            ? (await SecureStoragePlugin.get({ key: KEY })).value
            : sessionStorage.getItem(KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as Partial<Connection>;
        return parsed.url && parsed.token ? { url: parsed.url, token: parsed.token } : null;
    } catch {
        return null;
    }
}

export async function saveConnection(conn: Connection) {
    const raw = JSON.stringify(conn);
    if (Capacitor.isNativePlatform()) {
        await SecureStoragePlugin.set({ key: KEY, value: raw });
    } else {
        sessionStorage.setItem(KEY, raw);
    }
}

export async function forgetConnection() {
    try {
        if (Capacitor.isNativePlatform()) {
            await SecureStoragePlugin.remove({ key: KEY });
        } else {
            sessionStorage.removeItem(KEY);
        }
    } catch {
        // Nothing was saved.
    }
}

/** `https://host/` or `host` as the origin the app calls, or null when it isn't a usable URL. */
export function normalizeServerUrl(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            return null;
        }
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        return null;
    }
}
