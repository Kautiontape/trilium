import "./item_view.css";

import type { ItemViewData } from "@triliumnext/caius/src/daily/views.js";
import type { TaskOrigin } from "@triliumnext/caius/src/trilium/origin-html.js";
import { useMemo, useState } from "preact/hooks";

import { TicketCard } from "../../components/TicketCard.js";
import { Chip } from "../../components/ui.js";
import { addDays, dayLabel } from "../../lib/day.js";
import { sourceName } from "../../lib/origin.js";
import {
    dispositionWords, redrawRows, type RowAnswer, takeTicket, type TicketAnswer, ticketTakes, trailWords, type ViewAnswers
} from "../../lib/views.js";
import { ContextLines, rowOpener, ViewRows } from "./ViewParts.js";

/**
 * The Item view: the task's row and its trail in words, where it came from, its ticket's card, what
 * was said about the key lately, and the Context lines naming it. A ticket no task names offers
 * Take (today, the next workday, a day or the week, On deck unless the list) and Finished, with
 * `onTicket`.
 */
export function ItemView({ data, answers, onAnswer, onTicket }: {
    data: ItemViewData;
    answers: ViewAnswers;
    onAnswer?: (key: string, answer: RowAnswer) => void;
    onTicket?: (key: string, answer: TicketAnswer | undefined) => void;
}) {
    const { task, ticket } = data;
    const rows = useMemo(() => task ? redrawRows([ task ], answers) : [], [ task, answers ]);
    const open = rowOpener(task ? [ task ] : [], answers, () => ({ nextWorkday: data.nextWorkday, days: [ data.today ], week: data.week }), onAnswer);
    const trail = trailWords(data.trail);
    return (
        <>
            {rows.length > 0 && <ViewRows tasks={rows} answers={answers} open={open} />}
            {trail && <p class="item-trail ink-2">{trail}</p>}
            {data.origin && <ItemOrigin origin={data.origin} />}
            {ticket && <TicketCard ticket={ticket} />}
            {!task && ticket && onTicket && (
                <TicketTake data={data} answer={answers.tickets?.[ticket.key]} onAnswer={(answer) => onTicket(ticket.key, answer)} />
            )}
            {data.dispositions.length > 0 && (
                <p class="item-dispositions ink-2">{data.dispositions.map(dispositionWords).join(" · ")}</p>
            )}
            <ContextLines lines={data.context} />
        </>
    );
}

/** Where the task came from: the note, the headings above it, the item it sits under, and the paragraph before its list. */
function ItemOrigin({ origin }: { origin: TaskOrigin }) {
    return (
        <div class="origin item-origin">
            <span class="origin-from">From <strong>{sourceName(origin)}</strong></span>
            {origin.headings.length > 0 && <span class="origin-place">under {origin.headings.join(" › ")}</span>}
            {origin.parent && <span class="origin-place">part of: {origin.parent}</span>}
            {origin.matched && origin.lead && <span class="origin-lead">{origin.lead}</span>}
        </div>
    );
}

/**
 * Take and Finished for a ticket no task names: a chip per day or week, a day picker, and where a
 * day takes it. Tapping the chip in force again takes the answer back.
 */
function TicketTake({ data, answer, onAnswer }: {
    data: ItemViewData;
    answer: TicketAnswer | undefined;
    onAnswer: (answer: TicketAnswer | undefined) => void;
}) {
    const [ onDeck, setOnDeck ] = useState(answer?.kind === "take" ? answer.onDeck : true);
    const [ picking, setPicking ] = useState(false);
    const [ date, setDate ] = useState("");
    const takes = ticketTakes(data, onDeck);
    const taken = answer?.kind === "take" ? answer.to : null;
    const pickedDay = taken !== null && !takes.some((t) => t.answer.kind === "take" && t.answer.to === taken);
    const land = (next: boolean) => {
        setOnDeck(next);
        if (answer?.kind === "take") {
            onAnswer({ ...answer, onDeck: next });
        }
    };
    return (
        <div class="item-take">
            <div class="chip-row" role="group" aria-label="Take it to">
                <span class="label-caps">Take it to</span>
                {takes.map(({ chip, answer: take }) => {
                    const selected = take.kind === "take" && take.to === taken;
                    return <Chip key={chip} selected={selected} onClick={() => onAnswer(selected ? undefined : take)}>{chip}</Chip>;
                })}
                <Chip selected={pickedDay} onClick={() => pickedDay ? onAnswer(undefined) : setPicking(!picking)}>
                    {pickedDay && taken ? dayLabel(taken) : "A day…"}
                </Chip>
                <Chip selected={answer?.kind === "finished"} onClick={() => onAnswer(answer?.kind === "finished" ? undefined : { kind: "finished" })}>Finished</Chip>
            </div>
            {picking && !pickedDay && (
                <div class="picker">
                    <input class="field" type="date" min={addDays(data.today, 1)} value={date} aria-label="Which day"
                        onInput={(e) => {
                            const value = (e.target as HTMLInputElement).value;
                            setDate(value);
                            if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                                onAnswer(takeTicket(data, value, onDeck));
                                setPicking(false);
                            }
                        }} />
                </div>
            )}
            <div class="chip-row" role="group" aria-label="A day takes it to">
                <span class="label-caps">A day takes it to</span>
                <Chip selected={onDeck} onClick={() => land(true)}>Its On deck</Chip>
                <Chip selected={!onDeck} onClick={() => land(false)}>Its list</Chip>
            </div>
        </div>
    );
}
