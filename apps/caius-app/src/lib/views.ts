import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import { layoutGroups } from "@triliumnext/caius/src/daily/blocks.js";
import { groupTasks, meetingName } from "@triliumnext/caius/src/daily/groups.js";
import { type DayLoad, dayLoad, DEFAULT_ESTIMATE, liveMinutes } from "@triliumnext/caius/src/daily/load.js";
import type { DaysViewData, DaysViewDay, DayViewData, ItemViewData, ShownView, SlippingViewData, ViewName, ViewTask, ViewTrailStep } from "@triliumnext/caius/src/daily/views.js";
import type { TerrainInput } from "@triliumnext/caius/src/draw/terrain.js";
import { type Area, bareText, type Block } from "@triliumnext/caius/src/trilium/areas.js";

import { displayText } from "../components/TaskRow.js";
import { type ToolCall, parseResult } from "./chat.js";
import { clockMinutes, dayLabel, duration, hhmm, monthLabel, periodLabel, weekLabel } from "./day.js";
import { chipLabel, choicePhrase } from "./replies.js";

export type { ShownView, ViewName, ViewTask };

/**
 * The views `caius_show` answers, and what a tap on one says. Taps gather as on the step cards: a
 * view reports its sentences (`viewReply`) and pill rows (`viewPicks`), and draws its rows and
 * meters as they would stand after the taps (`redraw`), with the server's own arithmetic.
 */

/** Where a tap sends a row. `block`, `onDeck` and `list` keep it on its day; the rest take it off. */
export type ViewFate =
    | { kind: "done" }
    | { kind: "block"; block: Block }
    | { kind: "onDeck" }
    | { kind: "list" }
    | { kind: "day"; date: string; label: string; onDeck: boolean }
    | { kind: "week"; week: string; label: string }
    | { kind: "park"; month: string; label: string }
    | { kind: "drop"; reason: string };

/** The taps on one row; anything missing is untouched. */
export interface RowAnswer {
    fate?: ViewFate;
    estimate?: number;
    area?: Area;
}

/** A ticket no task names (Item): taken to a day or the week, or finished. `label` is `today`, a day's or the week's. */
export type TicketAnswer =
    | { kind: "take"; to: string; label: string; onDeck: boolean }
    | { kind: "finished" };

/** What has been tapped on one view: rows by `rowKey`, tickets by key. */
export interface ViewAnswers {
    rows?: Record<string, RowAnswer>;
    tickets?: Record<string, TicketAnswer>;
}

/** One tap as the answers pill lists it, and the answers with that tap taken back. */
export interface ViewPick {
    what: string;
    choice: string;
    undo: ViewAnswers;
}

/**
 * A row as it would stand after the taps; `leaving` when a tap takes it (or its parent) off the day.
 * `fate` is the row's own tap or its parent's; `landed` is set on a copy a tap brings from another
 * day or the week (Days), and names the period it came from.
 */
export interface RedrawnTask extends ViewTask {
    leaving: boolean;
    fate?: ViewFate;
    landed?: ViewTask["period"];
}

export interface RedrawnDay {
    tasks: RedrawnTask[];
    load: DayLoad;
}

const VIEW_NAMES: readonly ViewName[] = [ "day", "days", "item", "slipping" ];

/**
 * The view a successful `caius_show` call answered, as `stepOf` reads a step: null for any other
 * tool, a failed call, or a result with no known `view` and `data` object.
 */
export function viewOf(call: ToolCall): ShownView | null {
    const tool = call.toolName.replace(/^mcp__[\w-]+__/, "");
    if (tool !== "caius_show" || call.isError || !call.result) {
        return null;
    }
    const parsed = parseResult(call.result) as { view?: unknown; title?: unknown; sentence?: unknown; data?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || !VIEW_NAMES.includes(parsed.view as ViewName)) {
        return null;
    }
    if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
        return null;
    }
    return {
        view: parsed.view,
        title: typeof parsed.title === "string" ? parsed.title : "",
        sentence: typeof parsed.sentence === "string" ? parsed.sentence : "",
        data: parsed.data
    } as ShownView;
}

/**
 * The view's taps as one sentence in the step cards' form: each row's words in quotes, then what
 * happens to it; a row with a fate and an estimate gives a clause for each. A day, week or month
 * carries its key in brackets after its label, so Caius passes the key as given. No taps, no sentence.
 */
export function viewReply(view: ShownView, answers: ViewAnswers): string[] {
    const clauses = [
        ...rowsOf(view).flatMap((task) => {
            const answer = answers.rows?.[rowKey(task)];
            if (!answer) {
                return [];
            }
            const words = `"${displayText(task.text).text}"`;
            return [
                answer.fate && (answer.fate.kind === "drop" ? `${words}: ${choicePhrase(answer.fate, null)}` : `${words} ${fatePhrase(answer.fate)}`),
                answer.estimate !== undefined && `${words} is ${minutesWords(answer.estimate)}`,
                answer.area && `${words} is ${AREA_NAMES[answer.area]}`
            ].filter((c): c is string => !!c);
        }),
        ...ticketKeysOf(view).flatMap((key) => {
            const answer = answers.tickets?.[key];
            return answer ? [ ticketPhrase(key, answer) ] : [];
        })
    ];
    return clauses.length ? [ `${leadOf(view)}: ${clauses.join("; ")}.` ] : [];
}

/**
 * The view's taps as pill rows, one per tapped fate, estimate, area or ticket so each undoes on
 * its own. `total` is the taps alone: a view proposes nothing, so nothing on it "goes as proposed".
 */
export function viewPicks(view: ShownView, answers: ViewAnswers): { picks: ViewPick[]; total: number } {
    const picks: ViewPick[] = [];
    for (const task of rowsOf(view)) {
        const id = rowKey(task);
        const answer = answers.rows?.[id];
        if (!answer) {
            continue;
        }
        const what = displayText(task.text).text;
        const without = (field: keyof RowAnswer): ViewAnswers => {
            const { [field]: _, ...rest } = answer;
            return { ...answers, rows: { ...answers.rows, [id]: rest } };
        };
        if (answer.fate) {
            picks.push({ what, choice: fateLabel(answer.fate), undo: without("fate") });
        }
        if (answer.estimate !== undefined) {
            picks.push({ what, choice: `~${formatEstimate(answer.estimate)}`, undo: without("estimate") });
        }
        if (answer.area) {
            picks.push({ what, choice: AREA_NAMES[answer.area], undo: without("area") });
        }
    }
    for (const key of ticketKeysOf(view)) {
        const answer = answers.tickets?.[key];
        if (answer) {
            const { [key]: _, ...rest } = answers.tickets ?? {};
            picks.push({ what: key, choice: ticketLabel(answer), undo: { ...answers, tickets: rest } });
        }
    }
    return { picks, total: picks.length };
}

/**
 * Each day of the view (one for Day, every day for Days, none for Item and Slipping) with its taps
 * applied. Its meters are the server's `load` moved by what the taps change, worked again by
 * `dayLoad` against the focus and Growth target it came with: the server can cut rows off a long
 * list (`omitted`), so a count of the rows alone would read low.
 */
export function redraw(view: ShownView, answers: ViewAnswers): RedrawnDay[] {
    switch (view.view) {
        case "day":
            return [ redrawDay(view.data, answers) ];
        case "days":
            return redrawDays(view.data, answers).days;
        default:
            return [];
    }
}

/** One day's rows and load after the taps. A leaving row stays in `tasks`, so the view can strike it through. */
export function redrawDay(day: { tasks: ViewTask[]; load: DayLoad }, answers: ViewAnswers): RedrawnDay {
    return withLoad(day, redrawRows(day.tasks, answers));
}

/**
 * Days after the taps: each day's own rows, and a copy of each row a tap sends to a shown day,
 * `landed` on its list or On deck, before its meters are worked again; the week's rows, with a copy of
 * each day's row sent to the week. A row sent anywhere else only leaves.
 */
export function redrawDays(data: DaysViewData, answers: ViewAnswers): { days: RedrawnDay[]; week: RedrawnTask[] } {
    const rows = redrawRows([ ...data.days.flatMap((d) => d.tasks), ...data.week.tasks ], answers);
    const landing = (own: ViewTask[], lands: (fate: ViewFate) => Partial<ViewTask> | null) => {
        const keys = new Set(own.map(rowKey));
        return [
            ...rows.filter((t) => keys.has(rowKey(t))),
            ...rows.flatMap((t): RedrawnTask[] => {
                const to = t.fate && !keys.has(rowKey(t)) ? lands(t.fate) : null;
                return to ? [ { ...t, ...to, leaving: false, landed: t.period } ] : [];
            })
        ];
    };
    return {
        days: data.days.map((day) => withLoad(day, landing(day.tasks, (fate) => fate.kind === "day" && fate.date === day.date
            ? { period: { kind: "day", key: day.date }, place: fate.onDeck ? "onDeck" : "list", block: null }
            : null))),
        week: landing(data.week.tasks, (fate) => fate.kind === "week" && fate.week === data.week.key
            ? { period: { kind: "week", key: data.week.key }, place: "list", block: null }
            : null)
    };
}

/** Each figure of a Days grid column after the taps: ▲ on an area over its target, ○ for no Recharge, and `was` when a tap changed it. */
export function daysCells(day: DaysViewDay, after: RedrawnDay): { meetings: string; foundation: DaysCell; growth: DaysCell; recharge: DaysCell } {
    const cell = (before: string, figure: string, over: boolean): DaysCell => ({ figure: over ? `▲ ${figure}` : figure, ...(before !== figure ? { was: before } : {}), over });
    const recharge = (count: number) => count ? "●".repeat(count) : "○";
    return {
        meetings: day.calendarFailed ? "?" : day.meetingMinutes ? duration(day.meetingMinutes) : "–",
        foundation: cell(duration(day.load.foundation.minutes), duration(after.load.foundation.minutes), after.load.foundation.over),
        growth: cell(duration(day.load.growth.minutes), duration(after.load.growth.minutes), after.load.growth.over),
        recharge: cell(recharge(day.load.recharge.count), recharge(after.load.recharge.count), false)
    };
}

/** One cell of the Days grid. */
export interface DaysCell {
    figure: string;
    was?: string;
    over: boolean;
}

/** A trail in words, oldest first: `moved on from Mon 2 Nov, then Tue 3 Nov; on Wed 4 Nov now`. Null for no trail. */
export function trailWords(trail: ViewTrailStep[]): string | null {
    const moved = trail.filter((step) => step.movedOn).map((step) => step.label);
    const now = trail.find((step) => !step.movedOn);
    const parts = [
        moved.length ? `moved on from ${moved.join(", then ")}` : null,
        now ? (now.state === "done" ? `done on ${now.label}` : now.state === "cancelled" ? `dropped on ${now.label}` : `on ${now.label} now`) : null
    ].filter((part): part is string => !!part);
    return parts.length ? parts.join("; ") : null;
}

/** The overdue lane by how late, `3 under a week · 1 from 1–2 weeks · 2 older`; null when nothing is overdue. */
export function overdueLine(overdue: SlippingViewData["overdue"]): string | null {
    const parts = [
        overdue.underWeek && `${overdue.underWeek} under a week`,
        overdue.oneToTwoWeeks && `${overdue.oneToTwoWeeks} from 1–2 weeks`,
        overdue.older && `${overdue.older} older`
    ].filter((part): part is string => !!part);
    return parts.length ? parts.join(" · ") : null;
}

/** `Dismissed until Mon 9 Nov`, `Finished`, `Not today`. */
export function dispositionWords(disposition: ItemViewData["dispositions"][number]): string {
    const name = disposition.kind === "dismissed" ? "Dismissed" : disposition.kind === "finished" ? "Finished" : "Not today";
    return disposition.until ? `${name} until ${periodLabel(disposition.until)}` : name;
}

/** The Item view's Take chips for a ticket no task names: today, the next workday and the week, each landing On deck unless `onDeck` is false. */
export function ticketTakes(data: ItemViewData, onDeck: boolean): { chip: string; answer: TicketAnswer }[] {
    const keys = [ ...new Set([ data.today, data.nextWorkday, data.week ]) ];
    return keys.map((to) => ({ chip: to === data.today ? "Today" : takeLabel(data, to), answer: takeTicket(data, to, onDeck) }));
}

/** Take to a day (`today` for today's) or a week. */
export function takeTicket(data: ItemViewData, to: string, onDeck: boolean): TicketAnswer {
    return { kind: "take", to, label: takeLabel(data, to), onDeck };
}

/**
 * The day's server `load` moved by the change in each figure between its own rows and `tasks`,
 * with `over`, `overMinutes` and `overWith` worked again; the server's own `load` when nothing changed.
 */
function withLoad(day: { tasks: ViewTask[]; load: DayLoad }, tasks: RedrawnTask[]): RedrawnDay {
    const [ was, now ] = [ countOf(day.tasks), countOf(tasks.filter((t) => !t.leaving)) ];
    if (FIGURES.every((figure) => was[figure] === now[figure])) {
        return { tasks, load: day.load };
    }
    const { load: before } = day;
    const load = dayLoad({
        foundation: before.foundation.minutes + now.foundation - was.foundation,
        onDeck: before.onDeck.minutes + now.onDeck - was.onDeck,
        growth: before.growth.minutes + now.growth - was.growth,
        recharge: before.recharge.count + now.recharge - was.recharge
    }, { focus: before.foundation.focus, growthTarget: before.growth.target });
    return { tasks, load };
}

/** The four figures `dayLoad` takes, counted from rows: Foundation, On deck and Growth minutes, and the Recharge things on the list. */
function countOf(tasks: ViewTask[]): Record<(typeof FIGURES)[number], number> {
    const list = tasks.filter((t) => t.place === "list");
    const onDeck = tasks.filter((t) => t.place === "onDeck");
    return {
        foundation: liveMinutes(list, "foundation"),
        onDeck: liveMinutes(onDeck, "foundation"),
        growth: liveMinutes(list, "growth"),
        recharge: list.filter((t) => !t.parent && t.area === "recharge" && isLive(t)).length
    };
}

const FIGURES = [ "foundation", "onDeck", "growth", "recharge" ] as const;

/**
 * Rows with their taps applied: the estimate and area on the row itself, and its fate on the row
 * and its sub-items, which move with it wherever they are listed. A block tap on an On deck row
 * brings it onto the list.
 */
export function redrawRows(tasks: ViewTask[], answers: ViewAnswers): RedrawnTask[] {
    const own = new Map(tasks.flatMap((task) => {
        const fate = answers.rows?.[rowKey(task)]?.fate;
        return fate ? [ [ rowKey(task), fate ] as const ] : [];
    }));
    const parents = new Map(tasks.map((task) => [ rowKey(task), task.parentListItemId ? rowKey({ noteId: task.noteId, listItemId: task.parentListItemId }) : null ]));
    const fateOf = (key: string): ViewFate | undefined => {
        const seen = new Set<string>();
        for (let at: string | null | undefined = key; at && !seen.has(at); at = parents.get(at)) {
            seen.add(at);
            const fate = own.get(at);
            if (fate) {
                return fate;
            }
        }
        return undefined;
    };
    return tasks.map((task) => {
        const answer = answers.rows?.[rowKey(task)];
        const fate = fateOf(rowKey(task));
        const moved: RedrawnTask = {
            ...task,
            estMinutes: answer?.estimate ?? task.estMinutes,
            area: answer?.area ?? task.area,
            leaving: !!fate && LEAVING.has(fate.kind),
            ...(fate ? { fate } : {})
        };
        if (fate?.kind === "block") {
            return { ...moved, block: fate.block, section: BLOCK_NAMES[fate.block], place: "list" };
        }
        if (fate?.kind === "onDeck" || fate?.kind === "list") {
            return { ...moved, place: fate.kind };
        }
        return moved;
    });
}

/** A run of the Day view's rows under one heading, with the `TaskRow` variant its rows take. */
export interface DayGroup {
    name: string;
    variant: "critical" | "list" | "onDeck";
    tasks: RedrawnTask[];
}

/**
 * The Day view's rows under their headings: Important, Morning, Afternoon, Evening, The list (no
 * block) and On deck, empty ones left out. A sub-item follows its parent, whatever its own block.
 */
export function dayGroups(tasks: RedrawnTask[]): DayGroup[] {
    const keys = new Set(tasks.map(rowKey));
    const parentOf = (task: RedrawnTask) => task.parentListItemId ? rowKey({ noteId: task.noteId, listItemId: task.parentListItemId }) : null;
    const isSub = (task: RedrawnTask) => {
        const parent = parentOf(task);
        return parent !== null && keys.has(parent);
    };
    const groups: DayGroup[] = [
        { name: "Important", variant: "critical", tasks: [] },
        ...(Object.keys(BLOCK_NAMES) as Block[]).map((block): DayGroup => ({ name: BLOCK_NAMES[block], variant: "list", tasks: [] })),
        { name: "The list", variant: "list", tasks: [] },
        { name: "On deck", variant: "onDeck", tasks: [] }
    ];
    const groupOf = (task: RedrawnTask) => {
        if (task.place === "onDeck") {
            return groups[5];
        }
        if (task.critical) {
            return groups[0];
        }
        return task.block ? groups[1 + Object.keys(BLOCK_NAMES).indexOf(task.block)] : groups[4];
    };
    const withSubs = (task: RedrawnTask): RedrawnTask[] => [ task, ...tasks.filter((t) => parentOf(t) === rowKey(task)).flatMap(withSubs) ];
    for (const task of tasks.filter((t) => !isSub(t))) {
        groupOf(task).tasks.push(...withSubs(task));
    }
    return groups.filter((group) => group.tasks.length);
}

/** Whether a live sub-item on the task's note names it as its parent; the server sets no estimate on such a task. */
export function hasLiveSubItems(task: ViewTask, tasks: ViewTask[]): boolean {
    return tasks.some((t) => t.noteId === task.noteId && t.parentListItemId === task.listItemId && isLive(t));
}

/**
 * The `renderDayTerrain` input for a Day view's redrawn rows, as the server's `workBlocks` lays the
 * day out: the live top-level rows on the list that stay, in the brief's groups, around the timed
 * meetings. `unplacedMinutes` is the work that doesn't fit before bedtime.
 */
export function dayTerrain(data: DayViewData, tasks: RedrawnTask[]): { input: TerrainInput; unplacedMinutes: number } {
    const meetings = data.meetings.filter((m) => !m.allDay);
    const work = tasks
        .filter((t) => !t.leaving && t.place === "list" && !t.parent && isLive(t))
        .map((t) => ({
            id: t.listItemId, section: t.section ?? null, critical: t.critical,
            label: bareText(t.text), minutes: t.estMinutes ?? DEFAULT_ESTIMATE, block: t.block, area: t.area, at: t.at
        }));
    const groups = groupTasks(work, data.drawn?.groups).map((group) => ({ name: group.name, important: group.important, tasks: group.tasks }));
    const { span } = data;
    const laid = layoutGroups({ start: span.start, end: span.end, workEnd: span.workEnd, noon: span.noon }, meetings, groups);
    // A meeting before standup stretches the drawing back to its hour; work is still laid from standup.
    const start = clockMinutes(span.start) ?? 600;
    const earliest = Math.min(start, ...meetings.map((m) => clockMinutes(m.start) ?? start));
    return {
        input: {
            start: hhmm(earliest < start ? Math.floor(earliest / 60) * 60 : start),
            end: span.end,
            events: meetings.map((m) => ({ start: m.start, end: m.end, title: meetingName(m.title, data.drawn?.meetings) })),
            groups: laid.groups
        },
        unplacedMinutes: laid.unplaced.reduce((n, u) => n + u.minutes, 0)
    };
}

/** A row's key in `ViewAnswers`: Days holds rows of several notes. */
export function rowKey(task: Pick<ViewTask, "noteId" | "listItemId">) {
    return `${task.noteId}/${task.listItemId}`;
}

/** The fate's short words for a chip and the pill: `Afternoon`, `Mon · On deck`, `Week 46`, `Drop: not needed`. */
export function fateLabel(fate: ViewFate): string {
    switch (fate.kind) {
        case "block": return BLOCK_NAMES[fate.block];
        case "onDeck": return "On deck";
        case "list": return "On the list";
        case "day": return chipLabel({ kind: "day", label: fate.label, onDeck: fate.onDeck }, undefined);
        case "week": return fate.label;
        case "park": return `Park · ${fate.label}`;
        case "done": return "Done";
        case "drop": return fate.reason.trim() ? `Drop: ${fate.reason.trim()}` : "Drop";
    }
}

/** Whether two fates send a row to the same place, for the menu's check: a day whichever list, a drop whatever its reason. */
export function sameFate(a: ViewFate | undefined, b: ViewFate | undefined) {
    if (!a || !b || a.kind !== b.kind) {
        return false;
    }
    switch (a.kind) {
        case "block": return b.kind === "block" && a.block === b.block;
        case "day": return b.kind === "day" && a.date === b.date;
        case "week": return b.kind === "week" && a.week === b.week;
        case "park": return b.kind === "park" && a.month === b.month;
        default: return true;
    }
}

/** One line of the fate menu. A line with `ask` has no fate until the menu has asked why (Drop) or which day. */
export interface FateChoice {
    label: string;
    detail?: string;
    fate?: ViewFate;
    ask?: "reason" | "date";
}

/**
 * The fate menu's lines for a row: Done; the blocks and On deck or the list (a row on a day, not Important);
 * the next workday and the shown days, each On deck unless the list is picked; a day picker; the
 * week (a row not on it); Park (Slipping); Drop.
 */
export function fateChoices(task: ViewTask, where: { nextWorkday?: string; days?: string[]; week?: string; parkMonth?: string }): FateChoice[] {
    const onDay = task.period.kind === "day";
    // `caius_place` moves no Important task, so an Important row offers no block and no On deck.
    // A sub-item moves with its parent, so it offers no block, On deck or list move either.
    const placed = onDay && !task.critical && !task.parent;
    const day = (date: string, detail?: string): FateChoice => ({ label: dayLabel(date), detail, fate: { kind: "day", date, label: dayLabel(date), onDeck: true } });
    const days = (where.days ?? []).filter((date) => !(onDay && date === task.period.key) && date !== where.nextWorkday);
    const week = where.week && !(task.period.kind === "week" && task.period.key === where.week) ? where.week : undefined;
    const [ weekName, weekRange ] = week ? weekLabel(week).split(" · ") : [];
    return [
        { label: "Done", fate: { kind: "done" } },
        ...(placed ? (Object.keys(BLOCK_NAMES) as Block[]).map((block): FateChoice => ({ label: BLOCK_NAMES[block], fate: { kind: "block", block } })) : []),
        ...(placed ? [ task.place === "onDeck" ? { label: "Onto the list", fate: { kind: "list" } as const } : { label: "On deck", fate: { kind: "onDeck" } as const } ] : []),
        ...(where.nextWorkday && !(onDay && where.nextWorkday === task.period.key) ? [ day(where.nextWorkday, "next workday") ] : []),
        ...days.map((date) => day(date)),
        { label: "A day…", ask: "date" },
        ...(week && weekName ? [ { label: weekName, detail: weekRange, fate: { kind: "week", week, label: weekName } as const } ] : []),
        ...(where.parkMonth ? [ { label: "Park", detail: monthLabel(where.parkMonth), fate: { kind: "park", month: where.parkMonth, label: monthLabel(where.parkMonth) } as const } ] : []),
        { label: "Drop…", ask: "reason" }
    ];
}

/** The fate a row stands at with no tap: its block, for a row on the list. */
export function standingFate(task: ViewTask): ViewFate | undefined {
    return task.place === "list" && task.block ? { kind: "block", block: task.block } : undefined;
}

/** Whether the task is live: open or in progress, with words. */
function isLive(task: Pick<ViewTask, "state" | "text">) {
    return (task.state === "open" || task.state === "in_progress") && task.text.trim() !== "";
}

const LEAVING = new Set<ViewFate["kind"]>([ "done", "day", "week", "park", "drop" ]);

const BLOCK_NAMES: Record<Block, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };

export const AREA_NAMES: Record<Area, string> = { foundation: "Foundation", growth: "Growth", recharge: "Recharge" };

function rowsOf(view: ShownView): ViewTask[] {
    switch (view.view) {
        case "day": return view.data.tasks ?? [];
        case "days": return [ ...(view.data.days ?? []).flatMap((d) => d.tasks ?? []), ...(view.data.week?.tasks ?? []) ];
        case "item": return view.data.task ? [ view.data.task ] : [];
        case "slipping": return view.data.tasks ?? [];
    }
}

/** The ticket an Item view offers to take: one no task names. */
function ticketKeysOf(view: ShownView): string[] {
    return view.view === "item" && !view.data.task && view.data.ticket ? [ view.data.ticket.key ] : [];
}

function leadOf(view: ShownView) {
    return view.view === "day" ? `From the day view of ${view.data.dateLabel}` : `From the ${view.view} view`;
}

function fatePhrase(fate: Exclude<ViewFate, { kind: "drop" }>): string {
    switch (fate.kind) {
        case "block": return `goes in the ${fate.block}`;
        case "onDeck": return "goes On deck";
        case "list": return "goes on the list";
        case "day": return `goes on ${fate.label}'s ${fate.onDeck ? "On deck" : "list"} (${fate.date})`;
        case "week": return `${choicePhrase({ kind: "period", label: fate.label }, null)} (${fate.week})`;
        case "park": return `${choicePhrase({ kind: "period", label: fate.label }, null)} (${fate.month})`;
        case "done": return choicePhrase({ kind: "done" }, null);
    }
}

function ticketPhrase(key: string, answer: TicketAnswer) {
    if (answer.kind === "finished") {
        return `${key} is finished`;
    }
    return isDayKey(answer.to) ? `Take ${key} to ${answer.label}'s ${answer.onDeck ? "On deck" : "list"} (${answer.to})` : `Take ${key} to ${answer.label} (${answer.to})`;
}

function ticketLabel(answer: TicketAnswer) {
    if (answer.kind === "finished") {
        return "Finished";
    }
    return isDayKey(answer.to) ? `Take: ${answer.label} · ${answer.onDeck ? "On deck" : "list"}` : `Take: ${answer.label}`;
}

/** `30 minutes`, `1 hour`, `1 hour 30 minutes`, `2 hours`. */
function minutesWords(minutes: number) {
    const [ h, m ] = [ Math.floor(minutes / 60), Math.round(minutes % 60) ];
    const hours = h ? `${h} ${h === 1 ? "hour" : "hours"}` : "";
    const rest = m ? `${m} ${m === 1 ? "minute" : "minutes"}` : "";
    return [ hours, rest ].filter(Boolean).join(" ") || "0 minutes";
}

function takeLabel(data: ItemViewData, to: string) {
    if (to === data.today) {
        return "today";
    }
    return isDayKey(to) ? dayLabel(to) : weekLabel(to).split(" · ")[0];
}

function isDayKey(key: string) {
    return /^\d{4}-\d{2}-\d{2}$/.test(key);
}
