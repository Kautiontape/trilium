import "./day_view.css";

import type { DayViewData } from "@triliumnext/caius/src/daily/views.js";
import { renderDayTerrain, type TerrainInput } from "@triliumnext/caius/src/draw/terrain.js";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";

import { duration, nextWorkdayKey, weekOf } from "../../lib/day.js";
import { dayGroups, dayTerrain, redrawDay, type RowAnswer, type ViewAnswers } from "../../lib/views.js";
import { cropToContent } from "../Today.js";
import { ContextLines, DayMeters, rowOpener, ViewRows } from "./ViewParts.js";

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
    const where = { nextWorkday: nextWorkdayKey(data.date), week: weekOf(data.date) };
    const open = rowOpener(data.tasks, answers, () => where, onAnswer);
    const booked = data.capacity.bookedMinutes;
    return (
        <>
            {data.calendarFailed
                ? <p class="step-note ink-2">The calendar couldn't be read, so the focus is the stated one.</p>
                : booked > 0 && <p class="step-note ink-2">{duration(booked)} of meetings · {duration(data.capacity.openMinutes)} open</p>}
            <DayMeters load={data.load} after={day.load} openOn={data.openOn} />
            <DayTimeline input={terrain.input} />
            {terrain.unplacedMinutes > 0 && <p class="step-note ink-2">{duration(terrain.unplacedMinutes)} doesn't fit before bedtime.</p>}
            {dayGroups(day.tasks).map((group) => (
                <section key={group.name} class="day-group">
                    <h4 class="label-caps">{group.name}</h4>
                    <ViewRows tasks={group.tasks} variant={group.variant} answers={answers} open={open} />
                </section>
            ))}
            <ContextLines lines={data.context} />
        </>
    );
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
