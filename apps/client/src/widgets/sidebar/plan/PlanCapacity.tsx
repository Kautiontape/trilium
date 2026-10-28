import "./PlanCapacity.css";

import clsx from "clsx";
import { useState } from "preact/hooks";

import type { CaiusPlan } from "../../../services/caius";
import { t } from "../../../services/i18n";
import LinkButton from "../../react/LinkButton";
import RightPanelWidget from "../RightPanelWidget";
import { capacityStatus, taskLabel, unestimatedTasks } from "./plan_logic";
import type { PlanTaskRef } from "./PlanTab";

/** Mirrors the library's `DEFAULT_ESTIMATE`: the minutes a task without `~est` counts for. */
const UNESTIMATED_MINUTES = 30;

/** How far past the top of the target the bar reaches, so that an overfull plan shows as one. */
const METER_HEADROOM = 1.25;

/** The planned minutes against the period's target, the evening's minutes, and the tasks still without an estimate. */
export default function PlanCapacity({ plan, onOpen }: {
    plan: CaiusPlan;
    onOpen: (task: PlanTaskRef) => void;
}) {
    const [ listShown, setListShown ] = useState(false);
    const { capacity } = plan;
    const { target } = capacity;
    const status = capacityStatus(capacity);

    return (
        <RightPanelWidget id="plan-capacity" title={t("caius.plan.capacity")}>
            <div className={clsx("plan-capacity", `plan-capacity-${status}`)}>
                {target ? (
                    <>
                        <meter
                            className="plan-capacity-meter"
                            min={0}
                            max={target.max * METER_HEADROOM}
                            low={target.min}
                            high={target.max}
                            optimum={(target.min + target.max) / 2}
                            value={capacity.totalMinutes}
                        />
                        <div className="plan-capacity-summary">
                            {t("caius.plan.capacity_of_target", {
                                total: formatDuration(capacity.totalMinutes),
                                range: formatRange(target.min, target.max)
                            })}
                        </div>
                    </>
                ) : (
                    <div className="plan-capacity-summary">
                        {t("caius.plan.capacity_total", { total: formatDuration(capacity.totalMinutes) })}
                    </div>
                )}
                {capacity.eveningMinutes > 0 && (
                    <div className="plan-capacity-evening">
                        {t("caius.plan.capacity_evening", { total: formatDuration(capacity.eveningMinutes) })}
                    </div>
                )}
                {capacity.unestimatedCount > 0 && (
                    <LinkButton
                        className="plan-capacity-unestimated"
                        text={t("caius.plan.unestimated", {
                            count: capacity.unestimatedCount,
                            duration: formatDuration(UNESTIMATED_MINUTES)
                        })}
                        onClick={() => setListShown(!listShown)}
                    />
                )}
                {listShown && (
                    <ul className="plan-task-list">
                        {unestimatedTasks(plan).map((task) => (
                            <li key={task.listItemId ?? task.text}>
                                <LinkButton
                                    text={taskLabel(task.text)}
                                    onClick={() => onOpen(task)}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </RightPanelWidget>
    );
}

/** `220` → "3 h 40 m", `45` → "45 m", `240` → "4 h", `0` → "0 m". */
function formatDuration(minutes: number) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) {
        return t("caius.plan.duration_m", { m });
    }

    return m === 0 ? t("caius.plan.duration_h", { h }) : t("caius.plan.duration_hm", { h, m });
}

/** `180, 240` → "3–4 h"; ends that are not whole hours are written out in full. */
function formatRange(min: number, max: number) {
    if (min % 60 === 0 && max % 60 === 0) {
        return t("caius.plan.range_hours", { min: min / 60, max: max / 60 });
    }

    return t("caius.plan.range", { min: formatDuration(min), max: formatDuration(max) });
}
