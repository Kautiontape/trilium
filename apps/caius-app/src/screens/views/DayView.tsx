import "./day_view.css";

import type { DayViewData } from "@triliumnext/caius/src/daily/views.js";
import { renderDayTerrain, type TerrainInput } from "@triliumnext/caius/src/draw/terrain.js";
import type { Area } from "@triliumnext/caius/src/trilium/areas.js";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";

import { AreaMeter } from "../../components/AreaMeter.js";
import { RowFateMenu } from "../../components/FateMenu.js";
import { displayText, TaskRow } from "../../components/TaskRow.js";
import { openSheet } from "../../components/ui.js";
import { duration, nextWorkdayKey, weekOf } from "../../lib/day.js";
import { dayGroups, dayTerrain, fateChoices, fateLabel, hasLiveSubItems, type RedrawnTask, redrawDay, type RowAnswer, rowKey, type ViewAnswers } from "../../lib/views.js";
import { cropToContent } from "../Today.js";

/**
 * The Day view: the three area meters, the day's timeline, the rows by block then On deck, and the
 * Context lines, drawn as they stand after the pending taps (`redrawDay`, `dayTerrain`). The meter
 * of `openOn` is marked. With `onAnswer`, a row opens `RowFateMenu`.
 */
export function DayView({ data, answers, onAnswer }: {
    data: DayViewData;
    answers: ViewAnswers;
    onAnswer?: (key: string, answer: RowAnswer) => void;
}) {
    const day = useMemo(() => redrawDay(data, answers), [ data, answers ]);
    const terrain = useMemo(() => dayTerrain(data, day.tasks), [ data, day ]);
    const tapped = Object.values(answers.rows ?? {}).some((a) => a.fate || a.estimate !== undefined || a.area);
    const unplaced = tapped ? terrain.unplacedMinutes : data.unplacedMinutes;
    const { load } = data;
    const after = day.load;
    const where = { nextWorkday: nextWorkdayKey(data.date), week: weekOf(data.date) };
    const open = (task: RedrawnTask) => {
        if (!onAnswer) {
            return undefined;
        }
        const key = rowKey(task);
        const shown = data.tasks.find((t) => rowKey(t) === key) ?? task;
        return () => openSheet(
            <RowFateMenu task={shown} choices={fateChoices(shown, where)} answer={answers.rows?.[key]}
                estimate={!hasLiveSubItems(shown, data.tasks)} onAnswer={(answer) => onAnswer(key, answer)} />
        );
    };
    const booked = data.capacity.bookedMinutes;
    return (
        <>
            {data.calendarFailed
                ? <p class="step-note ink-2">The calendar couldn't be read, so the focus is the stated one.</p>
                : booked > 0 && <p class="step-note ink-2">{duration(booked)} of meetings · {duration(data.capacity.openMinutes)} open</p>}
            <div class="day-meters">
                <Meter area="foundation" openOn={data.openOn}>
                    <AreaMeter name="Foundation" minutes={load.foundation.minutes} target={load.foundation.focus} tone ghost={after.foundation.minutes} />
                    {after.onDeck.minutes > 0 && <p class="capacity-note ink-2">On deck would add {duration(after.onDeck.minutes)}</p>}
                </Meter>
                <Meter area="growth" openOn={data.openOn}>
                    <AreaMeter name="Growth" minutes={load.growth.minutes} target={load.growth.target} ghost={after.growth.minutes} />
                </Meter>
                <Meter area="recharge" openOn={data.openOn}>
                    <AreaMeter name="Recharge" minutes={0} target={null}
                        summary={after.recharge.count === load.recharge.count ? dots(load.recharge.count) : `${dots(load.recharge.count)} → ${dots(after.recharge.count)}`} />
                </Meter>
            </div>
            <DayTimeline input={terrain.input} />
            {unplaced > 0 && <p class="step-note ink-2">{duration(unplaced)} doesn't fit before bedtime.</p>}
            {dayGroups(day.tasks).map((group) => (
                <section key={group.name} class="day-group">
                    <h4 class="label-caps">{group.name}</h4>
                    <div class="day-rows">
                        {group.tasks.map((task) => {
                            const fate = answers.rows?.[rowKey(task)]?.fate;
                            return (
                                <div key={rowKey(task)} class={`day-row${task.leaving ? " leaving" : ""}`}>
                                    <TaskRow task={task} variant={group.variant} detail={fate ? fateLabel(fate) : undefined} onOpen={open(task)} />
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
            {data.context.length > 0 && (
                <section class="day-group">
                    <h4 class="label-caps">Context</h4>
                    {data.context.map((line) => (
                        <p key={line.text} class="day-context">
                            {displayText(line.text).text}
                            {(line.untilLabel ?? line.until) && <span class="mono ink-2"> until {line.untilLabel ?? line.until}</span>}
                        </p>
                    ))}
                </section>
            )}
        </>
    );
}

/** One area's meter, marked when the view opens on its area. */
function Meter({ area, openOn, children }: { area: Area; openOn: Area | null; children: ComponentChildren }) {
    return <div class={`day-meter${openOn === area ? " open" : ""}`}>{children}</div>;
}

/** The day's work as Today draws it, from `dayTerrain`'s input. */
function DayTimeline({ input }: { input: TerrainInput }) {
    const svg = useMemo(() => {
        try {
            return renderDayTerrain(input);
        } catch {
            return null;
        }
    }, [ input ]);
    const terrain = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => cropToContent(terrain.current?.querySelector("svg")), [ svg ]);
    if (!svg) {
        return null;
    }
    // renderDayTerrain builds the SVG from escaped task and meeting text; nothing else goes in.
    return <div class="day-terrain" ref={terrain} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Recharge as one dot per thing. */
function dots(count: number) {
    return count ? "●".repeat(count) : "none yet";
}
