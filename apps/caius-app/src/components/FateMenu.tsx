import "./fate_menu.css";

import type { Area } from "@triliumnext/caius/src/trilium/areas.js";
import { useState } from "preact/hooks";

import { addDays, dayLabel } from "../lib/day.js";
import { AREA_NAMES, type FateChoice, type RowAnswer, sameFate, standingFate, type ViewFate, type ViewTask } from "../lib/views.js";
import { DROP_REASONS } from "./sheets.js";
import { displayText } from "./TaskRow.js";
import { Button, Chip, closeSheet, SheetAction, SheetTitle } from "./ui.js";

/** A line of the menu: its words, a detail on the right, and what it asks before it picks. */
export interface FateOption {
    label: string;
    detail?: string;
    ask?: "reason" | "date";
}

/** What the menu asked before a pick: why (Drop), which day, and whether a day takes it On deck or onto the list. */
export interface FateAsked {
    reason?: string;
    date?: string;
    onDeck?: boolean;
}

/**
 * The fate sheet: a line per fate with a check on the current one, a pick closing the sheet. A
 * line that asks shows its question under the lines first: Drop's reason, or a day picker. With
 * `landing`, a day lands On deck unless the list is picked; `estimate` and `area` add their rows.
 */
export function FateMenu({ title = "Fate", sub, options, current, onPick, landing, minDate, estimate, area }: {
    title?: string;
    sub: string;
    options: FateOption[];
    /** The label of the option in force, which gets the check. */
    current?: string;
    onPick: (index: number, asked: FateAsked) => void;
    landing?: boolean;
    /** The first day the day picker offers. */
    minDate?: string;
    estimate?: { minutes?: number; onPick: (minutes: number | undefined) => void };
    area?: { area?: Area; onPick: (area: Area | undefined) => void };
}) {
    const [ asking, setAsking ] = useState<number | null>(null);
    const [ reason, setReason ] = useState("");
    const [ date, setDate ] = useState("");
    const [ onDeck, setOnDeck ] = useState(true);
    const [ minutes, setMinutes ] = useState(estimate?.minutes);
    const [ chosenArea, setChosenArea ] = useState(area?.area);
    const pick = (index: number, asked: FateAsked = {}) => {
        onPick(index, landing ? { onDeck, ...asked } : asked);
        closeSheet();
    };
    const asked = asking !== null ? options[asking]?.ask : undefined;
    return (
        <>
            <SheetTitle title={title} sub={sub} />
            {landing && (
                <div class="chip-row fate-landing" role="group" aria-label="Another day lands on">
                    <span class="label-caps">Another day lands on</span>
                    <Chip selected={onDeck} onClick={() => setOnDeck(true)}>Its On deck</Chip>
                    <Chip selected={!onDeck} onClick={() => setOnDeck(false)}>Its list</Chip>
                </div>
            )}
            {options.map((option, at) => (
                <SheetAction key={option.label} glyph={option.label === current ? "check" : "·"} label={option.label} detail={option.detail}
                    tone={option.ask === "reason" ? "berry" : undefined}
                    onClick={() => option.ask ? setAsking(asking === at ? null : at) : pick(at)} />
            ))}
            {asking !== null && asked === "reason" && (
                <div class="picker fate-ask">
                    <div class="chip-row">
                        {DROP_REASONS.map((r) => <Chip key={r} selected={reason === r} onClick={() => setReason(r)}>{r}</Chip>)}
                    </div>
                    <input class="field" type="text" placeholder="Or say why…" value={DROP_REASONS.includes(reason) ? "" : reason}
                        onInput={(e) => setReason((e.target as HTMLInputElement).value)} aria-label="Why" />
                    <Button kind="primary" class="btn-berry" disabled={!reason.trim()} onClick={() => pick(asking, { reason: reason.trim() })}>Drop it</Button>
                </div>
            )}
            {asking !== null && asked === "date" && (
                <div class="picker fate-ask">
                    <input class="field" type="date" min={minDate} value={date} aria-label="Which day"
                        onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
                    <Button kind="primary" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(date)} onClick={() => pick(asking, { date })}>
                        Move to {/^\d{4}-\d{2}-\d{2}$/.test(date) ? dayLabel(date) : "…"}
                    </Button>
                </div>
            )}
            {estimate && (
                <div class="fate-extra">
                    <div class="label-caps">Estimate</div>
                    <div class="chip-row">
                        {ESTIMATES.map(([ value, label ]) => (
                            <Chip key={value} selected={minutes === value} onClick={() => {
                                const next = minutes === value ? undefined : value;
                                setMinutes(next);
                                estimate.onPick(next);
                            }}>{label}</Chip>
                        ))}
                    </div>
                </div>
            )}
            {area && (
                <div class="fate-extra">
                    <div class="label-caps">Area</div>
                    <div class="chip-row">
                        {(Object.keys(AREA_NAMES) as Area[]).map((value) => (
                            <Chip key={value} selected={chosenArea === value} onClick={() => {
                                const next = chosenArea === value ? undefined : value;
                                setChosenArea(next);
                                area.onPick(next);
                            }}>{AREA_NAMES[value]}</Chip>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
}

/**
 * The fate menu for a view's row: `choices` (`fateChoices`) with a check on the pending fate, or on
 * where the row stands, and the estimate and area rows. Each tap gives the row's whole answer to
 * `onAnswer`; picking the fate in force again takes the tap back.
 */
export function RowFateMenu({ task, choices, answer, onAnswer, estimate = true, area = true }: {
    task: ViewTask;
    choices: FateChoice[];
    answer: RowAnswer | undefined;
    onAnswer: (answer: RowAnswer) => void;
    estimate?: boolean;
    area?: boolean;
}) {
    const [ mine, setMine ] = useState<RowAnswer>(answer ?? {});
    const change = (patch: Partial<RowAnswer>) => {
        const next = { ...mine, ...patch };
        setMine(next);
        onAnswer(next);
    };
    const inForce = mine.fate ?? standingFate(task);
    const current = choices.find((c) => sameFate(c.fate, inForce))?.label ?? (mine.fate?.kind === "drop" ? choices.find((c) => c.ask === "reason")?.label : undefined);
    const fateOf = (choice: FateChoice, asked: FateAsked): ViewFate | undefined => {
        if (choice.ask === "reason") {
            return { kind: "drop", reason: asked.reason ?? "" };
        }
        if (choice.ask === "date" && asked.date) {
            return { kind: "day", date: asked.date, label: dayLabel(asked.date), onDeck: asked.onDeck ?? true };
        }
        return choice.fate?.kind === "day" ? { ...choice.fate, onDeck: asked.onDeck ?? true } : choice.fate;
    };
    return (
        <FateMenu sub={displayText(task.text).text} options={choices} current={current}
            landing={choices.some((c) => c.fate?.kind === "day" || c.ask === "date")}
            minDate={task.period.kind === "day" ? addDays(task.period.key, 1) : undefined}
            onPick={(at, asked) => {
                const fate = fateOf(choices[at], asked);
                const back = fate && fate.kind !== "drop" && fate.kind !== "day" && sameFate(fate, inForce);
                change({ fate: back ? undefined : fate });
            }}
            estimate={estimate ? { minutes: mine.estimate, onPick: (minutes) => change({ estimate: minutes }) } : undefined}
            area={area ? { area: mine.area, onPick: (value) => change({ area: value }) } : undefined} />
    );
}

const ESTIMATES: [ number, string ][] = [ [ 15, "15 m" ], [ 30, "30 m" ], [ 60, "1 h" ], [ 120, "2 h" ] ];
