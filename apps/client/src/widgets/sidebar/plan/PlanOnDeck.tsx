import "./PlanOnDeck.css";

import { useState } from "preact/hooks";

import type { CaiusPlan, CaiusPlanTask } from "../../../services/caius";
import { t } from "../../../services/i18n";
import ActionButton from "../../react/ActionButton";
import LinkButton from "../../react/LinkButton";
import RightPanelWidget from "../RightPanelWidget";
import { formatDuration } from "./PlanCapacity";
import { onDeckTasks, parentKey, subItemCount, subItemsOf, taskLabel } from "./plan_logic";
import type { PlanTaskRef } from "./PlanTab";

const OPEN_PARENTS_KEY = "caius.plan.openParents";

/**
 * A day's On deck as its own group: the tasks intended for the day, tracked but not counted in the
 * capacity until Plan my day puts them on the list. Shown only while the day has one. A parent is
 * one row with its sub-item count and a chevron that opens the sub-items under it; a done parent
 * with open sub-items stays, struck through, with "N open" in place of the count.
 */
export default function PlanOnDeck({ plan, onOpen }: {
    plan: CaiusPlan;
    onOpen: (task: PlanTaskRef) => void;
}) {
    const [ open, toggle ] = useOpenParents();
    const tasks = onDeckTasks(plan);
    if (plan.period !== "day" || tasks.length === 0) {
        return null;
    }

    const subs = subItemsOf(plan.onDeck ?? []);

    return (
        <RightPanelWidget id="plan-on-deck" title={t("caius.plan.on_deck")}>
            <ul className="plan-task-list plan-on-deck">
                {tasks.map((task) => {
                    const children = subs.get(task);
                    const key = parentKey(task);
                    if (!children) {
                        return (
                            <li key={task.listItemId ?? task.text}>
                                <LinkButton
                                    text={taskLabel(task.text)}
                                    onClick={() => onOpen(task)}
                                />
                            </li>
                        );
                    }

                    const expanded = key !== null && open.includes(key);
                    return (
                        <li
                            key={task.listItemId ?? task.text}
                            className={task.state === "done" ? "done" : undefined}
                        >
                            <div className="plan-parent-row">
                                <ActionButton
                                    icon={expanded ? "bx bx-chevron-down" : "bx bx-chevron-right"}
                                    text={t(expanded
                                        ? "caius.plan.hide_sub_items"
                                        : "caius.plan.show_sub_items")}
                                    aria-expanded={expanded}
                                    disabled={key === null}
                                    onClick={() => key !== null && toggle(key)}
                                />
                                <LinkButton
                                    className="plan-task-text"
                                    text={taskLabel(task.text)}
                                    onClick={() => onOpen(task)}
                                />
                                <span className="plan-sub-count">
                                    {subItemCount(task, children)}
                                </span>
                            </div>
                            {expanded && <SubItems subs={children} onOpen={onOpen} />}
                        </li>
                    );
                })}
            </ul>
            <div className="plan-on-deck-total">
                {t("caius.plan.on_deck_total", { total: formatDuration(plan.capacity.onDeckMinutes ?? 0) })}
            </div>
        </RightPanelWidget>
    );
}

function SubItems({ subs, onOpen }: {
    subs: CaiusPlanTask[];
    onOpen: (task: PlanTaskRef) => void;
}) {
    return (
        <ul className="plan-sub-items">
            {subs.map((sub) => (
                <li
                    key={sub.listItemId ?? sub.text}
                    className={sub.state === "done" ? "done" : undefined}
                >
                    <LinkButton text={taskLabel(sub.text)} onClick={() => onOpen(sub)} />
                </li>
            ))}
        </ul>
    );
}

/** The `noteId/listItemId` of the parents shown open, kept in this device's `localStorage`. */
function useOpenParents() {
    const [ open, setOpen ] = useState(readOpenParents);

    const toggle = (key: string) => {
        const next = open.includes(key) ? open.filter((each) => each !== key) : [ ...open, key ];
        setOpen(next);
        try {
            window.localStorage.setItem(OPEN_PARENTS_KEY, JSON.stringify(next));
        } catch {
            // The choice then lasts until the tab reloads.
        }
    };

    return [ open, toggle ] as const;
}

function readOpenParents() {
    try {
        const stored: unknown = JSON.parse(window.localStorage.getItem(OPEN_PARENTS_KEY) ?? "[]");
        return Array.isArray(stored)
            ? stored.filter((key): key is string => typeof key === "string")
            : [];
    } catch {
        return [];
    }
}
