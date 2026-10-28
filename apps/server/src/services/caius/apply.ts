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
    overlapPairs,
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

import { ANSWERED_LABEL, ASK_SEEN_LABEL, ASKED_LABEL, type BriefPick, DECLINED_LABEL, FOCUS_LABEL, HELD_GROUP_LABEL, HELD_LABEL, findBrief, rewritePicks, SETTLED_LABEL, NOT_TODAY_LABEL, redrawHeader, sameTitle, WEATHER_LABEL, WOUND_DOWN_LABEL, writeBrief } from "./brief.js";
import {
    catchupOf,
    closingLines,
    closingPeriods,
    heldDays,
    heldValueOf,
    dateLabel,
    dayLabels,
    proposedForward,
    dayKey,
    type DayRead,
    EVENING_ID,
    drawnEvents,
    failedCalendar,
    focusOf,
    followUpsOf,
    HEAVY_ID,
    latestAsks,
    lineIdOf,
    listItems,
    listOf,
    mainTasks,
    type NamedDay,
    namedDays,
    nextAsked,
    plainText,
    planFromOf,
    localDay,
    nextOffer,
    overlapIdOf,
    planDay,
    planOffer,
    present,
    type StepDeps,
    stillOpen,
    weekdayName,
    windDownTarget,
    withTaken,
    withDateLabels,
    withoutMoveLinks,
    workBlocks
} from "./daily.js";
import { isInputWarning } from "./inputs/index.js";
import { hisWord, isRef, type Named, refOf, resolveIn, resolveName, saidAnswered, saidFates, saysPhrase, withRefs } from "./refs.js";
import { inHisVoice, sayOf } from "./say.js";
import type { PlanApplyInput, WindDownApplyInput } from "./schemas.js";
import { readAttachment, removeLabel } from "./store.js";
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
    if (!prose) return asked.move.length ? reorder(deps, asked, read, weather) : contextOnly(deps, asked);

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
        // An ask offered today is a Follow up from tomorrow on.
        await labelDay(store, date, ASK_SEEN_LABEL, offer.offeredAsks);
        // A forward may name only a task the steps showed, and only a day, week or month they listed.
        const { tasks: catchupTasks, held: heldTasks } = await catchupOf(store, date, now);
        const shown = new Set([
            offer.forwardSuggestion?.listItemId, ...offer.candidates.map((c) => c.listItemId), ...catchupTasks.map((t) => t.listItemId),
            ...listItems(offer.day.plan).map((item) => item.listItemId)
        ].filter((id): id is string => !!id));
        const listed = namedDays(date, dayKey(nextWorkday(localDay(date))));
        const listedTo = listedOf(listed);
        // Every ref and name is read against the step data as it stands before the first write.
        // A held task can be named, to settle it, but no catch-up moves it.
        const pools = planPools(offer, [ ...catchupTasks, ...heldTasks ], listed.days);
        const { table, items, copies, collided } = await refTable(store, now, known, offer.day.live, offer.carry.map((line) => line.line), read.context.map((line) => line.text), read.inputs.jira);
        pools.settled = settledOf(items, (item) => item.period === date, copies);
        const input = planAnswers(asked, pools, skipped, table, copies, collided);
        input.dismiss = withHisWord(asked.said, [ ...input.dismiss, ...answeredIn(asked.said, offer.jira, input.dismiss) ], skipped);
        const followed = new Map([ ...input.follows ].map(([ id, copy ]) => [ id, copy.text ]));
        /** The result with `say`, its entries named by their text first. */
        const answer = <R extends { written: Written[]; skipped: Skipped[] }>(result: R) => {
            withTexts([ ...result.written, ...result.skipped ], pools, known, followed);
            const askedIds = new Set(planAsks.flatMap((ask) => ask.ids));
            const stillHeld = heldTasks.filter((task) => task.listItemId && !input.done.includes(task.listItemId) && !askedIds.has(task.listItemId))
                .map(({ text, period }) => ({ text, period }));
            const textOf = (id: string) => heldTasks.find((task) => task.listItemId === id)?.text ?? "";
            const asking = planAsks.map((ask) => ({ intent: ask.intent, texts: ask.ids.map(textOf).filter((text) => text !== "") }));
            return withDateLabels({ ...result, say: sayOf(result, { day: date, held: stillHeld, asking, already: input.already }) });
        };

        // What he finished is ticked where it is, his list or a catch-up day, before the catch-up moves anything.
        const onList = new Set([
            ...listItems(offer.day.plan).map((item) => item.listItemId), ...[ ...catchupTasks, ...heldTasks ].map((task) => task.listItemId), ...followed.keys()
        ]);
        await guarded({ kind: "done" }, skipped, async () => {
            const states = await loadStateSymbols(store);
            for (const listItemId of input.done) {
                const noteId = onList.has(listItemId) ? await noteOf(store, listItemId) : null;
                if (!noteId) {
                    if (pools.settled.some((item) => item.id === listItemId)) written.push({ kind: "done", id: listItemId, status: "unchanged" });
                    else skipped.push({ kind: "done", text: listItemId, reason: "not_on_list" });
                    continue;
                }
                const [ result ] = await setStates(store, "done", [ { noteId, listItemId } ], { states });
                record(written, skipped, { kind: "done", id: listItemId }, result);
            }
        });
        // A held task he named is settled; a hold that narrows to one releases it. Holds are settled on
        // every note they were given on, against what is open anywhere in the Journal.
        const liveIds = new Set(items.filter((item) => !item.settled).map((item) => item.id));
        const kept = new Set<string>();
        // planAsks is filled here and read by `answer`, which runs after.
        const planAsks: HoldGroup[] = [];
        const released: string[] = [];
        for (const day of await heldDays(store)) {
            const settled = await settleHolds(store, day, liveIds, new Map(input.done.map((id) => [ id, "done" ] as const)), [], (id) => items.find((item) => item.id === id)?.period);
            for (const id of settled.held) kept.add(id);
            planAsks.push(...settled.asks);
            released.push(...settled.released);
        }
        for (const task of [ ...heldTasks ]) if (task.listItemId && !kept.has(task.listItemId)) heldTasks.splice(heldTasks.indexOf(task), 1);
        // A released item comes to today, as a wind-down's freed item goes to its target day: the catch-up
        // never moves a held item, and once its siblings are settled the walk can stop short of its day.
        await guarded({ kind: "fate" }, skipped, async () => { for (const id of released) {
            const item = items.find((candidate) => candidate.id === id);
            const to = proposedForward(item?.period ?? "", date);
            const noteId = item?.item?.noteId;
            if (!item || !to || !noteId) continue;
            const [ result ] = await forwardTasks(store, [ { noteId, listItemId: id, to } ], {});
            record(written, skipped, { kind: "fate", id, text: item.text, detail: to }, result);
        } });

        if (asked.acts) skipped.push({ kind: "acts", reason: "not_a_move", detail: "Acts go with a call that only moves items of his list" });
        await guarded({ kind: "catchup" }, skipped, () => catchup(store, date, now, input.catchup, written, skipped));

        // What the catch-up moves here can be placed by the id it had on its own day.
        const moved = new Map(input.catchup === "move_all" ? catchupTasks.flatMap((task) => task.listItemId ? [ [ task.listItemId, { text: task.text, noteId: task.noteId } ] as const ] : []) : []);
        await acceptAll(store, date, now, input, { known, moved }, written, skipped);

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
        await guarded({ kind: "dismiss" }, skipped, () => dismiss(store, date, now, input.dismiss.map((c) => c.candidateId), known, read.inputs.jira.asks, written, skipped));
        await guarded({ kind: "suggested" }, skipped, () => shelve(store, date, now, offer.candidates, input, written, skipped));
        await guarded({ kind: "evening" }, skipped, () => eveningAndContext(store, date, now, input, written, skipped, { tomorrow: true, events: eveningEvents(read) }));
        // A meeting he isn't taking leaves the Meetings block and the drawing written below.
        let taken = read;
        await guarded({ kind: "overlap" }, skipped, async () => {
            const declined = await takeOverlaps(store, date, now, read, asked.said, input.overlaps, written, skipped);
            taken = { ...read, inputs: withTaken(read.inputs, declined, read.rhythm) };
        });

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
                record(written, skipped, { kind: "meetings" }, await setMeetings(store, { date, lines: meetingLines(taken.inputs.calendar) }, {}));
                await recordFocus(store, date, taken);
            });
        }

        // A pick's reason is its candidate's, live or not, so a re-run words the brief the same.
        const reasons = new Map(dayCandidates({ jira: read.inputs.jira, week: offer.day.week, live: new Map(), exclude: offer.day.closed })
            .map(present).map((candidate) => [ candidate.candidateId, candidate ]));
        const answered = new Set(written.filter((entry) => entry.kind === "dismiss" && entry.id).map((entry) => entry.id));
        const brief = await briefOf(deps, { date, brief: prose }, taken, reasons, { ...offer.jira, asks: offer.jira.asks.filter((ask) => !answered.has(ask.ticket.key)) }, offer.headsUp, weather)
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
    const result = await deps.locked("caius_winddown_apply", async () => {
        const { store, now } = deps;
        const unreadable = await unreadableDay(store, [ date, targetDay ]);
        if (unreadable) return unreadable;
        const written: Written[] = [];
        const skipped: Skipped[] = [];
        const open = await stillOpen(store, date, targetDay);
        const { facts, candidates, asks, offeredAsks, jira } = await nextOffer(store, targetDay, now, read);
        const lines = await closingLines(store, date, targetDay, read);
        await labelDay(store, date, ASKED_LABEL, [ ...lines.keep, ...lines.carry ].map((line) => line.lineId));
        // The next step's questions are about the next workday, so they are answered on its note.
        await labelDay(store, targetDay, ASKED_LABEL, nextAsked(asks));
        await labelDay(store, targetDay, ASK_SEEN_LABEL, offeredAsks);
        const known = new Map([
            ...dayCandidates({ jira: read.inputs.jira, week: facts.week, live: facts.live, exclude: [ ...facts.plan.dismissed, ...facts.closed ] }).map(present),
            ...candidates
        ].map((candidate) => [ candidate.candidateId, candidate ]));

        const states = await loadStateSymbols(store);
        // An answer may name only an item the open step showed, and only a day, week or month it listed.
        const shownItems = new Set(open.items.map((item) => item.listItemId).filter((id): id is string => !!id));
        const listed = namedDays(date, targetDay);
        const listedTo = listedOf(listed);
        // Every ref and name is read against the step data as it stands before the first write.
        const pools: Pools = {
            open: named(withRefs(open.items, "o", (item) => item.listItemId), (item) => item.listItemId, (item) => item.text),
            candidates: named(withRefs(candidates, "c", (c) => c.candidateId), (c) => c.candidateId, (c) => c.text),
            list: named(withRefs(listItems(facts.plan), "l", (item) => item.listItemId), (item) => item.listItemId, (item) => item.text),
            lines: named(withRefs([ ...lines.keep, ...lines.carry ], "x", (line) => line.lineId), (line) => line.lineId, (line) => line.line),
            days: dayNames(listed.days),
            settled: [],
            taken: []
        };
        const { table, items, copies, collided } = await refTable(store, now, known, facts.live, [ ...lines.keep, ...lines.carry ].map((line) => line.line), read.context.map((line) => line.text), read.inputs.jira);
        // A re-run's words can name what is settled on the day, or what an earlier wind-down of it settled.
        const closingNote = await findPeriodNote(store, "day", date);
        const settledBefore = new Set(closingNote ? closingNote.attributes.filter((a) => a.type === "label" && a.name === SETTLED_LABEL).map((a) => a.value) : []);
        pools.settled = settledOf(items, (item) => item.period === date || settledBefore.has(item.id), copies);
        const input = windDownAnswers(asked, pools, skipped, table, copies, collided);
        // A fate he named in his own words that the call left out is applied as he named it.
        const answered = new Set([ ...input.done, ...input.fates.map((fate) => fate.listItemId), ...input.held ]);
        input.fates.push(...saidFates(asked.said, pools.open, pools.days).filter((fate) => !answered.has(fate.listItemId)));
        input.dismiss = withHisWord(asked.said, [ ...input.dismiss, ...answeredIn(asked.said, jira, input.dismiss) ], skipped);
        // The ref table covers the Journal, so a held item that lives outside the window is read from it.
        const journalItem = (id: string) => items.find((item) => item.id === id);
        // The open items and the ref table carry their note; only an id from elsewhere needs the Journal searched.
        const noteFor = async (listItemId: string) => open.items.find((item) => item.listItemId === listItemId)?.noteId
            ?? journalItem(listItemId)?.item?.noteId ?? await noteOf(store, listItemId);
        // A moved item he named is followed to its live copy, which the writes act on as if shown.
        const followed = new Map([ ...input.follows ].map(([ id, copy ]) => [ id, copy.text ]));
        for (const id of followed.keys()) shownItems.add(id);
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

        // An item an ambiguous answer matched stays where it is, on this call and later ones, until a
        // call names it: he named it, but which one is unclear.
        const namedNow = new Map<string, string>([
            ...input.done.map((id) => [ id, "done" ] as const), ...input.fates.map((fate) => [ fate.listItemId, "fate" ] as const),
            ...input.move.map((ref) => [ ref.listItemId, "move" ] as const)
        ]);
        const openIds = new Set(open.items.flatMap((item) => item.listItemId ? [ item.listItemId ] : []));
        // A hold's items can live on several days, so whether one is still open is read across the Journal.
        const liveIds = new Set(items.filter((item) => !item.settled).map((item) => item.id));
        const periodOf = (id: string) => journalItem(id)?.period;
        const { held, asks: holdAsks, released } = await settleHolds(store, date, liveIds, namedNow, input.heldGroups, periodOf);
        // An item an earlier wind-down held stays held too, settled on the note the hold was given on.
        const heldElsewhere: string[] = [];
        for (const day of (await heldDays(store)).filter((day) => day !== date)) {
            const settled = await settleHolds(store, day, liveIds, namedNow, [], periodOf);
            heldElsewhere.push(...settled.held);
            holdAsks.push(...settled.asks);
            released.push(...settled.released);
        }
        const allHeld = [ ...held, ...heldElsewhere ];
        // A fate he named, then the proposed one for every item he didn't name and isn't held.
        const given = new Set([ ...input.done, ...input.fates.map((fate) => fate.listItemId), ...allHeld ]);
        // A released item outside the window gets the fate its own window would propose.
        const freed = released.filter((id) => !openIds.has(id) && !given.has(id)).flatMap((id) => {
            const to = proposedForward(journalItem(id)?.period ?? "", targetDay);
            return to ? [ { listItemId: id, to, proposed: true } ] : [];
        });
        for (const fate of freed) shownItems.add(fate.listItemId);
        const putOffWeek: string[] = [];
        const fates = [
            ...input.fates,
            ...open.items.filter((item) => item.listItemId && !given.has(item.listItemId) && "forward" in item.fate)
                .map((item) => ({ listItemId: item.listItemId ?? "", to: (item.fate as { forward: string }).forward, proposed: true })),
            ...freed
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
            // An item already in the period he sends it to is in place, as a repeated correction finds it.
            if (!("proposed" in fate) && open.items.some((item) => item.listItemId === fate.listItemId && item.period === to)) {
                written.push({ ...entry, status: "unchanged" });
                continue;
            }
            // A task he sends to a week is put off there, so its week item isn't offered for two workdays.
            if (!("proposed" in fate) && PERIODS.week.pattern.test(to)) {
                const text = open.items.find((item) => item.listItemId === fate.listItemId)?.text ?? journalItem(fate.listItemId)?.text;
                const key = text ? keysOf(text)[0] : undefined;
                if (key) putOffWeek.push(key);
            }
            const [ result ] = await forwardTasks(store, [ { noteId, listItemId: fate.listItemId, to } ], {});
            record(written, skipped, entry, result);
        }
        await labelDay(store, date, NOT_TODAY_LABEL, putOffWeek);
        });
        await labelDay(store, date, SETTLED_LABEL, written.filter((entry) => (entry.kind === "done" || entry.kind === "fate") && entry.status === "written" && entry.id).map((entry) => entry.id ?? ""));

        // What the fates move to the next workday can be placed by the id it had here; nothing else
        // can, a held item least of all, since it stays here.
        const toTarget = (item: (typeof open.items)[number]) => {
            if (!item.listItemId || input.done.includes(item.listItemId) || allHeld.includes(item.listItemId)) return false;
            const fate = input.fates.find((f) => f.listItemId === item.listItemId);
            return fate ? fate.to === targetDay : "forward" in item.fate && item.fate.forward === targetDay;
        };
        const moved = new Map(open.items.filter(toTarget).map((item) => [ item.listItemId ?? "", { text: item.text, noteId: item.noteId } ] as const));
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
        await guarded({ kind: "dismiss" }, skipped, () => dismiss(store, targetDay, now, input.dismiss.map((c) => c.candidateId), known, read.inputs.jira.asks, written, skipped));
        await guarded({ kind: "suggested" }, skipped, () => shelve(store, targetDay, now, candidates, input, written, skipped));
        await guarded({ kind: "evening" }, skipped, () => eveningAndContext(store, targetDay, now, input, written, skipped, { events: eveningEvents(read) }));
        await guarded({ kind: "overlap" }, skipped, () => takeOverlaps(store, targetDay, now, read, asked.said, input.overlaps, written, skipped));
        if (!failedCalendar(read)) await recordFocus(store, targetDay, read);
        // The day is closed only when every item got its fate, so a later catch-up looks no further back.
        // The label holds the time of the first wind-down, which the nudge bar shows; a re-run keeps it.
        // A day keeps open while a hold given on it remains, or one given elsewhere covers an item that lives on it.
        const heldHere = allHeld.some((id) => open.items.some((item) => item.listItemId === id && item.period === date));
        const closed = !held.length && !heldHere && !skipped.some((entry) => entry.kind === "done" || entry.kind === "fate");
        if (closed) {
            const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
            if (!note.attributes.some((a) => a.type === "label" && a.name === WOUND_DOWN_LABEL)) await store.addLabel(note.noteId, WOUND_DOWN_LABEL, deps.plannedAt);
        }
        await pruneSettled(store, date, dayKey(now), closed);
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
        withTexts([ ...written, ...skipped ], pools, known, new Map([ ...followed, ...freed.map((fate) => [ fate.listItemId, journalItem(fate.listItemId)?.text ?? fate.listItemId ] as const) ]));
        const textOf = (id: string) => journalItem(id)?.text ?? "";
        const askedIds = new Set(holdAsks.flatMap((ask) => ask.ids));
        const heldTexts = allHeld.filter((id) => !askedIds.has(id)).flatMap((id) => {
            const item = journalItem(id);
            return item ? [ { text: item.text, period: item.period } ] : [];
        });
        const asking = holdAsks.map((ask) => ({ intent: ask.intent, texts: ask.ids.map(textOf).filter((text) => text !== "") }));
        const say = sayOf({ written, skipped }, { day: targetDay, held: heldTexts, asking, already: input.already });
        return {
            ...withDateLabels({ date, targetDay, written, skipped, next: morning ? "planday" : null, say: morning ? `${say} ${t("caius.say.next_planday")}` : say }),
            ...(morning ? { nextCall: { tool: "caius_planday", date: targetDay } } : {})
        };
    });
    if (!("nextCall" in result) || !result.nextCall) return result;
    // A morning Review goes straight on to today's plan: its steps run here, with what he already
    // answered, so the reply asks the plan's questions and never whether to plan.
    const answered = { evening: asked.evening, keep: [ ...asked.keep, ...asked.carry ].map((line) => line.lineId) };
    const catchup = await planDay(deps, { date: targetDay, step: "catchup" });
    const inputs = await planDay(deps, { date: targetDay, step: "inputs", answered });
    return { ...result, planday: { catchup, inputs } };
}

/**
 * A Plan my day call with only `move`: his list reordered and, when the order changes the picks, the
 * brief's picks, the drawing and the acts (his `acts`, or plain ones from the drawing) written again.
 * Nothing else is written.
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
        const { table, copies, collided } = await refTable(store, now, known, offer.day.live, offer.carry.map((line) => line.line), read.context.map((line) => line.text), read.inputs.jira);
        const input = planAnswers(asked, pools, skipped, table, copies, collided);
        const before = picksOf(offer.day.plan);
        await acceptAll(store, date, now, input, { known, moved: new Map() }, written, skipped);
        const plan = await readPlan(store, "day", date, now);
        if (picksOf(plan) !== before) {
            // The tool's own words follow the new order: the brief's picks, and the acts unless he sent them.
            const reasons = new Map(dayCandidates({ jira: read.inputs.jira, week: offer.day.week, live: new Map(), exclude: offer.day.closed })
                .map(present).map((candidate) => [ candidate.candidateId, candidate ]));
            await guarded({ kind: "picks", id: date }, skipped, async () => {
                const write = await rewritePicks(store, date, picksFor(plan, reasons));
                if (write) record(written, skipped, { kind: "picks", detail: date }, write.status === "updated" ? { status: "written" } : write);
            });
            // The acts he sent are kept where they name the drawing's work; the headline follows the new order.
            const given = (asked.acts ?? []).map((act) => typeof act === "string" ? { text: act } : act);
            const header = { acts: (drawn: ReturnType<typeof headerOf>) => drawnActs(drawn, given, titlesOf(plan)), headline: (drawn: ReturnType<typeof headerOf>) => asked.headline ?? orderHeadline(drawn) };
            if (failedCalendar(read)) skipped.push({ kind: "header", id: date, reason: "calendar_unavailable" });
            else await guarded({ kind: "header", id: date }, skipped, () => redraw(store, date, read, now, {}, weather, written, skipped, header));
        }
        withTexts([ ...written, ...skipped ], pools, known);
        return withDateLabels({ date, written, skipped, say: sayOf({ written, skipped }, { day: date, already: input.already }) });
    });
}

/** A Plan my day call with only `context`, as the retry of a line skipped as third person: those lines, and nothing else. */
async function contextOnly(deps: ApplyDeps, asked: PlanApplyInput) {
    const { date } = asked;
    return deps.locked("caius_plan_apply", async () => {
        const { store, now } = deps;
        const unreadable = await unreadableDay(store, [ date ]);
        if (unreadable) return unreadable;
        const written: Written[] = [];
        const skipped: Skipped[] = [];
        await guarded({ kind: "context" }, skipped, () => eveningAndContext(store, date, now, { evening: [], context: asked.context }, written, skipped, { tomorrow: true }));
        if (asked.acts) skipped.push({ kind: "acts", reason: "not_a_move", detail: "Acts go with a call that only moves items of his list" });
        return withDateLabels({ date, written, skipped, say: sayOf({ written, skipped }, { day: date }) });
    });
}

/** The brief's "Get done today": the first work tasks of his list, in order, each with its candidate's reason when it had one. */
function picksFor(plan: Awaited<ReturnType<typeof readPlan>>, reasons: Map<string, Candidate>): BriefPick[] {
    return listOf(plan).filter((task) => !task.evening).slice(0, MAX_PICKS).map((task) => {
        const reason = task.keys.map((key) => reasons.get(key)).find((candidate) => candidate && candidate.kind !== "week");
        return { text: task.text, minutes: task.minutes, ...(reason ? { because: reason.because } : {}) };
    });
}

/**
 * The header's first two acts from the drawing: its tasks before the end of work, whole (a task split
 * around a meeting is one), in two groups, each with its span ("10:15 to 12:15") and plain words
 * ("ZAP-101, then ZAP-110."), or open time without tasks. An act in `given` keeps its words, with the
 * drawing's span, when it names every task of its group, none of the other's and no other ticket.
 * A task is named by its key or by a word no other task's words have (`titles`, his list by bar
 * label). The third act, the evening, `withEveningAct` writes.
 */
function drawnActs(header: ReturnType<typeof headerOf>, given: { text: string }[] = [], titles: Map<string, string> = new Map()): Prose["acts"] {
    const tasks: { label: string; start: string; end: string }[] = [];
    for (const block of header.work.filter((work) => work.start < header.workEnd)) {
        const last = tasks.at(-1);
        if (!block.label && last) last.end = block.end;
        else tasks.push({ label: block.label, start: block.start, end: block.end });
    }
    const half = Math.ceil(tasks.length / 2);
    const groups = [ tasks.slice(0, half), tasks.slice(half) ];
    const acts = groups.map((group, i) => {
        const [ first ] = group;
        const last = group.at(-1);
        const from = i === 0 ? header.start : groups[0]?.at(-1)?.end ?? header.start;
        const plain = first && last
            ? { range: t("caius.brief.act_range", { start: first.start, end: last.end }), text: t("caius.brief.act_text", { items: group.map((task) => task.label).join(t("caius.brief.evening_then")) }) }
            : { range: t("caius.brief.act_range", { start: from, end: header.workEnd }), text: t("caius.brief.open_time") };
        const other = groups[1 - i] ?? [];
        const words = given[i]?.text.trim();
        const keys = new Set(group.map((task) => task.label));
        const names = (task: { label: string }) => !!words && namesTask(words, task.label, tasks.map((each) => each.label), titles);
        const fits = words && group.every(names) && !other.some(names) && keysOf(words).filter((key) => JIRA_KEY.test(key)).every((key) => keys.has(key));
        return fits ? { range: plain.range, text: words } : plain;
    });
    return [ ...acts, { range: "", text: "" } ];
}

/**
 * Whether an act's words name the task of bar `label`: its Jira key, or a word of four letters or
 * more from its words (`titles`, else the label) that no other task of `labels` has.
 */
function namesTask(text: string, label: string, labels: string[], titles: Map<string, string>): boolean {
    if (JIRA_KEY.test(label) && text.toUpperCase().includes(label)) return true;
    const wordsOf = (of: string) => (titles.get(of) ?? of).replace(/\S*…$/, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const said = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const others = new Set(labels.filter((other) => other !== label).flatMap(wordsOf));
    return wordsOf(label).some((word) => word.length >= 4 && !others.has(word) && said.has(word));
}

/** His list's words by bar label, which `drawnActs` reads an act's words against. */
function titlesOf(plan: Awaited<ReturnType<typeof readPlan>>, worked: { worked?: boolean } = {}): Map<string, string> {
    return new Map(listOf(plan, worked).map((task) => [ task.label, task.text ]));
}

/** A headline for a new order of the picks, from the drawing's labels: "ZAP-101 first, then ZAP-110 and ZAP-111." */
function orderHeadline(header: ReturnType<typeof headerOf>): string | undefined {
    const labels = header.work.filter((block) => block.start < header.workEnd && block.label).map((block) => block.label);
    const [ first, ...rest ] = labels;
    if (!first || !rest.length) return undefined;
    const tail = rest.at(-1) ?? "";
    return t("caius.brief.order_headline", { first, rest: rest.length > 1 ? t("caius.daily.list_and", { head: rest.slice(0, -1).join(", "), last: tail }) : tail });
}

/** The brief's picks of a plan as they read, in order: the first work tasks of his list. */
function picksOf(plan: Awaited<ReturnType<typeof readPlan>>): string {
    return listOf(plan).filter((task) => !task.evening).slice(0, MAX_PICKS).map((task) => task.text).join("\n");
}

/**
 * Draws the header of `day`'s brief again from its note: the drawing, and the acts checked against
 * it (`drawnActs`, from those `opts.acts` gives, else the ones written) with the Evening act as the
 * note now has it, and `opts.headline`'s headline when it gives one. With `worked`, as the day was
 * worked. A weather icon already drawn stays when no weather can be had.
 */
async function redraw(store: NoteStore, day: string, read: DayRead, now: Date, worked: { worked?: boolean }, fetched: DayWeather | undefined, written: Written[], skipped: Skipped[], opts: { acts?: (header: ReturnType<typeof headerOf>) => Prose["acts"]; headline?: (header: ReturnType<typeof headerOf>) => string | undefined } = {}) {
    const plan = await readPlan(store, "day", day, now);
    const header = headerOf(plan, read, day, now, worked);
    const draw = (noteId: string, weather: DayWeather | undefined) => drawHeader(noteId, header, weather ?? weatherOfSvg(readAttachment(noteId, "image", TERRAIN_TITLE) ?? "") ?? undefined).attachmentId;
    const acts = (kept: Prose["acts"]) => withEveningAct(opts.acts ? opts.acts(header) : drawnActs(header, kept, titlesOf(plan, worked)), plan, header, worked);
    const write = await redrawHeader(store, day, draw, acts, fetched, opts.headline?.(header));
    if (write) record(written, skipped, { kind: "header", detail: day }, write.status === "updated" ? { status: "written" } : write);
}

/** What Plan my day's answers name their items from: the step data of `catchup` and `inputs`, with their refs. */
function planPools(offer: Awaited<ReturnType<typeof planOffer>>, catchupTasks: Awaited<ReturnType<typeof catchupOf>>["tasks"], days: NamedDay[]): Pools {
    return {
        open: named(withRefs(catchupTasks, "o", (task) => task.listItemId), (task) => task.listItemId, (task) => task.text),
        candidates: named(withRefs(offer.candidates, "c", (c) => c.candidateId), (c) => c.candidateId, (c) => c.text),
        list: named(withRefs(listItems(offer.day.plan), "l", (item) => item.listItemId), (item) => item.listItemId, (item) => item.text),
        lines: named(withRefs(offer.carry, "x", (line) => line.lineId), (line) => line.lineId, (line) => line.line),
        days: dayNames(days),
        settled: [],
        // A candidate already taken is on his list by its key.
        taken: listItems(offer.day.plan).flatMap((item) => {
            const key = keysOf(item.text).find((k) => JIRA_KEY.test(k));
            return key ? [ { id: key, ref: "", text: item.text } ] : [];
        })
    };
}

/** The settled items `within` takes, done, moved or dropped, as names a re-run's answer can give. */
function settledOf(items: (RefEntry & { period: string })[], within: (item: RefEntry & { period: string }) => boolean, copies: Copies): Named[] {
    const byId = new Map(items.map((item) => [ item.id, item ]));
    // A carried item and its copies are one item: one name for each chain, whichever copy it ends at.
    const chains = new Map<string, Named>();
    for (const item of items.filter((candidate) => candidate.settled && within(candidate))) {
        const end = chainEnd(item, byId, copies)?.id ?? item.id;
        if (!chains.has(end)) chains.set(end, { id: item.id, ref: "", text: item.text });
    }
    return [ ...chains.values() ];
}

/** Where a moved item's forwards lead: the last copy along its back links, or the item itself when it wasn't moved. */
function chainEnd(entry: RefEntry, byId: Map<string, RefEntry>, copies: Copies): RefEntry | undefined {
    let at: RefEntry | undefined = entry;
    for (let hops = 0; at?.item?.moved && hops < 5; hops++) {
        const copy = copies.get(copyKey(at.item.noteId, at.text));
        at = copy ? byId.get(copy.id) : undefined;
    }
    return at;
}

/** The days and weeks an answer can send a task to, by ref or his words. */
function dayNames(days: NamedDay[]): Named[] {
    return named(days, (day) => "date" in day ? day.date : day.week, (day) => "date" in day ? dateLabel(day.date) ?? day.date : day.name)
        .map((day) => ({ ...day, ...(WEEK_PHRASES[day.ref] ? { aliases: WEEK_PHRASES[day.ref] } : {}) }));
}

/** The phrases that name a week ref outright; "week" alone could be either. */
const WEEK_PHRASES: Record<string, string[]> = { w1: [ "later this week", "this week" ], w2: [ "next week" ] };

/** Every day, week and month the steps listed for a task to go to. */
function listedOf(listed: ReturnType<typeof namedDays>): Set<string> {
    return new Set<string>([ ...listed.days.map((d) => "date" in d ? d.date : d.week), ...listed.weeks.map((w) => w.week), ...listed.months.map((m) => m.month) ]);
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
    /** Items already settled, which a re-run's done or fate answer finds in place. */
    settled: Named[];
    /** His list by its keys, which a re-run's accept finds in place. */
    taken: Named[];
}

/** `items` as names an answer can give: each with its id, ref and plain text; an item without an id or ref can't be named. */
function named<T extends { ref?: string }>(items: T[], id: (item: T) => string | null | undefined, text: (item: T) => string): Named[] {
    return items.flatMap((item) => {
        const value = id(item);
        return value && item.ref ? [ { id: value, ref: item.ref, text: plainText(withoutMoveLinks(text(item))) } ] : [];
    });
}

/** What a ref named when its step ran: the item's id and text, and whether it is settled since. */
interface RefEntry {
    id: string;
    text: string;
    settled: boolean;
    /** A list item's state, note and period, and the note its back link points at, if any. */
    item?: { state: string; moved: boolean; noteId: string; period: string; from: string | null };
}

/** The live copies of moved items, by the note their back link points at and their words. */
type Copies = Map<string, { id: string; period: string; text: string }>;

/**
 * A copy's key: the note it came from and its words without an estimate, which a moved source keeps
 * in its text, or the reason a drop adds to it (`_not needed_`).
 */
const copyKey = (from: string, text: string) => `${from}\n${text.replace(/\s+_[^_]+_$/, "").replace(/\s+~\d+(?:h\d*m?|m)\b/g, "").trim()}`;

/**
 * Every item a step's ref could have named, by ref, whatever happened to it since: each list item
 * of the Journal in any state (settled once done, moved or dropped), each ticket of the day's Jira
 * read and each candidate the day knows (settled once its key is live on a list, as an accepted
 * one is), and each Context line offered or in force (settled once in force). A ticket that has
 * left Jira since is in none of them. `copies` finds the live copy of a moved item.
 */
async function refTable(store: NoteStore, now: Date, known: Map<string, Candidate>, live: Map<string, string[]>, offered: string[], inForce: string[], jira: DayRead["inputs"]["jira"]) {
    const table = new Map<string, RefEntry>();
    /** A ref two different items hash to names neither: it stays out of the table, in `collided`. */
    const collided = new Map<string, RefEntry[]>();
    const put = (ref: string, entry: RefEntry) => {
        const seen = table.get(ref) ?? collided.get(ref)?.[0];
        if (seen && seen.id !== entry.id) {
            collided.set(ref, [ ...(collided.get(ref) ?? [ seen ]), entry ]);
            table.delete(ref);
            return;
        }
        if (!collided.has(ref)) table.set(ref, entry);
    };
    const items: (RefEntry & { period: string })[] = [];
    const copies: Copies = new Map();
    const { docs } = await loadJournal(store);
    const byPath = new Map(docs.map((doc) => [ doc.path, doc ]));
    for (const task of scanDocs(docs, TRILIUM_CONFIG, now).tasks) {
        const doc = byPath.get(task.file);
        const id = doc?.itemIds.get(task.line);
        if (!doc || !id) continue;
        const period = /^Journal\/\w+\/([^/]+?)(?:\.md|\/)/.exec(task.file)?.[1] ?? "";
        const from = /\[from [^\]]*\]\(#root\/([^)]+)\)/.exec(task.text)?.[1] ?? null;
        // A moved task is told by its "scheduled" link too, since its checked box reads as done where the Rescheduled state isn't known.
        const moved = task.state === "tombstone" || /_scheduled \[[^\]]*\]\(#root\/[^)]*\)_/.test(task.text);
        const entry = { id, text: plainText(withoutMoveLinks(task.text)), settled: !task.live, item: { state: task.state, moved, noteId: doc.noteId, period, from } };
        put(refOf("o", id), entry);
        put(refOf("l", id), entry);
        items.push({ ...entry, period });
        if (from) copies.set(copyKey(from, entry.text), { id, period, text: entry.text });
    }
    const tickets = dayCandidates({ jira: { ...jira, done: [] }, live: new Map(), exclude: [] }).map(present);
    for (const candidate of [ ...tickets, ...known.values() ]) {
        put(refOf("c", candidate.candidateId), { id: candidate.candidateId, text: candidate.text, settled: live.has(candidate.candidateId) });
    }
    for (const text of offered) put(refOf("x", lineIdOf(text)), { id: lineIdOf(text), text, settled: false });
    for (const text of inForce) put(refOf("x", lineIdOf(text)), { id: lineIdOf(text), text, settled: true });
    return { table, items, copies, collided };
}

/**
 * Reads the names of one answer: the id each names, its own value when it names nothing the steps
 * showed (the write then says why), or null when it names several, skipped as ambiguous, or a ref
 * whose item left its pool since the step, skipped as stale. With `hold`, `held` collects the ids an
 * ambiguous answer matched, which nothing may write for.
 */
function nameReader(skipped: Skipped[], table: Map<string, RefEntry>, copies: Copies = new Map(), collided: Map<string, RefEntry[]> = new Map()) {
    const held = new Set<string>();
    /** The items each holding answer matched, together. */
    const groups: HoldGroup[] = [];
    const follows = new Map<string, { source: string; period: string; text: string }>();
    /** The answers found already settled, which `say` names: what, and how it was settled. */
    const already: Already[] = [];
    const byId = new Map([ ...table.values() ].map((entry) => [ entry.id, entry ]));
    /**
     * What an answer of `kind` does with an item that left its pool: a done item is in place for a
     * done answer; a moved one is followed to its live copy; a candidate on his list or a line in
     * force is in place. Null for anything else, which is stale.
     */
    const settle = (entry: RefEntry, intent: string): string | null => {
        if (!entry.item) {
            if (entry.settled && intent === "accept") already.push({ text: entry.text, how: "taken" });
            return entry.settled ? entry.id : null;
        }
        const at = chainEnd(entry, byId, copies);
        if (!at?.item) return null;
        if (!at.settled) {
            if (at !== entry) follows.set(at.id, { source: entry.id, period: at.item.period, text: at.text });
            return at.id;
        }
        // The chain ends settled: in place only when that is what he asks for, a done item called done or a dropped one dropped.
        if (at.item.moved) return null;
        if (at.item.state === "done" && intent === "done") {
            already.push({ text: at.text, how: "done" });
            return at.id;
        }
        if (at.item.state === "cancelled" && intent === "drop") {
            already.push({ text: at.text, how: "dropped" });
            return at.id;
        }
        return null;
    };
    const read = (kind: string, value: string, pools: Named[][], fallback: Named[][] = [], hold = false, intent = kind): string | null => {
        // A ref that isn't in its pool any more names a settled item, which the write finds in place
        // or follows to its copy, or one the step showed and that has left since: never another item.
        const ref = value.trim().toLowerCase();
        if (isRef(ref) && !pools.some((pool) => pool.some((item) => item.ref.toLowerCase() === ref))) {
            const shared = collided.get(ref);
            if (shared) {
                skipped.push({ kind, text: value, reason: "ambiguous", detail: shared.map((entry) => entry.text).join("; ") });
                return null;
            }
            const entry = table.get(ref);
            const id = entry ? settle(entry, intent) : null;
            if (id) return id;
            skipped.push({ kind, ...(entry ? { text: entry.text } : {}), reason: "stale" });
            return null;
        }
        // A name that matches nothing open can name what an earlier run already settled.
        const open = resolveIn(pools, value);
        const found = open ?? resolveIn(fallback, value);
        if (found && "ambiguous" in found) {
            skipped.push({ kind, text: value, reason: "ambiguous", detail: found.ambiguous.join("; ") });
            if (hold) {
                for (const id of found.ids) held.add(id);
                groups.push({ intent: kind, ids: found.ids });
            }
            return null;
        }
        if (found && !open) {
            const entry = byId.get(found.id);
            // A key already on his list: the accept is in place.
            if (!entry) already.push({ text: [ ...fallback.flat() ].find((item) => item.id === found.id)?.text ?? found.id, how: "taken" });
            const id = entry ? settle(entry, intent) : found.id;
            if (id) return id;
            skipped.push({ kind, text: entry?.text ?? value, reason: "stale" });
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
    return { read, place, held, groups, follows, already };
}

/** An answer found already settled: the item's words, and how. */
interface Already {
    text: string;
    how: "done" | "dropped" | "moved" | "taken";
}

/**
 * Plan my day's answers with every name read as the id it names; an ambiguous one is left out,
 * skipped. `done` holds the items of his list or the catch-up that `finished` names: by a ticket
 * key, or by anything else he called done.
 */
function planAnswers(input: PlanApplyInput, pools: Pools, skipped: Skipped[], table: Map<string, RefEntry>, copies?: Copies, collided?: Map<string, RefEntry[]>): PlanApplyInput & { done: string[]; follows: Follows; already: Already[] } {
    const { read, place, follows, already } = nameReader(skipped, table, copies, collided);
    const { done, finished } = doneOf([], input.finished, [ pools.list, pools.open ], [ pools.settled ], read);
    const onList = [ pools.list, pools.candidates, pools.open ];
    const candidate = (kind: string) => (ref: { candidateId: string }) => {
        const id = read(kind, ref.candidateId, [ pools.candidates ]);
        return id === null ? [] : [ { ...ref, candidateId: id } ];
    };
    return {
        ...input,
        done,
        finished,
        follows,
        already,
        accept: input.accept.flatMap((ref) => {
            const id = read("accept", ref.candidateId, [ pools.candidates ], [ pools.taken ]);
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

/**
 * Wind down's answers with every name read as the id it names; an ambiguous one is left out,
 * skipped, and the open items it matched are `held`: they keep no proposed fate either.
 */
function windDownAnswers(input: WindDownApplyInput, pools: Pools, skipped: Skipped[], table: Map<string, RefEntry>, copies?: Copies, collided?: Map<string, RefEntry[]>): WindDownApplyInput & { held: string[]; heldGroups: HoldGroup[]; follows: Follows; already: Already[] } {
    const { read, place, held, groups, follows, already } = nameReader(skipped, table, copies, collided);
    const onList = [ pools.list, pools.candidates, pools.open ];
    const candidate = (kind: string) => (ref: { candidateId: string }) => {
        const id = read(kind, ref.candidateId, [ pools.candidates ]);
        return id === null ? [] : [ { ...ref, candidateId: id } ];
    };
    const line = (kind: string) => (ref: { lineId: string }) => {
        const id = read(kind, ref.lineId, [ pools.lines ]);
        return id === null ? [] : [ { lineId: id } ];
    };
    const { done, finished } = doneOf(input.done, input.finished, [ pools.open ], [ pools.settled ], read);
    const open = new Set(pools.open.map((item) => item.id));
    return {
        ...input,
        done,
        finished,
        fates: input.fates.flatMap((fate) => {
            const id = read("fate", fate.listItemId, [ pools.open ], [ pools.settled ], true, fate.drop ? "drop" : "fate");
            const to = fate.to === undefined ? undefined : read("fate", fate.to, [ pools.days ]);
            // An item he sent somewhere unclear stays held: it never falls back to its proposed fate.
            if (to === null && id !== null) {
                held.add(id);
                groups.push({ intent: "fate", ids: [ id ] });
            }
            if (id === null || to === null) return [];
            // A moved item already where he sends it is in place: its source answers unchanged.
            const copy = follows.get(id);
            const item = copy && !fate.drop && copy.period === to ? copy.source : id;
            if (copy && item === copy.source) already.push({ text: copy.text, how: "moved" });
            return [ { ...fate, listItemId: item, ...(to === undefined ? {} : { to }) } ];
        }),
        accept: input.accept.flatMap((ref) => {
            const id = read("accept", ref.candidateId, [ pools.candidates ], [ pools.taken ]);
            const at = place("place", ref, onList);
            return id === null || at === null ? [] : [ { ...at, candidateId: id } ];
        }),
        move: input.move.flatMap((ref) => {
            const id = read("move", ref.listItemId, onList, [], true);
            const at = place("move", ref, onList);
            return id === null || at === null ? [] : [ { ...at, listItemId: id } ];
        }),
        keep: input.keep.flatMap(line("keep")),
        carry: input.carry.flatMap(line("carry")),
        notToday: input.notToday.flatMap(candidate("not_today")),
        dismiss: input.dismiss.flatMap(candidate("dismiss")),
        held: [ ...held ].filter((id) => open.has(id)),
        heldGroups: groups.map((group) => ({ ...group, ids: group.ids.filter((id) => open.has(id)) })).filter((group) => group.ids.length > 0),
        follows,
        already
    };
}

/** The live copies the answers followed moved items to, by copy id: the item named, the copy's period and words. */
type Follows = Map<string, { source: string; period: string; text: string }>;

/**
 * What he called done, read from `done` and `finished`: each done answer, each finished answer that
 * is not a Jira key, and the items each finished key names in `pools`, once: one item, or a work
 * item with its Answer task. `finished` keeps only the keys, which are recorded as finished whether
 * or not they name an item.
 */
function doneOf(said: string[], finished: string[], pools: Named[][], settled: Named[][], read: (kind: string, value: string, pools: Named[][], fallback?: Named[][], hold?: boolean) => string | null) {
    const keys = finished.filter((value) => JIRA_KEY.test(value));
    const done = new Set([ ...said, ...finished.filter((value) => !JIRA_KEY.test(value)) ].flatMap((value) => read("done", value, pools, settled, true) ?? []));
    for (const key of keys) {
        const pool = pools.find((candidates) => resolveName(candidates, key) !== null);
        const found = pool ? resolveName(pool, key) : null;
        if (!pool || !found) continue;
        if ("id" in found) {
            done.add(found.id);
            continue;
        }
        // The work item and the Answer task of the same ticket: finishing the ticket settles its
        // question too. Any other pair is held and reported, as an ambiguous done answer is.
        const work = found.ambiguous.filter((text) => !ANSWER_TASK.test(text));
        if (work.length <= 1) for (const id of found.ids) done.add(id);
        else read("done", key, [ pool ], [], true);
    }
    return { done: [ ...done ], finished: keys };
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** The task an accepted ask becomes: "Answer Jordan's question on ZAP-105". */
const ANSWER_TASK = /^Answer .+'s question on [A-Z][A-Z0-9]+-\d+/;

/**
 * Gives each entry without a text the text of the item its id names in `pools` or `known`, or his
 * own words when the id is an answer that named nothing, so `say` can name it. An id-shaped value
 * that named nothing stays unnamed.
 */
function withTexts(entries: (Written | Skipped)[], pools: Pools, known: Map<string, Candidate>, extra: Map<string, string> = new Map()) {
    const texts = new Map<string, string>([ ...[ ...known ].map(([ id, candidate ]) => [ id, candidate.text ] as const), ...extra ]);
    for (const item of Object.values(pools).flat()) texts.set(item.id, item.text);
    for (const entry of entries) {
        if (entry.text !== undefined || entry.id === undefined) continue;
        const text = texts.get(entry.id) ?? (ID_SHAPED.test(entry.id) || JIRA_KEY.test(entry.id) ? undefined : entry.id);
        if (text !== undefined) entry.text = text;
    }
}

/** A value that looks like a list item id, a ref, or a line or overlap id rather than his words. */
const ID_SHAPED = /^(?:[a-z]?[0-9a-f]{8,}|[oclx][0-9a-f]{5}|[dw]\d+|[lo][0-9a-f]{10})$/i;

/**
 * The items held on the day note of `date` after a call that named `named` and held `added`: the
 * earlier holds he didn't name and the new ones, among `live`, less the rest of an earlier group
 * once he named one of its items or it narrowed to one, which are `released`. Rewrites the note's
 * hold labels to match; a new hold records the period `periodOf` gives the note its item lives on.
 */
async function settleHolds(store: NoteStore, date: string, live: Set<string>, named: Map<string, string>, added: HoldGroup[], periodOf: (id: string) => string | undefined): Promise<{ held: string[]; asks: HoldGroup[]; released: string[] }> {
    const note = await findPeriodNote(store, "day", date);
    const labels = (name: string) => note ? note.attributes.filter((a) => a.type === "label" && a.name === name).map((a) => a.value) : [];
    const heldValues = labels(HELD_LABEL);
    const heldBefore = heldValues.map((value) => heldValueOf(value).id);
    const groupsBefore = labels(HELD_GROUP_LABEL);
    const fresh = new Set(added.flatMap((group) => group.ids));
    let held = [ ...new Set([ ...heldBefore.filter((id) => !named.has(id)), ...fresh ]) ].filter((id) => live.has(id));
    const asks: HoldGroup[] = [];
    /** Groups narrowed by an answer of another intent, by old label value: the label with only the items still held. */
    const narrowed = new Map<string, string>();
    for (const value of groupsBefore) {
        const { intent, ids: group } = holdGroupOf(value);
        const left = group.filter((id) => held.includes(id) && !fresh.has(id));
        const answers = group.filter((id) => named.has(id)).map((id) => named.get(id));
        if (group.length < 2 || !left.length) continue;
        // An answer of the hold's own intent says which one he meant, so the rest are released. One of
        // another intent settles only what it names: the rest stay held and are asked about by name,
        // never given a fate by elimination. A group left with one item and no answer has nothing to ask.
        if (answers.length && answers.every((answer) => answer === intent)) held = held.filter((id) => !left.includes(id));
        else if (answers.length) {
            // The group keeps only what is still held, so it never later narrows to one by itself and releases the rest.
            asks.push({ intent, ids: left });
            narrowed.set(value, [ intent, ...left ].join(" "));
        }
        else if (left.length === 1) held = held.filter((id) => !left.includes(id));
    }
    const groups = [ ...groupsBefore.map((value) => narrowed.get(value) ?? value), ...added.map((group) => [ group.intent, ...group.ids ].join(" ")) ]
        .filter((value) => holdGroupOf(value).ids.some((id) => held.includes(id)));
    if (note) {
        for (const value of heldValues.filter((value) => !held.includes(heldValueOf(value).id))) removeLabel(note.noteId, HELD_LABEL, value);
        for (const value of groupsBefore.filter((value) => !groups.includes(value))) removeLabel(note.noteId, HELD_GROUP_LABEL, value);
    }
    await labelDay(store, date, HELD_LABEL, held.filter((id) => !heldBefore.includes(id)).map((id) => {
        const period = periodOf(id);
        return period ? `${id}@${period}` : id;
    }));
    await labelDay(store, date, HELD_GROUP_LABEL, groups);
    return { held, asks, released: heldBefore.filter((id) => !held.includes(id) && !named.has(id) && live.has(id)) };
}

/** The items one ambiguous answer held together, and what that answer asked for: `done`, a `fate` or a `move`. */
interface HoldGroup {
    intent: string;
    ids: string[];
}

/** A `#caiusHeldGroup` value, `done e111 e101`, as its intent and ids; a value from before intents were kept reads as done. */
function holdGroupOf(value: string): HoldGroup {
    const [ first = "", ...rest ] = value.split(" ");
    return [ "done", "fate", "move" ].includes(first) ? { intent: first, ids: rest } : { intent: "done", ids: value.split(" ") };
}

/** Runs one group of writes; a throw becomes one skipped entry, so the rest of the answer still comes back. */
/** The follow-ups of `jira` he says in `said` he answered, as dismissals, but those `dismiss` already names. */
function answeredIn(said: string, jira: DayRead["inputs"]["jira"], dismiss: { candidateId: string }[]): { candidateId: string }[] {
    return saidAnswered(said, followUpsOf(jira)).filter((key) => !dismiss.some((c) => c.candidateId === key)).map((candidateId) => ({ candidateId }));
}

/** The dismissals his reply `said` gives his word for; without it each is skipped as `not_his_word`. */
function withHisWord<T extends { candidateId: string }>(said: string, dismiss: T[], skipped: Skipped[]): T[] {
    if (hisWord(said)) return dismiss;
    for (const { candidateId } of dismiss) skipped.push({ kind: "dismiss", id: candidateId, reason: "not_his_word" });
    return [];
}

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

/**
 * Takes `#caiusSettled` off every day note before `date` when `date` is closed, and off every other
 * day note older than the 3 workdays before `today` in any case. A re-run of `date` reads only its
 * own labels, so an earlier day's are needed only until a later day is closed; `date` keeps its own.
 */
async function pruneSettled(store: NoteStore, date: string, today: string, closed: boolean) {
    const oldest = closingPeriods(today).recent.at(-1) ?? today;
    for (const note of await store.search(`#${SETTLED_LABEL}`)) {
        const day = label(note, PERIODS.day.label);
        if (!day || day === date || !(day < oldest || (closed && day < date))) continue;
        for (const a of note.attributes) if (a.type === "label" && a.name === SETTLED_LABEL) removeLabel(note.noteId, SETTLED_LABEL, a.value);
    }
}

/** Adds each value of `name` not on the day note of `date` yet, creating the note if missing. */
async function labelDay(store: NoteStore, date: string, name: string, values: string[]) {
    if (!values.length) return;
    const note = await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);
    for (const value of new Set(values)) {
        if (!note.attributes.some((a) => a.type === "label" && a.name === name && a.value === value)) await store.addLabel(note.noteId, name, value);
    }
}

/** Records on the day note of `day` the focus figure the steps stated for it (`#caiusFocus`), which the Plan tab shows. */
async function recordFocus(store: NoteStore, day: string, read: DayRead) {
    const { min, max } = focusOf(read.inputs.capacity);
    const value = `${min}-${max}`;
    const note = await findPeriodNote(store, "day", day) ?? await store.calendarDay(day);
    for (const old of note.attributes.filter((a) => a.type === "label" && a.name === FOCUS_LABEL && a.value !== value)) removeLabel(note.noteId, FOCUS_LABEL, old.value);
    await labelDay(store, day, FOCUS_LABEL, [ value ]);
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
 * A ticket's latest ask in `asks` is recorded as answered (`#caiusAnswered`), which keeps it out of
 * every Follow up for good.
 */
async function dismiss(store: NoteStore, date: string, now: Date, ids: string[], known: Map<string, Candidate>, asks: DayRead["inputs"]["jira"]["asks"], written: Written[], skipped: Skipped[]) {
    for (const candidateId of ids) {
        const candidate = known.get(candidateId);
        const entry = { kind: "dismiss", id: candidateId, ...(candidate ? { text: candidate.text } : {}) };
        const ask = latestAsks(asks).find((latest) => latest.ticket.key === candidateId);
        if (ask) await labelDay(store, date, ANSWERED_LABEL, [ `${ask.ticket.key}:${ask.commentId}` ]);
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
    for (const said of input.context) {
        const voiced = inHisVoice(said);
        if ("error" in voiced) {
            skipped.push({ kind: "context", text: said, reason: "third_person", detail: voiced.error });
            continue;
        }
        const { result } = await contextAddOn(store, { date, text: voiced.text }, now, opts);
        record(written, skipped, { kind: "context", text: voiced.text }, result);
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
    const { tasks, held } = await catchupOf(store, date, now);
    if (answer === "review") {
        // Held tasks are reviewed with the rest: the wind-down of their day asks which.
        if (tasks.length || held.length) skipped.push({ kind: "catchup", reason: "review", detail: t("caius.daily.catchup_review") });
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

/**
 * What a place can name besides an item of the list: the call's candidates, and the items it moved
 * here by the id they had (`moved`, id to their text and the note they came from).
 */
interface Refs {
    known: Map<string, Candidate>;
    moved: Map<string, { text: string; noteId: string }>;
}

/**
 * Moves `item` in his main list of `date` to `place`. `item` and the item it is placed by are each
 * a listItemId of the list, a candidate's id or the id of an item the call moved here, found on the
 * list by its key or, for an item whose copy has a new id, by its text without the forward links;
 * of several copies with that text, the one whose back link points at the note it came from.
 */
async function placeOnList(store: NoteStore, date: string, now: Date, entry: { kind: string; id: string }, item: string, place: { first?: boolean; before?: string; after?: string }, refs: Refs, written: Written[], skipped: Skipped[]) {
    const by = place.before ?? place.after;
    if (!place.first && by === undefined) return;
    const plan = await readPlan(store, "day", date, now);
    const tasks = mainTasks(plan);
    const refsOf = (ref: string) => {
        const text = refs.known.get(ref)?.text ?? refs.moved.get(ref)?.text;
        return [ ref, ...(text ? keysOf(withoutMoveLinks(text)) : []) ];
    };
    const find = (ref: string) => {
        const exact = tasks.find((task) => task.listItemId === ref);
        if (exact) return exact;
        const matches = tasks.filter((task) => keysOf(withoutMoveLinks(task.text)).some((key) => refsOf(ref).includes(key)));
        const origin = refs.moved.get(ref)?.noteId;
        return (origin ? matches.find((task) => task.text.includes(`(#root/${origin})`)) : undefined) ?? matches[0];
    };
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

/**
 * The acts of a day already under way as they plan from `from` on: an act that starts earlier
 * starts at `from`, and one that ends by then reads as `from`. A range that isn't two clock
 * times, such as "Evening", is left alone.
 */
function fromNow(acts: Prose["acts"], from: string | undefined): Prose["acts"] {
    if (!from) return acts;
    return acts.map((act) => {
        const m = /^(\s*)(\d{1,2}:\d{2})(\s*(?:to|–|-)\s*)(\d{1,2}:\d{2})(\s*)$/.exec(act.range);
        if (!m?.[2] || !m[4]) return act;
        const clock = (time: string) => time.padStart(5, "0");
        if (clock(m[4]) <= from) return { ...act, range: from };
        return clock(m[2]) < from ? { ...act, range: `${m[1]}${from}${m[3]}${m[4]}${m[5]}` } : act;
    });
}

/** The day's drawing: its span from the rhythm, the calendar's events and his list laid out between them. */
function headerOf(plan: Awaited<ReturnType<typeof readPlan>>, read: DayRead, date: string, now: Date, opts: { worked?: boolean } = {}) {
    const { start, end, workEnd } = read.rhythm;
    const events = drawnEvents(read);
    return { start, end, workEnd, events, work: workBlocks(plan, { start, end, workEnd }, events, date, now, opts).work };
}

/** A ticket candidate as its Suggested line: the shape `caius_add` writes, or an ask's "Answer X's question on KEY: because Y (~15m)". */
function suggestedLine(candidate: Candidate): string {
    if (candidate.kind === "ask") return `${candidate.text}: because ${candidate.because} (~${candidate.minutes}m)`;
    return `Get ${candidate.key ? `${candidate.key} ` : ""}${candidate.title ?? candidate.text} done: because ${candidate.because} (~${candidate.minutes}m)`;
}

/**
 * The overlaps of `day` he answered, in `answers` or in `said` naming one meeting of a pair: each
 * written as "Taking X, not Y, at 11:00" in the day's Context, with Y declined for the day
 * (`#caiusDeclined`). Answers the titles declined. The pairs are read with his own declines undone,
 * so a re-run finds the pair it answered.
 */
async function takeOverlaps(store: NoteStore, day: string, now: Date, read: DayRead, said: string, answers: { overlapId: string; take: string }[], written: Written[], skipped: Skipped[]): Promise<string[]> {
    const his = new Set((await dayLabels(store, day, DECLINED_LABEL)).map(normName));
    const pairs = overlapPairs(read.inputs.calendar.map((event) => his.has(normName(event.title)) ? { ...event, declined: false } : event))
        .map((pair) => ({ ...pair, overlapId: overlapIdOf(pair) }));
    const heard = pairs.filter((pair) => !answers.some((answer) => answer.overlapId === pair.overlapId)).flatMap((pair) => {
        const named = [ pair.first, pair.second ].filter((title) => saysPhrase(said, title));
        return named.length === 1 && named[0] ? [ { overlapId: pair.overlapId, take: named[0] } ] : [];
    });
    const declined: string[] = [];
    for (const { overlapId, take } of [ ...answers, ...heard ]) {
        const pair = pairs.find((candidate) => candidate.overlapId === overlapId);
        const taken = pair && [ pair.first, pair.second ].find((title) => normName(title) === normName(take) || saysPhrase(take, title));
        if (!pair || !taken) {
            skipped.push({ kind: "overlap", id: overlapId, text: take, reason: "not_offered" });
            continue;
        }
        const other = taken === pair.first ? pair.second : pair.first;
        const text = t("caius.daily.overlap_taken", { take: taken, other, time: pair.at });
        const { result } = await contextAddOn(store, { date: day, text }, now);
        record(written, skipped, { kind: "overlap", id: overlapId, text, detail: taken }, result);
        await labelDay(store, day, DECLINED_LABEL, [ other ]);
        declined.push(other);
    }
    return declined;
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
    const picks = picksFor(plan, reasons);
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
        date: input.date, headline: input.brief.headline, picks, sections, header,
        acts: withEveningAct(fromNow(drawnActs(header, input.brief.acts, titlesOf(plan)), planFromOf(input.date, now, read.rhythm.start).planFrom), plan, header),
        followUps: followUps.map(({ key, commentId }) => ({ key, commentId }))
    });
    if (result.error !== undefined) return { error: result.error, detail: result.detail };
    if (!("writes" in result) || !result.writes) return { error: "failed", detail: "the brief was not written" };
    const { briefNoteId, headerNoteId, attachmentId, plannedAt, writes } = result;
    return { briefNoteId, headerNoteId, attachmentId, plannedAt, writes, picks };
}
