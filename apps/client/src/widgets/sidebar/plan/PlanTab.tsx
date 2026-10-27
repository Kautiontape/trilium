import "./PlanTab.css";

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import appContext from "../../../components/app_context";
import type NoteContext from "../../../components/note_context";
import { isJournalNote } from "../../../menus/task_actions";
import {
    caiusApi, type CaiusLane, type CaiusOpenTask, type CaiusPeriodKind, type CaiusPlan,
    isCaiusEnabled, wasCaiusEnabled
} from "../../../services/caius";
import froca from "../../../services/froca";
import { t } from "../../../services/i18n";
import ActionButton from "../../react/ActionButton";
import { Badge } from "../../react/Badge";
import Button from "../../react/Button";
import { useActiveNoteContext, useTriliumEvent } from "../../react/hooks";
import LoadingSpinner from "../../react/LoadingSpinner";
import NoItems from "../../react/NoItems";
import { getEditorNoteId } from "../../react/NoteStore";
import SegmentedChoice from "../../react/SegmentedChoice";
import { CollapsibleWidgets } from "../RightPanelWidget";
import PlanCapacity from "./PlanCapacity";
import PlanClose from "./PlanClose";
import {
    acceptSections, isCloseable, periodKey, periodOfNote, stepPeriod, type ViewedPeriod
} from "./plan_logic";
import PlanPullIn from "./PlanPullIn";
import PlanSuggested from "./PlanSuggested";

/** The lanes Pull in offers tasks from, in order. */
export const PULL_IN_LANES: CaiusLane[] = [ "overdue", "week", "orbit" ];

/** How many tasks of each lane Pull in lists. */
export const PULL_IN_LIMIT = 20;

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
    const [ period, setPeriod ] = useState<ViewedPeriod>(() => periodOfNote(note, new Date()));
    useEffect(() => setPeriod(periodOfNote(note, new Date())), [ note ]);

    const key = periodKey(period);
    const { data, error, reload } = usePlanData(period.kind, key);
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
                    <PlanSuggested
                        key={key}
                        plan={current.plan}
                        sections={current.sections}
                        onChanged={reload}
                    />
                    <PlanPullIn
                        plan={current.plan}
                        lanes={current.lanes}
                        onOpen={openTask}
                        onChanged={reload}
                    />
                    {current.plan.noteId && isCloseable(period, new Date()) && (
                        <PlanClose
                            key={key}
                            plan={current.plan}
                            onOpen={openTask}
                            onChanged={reload}
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
    const now = new Date();
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
        </div>
    );
}

interface PlanData {
    plan: CaiusPlan;
    lanes: { lane: CaiusLane; total: number; tasks: CaiusOpenTask[] }[];
    /** The note's headings, where Accept can put a suggested item. */
    sections: string[];
}

/**
 * Reads the plan of one period and the Pull in lanes, again after `reload()` and, debounced, after
 * a change to any Journal note.
 */
function usePlanData(kind: CaiusPeriodKind, key: string) {
    const [ data, setData ] = useState<PlanData | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    const lastRequest = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout>>();

    const reload = useCallback(async () => {
        const request = ++lastRequest.current;
        try {
            const [ plan, lanes ] = await Promise.all([
                caiusApi.plan(kind, key),
                Promise.all(PULL_IN_LANES.map(async (lane) => ({
                    lane, ...await caiusApi.open(lane, PULL_IN_LIMIT)
                })))
            ]);
            const note = plan.noteId ? await froca.getNote(plan.noteId) : null;
            const html = await note?.getContent();
            if (request === lastRequest.current) {
                const sections = typeof html === "string" ? acceptSections(html) : [];
                setData({ plan, lanes, sections });
                setError(null);
            }
        } catch (e) {
            if (request === lastRequest.current) {
                setError(e instanceof Error ? e.message : String(e));
            }
        }
    }, [ kind, key ]);

    useEffect(() => {
        clearTimeout(timer.current);
        void reload();
    }, [ reload ]);
    useEffect(() => () => clearTimeout(timer.current), []);

    useTriliumEvent("entitiesReloaded", useCallback(({ loadResults }) => {
        const changesJournal = loadResults.getNoteIds().some((noteId) => {
            const changed = froca.notes[noteId];
            return !!changed && isJournalNote(changed);
        });
        if (changesJournal) {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => void reload(), REFRESH_DELAY_MS);
        }
    }, [ reload ]));

    return { data, error, reload: () => void reload() };
}

/** Opens the task's note in the active tab and, once its editor holds it, puts the caret on it. */
async function openTaskInNote(
    noteContext: NoteContext | undefined,
    { noteId, listItemId }: PlanTaskRef
) {
    const context = noteContext ?? appContext.tabManager.getActiveContext();
    if (!context) {
        return;
    }

    await context.setNote(noteId);
    const isText = context.note?.type === "text";
    const editor = listItemId && isText ? await context.getTextEditor() : null;
    const root = editor?.model.document.getRoot();
    if (!editor || !root || getEditorNoteId(editor) !== noteId) {
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
