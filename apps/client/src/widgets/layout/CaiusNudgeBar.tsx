import "./CaiusNudgeBar.css";

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type FNote from "../../entities/fnote";
import { dayKey } from "../../menus/task_actions";
import {
    caiusApi, type CaiusNudge, caiusNow, caiusOpener, caiusWrite, openPeriodNoteIds, startCaiusConversation
} from "../../services/caius";
import froca from "../../services/froca";
import { t } from "../../services/i18n";
import type LoadResults from "../../services/load_results";
import { isDesktop } from "../../services/utils";
import { useCaiusEnabled } from "../sidebar/plan/PlanTab";
import ActionButton from "../react/ActionButton";
import Button from "../react/Button";
import { useNoteLabel, useNoteProperty, useTriliumEvent } from "../react/hooks";
import InfoBar from "../react/InfoBar";

/** How long the bar waits after a change to the day's notes before it reads its state again. */
export const NUDGE_REFRESH_DELAY_MS = 300;

/**
 * The slim bar at the top of today's day note (today by the Caius clock) that offers the next step of
 * the day: the last workday's catch-up, Plan my day, or Refresh once the day is planned. It shows on
 * no other note, on no protected note, not on mobile and not while Caius is off, and hides for the
 * day when dismissed.
 */
export default function CaiusNudgeBar({ note }: { note: FNote | null | undefined }) {
    const enabled = useCaiusEnabled();
    const [ dateNote ] = useNoteLabel(note, "dateNote");
    const isProtected = useNoteProperty(note, "isProtected");
    // The Caius clock is known once the status has answered, which is what `enabled` waits for.
    // The mobile layout has no sidebar chat, which most of the actions open.
    const date = note && enabled && !isProtected && isDesktop() && dateNote === dayKey(caiusNow()) ? dateNote : null;
    const { nudge, refresh } = useNudge(date, note?.noteId);
    const [ busy, setBusy ] = useState(false);
    const [ , setDismissals ] = useState(0);
    const dismissKey = note && date ? `caius-nudge-dismissed:${note.noteId}:${date}` : null;

    if (!date || !nudge || nudge.date !== date || !dismissKey || isDismissed(dismissKey)) {
        return null;
    }

    const start = (opener: string) => void startCaiusConversation(opener);
    const dismiss = () => {
        remember(dismissKey);
        setDismissals((count) => count + 1);
    };
    const moveAll = async (tasks: MovableTask[]) => {
        setBusy(true);
        await moveToToday(tasks, date);
        setBusy(false);
        refresh();
    };
    const skip = async () => {
        setBusy(true);
        try {
            await caiusApi.skipCatchup(date);
        } finally {
            setBusy(false);
            refresh();
        }
    };

    let text: string;
    let actions: { label: string; onClick: () => void }[];
    switch (nudge.state) {
        case "catchup": {
            const movable = nudge.tasks.filter((task): task is MovableTask => !!task.listItemId);
            text = t("caius.nudge.catchup", { weekday: weekdayName(nudge.lastWorkday), count: nudge.tasks.length });
            actions = [
                ...(movable.length ? [ { label: t("caius.nudge.move_all"), onClick: () => void moveAll(movable) } ] : []),
                { label: t("caius.nudge.review"), onClick: () => start(caiusOpener("winddown", nudge.lastWorkday)) },
                { label: t("caius.nudge.skip"), onClick: () => void skip() }
            ];
            break;
        }
        case "unplanned":
            text = t("caius.nudge.unplanned");
            actions = [ { label: t("caius.plan_my_day"), onClick: () => start(caiusOpener("plan", date)) } ];
            break;
        case "planned":
            text = nudge.plannedAt
                ? t("caius.nudge.planned", { time: nudge.plannedAt.slice(11, 16) })
                : t("caius.nudge.planned_untimed");
            actions = [ { label: t("caius.nudge.refresh"), onClick: () => start(caiusOpener("plan", date)) } ];
            break;
    }

    return (
        <InfoBar className="caius-nudge-bar" type="subtle">
            <div className="caius-nudge-bar-content">
                <span className="caius-nudge-text">{text}</span>
                <div className="caius-nudge-actions">
                    {actions.map(({ label, onClick }) => (
                        <Button key={label} size="small" text={label} disabled={busy} onClick={onClick} />
                    ))}
                </div>
                <ActionButton icon="bx bx-x" text={t("caius.nudge.hide")} onClick={dismiss} />
            </div>
        </InfoBar>
    );
}

type MovableTask = { noteId: string; listItemId: string; text: string };

/**
 * Reads the bar's state for `date` (none for `null`): at once, and debounced after a change to the
 * day note, the last workday's note, a note under today's, or a label the state depends on.
 */
function useNudge(date: string | null, noteId: string | undefined) {
    const [ nudge, setNudge ] = useState<CaiusNudge | null>(null);
    const latest = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout>>();

    const load = useCallback(async () => {
        const request = ++latest.current;
        if (!date) {
            setNudge(null);
            return;
        }
        try {
            const answer = await caiusApi.nudge(date);
            if (request === latest.current) setNudge(answer);
        } catch {
            if (request === latest.current) setNudge(null);
        }
    }, [ date ]);

    const refresh = useCallback(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), NUDGE_REFRESH_DELAY_MS);
    }, [ load ]);

    useEffect(() => {
        clearTimeout(timer.current);
        void load();
    }, [ load ]);
    useEffect(() => () => clearTimeout(timer.current), []);

    useTriliumEvent("entitiesReloaded", useCallback(({ loadResults }) => {
        if (date && noteId && touchesNudge(loadResults, [ date, ...(nudge ? [ nudge.lastWorkday ] : []) ], noteId)) {
            refresh();
        }
    }, [ date, noteId, nudge, refresh ]));

    return { nudge, refresh };
}

/** The labels the nudge state reads: the skip, and the brief's day and planned time. */
const NUDGE_LABELS = [ "caiusSkipCatchup", "morningBrief", "caiusPlannedAt" ];

/** Whether the changes touch a day note of `days`, a note under one, a child of `dayNoteId` or a nudge label. */
function touchesNudge(loadResults: LoadResults, days: string[], dayNoteId: string) {
    const inDays = (noteId: string) => {
        const changed = froca.notes[noteId];
        return !!changed && [ changed, ...changed.getParentNotes() ]
            .some((candidate) => days.includes(candidate.getOwnedLabelValue("dateNote") ?? ""));
    };

    return loadResults.getNoteIds().some(inDays)
        || loadResults.getAttributeRows().some((row) => NUDGE_LABELS.includes(row.name ?? "") || (!!row.noteId && inDays(row.noteId)))
        || loadResults.getBranchRows().some((row) => row.parentNoteId === dayNoteId);
}

/**
 * Forwards the catch-up's tasks to `date` in one request, through the same write as the Plan tab's
 * Close: their notes' editors and today's are locked and reloaded. The version token checks one note,
 * so it is sent only when every task is in the same one.
 */
function moveToToday(tasks: MovableTask[], date: string) {
    const sources = [ ...new Set(tasks.map((task) => task.noteId)) ];
    const [ first, ...others ] = sources;
    if (!first) return Promise.resolve(null);
    return caiusWrite(
        first,
        (expectedBlobId) => caiusApi.apply({
            forwards: tasks.map(({ noteId, listItemId }) => ({ noteId, listItemId, to: date })),
            drops: [],
            expectedBlobId: sources.length === 1 ? expectedBlobId : undefined
        }),
        t("caius.nudge.moved", { count: tasks.length }),
        { alsoLock: [ ...others, ...openPeriodNoteIds(date) ] }
    );
}

const WEEKDAYS = [ "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday" ];

/** The weekday of a `YYYY-MM-DD` in the UI's language: "Tuesday". */
function weekdayName(date: string) {
    const [ year, month, day ] = date.split("-").map(Number);
    return t(`i18n.${WEEKDAYS[new Date(year, month - 1, day).getDay()]}`);
}

/**
 * Dismissals live in this browser's local storage: they are a convenience of the view, not a synced
 * setting. `dismissedHere` keeps them for the session when the storage cannot be used.
 */
const dismissedHere = new Set<string>();

function isDismissed(key: string) {
    if (dismissedHere.has(key)) return true;
    try {
        return localStorage.getItem(key) !== null;
    } catch {
        return false;
    }
}

function remember(key: string) {
    dismissedHere.add(key);
    try {
        localStorage.setItem(key, "1");
    } catch {
        // `dismissedHere` holds it.
    }
}
