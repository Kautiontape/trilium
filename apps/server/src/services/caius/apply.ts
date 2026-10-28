/**
 * The apply tools: `caius_plan_apply` and `caius_winddown_apply` make every write of a Plan my day
 * or a Wind down conversation from his answers, in one call. Each answer names an id from the step data, so nothing here builds text
 * from the agent's words except the evening tasks, the Context lines and the brief's prose. Every
 * write is safe to repeat: a second run with the same input changes no note.
 */

import {
    acceptTasks,
    addTasks,
    dayCandidates,
    dismissTasks,
    findPeriodNote,
    forwardTasks,
    keysOf,
    label,
    loadJournal,
    isoWeekKey,
    loadStateSymbols,
    meetingLines,
    moveTasks,
    nextWorkday,
    normName,
    type NoteStore,
    openTasks,
    PERIODS,
    readPlan,
    scanDocs,
    setMeetings,
    setStates,
    takeSuggested,
    TRILIUM_CONFIG,
    weatherOfSvg
} from "@triliumnext/caius";
import { t } from "i18next";

import { ASKED_LABEL, type BriefPick, findBrief, NOT_TODAY_LABEL, redrawHeader, sameTitle, WEATHER_LABEL, WOUND_DOWN_LABEL, writeBrief } from "./brief.js";
import {
    catchupOf,
    closingLines,
    dateLabel,
    dayKey,
    type DayRead,
    EVENING_ID,
    drawnEvents,
    failedCalendar,
    followUpsOf,
    HEAVY_ID,
    lineIdOf,
    listItems,
    listOf,
    mainTasks,
    namedDays,
    nextAsked,
    plainText,
    localDay,
    nextOffer,
    planOffer,
    present,
    type StepDeps,
    stillOpen,
    weekdayName,
    windDownTarget,
    withDateLabels,
    withoutMoveLinks,
    workBlocks
} from "./daily.js";
import { isInputWarning } from "./inputs/index.js";
import { type Named, resolveIn, resolveName, withRefs } from "./refs.js";
import { sayOf } from "./say.js";
import type { PlanApplyInput, WindDownApplyInput } from "./schemas.js";
import { readAttachment } from "./store.js";
import { contextAddOn, contextKeepOn, drawHeader, finishedOn, skipCatchupOn, TERRAIN_TITLE } from "./writes.js";
import type { DayWeather } from "./weather.js";

export interface ApplyDeps extends StepDeps {
    /** The standing note's coordinates for the weather, or null. */
    place: () => Promise<{ latitude: number; longitude: number } | null>;
    weatherOf: (latitude: number, longitude: number, date: string) => Promise<DayWeather | undefined>;
    /** Trilium's markdown import renderer, as the note tools use it. */
    render: (markdown: string, title: string) => string;
    /** `YYYY-MM-DDTHH:mm:ss` local time from the Caius clock. */
    plannedAt: string;
}

/** One write the apply made, or found already made (`unchanged`). */
export interface Written {
    kind: string;
    id?: string;
    text?: string;
    status: "written" | "unchanged";
    detail?: string;
    /** A move's other item, by its text: what it went before or after. */
    anchor?: string;
}

/** One answer the apply could not act on, and why. */
export interface Skipped {
    kind: string;
    id?: string;
    text?: string;
    reason: string;
    detail?: string;
}

/** Most picks the brief's "Get done today" lists. */
const MAX_PICKS = 5;

export async function planApply(deps: ApplyDeps, asked: PlanApplyInput) {
    const { date } = asked;
    if (date > dayKey(deps.now)) {
        return { date, error: "not_today", detail: t("caius.daily.not_today", { day: weekdayName(date), today: dayKey(deps.now) }) };
    }
    // The sources and the forecast are read before the lock, as the steps read them.
    const read = await deps.dayRead(date);
    const place = await deps.place();
    const weather = place ? await deps.weatherOf(place.latitude, place.longitude, date) : undefined;
    const prose = asked.brief;
    if (!prose) return reorder(deps, asked, read, weather);

    return deps.locked("caius_plan_apply", async () => {
        const { store, now } = deps;
        const unreadable = await unreadableDay(store, [ date ]);
        if (unreadable) return unreadable;
        const written: Written[] = [];
        const skipped: Skipped[] = [];
        const offer = await planOffer(store, date, now, read);
        // Every candidate the day could offer, whatever was offered or added since: a re-run finds
        // those already in Suggested, and an id he named still resolves after the brief is written.
        const known = new Map([
            ...dayCandidates({ jira: read.inputs.jira, week: offer.day.week, live: offer.day.live, exclude: [ ...offer.day.plan.dismissed, ...offer.day.closed ] }).map(present),
            ...offer.candidates
        ].map((candidate) => [ candidate.candidateId, candidate ]));

        // Every question the step asked is answered now, whatever he said, so it isn't asked again.
        await labelDay(store, date, ASKED_LABEL, [
            ...offer.carry.map((line) => line.lineId), ...offer.overlaps.map((pair) => pair.overlapId), ...(offer.forwardSuggestion ? [ HEAVY_ID ] : []),
            ...(offer.askEvening ? [ EVENING_ID ] : [])
        ]);
        // A forward may name only a task the steps showed, and only a day, week or month they listed.
        const catchupTasks = (await catchupOf(store, date, now)).tasks;
        const shown = new Set([
            offer.forwardSuggestion?.listItemId, ...offer.candidates.map((c) => c.listItemId), ...catchupTasks.map((t) => t.listItemId),
            ...listItems(offer.day.plan).map((item) => item.listItemId)
        ].filter((id): id is string => !!id));
        const listed = namedDays(date, dayKey(nextWorkday(localDay(date))));
        const listedTo = new Set<string>([ ...listed.days.map((d) => d.date), ...listed.weeks.map((w) => w.week), ...listed.months.map((m) => m.month) ]);
        // Every ref and name is read against the step data as it stands before the first write.
        const pools = planPools(offer, catchupTasks, listed.days);
        const input = planAnswers(asked, pools, skipped);
        /** The result with `say`, its entries named by their text first. */
        const answer = <R extends { written: Written[]; skipped: Skipped[] }>(result: R) => {
            withTexts([ ...result.written, ...result.skipped ], pools, known);
            return withDateLabels({ ...result, say: sayOf(result, { day: date }) });
        };

        await guarded({ kind: "catchup" }, skipped, () => catchup(store, date, now, input.catchup, written, skipped));

        // What the catch-up moves here can be placed by the id it had on its own day.
        const moved = new Map(input.catchup === "move_all" ? catchupTasks.flatMap((task) => task.listItemId ? [ [ task.listItemId, task.text ] as const ] : []) : []);
        await acceptAll(store, date, now, input, { known, moved }, written, skipped);

        const onList = new Set(listItems(offer.day.plan).map((item) => item.listItemId));
        await guarded({ kind: "done" }, skipped, async () => {
            const states = await loadStateSymbols(store);
            for (const listItemId of input.done) {
                const noteId = onList.has(listItemId) ? await noteOf(store, listItemId) : null;
                if (!noteId) {
                    skipped.push({ kind: "done", text: listItemId, reason: "not_on_list" });
                    continue;
                }
                const [ result ] = await setStates(store, "done", [ { noteId, listItemId } ], { states });
                record(written, skipped, { kind: "done", id: listItemId }, result);
            }
        });

        await guarded({ kind: "keep" }, skipped, async () => { for (const { lineId } of input.keep) {
            const line = offer.carry.find((c) => c.lineId === lineId);
            if (!line) {
                if (read.context.some((c) => lineIdOf(c.text) === lineId)) written.push({ kind: "keep", id: lineId, status: "unchanged" });
                else skipped.push({ kind: "keep", id: lineId, reason: "not_offered" });
                continue;
            }
            const [ result ] = await contextKeepOn(store, date, [ { text: line.line, ...(line.until ? { until: line.until } : {}) } ], { now });
            record(written, skipped, { kind: "keep", id: lineId, text: line.line }, result);
        } });

        await guarded({ kind: "finished" }, skipped, () => finish(store, date, now, input.finished, written, skipped));

        await guarded({ kind: "not_today" }, skipped, () => putOff(store, date, now, input.notToday.map((c) => c.candidateId), known, written, skipped));
        await guarded({ kind: "dismiss" }, skipped, () => dismiss(store, date, now, input.dismiss.map((c) => c.candidateId), known, written, skipped));
        await guarded({ kind: "suggested" }, skipped, () => shelve(store, date, now, offer.candidates, input, written, skipped));
        await guarded({ kind: "evening" }, skipped, () => eveningAndContext(store, date, now, input, written, skipped, { tomorrow: true, events: eveningEvents(read) }));

        await guarded({ kind: "forward" }, skipped, async () => { for (const { listItemId, to } of input.forward ?? []) {
            if (!shown.has(listItemId)) {
                await notShown(store, now, { kind: "forward", id: listItemId }, written, skipped);
                continue;
            }
            if (!listedTo.has(to)) {
                skipped.push({ kind: "forward", id: listItemId, reason: "not_a_listed_day", detail: NOT_LISTED });
                continue;
            }
            const noteId = await noteOf(store, listItemId);
            if (!noteId) {
                skipped.push({ kind: "forward", id: listItemId, reason: "not_found" });
                continue;
            }
            const [ result ] = await forwardTasks(store, [ { noteId, listItemId, to } ], {});
            record(written, skipped, { kind: "forward", id: listItemId, detail: to }, result);
        } });

        if (read.inputs.errors.some((e) => e.source === "calendar" && !isInputWarning(e.error))) {
            skipped.push({ kind: "meetings", reason: "calendar_unavailable" });
        } else {
            await guarded({ kind: "meetings" }, skipped, async () => {
                record(written, skipped, { kind: "meetings" }, await setMeetings(store, { date, lines: meetingLines(read.inputs.calendar) }, {}));
            });
        }

        // A pick's reason is its candidate's, live or not, so a re-run words the brief the same.
        const reasons = new Map(dayCandidates({ jira: read.inputs.jira, week: offer.day.week, live: new Map(), exclude: offer.day.closed })
            .map(present).map((candidate) => [ candidate.candidateId, candidate ]));
        const brief = await briefOf(deps, { date, brief: prose }, read, reasons, offer.jira, offer.headsUp, weather)
            .catch((e: unknown) => ({ error: "failed", detail: e instanceof Error ? e.message : String(e) }));
        if ("error" in brief) {
            skipped.push({ kind: "brief", reason: brief.error ?? "bad_request", detail: brief.detail });
            return answer({ date, written, skipped });
        }
        const changed = brief.writes.some((w) => w.status === "updated");
        const lost = brief.writes.find((w) => w.status === "skipped");
        if (lost) skipped.push({ kind: "brief", reason: lost.reason ?? "edited" });
        else written.push({ kind: "brief", status: changed ? "written" : "unchanged" });
        return answer({
            date, written, skipped,
            headline: prose.headline, topPick: brief.picks[0]?.text ?? null,
            briefNoteId: brief.briefNoteId, headerNoteId: brief.headerNoteId, attachmentId: brief.attachmentId,
            link: `#root/${brief.briefNoteId}`, plannedAt: brief.plannedAt
        });
    });
}

/**
 * Wind down's writes for `date`, against the next workday: what he called done, the fates he named
 * (a forward, or a drop with his reason), the proposed fate for every open item he didn't name,
 * the candidates he took for the next workday in his order, the keep and carry lines, finished
 * tickets, candidates put off, evening tasks and Context lines on the next workday.
 */
export async function windDownApply(deps: ApplyDeps, asked: WindDownApplyInput) {
    const { date } = asked;
    const targetDay = windDownTarget(date, deps.now);
    const read = await deps.dayRead(targetDay);
    // A day with a brief has its header drawn again after the writes, from its calendar, with the
    // day's forecast fetched for a brief that kept no weather.
    const briefed = new Map<string, { read: DayRead; fetched?: DayWeather }>();
    const place = await deps.place();
    for (const day of new Set([ date, targetDay ])) {
        const note = await findPeriodNote(deps.store, "day", day);
        const brief = note ? await findBrief(deps.store, note.noteId, day) : null;
        if (!brief) continue;
        const fetched = place && label(brief, WEATHER_LABEL) === undefined ? await deps.weatherOf(place.latitude, place.longitude, day) : undefined;
        briefed.set(day, { read: day === targetDay ? read : await deps.dayRead(day), ...(fetched ? { fetched } : {}) });
    }
    return deps.locked("caius_winddown_apply", async () => {
        const { store, now } = deps;
        const unreadable = await unreadableDay(store, [ date, targetDay ]);
        if (unreadable) return unreadable;
        const written: Written[] = [];
        const skipped: Skipped[] = [];
        const open = await stillOpen(store, date, targetDay);
        const { facts, candidates, asks } = await nextOffer(store, targetDay, now, read);
        const lines = await closingLines(store, date, targetDay, read);
        await labelDay(store, date, ASKED_LABEL, [ ...lines.keep, ...lines.carry ].map((line) => line.lineId));
        // The next step's questions are about the next workday, so they are answered on its note.
        await labelDay(store, targetDay, ASKED_LABEL, nextAsked(asks));
        const known = new Map([
            ...dayCandidates({ jira: read.inputs.jira, week: facts.week, live: facts.live, exclude: [ ...facts.plan.dismissed, ...facts.closed ] }).map(present),
            ...candidates
        ].map((candidate) => [ candidate.candidateId, candidate ]));

        const states = await loadStateSymbols(store);
        // An answer may name only an item the open step showed, and only a day, week or month it listed.
        const shownItems = new Set(open.items.map((item) => item.listItemId).filter((id): id is string => !!id));
        const listed = namedDays(date, targetDay);
        const listedTo = new Set<string>([ ...listed.days.map((d) => d.date), ...listed.weeks.map((w) => w.week), ...listed.months.map((m) => m.month) ]);
        // Every ref and name is read against the step data as it stands before the first write.
        const pools: Pools = {
            open: named(withRefs(open.items, "o"), (item) => item.listItemId, (item) => item.text),
            candidates: named(withRefs(candidates, "c"), (c) => c.candidateId, (c) => c.text),
            list: named(withRefs(listItems(facts.plan), "l"), (item) => item.listItemId, (item) => item.text),
            lines: named(withRefs([ ...lines.keep, ...lines.carry ], "x"), (line) => line.lineId, (line) => line.line),
            days: named(listed.days, (day) => day.date, (day) => dateLabel(day.date) ?? day.date)
        };
        const input = windDownAnswers(asked, pools, skipped);
        // The open items carry their note; only an id from elsewhere needs the Journal searched.
        const noteFor = async (listItemId: string) => open.items.find((item) => item.listItemId === listItemId)?.noteId ?? await noteOf(store, listItemId);
        await guarded({ kind: "done" }, skipped, async () => { for (const listItemId of input.done) {
            if (!shownItems.has(listItemId)) {
                await notShown(store, now, { kind: "done", id: listItemId }, written, skipped);
                continue;
            }
            const noteId = await noteFor(listItemId);
            if (!noteId) {
                skipped.push({ kind: "done", id: listItemId, reason: "not_found" });
                continue;
            }
            const [ result ] = await setStates(store, "done", [ { noteId, listItemId } ], { states });
            record(written, skipped, { kind: "done", id: listItemId }, result);
        } });

        // A fate he named, then the proposed one for every item he didn't name.
        const given = new Set([ ...input.done, ...input.fates.map((fate) => fate.listItemId) ]);
        const putOffWeek: string[] = [];
        const fates = [
            ...input.fates,
            ...open.items.filter((item) => item.listItemId && !given.has(item.listItemId) && "forward" in item.fate)
                .map((item) => ({ listItemId: item.listItemId ?? "", to: (item.fate as { forward: string }).forward, proposed: true }))
        ];
        await guarded({ kind: "fate" }, skipped, async () => { for (const fate of fates) {
            const noteId = await noteFor(fate.listItemId);
            const entry = { kind: "fate", id: fate.listItemId, ...("drop" in fate && fate.drop ? { detail: "dropped" } : { detail: fate.to }) };
            if (!shownItems.has(fate.listItemId)) {
                await notShown(store, now, entry, written, skipped);
                continue;
            }
            if (!("proposed" in fate) && fate.to !== undefined && !listedTo.has(fate.to)) {
                skipped.push({ ...entry, reason: "not_a_listed_day", detail: NOT_LISTED });
                continue;
            }
            if (!noteId) {
                skipped.push({ ...entry, reason: "not_found" });
                continue;
            }
            if ("drop" in fate && fate.drop) {
                const [ result ] = await setStates(store, "drop", [ { noteId, listItemId: fate.listItemId, reason: fate.drop } ], { states });
                record(written, skipped, entry, result);
                continue;
            }
            const to = fate.to ?? "";
            // A task he sends to a week is put off there, so its week item isn't offered for two workdays.
            if (!("proposed" in fate) && PERIODS.week.pattern.test(to)) {
                const text = open.items.find((item) => item.listItemId === fate.listItemId)?.text;
                const key = text ? keysOf(text)[0] : undefined;
                if (key) putOffWeek.push(key);
            }
            const [ result ] = await forwardTasks(store, [ { noteId, listItemId: fate.listItemId, to } ], {});
            record(written, skipped, entry, result);
        }
        await labelDay(store, date, NOT_TODAY_LABEL, putOffWeek);
        });

        // What the fates move to the next workday can be placed by the id it had here.
        const moved = new Map(open.items.flatMap((item) => item.listItemId ? [ [ item.listItemId, item.text ] as const ] : []));
        await acceptAll(store, targetDay, now, input, { known, moved }, written, skipped);
        await guarded({ kind: "keep" }, skipped, async () => { for (const [ kind, refs ] of [ [ "keep", input.keep ], [ "carry", input.carry ] ] as const) {
            for (const { lineId } of refs) {
                const line = [ ...lines.keep, ...lines.carry ].find((l) => l.lineId === lineId);
                if (!line) {
                    if (read.context.some((c) => lineIdOf(c.text) === lineId)) written.push({ kind, id: lineId, status: "unchanged" });
                    else skipped.push({ kind, id: lineId, reason: "not_offered" });
                    continue;
                }
                // A kept line holds on with no end; a carried one keeps its own.
                const until = line.kind === "carry" ? line.until : undefined;
                const [ result ] = await contextKeepOn(store, targetDay, [ { text: line.line, ...(until ? { until } : {}) } ], { now });
                record(written, skipped, { kind, id: lineId, text: line.line }, result);
            }
        } });
        await guarded({ kind: "finished" }, skipped, () => finish(store, targetDay, now, input.finished, written, skipped));
        await guarded({ kind: "not_today" }, skipped, () => putOff(store, targetDay, now, input.notToday.map((c) => c.candidateId), known, written, skipped));
        await guarded({ kind: "dismiss" }, skipped, () => dismiss(store, targetDay, now, input.dismiss.map((c) => c.candidateId), known, written, skipped));
        await guarded({ kind: "suggested" }, skipped, () => shelve(store, targetDay, now, candidates, input, written, skipped));
        await guarded({ kind: "evening" }, skipped, () => eveningAndContext(store, targetDay, now, input, written, skipped, { events: eveningEvents(read) }));
        // The day is closed only when every item got its fate, so a later catch-up looks no further back.
        // The label holds the time of the first wind-down, which the nudge bar shows; a re-run keeps it.
        if (!skipped.some((entry) => entry.kind === "done" || entry.kind === "fate")) {
            const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
            if (!note.attributes.some((a) => a.type === "label" && a.name === WOUND_DOWN_LABEL)) await store.addLabel(note.noteId, WOUND_DOWN_LABEL, deps.plannedAt);
        }
        // The closed day is drawn as it was worked, its done tasks included; the next workday as it stands.
        for (const [ day, { read: dayRead, fetched } ] of briefed) {
            if (failedCalendar(dayRead)) {
                skipped.push({ kind: "header", id: day, reason: "calendar_unavailable" });
                continue;
            }
            await guarded({ kind: "header", id: day }, skipped, () => redraw(store, day, dayRead, now, { worked: day === date }, fetched, written, skipped));
        }
        // A morning Review of an older day closes it against today, which Plan my day plans next in the same conversation.
        const morning = targetDay === dayKey(now) && hhmm(now) < read.rhythm.workEnd;
        withTexts([ ...written, ...skipped ], pools, known);
        const say = sayOf({ written, skipped }, { day: targetDay });
        return {
            ...withDateLabels({ date, targetDay, written, skipped, next: morning ? "planday" : null, say: morning ? `${say} ${t("caius.say.next_planday")}` : say }),
            ...(morning ? { nextCall: { tool: "caius_planday", date: targetDay } } : {})
        };
    });
}

/**
 * A Plan my day call with only `move`: his list reordered, and the header's drawing and Evening act
 * drawn again when the order changes the picks. Nothing else is written.
 */
async function reorder(deps: ApplyDeps, asked: PlanApplyInput, read: DayRead, weather: DayWeather | undefined) {
    const { date } = asked;
    return deps.locked("caius_plan_apply", async () => {
        const { store, now } = deps;
        const unreadable = await unreadableDay(store, [ date ]);
        if (unreadable) return unreadable;
        const written: Written[] = [];
        const skipped: Skipped[] = [];
        const offer = await planOffer(store, date, now, read);
        const catchupTasks = (await catchupOf(store, date, now)).tasks;
        const pools = planPools(offer, catchupTasks, namedDays(date, dayKey(nextWorkday(localDay(date)))).days);
        const known = new Map(offer.candidates.map((candidate) => [ candidate.candidateId, candidate ]));
        const input = planAnswers(asked, pools, skipped);
        const before = picksOf(offer.day.plan);
        await acceptAll(store, date, now, input, { known, moved: new Map() }, written, skipped);
        if (picksOf(await readPlan(store, "day", date, now)) !== before) {
            if (failedCalendar(read)) skipped.push({ kind: "header", id: date, reason: "calendar_unavailable" });
            else await guarded({ kind: "header", id: date }, skipped, () => redraw(store, date, read, now, {}, weather, written, skipped));
        }
        withTexts([ ...written, ...skipped ], pools, known);
        return withDateLabels({ date, written, skipped, say: sayOf({ written, skipped }, { day: date }) });
    });
}

/** The brief's picks of a plan as they read, in order: the first work tasks of his list. */
function picksOf(plan: Awaited<ReturnType<typeof readPlan>>): string {
    return listOf(plan).filter((task) => !task.evening).slice(0, MAX_PICKS).map((task) => task.text).join("\n");
}

/**
 * Draws the header of `day`'s brief again from its note: the drawing, and the acts with the Evening
 * act as the note now has it. With `worked`, as the day was worked. A weather icon already drawn
 * stays when no weather can be had.
 */
async function redraw(store: NoteStore, day: string, read: DayRead, now: Date, worked: { worked?: boolean }, fetched: DayWeather | undefined, written: Written[], skipped: Skipped[]) {
    const plan = await readPlan(store, "day", day, now);
    const header = headerOf(plan, read, day, now, worked);
    const draw = (noteId: string, weather: DayWeather | undefined) => drawHeader(noteId, header, weather ?? weatherOfSvg(readAttachment(noteId, "image", TERRAIN_TITLE) ?? "") ?? undefined).attachmentId;
    const write = await redrawHeader(store, day, draw, (acts) => withEveningAct(acts, plan, header, worked), fetched);
    if (write) record(written, skipped, { kind: "header", detail: day }, write.status === "updated" ? { status: "written" } : write);
}

/** What Plan my day's answers name their items from: the step data of `catchup` and `inputs`, with their refs. */
function planPools(offer: Awaited<ReturnType<typeof planOffer>>, catchupTasks: Awaited<ReturnType<typeof catchupOf>>["tasks"], days: { date: string; ref: string }[]): Pools {
    return {
        open: named(withRefs(catchupTasks, "o"), (task) => task.listItemId, (task) => task.text),
        candidates: named(withRefs(offer.candidates, "c"), (c) => c.candidateId, (c) => c.text),
        list: named(withRefs(listItems(offer.day.plan), "l"), (item) => item.listItemId, (item) => item.text),
        lines: named(withRefs(offer.carry, "x"), (line) => line.lineId, (line) => line.line),
        days: named(days, (day) => day.date, (day) => dateLabel(day.date) ?? day.date)
    };
}

const EVENING = "Evening";

/** The local time of `at` as `HH:MM`. */
const hhmm = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** What each kind of answer names its items from, each item with the ref its step gave it. */
interface Pools {
    open: Named[];
    candidates: Named[];
    list: Named[];
    lines: Named[];
    days: Named[];
}

/** `items` as names an answer can give: each with its id, ref and plain text; an item without an id can't be named. */
function named<T extends { ref: string }>(items: T[], id: (item: T) => string | null | undefined, text: (item: T) => string): Named[] {
    return items.flatMap((item) => {
        const value = id(item);
        return value ? [ { id: value, ref: item.ref, text: plainText(withoutMoveLinks(text(item))) } ] : [];
    });
}

/**
 * Reads the names of one answer: the id each names, its own value when it names nothing the steps
 * showed (the write then says why), or null when it names several, skipped as ambiguous.
 */
function nameReader(skipped: Skipped[]) {
    const read = (kind: string, value: string, pools: Named[][]): string | null => {
        const found = resolveIn(pools, value);
        if (found && "ambiguous" in found) {
            skipped.push({ kind, text: value, reason: "ambiguous", detail: found.ambiguous.join("; ") });
            return null;
        }
        return found?.id ?? value;
    };
    /** A place with the item it names read from `pools`, or null when that is ambiguous. */
    const place = <P extends { before?: string; after?: string }>(kind: string, at: P, pools: Named[][]): P | null => {
        const by = at.before ?? at.after;
        if (by === undefined) return at;
        const id = read(kind, by, pools);
        return id === null ? null : { ...at, ...(at.before !== undefined ? { before: id } : { after: id }) };
    };
    return { read, place };
}

/**
 * Plan my day's answers with every name read as the id it names; an ambiguous one is left out,
 * skipped. `done` holds the items of his list that `finished` names: by a ticket key, or by anything
 * else he called done.
 */
function planAnswers(input: PlanApplyInput, pools: Pools, skipped: Skipped[]): PlanApplyInput & { done: string[] } {
    const { read, place } = nameReader(skipped);
    const { done, finished } = doneOf([], input.finished, [ pools.list ], read);
    const onList = [ pools.list, pools.candidates, pools.open ];
    const candidate = (kind: string) => (ref: { candidateId: string }) => {
        const id = read(kind, ref.candidateId, [ pools.candidates ]);
        return id === null ? [] : [ { ...ref, candidateId: id } ];
    };
    return {
        ...input,
        done,
        finished,
        accept: input.accept.flatMap((ref) => {
            const id = read("accept", ref.candidateId, [ pools.candidates ]);
            const at = place("place", ref, onList);
            return id === null || at === null ? [] : [ { ...at, candidateId: id } ];
        }),
        move: input.move.flatMap((ref) => {
            const id = read("move", ref.listItemId, onList);
            const at = place("move", ref, onList);
            return id === null || at === null ? [] : [ { ...at, listItemId: id } ];
        }),
        keep: input.keep.flatMap((ref) => {
            const id = read("keep", ref.lineId, [ pools.lines ]);
            return id === null ? [] : [ { lineId: id } ];
        }),
        notToday: input.notToday.flatMap(candidate("not_today")),
        dismiss: input.dismiss.flatMap(candidate("dismiss")),
        ...(input.forward ? { forward: input.forward.flatMap((fate) => {
            const id = read("forward", fate.listItemId, onList);
            const to = read("forward", fate.to, [ pools.days ]);
            return id === null || to === null ? [] : [ { listItemId: id, to } ];
        }) } : {})
    };
}

/** Wind down's answers with every name read as the id it names; an ambiguous one is left out, skipped. */
function windDownAnswers(input: WindDownApplyInput, pools: Pools, skipped: Skipped[]): WindDownApplyInput {
    const { read, place } = nameReader(skipped);
    const onList = [ pools.list, pools.candidates, pools.open ];
    const candidate = (kind: string) => (ref: { candidateId: string }) => {
        const id = read(kind, ref.candidateId, [ pools.candidates ]);
        return id === null ? [] : [ { ...ref, candidateId: id } ];
    };
    const line = (kind: string) => (ref: { lineId: string }) => {
        const id = read(kind, ref.lineId, [ pools.lines ]);
        return id === null ? [] : [ { lineId: id } ];
    };
    const { done, finished } = doneOf(input.done, input.finished, [ pools.open ], read);
    return {
        ...input,
        done,
        finished,
        fates: input.fates.flatMap((fate) => {
            const id = read("fate", fate.listItemId, [ pools.open ]);
            const to = fate.to === undefined ? undefined : read("fate", fate.to, [ pools.days ]);
            return id === null || to === null ? [] : [ { ...fate, listItemId: id, ...(to === undefined ? {} : { to }) } ];
        }),
        accept: input.accept.flatMap((ref) => {
            const id = read("accept", ref.candidateId, [ pools.candidates ]);
            const at = place("place", ref, onList);
            return id === null || at === null ? [] : [ { ...at, candidateId: id } ];
        }),
        move: input.move.flatMap((ref) => {
            const id = read("move", ref.listItemId, onList);
            const at = place("move", ref, onList);
            return id === null || at === null ? [] : [ { ...at, listItemId: id } ];
        }),
        keep: input.keep.flatMap(line("keep")),
        carry: input.carry.flatMap(line("carry")),
        notToday: input.notToday.flatMap(candidate("not_today")),
        dismiss: input.dismiss.flatMap(candidate("dismiss"))
    };
}

/**
 * What he called done, read from `done` and `finished`: each done answer, each finished answer that
 * is not a Jira key, and the item each finished key names in `pools`, once. `finished` keeps only
 * the keys, which are recorded as finished whether or not they name an item.
 */
function doneOf(said: string[], finished: string[], pools: Named[][], read: (kind: string, value: string, pools: Named[][]) => string | null) {
    const keys = finished.filter((value) => JIRA_KEY.test(value));
    const done = new Set([ ...said, ...finished.filter((value) => !JIRA_KEY.test(value)) ].flatMap((value) => read("done", value, pools) ?? []));
    for (const key of keys) {
        const found = pools.map((pool) => resolveName(pool, key)).find((r) => r !== null);
        if (found && "id" in found) done.add(found.id);
    }
    return { done: [ ...done ], finished: keys };
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * Gives each entry without a text the text of the item its id names in `pools` or `known`, or his
 * own words when the id is an answer that named nothing, so `say` can name it. An id-shaped value
 * that named nothing stays unnamed.
 */
function withTexts(entries: (Written | Skipped)[], pools: Pools, known: Map<string, Candidate>) {
    const texts = new Map<string, string>([ ...known ].map(([ id, candidate ]) => [ id, candidate.text ]));
    for (const item of Object.values(pools).flat()) texts.set(item.id, item.text);
    for (const entry of entries) {
        if (entry.text !== undefined || entry.id === undefined) continue;
        const text = texts.get(entry.id) ?? (ID_SHAPED.test(entry.id) || JIRA_KEY.test(entry.id) ? undefined : entry.id);
        if (text !== undefined) entry.text = text;
    }
}

/** A value that looks like a list item id, a ref, or a line or overlap id rather than his words. */
const ID_SHAPED = /^(?:[a-z]?[0-9a-f]{8,}|[oclxdw]\d+|[lo][0-9a-f]{10})$/i;

/** Runs one group of writes; a throw becomes one skipped entry, so the rest of the answer still comes back. */
async function guarded(entry: { kind: string; id?: string }, skipped: Skipped[], work: () => Promise<unknown>) {
    try {
        await work();
    } catch (e) {
        skipped.push({ ...entry, reason: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
}

/** `error: "bad_request"` when the day note of one of `dates` is protected or not a text note, which Caius cannot read. */
async function unreadableDay(store: NoteStore, dates: string[]) {
    for (const date of dates) {
        const note = await findPeriodNote(store, "day", date);
        if (note && (note.type !== "text" || note.isProtected)) return { date: dates[0], error: "bad_request", detail: `The day note for ${date} is protected or not a text note` };
    }
    return null;
}
const NOT_LISTED = "Name a day from the step's data.days, a week from data.weeks or a month from data.months";

/**
 * The day note's evening heading, Evening or Recharge with or without an emoji, given a
 * `### Evening` after his tasks and above Suggested when it has none, so an evening task never
 * lands in the work list and is drawn after work ends. Answers the heading's name.
 */
async function eveningHeading(store: NoteStore, date: string): Promise<string> {
    const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
    const before = await store.content(note.noteId);
    const headings = [ ...before.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi) ];
    const found = headings.find((m) => EVENING_NAMES.has(normName((m[1] ?? "").replace(/<[^>]+>/g, ""))));
    if (found) return (found[1] ?? EVENING).replace(/<[^>]+>/g, "").trim();
    const suggested = headings.find((m) => normName((m[1] ?? "").replace(/<[^>]+>/g, "")) === "suggested");
    const at = suggested?.index ?? before.length;
    await store.putContent(note.noteId, `${before.slice(0, at)}<h3>${EVENING}</h3>${before.slice(at)}`, before);
    return EVENING;
}

const EVENING_NAMES = new Set([ "evening", "recharge" ]);

/** Adds each value of `name` not on the day note of `date` yet, creating the note if missing. */
async function labelDay(store: NoteStore, date: string, name: string, values: string[]) {
    if (!values.length) return;
    const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
    for (const value of new Set(values)) {
        if (!note.attributes.some((a) => a.type === "label" && a.name === name && a.value === value)) await store.addLabel(note.noteId, name, value);
    }
}

/** Records the tickets he called finished on the day note of `date`. */
async function finish(store: NoteStore, date: string, now: Date, keys: string[], written: Written[], skipped: Skipped[]) {
    if (!keys.length) return;
    const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
    const result = await finishedOn(store, keys, note, date, now);
    if ("error" in result) skipped.push({ kind: "finished", text: keys.join(", "), reason: result.error ?? "bad_request", detail: result.detail });
    else for (const key of keys) written.push({ kind: "finished", id: key, status: result.status === "updated" ? "written" : "unchanged" });
}

/**
 * Puts candidates off for `date`: `#caiusNotToday` on its note, and off its Suggested without a
 * dismissal, so they come back on the next workday.
 */
async function putOff(store: NoteStore, date: string, now: Date, ids: string[], known: Map<string, Candidate>, written: Written[], skipped: Skipped[]) {
    for (const candidateId of ids) {
        if (!known.has(candidateId)) {
            skipped.push({ kind: "not_today", id: candidateId, reason: "not_offered" });
            continue;
        }
        const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
        const labelled = note.attributes.some((a) => a.type === "label" && a.name === NOT_TODAY_LABEL && a.value === candidateId);
        if (!labelled) await store.addLabel(note.noteId, NOT_TODAY_LABEL, candidateId);
        const removed = await unsuggest(store, date, now, candidateId);
        written.push({ kind: "not_today", id: candidateId, text: known.get(candidateId)?.text, status: labelled && !removed ? "unchanged" : "written" });
    }
}

/**
 * Dismisses candidates he said to dismiss: from the day's Suggested, put there first when it isn't,
 * with `#caiusDismissed`, so the key is off every list for 14 days and its asks leave the Follow up.
 */
async function dismiss(store: NoteStore, date: string, now: Date, ids: string[], known: Map<string, Candidate>, written: Written[], skipped: Skipped[]) {
    for (const candidateId of ids) {
        const candidate = known.get(candidateId);
        const entry = { kind: "dismiss", id: candidateId, ...(candidate ? { text: candidate.text } : {}) };
        let plan = await readPlan(store, "day", date, now);
        if (plan.dismissed.includes(candidateId)) {
            written.push({ ...entry, status: "unchanged" });
            continue;
        }
        let item = plan.suggested.find((task) => keysOf(task.text).includes(candidateId));
        if (!item && candidate?.key && candidate.kind !== "week") {
            const [ added ] = await addTasks(store, [ { date, suggested: true, text: suggestedLine(candidate), source: candidate.key } ], { now });
            if (added?.status !== "added") {
                record(written, skipped, entry, added);
                continue;
            }
            plan = await readPlan(store, "day", date, now);
            item = plan.suggested.find((task) => task.listItemId === added.listItemId);
        }
        if (!item?.listItemId || !plan.noteId) {
            skipped.push({ ...entry, reason: candidate ? "not_suggested" : "not_offered" });
            continue;
        }
        const [ result ] = await dismissTasks(store, [ { noteId: item.noteId ?? plan.noteId, listItemId: item.listItemId } ]);
        record(written, skipped, entry, result);
    }
}

/** What was offered and not named stays on the shelf: each ticket candidate goes to the day's Suggested. */
async function shelve(store: NoteStore, date: string, now: Date, offered: Candidate[], input: { accept: { candidateId: string }[]; notToday: { candidateId: string }[]; dismiss: { candidateId: string }[]; finished: string[] }, written: Written[], skipped: Skipped[]) {
    const named = new Set([ ...input.accept, ...input.notToday, ...input.dismiss ].map((c) => c.candidateId).concat(input.finished));
    for (const candidate of offered) {
        if (candidate.kind === "week" || named.has(candidate.candidateId) || !candidate.key) continue;
        const [ result ] = await addTasks(store, [ { date, suggested: true, text: suggestedLine(candidate), source: candidate.key } ], { now });
        record(written, skipped, { kind: "suggested", id: candidate.candidateId, text: candidate.text }, result);
    }
}

/**
 * His evening tasks under the day's Evening heading, and his Context lines placed by `contextAddOn`
 * (with `tomorrow` in Plan my day). An evening thing that names one of the day's evening calendar
 * `events` is not a task: it is skipped as `calendar_event`, and the Evening act names the event.
 */
async function eveningAndContext(store: NoteStore, date: string, now: Date, input: { evening: string[]; context: string[] }, written: Written[], skipped: Skipped[], opts: { tomorrow?: boolean; events?: string[] } = {}) {
    for (const text of input.evening) {
        const event = opts.events?.find((title) => namesEvent(text, title));
        if (event) {
            skipped.push({ kind: "evening", text, reason: "calendar_event", detail: event });
            continue;
        }
        // An evening task forwarded to the day carries a "from Monday 2" link, so the same words there count as written.
        const same = (words: string) => plainText(words).toLowerCase();
        if (listOf(await readPlan(store, "day", date, now)).some((task) => task.evening && same(task.text) === same(text))) {
            written.push({ kind: "evening", text, status: "unchanged" });
            continue;
        }
        const section = await eveningHeading(store, date);
        const [ result ] = await addTasks(store, [ { date, section, text } ], { now });
        // A duplicate here is a work task with the same words, not an evening task already written.
        if (result?.status === "skipped" && result.reason === "duplicate") skipped.push({ kind: "evening", text, reason: "duplicate", detail: result.detail });
        else record(written, skipped, { kind: "evening", text }, result);
    }
    for (const text of input.context) {
        const { result } = await contextAddOn(store, { date, text }, now, opts);
        record(written, skipped, { kind: "context", text }, result);
    }
}

type Candidate = ReturnType<typeof present>;

/** The brief's prose as the agent writes it. */
type Prose = NonNullable<PlanApplyInput["brief"]>;

/** The titles of the day's timed calendar events that start at or after the end of work. */
function eveningEvents(read: DayRead): string[] {
    return read.inputs.calendar.filter((e) => !e.allDay && !e.declined && e.start >= read.rhythm.workEnd).map((e) => e.title);
}

/**
 * Whether `text` names the event `title`: every word he said, past the filler, is a word of the
 * title ("just mom" and "Call Mom"). A line with words beyond the title ("Call Mom about the
 * flights") is a task of its own.
 */
function namesEvent(text: string, title: string): boolean {
    const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const said = words(plainText(text)).filter((word) => !FILLER.has(word));
    const event = new Set(words(title));
    return said.length > 0 && said.every((word) => event.has(word));
}

/** Words that don't name anything in what he says about the evening. */
const FILLER = new Set([ "the", "a", "just", "is", "evening" ]);

/** The catch-up as he answered it: every live task of the last workday forwarded to `date`, a skip, or nothing on "review". */
async function catchup(store: NoteStore, date: string, now: Date, answer: PlanApplyInput["catchup"], written: Written[], skipped: Skipped[]) {
    if (!answer) return;
    if (answer === "skip") {
        const result = await skipCatchupOn(store, date);
        if ("error" in result) skipped.push({ kind: "catchup", reason: result.error ?? "bad_request", detail: result.detail });
        else written.push({ kind: "catchup", status: result.status === "updated" ? "written" : "unchanged", detail: "skip" });
        return;
    }
    const { tasks } = await catchupOf(store, date, now);
    if (answer === "review") {
        if (tasks.length) skipped.push({ kind: "catchup", reason: "review", detail: t("caius.daily.catchup_review") });
        return;
    }
    for (const task of tasks) {
        if (!task.listItemId) {
            skipped.push({ kind: "catchup", text: task.text, reason: "no_id" });
            continue;
        }
        const [ result ] = await forwardTasks(store, [ { noteId: task.noteId, listItemId: task.listItemId, to: date } ], {});
        record(written, skipped, { kind: "catchup", id: task.listItemId, text: task.text }, result);
    }
}

/**
 * Puts a candidate at the end of his list: a week item by forwarding it to `date`, a ticket from
 * the day's Suggested, added there first when it isn't. One already on his list is unchanged.
 */
async function accept(store: NoteStore, date: string, now: Date, candidate: Candidate | undefined, candidateId: string, written: Written[], skipped: Skipped[]) {
    const entry = { kind: "accept", id: candidateId, ...(candidate ? { text: candidate.text } : {}) };
    const plan = await readPlan(store, "day", date, now);
    if (listOf(plan).some((task) => task.keys.includes(candidateId))) {
        written.push({ ...entry, status: "unchanged" });
        return;
    }
    if (!candidate) {
        skipped.push({ ...entry, reason: "not_offered" });
        return;
    }
    if (candidate.kind === "week") {
        if (!candidate.noteId || !candidate.listItemId) {
            skipped.push({ ...entry, reason: "no_id" });
            return;
        }
        const [ result ] = await forwardTasks(store, [ { noteId: candidate.noteId, listItemId: candidate.listItemId, to: date } ], {});
        record(written, skipped, entry, result);
        return;
    }
    let shelf = plan;
    let item = plan.suggested.find((task) => keysOf(task.text).includes(candidateId));
    if (!item?.listItemId && candidate.key) {
        const [ added ] = await addTasks(store, [ { date, suggested: true, text: suggestedLine(candidate), source: candidate.key } ], { now });
        if (added?.status !== "added") {
            record(written, skipped, entry, added);
            return;
        }
        // The add can create the day note, so its id comes from a fresh read.
        shelf = await readPlan(store, "day", date, now);
        item = shelf.suggested.find((task) => task.listItemId === added.listItemId);
    }
    const noteId = item?.noteId ?? shelf.noteId;
    if (!item?.listItemId || !noteId) {
        skipped.push({ ...entry, reason: "not_found" });
        return;
    }
    const [ result ] = await acceptTasks(store, [ { noteId, listItemId: item.listItemId } ]);
    record(written, skipped, entry, result);
}

/**
 * The candidates he took, in his order, then each put where he said (`first`, `before` or `after`),
 * then the items of his list he asked to move, so a place can name anything the call put on the list.
 */
async function acceptAll(store: NoteStore, date: string, now: Date, input: Pick<PlanApplyInput, "accept" | "move">, refs: Refs, written: Written[], skipped: Skipped[]) {
    const taken: typeof input.accept = [];
    for (const ref of input.accept) {
        const before = skipped.length;
        await guarded({ kind: "accept", id: ref.candidateId }, skipped, () => accept(store, date, now, refs.known.get(ref.candidateId), ref.candidateId, written, skipped));
        if (skipped.length === before) taken.push(ref);
    }
    // Several firsts keep the order he gave: each one after the first goes after the one before it.
    let lastFirst: string | undefined;
    const inOrder = (item: string, place: { first?: boolean; before?: string; after?: string }) => {
        if (!place.first) return place;
        const at = lastFirst === undefined ? place : { after: lastFirst };
        lastFirst = item;
        return at;
    };
    for (const { candidateId, ...place } of taken) {
        const at = inOrder(candidateId, place);
        await guarded({ kind: "place", id: candidateId }, skipped, () => placeOnList(store, date, now, { kind: "place", id: candidateId }, candidateId, at, refs, written, skipped));
    }
    for (const { listItemId, ...place } of input.move) {
        const at = inOrder(listItemId, place);
        await guarded({ kind: "move", id: listItemId }, skipped, () => placeOnList(store, date, now, { kind: "move", id: listItemId }, listItemId, at, refs, written, skipped));
    }
}

/** What a place can name besides an item of the list: the call's candidates, and the items it moved here by the id they had (`moved`, id to text). */
interface Refs {
    known: Map<string, Candidate>;
    moved: Map<string, string>;
}

/**
 * Moves `item` in his main list of `date` to `place`. `item` and the item it is placed by are each
 * a listItemId of the list, a candidate's id or the id of an item the call moved here, found on the
 * list by its key or, for an item whose copy has a new id, by its text without the forward links.
 */
async function placeOnList(store: NoteStore, date: string, now: Date, entry: { kind: string; id: string }, item: string, place: { first?: boolean; before?: string; after?: string }, refs: Refs, written: Written[], skipped: Skipped[]) {
    const by = place.before ?? place.after;
    if (!place.first && by === undefined) return;
    const plan = await readPlan(store, "day", date, now);
    const tasks = mainTasks(plan);
    const refsOf = (ref: string) => {
        const text = refs.known.get(ref)?.text ?? refs.moved.get(ref);
        return [ ref, ...(text ? keysOf(withoutMoveLinks(text)) : []) ];
    };
    const find = (ref: string) => tasks.find((task) => task.listItemId === ref)
        ?? tasks.find((task) => keysOf(withoutMoveLinks(task.text)).some((key) => refsOf(ref).includes(key)));
    const task = find(item);
    const anchor = by === undefined ? undefined : find(by)?.listItemId ?? undefined;
    const noteId = task?.noteId ?? plan.noteId;
    if (!task?.listItemId || !noteId || (by !== undefined && !anchor)) {
        skipped.push({ ...entry, reason: "not_on_list" });
        return;
    }
    const where = place.first ? { first: true } : place.before !== undefined ? { before: anchor } : { after: anchor };
    const [ result ] = await moveTasks(store, [ { noteId, listItemId: task.listItemId, ...where } ]);
    const other = tasks.find((t) => t.listItemId === anchor)?.text;
    record(written, skipped, { ...entry, text: task.text, detail: place.first ? "first" : place.before !== undefined ? "before" : "after", ...(other ? { anchor: other } : {}) }, result);
}

/** Takes the day's Suggested item for `key` out without recording a dismissal. Answers whether one was there. */
async function unsuggest(store: NoteStore, date: string, now: Date, key: string): Promise<boolean> {
    const plan = await readPlan(store, "day", date, now);
    const item = plan.suggested.find((task) => keysOf(task.text).includes(key));
    if (!item?.listItemId || !plan.noteId) return false;
    const before = await store.content(plan.noteId);
    const taken = takeSuggested(before, item.listItemId);
    return taken.ok && await store.putContent(plan.noteId, taken.html, before);
}

/**
 * An answer naming a task the step didn't show: unchanged when the task is in the Journal and
 * already closed (a re-run, after the first run moved or finished it), else not offered.
 */
async function notShown(store: NoteStore, now: Date, entry: Omit<Written, "status">, written: Written[], skipped: Skipped[]) {
    const { docs } = await loadJournal(store);
    const exists = docs.some((doc) => [ ...doc.itemIds.values() ].includes(entry.id ?? ""));
    const live = openTasks(docs, scanDocs(docs, TRILIUM_CONFIG, now)).some((task) => task.listItemId === entry.id);
    if (exists && !live) written.push({ ...entry, status: "unchanged" });
    else skipped.push({ ...entry, reason: "not_offered" });
}

/** The note holding the list item `listItemId`, anywhere in the Journal. */
async function noteOf(store: NoteStore, listItemId: string): Promise<string | null> {
    for (const doc of (await loadJournal(store)).docs) {
        if ([ ...doc.itemIds.values() ].includes(listItemId)) return doc.noteId;
    }
    return null;
}

/**
 * The acts with the third as the evening's own act: the evening's calendar events and his evening
 * tasks in time order, each name once ("Call Mom, then Laundry."), or "Nothing planned." without any.
 */
function withEveningAct(acts: Prose["acts"], plan: Awaited<ReturnType<typeof readPlan>>, header: { workEnd: string; events: { start: string; title: string }[]; work: { start: string; label: string }[] }, opts: { worked?: boolean } = {}) {
    const tasks = listOf(plan, opts).filter((task) => task.evening)
        .map((task) => ({ at: header.work.find((block) => block.label === task.label)?.start ?? "99:99", name: task.text }));
    const events = header.events.filter((event) => event.start >= header.workEnd).map((event) => ({ at: event.start, name: event.title }));
    const named = new Set<string>();
    const items = [ ...events, ...tasks ].sort((a, b) => a.at.localeCompare(b.at)).map((item) => item.name).filter((name) => {
        const same = name.replace(/\s+/g, " ").trim().toLowerCase();
        if (named.has(same)) return false;
        named.add(same);
        return true;
    });
    const [ first, second ] = acts;
    if (!first || !second) return acts;
    const text = items.length ? t("caius.brief.evening_act", { items: items.join(t("caius.brief.evening_then")) }) : t("caius.brief.evening_empty");
    return [ first, second, { range: t("caius.brief.evening_range"), text } ];
}

/** The day's drawing: its span from the rhythm, the calendar's events and his list laid out between them. */
function headerOf(plan: Awaited<ReturnType<typeof readPlan>>, read: DayRead, date: string, now: Date, opts: { worked?: boolean } = {}) {
    const { start, end, workEnd } = read.rhythm;
    const events = drawnEvents(read);
    return { start, end, workEnd, events, work: workBlocks(plan, { start, end, workEnd }, events, date, now, opts).work };
}

/** A ticket candidate as its Suggested line, the one shape `caius_add` writes. */
function suggestedLine(candidate: Candidate): string {
    return `Get ${candidate.key ? `${candidate.key} ` : ""}${candidate.title ?? candidate.text} done: because ${candidate.because} (~${candidate.minutes}m)`;
}

/** Files a library result under written (a write, or `duplicate`/`already_moved`/`unchanged`: already there) or skipped. */
function record(written: Written[], skipped: Skipped[], entry: Omit<Written, "status">, result: unknown) {
    const r = (result ?? { status: "failed", error: "no result" }) as { status: string; reason?: string; detail?: string; error?: string };
    if (r.status === "skipped" && [ "duplicate", "already_moved", "already_done", "already_cancelled" ].includes(r.reason ?? "")) {
        written.push({ ...entry, status: "unchanged" });
    } else if (r.status === "skipped" || r.status === "failed") {
        skipped.push({ ...entry, reason: r.reason ?? "failed", ...(r.detail ?? r.error ? { detail: r.detail ?? r.error } : {}) });
    } else {
        written.push({ ...entry, status: r.status === "unchanged" ? "unchanged" : "written" });
    }
}

/**
 * Writes the brief: his prose, the picks from his list in its order (evening tasks apart), the
 * Follow up and Heads-up from the step data in place of any the agent wrote, the drawing and the
 * weather.
 */
async function briefOf(deps: ApplyDeps, input: { date: string; brief: Prose }, read: DayRead, reasons: Map<string, Candidate>, jira: DayRead["inputs"]["jira"], headsUp: string[], weather: DayWeather | undefined) {
    const { store, now } = deps;
    const plan = await readPlan(store, "day", input.date, now);
    const picks: BriefPick[] = listOf(plan).filter((task) => !task.evening).slice(0, MAX_PICKS).map((task) => {
        const reason = task.keys.map((key) => reasons.get(key)).find((candidate) => candidate && candidate.kind !== "week");
        return { text: task.text, minutes: task.minutes, ...(reason ? { because: reason.because } : {}) };
    });
    const followUps = followUpsOf(jira);
    // Follow up and Heads-up are written from the step data, in place of anything the agent wrote under them.
    const followUpTitle = t("caius.daily.follow_up");
    const headsUpTitle = t("caius.daily.heads_up");
    const sections = [
        ...(followUps.length ? [ { title: followUpTitle, markdown: followUps.map((f) => `- ${f.sentence}`).join("\n") } ] : []),
        ...(headsUp.length ? [ { title: headsUpTitle, markdown: headsUp.map((line) => `- ${line}`).join("\n") } ] : []),
        ...input.brief.sections.filter((section) => ![ followUpTitle, headsUpTitle ].some((title) => sameTitle(section.title) === sameTitle(title)))
    ];
    const header = headerOf(plan, read, input.date, now);
    const result = await writeBrief({
        store,
        draw: (noteId) => drawHeader(noteId, header, weather).attachmentId,
        render: deps.render,
        plannedAt: deps.plannedAt,
        ...(weather ? { weather } : {})
    }, {
        date: input.date, headline: input.brief.headline, acts: withEveningAct(input.brief.acts, plan, header), picks, sections, header,
        followUps: followUps.map(({ key, commentId }) => ({ key, commentId }))
    });
    if (result.error !== undefined) return { error: result.error, detail: result.detail };
    if (!("writes" in result) || !result.writes) return { error: "failed", detail: "the brief was not written" };
    const { briefNoteId, headerNoteId, attachmentId, plannedAt, writes } = result;
    return { briefNoteId, headerNoteId, attachmentId, plannedAt, writes, picks };
}
