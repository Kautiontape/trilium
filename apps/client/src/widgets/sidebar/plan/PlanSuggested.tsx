import "./PlanSuggested.css";

import { useState } from "preact/hooks";

import {
    caiusApi, type CaiusDismissItem, type CaiusItemResult, type CaiusPlan, type CaiusPlanTask,
    caiusWrite, describeOutcome, findOpenEditors
} from "../../../services/caius";
import { t } from "../../../services/i18n";
import Button from "../../react/Button";
import Dropdown from "../../react/Dropdown";
import { FormDropdownDivider, FormListItem } from "../../react/FormList";
import NoItems from "../../react/NoItems";
import RightPanelWidget from "../RightPanelWidget";

type Placement = { section: string } | { critical: true };

/** The period note's Suggested items, each to accept under a heading or as critical, or dismiss. */
export default function PlanSuggested({ plan, sections, onChanged }: {
    plan: CaiusPlan;
    sections: string[];
    onChanged: () => void;
}) {
    const [ outcomes, setOutcomes ] = useState<Record<string, string>>({});
    const { noteId } = plan;

    async function write(
        { listItemId }: CaiusPlanTask,
        send: (item: CaiusDismissItem) => Promise<CaiusItemResult[]>,
        successMessage: string
    ) {
        if (!noteId || !listItemId) {
            return;
        }

        const flushed = findOpenEditors(noteId).length > 0;
        const results = await caiusWrite(
            noteId,
            (expectedBlobId) => send({ noteId, listItemId, expectedBlobId }),
            successMessage
        );
        const outcome = describeOutcome(results?.[0], flushed);
        setOutcomes((previous) => ({ ...previous, [listItemId]: outcome ?? "" }));
        onChanged();
    }

    const accept = (task: CaiusPlanTask, placement: Placement) =>
        write(task, (item) => caiusApi.accept([ { ...item, ...placement } ]), t("caius.accepted"));
    const dismiss = (task: CaiusPlanTask) =>
        write(task, (item) => caiusApi.dismiss([ item ]), t("caius.dismissed"));

    return (
        <RightPanelWidget id="plan-suggested" title={t("caius.plan.suggested")}>
            {plan.suggested.length === 0 ? (
                <NoItems size="small" icon="bx bx-bulb" text={t("caius.plan.no_suggestions")} />
            ) : (
                <ul className="plan-task-list plan-suggested">
                    {plan.suggested.map((task) => (
                        <SuggestedRow
                            key={task.listItemId ?? task.text}
                            task={task}
                            sections={sections}
                            outcome={task.listItemId
                                ? outcomes[task.listItemId]
                                : t("caius.plan.no_id")}
                            onAccept={(placement) => void accept(task, placement)}
                            onDismiss={() => void dismiss(task)}
                        />
                    ))}
                </ul>
            )}
        </RightPanelWidget>
    );
}

function SuggestedRow({ task, sections, outcome, onAccept, onDismiss }: {
    task: CaiusPlanTask;
    sections: string[];
    outcome: string | undefined;
    onAccept: (placement: Placement) => void;
    onDismiss: () => void;
}) {
    return (
        <li>
            <span className="plan-task-text">{task.text}</span>
            <div className="plan-task-actions">
                <Dropdown
                    className="plan-accept"
                    text={t("caius.accept")}
                    buttonClassName="btn-sm"
                    disabled={!task.listItemId}
                    noDropdownListStyle
                    portalToBody
                >
                    {sections.map((section) => (
                        <FormListItem
                            key={section}
                            icon="bx bx-heading"
                            onClick={() => onAccept({ section })}
                        >
                            {section}
                        </FormListItem>
                    ))}
                    {sections.length > 0 && <FormDropdownDivider />}
                    <FormListItem icon="bx bx-error" onClick={() => onAccept({ critical: true })}>
                        {t("caius.accept_critical")}
                    </FormListItem>
                </Dropdown>
                <Button
                    size="small"
                    text={t("caius.dismiss")}
                    disabled={!task.listItemId}
                    disabledTooltip={t("caius.plan.no_id")}
                    onClick={onDismiss}
                />
            </div>
            {outcome && <div className="plan-task-outcome">{outcome}</div>}
        </li>
    );
}
