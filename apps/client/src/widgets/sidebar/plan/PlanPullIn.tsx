import "./PlanPullIn.css";

import { useState } from "preact/hooks";

import {
    caiusApi, type CaiusItemResult, type CaiusLane, type CaiusOpenTask, type CaiusPlan,
    type CaiusTaskState, caiusWrite, describeOutcome, findOpenEditors
} from "../../../services/caius";
import dialog from "../../../services/dialog";
import { t } from "../../../services/i18n";
import toast from "../../../services/toast";
import { Badge } from "../../react/Badge";
import Dropdown from "../../react/Dropdown";
import { FormListItem } from "../../react/FormList";
import LinkButton from "../../react/LinkButton";
import RightPanelWidget from "../RightPanelWidget";
import { taskLabel } from "./plan_logic";
import type { PlanTaskRef } from "./PlanTab";

/**
 * Open tasks of the overdue, this week and this month lanes that are not in the viewed period's
 * note, each with an Actions menu: pull it into the viewed period, mark it done or drop it.
 */
export default function PlanPullIn({ plan, lanes, onOpen, onChanged }: {
    plan: CaiusPlan;
    lanes: { lane: CaiusLane; total: number; tasks: CaiusOpenTask[] }[];
    onOpen: (task: PlanTaskRef) => void;
    onChanged: () => void;
}) {
    const [ outcomes, setOutcomes ] = useState<Record<string, string>>({});

    async function write(
        { noteId, listItemId }: CaiusOpenTask,
        send: (expectedBlobId: string | undefined) => Promise<CaiusItemResult[]>,
        successMessage: string,
        options: { alsoLock?: string[] } = {}
    ) {
        if (!listItemId) {
            return;
        }

        const flushed = findOpenEditors(noteId).length > 0;
        const results = await caiusWrite(noteId, send, successMessage, options);
        const outcome = describeOutcome(results?.[0], flushed);
        setOutcomes((previous) => ({ ...previous, [listItemId]: outcome ?? "" }));
        onChanged();
    }

    const pullIn = (task: CaiusOpenTask) => write(
        task,
        (expectedBlobId) => caiusApi.forward([
            { noteId: task.noteId, listItemId: task.listItemId ?? "", to: plan.key, expectedBlobId }
        ]),
        t("caius.forwarded", { to: plan.key }),
        { alsoLock: plan.noteId ? [ plan.noteId ] : [] }
    );

    const setState = (task: CaiusOpenTask, state: CaiusTaskState, reason?: string) => write(
        task,
        (expectedBlobId) => caiusApi.setState([ {
            noteId: task.noteId, listItemId: task.listItemId ?? "", state, reason, expectedBlobId
        } ]),
        t(`caius.set_${state}`)
    );

    async function drop(task: CaiusOpenTask) {
        const reason = await dialog.prompt({
            title: t("caius.drop_title"),
            message: t("caius.drop_message")
        });
        if (reason === null) {
            return;
        }

        if (!reason.trim()) {
            toast.showError(t("caius.drop_reason_required"));
            return;
        }

        await setState(task, "cancelled", reason.trim());
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
                                        outcome={task.listItemId
                                            ? outcomes[task.listItemId]
                                            : t("caius.plan.no_id")}
                                        onOpen={onOpen}
                                        onPullIn={pullIn}
                                        onDone={(row) => setState(row, "done")}
                                        onDrop={drop}
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

function PullInRow({ task, outcome, onOpen, onPullIn, onDone, onDrop }: {
    task: CaiusOpenTask;
    outcome: string | undefined;
    onOpen: (task: PlanTaskRef) => void;
    onPullIn: (task: CaiusOpenTask) => Promise<void>;
    onDone: (task: CaiusOpenTask) => Promise<void>;
    onDrop: (task: CaiusOpenTask) => Promise<void>;
}) {
    return (
        <li>
            <div className="plan-pull-in-row">
                <LinkButton
                    className="plan-task-text"
                    text={taskLabel(task.text)}
                    onClick={() => onOpen(task)}
                />
                {task.daysLate !== undefined && (
                    <Badge
                        className="plan-days-late"
                        text={t("caius.plan.days_late", { count: task.daysLate })}
                    />
                )}
                <Dropdown
                    className="plan-pull-in-actions"
                    text={t("caius.plan.actions")}
                    buttonClassName="btn-sm"
                    disabled={!task.listItemId}
                    noDropdownListStyle
                    portalToBody
                >
                    <FormListItem icon="bx bx-right-arrow-alt" onClick={() => void onPullIn(task)}>
                        {t("caius.plan.pull_in")}
                    </FormListItem>
                    <FormListItem icon="bx bx-check" onClick={() => void onDone(task)}>
                        {t("caius.done")}
                    </FormListItem>
                    <FormListItem icon="bx bx-block" onClick={() => void onDrop(task)}>
                        {t("caius.drop")}
                    </FormListItem>
                </Dropdown>
            </div>
            {outcome && <div className="plan-task-outcome">{outcome}</div>}
        </li>
    );
}
