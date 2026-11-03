import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import { type DayLoad, dayLoad, liveMinutes } from "@triliumnext/caius/src/daily/load.js";
import type { ShownView, ViewName, ViewTask } from "@triliumnext/caius/src/daily/views.js";
import type { Area, Block } from "@triliumnext/caius/src/trilium/areas.js";

import { displayText } from "../components/TaskRow.js";
import { type ToolCall, parseResult } from "./chat.js";
import { dayLabel, monthLabel, weekLabel } from "./day.js";
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

/** A row as it would stand after the taps; `leaving` when a tap takes it (or its parent) off the day. */
export interface RedrawnTask extends ViewTask {
    leaving: boolean;
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
 * happens to it; a row with a fate and an estimate gives a clause for each. No taps, no sentence.
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
 * applied and its meters worked again by `dayLoad`, against the focus and Growth target it came with.
 */
export function redraw(view: ShownView, answers: ViewAnswers): RedrawnDay[] {
    switch (view.view) {
        case "day":
            return [ redrawDay(view.data, answers) ];
        case "days":
            return view.data.days.map((day) => redrawDay(day, answers));
        default:
            return [];
    }
}

/** One day's rows and load after the taps. A leaving row stays in `tasks`, so the view can strike it through. */
export function redrawDay(day: { tasks: ViewTask[]; load: DayLoad }, answers: ViewAnswers): RedrawnDay {
    const tasks = redrawRows(day.tasks, answers);
    const staying = tasks.filter((t) => !t.leaving);
    const list = staying.filter((t) => t.place === "list");
    const onDeck = staying.filter((t) => t.place === "onDeck");
    const load = dayLoad({
        foundation: liveMinutes(list, "foundation"),
        onDeck: liveMinutes(onDeck, "foundation"),
        growth: liveMinutes(list, "growth"),
        recharge: list.filter((t) => !t.parent && t.area === "recharge" && isLive(t)).length
    }, { focus: day.load.foundation.focus, growthTarget: day.load.growth.target });
    return { tasks, load };
}

/**
 * Rows with their taps applied: the estimate and area on the row itself, and its fate on the row
 * and its sub-items, which move with it. A block tap on an On deck row brings it onto the list.
 */
export function redrawRows(tasks: ViewTask[], answers: ViewAnswers): RedrawnTask[] {
    const fates = new Map<string, ViewFate>();
    for (const task of tasks) {
        const own = answers.rows?.[rowKey(task)]?.fate;
        const parent = task.parentListItemId ? fates.get(rowKey({ noteId: task.noteId, listItemId: task.parentListItemId })) : undefined;
        const fate = own ?? parent;
        if (fate) {
            fates.set(rowKey(task), fate);
        }
    }
    return tasks.map((task) => {
        const answer = answers.rows?.[rowKey(task)];
        const fate = fates.get(rowKey(task));
        const moved: RedrawnTask = {
            ...task,
            estMinutes: answer?.estimate ?? task.estMinutes,
            area: answer?.area ?? task.area,
            leaving: !!fate && LEAVING.has(fate.kind)
        };
        if (fate?.kind === "block") {
            return { ...moved, block: fate.block, place: "list" };
        }
        if (fate?.kind === "onDeck" || fate?.kind === "list") {
            return { ...moved, place: fate.kind };
        }
        return moved;
    });
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
 * The fate menu's lines for a row: Done; the blocks and On deck or the list (a row on a day);
 * the next workday and the shown days, each On deck unless the list is picked; a day picker; the
 * week (a row not on it); Park (Slipping); Drop.
 */
export function fateChoices(task: ViewTask, where: { nextWorkday?: string; days?: string[]; week?: string; parkMonth?: string }): FateChoice[] {
    const onDay = task.period.kind === "day";
    const day = (date: string, detail?: string): FateChoice => ({ label: dayLabel(date), detail, fate: { kind: "day", date, label: dayLabel(date), onDeck: true } });
    const days = (where.days ?? []).filter((date) => !(onDay && date === task.period.key) && date !== where.nextWorkday);
    const week = where.week && !(task.period.kind === "week" && task.period.key === where.week) ? where.week : undefined;
    const [ weekName, weekRange ] = week ? weekLabel(week).split(" · ") : [];
    return [
        { label: "Done", fate: { kind: "done" } },
        ...(onDay ? (Object.keys(BLOCK_NAMES) as Block[]).map((block): FateChoice => ({ label: BLOCK_NAMES[block], fate: { kind: "block", block } })) : []),
        ...(onDay ? [ task.place === "onDeck" ? { label: "Onto the list", fate: { kind: "list" } as const } : { label: "On deck", fate: { kind: "onDeck" } as const } ] : []),
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
        case "day": return `goes on ${fate.label}'s ${fate.onDeck ? "On deck" : "list"}`;
        case "week": return choicePhrase({ kind: "period", label: fate.label }, null);
        case "park": return choicePhrase({ kind: "period", label: fate.label }, null);
        case "done": return choicePhrase({ kind: "done" }, null);
    }
}

function ticketPhrase(key: string, answer: TicketAnswer) {
    if (answer.kind === "finished") {
        return `${key} is finished`;
    }
    return isDayKey(answer.to) ? `Take ${key} to ${answer.label}'s ${answer.onDeck ? "On deck" : "list"}` : `Take ${key} to ${answer.label}`;
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

function isDayKey(key: string) {
    return /^\d{4}-\d{2}-\d{2}$/.test(key);
}
