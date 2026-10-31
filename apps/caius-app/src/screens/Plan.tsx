import "./plan.css";

import { useEffect, useState } from "preact/hooks";

import { openSettings } from "../app-state.js";
import { acceptFromSwipe, dismissSuggestion, DropSheet, ExplainSheet, markDone, TaskSheet } from "../components/sheets.js";
import { TaskRow } from "../components/TaskRow.js";
import { Button, Card, closeSheet, haptic, openSheet, SheetAction, SheetTitle } from "../components/ui.js";
import type { Lane, OpenResult, OpenTask, PeriodKind, PlanTask, PlanView } from "../lib/caius.js";
import { addDays, addMonths, addWeeks, dayLabel, duration, monthLabel, periodLabel, weekLabel, weekOf } from "../lib/day.js";
import { api, holdWrite, messageOf, refOf, revision, taskKey, today } from "../lib/store.js";

const LANES: { lane: Lane; title: string }[] = [
    { lane: "overdue", title: "Overdue" },
    { lane: "week", title: "This week" },
    { lane: "orbit", title: "This month" }
];

const PAGE = 20;

/**
 * The desktop Plan tab, reshaped for a thumb: a day, week or month with ‹ › and Today, its list,
 * and the Pull in lanes (Overdue, This week, This month), each row naming where it comes from. The
 * overdue tail is worked off here a few rows at a time, never pushed onto Today.
 */
export function Plan() {
    const base = today.value?.key;
    const [ period, setPeriod ] = useState<PeriodKind>("week");
    const [ key, setKey ] = useState<string | null>(null);
    const [ view, setView ] = useState<PlanView | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    const current = key ?? (base ? keyFor(period, base) : null);

    useEffect(() => {
        if (!current) {
            return;
        }
        let stale = false;
        setError(null);
        api().plan(period, current).then((v) => !stale && setView(v), (e) => !stale && setError(messageOf(e)));
        return () => {
            stale = true;
        };
    }, [ period, current, revision.value ]);

    if (!base || !current) {
        return <div class="screen plan"><p class="ink-2">Asking Caius what today is…</p></div>;
    }

    const step = (n: number) => setKey(period === "day" ? addDays(current, n) : period === "week" ? addWeeks(current, n) : addMonths(current, n));
    const title = period === "day" ? dayLabel(current) : period === "week" ? weekLabel(current) : monthLabel(current);

    return (
        <div class="screen plan">
            <header class="today-head">
                <div>
                    <h1>Plan</h1>
                    <p class="ink-2">{title}</p>
                </div>
                <button type="button" class="icon-btn" aria-label="Settings" onClick={openSettings}>⚙</button>
            </header>
            <div class="plan-controls">
                <div class="segmented" role="tablist">
                    {(["day", "week", "month"] as const).map((p) => (
                        <button key={p} type="button" role="tab" aria-selected={period === p} class={period === p ? "active" : ""}
                            onClick={() => { setPeriod(p); setKey(null); setView(null); }}>
                            {p === "day" ? "Day" : p === "week" ? "Week" : "Month"}
                        </button>
                    ))}
                </div>
                <div class="stepper">
                    <button type="button" class="icon-btn" aria-label="Earlier" onClick={() => step(-1)}>‹</button>
                    <Button kind="quiet" onClick={() => setKey(null)}>Today</Button>
                    <button type="button" class="icon-btn" aria-label="Later" onClick={() => step(1)}>›</button>
                </div>
            </div>
            {error && <p class="banner">{error}</p>}
            {view && view.key === current && <PeriodView view={view} />}
            {LANES.map((l) => <LaneView key={l.lane} lane={l.lane} title={l.title} into={current} />)}
        </div>
    );
}

function keyFor(period: PeriodKind, day: string) {
    return period === "day" ? day : period === "week" ? weekOf(day) : day.slice(0, 7);
}

function PeriodView({ view }: { view: PlanView }) {
    const cap = view.capacity;
    const open = (task: PlanTask, suggested = false) => openSheet(<TaskSheet task={task} periodKey={view.key} suggested={suggested} />);
    const tasks = [ ...view.critical, ...view.sections.flatMap((s) => s.tasks) ];
    return (
        <>
            {view.noteId === null && <p class="ink-2 plan-empty">No note for {periodLabel(view.key)} yet. Pull something in to start one.</p>}
            {(cap.totalMinutes > 0 || cap.target) && (
                <Card class="capacity">
                    <div class="label-caps">Capacity</div>
                    <p class="plan-cap">
                        <strong>{duration(cap.totalMinutes)}</strong> planned{cap.target ? ` of ${duration(cap.target.min).replace(/ h$/, "")}–${duration(cap.target.max)}` : ""}
                        {cap.unestimatedCount > 0 && <span class="ink-2"> · {cap.unestimatedCount} ~?</span>}
                    </p>
                </Card>
            )}
            {tasks.length > 0 && (
                <section class="list-group">
                    <h2 class="label-caps">On the list</h2>
                    <div class="rows">
                        {tasks.map((t) => (
                            <TaskRow key={taskKey(t)} task={t} variant={t.critical ? "critical" : "list"} detail={t.section}
                                onOpen={() => open(t)} right={{ label: "✓ Done", tone: "moss", run: () => markDone(t) }} />
                        ))}
                    </div>
                </section>
            )}
            {view.onDeck.length > 0 && (
                <section class="list-group">
                    <h2 class="label-caps">On deck</h2>
                    <div class="rows">{view.onDeck.map((t) => <TaskRow key={taskKey(t)} task={t} variant="onDeck" onOpen={() => open(t)} />)}</div>
                </section>
            )}
            {view.suggested.length > 0 && (
                <section class="list-group">
                    <h2 class="label-caps">Suggested</h2>
                    <div class="rows">
                        {view.suggested.map((t) => (
                            <TaskRow key={taskKey(t)} task={t} variant="suggested" onOpen={() => open(t, true)}
                                right={{ label: "+ Accept", tone: "clay", run: () => acceptFromSwipe(t) }}
                                left={{ label: "Dismiss", tone: "berry", run: () => dismissSuggestion(t) }} />
                        ))}
                    </div>
                </section>
            )}
        </>
    );
}

/** One Pull in lane, 20 rows at a time. */
function LaneView({ lane, title, into }: { lane: Lane; title: string; into: string }) {
    const [ limit, setLimit ] = useState(PAGE);
    const [ result, setResult ] = useState<OpenResult | null>(null);
    useEffect(() => {
        let stale = false;
        api().open(lane, limit).then((r) => !stale && setResult(r), () => !stale && setResult({ total: 0, tasks: [] }));
        return () => {
            stale = true;
        };
    }, [ lane, limit, revision.value ]);

    const tasks = (result?.tasks ?? []).filter((t) => !t.parent);
    if (!result || !tasks.length) {
        return null;
    }
    return (
        <section class="list-group">
            <h2 class="label-caps">{title} <span class="mono">{tasks.length < result.total ? `${tasks.length} of ${result.total}` : result.total}</span></h2>
            <div class="rows">
                {tasks.map((t) => (
                    <TaskRow key={taskKey(t)} task={t} variant={t.critical ? "critical" : "list"}
                        detail={`${periodLabel(t.period)}${t.daysLate ? ` · ${t.daysLate} d late` : ""}${t.state === "in_progress" ? " · Doing" : ""}`}
                        onOpen={() => openSheet(<LaneSheet task={t} into={into} />)}
                        trailing={<span class="lane-more" aria-hidden="true">⋯</span>} />
                ))}
            </div>
            {tasks.length < result.total && (
                <Button kind="quiet" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, result.total - tasks.length)} more</Button>
            )}
        </section>
    );
}

/** ⋯ on a lane row: Pull in to the period being viewed, Done, Drop…, Why. */
function LaneSheet({ task, into }: { task: OpenTask; into: string }) {
    const ref = refOf(task);
    return (
        <>
            <SheetTitle title={task.text} sub={`${periodLabel(task.period)} · ${task.section ?? ""}`} />
            {ref && into !== task.period && (
                <SheetAction glyph="↓" tone="clay" label={`Pull in to ${periodLabel(into)}`} onClick={() => {
                    haptic("tick");
                    closeSheet();
                    holdWrite(ref, "forwarded", `Pulled in to ${periodLabel(into)}`, () => api().forward([ { ...ref, to: into } ]));
                }} />
            )}
            {ref && <SheetAction glyph="✓" tone="moss" label="Done" onClick={() => markDone(task)} />}
            {ref && <SheetAction glyph="✕" tone="berry" label="Drop…" onClick={() => openSheet(<DropSheet task={task} />)} />}
            <SheetAction glyph="?" label="Why is this here?" onClick={() => openSheet(<ExplainSheet task={task} />)} />
        </>
    );
}
