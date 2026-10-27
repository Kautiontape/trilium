import "./PlanClose.css";

import { useState } from "preact/hooks";

import {
    caiusApi, caiusNow, type CaiusForwardItem, type CaiusItemResult, type CaiusPeriodKind, type CaiusPlan,
    type CaiusPlanTask, type CaiusSetStateItem, caiusWrite, describeOutcome, findOpenEditors,
    openPeriodNoteIds
} from "../../../services/caius";
import { t } from "../../../services/i18n";
import Button from "../../react/Button";
import FormTextBox from "../../react/FormTextBox";
import LinkButton from "../../react/LinkButton";
import NoItems from "../../react/NoItems";
import SegmentedChoice from "../../react/SegmentedChoice";
import RightPanelWidget from "../RightPanelWidget";
import {
    closeCandidates, closeFates, type Fate, type FateKind, fateTarget, groupFates, isDecided,
    listedFates, taskLabel
} from "./plan_logic";
import type { PlanTaskRef } from "./PlanTab";

/** Each fate's icon and name; `current` is named after the kind of period being closed. */
const FATES: Record<FateKind, { icon: string; name: (period: CaiusPeriodKind) => string }> = {
    current: { icon: "bx-calendar-event", name: (period) => t(`caius.plan.current_${period}`) },
    tomorrow: { icon: "bx-sun", name: () => t("caius.forward_tomorrow") },
    next_week: { icon: "bx-calendar-week", name: () => t("caius.forward_next_week") },
    next_month: { icon: "bx-calendar", name: () => t("caius.forward_next_month") },
    drop: { icon: "bx-block", name: () => t("caius.plan.fate_drop") }
};

/**
 * Closes the period: every live task of its note gets a fate (Today, This week or This month for a
 * past period, then Tomorrow, Next week, Next month, or Drop with a reason), and Apply carries out
 * the decided ones. Undecided tasks stay where they are.
 */
export default function PlanClose({ plan, onOpen, onChanged }: {
    plan: CaiusPlan;
    onOpen: (task: PlanTaskRef) => void;
    onChanged: () => void;
}) {
    const [ fates, setFates ] = useState<Record<string, Fate>>({});
    const [ results, setResults ] = useState<{ text: string; message: string }[]>([]);
    const [ applying, setApplying ] = useState(false);
    const candidates = closeCandidates(plan);
    // One moment per render, so that Apply sends each task where its row says.
    const now = caiusNow();
    const fateKinds = closeFates(plan.period, plan.key, now);
    const targetable = candidates.filter((task) => task.listItemId);
    const decided = targetable
        .filter((task) => task.listItemId && isDecided(fates[task.listItemId])).length;

    const setFate = (listItemId: string, fate: Fate | null) => setFates((previous) => {
        const { [listItemId]: _, ...rest } = previous;
        return fate ? { ...rest, [listItemId]: fate } : rest;
    });

    async function apply() {
        const { noteId } = plan;
        if (!noteId) {
            return;
        }

        const calls = groupFates(noteId, listedFates(fates, candidates), now, plan.period);
        const items = [ ...calls.forward, ...calls.drop ];
        const flushed = findOpenEditors(noteId).length > 0;
        const targets = [ ...new Set(calls.forward.map((item) => item.to)) ]
            .flatMap(openPeriodNoteIds);
        setApplying(true);
        const outcome = await caiusWrite(
            noteId,
            (expectedBlobId) => applyFates(calls, expectedBlobId),
            t("caius.plan.closed", { count: items.length }),
            { alsoLock: targets }
        );
        setApplying(false);
        if (outcome) {
            const textOf = (listItemId: string) => taskLabel(
                candidates.find((task) => task.listItemId === listItemId)?.text ?? listItemId
            );
            setResults(items.map((item, index) => ({
                text: textOf(item.listItemId),
                message: describeResult(item, outcome[index], flushed)
            })));
            const changed = new Set(items
                .filter((_, index) => isChange(outcome[index]))
                .map((item) => item.listItemId));
            setFates((previous) => Object.fromEntries(
                Object.entries(previous).filter(([ listItemId ]) => !changed.has(listItemId))
            ));
        }
        onChanged();
    }

    return (
        <RightPanelWidget id="plan-close" title={t("caius.plan.close")}>
            {candidates.length === 0 ? (
                <NoItems
                    size="small"
                    icon="bx bx-check-double"
                    text={t("caius.plan.close_nothing_open")}
                />
            ) : (
                <ul className="plan-task-list plan-close-list">
                    {candidates.map((task) => (
                        <CloseRow
                            key={task.listItemId ?? task.text}
                            task={task}
                            fate={task.listItemId ? fates[task.listItemId] : undefined}
                            kinds={fateKinds}
                            period={plan.period}
                            now={now}
                            onFate={setFate}
                            onOpen={onOpen}
                        />
                    ))}
                </ul>
            )}
            <div className="plan-close-footer">
                <span className="plan-close-count">
                    {t("caius.plan.decided", { decided, total: targetable.length })}
                </span>
                <Button
                    kind="primary"
                    size="small"
                    text={t("caius.plan.apply")}
                    disabled={decided === 0 || applying}
                    onClick={() => void apply()}
                />
            </div>
            {results.length > 0 && (
                <ul className="plan-close-results">
                    {results.map(({ text, message }, index) => (
                        <li key={index}>{t("caius.plan.result", { text, message })}</li>
                    ))}
                </ul>
            )}
        </RightPanelWidget>
    );
}

/**
 * Sends the forwards, then the drops, all on one note, as one request: the server checks the
 * version once and writes them under one lock. A stale batch comes back stale whole, so that
 * `caiusWrite` saves and retries it.
 */
export function applyFates(
    { forward, drop }: { forward: CaiusForwardItem[]; drop: CaiusSetStateItem[] },
    expectedBlobId: string | undefined
) {
    return caiusApi.apply({ forwards: forward, drops: drop, expectedBlobId });
}

function CloseRow({ task, fate, kinds, period, now, onFate, onOpen }: {
    task: CaiusPlanTask;
    fate: Fate | undefined;
    kinds: FateKind[];
    period: CaiusPeriodKind;
    now: Date;
    onFate: (listItemId: string, fate: Fate | null) => void;
    onOpen: (task: PlanTaskRef) => void;
}) {
    const { listItemId } = task;

    return (
        <li>
            <LinkButton
                className="plan-task-text"
                text={taskLabel(task.text)}
                onClick={() => onOpen(task)}
            />
            {listItemId ? (
                <div className="plan-close-fate">
                    <SegmentedChoice<FateKind>
                        options={kinds.map((kind) => ({
                            value: kind, icon: FATES[kind].icon, title: fateLabel(kind, now, period)
                        }))}
                        currentValue={fate?.kind ?? ""}
                        // Pressing the chosen fate again takes it back.
                        onChange={(kind) => onFate(
                            listItemId,
                            kind === fate?.kind ? null : { kind, reason: fate?.reason }
                        )}
                    />
                    {fate && fate.kind !== "drop" && (
                        <span className="plan-close-target">
                            {fateLabel(fate.kind, now, period)}
                        </span>
                    )}
                    {fate?.kind === "drop" && (
                        <FormTextBox
                            className="plan-close-reason"
                            placeholder={t("caius.plan.drop_reason")}
                            currentValue={fate.reason ?? ""}
                            onChange={(reason) => onFate(listItemId, { kind: "drop", reason })}
                        />
                    )}
                </div>
            ) : (
                <div className="plan-task-outcome">{t("caius.plan.no_id")}</div>
            )}
        </li>
    );
}

/** The fate's name, with the note a forwarding fate sends the task to. */
function fateLabel(kind: FateKind, now: Date, period: CaiusPeriodKind) {
    const name = FATES[kind].name(period);
    return kind === "drop"
        ? name
        : t("caius.plan.fate_to", { fate: name, to: fateTarget(kind, now, period) });
}

function describeResult(
    item: CaiusForwardItem | CaiusSetStateItem,
    result: CaiusItemResult | undefined,
    flushed: boolean
) {
    if (!result) {
        return t("caius.plan.not_applied");
    }

    return describeOutcome(result, flushed)
        ?? ("to" in item ? t("caius.forwarded", { to: item.to }) : t("caius.set_cancelled"));
}

function isChange(result: CaiusItemResult | undefined) {
    return !!result && result.status !== "skipped" && result.status !== "failed";
}
