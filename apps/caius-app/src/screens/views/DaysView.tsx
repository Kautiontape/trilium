import "./days_view.css";

import type { DaysViewData, DaysViewDay } from "@triliumnext/caius/src/daily/views.js";
import type { Area } from "@triliumnext/caius/src/trilium/areas.js";
import { useMemo, useState } from "preact/hooks";

import { AreaMeter } from "../../components/AreaMeter.js";
import { duration, nextWorkdayKey } from "../../lib/day.js";
import { AREA_NAMES, type DaysCell, daysCells, type RedrawnDay, redrawDays, type RowAnswer, type ViewAnswers } from "../../lib/views.js";
import { DayMeters, rowOpener, ViewRows } from "./ViewParts.js";

/**
 * The Days view, drawn after the pending taps (`redrawDays`). Two days stand side by side with
 * their meters and rows; more make a grid of a row per day and a column each for meetings and the
 * three areas, whose area cell opens that day's rows in that area under it. The Week row holds the
 * week note's items not yet on a day and the week's Foundation against its target. A row's fate
 * menu offers the shown days and the week.
 */
export function DaysView({ data, answers, onAnswer }: {
    data: DaysViewData;
    answers: ViewAnswers;
    onAnswer?: (key: string, answer: RowAnswer) => void;
}) {
    const after = useMemo(() => redrawDays(data, answers), [ data, answers ]);
    const all = useMemo(() => [ ...data.days.flatMap((d) => d.tasks), ...data.week.tasks ], [ data ]);
    const dates = data.days.map((d) => d.date);
    const open = rowOpener(all, answers, (task) => ({
        days: dates,
        week: data.week.key,
        nextWorkday: task.period.kind === "day" ? nextWorkdayKey(task.period.key) : undefined
    }), onAnswer);
    const [ cell, setCell ] = useState<{ date: string; area: Area } | null>(null);
    const picked = cell ? data.days.findIndex((d) => d.date === cell.date) : -1;
    const pickedDay = after.days[picked];
    return (
        <>
            {data.days.length <= 2 ? (
                <div class="days-columns">
                    {data.days.map((day, at) => (
                        <section key={day.date} class={`days-column${day.workday ? "" : " off"}`}>
                            <h4 class="label-caps">{day.dateLabel}</h4>
                            <p class="days-meetings ink-2">{meetingsWords(day)}</p>
                            <DayMeters load={day.load} after={after.days[at].load} openOn={null} />
                            <ViewRows tasks={after.days[at].tasks} answers={answers} open={open} />
                        </section>
                    ))}
                </div>
            ) : (
                <>
                    <DaysGrid days={data.days} after={after.days} cell={cell} onCell={(date, area) =>
                        setCell(cell?.date === date && cell.area === area ? null : { date, area })} />
                    {cell && pickedDay && (
                        <section class="day-group">
                            <h4 class="label-caps">{data.days[picked].dateLabel} · {AREA_NAMES[cell.area]}</h4>
                            <CellRows day={pickedDay} area={cell.area} answers={answers} open={open} />
                        </section>
                    )}
                </>
            )}
            <section class="day-group days-week">
                <h4 class="label-caps">{data.week.label}</h4>
                <AreaMeter name="Foundation" minutes={data.week.foundation.minutes} target={data.week.foundation.target} tone />
                {after.week.length > 0
                    ? <ViewRows tasks={after.week} answers={answers} open={open} />
                    : <p class="step-note ink-2">Nothing on the week that isn't on a day.</p>}
            </section>
        </>
    );
}

/** The grid: a row per day, its meetings and each area's figure, the area cells tappable. */
function DaysGrid({ days, after, cell, onCell }: {
    days: DaysViewDay[];
    after: RedrawnDay[];
    cell: { date: string; area: Area } | null;
    onCell: (date: string, area: Area) => void;
}) {
    return (
        <table class="days-grid">
            <thead>
                <tr>
                    <th />
                    <th class="label-caps">Meetings</th>
                    {AREAS.map((area) => <th key={area} class="label-caps">{AREA_NAMES[area]}</th>)}
                </tr>
            </thead>
            <tbody>
                {days.map((day, at) => {
                    const cells = daysCells(day, after[at]);
                    return (
                        <tr key={day.date} class={day.workday ? undefined : "off"}>
                            <th scope="row">{day.dateLabel}</th>
                            <td class="mono ink-2">{cells.meetings}</td>
                            {AREAS.map((area) => (
                                <td key={area}>
                                    <GridCell cell={cells[area]} selected={cell?.date === day.date && cell.area === area}
                                        label={`${day.dateLabel} ${AREA_NAMES[area]}`} onClick={() => onCell(day.date, area)} />
                                </td>
                            ))}
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function GridCell({ cell, selected, label, onClick }: { cell: DaysCell; selected: boolean; label: string; onClick: () => void }) {
    return (
        <button type="button" class={`days-cell mono${cell.over ? " over" : ""}${selected ? " selected" : ""}`} aria-pressed={selected} aria-label={label} onClick={onClick}>
            {cell.figure}
            {cell.was && <span class="days-cell-was ink-3">was {cell.was}</span>}
        </button>
    );
}

/** A day's rows in one area, after the taps, or a line saying there are none. */
function CellRows({ day, area, answers, open }: {
    day: RedrawnDay;
    area: Area;
    answers: ViewAnswers;
    open: ReturnType<typeof rowOpener>;
}) {
    const tasks = day.tasks.filter((t) => t.area === area);
    if (!tasks.length) {
        return <p class="step-note ink-2">Nothing in {AREA_NAMES[area]}.</p>;
    }
    return <ViewRows tasks={tasks} answers={answers} open={open} />;
}

/** `2 h of meetings`, `No meetings`, `Day off`, or that the calendar couldn't be read. */
function meetingsWords(day: DaysViewDay) {
    if (day.calendarFailed) {
        return "The calendar couldn't be read.";
    }
    const meetings = day.meetingMinutes ? `${duration(day.meetingMinutes)} of meetings` : "No meetings";
    return day.workday ? meetings : `Day off · ${meetings.toLowerCase()}`;
}

const AREAS: Area[] = [ "foundation", "growth", "recharge" ];
