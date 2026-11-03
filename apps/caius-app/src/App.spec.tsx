// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it, vi } from "vitest";

import { minimizeRitual, openRitual, publishActivity, restoreRitual, ritual, settingsOpen, tab } from "./app-state.js";
import { App } from "./App.js";
import { today, type TodayData } from "./lib/store.js";

const mounts = vi.hoisted(() => ({ ritual: 0, ask: 0 }));
/** The day each Ask mount was given. */
const askDays = vi.hoisted((): (string | undefined)[] => []);

vi.mock("./screens/Chat.js", async () => {
    const { h } = await import("preact");
    const { useEffect, useState } = await import("preact/hooks");
    return {
        // Stands in for a ritual whose step cards hold answers in their own state.
        Ritual: () => {
            const [ answers, setAnswers ] = useState(0);
            useEffect(() => {
                mounts.ritual++;
            }, []);
            return h("button", { type: "button", class: "ritual-stub", onClick: () => setAnswers(answers + 1) }, `${answers} answers`);
        },
        Ask: ({ day }: { day: string | undefined }) => {
            useEffect(() => {
                mounts.ask++;
                askDays.push(day);
            }, []);
            return h("div", { class: "ask-stub" }, day);
        }
    };
});
vi.mock("./screens/Today.js", () => ({ Today: () => null }));
vi.mock("./screens/Plan.js", () => ({ Plan: () => null }));
vi.mock("./screens/Reminders.js", () => ({ Reminders: () => null }));
vi.mock("./screens/Settings.js", async () => {
    const { h } = await import("preact");
    return { Settings: () => h("div", { class: "settings-stub" }) };
});
vi.mock("./lib/connection.js", () => ({ loadConnection: () => Promise.resolve({ url: "https://caius.example", token: "t" }) }));
vi.mock("./lib/notify.js", () => ({ scheduleNudges: vi.fn(), scheduleReminder: vi.fn(), setUpNotifications: vi.fn(), snoozeNudge: vi.fn() }));
vi.mock("./lib/store.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./lib/store.js")>(), refreshToday: vi.fn() }));

describe("App", () => {
    it("keeps the ritual and Ask mounted while they are minimized, on another tab or under Settings", async () => {
        const root = document.createElement("div");
        document.body.append(root);
        act(() => render(<App />, root));
        await vi.waitFor(() => expect(root.querySelector(".shell")).not.toBeNull());

        act(() => openRitual("plan", "2026-11-03"));
        const host = () => root.querySelector<HTMLElement>(".ritual-host");
        const stub = () => root.querySelector<HTMLButtonElement>(".ritual-stub");
        expect(root.querySelector(".shell")?.hasAttribute("hidden")).toBe(true);
        act(() => stub()?.click());
        expect(stub()?.textContent).toBe("1 answers");

        act(() => minimizeRitual());
        expect(host()?.hasAttribute("hidden")).toBe(true);
        expect(root.querySelector(".shell")?.hasAttribute("hidden")).toBe(false);
        expect(root.querySelector(".mini-chat")?.textContent).toContain("Plan my day");
        expect(stub()?.textContent).toBe("1 answers");

        act(() => {
            tab.value = "ask";
        });
        act(() => {
            tab.value = "plan";
        });
        expect(root.querySelector(".ask-stub")).not.toBeNull();

        act(() => {
            settingsOpen.value = true;
        });
        expect(root.querySelector(".settings-stub")).not.toBeNull();
        expect(root.querySelector(".shell")?.hasAttribute("hidden")).toBe(true);
        act(() => {
            settingsOpen.value = false;
        });

        act(() => restoreRitual());
        expect(host()?.hasAttribute("hidden")).toBe(false);
        expect(stub()?.textContent).toBe("1 answers");
        expect(mounts).toEqual({ ritual: 1, ask: 1 });

        act(() => render(null, root));
        root.remove();
    });

    it("keeps Ask on its day through a turn that runs into the next one, and starts it fresh once it is out of sight", async () => {
        ritual.value = null;
        tab.value = "today";
        const day = (key: string) => {
            today.value = { key } as TodayData;
        };
        act(() => day("2026-11-03"));
        const root = document.createElement("div");
        document.body.append(root);
        act(() => render(<App />, root));
        await vi.waitFor(() => expect(root.querySelector(".shell")).not.toBeNull());
        askDays.length = 0;
        const shown = () => root.querySelector(".ask-stub")?.textContent;

        act(() => {
            tab.value = "ask";
        });
        expect(shown()).toBe("2026-11-03");
        act(() => publishActivity("ask", { kind: "ask", working: true, streaming: true, line: "Reading" }));
        act(() => {
            tab.value = "today";
        });
        act(() => day("2026-11-04"));
        expect(shown()).toBe("2026-11-03");

        act(() => publishActivity("ask", { kind: "ask", working: false, streaming: false, line: "Two meetings." }));
        expect(shown()).toBe("2026-11-03");
        act(() => {
            tab.value = "ask";
        });
        act(() => {
            tab.value = "plan";
        });
        expect(askDays).toEqual([ "2026-11-03", "2026-11-04" ]);
        expect(shown()).toBe("2026-11-04");

        act(() => {
            tab.value = "ask";
        });
        act(() => day("2026-11-05"));
        expect(shown()).toBe("2026-11-04");

        act(() => publishActivity("ask", null));
        act(() => render(null, root));
        root.remove();
        today.value = null;
    });
});
