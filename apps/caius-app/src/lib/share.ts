import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

import { snack } from "./store.js";

/** Longer than this goes as a file: Android's share sheet can't carry a very long text. */
const TEXT_LIMIT = 100_000;

/** The installed app's version, or undefined in a browser. */
export async function appVersion(): Promise<string | undefined> {
    if (!Capacitor.isNativePlatform()) {
        return undefined;
    }
    try {
        const info = await App.getInfo();
        return `${info.version} (${info.build})`;
    } catch {
        return undefined;
    }
}

/** Shares `text` through Android's share sheet; in a browser, the Web Share API, else the clipboard. */
export async function shareText(title: string, text: string, fileName: string) {
    try {
        if (Capacitor.isNativePlatform()) {
            if (text.length > TEXT_LIMIT) {
                const { uri } = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
                await Share.share({ title, url: uri });
            } else {
                await Share.share({ title, text });
            }
        } else if (navigator.share) {
            await navigator.share({ title, text });
        } else {
            await navigator.clipboard.writeText(text);
            snack.value = { text: "Copied the chat to the clipboard." };
        }
    } catch (e) {
        // Closing the share sheet rejects; that isn't a failure.
        if (!/cancel|abort/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))) {
            snack.value = { text: `Couldn't share the chat: ${e instanceof Error ? e.message : String(e)}`, tone: "error" };
        }
    }
}
