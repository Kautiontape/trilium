import "./today.css";

import { layoutWork } from "@triliumnext/caius/src/daily/blocks.js";
import { renderDayTerrain } from "@triliumnext/caius/src/draw/terrain.js";
import { useMemo } from "preact/hooks";

import { openRitual, openSettings } from "../app-state.js";
import { acceptFromSwipe, dismissSuggestion, ForwardSheet, markDone, startDoing, TaskSheet } from "../components/sheets.js";
import { TaskRow } from "../components/TaskRow.js";
import { Button, Card, openSheet } from "../components/ui.js";
import type { PlanTask } from "../lib/caius.js";
import { clockMinutes, dayLabel, duration, hhmm, nextWorkdayKey, parseMeeting } from "../lib/day.js";
import { api, appNow, held, outbox, refreshing, refreshToday, runWrite, serverStatus, taskKey, today, type TodayData, todayError } from "../lib/store.js";

/**
 * Today: the top half answers "what is today?" (terrain, the one nudge, Now), then capacity, the
 * Important block, the list in Caius's order (the first three are the Top 3), On deck, Suggested,
 * Meetings and Context. A card with nothing to say is absent.
 */
export function Today() {
    const data = today.value;
    if (!data) {
        return (
            <div class="screen today">
                <TodayHeader title="Today" sub={refreshing.value ? "Asking Caius…" : (todayError.value ?? "")} />
                {todayError.value && !refreshing.value && <Button onClick={() => void refreshToday()}>Try again</Button>}
            </div>
        );
    }
    const now = appNow();
    return (
        <div class="screen today">
            <TodayHeader title={data.label} sub={asOfLine(data, now)} />
            {data.offline && <p class="banner">{todayError.value ?? "Offline."} Actions are off until it's back.</p>}
            <TerrainView data={data} now={now} />
            <NudgeCard data={data} now={now} />
            <NowCard data={data} now={now} />
            <CapacityCard data={data} />
            <TaskLists data={data} />
            {outbox.value.length > 0 && (
                <Card class="pending">
                    <div class="label-caps">Waiting to send</div>
                    {outbox.value.map((c) => <p key={c.id} class="pending-row">◌ {c.text}</p>)}
                </Card>
            )}
            <MeetingsCard data={data} />
            <ContextCard data={data} />
        </div>
    );
}

function TodayHeader({ title, sub }: { title: string; sub: string }) {
    return (
        <header class="today-head">
            <div>
                <h1>{title}</h1>
                <p class="ink-2">{sub}</p>
            </div>
            <button type="button" class="icon-btn" aria-label="Refresh" disabled={refreshing.value} onClick={() => void refreshToday()}>↻</button>
            <button type="button" class="icon-btn" aria-label="Settings" onClick={openSettings}>⚙</button>
        </header>
    );
}

function asOfLine(data: TodayData, now: Date) {
    const at = new Date(data.asOf);
    const clock = hhmm(at.getHours() * 60 + at.getMinutes());
    const sameDay = at.toDateString() === now.toDateString();
    return `as of ${sameDay ? clock : at.toLocaleString()}`;
}

// ---- Terrain -----------------------------------------------------------------------------------

/** The day as Caius draws it: meetings as ridges, the list laid into the gaps from now on, the first block in clay. */
function TerrainView({ data, now }: { data: TodayData; now: Date }) {
    const svg = useMemo(() => {
        const meetings = data.plan.meetings.map(parseMeeting).filter((m): m is NonNullable<typeof m> => !!m);
        const live = (t: PlanTask) => (t.state === "open" || t.state === "in_progress") && !held.value[taskKey(t)];
        const tasks = [ ...data.plan.critical, ...data.plan.sections.flatMap((s) => s.tasks.filter((t) => !t.parent)) ]
            .filter(live)
            .map((t) => ({ label: t.text, minutes: t.estMinutes ?? 30, evening: /^(evening|recharge)$/i.test(t.section ?? "") }));
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const start = clockMinutes(data.rhythm.start) ?? 600;
        const { work } = layoutWork(
            { start: data.rhythm.start, end: data.rhythm.end, workEnd: data.rhythm.workEnd, notBefore: nowMinutes > start ? hhmm(nowMinutes) : undefined },
            meetings,
            tasks
        );
        try {
            return renderDayTerrain({
                start: data.rhythm.start,
                end: data.rhythm.end,
                workEnd: data.rhythm.workEnd,
                events: meetings.map((m) => ({ start: m.start, end: m.end, title: m.title })),
                work
            });
        } catch {
            return null;
        }
    }, [ data, held.value, now.getHours() ]);
    if (!svg) {
        return null;
    }
    // renderDayTerrain builds the SVG from escaped task and meeting text; nothing else goes in.
    return <div class="terrain" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// ---- The one nudge -----------------------------------------------------------------------------

function NudgeCard({ data, now }: { data: TodayData; now: Date }) {
    const state = data.nudge?.state;
    const catchup = data.catchup;
    const pendingCatchup = catchup && !catchup.data.skipped && catchup.data.tasks.length > 0 && state !== "planned" && state !== "wound_down";
    const minutes = now.getHours() * 60 + now.getMinutes();
    const offline = data.offline;

    if (pendingCatchup && catchup) {
        const moveAll = () => void runWrite(() => api().forward(catchup.data.tasks.map((t) => ({ noteId: t.noteId, listItemId: t.listItemId, to: catchup.data.moveTo }))));
        return (
            <Card tone="clay" class="nudge">
                <p class="nudge-text">{catchup.question}</p>
                <div class="nudge-actions">
                    <Button kind="primary" disabled={offline} onClick={moveAll}>Move all to today</Button>
                    <Button disabled={offline} onClick={() => openRitual("winddown", catchup.data.oldestDay ?? catchup.data.lastWorkday)}>Review</Button>
                    <Button kind="quiet" disabled={offline} onClick={() => void runWrite(() => api().skipCatchup(data.key))}>Skip</Button>
                </div>
            </Card>
        );
    }
    if (state === "unplanned" && minutes < (clockMinutes(data.rhythm.workEnd) ?? 18 * 60)) {
        return (
            <Card tone="clay" class="nudge">
                <p class="nudge-text">No plan yet.</p>
                <div class="nudge-actions">
                    <Button kind="primary" disabled={offline} onClick={() => openRitual("plan", data.key)}>Plan my day</Button>
                </div>
            </Card>
        );
    }
    if (minutes >= 15 * 60 && state !== "wound_down") {
        return (
            <Card tone="dusk" class="nudge">
                <p class="nudge-text">Wind down when you're ready.</p>
                <div class="nudge-actions">
                    <Button kind="primary" class="btn-dusk" disabled={offline} onClick={() => openRitual("winddown", data.key)}>Wind down</Button>
                </div>
            </Card>
        );
    }
    if (state === "wound_down") {
        const at = data.nudge && "woundDownAt" in data.nudge ? data.nudge.woundDownAt : null;
        return <p class="nudge-quiet ink-2">Wound down{at ? ` at ${at}` : ""}. Anything new lands on {dayLabel(nextWorkdayKey(data.key))}'s On deck.</p>;
    }
    if (serverStatus.value === null) {
        return (
            <div class="nudge-quiet rituals-row">
                <Button onClick={() => openRitual("plan", data.key)}>Plan my day</Button>
                <Button onClick={() => openRitual("winddown", data.key)}>Wind down</Button>
            </div>
        );
    }
    return null;
}

// ---- Now ---------------------------------------------------------------------------------------

/** The next task in his order that fits before the next meeting; the one he is Doing comes first. */
function NowCard({ data, now }: { data: TodayData; now: Date }) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const workEnd = clockMinutes(data.rhythm.workEnd) ?? 18 * 60;
    const order = [ ...data.plan.critical, ...data.plan.sections.flatMap((s) => s.tasks) ]
        .filter((t) => !t.parent && (t.state === "open" || t.state === "in_progress") && !held.value[taskKey(t)])
        .filter((t) => minutes >= workEnd || !/^(evening|recharge)$/i.test(t.section ?? ""));
    if (!order.length) {
        return null;
    }
    const meeting = data.plan.meetings.map(parseMeeting)
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({ ...m, at: clockMinutes(m.start) ?? 0 }))
        .find((m) => m.at > minutes);
    const gap = meeting ? meeting.at - minutes : null;
    const doing = order.find((t) => t.state === "in_progress");
    const task = doing ?? (gap === null ? order[0] : order.find((t) => (t.estMinutes ?? 30) <= gap) ?? order[0]);
    const head = meeting && gap !== null ? `Now · ${duration(gap)} until ${meeting.title}` : "Now";
    return (
        <Card class="now">
            <div class="label-caps">{head}</div>
            <button type="button" class="now-task" onClick={() => openSheet(<TaskSheet task={task} />)}>
                {task.state === "in_progress" ? "◐ " : ""}{task.text}
                <span class="mono ink-2">{task.estMinutes ? ` ~${task.estMinutes}m` : " ~?"}</span>
            </button>
            {!data.offline && (
                <div class="nudge-actions">
                    {task.state === "in_progress"
                        ? <Button kind="primary" onClick={() => markDone(task)}>✓ Done</Button>
                        : <Button kind="primary" onClick={() => startDoing(task)}>Start</Button>}
                    <Button kind="quiet" onClick={() => openSheet(<ForwardSheet task={task} />)}>Forward</Button>
                </div>
            )}
        </Card>
    );
}

// ---- Capacity ----------------------------------------------------------------------------------

function CapacityCard({ data }: { data: TodayData }) {
    const cap = data.plan.capacity;
    if (!cap.target) {
        return null;
    }
    const over = cap.totalMinutes - cap.target.max;
    const range = `${duration(cap.target.min).replace(/ h$/, "")}–${duration(cap.target.max)}`;
    return (
        <Card class="capacity" tone={over > 0 ? "ochre" : undefined}>
            <div class="capacity-line">
                <span><strong>{duration(cap.totalMinutes)}</strong> planned of {range}</span>
                {over > 0 && <span class="capacity-over mono">▲ {duration(over)} over</span>}
            </div>
            <CapacityBar planned={cap.totalMinutes} min={cap.target.min} max={cap.target.max} />
            {cap.unestimatedCount > 0 && <p class="capacity-note ink-2">{cap.unestimatedCount} unestimated, counted at 30 m</p>}
            {cap.onDeckMinutes > 0 && <p class="capacity-note ink-2">{duration(cap.onDeckMinutes)} on deck, not counted yet</p>}
        </Card>
    );
}

function CapacityBar({ planned, min, max }: { planned: number; min: number; max: number }) {
    const scale = Math.max(planned, max) * 1.1;
    const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
    return (
        <div class="capacity-bar" aria-hidden="true">
            <div class="capacity-target" style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }} />
            <div class={`capacity-fill${planned > max ? " over" : ""}`} style={{ width: pct(planned) }} />
        </div>
    );
}

// ---- The lists ---------------------------------------------------------------------------------

function TaskLists({ data }: { data: TodayData }) {
    const top = new Map(data.plan.top3.map((t, i) => [ taskKey(t), i + 1 ]));
    const swipes = (task: PlanTask) => data.offline ? {} : {
        right: { label: "✓ Done", tone: "moss" as const, run: () => markDone(task) },
        left: { label: "Forward ▸", tone: "dusk" as const, run: () => openSheet(<ForwardSheet task={task} />) }
    };
    const row = (task: PlanTask, variant: "list" | "critical" | "onDeck") => (
        <TaskRow key={taskKey(task)} task={task} variant={variant} top={top.get(taskKey(task))}
            detail={detailOf(task)} onOpen={() => openSheet(<TaskSheet task={task} />)} {...swipes(task)} />
    );

    return (
        <>
            {data.plan.critical.length > 0 && (
                <section class="list-group">
                    <h2 class="label-caps">Important</h2>
                    <div class="rows">{data.plan.critical.map((t) => row(t, "critical"))}</div>
                </section>
            )}
            {data.plan.sections.filter((s) => s.tasks.length).map((s) => (
                <section class="list-group" key={s.name ?? "tasks"}>
                    <h2 class="label-caps">{s.name ?? "Tasks"}</h2>
                    <div class="rows">{s.tasks.map((t) => row(t, "list"))}</div>
                </section>
            ))}
            {data.plan.onDeck.length > 0 && (
                <section class="list-group">
                    <h2 class="label-caps">On deck</h2>
                    <div class="rows">{data.plan.onDeck.map((t) => row(t, "onDeck"))}</div>
                    <p class="list-foot ink-2">Not on the list yet: Plan my day places these.</p>
                </section>
            )}
            {data.plan.suggested.length > 0 && (
                <section class="list-group">
                    <h2 class="label-caps">Suggested</h2>
                    <div class="rows">
                        {data.plan.suggested.map((t) => (
                            <TaskRow key={taskKey(t)} task={t} variant="suggested" onOpen={() => openSheet(<TaskSheet task={t} suggested />)}
                                {...(data.offline ? {} : {
                                    right: { label: "+ Accept", tone: "clay" as const, run: () => acceptFromSwipe(t) },
                                    left: { label: "Dismiss", tone: "berry" as const, run: () => dismissSuggestion(t) }
                                })} />
                        ))}
                    </div>
                </section>
            )}
        </>
    );
}

function detailOf(task: PlanTask) {
    if (task.state === "in_progress") {
        return "Doing";
    }
    return null;
}

function MeetingsCard({ data }: { data: TodayData }) {
    if (!data.plan.meetings.length) {
        return null;
    }
    return (
        <Card class="meetings">
            <div class="label-caps">Meetings</div>
            {data.plan.meetings.map((line) => <p key={line} class="mono-line"><span class="mono">{line.slice(0, 5)}</span> {line.slice(5).trim()}</p>)}
        </Card>
    );
}

function ContextCard({ data }: { data: TodayData }) {
    if (!data.plan.context.length) {
        return null;
    }
    return (
        <Card class="context">
            <div class="label-caps">Context</div>
            {data.plan.context.map((c) => (
                <p key={c.text}>{c.text}{c.until && <span class="mono ink-2"> until {c.until.slice(5)}</span>}</p>
            ))}
        </Card>
    );
}
