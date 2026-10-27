import "./PlanPullIn.css";

import { useState } from "preact/hooks";

import {
    caiusApi, type CaiusLane, type CaiusOpenTask, type CaiusPlan, caiusWrite, describeOutcome,
    findOpenEditors
} from "../../../services/caius";
import { t } from "../../../services/i18n";
import { Badge } from "../../react/Badge";
import Button from "../../react/Button";
import LinkButton from "../../react/LinkButton";
import RightPanelWidget from "../RightPanelWidget";
import type { PlanTaskRef } from "./PlanTab";

/**
 * Open tasks of the overdue, this week and this month lanes that are not in the viewed period's
 * note, each with a button that forwards it there.
 */
export default function PlanPullIn({ plan, lanes, onOpen, onChanged }: {
    plan: CaiusPlan;
    lanes: { lane: CaiusLane; total: number; tasks: CaiusOpenTask[] }[];
    onOpen: (task: PlanTaskRef) => void;
    onChanged: () => void;
}) {
    const [ outcomes, setOutcomes ] = useState<Record<string, string>>({});

    async function pullIn({ noteId, listItemId }: CaiusOpenTask) {
        if (!listItemId) {
            return;
        }

        const flushed = findOpenEditors(noteId).length > 0;
        const results = await caiusWrite(
            noteId,
            (expectedBlobId) => caiusApi.forward([
                { noteId, listItemId, to: plan.key, expectedBlobId }
            ]),
            t("caius.forwarded", { to: plan.key })
        );
        const outcome = describeOutcome(results?.[0], flushed);
        setOutcomes((previous) => ({ ...previous, [listItemId]: outcome ?? "" }));
        onChanged();
    }

    return (
        <RightPanelWidget id="plan-pull-in" title={t("caius.plan.pull_in")}>
            {lanes.map(({ lane, total, tasks }) => {
                const elsewhere = tasks.filter((task) =>
                    task.noteId !== plan.noteId && task.period !== plan.key);
                const hidden = total - tasks.length;
                return (
                    <section key={lane} className="plan-lane" data-lane={lane}>
                        <div className="plan-lane-title">
                            {t(`caius.plan.lane_${lane}`)}
                            <Badge text={String(elsewhere.length + hidden)} />
                        </div>
                        {elsewhere.length === 0 && hidden === 0 ? (
                            <div className="plan-lane-empty">{t("caius.plan.lane_empty")}</div>
                        ) : (
                            <ul className="plan-task-list">
                                {elsewhere.map((task) => (
                                    <PullInRow
                                        key={`${task.noteId}-${task.listItemId ?? task.text}`}
                                        task={task}
                                        target={plan.key}
                                        outcome={outcomes[task.listItemId ?? ""]}
                                        onOpen={onOpen}
                                        onPullIn={pullIn}
                                    />
                                ))}
                                {hidden > 0 && (
                                    <li className="plan-lane-more">
                                        {t("caius.plan.lane_more", { count: hidden })}
                                    </li>
                                )}
                            </ul>
                        )}
                    </section>
                );
            })}
        </RightPanelWidget>
    );
}

function PullInRow({ task, target, outcome, onOpen, onPullIn }: {
    task: CaiusOpenTask;
    target: string;
    outcome: string | undefined;
    onOpen: (task: PlanTaskRef) => void;
    onPullIn: (task: CaiusOpenTask) => Promise<void>;
}) {
    return (
        <li>
            <div className="plan-pull-in-row">
                <LinkButton
                    className="plan-task-text"
                    text={task.text}
                    onClick={() => onOpen(task)}
                />
                {task.daysLate !== undefined && (
                    <Badge
                        className="plan-days-late"
                        text={t("caius.plan.days_late", { count: task.daysLate })}
                    />
                )}
                <Button
                    size="small"
                    text={t("caius.plan.pull_into", { period: target })}
                    disabled={!task.listItemId}
                    disabledTooltip={t("caius.plan.no_id")}
                    onClick={() => void onPullIn(task)}
                />
            </div>
            {outcome && <div className="plan-task-outcome">{outcome}</div>}
        </li>
    );
}
