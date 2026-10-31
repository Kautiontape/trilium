import "./PlanTab.css";

import type { CKTextEditor } from "@triliumnext/ckeditor5";

import { caiusOpener } from "@triliumnext/commons";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";

import appContext from "../../../components/app_context";
import type NoteContext from "../../../components/note_context";
import { isJournalNote } from "../../../menus/task_actions";
import {
    caiusApi, caiusClockMinutes, type CaiusContextLine, caiusNow, type CaiusLane, type CaiusOpenTask, type CaiusPeriodKind, type CaiusPlan,
    isCaiusEnabled, RELOAD_TIMEOUT_MS, startCaiusConversation, wasCaiusEnabled
} from "../../../services/caius";
import froca from "../../../services/froca";
import type LoadResults from "../../../services/load_results";
import { t } from "../../../services/i18n";
import ActionButton from "../../react/ActionButton";
import { Badge } from "../../react/Badge";
import Button from "../../react/Button";
import { useActiveNoteContext, useTriliumEvent } from "../../react/hooks";
import LoadingSpinner from "../../react/LoadingSpinner";
import NoItems from "../../react/NoItems";
import { getEditorNoteId } from "../../react/NoteStore";
import SegmentedChoice from "../../react/SegmentedChoice";
import { CollapsibleWidgets, RightPaneTabVisible } from "../RightPanelWidget";
import PlanCapacity from "./PlanCapacity";
import PlanClose from "./PlanClose";
import PlanContext from "./PlanContext";
import {
    acceptSections, isCloseable, isPastPeriod, periodKey, periodOfNote, stepPeriod,
    type ViewedPeriod
} from "./plan_logic";
import PlanPullIn from "./PlanPullIn";
import PlanOnDeck from "./PlanOnDeck";
import PlanSuggested from "./PlanSuggested";

/** The lanes Pull in offers tasks from, in order. */
export const PULL_IN_LANES: CaiusLane[] = [ "overdue", "week", "orbit" ];

/** How many tasks of each lane Pull in lists. */
export const PULL_IN_LIMIT = 20;

/**
 * The most open tasks one read asks for, across every lane; Pull in shows {@link PULL_IN_LIMIT} of
 * each lane and counts the rest.
 */
const OPEN_TASKS_LIMIT = 1000;

/** How long the tab waits after a change to a Journal note before it reads the plan again. */
export const REFRESH_DELAY_MS = 300;

/** A task the tab can open its note at. */
export interface PlanTaskRef {
    noteId: string;
    listItemId: string | null;
}

/**
 * The right pane's Plan tab: the capacity, Suggested items, tasks to pull in and, when the period
 * is due, its close, for the day, week or month the active note is (today for any other note).
 */
export default function PlanTab() {
    const { note, noteContext } = useActiveNoteContext();
    const [ period, setPeriod ] = useState<ViewedPeriod>(() => periodOfNote(note, caiusNow()));
    useEffect(() => {
        setPeriod(periodOfNote(note, caiusNow()));
        // The server's dev clock is known once the status has answered.
        let mounted = true;
        void isCaiusEnabled().then(() => mounted && setPeriod(periodOfNote(note, caiusNow())));
        return () => {
            mounted = false;
        };
    }, [ note ]);

    const key = periodKey(period);
    const { data, error, reload, refresh } = usePlanData(period.kind, key);
    const openTask = useCallback(
        (task: PlanTaskRef) => void openTaskInNote(noteContext, task),
        [ noteContext ]
    );
    const current = data?.plan.period === period.kind && data.plan.key === key ? data : null;

    return (
        <div className="plan-tab">
            <PlanPeriodBar period={period} onChange={setPeriod} />
            {error ? (
                <NoItems
                    icon="bx bx-error-circle"
                    text={t("caius.plan.load_failed", { message: error })}
                >
                    <Button text={t("caius.plan.retry")} icon="bx bx-refresh" onClick={reload} />
                </NoItems>
            ) : !current ? (
                <LoadingSpinner />
            ) : (
                // The tab holds one entry in the pane, but its cards collapse one by one.
                <CollapsibleWidgets.Provider value>
                    {!current.plan.noteId && (
                        <div className="plan-no-note">{t("caius.plan.no_note")}</div>
                    )}
                    <PlanCapacity plan={current.plan} onOpen={openTask} />
                    <PlanOnDeck plan={current.plan} onOpen={openTask} />
                    {current.context && <PlanContext date={key} lines={current.context} />}
                    <PlanSuggested
                        key={key}
                        plan={current.plan}
                        sections={current.sections}
                        onChanged={refresh}
                    />
                    {!isPastPeriod(current.plan.period, current.plan.key, caiusNow()) && (
                        <PlanPullIn
                            plan={current.plan}
                            lanes={current.lanes}
                            onOpen={openTask}
                            onChanged={refresh}
                        />
                    )}
                    {current.plan.noteId && isCloseable(period, caiusNow(), caiusClockMinutes(caiusNow())) && (
                        <PlanClose
                            key={key}
                            plan={current.plan}
                            onOpen={openTask}
                            onChanged={refresh}
                        />
                    )}
                </CollapsibleWidgets.Provider>
            )}
        </div>
    );
}

/** Whether the server runs Caius, starting from the last known answer. */
export function useCaiusEnabled() {
    const [ enabled, setEnabled ] = useState(wasCaiusEnabled());
    useEffect(() => {
        let mounted = true;
        void isCaiusEnabled().then((value) => mounted && setEnabled(value));
        return () => {
            mounted = false;
        };
    }, []);

    return enabled;
}

function PlanPeriodBar({ period, onChange }: {
    period: ViewedPeriod;
    onChange: (period: ViewedPeriod) => void;
}) {
    const now = caiusNow();
    const key = periodKey(period);
    const isCurrent = key === periodKey({ kind: period.kind, anchor: now });

    return (
        <div className="plan-period-bar">
            <SegmentedChoice<CaiusPeriodKind>
                className="plan-period-kind"
                options={[
                    { value: "day", label: t("caius.plan.day") },
                    { value: "week", label: t("caius.plan.week") },
                    { value: "month", label: t("caius.plan.month") }
                ]}
                currentValue={period.kind}
                onChange={(kind) => onChange({ kind, anchor: period.anchor })}
            />
            <div className="plan-period-step">
                <ActionButton
                    icon="bx bx-chevron-left"
                    text={t("caius.plan.previous")}
                    onClick={() => onChange(stepPeriod(period, -1))}
                />
                <span className="plan-period-key">{key}</span>
                <ActionButton
                    icon="bx bx-chevron-right"
                    text={t("caius.plan.next")}
                    onClick={() => onChange(stepPeriod(period, 1))}
                />
                {isCurrent ? (
                    <Badge
                        className="plan-period-current"
                        text={t(`caius.plan.current_${period.kind}`)}
                    />
                ) : (
                    <Button
                        size="small"
                        text={t("caius.plan.today")}
                        onClick={() => onChange({ kind: "day", anchor: now })}
                    />
                )}
            </div>
            {period.kind === "day" && (
                <div className="plan-day-actions">
                    <Button
                        size="small"
                        icon="bx bx-sun"
                        text={t("caius.plan_my_day")}
                        onClick={() => void startCaiusConversation(caiusOpener("plan", key))}
                    />
                    <Button
                        size="small"
                        icon="bx bx-moon"
                        text={t("caius.wind_down")}
                        onClick={() => void startCaiusConversation(caiusOpener("winddown", key))}
                    />
                </div>
            )}
        </div>
    );
}

interface PlanData {
    plan: CaiusPlan;
    lanes: { lane: CaiusLane; total: number; tasks: CaiusOpenTask[] }[];
    /** The note's headings, where Accept can put a suggested item. */
    sections: string[];
    /** The Context in force on a viewed day; `null` for a week or month. */
    context: CaiusContextLine[] | null;
}

/**
 * Reads the plan of one period and the Pull in lanes: at once after `reload()`, and debounced
 * after `refresh()` or a change to any Journal note. One read runs at a time, with at most one more
 * queued behind it, and none while the tab is hidden; a tab that missed one reads when it shows.
 */
function usePlanData(kind: CaiusPeriodKind, key: string) {
    const visible = useContext(RightPaneTabVisible);
    const [ data, setData ] = useState<PlanData | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const inFlight = useRef(false);
    const queued = useRef(false);
    const missed = useRef(false);
    const visibleRef = useRef(visible);
    visibleRef.current = visible;

    const load = useCallback(async () => {
        try {
            const [ plan, open, context ] = await Promise.all([
                caiusApi.plan(kind, key),
                caiusApi.open(undefined, OPEN_TASKS_LIMIT),
                kind === "day" ? caiusApi.context(key) : null
            ]);
            const lanes = PULL_IN_LANES.map((lane) => {
                const tasks = open.tasks.filter((task) => task.lane === lane);
                return { lane, total: tasks.length, tasks: tasks.slice(0, PULL_IN_LIMIT) };
            });
            const note = plan.noteId ? await froca.getNote(plan.noteId) : null;
            const html = await note?.getContent();
            const sections = typeof html === "string" ? acceptSections(html) : [];
            setData({ plan, lanes, sections, context: context?.context ?? null });
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [ kind, key ]);
    const loadRef = useRef(load);
    loadRef.current = load;

    const reload = useCallback(async () => {
        if (!visibleRef.current) {
            missed.current = true;
            return;
        }
        if (inFlight.current) {
            queued.current = true;
            return;
        }

        inFlight.current = true;
        try {
            do {
                queued.current = false;
                await loadRef.current();
            } while (queued.current);
        } finally {
            inFlight.current = false;
        }
    }, []);

    const refresh = useCallback(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void reload(), REFRESH_DELAY_MS);
    }, [ reload ]);

    useEffect(() => {
        clearTimeout(timer.current);
        void reload();
    }, [ load, reload ]);
    useEffect(() => {
        if (visible && missed.current) {
            missed.current = false;
            void reload();
        }
    }, [ visible, reload ]);
    useEffect(() => () => clearTimeout(timer.current), []);

    useTriliumEvent("entitiesReloaded", useCallback(({ loadResults }) => {
        if (touchesJournal(loadResults)) {
            refresh();
        }
    }, [ refresh ]));

    return { data, error, reload: () => void reload(), refresh };
}

/**
 * Whether the changes touch a Journal note the client holds: the note itself, one of its labels (a
 * Caius write such as `#caiusFocus` changes no note row) or a child added under it (a brief, a new
 * day note under its week).
 */
function touchesJournal(loadResults: LoadResults) {
    const journal = (noteId: string | undefined) => {
        const note = noteId ? froca.notes[noteId] : undefined;
        return !!note && isJournalNote(note);
    };

    return loadResults.getNoteIds().some(journal)
        || loadResults.getAttributeRows().some((row) => journal(row.noteId))
        || loadResults.getBranchRows().some((row) => journal(row.parentNoteId));
}

/**
 * Whether `editor` holds `noteId`, waiting up to {@link RELOAD_TIMEOUT_MS} for `EditableText` to
 * load it.
 */
function editorLoads(editor: CKTextEditor, noteId: string) {
    if (getEditorNoteId(editor) === noteId) {
        return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
        const done = (loaded: boolean) => {
            clearTimeout(timer);
            editor.data.off("set", onSet);
            resolve(loaded);
        };
        const onSet = () => {
            if (getEditorNoteId(editor) === noteId) {
                done(true);
            }
        };
        const timer = setTimeout(() => done(false), RELOAD_TIMEOUT_MS);
        // `set` is decorated, so a listener below `normal` runs after the data is in the model.
        editor.data.on("set", onSet, { priority: "lowest" });
    });
}

/** Opens the task's note in the active tab and, once its editor holds it, puts the caret on it. */
export async function openTaskInNote(
    noteContext: NoteContext | undefined,
    { noteId, listItemId }: PlanTaskRef
) {
    const context = noteContext ?? appContext.tabManager.getActiveContext();
    if (!context) {
        return;
    }

    await context.setNote(noteId);
    const isText = context.note?.type === "text";
    // The editor answers at once, possibly while it still holds the note shown before.
    const editor = listItemId && isText ? await context.getTextEditor() : null;
    const root = editor?.model.document.getRoot();
    if (!editor || !root || !(await editorLoads(editor, noteId))) {
        return;
    }

    const block = Array.from(root.getChildren()).find((child) =>
        child.is("element") && child.getAttribute("listItemId") === listItemId);
    if (block?.is("element")) {
        editor.model.change((writer) => writer.setSelection(block, "end"));
        editor.editing.view.focus();
        editor.editing.view.scrollToTheSelection();
    }
}
