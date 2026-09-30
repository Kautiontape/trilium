import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type FNote from "../../entities/fnote";

// Resolved by default: modules further down the import chain fetch at load time.
const mocks = vi.hoisted(() => ({
    serverGet: vi.fn<(url: string) => Promise<unknown>>(async () => []),
    frocaGetNotes: vi.fn<(noteIds: string[], silent: boolean) => Promise<unknown>>(async () => [])
}));

vi.mock("../../services/server", () => ({
    default: { get: (url: string) => mocks.serverGet(url) }
}));
vi.mock("../../services/froca", () => ({
    default: { getNotes: (noteIds: string[], silent: boolean) => mocks.frocaGetNotes(noteIds, silent) }
}));
vi.mock("../../services/i18n", () => ({ t: (key: string) => key }));
// The tab's link component drags in the app context; the hook under test never renders it.
vi.mock("../react/NoteLink", () => ({ default: () => null }));

// After the mocks: the hook must resolve the stubbed services.
import { useEditedNotes } from "./EditedNotesTab";

/** The two things the hook needs from a day note. */
function dayNote(noteId: string, dateNote: string) {
    return { noteId, getLabelValue: (name: string) => (name === "dateNote" ? dateNote : null) } as unknown as FNote;
}

function edited(noteId: string) {
    return { noteId, isDeleted: false, title: noteId, notePath: [noteId] };
}

function Probe({ note }: { note: FNote | null }) {
    const editedNotes = useEditedNotes(note);
    return <div>{editedNotes ? editedNotes.map((n) => n.noteId).join(",") || "empty" : "loading"}</div>;
}

let container: HTMLDivElement | undefined;

function renderProbe(note: FNote | null) {
    container = container ?? document.body.appendChild(document.createElement("div"));
    render(<Probe note={note} />, container);
    return container;
}

afterEach(() => {
    if (container) {
        render(null, container);
        container.remove();
        container = undefined;
    }
    mocks.serverGet.mockClear();
    mocks.frocaGetNotes.mockClear();
});

describe("useEditedNotes", () => {
    it("fetches the day's edits, leaves the day note itself out, and preloads the rest", async () => {
        mocks.serverGet.mockResolvedValueOnce([edited("day1"), edited("a"), edited("b")]);
        const probe = renderProbe(dayNote("day1", "2026-09-30"));

        expect(probe.textContent).toBe("loading");
        await vi.waitFor(() => expect(probe.textContent).toBe("a,b"));
        expect(mocks.serverGet).toHaveBeenCalledWith("edited-notes/2026-09-30");
        expect(mocks.frocaGetNotes).toHaveBeenCalledWith(["a", "b"], true);
    });

    it("clears the list when the note changes, and discards a fetch the note moved on from", async () => {
        mocks.serverGet.mockResolvedValueOnce([edited("a")]);
        const probe = renderProbe(dayNote("day1", "2026-09-29"));
        await vi.waitFor(() => expect(probe.textContent).toBe("a"));

        // Day 2's fetch is left pending: the old list has to go before its answer comes.
        let resolveSecond: (value: unknown) => void = () => {};
        mocks.serverGet.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
        renderProbe(dayNote("day2", "2026-09-30"));
        await vi.waitFor(() => expect(probe.textContent).toBe("loading"));

        // Moving on again before day 2 answers: its late answer must not land under day 3.
        mocks.serverGet.mockResolvedValueOnce([edited("c")]);
        renderProbe(dayNote("day3", "2026-10-01"));
        await vi.waitFor(() => expect(probe.textContent).toBe("c"));
        resolveSecond([edited("b")]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(probe.textContent).toBe("c");

        // Leaving day notes altogether drops the list without a fetch.
        renderProbe(null);
        await vi.waitFor(() => expect(probe.textContent).toBe("loading"));
        expect(mocks.serverGet).toHaveBeenCalledTimes(3);
    });
});
