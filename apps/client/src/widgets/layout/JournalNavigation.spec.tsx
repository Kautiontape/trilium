import { describe, expect, it } from "vitest";

import type FNote from "../../entities/fnote";
import { expectedAncestors } from "../../services/journal_navigation";
import { collectAncestors, resolveCalendarRoot } from "./useJournalNavigation";

const SETTINGS = { firstDayOfWeek: 1, firstWeekOfYear: 0, minDaysInFirstWeek: 4 };

/** The subset of the real FNote surface that resolveCalendarRoot/collectAncestors use. */
interface FakeNote {
    noteId: string;
    title: string;
    getOwnedLabelValue(name: string): string | null;
    hasLabel(name: string): boolean;
    getParentNotes(): FakeNote[];
}

/**
 * Builds a fake note graph. Each entry is [noteId, labels, parentIds], and the returned
 * objects expose just the FNote surface the helpers use.
 */
function buildGraph(entries: Array<[string, Record<string, string>, string[]]>) {
    const notes = new Map<string, FakeNote>();

    for (const [ noteId, labels ] of entries) {
        notes.set(noteId, {
            noteId,
            title: noteId,
            getOwnedLabelValue: (name: string) => labels[name] ?? null,
            hasLabel: (name: string) => name in labels,
            getParentNotes: () => []
        });
    }

    for (const [ noteId, , parentIds ] of entries) {
        const note = notes.get(noteId);
        if (note) {
            note.getParentNotes = () => parentIds.map((id) => notes.get(id)).filter((n): n is FakeNote => !!n);
        }
    }

    return notes as unknown as Map<string, FNote>;
}

/** Narrows a fixture lookup to a non-nullable FNote, since ids in these tests always exist. */
function getNote(notes: Map<string, FNote>, noteId: string): FNote {
    const note = notes.get(noteId);
    if (!note) {
        throw new Error(`test fixture is missing note '${noteId}'`);
    }
    return note;
}

describe("resolveCalendarRoot", () => {
    it("finds the nearest calendar root above a day note", () => {
        const g = buildGraph([
            [ "root", {}, [] ],
            [ "cal", { calendarRoot: "" }, [ "root" ] ],
            [ "y2026", { yearNote: "2026" }, [ "cal" ] ],
            [ "day", { dateNote: "2026-07-20" }, [ "y2026" ] ]
        ]);

        expect(resolveCalendarRoot(getNote(g, "day"))?.noteId).toBe("cal");
    });

    it("prefers a workspace calendar root and returns null when there is none", () => {
        const withWorkspace = buildGraph([
            [ "ws", { workspaceCalendarRoot: "" }, [] ],
            [ "day", { dateNote: "2026-07-20" }, [ "ws" ] ]
        ]);
        expect(resolveCalendarRoot(getNote(withWorkspace, "day"))?.noteId).toBe("ws");

        // The stray-label gate: #dateNote on a note outside any calendar tree.
        const stray = buildGraph([
            [ "projects", {}, [] ],
            [ "meeting", { dateNote: "2026-07-20" }, [ "projects" ] ]
        ]);
        expect(resolveCalendarRoot(getNote(stray, "meeting"))).toBeNull();
    });
});

describe("crumb resolution", () => {
    it("matches each expected ancestor by label value", () => {
        const g = buildGraph([
            [ "cal", { calendarRoot: "", enableWeekNote: "" }, [] ],
            [ "y2026", { yearNote: "2026" }, [ "cal" ] ],
            [ "m07", { monthNote: "2026-07" }, [ "y2026" ] ],
            [ "w30", { weekNote: "2026-W30" }, [ "m07" ] ],
            [ "day", { dateNote: "2026-07-20" }, [ "w30" ] ]
        ]);

        const ancestors = expectedAncestors("day", "2026-07-20", SETTINGS, { week: true, quarter: false });
        const inTree = collectAncestors(getNote(g, "day"));
        const matched = ancestors.map((a) =>
            inTree.find((c) => c.getOwnedLabelValue(a.labelName) === a.value)?.noteId ?? null);

        expect(matched).toEqual([ "y2026", "m07", "w30" ]);
    });

    it("picks the right month for a day note under a week straddling two months", () => {
        // 2026-W31 runs Jul 27 - Aug 2 and is cloned under both months. Taking
        // parents[0] would yield July for a day note that belongs to August.
        const g = buildGraph([
            [ "cal", { calendarRoot: "", enableWeekNote: "" }, [] ],
            [ "y2026", { yearNote: "2026" }, [ "cal" ] ],
            [ "m07", { monthNote: "2026-07" }, [ "y2026" ] ],
            [ "m08", { monthNote: "2026-08" }, [ "y2026" ] ],
            [ "w31", { weekNote: "2026-W31" }, [ "m07", "m08" ] ],
            [ "aug1", { dateNote: "2026-08-01" }, [ "w31" ] ]
        ]);

        const ancestors = expectedAncestors("day", "2026-08-01", SETTINGS, { week: true, quarter: false });
        const inTree = collectAncestors(getNote(g, "aug1"));
        const monthAncestor = ancestors.find((a) => a.level === "month");
        const matchedMonth = inTree.find((c) =>
            c.getOwnedLabelValue("monthNote") === monthAncestor?.value);

        expect(monthAncestor?.value).toBe("2026-08");
        expect(matchedMonth?.noteId).toBe("m08");
        // The naive approach would have picked July.
        expect(getNote(g, "w31").getParentNotes()[0].noteId).toBe("m07");
    });
});
