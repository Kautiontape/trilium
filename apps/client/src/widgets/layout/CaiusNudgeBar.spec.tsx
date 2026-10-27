import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Component from "../../components/component";
import type FNote from "../../entities/fnote";
import type { CaiusNudge } from "../../services/caius";
import LoadResults from "../../services/load_results";
import { buildNote } from "../../test/easy-froca";
import { ParentComponent } from "../react/react_utils";

const h = vi.hoisted(() => ({
    nudge: vi.fn(),
    skipCatchup: vi.fn(async () => ({})),
    apply: vi.fn(async () => [ { status: "moved" } ]),
    caiusWrite: vi.fn(),
    startCaiusConversation: vi.fn(async () => {}),
    enabled: true,
    desktop: true
}));
vi.mock("../../services/utils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../services/utils")>()),
    isDesktop: () => h.desktop
}));
vi.mock("../../services/caius", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../services/caius")>()),
    caiusApi: { nudge: h.nudge, skipCatchup: h.skipCatchup, apply: h.apply },
    caiusWrite: h.caiusWrite,
    startCaiusConversation: h.startCaiusConversation,
    isCaiusEnabled: async () => h.enabled,
    wasCaiusEnabled: () => false,
    openPeriodNoteIds: (key: string) => (key === "2026-11-04" ? [ "wed" ] : [])
}));

vi.mock("../../services/i18n", async () => {
    const { createInstance } = await import("i18next");
    const translations = await import("../../translations/en/translation.json");
    const i18n = createInstance();
    await i18n.init({
        lng: "en",
        interpolation: { escapeValue: false },
        resources: { en: { translation: translations.default } }
    });
    return { t: i18n.t };
});

import CaiusNudgeBar, { NUDGE_REFRESH_DELAY_MS } from "./CaiusNudgeBar";

const TODAY = "2026-11-04";

const CATCHUP: CaiusNudge = {
    date: TODAY, lastWorkday: "2026-11-03", state: "catchup",
    tasks: [
        { noteId: "tue", listItemId: "a", text: "First" },
        { noteId: "tue", listItemId: "b", text: "Second" },
        { noteId: "tue", listItemId: null, text: "Without an id" }
    ]
};

describe("CaiusNudgeBar", () => {
    let today: FNote;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: [ "Date", "setTimeout", "clearTimeout" ] });
        vi.setSystemTime(new Date(2026, 10, 4, 9, 0));
        vi.clearAllMocks();
        h.enabled = true;
        h.desktop = true;
        localStorage.clear();
        h.caiusWrite.mockImplementation(
            (_noteId: string, call: (blobId: string) => Promise<unknown>) => call("blob-1"));
        buildNote({ id: "tue", title: "3", "#dateNote": "2026-11-03" });
        today = buildNote({ id: "wed", title: "4", "#dateNote": TODAY });
    });

    afterEach(() => vi.useRealTimers());

    it("offers the catch-up of the last workday: move all to today, review, or skip", async () => {
        h.nudge.mockResolvedValue(CATCHUP);
        const bar = await mount(today);

        expect(h.nudge).toHaveBeenCalledWith(TODAY);
        expect(text(bar)).toBe("Tuesday has 3 open tasks.");
        expect(buttons(bar)).toEqual([ "Move all to today", "Review", "Skip" ]);

        await press(button(bar, "Move all to today"));
        expect(h.caiusWrite).toHaveBeenCalledWith("tue", expect.any(Function), "Moved 2 tasks to today.", { alsoLock: [ "wed" ] });
        expect(h.apply).toHaveBeenCalledWith({
            forwards: [ { noteId: "tue", listItemId: "a", to: TODAY }, { noteId: "tue", listItemId: "b", to: TODAY } ],
            drops: [],
            expectedBlobId: "blob-1"
        });
        await settle();
        expect(h.nudge).toHaveBeenCalledTimes(2);

        await press(button(bar, "Review"));
        expect(h.startCaiusConversation).toHaveBeenLastCalledWith("Wind down 2026-11-03");

        h.nudge.mockResolvedValue({ date: TODAY, lastWorkday: "2026-11-03", state: "unplanned" });
        await press(button(bar, "Skip"));
        await settle();
        expect(h.skipCatchup).toHaveBeenCalledWith(TODAY);
        expect(text(bar)).toBe("No plan yet.");
    });

    it("moves tasks from several notes without a version token, locking every source", async () => {
        h.nudge.mockResolvedValue({ ...CATCHUP, tasks: [
            { noteId: "tue", listItemId: "a", text: "First" },
            { noteId: "child", listItemId: "c", text: "In a child note" }
        ] });
        const bar = await mount(today);

        await press(button(bar, "Move all to today"));
        expect(h.caiusWrite).toHaveBeenCalledWith("tue", expect.any(Function), "Moved 2 tasks to today.", { alsoLock: [ "child", "wed" ] });
        expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ expectedBlobId: undefined }));
    });

    it("offers Plan my day before a plan, and Refresh after one, with the planned time", async () => {
        h.nudge.mockResolvedValue({ date: TODAY, lastWorkday: "2026-11-03", state: "unplanned" });
        const bar = await mount(today);
        expect(text(bar)).toBe("No plan yet.");
        await press(button(bar, "Plan my day"));
        expect(h.startCaiusConversation).toHaveBeenLastCalledWith("Plan my day 2026-11-04");

        h.nudge.mockResolvedValue({ date: TODAY, lastWorkday: "2026-11-03", state: "planned", plannedAt: "2026-11-04T08:40:12" });
        const planned = await mount(today);
        expect(text(planned)).toBe("Planned 08:40.");
        expect(buttons(planned)).toEqual([ "Refresh" ]);
        await press(button(planned, "Refresh"));
        expect(h.startCaiusConversation).toHaveBeenLastCalledWith("Plan my day 2026-11-04");
    });

    it("hides for the rest of the day on that note once dismissed, without skipping the catch-up", async () => {
        h.nudge.mockResolvedValue(CATCHUP);
        // A note of its own, since a dismissal outlives the test.
        const dismissed = buildNote({ id: "wed-dismissed", title: "4", "#dateNote": TODAY });
        const parent = new Component();
        const bar = await mount(dismissed, parent);
        await press(bar.querySelector(".caius-nudge-bar .bx-x"));

        expect(bar.querySelector(".caius-nudge-bar")).toBeNull();
        expect(h.skipCatchup).not.toHaveBeenCalled();
        expect(localStorage.getItem(`caius-nudge-dismissed:wed-dismissed:${TODAY}`)).not.toBeNull();
        // A hidden bar reads nothing: not on a change, not when the note opens again.
        h.nudge.mockClear();
        await changed(parent, (results) => results.addNote("tue", "elsewhere"));
        expect((await mount(dismissed)).querySelector(".caius-nudge-bar")).toBeNull();
        expect(h.nudge).not.toHaveBeenCalled();
        expect((await mount(today)).querySelector(".caius-nudge-bar")).not.toBeNull();

        // The next day the note is no longer today's; that day's note shows its bar again.
        vi.setSystemTime(new Date(2026, 10, 5, 9, 0));
        h.nudge.mockResolvedValue({ ...CATCHUP, date: "2026-11-05", lastWorkday: TODAY });
        const tomorrow = buildNote({ id: "thu", title: "5", "#dateNote": "2026-11-05" });
        expect(text(await mount(tomorrow))).toBe("Wednesday has 3 open tasks.");
    });

    it("shows nothing on a note that is not today's, on a protected one, on mobile, or while Caius is off", async () => {
        h.nudge.mockResolvedValue(CATCHUP);
        const other = buildNote({ id: "other", title: "Other" });
        const past = buildNote({ id: "past", title: "2", "#dateNote": "2026-11-02" });
        const future = buildNote({ id: "future", title: "5", "#dateNote": "2026-11-05" });
        for (const note of [ other, past, future ]) {
            expect((await mount(note)).querySelector(".caius-nudge-bar")).toBeNull();
        }
        expect(h.nudge).not.toHaveBeenCalled();

        expect((await mount(today)).querySelector(".caius-nudge-bar")).not.toBeNull();
        today.isProtected = true;
        expect((await mount(today)).querySelector(".caius-nudge-bar")).toBeNull();
        today.isProtected = false;

        // The mobile layout has no sidebar chat for the bar's actions to open.
        h.desktop = false;
        expect((await mount(today)).querySelector(".caius-nudge-bar")).toBeNull();
        h.desktop = true;

        h.nudge.mockClear();
        h.enabled = false;
        expect((await mount(today)).querySelector(".caius-nudge-bar")).toBeNull();
        expect(h.nudge).not.toHaveBeenCalled();
    });

    it("reads the state again after a change to the last workday's note, or a skip or brief on today's, and not for others", async () => {
        h.nudge.mockResolvedValue(CATCHUP);
        const parent = new Component();
        await mount(today, parent);
        expect(h.nudge).toHaveBeenCalledTimes(1);

        buildNote({ id: "unrelated", title: "Unrelated" });
        await changed(parent, (results) => results.addNote("unrelated", "elsewhere"));
        expect(h.nudge).toHaveBeenCalledTimes(1);

        // Typing in today's note changes nothing the bar reads.
        await changed(parent, (results) => results.addNote("wed", "elsewhere"));
        expect(h.nudge).toHaveBeenCalledTimes(1);

        await changed(parent, (results) => results.addNote("tue", "elsewhere"));
        expect(h.nudge).toHaveBeenCalledTimes(2);

        // A brief written under today's note: a new child and its labels.
        await changed(parent, (results) => results.addBranch("brief-branch", "elsewhere"));
        expect(h.nudge).toHaveBeenCalledTimes(3);
        await changed(parent, (results) => results.addAttribute("planned-at", "elsewhere"));
        expect(h.nudge).toHaveBeenCalledTimes(4);
    });
});

async function changed(parent: Component, fill: (results: LoadResults) => void) {
    const results = new LoadResults([
        { entityName: "branches", entityId: "brief-branch", entity: { branchId: "brief-branch", noteId: "brief", parentNoteId: "wed" } },
        { entityName: "attributes", entityId: "planned-at", entity: { attributeId: "planned-at", noteId: "brief", type: "label", name: "caiusPlannedAt", value: "" } }
    ] as unknown as ConstructorParameters<typeof LoadResults>[0]);
    fill(results);
    await act(async () => {
        await parent.handleEvent("entitiesReloaded", { loadResults: results });
    });
    await settle();
}

/** Lets the debounced read after a change run. */
async function settle() {
    await act(async () => {
        vi.advanceTimersByTime(NUDGE_REFRESH_DELAY_MS);
    });
    await flush();
}

async function mount(note: FNote, parent = new Component()) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
        render(
            <ParentComponent.Provider value={parent}>
                <CaiusNudgeBar note={note} />
            </ParentComponent.Provider>,
            host
        );
    });
    await flush();
    return host;
}

async function flush() {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}

async function press(element: Element | null | undefined) {
    if (!(element instanceof HTMLElement)) throw new Error("nothing to press");
    act(() => element.click());
    await flush();
}

function button(root: Element, label: string) {
    const found = [ ...root.querySelectorAll<HTMLElement>(".caius-nudge-actions button") ]
        .find((el) => el.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
}

function buttons(root: Element) {
    return [ ...root.querySelectorAll(".caius-nudge-actions button") ].map((el) => el.textContent?.trim());
}

function text(root: Element) {
    return root.querySelector(".caius-nudge-text")?.textContent?.trim();
}
