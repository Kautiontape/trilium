// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ChatActivity, chatActivity, minimizeRitual, openRitual, ritual, settingsOpen, tab } from "../app-state.js";
import { MiniChat } from "./MiniChat.js";

let root: HTMLElement;

beforeEach(() => {
    ritual.value = null;
    tab.value = "today";
    settingsOpen.value = false;
    chatActivity.value = {};
    root = document.createElement("div");
    document.body.append(root);
    act(() => render(<MiniChat />, root));
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

describe("MiniChat", () => {
    it("shows the minimized ritual working, then its reply, and a tap restores it", () => {
        act(() => {
            openRitual("plan", "2026-11-03");
            minimizeRitual();
            chatActivity.value = { ritual: activity({ working: true, line: "Caius is reading the Journal…" }) };
        });
        const bar = root.querySelector<HTMLButtonElement>(".mini-chat");
        expect(bar?.textContent).toContain("Plan my day");
        expect(bar?.textContent).toContain("Caius is reading the Journal…");
        expect(bar?.classList.contains("working")).toBe(true);

        act(() => {
            chatActivity.value = { ritual: activity({ line: "Three things today", unseen: true }) };
        });
        const replied = root.querySelector<HTMLButtonElement>(".mini-chat");
        expect(replied?.classList.contains("working")).toBe(false);
        expect(replied?.textContent).toContain("Replied");
        expect(replied?.textContent).toContain("Three things today");

        act(() => replied?.click());
        expect(ritual.value?.minimized).toBe(false);
        expect(root.querySelector(".mini-chat")).toBeNull();
    });

    it("shows Ask from another tab while it works or has an unseen reply, and a tap opens Ask", () => {
        act(() => {
            chatActivity.value = { ask: activity({ kind: "ask", title: "Ask", line: "Two meetings." }) };
        });
        expect(root.querySelector(".mini-chat")).toBeNull();

        act(() => {
            chatActivity.value = { ask: activity({ kind: "ask", title: "Ask", line: "Two meetings.", unseen: true }) };
        });
        const bar = root.querySelector<HTMLButtonElement>(".mini-chat");
        expect(bar?.textContent).toContain("Ask");
        expect(bar?.textContent).toContain("Two meetings.");

        act(() => bar?.click());
        expect(tab.value).toBe("ask");
        expect(root.querySelector(".mini-chat")).toBeNull();
    });

    it("hides while the ritual or Settings covers the tabs", () => {
        act(() => {
            chatActivity.value = { ask: activity({ kind: "ask", title: "Ask", working: true }) };
        });
        expect(root.querySelector(".mini-chat")).not.toBeNull();
        act(() => openRitual("winddown", "2026-11-03"));
        expect(root.querySelector(".mini-chat")).toBeNull();
        act(() => {
            ritual.value = null;
            settingsOpen.value = true;
        });
        expect(root.querySelector(".mini-chat")).toBeNull();
    });
});

function activity(patch: Partial<ChatActivity>): ChatActivity {
    return { kind: "plan", title: "Plan my day", working: false, streaming: patch.working ?? false, line: "", unseen: false, ...patch };
}
