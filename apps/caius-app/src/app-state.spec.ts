import { beforeEach, describe, expect, it } from "vitest";

import { chatActivity, closeRitual, minimizeRitual, openRitual, publishActivity, restoreRitual, ritual, settingsOpen, tab } from "./app-state.js";

beforeEach(() => {
    ritual.value = null;
    tab.value = "today";
    settingsOpen.value = false;
    chatActivity.value = {};
});

describe("the ritual's minimize and restore", () => {
    it("hides and shows the same ritual, and a second open of the same day restores it with its chat note", () => {
        openRitual("plan", "2026-11-03", "note1");
        minimizeRitual();
        expect(ritual.value).toEqual({ kind: "plan", date: "2026-11-03", noteId: "note1", minimized: true });
        restoreRitual();
        expect(ritual.value).toEqual({ kind: "plan", date: "2026-11-03", noteId: "note1", minimized: false });

        minimizeRitual();
        openRitual("plan", "2026-11-03");
        expect(ritual.value).toEqual({ kind: "plan", date: "2026-11-03", noteId: "note1", minimized: false });

        minimizeRitual();
        openRitual("winddown", "2026-11-03");
        expect(ritual.value).toEqual({ kind: "winddown", date: "2026-11-03", noteId: undefined });

        closeRitual();
        minimizeRitual();
        restoreRitual();
        expect(ritual.value).toBeNull();
    });
});

describe("publishActivity", () => {
    const working = { kind: "plan" as const, working: true, streaming: true, line: "Caius is reading the Journal…" };
    const replied = { kind: "plan" as const, working: false, streaming: false, line: "Three things today" };

    it("titles the chat, and marks a turn that ends off screen unseen until the chat shows again", () => {
        openRitual("plan", "2026-11-03");
        publishActivity("ritual", working);
        expect(chatActivity.value.ritual).toEqual({ ...working, title: "Plan my day", unseen: false });
        minimizeRitual();
        publishActivity("ritual", replied);
        expect(chatActivity.value.ritual).toMatchObject({ line: "Three things today", unseen: true });
        restoreRitual();
        expect(chatActivity.value.ritual?.unseen).toBe(false);

        publishActivity("ritual", working);
        publishActivity("ritual", replied);
        expect(chatActivity.value.ritual?.unseen).toBe(false);
        publishActivity("ritual", null);
        expect(chatActivity.value.ritual).toBeUndefined();
    });

    it("counts Ask off screen on another tab, under the ritual or under Settings, and not for a chat that only reopened", () => {
        const ask = { kind: "ask" as const, working: true, streaming: true, line: "…" };
        const done = { ...ask, working: false, streaming: false, line: "Two meetings." };
        tab.value = "ask";
        openRitual("winddown", "2026-11-03");
        publishActivity("ask", ask);
        publishActivity("ask", done);
        expect(chatActivity.value.ask).toMatchObject({ title: "Ask", unseen: true });
        closeRitual();
        expect(chatActivity.value.ask?.unseen).toBe(false);

        tab.value = "plan";
        publishActivity("ask", { ...done, working: true, streaming: false });
        publishActivity("ask", done);
        expect(chatActivity.value.ask?.unseen).toBe(false);

        tab.value = "ask";
        settingsOpen.value = true;
        publishActivity("ask", ask);
        publishActivity("ask", done);
        expect(chatActivity.value.ask?.unseen).toBe(true);
    });
});
