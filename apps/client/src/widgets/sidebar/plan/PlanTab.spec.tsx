import { ClassicEditor, Essentials, List, Paragraph, TodoList } from "ckeditor5";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type NoteContext from "../../../components/note_context";
import type FNote from "../../../entities/fnote";
import type { CaiusOpenTask, CaiusPlan, CaiusPlanTask } from "../../../services/caius";
import options from "../../../services/options";
import { buildNote } from "../../../test/easy-froca";
import { renderInto } from "../../../test/render";
import { getEditorNoteId, setEditorNoteId } from "../../react/NoteStore";

const api = vi.hoisted(() => ({
    plan: vi.fn(),
    open: vi.fn(),
    accept: vi.fn(),
    dismiss: vi.fn(),
    forward: vi.fn(),
    setState: vi.fn(),
    explain: vi.fn()
}));
const caiusWrite = vi.hoisted(() => vi.fn());
const caiusEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../../services/caius", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/caius")>()),
    caiusApi: api,
    caiusWrite,
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

import PlanTab, { openTaskInNote, useCaiusEnabled } from "./PlanTab";

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
        api.open.mockImplementation(async (lane: string) => ({
            total: LANES[lane]?.length ?? 0, tasks: LANES[lane] ?? []
        }));
        activeNote.current = buildNote({
            id: "today", title: "27", "#dateNote": "2026-10-27", content: DAY_HTML
        });
    });

    afterEach(() => vi.useRealTimers());

    it("shows the active day note's capacity, suggestions, lanes and close", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        expect(api.plan).toHaveBeenCalledWith("day", "2026-10-27");
        expect(api.open.mock.calls.map(([ lane ]) => lane)).toEqual([ "overdue", "week", "orbit" ]);
        expect(text(tab, ".plan-period-key")).toBe("2026-10-27");
        expect(text(tab, ".plan-capacity-summary")).toBe("75 min planned of 180–240 min");
        expect(tab.querySelector("meter")?.getAttribute("value")).toBe("75");
        expect(text(tab, ".plan-capacity-unestimated")).toBe("1 unestimated, counted at 30 min");

        act(() => click(tab.querySelector(".plan-capacity-unestimated")));
        expect(texts(tab, "#plan-capacity .plan-task-list li")).toEqual([ "No estimate" ]);

        expect(text(tab, "#plan-suggested .plan-task-text")).toBe("An idea");
        // Headings come from the note itself, so an empty one is offered too; Suggested is not.
        expect(menuItems(tab)).toEqual([ "Morning", "Afternoon", "Critical" ]);

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
        // Every write reads the plan again.
        expect(api.plan).toHaveBeenCalledTimes(4);
    });

    it("pulls a task into the viewed period through a write on the task's own note", async () => {
        api.plan.mockResolvedValue(dayPlan());
        const tab = await mount();

        await press(button(tab, "→ 2026-10-27", tab.querySelector("[data-lane=overdue]")));
        // The viewed note is the target, so its editors are locked too.
        expect(caiusWrite).toHaveBeenLastCalledWith(
            "yesterday", expect.any(Function), "Forwarded to 2026-10-27.",
            { alsoLock: [ "today" ] });
        expect(api.forward).toHaveBeenCalledWith([
            { noteId: "yesterday", listItemId: "late", to: "2026-10-27", expectedBlobId: "blob-1" }
        ]);
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
        await press(button(first, "", first, "Today → 2026-10-27"));
        await press(button(tab, "Apply"));
        expect(api.forward).toHaveBeenCalledWith([
            { noteId: "yesterday", listItemId: "t1", to: "2026-10-27", expectedBlobId: "blob-1" }
        ]);
    });

    it("applies the decided fates in a forward call and a drop call under one write", async () => {
        api.plan.mockResolvedValue(dayPlan());
        api.forward.mockResolvedValue([ { status: "moved" } ]);
        api.setState.mockResolvedValue([ { status: "skipped", reason: "already_cancelled" } ]);
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
        expect(api.forward).toHaveBeenCalledWith([
            { noteId: "today", listItemId: "t1", to: "2026-10-28", expectedBlobId: "blob-1" }
        ]);
        // The forward changed the note, so the drop goes without the old blobId.
        expect(api.setState).toHaveBeenCalledWith([
            {
                noteId: "today", listItemId: "t2", state: "cancelled", reason: "No longer needed",
                expectedBlobId: undefined
            }
        ]);
        expect(texts(tab, ".plan-close-results li")).toEqual([
            "Estimated: Forwarded to 2026-10-28.",
            "No estimate: This task is already dropped."
        ]);
    });

    it("stops a batch whose forward is stale, so that the write retries it", async () => {
        api.plan.mockResolvedValue(dayPlan());
        api.forward.mockResolvedValue([ { status: "skipped", reason: "stale", blobId: "blob-2" } ]);
        const { applyFates } = await import("./PlanClose");
        const results = await applyFates({
            forward: [ { noteId: "today", listItemId: "t1", to: "2026-10-28" } ],
            drop: [ { noteId: "today", listItemId: "t2", state: "cancelled", reason: "x" } ]
        }, "blob-1");
        expect(results).toEqual([ { status: "skipped", reason: "stale", blobId: "blob-2" } ]);
        expect(api.setState).not.toHaveBeenCalled();
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
        expect(text(tab, ".plan-capacity-summary")).toBe("75 min planned");
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
            totalMinutes: 75, target: { min: 180, max: 240 }, horizons: {}
        }
    };
}

function planTask(overrides: Partial<CaiusPlanTask>): CaiusPlanTask {
    return {
        noteId: "today", listItemId: null, state: "open", text: "", estMinutes: null, parent: null,
        section: "Morning", critical: false, ...overrides
    };
}

function openTask(
    overrides: Partial<CaiusOpenTask> & Pick<CaiusOpenTask, "noteId" | "period" | "text">
): CaiusOpenTask {
    return {
        listItemId: null, state: "open", parent: null, section: null, lane: null, ...overrides
    };
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
        editor.setData("<p>Marker</p><ul class=\"todo-list\"><li data-list-item-id=\"eone\">One</li>"
            + "<li data-list-item-id=\"etwo\">Two</li></ul>");
        await opening;

        expect(getEditorNoteId(editor)).toBe("yesterday");
        expect(editor.model.document.selection.getFirstPosition()?.parent.getAttribute("listItemId"))
            .toBe("etwo");
        await editor.destroy();
    });
});
