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
 * the day: the last workday's catch-up, Plan my day, Refresh once the day is planned, or when it was wound down. It shows on
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
    const [ , setDismissals ] = useState(0);
    const dismissKey = note && date ? `caius-nudge-dismissed:${note.noteId}:${date}` : null;
    const dismissed = !!dismissKey && isDismissed(dismissKey);
    const { nudge, refresh } = useNudge(dismissed ? null : date, note?.noteId);
    const [ busy, setBusy ] = useState(false);

    if (!date || !nudge || nudge.date !== date || !dismissKey || dismissed) {
        return null;
    }

    const start = (opener: string) => void startCaiusConversation(opener);
    const dismiss = () => {
        remember(dismissKey);
        setDismissals((count) => count + 1);
    };
    const moveAll = async (tasks: MovableTask[]) => {
        setBusy(true);
        try {
            await moveToToday(tasks, date);
        } finally {
            setBusy(false);
            refresh();
        }
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

    // A plan made on an earlier day was made before today began, so today still has none.
    const shown: CaiusNudge = nudge.state === "planned" && !!nudge.plannedAt && nudge.plannedAt.slice(0, 10) < date
        ? { date: nudge.date, lastWorkday: nudge.lastWorkday, state: "unplanned" }
        : nudge;

    let text: string;
    let actions: { label: string; onClick: () => void }[];
    switch (shown.state) {
        case "catchup": {
            const movable = shown.tasks.filter((task): task is MovableTask => !!task.listItemId);
            const days = shown.days?.length ? shown.days : [ shown.lastWorkday ];
            const names = days.map(weekdayName);
            text = names.length > 1
                ? t("caius.nudge.catchup_days", { weekdays: t("caius.nudge.list_and", { head: names.slice(0, -1).join(", "), last: names.at(-1) }), count: shown.tasks.length })
                : t("caius.nudge.catchup", { weekday: names[0], count: shown.tasks.length });
            // Review closes the oldest day first; its wind-down sends what's left on.
            const oldest = days[0] ?? shown.lastWorkday;
            actions = [
                ...(movable.length ? [ { label: t("caius.nudge.move_all"), onClick: () => void moveAll(movable) } ] : []),
                { label: t("caius.nudge.review"), onClick: () => start(caiusOpener("winddown", oldest)) },
                { label: t("caius.nudge.skip"), onClick: () => void skip() }
            ];
            break;
        }
        case "unplanned":
            text = t("caius.nudge.unplanned");
            actions = [ { label: t("caius.plan_my_day"), onClick: () => start(caiusOpener("plan", date)) } ];
            break;
        case "planned":
            text = plannedText(shown.plannedAt, date);
            actions = [ { label: t("caius.nudge.refresh"), onClick: () => start(caiusOpener("plan", date)) } ];
            break;
        case "wound_down":
            text = shown.woundDownAt ? t("caius.nudge.wound_down", { time: shown.woundDownAt.slice(11, 16) }) : t("caius.nudge.wound_down_untimed");
            actions = [];
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

/** "Planned 09:40." for a plan made on `date`, else with the weekday it was made: "Planned Fri 17:20." */
function plannedText(plannedAt: string | null, date: string) {
    if (!plannedAt) {
        return t("caius.nudge.planned_untimed");
    }

    const plannedOn = plannedAt.slice(0, 10);
    const time = plannedAt.slice(11, 16);
    return plannedOn === date
        ? t("caius.nudge.planned", { time })
        : t("caius.nudge.planned_on", { weekday: shortWeekday(plannedOn), time });
}

/**
 * Reads the bar's state for `date` (none for `null`): at once, and debounced after a change that
 * {@link touchesNudge}.
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
        const days = nudge?.state === "catchup" && nudge.days?.length ? nudge.days : nudge ? [ nudge.lastWorkday ] : [];
        if (date && noteId && touchesNudge(loadResults, days, noteId)) {
            refresh();
        }
    }, [ date, noteId, nudge, refresh ]));

    return { nudge, refresh };
}

/** The labels the nudge state reads: the wind-down, the skip, and the brief's day and planned time. */
const NUDGE_LABELS = [ "caiusWoundDown", "caiusSkipCatchup", "morningBrief", "caiusPlannedAt" ];

/**
 * Whether the changes touch what the bar reads: the day note of one of the catch-up's `days` (the
 * last workday when there is no catch-up) or a note under it, a new child of today's note
 * `dayNoteId` (a brief), or a skip or brief label. Edits to the text of today's note change none of it.
 */
function touchesNudge(loadResults: LoadResults, days: string[], dayNoteId: string) {
    const inLastWorkday = (noteId: string) => {
        const changed = froca.notes[noteId];
        return !!changed && [ changed, ...changed.getParentNotes() ]
            .some((candidate) => days.includes(candidate.getOwnedLabelValue("dateNote") ?? ""));
    };

    return loadResults.getNoteIds().some(inLastWorkday)
        || loadResults.getAttributeRows().some((row) => NUDGE_LABELS.includes(row.name ?? "") || (!!row.noteId && inLastWorkday(row.noteId)))
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
    return t(`i18n.${WEEKDAYS[weekdayOf(date)]}`);
}

/** The short weekday of a `YYYY-MM-DD` in the UI's language: "Tue". */
function shortWeekday(date: string) {
    return t(`calendar.${WEEKDAYS[weekdayOf(date)].slice(0, 3)}`);
}

function weekdayOf(date: string) {
    const [ year, month, day ] = date.split("-").map(Number);
    return new Date(year, month - 1, day).getDay();
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
