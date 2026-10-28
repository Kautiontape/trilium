import { ClassicEditor, Essentials, List, Paragraph, TodoList } from "ckeditor5";
import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Component from "../../../components/component";
import type NoteContext from "../../../components/note_context";
import type FNote from "../../../entities/fnote";
import type { CaiusOpenTask, CaiusPlan, CaiusPlanTask } from "../../../services/caius";
import LoadResults from "../../../services/load_results";
import options from "../../../services/options";
import { buildNote } from "../../../test/easy-froca";
import { renderInto } from "../../../test/render";
import { getEditorNoteId, setEditorNoteId } from "../../react/NoteStore";
import { ParentComponent } from "../../react/react_utils";
import { RightPaneTabVisible } from "../RightPanelWidget";

const api = vi.hoisted(() => ({
    plan: vi.fn(),
    open: vi.fn(),
    accept: vi.fn(),
    dismiss: vi.fn(),
    forward: vi.fn(),
    setState: vi.fn(),
    apply: vi.fn(),
    explain: vi.fn(),
    context: vi.fn()
}));
const caiusWrite = vi.hoisted(() => vi.fn());
const startCaiusConversation = vi.hoisted(() => vi.fn());
const caiusEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../../services/caius", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/caius")>()),
    caiusApi: api,
    caiusWrite,
    startCaiusConversation,
    isCaiusEnabled: async () => caiusEnabled.value,
    wasCaiusEnabled: () => false,
    findOpenEditors: () => [],
    openPeriodNoteIds: (key: string) => (key === "2026-10-28" ? [ "tomorrow" ] : [])
}));

const activeNote = vi.hoisted(() => ({ current: null as FNote | null }));
vi.mock("../../react/hooks", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../react/hooks")>()),
    useActiveNoteContext: () => ({ note: activeNote.current, noteContext: undefined }),
    useStaticTooltip: () => {}
}));

vi.mock("../../../services/i18n", async () => {
    const { createInstance } = await import("i18next");
    const translations = await import("../../../translations/en/translation.json");
    const i18n = createInstance();
    await i18n.init({
        lng: "en",
        interpolation: { escapeValue: false },
        resources: { en: { translation: translations.default } }
    });
    return { t: i18n.t };
});

// The menu's own mechanics are Bootstrap's; the items are what is under test.
vi.mock("../../react/Dropdown", () => ({
    default: ({ text, children }: { text: string; children: ComponentChildren }) => (
        <div className="dropdown-stub"><span>{text}</span>{children}</div>
    )
}));

const prompt = vi.hoisted(() => vi.fn());
vi.mock("../../../services/dialog", () => ({ default: { prompt } }));

import PlanTab, { openTaskInNote, REFRESH_DELAY_MS, useCaiusEnabled } from "./PlanTab";

const DAY_HTML = "<h2>Morning</h2><ul class=\"todo-list\"><li>…</li></ul>"
    + "<h2>Afternoon</h2><h2>Suggested</h2>";

describe("PlanTab", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: [ "Date" ] });
        vi.setSystemTime(new Date(2026, 9, 27, 16, 0));
        vi.clearAllMocks();
        options.load({ rightPaneCollapsedItems: "[]" } as Parameters<typeof options.load>[0]);
        caiusWrite.mockImplementation(
            (_noteId: string, call: (blobId: string) => Promise<unknown>) => call("blob-1"));
        for (const write of [ api.accept, api.dismiss, api.forward ]) {
            write.mockResolvedValue([ { status: "moved" } ]);
        }
        api.setState.mockResolvedValue([ { status: "updated" } ]);
        api.context.mockImplementation(async (date: string) => ({ date, context: [] }));
        api.open.mockImplementation(async (lane?: string) => {
            const tasks = lane ? LANES[lane] ?? [] : Object.values(LANES).flat();
            return { total: tasks.length, tasks };
        });
        activeNote.current = buildNote({
            id: "today", title: "27", "#dateNote": "2026-10-27", content: DAY_HTML
        });
    });

    afterEach(() => vi.useRealTimers());

    it("shows the active day note's capacity, suggestions, lanes and close", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        expect(api.plan).toHaveBeenCalledWith("day", "2026-10-27");
        expect(api.open.mock.calls.map(([ lane ]) => lane)).toEqual([ undefined ]);
        expect(text(tab, ".plan-period-key")).toBe("2026-10-27");
        expect(text(tab, ".plan-capacity-summary")).toBe("1 h 15 m planned of 3–4 h");
        expect(tab.querySelector("meter")?.getAttribute("value")).toBe("75");
        expect(text(tab, ".plan-capacity-unestimated")).toBe("1 unestimated, counted at 30 m");

        act(() => click(tab.querySelector(".plan-capacity-unestimated")));
        expect(texts(tab, "#plan-capacity .plan-task-list li")).toEqual([ "No estimate" ]);

        expect(text(tab, "#plan-suggested .plan-task-text")).toBe("An idea");
        // Headings come from the note itself, so an empty one is offered too; Suggested is not.
        expect(menuItems(tab.querySelector("#plan-suggested") ?? tab)).toEqual([ "Morning", "Afternoon", "Critical" ]);

        const overdue = tab.querySelector("[data-lane=overdue]");
        expect(overdue?.textContent).toContain("Late task");
        expect(overdue?.textContent).toContain("2 days late");
        // A task already in the viewed note is not offered for pulling in.
        expect(tab.querySelector("[data-lane=week]")?.textContent).not.toContain("Already here");
        expect(tab.querySelector("[data-lane=week]")?.textContent).toContain("Week task");

        expect(text(tab, ".plan-close-count")).toBe("0 of 2 decided");
    });

    it("accepts under a section or as critical, and dismisses, on the period note", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        await press(button(tab, "Afternoon"));
        expect(caiusWrite).toHaveBeenLastCalledWith("today", expect.any(Function), "Accepted.");
        expect(api.accept).toHaveBeenLastCalledWith([
            { noteId: "today", listItemId: "s1", expectedBlobId: "blob-1", section: "Afternoon" }
        ]);

        await press(button(tab, "Critical"));
        expect(api.accept).toHaveBeenLastCalledWith([
            { noteId: "today", listItemId: "s1", expectedBlobId: "blob-1", critical: true }
        ]);

        api.dismiss.mockResolvedValue([ { status: "skipped", reason: "not_suggested" } ]);
        await press(button(tab, "Dismiss"));
        expect(api.dismiss).toHaveBeenCalledWith([
            { noteId: "today", listItemId: "s1", expectedBlobId: "blob-1" }
        ]);
        // The skip is said in place, in describeSkip's words.
        expect(text(tab, "#plan-suggested .plan-task-outcome"))
            .toBe("Only a task under Suggested can be accepted or dismissed.");
        // The writes' refreshes fold into one, after the debounce.
        expect(api.plan).toHaveBeenCalledTimes(1);
        await wait(REFRESH_DELAY_MS + 50);
        expect(api.plan).toHaveBeenCalledTimes(2);
    });

    it("reads every Pull in lane with one open call, at most 20 tasks a lane", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const many = Array.from({ length: 25 }, (_, index) => openTask({
            noteId: "yesterday", period: "2026-10-25", listItemId: `o${index}`,
            text: `Old ${index}`,
            lane: "overdue"
        }));
        api.open.mockResolvedValue({
            total: many.length + 1, tasks: [ ...many, ...LANES.week ?? [] ]
        });
        const tab = await mount();

        expect(api.open).toHaveBeenCalledTimes(1);
        expect(api.open.mock.calls[0]?.[0]).toBeUndefined();
        const rows = tab.querySelectorAll("[data-lane=overdue] .plan-task-list > li:not(.plan-lane-more)");
        expect(rows).toHaveLength(20);
        expect(text(tab, "[data-lane=overdue] .plan-lane-more")).toBe("and 5 more");
        expect(texts(tab, "[data-lane=week] li .plan-task-text")).toEqual([ "Week task" ]);
    });

    it("skips refreshes while the tab is hidden, and refreshes once when it shows", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const { container, setVisible, journalChanged } = mountInPane(false);
        await flush();
        expect(api.plan).not.toHaveBeenCalled();

        await journalChanged();
        await wait(REFRESH_DELAY_MS + 50);
        expect(api.plan).not.toHaveBeenCalled();

        await setVisible(true);
        await setVisible(true);
        expect(api.plan).toHaveBeenCalledTimes(1);
        expect(container.querySelector("#plan-capacity")).not.toBeNull();
    });

    it("starts no refresh while one is in flight, and runs at most one more after it", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const { journalChanged } = mountInPane(true);
        await flush();
        let answer = () => {};
        api.plan.mockImplementation(() => new Promise((resolve) => {
            answer = () => resolve(dayPlan());
        }));

        await journalChanged();
        await wait(REFRESH_DELAY_MS + 50);
        expect(api.plan).toHaveBeenCalledTimes(2);
        for (let i = 0; i < 3; i++) {
            await journalChanged();
            await wait(REFRESH_DELAY_MS + 50);
        }
        expect(api.plan).toHaveBeenCalledTimes(2);

        api.plan.mockResolvedValue(dayPlan());
        answer();
        await flush();
        await flush();
        expect(api.plan).toHaveBeenCalledTimes(3);
    });

    it("replaces the pull-in button with an Actions menu on each row", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        const rows = [ ...tab.querySelectorAll("#plan-pull-in .plan-pull-in-row") ];
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining("Late task"), expect.stringContaining("Week task")
        ]);
        for (const row of rows) {
            expect(menuItems(row)).toEqual([ "Pull in", "Done", "Drop…" ]);
            expect(row.querySelector(".dropdown-stub > span")?.textContent).toBe("Actions");
        }
        expect(tab.textContent).not.toContain("→ 2026-10-27");
    });

    it("pulls a task into the viewed period from the Actions menu", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        await press(button(tab, "Pull in", tab.querySelector("[data-lane=overdue]")));
        // The viewed note is the target, so its editors are locked too.
        expect(caiusWrite).toHaveBeenLastCalledWith(
            "yesterday", expect.any(Function), "Forwarded to 2026-10-27.",
            { alsoLock: [ "today" ] });
        expect(api.forward).toHaveBeenCalledWith([
            { noteId: "yesterday", listItemId: "late", to: "2026-10-27", expectedBlobId: "blob-1" }
        ]);
    });

    it("marks a Pull in task done, then reloads without its row", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        const overdue = LANES.overdue;
        LANES.overdue = [];
        try {
            await press(button(tab, "Done", tab.querySelector("[data-lane=overdue]")));
            expect(caiusWrite).toHaveBeenLastCalledWith(
                "yesterday", expect.any(Function), "Marked as done.", {});
            expect(api.setState).toHaveBeenCalledWith([
                { noteId: "yesterday", listItemId: "late", state: "done", expectedBlobId: "blob-1" }
            ]);
            await wait(REFRESH_DELAY_MS + 50);
            expect(text(tab, "[data-lane=overdue]")).not.toContain("Late task");
        } finally {
            LANES.overdue = overdue;
        }
    });

    it("drops a Pull in task with the reason asked for, and does nothing when asking is cancelled", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();
        const overdue = tab.querySelector("[data-lane=overdue]");

        prompt.mockResolvedValueOnce(null);
        await press(button(tab, "Drop…", overdue));
        expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: "Drop task" }));
        expect(api.setState).not.toHaveBeenCalled();

        prompt.mockResolvedValueOnce("  no longer needed ");
        await press(button(tab, "Drop…", overdue));
        expect(caiusWrite).toHaveBeenLastCalledWith(
            "yesterday", expect.any(Function), "Dropped.", {});
        expect(api.setState).toHaveBeenCalledWith([ {
            noteId: "yesterday", listItemId: "late", state: "cancelled",
            reason: "no longer needed", expectedBlobId: "blob-1"
        } ]);
    });

    it("says why a Pull in task without an id has no actions", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const idless = openTask({
            noteId: "week44", period: "2026-W44", text: "Unsaved task", lane: "week"
        });
        api.open.mockResolvedValue({ total: 1, tasks: [ idless ] });
        const tab = await mount();

        expect(text(tab, "[data-lane=week] .plan-task-outcome"))
            .toBe("This task has no id yet. Open its note and save it first.");
        expect(tab.querySelector("[data-lane=overdue] .plan-task-outcome")).toBeNull();
    });

    it("shows no Pull in card for a past period", async () => {
        activeNote.current = buildNote({
            id: "yesterday", title: "26", "#dateNote": "2026-10-26", content: DAY_HTML
        });
        api.plan.mockResolvedValue({ ...dayPlan(), key: "2026-10-26", noteId: "yesterday" });
        const tab = await mount();

        expect(tab.querySelector("#plan-capacity")).not.toBeNull();
        expect(tab.querySelector("#plan-pull-in")).toBeNull();
    });

    it("offers Today first when closing a past day, and forwards there", async () => {
        activeNote.current = buildNote({
            id: "yesterday", title: "26", "#dateNote": "2026-10-26", content: DAY_HTML
        });
        api.plan.mockResolvedValue({ ...dayPlan(), key: "2026-10-26", noteId: "yesterday" });
        const tab = await mount();
        const [ first ] = [ ...tab.querySelectorAll(".plan-close-list > li") ];
        if (!first) throw new Error("no close row");

        const titles = [ ...first.querySelectorAll("button") ].map((el) =>
            el.getAttribute("title") ?? el.dataset.bsOriginalTitle);
        expect(titles[0]).toBe("Today → 2026-10-27");
        // Nothing is pulled into a period that is already over.
        expect(tab.querySelector("#plan-pull-in")).toBeNull();
        await press(button(first, "", first, "Today → 2026-10-27"));
        await press(button(tab, "Apply"));
        expect(api.apply).toHaveBeenCalledWith({
            forwards: [ { noteId: "yesterday", listItemId: "t1", to: "2026-10-27" } ],
            drops: [],
            expectedBlobId: "blob-1"
        });
    });

    it("forwards to the target the row showed, even when Apply comes after midnight", async () => {
        vi.setSystemTime(new Date(2026, 9, 27, 23, 59, 50));
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();
        const [ first ] = [ ...tab.querySelectorAll(".plan-close-list > li") ];
        if (!first) throw new Error("no close row");
        await press(button(first, "", first, "Tomorrow → 2026-10-28"));

        vi.setSystemTime(new Date(2026, 9, 28, 0, 0, 30));
        await press(button(tab, "Apply"));
        expect(api.apply).toHaveBeenCalledWith(expect.objectContaining({
            forwards: [ { noteId: "today", listItemId: "t1", to: "2026-10-28" } ]
        }));
    });

    it("applies the decided fates in one request under one write", async () => {
        api.plan.mockResolvedValue(dayPlan());
        api.apply.mockResolvedValue([
            { status: "moved" }, { status: "skipped", reason: "already_cancelled" }
        ]);
        const tab = await mount();
        const [ first, second ] = [ ...tab.querySelectorAll(".plan-close-list > li") ];

        // Today is not a fate for closing today.
        expect(() => button(first, "", first, "Today → 2026-10-27")).toThrow();
        await press(button(first, "", first, "Tomorrow → 2026-10-28"));
        expect(text(first, ".plan-close-target")).toBe("Tomorrow → 2026-10-28");
        await press(button(second, "", second, "Drop"));
        // A drop without a reason is not decided yet.
        expect(text(tab, ".plan-close-count")).toBe("1 of 2 decided");
        const reason = second.querySelector<HTMLInputElement>(".plan-close-reason");
        act(() => {
            if (!reason) throw new Error("no reason box");
            reason.value = "No longer needed";
            reason.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(text(tab, ".plan-close-count")).toBe("2 of 2 decided");

        await press(button(tab, "Apply"));
        expect(caiusWrite).toHaveBeenCalledTimes(1);
        // Tomorrow's note is open, so its editors are locked too.
        expect(caiusWrite).toHaveBeenCalledWith(
            "today", expect.any(Function), "Closed 2 tasks.", { alsoLock: [ "tomorrow" ] });
        // One request, so one version check before its first write and one commit set to settle.
        expect(api.apply).toHaveBeenCalledTimes(1);
        expect(api.apply).toHaveBeenCalledWith({
            forwards: [ { noteId: "today", listItemId: "t1", to: "2026-10-28" } ],
            drops: [ {
                noteId: "today", listItemId: "t2", state: "cancelled", reason: "No longer needed"
            } ],
            expectedBlobId: "blob-1"
        });
        expect(api.forward).not.toHaveBeenCalled();
        expect(api.setState).not.toHaveBeenCalled();
        expect(texts(tab, ".plan-close-results li")).toEqual([
            "Estimated: Forwarded to 2026-10-28.",
            "No estimate: This task is already dropped."
        ]);
    });

    it("passes a stale batch back whole, so that the write saves and retries it", async () => {
        api.apply.mockResolvedValue([
            { status: "skipped", reason: "stale", blobId: "blob-2" },
            { status: "skipped", reason: "stale", blobId: "blob-2" }
        ]);
        const { applyFates } = await import("./PlanClose");
        const results = await applyFates({
            forward: [ { noteId: "today", listItemId: "t1", to: "2026-10-28" } ],
            drop: [ { noteId: "today", listItemId: "t2", state: "cancelled", reason: "x" } ]
        }, "blob-1");
        expect(results.every((result) => result.reason === "stale")).toBe(true);
        expect(api.apply).toHaveBeenCalledTimes(1);
    });

    it("shows a Suggested item's reason on a line of its own under what to do", async () => {
        api.plan.mockResolvedValue({
            ...dayPlan(),
            suggested: [
                planTask({ listItemId: "s1", text: "Get [ZAP-101](https://jira/ZAP-101) Verify the export done: because sitting in Dev Verify for 6 days (~30m)", section: "Suggested" }),
                planTask({ listItemId: "s2", text: "ZAP-111", section: "Suggested" })
            ]
        });
        const tab = await mount();

        expect(texts(tab, "#plan-suggested .plan-task-text")).toEqual([ "Get ZAP-101 Verify the export done (~30m)", "ZAP-111" ]);
        expect(texts(tab, "#plan-suggested .plan-task-reason")).toEqual([ "because sitting in Dev Verify for 6 days" ]);
    });

    it("lists the Context in force for the viewed day under Capacity, with when each line ends", async () => {
        api.plan.mockImplementation(async (period: string, key: string) => ({ ...dayPlan(), period, key }));
        api.context.mockResolvedValue({
            date: "2026-10-27",
            context: [
                { text: "[ZAP-2590](https://jira/ZAP-2590) is open", period: "week", key: "2026-W44", noteId: "week44" },
                { text: "Jaco out", until: "2026-10-27", period: "day", key: "2026-10-26", noteId: "yesterday" },
                { text: "Release frozen", until: "2026-11-13", period: "day", key: "2026-10-27", noteId: "today" }
            ]
        });
        const tab = await mount();

        expect(api.context).toHaveBeenCalledWith("2026-10-27");
        const cards = [ ...tab.querySelectorAll("[id^=plan-]") ].map((card) => card.id);
        expect(cards.indexOf("plan-context")).toBe(cards.indexOf("plan-capacity") + 1);
        expect(texts(tab, "#plan-context .plan-context-text")).toEqual([ "ZAP-2590 is open", "Jaco out", "Release frozen" ]);
        expect(texts(tab, "#plan-context li")).toEqual([
            "ZAP-2590 is open",
            "Jaco outuntil Tue 27 Octends soon",
            "Release frozenuntil Fri 13 Nov"
        ]);

        api.context.mockResolvedValue({ date: "2026-10-27", context: [] });
        await press(tab.querySelector(".plan-period-step .bx-chevron-right"));
        expect(api.context).toHaveBeenLastCalledWith("2026-10-28");
        expect(text(tab, "#plan-context")).toContain("No Context in force.");

        // A week or month has no single day to read the Context of.
        api.context.mockClear();
        await press(button(tab, "Week"));
        expect(api.plan).toHaveBeenLastCalledWith("week", "2026-W44");
        expect(api.context).not.toHaveBeenCalled();
        expect(tab.querySelector("#plan-context")).toBeNull();
    });

    it("steps between periods, switches to the week, and comes back to today", async () => {
        api.plan.mockImplementation(
            async (period: string, key: string) => ({ ...dayPlan(), period, key }));
        const tab = await mount();

        await press(tab.querySelector(".plan-period-step .bx-chevron-left"));
        expect(api.plan).toHaveBeenLastCalledWith("day", "2026-10-26");
        await press(button(tab, "Week"));
        expect(api.plan).toHaveBeenLastCalledWith("week", "2026-W44");
        expect(text(tab, ".plan-period-current")).toBe("This week");
        await press(tab.querySelector(".plan-period-step .bx-chevron-right"));
        expect(api.plan).toHaveBeenLastCalledWith("week", "2026-W45");
        // Next week is not due to close.
        expect(tab.querySelector("#plan-close")).toBeNull();
        await press(button(tab, "Today"));
        expect(api.plan).toHaveBeenLastCalledWith("day", "2026-10-27");
    });

    it("writes the planned total and target in hours and minutes", async () => {
        const shown = async (totalMinutes: number, target: { min: number; max: number } | null) => {
            api.plan.mockResolvedValue({
                ...dayPlan(), capacity: { ...dayPlan().capacity, totalMinutes, target }
            });
            return text(await mount(), ".plan-capacity-summary");
        };
        expect(await shown(220, { min: 180, max: 240 })).toBe("3 h 40 m planned of 3–4 h");
        expect(await shown(45, { min: 720, max: 900 })).toBe("45 m planned of 12–15 h");
        expect(await shown(240, { min: 150, max: 240 })).toBe("4 h planned of 2 h 30 m–4 h");
        // A heavy day's one focus figure, as the chat states it.
        expect(await shown(30, { min: 120, max: 120 })).toBe("30 m planned of 2 h");
        expect(await shown(0, null)).toBe("0 m planned");
    });

    it("shows the evening's minutes on a second line, apart from the work, and leaves evening tasks out of the unestimated list", async () => {
        const plan = dayPlan();
        api.plan.mockResolvedValue({
            ...plan,
            sections: [ ...plan.sections, { name: "Evening", kind: "slot", tasks: [ planTask({ listItemId: "t4", text: "Laundry", section: "Evening" }) ] } ],
            capacity: { ...plan.capacity, eveningMinutes: 45 }
        });
        const tab = await mount();
        expect(text(tab, ".plan-capacity-summary")).toBe("1 h 15 m planned of 3–4 h");
        expect(text(tab, ".plan-capacity-evening")).toBe("Evening: 45 m");
        act(() => click(tab.querySelector(".plan-capacity-unestimated")));
        expect(texts(tab, "#plan-capacity .plan-task-list li")).toEqual([ "No estimate" ]);

        api.plan.mockResolvedValue(dayPlan());
        expect((await mount()).querySelector(".plan-capacity-evening")).toBeNull();
    });

    it("starts Plan my day or Wind down for the viewed day as a new conversation, and offers neither for a week", async () => {
        api.plan.mockImplementation(
            async (period: string, key: string) => ({ ...dayPlan(), period, key }));
        const tab = await mount();

        await press(button(tab, "Plan my day"));
        expect(startCaiusConversation).toHaveBeenLastCalledWith("Plan my day 2026-10-27");
        await press(tab.querySelector(".plan-period-step .bx-chevron-left"));
        await press(button(tab, "Wind down"));
        expect(startCaiusConversation).toHaveBeenLastCalledWith("Wind down 2026-10-26");
        expect(startCaiusConversation).toHaveBeenCalledTimes(2);

        await press(button(tab, "Week"));
        expect(tab.querySelector(".plan-day-actions")).toBeNull();
    });

    it("says why the plan could not be read, and reads it again on Retry", async () => {
        api.plan.mockRejectedValueOnce(new Error("503")).mockResolvedValue(dayPlan());
        const tab = await mount();
        expect(tab.textContent).toContain("Caius could not read the plan: 503");

        await press(button(tab, "Retry"));
        expect(tab.querySelector("#plan-capacity")).not.toBeNull();
    });

    it("shows nothing suggested, and no close for a period not yet due", async () => {
        activeNote.current = buildNote({ id: "month", title: "December", "#monthNote": "2026-12" });
        api.plan.mockResolvedValue({
            ...dayPlan(), period: "month", key: "2026-12", suggested: [],
            capacity: { ...dayPlan().capacity, target: null }
        });
        const tab = await mount();

        expect(api.plan).toHaveBeenCalledWith("month", "2026-12");
        expect(text(tab, "#plan-suggested")).toContain("Nothing suggested.");
        expect(text(tab, ".plan-capacity-summary")).toBe("1 h 15 m planned");
        expect(tab.querySelector("meter")).toBeNull();
        expect(tab.querySelector("#plan-close")).toBeNull();
    });

    it("is hidden while Caius is off", async () => {
        caiusEnabled.value = false;
        let enabled: boolean | undefined;
        function Probe() {
            enabled = useCaiusEnabled();
            return null;
        }
        rendered(<Probe />);
        await flush();
        expect(enabled).toBe(false);

        caiusEnabled.value = true;
        rendered(<Probe />);
        await flush();
        expect(enabled).toBe(true);
    });
});

const LANES: Record<string, CaiusOpenTask[]> = {
    overdue: [ openTask({
        noteId: "yesterday", period: "2026-10-25", listItemId: "late", text: "Late task",
        lane: "overdue", daysLate: 2
    }) ],
    week: [
        openTask({
            noteId: "week44", period: "2026-W44", listItemId: "w1", text: "Week task", lane: "week"
        }),
        openTask({
            noteId: "today", period: "2026-10-27", listItemId: "t1", text: "Already here",
            lane: "week"
        })
    ],
    orbit: []
};

function dayPlan(): CaiusPlan {
    return {
        period: "day",
        key: "2026-10-27",
        noteId: "today",
        critical: [],
        sections: [ {
            name: "Morning",
            kind: "slot",
            tasks: [
                planTask({ listItemId: "t1", text: "Estimated", estMinutes: 45 }),
                planTask({ listItemId: "t2", text: "No estimate" }),
                planTask({ listItemId: "t3", text: "Done", state: "done" })
            ]
        } ],
        top3: [],
        suggested: [ planTask({ listItemId: "s1", text: "An idea", section: "Suggested" }) ],
        dismissed: [],
        capacity: {
            plannedMinutes: 45, estimatedCount: 1, unestimatedCount: 1, unestimatedMinutes: 30,
            totalMinutes: 75, eveningMinutes: 0, target: { min: 180, max: 240 }, horizons: {}
        }
    };
}

function planTask(overrides: Partial<CaiusPlanTask>): CaiusPlanTask {
    return {
        noteId: "today", listItemId: null, state: "open", text: "", estMinutes: null, parent: null,
        parentListItemId: null, section: "Morning", critical: false, ...overrides
    };
}

function openTask(
    overrides: Partial<CaiusOpenTask> & Pick<CaiusOpenTask, "noteId" | "period" | "text">
): CaiusOpenTask {
    return {
        listItemId: null, state: "open", parent: null, parentListItemId: null, section: null,
        lane: null, ...overrides
    };
}

/** Renders the tab as the right pane does, with a parent for its events and its visibility. */
function mountInPane(visible: boolean) {
    const parent = new Component();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const draw = (shown: boolean) => act(() => {
        render(
            <ParentComponent.Provider value={parent}>
                <RightPaneTabVisible.Provider value={shown}>
                    <PlanTab />
                </RightPaneTabVisible.Provider>
            </ParentComponent.Provider>,
            host
        );
    });
    draw(visible);
    return {
        container: host,
        async setVisible(shown: boolean) {
            draw(shown);
            await flush();
        },
        /** An edit to today's note, a Journal note, as the WebSocket delivers it. */
        async journalChanged() {
            const loadResults = new LoadResults([]);
            loadResults.addNote("today", "elsewhere");
            await act(async () => {
                await parent.handleEvent("entitiesReloaded", { loadResults });
            });
        }
    };
}

async function wait(ms: number) {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

async function mount() {
    const tab = rendered(<PlanTab />);
    await flush();
    return tab;
}

function rendered(vnode: ComponentChildren) {
    let container: HTMLElement | undefined;
    act(() => {
        container = renderInto(vnode);
    });
    if (!container) throw new Error("nothing rendered");
    return container;
}

async function flush() {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}

async function press(element: Element | null | undefined) {
    act(() => click(element));
    await flush();
}

function click(element: Element | null | undefined) {
    if (!(element instanceof HTMLElement)) throw new Error("nothing to click");
    element.click();
}

/** The button or menu item reading `label`, or named `title` when it shows an icon alone. */
function button(root: Element, label: string, scope: Element | null = root, title?: string) {
    const candidates = [
        ...(scope ?? root).querySelectorAll<HTMLElement>("button, a, .dropdown-item")
    ];
    const found = candidates.find((el) => title
        ? [ el.getAttribute("title"), el.dataset.bsOriginalTitle ].includes(title)
        : el.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${title ?? label}"`);
    return found;
}

function menuItems(root: Element) {
    return texts(root, ".dropdown-stub .dropdown-item");
}

function texts(root: Element, selector: string) {
    return [ ...root.querySelectorAll(selector) ].map((element) => element.textContent?.trim());
}

function text(root: Element, selector: string) {
    return root.querySelector(selector)?.textContent?.trim();
}

describe("openTaskInNote", () => {
    it("puts the caret on the task once the editor has loaded the note it opened", async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = await ClassicEditor.create(el, {
            plugins: [ Essentials, Paragraph, List, TodoList ], licenseKey: "GPL"
        });
        editor.setData("<p>The note shown before</p>");
        setEditorNoteId(editor, "today");
        // happy-dom has no layout to scroll.
        vi.spyOn(editor.editing.view, "scrollToTheSelection").mockImplementation(() => {});
        // The editor answers getTextEditor() at once, while it still holds the note shown before.
        const context = {
            note: { type: "text" },
            setNote: vi.fn(async () => {}),
            getTextEditor: async () => editor
        } as unknown as NoteContext;

        const opening = openTaskInNote(context, { noteId: "yesterday", listItemId: "etwo" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        setEditorNoteId(editor, "yesterday");
        editor.setData("<p>Marker</p><ul class=\"todo-list\">"
            + "<li data-list-item-id=\"eone\">One</li>"
            + "<li data-list-item-id=\"etwo\">Two</li></ul>");
        await opening;

        expect(getEditorNoteId(editor)).toBe("yesterday");
        const block = editor.model.document.selection.getFirstPosition()?.parent;
        expect(block?.is("element") && block.getAttribute("listItemId")).toBe("etwo");
        await editor.destroy();
    });
});
