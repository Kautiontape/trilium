import type { EditedNotesResponse } from "@triliumnext/commons";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import Component from "../../components/component";
import NoteContext from "../../components/note_context";
import type FNote from "../../entities/fnote";
import froca from "../../services/froca";
import options from "../../services/options";
import server from "../../services/server";
import { buildNote } from "../../test/easy-froca";
import { renderInto } from "../../test/render";
import { NoteContextContext, ParentComponent } from "../react/react_utils";
import NoteTitleActions from "./NoteTitleActions";

// The attribute grid has a spec of its own; here one cell is enough for the section to show.
vi.mock("../PromotedAttributes", () => ({
    usePromotedAttributeData: () => [ [ { uniqueId: "cell" } ], () => {} ],
    PromotedAttributesContent: () => <div className="promoted-attributes-stub" />
}));
vi.mock("../NoteDetail", () => ({
    getExtendedWidgetType: async () => "text",
    checkFullHeight: () => true
}));
vi.mock("./NoteTypeSwitcher", () => ({ default: () => null }));
vi.mock("./PinnedAttachments", () => ({ default: () => null }));
vi.mock("./JournalNavigation", () => ({ default: () => null }));
vi.mock("./CaiusNudgeBar", () => ({ default: () => null }));
// The count only reaches the title through the interpolation, which a bare key leaves out.
vi.mock("../../services/i18n", async (importOriginal) => ({
    ...await importOriginal<typeof import("../../services/i18n")>(),
    t: (key: string, params?: { count?: number }) =>
        params?.count === undefined ? key : `${key}:${params.count}`
}));

describe("NoteTitleActions", () => {
    it("toggles the promoted attributes on their shortcut only for its own note context", async () => {
        const note = buildNote({ title: "Text", type: "text" });
        const noteContext = new NoteContext("ntx-split-2");
        noteContext.noteId = note.noteId;
        noteContext.viewScope = { viewMode: "default" };
        const parent = new Component();
        let container: HTMLElement | undefined;
        await act(async () => {
            container = renderInto(
                <ParentComponent.Provider value={parent}>
                    <NoteContextContext.Provider value={noteContext}>
                        <NoteTitleActions />
                    </NoteContextContext.Provider>
                </ParentComponent.Provider>
            );
        });
        const expanded = () => container?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded");
        expect(expanded()).toBe("false");

        await act(async () => { await parent.handleEvent("toggleRibbonTabPromotedAttributes", { ntxId: "ntx-split-1" }); });
        expect(expanded()).toBe("false");

        await act(async () => { await parent.handleEvent("toggleRibbonTabPromotedAttributes", { ntxId: "ntx-split-2" }); });
        expect(expanded()).toBe("true");
    });
});

describe("Notes edited on this day", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("lists the day's edits without the day note itself, preloaded, and counts them in the title", async () => {
        options.set("editedNotesOpenInRibbon", "false");
        const day = buildNote({ id: "day1", title: "Day", "#dateNote": "2026-09-30" });
        buildNote({ id: "editedA", title: "A" });
        buildNote({ id: "editedB", title: "B" });
        const get = vi.spyOn(server, "get")
            .mockResolvedValueOnce([ edited("day1"), edited("editedA"), edited("editedB") ]);
        const getNotes = vi.spyOn(froca, "getNotes");

        const section = await renderEditedNotes(day);

        await vi.waitFor(() => expect(title(section())).toBe("note_title.edited_notes_count:2"));
        expect(get).toHaveBeenCalledWith("edited-notes/2026-09-30");
        expect(getNotes).toHaveBeenCalledWith([ "editedA", "editedB" ], true);
        expect([ ...section()?.querySelectorAll("a.badge") ?? [] ].map((link) => link.textContent))
            .toEqual([ "A", "B" ]);
        expect(section()?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens as editedNotesOpenInRibbon says", async () => {
        options.set("editedNotesOpenInRibbon", "true");
        const day = buildNote({ title: "Day", "#dateNote": "2026-09-28" });
        vi.spyOn(server, "get").mockResolvedValueOnce([]);

        const section = await renderEditedNotes(day);

        await vi.waitFor(() => expect(title(section())).toBe("note_title.edited_notes_count:0"));
        expect(section()?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    });

    it("drops the count when the note changes, and discards a fetch the note moved on from", async () => {
        const get = vi.spyOn(server, "get").mockResolvedValueOnce([ edited("editedA") ]);
        buildNote({ id: "editedA", title: "A" });
        const section = await renderEditedNotes(buildNote({ title: "Day 1", "#dateNote": "2026-09-29" }));
        await vi.waitFor(() => expect(title(section())).toBe("note_title.edited_notes_count:1"));

        // Day 2's fetch is left pending: the old count has to go before its answer comes.
        let resolveSecond: (value: EditedNotesResponse) => void = () => {};
        get.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
        await section.show(buildNote({ title: "Day 2", "#dateNote": "2026-09-30" }));
        expect(title(section())).toBe("note_title.edited_notes");

        // Moving on again before day 2 answers: its late answer must not land under day 3.
        buildNote({ id: "editedC", title: "C" });
        buildNote({ id: "editedD", title: "D" });
        get.mockResolvedValueOnce([ edited("editedC"), edited("editedD") ]);
        await section.show(buildNote({ title: "Day 3", "#dateNote": "2026-10-01" }));
        await vi.waitFor(() => expect(title(section())).toBe("note_title.edited_notes_count:2"));
        await act(async () => {
            resolveSecond([ edited("editedA") ]);
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(title(section())).toBe("note_title.edited_notes_count:2");

        // A note that is not a day note shows no section and fetches nothing.
        await section.show(buildNote({ title: "Plain" }));
        expect(section()).toBeNull();
        expect(get).toHaveBeenCalledTimes(3);
    });
});

function edited(noteId: string) {
    return { noteId, isDeleted: false, title: noteId, notePath: [ noteId ] };
}

function title(section: Element | null | undefined) {
    return section?.querySelector(".collapsible-title")?.textContent?.trim();
}

/**
 * Renders the strip for `note` and returns a lookup of its edited notes section, whose `show()`
 * renders the strip again for another note, as a note switch does.
 */
async function renderEditedNotes(note: FNote) {
    const parent = new Component();
    const strip = (shown: FNote) => (
        <ParentComponent.Provider value={parent}>
            <NoteContextContext.Provider value={contextFor(shown)}>
                <NoteTitleActions />
            </NoteContextContext.Provider>
        </ParentComponent.Provider>
    );
    let container: HTMLElement | undefined;
    await act(async () => {
        container = renderInto(strip(note));
    });

    return Object.assign(() => container?.querySelector(".edited-notes"), {
        async show(shown: FNote) {
            await act(async () => {
                if (container) render(strip(shown), container);
            });
        }
    });
}

function contextFor(note: FNote) {
    const noteContext = new NoteContext("ntx-main");
    noteContext.noteId = note.noteId;
    noteContext.viewScope = { viewMode: "default" };
    return noteContext;
}
