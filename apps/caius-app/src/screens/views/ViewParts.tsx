import "./day_view.css";

import type { DayLoad } from "@triliumnext/caius/src/daily/load.js";
import type { ViewContextLine } from "@triliumnext/caius/src/daily/views.js";
import type { Area } from "@triliumnext/caius/src/trilium/areas.js";
import type { ComponentChildren } from "preact";

import { AreaMeter } from "../../components/AreaMeter.js";
import { RowFateMenu } from "../../components/FateMenu.js";
import { displayText, TaskRow } from "../../components/TaskRow.js";
import { openSheet } from "../../components/ui.js";
import { duration, periodLabel } from "../../lib/day.js";
import {
    type DayGroup, fateChoices, fateLabel, hasLiveSubItems, type RedrawnTask, type RowAnswer, rowKey, type ViewAnswers, type ViewTask
} from "../../lib/views.js";

/**
 * The pieces the views share: the three area meters, a list of rows and the line for the rows it
 * lost, the Context lines, and the opener of a row's fate menu. Their classes are `day_view.css`'s.
 */

/** The Foundation, Growth and Recharge meters: the view's figures, with the pending taps' as ghosts. The meter of `openOn` is marked. */
export function DayMeters({ load, after, openOn }: { load: DayLoad; after: DayLoad; openOn: Area | null }) {
    return (
        <div class="day-meters">
            <Meter area="foundation" openOn={openOn}>
                <AreaMeter name="Foundation" minutes={load.foundation.minutes} target={load.foundation.focus} tone ghost={after.foundation.minutes} />
                {after.onDeck.minutes > 0 && <p class="capacity-note ink-2">On deck would add {duration(after.onDeck.minutes)}</p>}
            </Meter>
            <Meter area="growth" openOn={openOn}>
                <AreaMeter name="Growth" minutes={load.growth.minutes} target={load.growth.target} ghost={after.growth.minutes} />
            </Meter>
            <Meter area="recharge" openOn={openOn}>
                <AreaMeter name="Recharge" minutes={0} target={null}
                    summary={after.recharge.count === load.recharge.count ? dots(load.recharge.count) : `${dots(load.recharge.count)} → ${dots(after.recharge.count)}`} />
            </Meter>
        </div>
    );
}

/**
 * Redrawn rows, each a `TaskRow` with its pending fate as its detail, else `detail`'s words. A
 * leaving row is struck through; a landed one says where it came from. `variant` is the group's,
 * else each row's own (Important, On deck or the list).
 */
export function ViewRows({ tasks, variant, answers, open, detail }: {
    tasks: RedrawnTask[];
    variant?: DayGroup["variant"];
    answers: ViewAnswers;
    open?: (task: RedrawnTask) => (() => void) | undefined;
    detail?: (task: RedrawnTask) => string | undefined;
}) {
    return (
        <div class="day-rows">
            {tasks.map((task) => {
                const fate = answers.rows?.[rowKey(task)]?.fate;
                const words = task.landed ? `from ${periodLabel(task.landed.key)}` : fate ? fateLabel(fate) : detail?.(task);
                return (
                    <div key={`${rowKey(task)}${task.landed ? "+" : ""}`} class={`day-row${task.leaving ? " leaving" : ""}${task.landed ? " landed" : ""}`}>
                        <TaskRow task={task} variant={variant ?? rowVariant(task)} detail={words} onOpen={open?.(task)} />
                    </div>
                );
            })}
        </div>
    );
}

/** A quiet line under a list the server cut to keep its reply short. Nothing for no count. */
export function NotShown({ count }: { count: number | undefined }) {
    return count ? <p class="view-not-shown ink-3">{count} more not shown</p> : null;
}

/** The Context lines, each with its until. Nothing for no lines. */
export function ContextLines({ lines }: { lines: ViewContextLine[] }) {
    if (!lines.length) {
        return null;
    }
    return (
        <section class="day-group">
            <h4 class="label-caps">Context</h4>
            {lines.map((line) => (
                <p key={line.text} class="day-context">
                    {displayText(line.text).text}
                    {(line.untilLabel ?? line.until) && <span class="mono ink-2"> until {line.untilLabel ?? line.until}</span>}
                </p>
            ))}
        </section>
    );
}

/**
 * The opener of a row's `RowFateMenu`, or nothing without `onAnswer`. The menu is the shown task's
 * (from `tasks`, found by `rowKey`), so a landed copy's menu offers what its original's does.
 */
export function rowOpener(tasks: ViewTask[], answers: ViewAnswers, where: (task: ViewTask) => Parameters<typeof fateChoices>[1],
    onAnswer: ((key: string, answer: RowAnswer) => void) | undefined) {
    return (task: RedrawnTask) => {
        if (!onAnswer) {
            return undefined;
        }
        const key = rowKey(task);
        const shown = tasks.find((t) => rowKey(t) === key) ?? task;
        return () => openSheet(
            <RowFateMenu task={shown} choices={fateChoices(shown, where(shown))} answer={answers.rows?.[key]}
                estimate={!hasLiveSubItems(shown, tasks)} onAnswer={(answer) => onAnswer(key, answer)} />
        );
    };
}

/** Recharge as one dot per thing. */
function dots(count: number) {
    return count ? "●".repeat(count) : "none yet";
}

/** One area's meter, marked when the view opens on its area. */
function Meter({ area, openOn, children }: { area: Area; openOn: Area | null; children: ComponentChildren }) {
    return <div class={`day-meter${openOn === area ? " open" : ""}`}>{children}</div>;
}

function rowVariant(task: RedrawnTask): DayGroup["variant"] {
    return task.place === "onDeck" ? "onDeck" : task.critical ? "critical" : "list";
}
