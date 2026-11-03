import { useLayoutEffect, useMemo, useState } from "preact/hooks";

import { haptic } from "../../components/ui.js";
import { type RowAnswer, type ShownView, type ViewAnswers, viewPicks, viewReply } from "../../lib/views.js";
import { DayView } from "./DayView.js";

/** A view's answer for the answers pill, in the step cards' form. */
export interface ViewReport {
    sentences: string[];
    picks: { what: string; choice: string; undo?: () => void }[];
    total: number;
}

/**
 * A `caius_show` result in the chat: the view `view.view` names, its taps kept here. While `live`,
 * it reports its sentences (`viewReply`) and pill rows (`viewPicks`) under `id` as a step card does;
 * with no taps the report is empty and adds nothing to the pill. Days, Item and Slipping show the
 * view's one-line `sentence` for now.
 */
export function ViewCard({ id, view: parsed, live, report }: {
    id: string;
    view: ShownView;
    live: boolean;
    report: (key: string, answer: ViewReport) => void;
}) {
    // A tool call's result is final, so the view parsed again on each render is the same for one `id`;
    // keeping the first lets `DayView` memoize its redraw and drawing across streaming chunks.
    const view = useMemo(() => parsed, [ id ]);
    const [ answers, setAnswers ] = useState<ViewAnswers>({});
    const answerRow = (key: string, answer: RowAnswer) => {
        haptic("tick");
        setAnswers((prev) => ({ ...prev, rows: { ...prev.rows, [key]: answer } }));
    };
    const { sentences, picks, total } = useMemo(() => ({ sentences: viewReply(view, answers), ...viewPicks(view, answers) }), [ view, answers ]);
    const joined = JSON.stringify([ sentences, picks.map((p) => [ p.what, p.choice ]) ]);
    // A layout effect, so the pill holds the new answer before the next paint and a quick Send never sends the old one.
    useLayoutEffect(() => {
        if (live) {
            report(id, { sentences, total, picks: picks.map((p) => ({ what: p.what, choice: p.choice, undo: () => setAnswers(p.undo) })) });
        }
    }, [ live, joined ]);
    return (
        <section class={`step-card view-card view-${view.view}`}>
            {view.title && <h3 class="step-title">{view.title}</h3>}
            {view.view === "day"
                ? <DayView data={view.data} answers={answers} onAnswer={live ? answerRow : undefined} />
                : view.sentence && <p class="step-note ink-2">{view.sentence}</p>}
        </section>
    );
}
