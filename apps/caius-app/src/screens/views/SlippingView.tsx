import "./slipping_view.css";

import type { SlippingViewData } from "@triliumnext/caius/src/daily/views.js";
import { useMemo } from "preact/hooks";

import { nextWorkdayKey, periodLabel, weekOf } from "../../lib/day.js";
import { today } from "../../lib/store.js";
import { overdueLine, redrawRows, type RowAnswer, type ViewAnswers } from "../../lib/views.js";
import { rowOpener, ViewRows } from "./ViewParts.js";

/**
 * The Slipping view: the tasks moved twice or more, the longest trail first, each with its count
 * and where it sits now, then the overdue lane's count by how late. A row's fate menu adds Park.
 */
export function SlippingView({ data, answers, onAnswer }: {
    data: SlippingViewData;
    answers: ViewAnswers;
    onAnswer?: (key: string, answer: RowAnswer) => void;
}) {
    const sorted = useMemo(() => [ ...data.tasks ].sort((a, b) => b.slips - a.slips), [ data ]);
    const rows = useMemo(() => redrawRows(sorted, answers), [ sorted, answers ]);
    const open = rowOpener(data.tasks, answers, (task) => {
        const base = today.value?.key ?? (task.period.kind === "day" ? task.period.key : undefined);
        return { nextWorkday: base && nextWorkdayKey(base), week: base && weekOf(base), parkMonth: data.parkMonth };
    }, onAnswer);
    const overdue = overdueLine(data.overdue);
    return (
        <>
            {rows.length > 0
                ? <ViewRows tasks={rows} answers={answers} open={open} detail={(task) => `on ${periodLabel(task.period.key)}`} />
                : <p class="step-note ink-2">Nothing has moved twice.</p>}
            <p class="slipping-overdue ink-2">{overdue ? `Overdue: ${overdue}` : "Nothing overdue."}</p>
        </>
    );
}
