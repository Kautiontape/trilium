import type { WeekSettings } from "@triliumnext/commons";
import { useEffect, useMemo, useState } from "preact/hooks";

import appContext from "../../components/app_context";
import FNote from "../../entities/fnote";
import date_notes from "../../services/date_notes";
import hoisted_note from "../../services/hoisted_note";
import { t } from "../../services/i18n";
import {
    CalendarLevel,
    detectLevel,
    ExpectedAncestor,
    expectedAncestors,
    LEVEL_LABELS,
    stepValue
} from "../../services/journal_navigation";
import search from "../../services/search";
import { useTriliumOptionInt } from "../react/hooks";

export interface Crumb {
    level: CalendarLevel;
    noteId: string;
    title: string;
}

export interface JournalNavigation {
    level: CalendarLevel;
    crumbs: Crumb[];
    /** Null when there is no valid neighbour (e.g. week level with weeks disabled). */
    prev: { value: string; exists: boolean } | null;
    next: { value: string; exists: boolean } | null;
    /**
     * Set when the calendar root lies outside the hoisted subtree. The bar still
     * renders — hiding it reads as a bug on a note that visibly is a journal entry —
     * but every control is inert and carries this reason as a tooltip.
     */
    disabledReason: string | null;
    navigate(delta: 1 | -1): Promise<void>;
    goToday(): Promise<void>;
}

/**
 * Resolves everything the journal navigation bar needs, or null when the active note is
 * not a navigable calendar note.
 */
export function useJournalNavigation(note: FNote | null | undefined): JournalNavigation | null {
    const settings = useWeekSettings();
    const root = useMemo(() => (note ? resolveCalendarRoot(note) : null), [ note ]);
    const detected = useMemo(() => (note ? detectLevel(note) : null), [ note ]);

    const enabled = useMemo(() => ({
        week: !!root?.hasLabel("enableWeekNote"),
        quarter: !!root?.hasLabel("enableQuarterNote")
    }), [ root ]);

    const [ crumbs, setCrumbs ] = useState<Crumb[]>([]);
    const [ neighbours, setNeighbours ] = useState<{ prev: string | null; next: string | null; existing: Set<string> }>({
        prev: null, next: null, existing: new Set()
    });

    useEffect(() => {
        if (!note || !root || !detected) {
            setCrumbs([]);
            return;
        }

        // Guards against an out-of-order resolution overwriting a newer note's crumbs.
        let cancelled = false;
        const ancestors = expectedAncestors(detected.level, detected.value, settings, enabled);

        void resolveCrumbs(note, root.noteId, ancestors).then((resolved) => {
            if (!cancelled) {
                setCrumbs(resolved);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [ note, root, detected, settings, enabled ]);

    useEffect(() => {
        if (!root || !detected) {
            setNeighbours({ prev: null, next: null, existing: new Set() });
            return;
        }

        let cancelled = false;
        const prev = stepValue(detected.level, detected.value, -1, settings);
        const next = stepValue(detected.level, detected.value, 1, settings);

        void existingValues(detected.level, [ prev, next ], root.noteId).then((existing) => {
            if (!cancelled) {
                setNeighbours({ prev, next, existing });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [ root, detected, settings ]);

    if (!note || !root || !detected) {
        return null;
    }

    // Checked up front rather than after the write: the target note would otherwise
    // already exist by the time the unhoist prompt appeared, leaving an orphan on decline.
    const hoistedNoteId = hoisted_note.getHoistedNoteId();
    const rootReachable = hoistedNoteId === "root"
        || root.noteId === hoistedNoteId
        || root.hasAncestor(hoistedNoteId);
    const disabledReason = rootReachable ? null : t("journal_navigation.outside_hoisted_subtree");

    // Standing on a week note after `#enableWeekNote` was switched off: the note is
    // still there, but getWeekNote now returns null, so week stepping is a dead end.
    const stepsAvailable = !(detected.level === "week" && !enabled.week) && !disabledReason;

    const navigate = async (delta: 1 | -1) => {
        if (!stepsAvailable) return;

        const target = stepValue(detected.level, detected.value, delta, settings);
        if (!target) return;

        const targetNote = await openCalendarNote(detected.level, target, root.noteId);
        if (targetNote) {
            await appContext.tabManager.getActiveContext()?.setNote(targetNote.noteId);
        }
    };

    const goToday = async () => {
        if (disabledReason) return;

        // The client's local date — a server in another timezone would be wrong.
        const todayNote = await date_notes.getTodayNote();
        if (todayNote) {
            await appContext.tabManager.getActiveContext()?.setNote(todayNote.noteId);
        }
    };

    return {
        level: detected.level,
        crumbs,
        prev: stepsAvailable && neighbours.prev
            ? { value: neighbours.prev, exists: neighbours.existing.has(neighbours.prev) }
            : null,
        next: stepsAvailable && neighbours.next
            ? { value: neighbours.next, exists: neighbours.existing.has(neighbours.next) }
            : null,
        disabledReason,
        navigate,
        goToday
    };
}

/** Week settings, normalising the legacy `0` encoding of Sunday to `7`. */
function useWeekSettings(): WeekSettings {
    const [ rawFirstDayOfWeek ] = useTriliumOptionInt("firstDayOfWeek");
    const [ firstWeekOfYear ] = useTriliumOptionInt("firstWeekOfYear");
    const [ minDaysInFirstWeek ] = useTriliumOptionInt("minDaysInFirstWeek");

    return useMemo(() => ({
        firstDayOfWeek: rawFirstDayOfWeek === 0 ? 7 : (rawFirstDayOfWeek ?? 1),
        firstWeekOfYear: firstWeekOfYear ?? 0,
        minDaysInFirstWeek: minDaysInFirstWeek ?? 4
    }), [ rawFirstDayOfWeek, firstWeekOfYear, minDaysInFirstWeek ]);
}

/**
 * Walks up from `note` to the nearest calendar root. Returns null when there is none —
 * which is the gate that stops a stray `#dateNote` on an unrelated note from rendering
 * the bar, and which supplies the root id every navigation call needs.
 */
export function resolveCalendarRoot(note: FNote): FNote | null {
    const seen = new Set<string>();
    const queue = [ ...note.getParentNotes() ];

    while (queue.length) {
        const candidate = queue.shift();
        if (!candidate || seen.has(candidate.noteId)) continue;
        seen.add(candidate.noteId);

        if (candidate.hasLabel("workspaceCalendarRoot") || candidate.hasLabel("calendarRoot")) {
            return candidate;
        }

        queue.push(...candidate.getParentNotes());
    }

    return null;
}

/**
 * Resolves each expected ancestor to a real note.
 *
 * Matches by label value across *all* parent branches rather than taking `parents[0]`:
 * saved-search results carry a virtual parent, and a week note spanning two months is
 * legitimately cloned into both. Falls back to a root-scoped search when the tree shape
 * doesn't match — stale week settings, a failed clone, or a hand-placed note.
 */
async function resolveCrumbs(note: FNote, rootId: string, ancestors: ExpectedAncestor[]): Promise<Crumb[]> {
    const inTree = collectAncestors(note);
    const crumbs: Crumb[] = [];

    for (const ancestor of ancestors) {
        const matched = inTree.find((candidate) => candidate.getOwnedLabelValue(ancestor.labelName) === ancestor.value);

        if (matched) {
            crumbs.push({ level: ancestor.level, noteId: matched.noteId, title: matched.title });
            continue;
        }

        const found = await searchScoped(ancestor.labelName, ancestor.value, rootId);
        if (found) {
            crumbs.push({ level: ancestor.level, noteId: found.noteId, title: found.title });
        }
    }

    return crumbs;
}

/** Every transitive parent of `note`, from the client cache. Ancestors are always loaded. */
export function collectAncestors(note: FNote): FNote[] {
    const seen = new Set<string>();
    const result: FNote[] = [];
    const queue = [ ...note.getParentNotes() ];

    while (queue.length) {
        const candidate = queue.shift();
        if (!candidate || seen.has(candidate.noteId)) continue;
        seen.add(candidate.noteId);
        result.push(candidate);
        queue.push(...candidate.getParentNotes());
    }

    return result;
}

async function searchScoped(labelName: string, value: string, rootId: string): Promise<FNote | null> {
    const notes = await search.searchForNotes(`#${labelName}="${value}"`);
    return notes.find((candidate) => candidate.hasAncestor(rootId)) ?? null;
}

/** Non-mutating existence check, so Prev/Next can render a "will create" state. */
async function existingValues(level: CalendarLevel, values: (string | null)[], rootId: string): Promise<Set<string>> {
    const labelName = LEVEL_LABELS[level];
    const found = new Set<string>();
    const candidates = values.filter((value): value is string => !!value);

    await Promise.all(candidates.map(async (value) => {
        if (await searchScoped(labelName, value, rootId)) {
            found.add(value);
        }
    }));

    return found;
}

/** Creates (or finds) the target note. The hoist gate is checked by the caller. */
async function openCalendarNote(level: CalendarLevel, value: string, rootId: string) {
    switch (level) {
        case "day": return await date_notes.getDayNote(value, rootId);
        case "week": return await date_notes.getWeekNote(value, rootId);
        case "month": return await date_notes.getMonthNote(value, rootId);
        case "quarter": return await date_notes.getQuarterNote(value, rootId);
        case "year": return await date_notes.getYearNote(value, rootId);
    }
}
