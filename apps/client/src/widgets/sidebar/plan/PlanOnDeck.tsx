import type { CaiusPlan } from "../../../services/caius";
import { t } from "../../../services/i18n";
import LinkButton from "../../react/LinkButton";
import RightPanelWidget from "../RightPanelWidget";
import { formatDuration } from "./PlanCapacity";
import { onDeckTasks, taskLabel } from "./plan_logic";
import type { PlanTaskRef } from "./PlanTab";

/**
 * A day's On deck as its own group: the tasks intended for the day, tracked but not counted in the
 * capacity until Plan my day puts them on the list. Shown only while the day has one.
 */
export default function PlanOnDeck({ plan, onOpen }: {
    plan: CaiusPlan;
    onOpen: (task: PlanTaskRef) => void;
}) {
    const tasks = onDeckTasks(plan);
    if (plan.period !== "day" || tasks.length === 0) {
        return null;
    }

    return (
        <RightPanelWidget id="plan-on-deck" title={t("caius.plan.on_deck")}>
            <ul className="plan-task-list plan-on-deck">
                {tasks.map((task) => (
                    <li key={task.listItemId ?? task.text}>
                        <LinkButton text={taskLabel(task.text)} onClick={() => onOpen(task)} />
                    </li>
                ))}
            </ul>
            <div className="plan-on-deck-total">
                {t("caius.plan.on_deck_total", { total: formatDuration(plan.capacity.onDeckMinutes ?? 0) })}
            </div>
        </RightPanelWidget>
    );
}
