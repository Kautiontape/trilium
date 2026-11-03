/**
 * The views `caius_show` answers (`ShownView`): a day, several days, one task or ticket, and what
 * keeps slipping. They read the day read (`readDay`, `readDays`), the trail and the ticket read, so
 * a view's figures are the ones the steps and `caius_plan` give.
 */

import {
    bareText,
    CLOSED_DAYS,
    type ContextEntry,
    type DaysViewData,
    type DayViewData,
    daysLate,
    DISMISSED_LABEL,
    FINISHED_DAYS,
    FINISHED_LABEL,
    formatHours,
    gatherContext,
    isoWeekKey,
    isPeriodKey,
    type ItemViewData,
    keysOf,
    label,
    liveKeys,
    loadJournal,
    nextWorkday,
    type NoteStore,
    openTasks,
    type PeriodKind,
    PERIODS,
    periodSpan,
    type PlanTask,
    type PlanView,
    readPlan,
    scanDocs,
    type ShownView,
    type SlippingViewData,
    type StoreNote,
    type TaskOrigin,
    TRILIUM_CONFIG,
    type TriliumDoc,
    type ViewContextLine,
    type ViewTask,
    type ViewTicket,
    type ViewTrailStep
} from "@triliumnext/caius";
import { t } from "i18next";

import { drawnNamesOf, NOT_TODAY_LABEL } from "./brief.js";
import { dateLabel, dayKey, focusText, MAX_REPLY_CHARS, plainText, weekdayName, withoutMoveLinks } from "./daily.js";
import { type DaysDeps, type DayView, readDay, readDays } from "./day-read.js";
import type { TicketCard, TicketError } from "./inputs/jira.js";
import { refOf } from "./refs.js";
import type { ShowInput } from "./schemas.js";
import { periodOf, type Trail, trailOf, trailsOf } from "./trail.js";

/** What the views read through the service: the day read's needs, one ticket by key and a task's origin. */
export interface ViewsDeps extends DaysDeps {
    ticket: (key: string) => Promise<TicketCard | TicketError>;
    origin: (store: NoteStore, noteId: string, listItemId: string) => Promise<TaskOrigin | null>;
}

export type ShowAnswer = ShownView | { error: string; detail: string };

/**
 * The view `input` asks for, as of `now` (the workday's, read before the lock). The frames are read
 * before the lock and the notes under one `caius_show` lock; `readDays` takes its own, and a ticket
 * is read after it. Every row carries its `noteId`, `listItemId` and a `ref` (prefix `v`).
 */
export async function showView(deps: ViewsDeps, input: ShowInput, now: Date): Promise<ShowAnswer> {
    const today = dayKey(now);
    switch (input.view) {
        case "day":
            return dayView(deps, input.date ?? today, input.area ?? null, now);
        case "days":
            return daysView(deps, input.from ?? today, input.count ?? DEFAULT_DAYS, now);
        case "item":
            return itemView(deps, input, now);
        case "slipping":
            return slippingView(deps, input.period ?? null, now);
    }
}

async function dayView(deps: ViewsDeps, date: string, area: DayViewData["openOn"], now: Date): Promise<ShowAnswer> {
    const frame = await deps.dayFrame(date);
    const { day, drawn } = await deps.locked("caius_show", async () => {
        const plan = await readPlan(deps.store, "day", date, now);
        const drawn = await drawnNamesOf(deps.store, date);
        return { day: await readDay(deps.store, frame, plan, { date, now, drawn }), drawn };
    });
    const { load, capacity } = day;
    const { start, noon, workEnd, end } = frame.rhythm;
    const data: DayViewData = {
        date,
        dateLabel: dateLabel(date) ?? date,
        openOn: area ?? (load.foundation.over ? "foundation" : load.growth.over ? "growth" : null),
        load,
        calendarFailed: day.calendarFailed,
        capacity: { windowMinutes: capacity.windowMinutes, bookedMinutes: capacity.bookedMinutes, openMinutes: capacity.openMinutes },
        span: { start, noon, workEnd, end },
        meetings: day.meetings,
        drawn: drawn ? { groups: drawn.groups, meetings: drawn.meetings } : null,
        unplacedMinutes: day.layout.unplaced.reduce((sum, unplaced) => sum + unplaced.minutes, 0),
        tasks: rowsOf(day.plan, day.slips),
        context: contextLines(day.context)
    };
    return capped({ view: "day", title: dayTitle(date), sentence: daySentence(date, day), data }, [ { name: "tasks", rows: data.tasks } ]);
}

async function daysView(deps: ViewsDeps, from: string, count: number, now: Date): Promise<ShowAnswer> {
    if (count < MIN_DAYS || count > MAX_DAYS) {
        return { error: "bad_request", detail: `count is ${count}; give ${MIN_DAYS} to ${MAX_DAYS} days` };
    }
    const read = await readDays(deps, from, count, now);
    const { key } = read.week;
    const data: DaysViewData = {
        from,
        days: read.days.map(({ date, workday, day }) => ({
            date, dateLabel: dateLabel(date) ?? date, workday, meetingMinutes: day.capacity.bookedMinutes,
            load: day.load, calendarFailed: day.calendarFailed, tasks: rowsOf(day.plan, day.slips)
        })),
        week: {
            key,
            label: t("caius.views.days.week", { week: Number(key.slice(6)) }),
            tasks: read.week.tasks.flatMap((task) => task.listItemId
                ? [ viewTask(task, task.listItemId, { kind: "week", key }, "list", read.week.slips[task.listItemId] ?? 0) ]
                : []),
            foundation: { minutes: read.week.foundation.minutes, target: read.week.foundation.target ?? { min: 0, max: 0 } }
        }
    };
    const first = data.days[0]?.dateLabel ?? from;
    const last = data.days.at(-1)?.dateLabel ?? from;
    const sentence = `${[ ...read.days.map(({ date, day }) => dayGist(date, day)), weekGist(data.week) ].join("; ")}.`;
    return capped(
        { view: "days", title: t("caius.views.days.title", { first, last }), sentence, data },
        [ ...data.days.map((day) => ({ name: day.date, rows: day.tasks })), { name: "week", rows: data.week.tasks } ]
    );
}

async function itemView(deps: ViewsDeps, input: ShowInput, now: Date): Promise<ShowAnswer> {
    const asked = input.key?.trim().toUpperCase();
    if (asked !== undefined && !JIRA_KEY.test(asked)) {
        return { error: "bad_request", detail: `"${input.key}" is not a ticket key such as ZAP-101` };
    }
    if (!input.item && asked === undefined) {
        return { error: "bad_request", detail: "The item view takes item ({ noteId, listItemId }) or key" };
    }
    const today = dayKey(now);
    const found = await deps.locked("caius_show", async () => {
        const { docs } = await loadJournal(deps.store);
        const where = input.item ?? (asked ? taskNaming(docs, asked, now) : null);
        const row = where ? await planRowOf(deps.store, docs, where, now) : null;
        if (input.item && !row) return null;
        const key = asked ?? (row ? ticketKeyOf(row.task.text) : undefined);
        const trail = row ? trailOf(trailsOf(docs, now), row.task) : undefined;
        return {
            row, trail, key,
            origin: row ? await deps.origin(deps.store, row.task.noteId, row.listItemId) : null,
            context: key ? contextLines((await gatherContext(deps.store, today)).context.filter((line) => keysOf(line.text).includes(key))) : [],
            dispositions: key ? await dispositionsOf(deps.store, key, today) : []
        };
    });
    if (!found) {
        return { error: "not_found", detail: `No task ${input.item?.listItemId} on a list or On deck of note ${input.item?.noteId}` };
    }
    const { row, trail, key } = found;
    const card = key ? await deps.ticket(key) : null;
    const ticket = key && card ? viewTicket(key, card) : null;
    const task = row ? viewTask(row.task, row.listItemId, row.period, row.place, trail?.slips ?? 0) : null;
    if (task?.ticket && ticket && !("error" in ticket) && task.ticket.key === ticket.key) task.ticket.status = ticket.status;
    const data: ItemViewData = {
        task,
        trail: (trail?.copies ?? []).map((copy): ViewTrailStep => ({
            period: { kind: copy.kind, key: copy.period }, label: dateLabel(copy.period) ?? copy.period, movedOn: copy.movedOn, state: copy.state
        })),
        origin: found.origin,
        ticket,
        context: found.context,
        dispositions: found.dispositions,
        today,
        nextWorkday: dayKey(nextWorkday(now)),
        week: isoWeekKey(new Date(`${today}T00:00:00Z`))
    };
    const title = task ? wordsOf(task.text) : ticket && !("error" in ticket) ? `${ticket.key} ${ticket.summary}` : key ?? "";
    const sentence = [ task ? taskGist(task, data.trail) : null, ticket ? ticketGist(ticket) : null ].filter((part) => part !== null).join(" ");
    return { view: "item", title, sentence, data };
}

async function slippingView(deps: ViewsDeps, period: string | null, now: Date): Promise<ShowAnswer> {
    const kind = period === null ? null : periodKind(period);
    if (period !== null && !kind) {
        return { error: "bad_request", detail: `"${period}" is not a day, week or month such as 2026-11-03, 2026-W45 or 2026-11` };
    }
    const within = period !== null && kind ? periodSpan(kind, period) : null;
    const today = dayKey(now);
    const { rows, total, overdue } = await deps.locked("caius_show", async () => {
        const { docs } = await loadJournal(deps.store);
        const scan = scanDocs(docs, TRILIUM_CONFIG, now);
        const open = openTasks(docs, scan);
        const all = trailsOf(docs, now, scan);
        const slipping = open
            .filter((task) => task.parent === null && task.listItemId)
            .flatMap((task) => {
                const trail = trailOf(all, task);
                return trail && trail.slips >= MIN_SLIPS && (!within || movedWithin(trail, within)) ? [ { task, trail } ] : [];
            })
            .sort((a, b) => b.trail.slips - a.trail.slips);
        // Only a task on its period's list or On deck can be a row, so only those are counted.
        const placedRows: ViewTask[] = [];
        const plans = new Map<string, PlanView>();
        for (const { task, trail } of slipping) {
            const where = periodOf(task.path);
            if (!where || !task.listItemId) continue;
            const planKey = `${where.kind}:${where.period}`;
            const plan = plans.get(planKey) ?? await readPlan(deps.store, where.kind, where.period, now);
            plans.set(planKey, plan);
            const placed = placedIn(plan, task.listItemId);
            if (placed) placedRows.push(viewTask(placed.task, task.listItemId, { kind: where.kind, key: where.period }, placed.place, trail.slips));
        }
        const ages = open.filter((task) => task.horizon === "overdue").map((task) => daysLate(task.period, now) ?? 0);
        return {
            rows: placedRows.slice(0, SLIPPING_ROWS),
            total: placedRows.length,
            overdue: {
                underWeek: ages.filter((age) => age < 7).length,
                oneToTwoWeeks: ages.filter((age) => age >= 7 && age < 14).length,
                older: ages.filter((age) => age >= 14).length
            }
        };
    });
    const data: SlippingViewData = { tasks: rows, overdue, parkMonth: today.slice(0, 7) };
    const overdueCount = overdue.underWeek + overdue.oneToTwoWeeks + overdue.older;
    const sentence = [
        total ? t("caius.views.slipping.slipping", { count: total, moves: rows[0]?.slips ?? MIN_SLIPS }) : t("caius.views.slipping.none"),
        overdueCount ? t("caius.views.slipping.overdue", { count: overdueCount }) : t("caius.views.slipping.overdue_none")
    ].join(" ");
    const omitted: Record<string, number> | undefined = total > rows.length ? { tasks: total - rows.length } : undefined;
    return capped({ view: "slipping", title: t("caius.views.slipping.title"), sentence, data }, [ { name: "tasks", rows: data.tasks } ], omitted);
}

const DEFAULT_DAYS = 5;
const MIN_DAYS = 2;
const MAX_DAYS = 7;
/** Moves off day notes from which a task counts as slipping. */
const MIN_SLIPS = 2;
const SLIPPING_ROWS = 30;
/** Room kept for the `omitted` counts a capped reply adds. */
const OMITTED_ROOM = 300;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const ESTIMATE = /\s+~\d+(?:h\d*m?|m)\b/g;

/**
 * A plan's live rows with ids: the Important block, the list in order and On deck, each sub-item
 * after its parent. They hold every task `liveMinutes` counts, so the phone's recount matches `load`.
 */
function rowsOf(plan: PlanView, slips: Record<string, number>): ViewTask[] {
    const period = { kind: plan.period, key: plan.key };
    const placed = [
        ...[ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ].map((task) => ({ task, place: "list" as const })),
        ...plan.onDeck.map((task) => ({ task, place: "onDeck" as const }))
    ];
    return inParentOrder(placed.flatMap(({ task, place }) => task.listItemId && isLive(task)
        ? [ viewTask(task, task.listItemId, period, place, slips[task.listItemId] ?? 0) ]
        : []));
}

function viewTask(task: PlanTask, listItemId: string, period: ViewTask["period"], place: ViewTask["place"], slips: number): ViewTask {
    const { noteId, state, text, estMinutes, parent, parentListItemId, section, critical, area, block, at } = task;
    const key = ticketKeyOf(text);
    return {
        noteId, listItemId, ref: refOf("v", listItemId), state, text, estMinutes, parent, parentListItemId, section, critical, area, block, at,
        period, place, slips, ...(key ? { ticket: { key } } : {})
    };
}

/** `rows` with each sub-item moved right after its parent, when its parent is a row too. */
function inParentOrder(rows: ViewTask[]): ViewTask[] {
    const ids = new Set(rows.map((row) => row.listItemId));
    const ordered: ViewTask[] = [];
    const seen = new Set<string>();
    const add = (row: ViewTask) => {
        if (seen.has(row.listItemId)) return;
        seen.add(row.listItemId);
        ordered.push(row);
        for (const sub of rows.filter((other) => other.parentListItemId === row.listItemId)) add(sub);
    };
    for (const row of rows.filter((r) => !r.parentListItemId || !ids.has(r.parentListItemId))) add(row);
    return ordered;
}

/** The task `listItemId` on a plan's list or On deck, with where it sits; null when it is on neither. */
function placedIn(plan: PlanView, listItemId: string): { task: PlanTask; place: ViewTask["place"] } | null {
    const onList = [ ...plan.critical, ...plan.sections.flatMap((section) => section.tasks) ].find((task) => task.listItemId === listItemId);
    if (onList) return { task: onList, place: "list" };
    const onDeck = plan.onDeck.find((task) => task.listItemId === listItemId);
    return onDeck ? { task: onDeck, place: "onDeck" } : null;
}

/** The task `where` names, read from its period note's plan. The caller holds the lock. */
async function planRowOf(store: NoteStore, docs: TriliumDoc[], where: { noteId: string; listItemId: string }, now: Date) {
    const doc = docs.find((d) => d.noteId === where.noteId);
    const period = doc ? periodOf(doc.path) : null;
    if (!period) return null;
    const placed = placedIn(await readPlan(store, period.kind, period.period, now), where.listItemId);
    return placed ? { ...placed, listItemId: where.listItemId, period: { kind: period.kind, key: period.period } } : null;
}

/** The live task that names `key`, the one in the latest period when several do. */
function taskNaming(docs: TriliumDoc[], key: string, now: Date): { noteId: string; listItemId: string } | null {
    const paths = new Map(docs.map((doc) => [ doc.noteId, doc.path ]));
    const startOf = (noteId: string) => {
        const period = periodOf(paths.get(noteId) ?? "");
        return period ? periodSpan(period.kind, period.period).start : "";
    };
    const refs = (liveKeys(docs, now).get(key) ?? [])
        .map((ref) => ref.split("/"))
        .flatMap(([ noteId, listItemId ]) => noteId && listItemId ? [ { noteId, listItemId } ] : [])
        .sort((a, b) => startOf(a.noteId).localeCompare(startOf(b.noteId)));
    return refs.at(-1) ?? null;
}

/** The first ticket key a task's text names, if any. */
function ticketKeyOf(text: string): string | undefined {
    return keysOf(text).find((key) => JIRA_KEY.test(key));
}

function isLive(task: PlanTask): boolean {
    return (task.state === "open" || task.state === "in_progress") && task.text.trim() !== "";
}

function contextLines(lines: ContextEntry[]): ViewContextLine[] {
    return lines.map((line) => ({ text: line.text, ...(line.until ? { until: line.until, untilLabel: dateLabel(line.until) ?? line.until } : {}) }));
}

/**
 * What was said about `key` that still holds on `today`: dismissed (`CLOSED_DAYS` after its note's
 * period), finished (`FINISHED_DAYS`) and not today (that day), each with its latest end. The caller holds the lock.
 */
async function dispositionsOf(store: NoteStore, key: string, today: string): Promise<ItemViewData["dispositions"]> {
    const kinds = [ [ "dismissed", DISMISSED_LABEL, CLOSED_DAYS ], [ "finished", FINISHED_LABEL, FINISHED_DAYS ], [ "not_today", NOT_TODAY_LABEL, 0 ] ] as const;
    const out: ItemViewData["dispositions"] = [];
    for (const [ kind, name, days ] of kinds) {
        const ends = (await store.search(`#${name}`))
            .filter((note) => note.attributes.some((a) => a.type === "label" && a.name === name && a.value === key))
            .flatMap((note) => {
                const period = notePeriod(note);
                return period ? [ addDays(periodSpan(period.kind, period.key).end, days) ] : [];
            })
            .filter((until) => until >= today)
            .sort();
        const until = ends.at(-1);
        if (until) out.push({ kind, until });
    }
    return out;
}

function notePeriod(note: StoreNote): { kind: PeriodKind; key: string } | null {
    for (const kind of [ "day", "week", "month" ] as const) {
        const key = label(note, PERIODS[kind].label);
        if (key && PERIODS[kind].pattern.test(key)) return { kind, key };
    }
    return null;
}

function periodKind(key: string): PeriodKind | null {
    return ([ "day", "week", "month" ] as const).find((kind) => isPeriodKey(kind, key)) ?? null;
}

function movedWithin(trail: Trail, span: { start: string; end: string }): boolean {
    return trail.copies.some((copy) => copy.movedOn && copy.kind === "day" && copy.period >= span.start && copy.period <= span.end);
}

function viewTicket(key: string, card: TicketCard | TicketError): ViewTicket | { key: string; error: string } {
    if ("error" in card) return { key, error: card.error };
    const latest = card.asks.reduce<TicketCard["asks"][number] | undefined>((a, b) => !a || Date.parse(b.created) >= Date.parse(a.created) ? b : a, undefined);
    return {
        key: card.key, summary: card.summary, status: card.status, daysInStatus: card.daysInStatus, assignee: card.assignee,
        url: card.url, done: card.done, lastComment: card.lastComment,
        ask: latest ? { author: latest.author, created: latest.created, excerpt: latest.excerpt } : null
    };
}

/**
 * `reply` with rows taken off the end of its longest lists until its JSON is at most
 * `MAX_REPLY_CHARS`, and `data.omitted` counting what each list lost, with `omitted` given. A
 * sub-item goes with its parent and the parent's other sub-items (`familyOf`), so no row a list
 * keeps has lost a sub-item.
 */
function capped<R extends ShownView>(reply: R, lists: { name: string; rows: ViewTask[] }[], omitted: Record<string, number> = {}): R {
    let size = JSON.stringify(reply).length + OMITTED_ROOM;
    while (size > MAX_REPLY_CHARS) {
        const longest = lists.reduce<(typeof lists)[number] | undefined>((a, b) => b.rows.length > (a?.rows.length ?? 0) ? b : a, undefined);
        const last = longest?.rows.at(-1);
        if (!longest || !last) break;
        const cut = familyOf(longest.rows, last);
        longest.rows.splice(0, longest.rows.length, ...longest.rows.filter((row) => !cut.has(row)));
        for (const row of cut) size -= JSON.stringify(row).length + 1;
        omitted[longest.name] = (omitted[longest.name] ?? 0) + cut.size;
    }
    return Object.keys(omitted).length ? { ...reply, data: { ...reply.data, omitted } } : reply;
}

/** `row`'s topmost ancestor among `rows` and every row under that ancestor, `row` included. */
function familyOf(rows: ViewTask[], row: ViewTask): Set<ViewTask> {
    const byId = new Map(rows.map((r) => [ r.listItemId, r ]));
    let top = row;
    const climbed = new Set([ row ]);
    for (let up = byId.get(row.parentListItemId ?? ""); up && !climbed.has(up); up = byId.get(up.parentListItemId ?? "")) {
        climbed.add(up);
        top = up;
    }
    const family = new Set([ top ]);
    const ids = new Set([ top.listItemId ]);
    for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) {
            if (!family.has(r) && r.parentListItemId && ids.has(r.parentListItemId)) {
                family.add(r);
                ids.add(r.listItemId);
                grew = true;
            }
        }
    }
    return family;
}

/** "Tuesday 3 Nov". */
function dayTitle(date: string): string {
    const at = new Date(`${date}T00:00:00Z`);
    return t("caius.views.day.title", { weekday: weekdayName(date), day: at.getUTCDate(), month: t(`caius.short.months.${MONTHS[at.getUTCMonth()]}`) });
}

/** The Day view's figures in one line: Foundation against the focus, On deck, Growth and Recharge. */
function daySentence(date: string, day: DayView): string {
    const { foundation, onDeck, growth, recharge } = day.load;
    const words = {
        day: weekdayName(date), minutes: formatHours(foundation.minutes), focus: focusText(foundation.focus), over: formatHours(foundation.overMinutes),
        deck: formatHours(onDeck.minutes), growth: formatHours(growth.minutes), target: focusText(growth.target)
    };
    const work = foundation.minutes ? (foundation.over ? "foundation_over" : "foundation") : "foundation_empty";
    const parts = [
        t(`caius.views.day.${work}`, words),
        ...(onDeck.minutes ? [ t("caius.views.day.deck", words) ] : []),
        t(`caius.views.day.${growth.minutes ? (growth.over ? "growth_over" : "growth") : "growth_empty"}`, words),
        recharge.count ? t("caius.views.day.recharge", { count: recharge.count }) : t("caius.views.day.recharge_none"),
        ...(day.calendarFailed ? [ t("caius.views.day.calendar_failed") ] : [])
    ];
    return `${parts.join("; ")}.`;
}

/** One day of Days in a few words: "Mon 2 h of 3–4 h", "Tue over by 30 m". */
function dayGist(date: string, day: DayView): string {
    const { foundation } = day.load;
    const words = { day: t(`caius.short.weekdays.${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}`), minutes: formatHours(foundation.minutes), focus: focusText(foundation.focus), over: formatHours(foundation.overMinutes) };
    return t(`caius.views.days.${foundation.minutes ? (foundation.over ? "over" : "fits") : "empty"}`, words);
}

function weekGist(week: DaysViewData["week"]): string {
    return t("caius.views.days.week_total", { week: week.label, minutes: formatHours(week.foundation.minutes), target: focusText(week.foundation.target) });
}

/** "Garage shelf: moved on from Mon 2 Nov and Tue 3 Nov; on Wed 4 Nov now." */
function taskGist(task: ViewTask, trail: ViewTrailStep[]): string {
    const moved = trail.filter((step) => step.movedOn).map((step) => step.label);
    const now = dateLabel(task.period.key) ?? task.period.key;
    const words = wordsOf(task.text);
    if (!moved.length) return t("caius.views.item.on", { task: words, now });
    const last = moved.at(-1) ?? "";
    const from = moved.length > 1 ? t("caius.daily.list_and", { head: moved.slice(0, -1).join(", "), last }) : last;
    return t("caius.views.item.moved", { task: words, from, now });
}

/** "ZAP-2640: In Review for 3 days; last comment from Sam." */
function ticketGist(ticket: ViewTicket | { key: string; error: string }): string {
    if ("error" in ticket) return t("caius.views.item.ticket_unread", { key: ticket.key });
    const status = ticket.daysInStatus === null
        ? t("caius.views.item.ticket", { key: ticket.key, status: ticket.status })
        : t("caius.views.item.ticket_days", { key: ticket.key, status: ticket.status, count: ticket.daysInStatus });
    return `${[ status, ...(ticket.lastComment ? [ t("caius.views.item.last_comment", { author: ticket.lastComment.author }) ] : []) ].join("; ")}.`;
}

/** A task's words without its links, area marker, clock or estimate. */
function wordsOf(text: string): string {
    return bareText(plainText(withoutMoveLinks(text))).replace(ESTIMATE, "").trim();
}

function addDays(date: string, days: number): string {
    return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

const WEEKDAYS = [ "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday" ];
const MONTHS = [ "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december" ];
