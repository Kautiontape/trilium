import "./PlanContext.css";

import type { CaiusContextLine } from "../../../services/caius";
import { t } from "../../../services/i18n";
import { formatShortDate } from "../../../utils/formatters";
import NoItems from "../../react/NoItems";
import RightPanelWidget from "../RightPanelWidget";
import { endsSoon, taskLabel } from "./plan_logic";

/** The Context lines in force on the viewed day `date`, each with the day it ends. */
export default function PlanContext({ date, lines }: {
    date: string;
    lines: CaiusContextLine[];
}) {
    return (
        <RightPanelWidget id="plan-context" title={t("caius.plan.context")}>
            {lines.length === 0 ? (
                <NoItems size="small" icon="bx bx-info-circle" text={t("caius.plan.no_context")} />
            ) : (
                <ul className="plan-task-list plan-context">
                    {lines.map((line) => (
                        <li key={`${line.noteId}:${line.text}`}>
                            <span className="plan-context-text">{taskLabel(line.text)}</span>
                            {line.until && (
                                <span className="plan-context-until">
                                    {t("caius.plan.context_until", { date: formatShortDate(line.until) })}
                                </span>
                            )}
                            {endsSoon(line, date) && (
                                <span className="plan-context-ends-soon">{t("caius.plan.context_ends_soon")}</span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </RightPanelWidget>
    );
}
