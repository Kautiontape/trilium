/**
 * The apply tools: `caius_plan_apply` makes every write of a Plan my day conversation from his
 * answers, in one call. Each answer names an id from the step data, so nothing here builds text
 * from the agent's words except the evening tasks, the Context lines and the brief's prose. Every
 * write is safe to repeat: a second run with the same input changes no note.
 */

import {
    acceptTasks,
    addTasks,
    dayCandidates,
    findPeriodNote,
    forwardTasks,
    keysOf,
    loadJournal,
    meetingLines,
    type NoteStore,
    readPlan,
    setMeetings,
    takeSuggested
} from "@triliumnext/caius";
import { t } from "i18next";

import { ASKED_LABEL, type BriefPick, NOT_TODAY_LABEL, sameTitle, writeBrief } from "./brief.js";
import {
    catchupOf,
    dayKey,
    type DayRead,
    drawnEvents,
    followUpsOf,
    lineIdOf,
    listOf,
    planOffer,
    present,
    type StepDeps,
    weekdayName,
    withDateLabels,
    workBlocks
} from "./daily.js";
import { isInputWarning } from "./inputs/index.js";
import type { PlanApplyInput } from "./schemas.js";
import { contextAddOn, contextKeepOn, drawHeader, finishedOn, skipCatchupOn } from "./writes.js";
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

export async function planApply(deps: ApplyDeps, input: PlanApplyInput) {
    const { date } = input;
    if (date > dayKey(deps.now)) {
        return { date, error: "not_today", detail: t("caius.daily.not_today", { day: weekdayName(date), today: dayKey(deps.now) }) };
    }
    // The sources and the forecast are read before the lock, as the steps read them.
    const read = await deps.dayRead(date);
    const place = await deps.place();
    const weather = place ? await deps.weatherOf(place.latitude, place.longitude, date) : undefined;

    return deps.locked("caius_plan_apply", async () => {
        const { store, now } = deps;
        const written: Written[] = [];
        const skipped: Skipped[] = [];
        const offer = await planOffer(store, date, now, read);
        // Every candidate the day could offer, whatever was offered or added since: a re-run finds
        // those already in Suggested, and an id he named still resolves after the brief is written.
        const known = new Map([
            ...dayCandidates({ jira: read.inputs.jira, week: offer.day.week, live: offer.day.live, exclude: [ ...offer.day.plan.dismissed, ...offer.day.closed ] }).map(present),
            ...offer.candidates
        ].map((candidate) => [ candidate.candidateId, candidate ]));

        // Every line the step asked about is answered now, whatever he said, so it isn't asked again.
        const askedNote = offer.carry.length ? await findPeriodNote(store, "day", date) ?? await store.calendarDay(date) : null;
        for (const line of askedNote ? offer.carry : []) {
            if (askedNote && !askedNote.attributes.some((a) => a.type === "label" && a.name === ASKED_LABEL && a.value === line.lineId)) {
                await store.addLabel(askedNote.noteId, ASKED_LABEL, line.lineId);
            }
        }

        await catchup(store, date, now, input.catchup, written, skipped);

        for (const { candidateId } of input.accept) {
            await accept(store, date, now, known.get(candidateId), candidateId, written, skipped);
        }

        for (const { lineId } of input.keep) {
            const line = offer.carry.find((c) => c.lineId === lineId);
            if (!line) {
                if (read.context.some((c) => lineIdOf(c.text) === lineId)) written.push({ kind: "keep", id: lineId, status: "unchanged" });
                else skipped.push({ kind: "keep", id: lineId, reason: "not_offered" });
                continue;
            }
            const [ result ] = await contextKeepOn(store, date, [ { text: line.line, ...(line.until ? { until: line.until } : {}) } ], { now });
            record(written, skipped, { kind: "keep", id: lineId, text: line.line }, result);
        }

        const dayNote = async () => await findPeriodNote(store, "day", date) ?? await store.calendarDay(date);

        if (input.finished.length) {
            const result = await finishedOn(store, input.finished, await dayNote(), date, now);
            if ("error" in result) skipped.push({ kind: "finished", text: input.finished.join(", "), reason: result.error ?? "bad_request", detail: result.detail });
            else for (const key of input.finished) written.push({ kind: "finished", id: key, status: result.status === "updated" ? "written" : "unchanged" });
        }

        for (const { candidateId } of input.notToday) {
            const note = await dayNote();
            const labelled = note.attributes.some((a) => a.type === "label" && a.name === NOT_TODAY_LABEL && a.value === candidateId);
            if (!labelled) await store.addLabel(note.noteId, NOT_TODAY_LABEL, candidateId);
            // Not today takes it off today's shelf without a dismissal, so it comes back on the next workday.
            const removed = await unsuggest(store, date, now, candidateId);
            written.push({ kind: "not_today", id: candidateId, text: known.get(candidateId)?.text, status: labelled && !removed ? "unchanged" : "written" });
        }

        // What was offered and not named stays on the shelf: each ticket candidate goes to Suggested.
        const named = new Set([ ...input.accept, ...input.notToday ].map((c) => c.candidateId).concat(input.finished));
        for (const candidate of offer.candidates) {
            if (candidate.kind === "week" || named.has(candidate.candidateId) || !candidate.key) continue;
            const [ result ] = await addTasks(store, [ { date, suggested: true, text: suggestedLine(candidate), source: candidate.key } ], { now });
            record(written, skipped, { kind: "suggested", id: candidate.candidateId, text: candidate.text }, result);
        }

        for (const text of input.evening) {
            const [ result ] = await addTasks(store, [ { date, section: EVENING, text } ], { now });
            record(written, skipped, { kind: "evening", text }, result);
        }

        for (const text of input.context) {
            const { result } = await contextAddOn(store, { date, text }, now);
            record(written, skipped, { kind: "context", text }, result);
        }

        for (const { listItemId, to } of input.forward ?? []) {
            const noteId = await noteOf(store, listItemId);
            if (!noteId) {
                skipped.push({ kind: "forward", id: listItemId, reason: "not_found" });
                continue;
            }
            const [ result ] = await forwardTasks(store, [ { noteId, listItemId, to } ], {});
            record(written, skipped, { kind: "forward", id: listItemId, detail: to }, result);
        }

        if (read.inputs.errors.some((e) => e.source === "calendar" && !isInputWarning(e.error))) {
            skipped.push({ kind: "meetings", reason: "calendar_unavailable" });
        } else {
            const result = await setMeetings(store, { date, lines: meetingLines(read.inputs.calendar) }, {});
            record(written, skipped, { kind: "meetings" }, result);
        }

        // A pick's reason is its candidate's, live or not, so a re-run words the brief the same.
        const reasons = new Map(dayCandidates({ jira: read.inputs.jira, week: offer.day.week, live: new Map(), exclude: offer.day.closed })
            .map(present).map((candidate) => [ candidate.candidateId, candidate ]));
        const brief = await briefOf(deps, input, read, reasons, offer.jira, weather);
        if ("error" in brief) {
            skipped.push({ kind: "brief", reason: brief.error ?? "bad_request", detail: brief.detail });
            return withDateLabels({ date, written, skipped });
        }
        const changed = brief.writes.some((w) => w.status === "updated");
        const lost = brief.writes.find((w) => w.status === "skipped");
        if (lost) skipped.push({ kind: "brief", reason: lost.reason ?? "edited" });
        else written.push({ kind: "brief", status: changed ? "written" : "unchanged" });
        return withDateLabels({
            date, written, skipped,
            headline: input.brief.headline, topPick: brief.picks[0]?.text ?? null,
            briefNoteId: brief.briefNoteId, headerNoteId: brief.headerNoteId, attachmentId: brief.attachmentId,
            link: `#root/${brief.briefNoteId}`, plannedAt: brief.plannedAt
        });
    });
}

const EVENING = "Evening";

type Candidate = ReturnType<typeof present>;

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
    let item = plan.suggested.find((task) => keysOf(task.text).includes(candidateId));
    if (!item?.listItemId && candidate.key) {
        const [ added ] = await addTasks(store, [ { date, suggested: true, text: suggestedLine(candidate), source: candidate.key } ], { now });
        if (added?.status !== "added") {
            record(written, skipped, entry, added);
            return;
        }
        item = (await readPlan(store, "day", date, now)).suggested.find((task) => task.listItemId === added.listItemId);
    }
    if (!item?.listItemId || !plan.noteId) {
        skipped.push({ ...entry, reason: "not_found" });
        return;
    }
    const [ result ] = await acceptTasks(store, [ { noteId: item.noteId ?? plan.noteId, listItemId: item.listItemId } ]);
    record(written, skipped, entry, result);
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

/** The note holding the list item `listItemId`, anywhere in the Journal. */
async function noteOf(store: NoteStore, listItemId: string): Promise<string | null> {
    for (const doc of (await loadJournal(store)).docs) {
        if ([ ...doc.itemIds.values() ].includes(listItemId)) return doc.noteId;
    }
    return null;
}

/** A task's text without the `from Friday 30` or `scheduled Tuesday 3` link a forward adds. */
function withoutMoveLinks(text: string): string {
    return text.replace(/\s*(?:from|scheduled) [^\s,]+ \d{1,2}(?=\s|$)/g, "").trim();
}

/** A ticket candidate as its Suggested line, the one shape `caius_add` writes. */
function suggestedLine(candidate: Candidate): string {
    return `Get ${candidate.key ? `${candidate.key} ` : ""}${candidate.title ?? candidate.text} done: because ${candidate.because} (~${candidate.minutes}m)`;
}

/** Files a library result under written (a write, or `duplicate`/`already_moved`/`unchanged`: already there) or skipped. */
function record(written: Written[], skipped: Skipped[], entry: Omit<Written, "status">, result: unknown) {
    const r = (result ?? { status: "failed", error: "no result" }) as { status: string; reason?: string; detail?: string; error?: string };
    if (r.status === "skipped" && (r.reason === "duplicate" || r.reason === "already_moved")) {
        written.push({ ...entry, status: "unchanged" });
    } else if (r.status === "skipped" || r.status === "failed") {
        skipped.push({ ...entry, reason: r.reason ?? "failed", ...(r.detail ?? r.error ? { detail: r.detail ?? r.error } : {}) });
    } else {
        written.push({ ...entry, status: r.status === "unchanged" ? "unchanged" : "written" });
    }
}

/**
 * Writes the brief: his prose, the picks from his list in its order (evening tasks apart), the
 * Follow up from the step's sentences in place of any the agent wrote, the drawing and the weather.
 */
async function briefOf(deps: ApplyDeps, input: PlanApplyInput, read: DayRead, reasons: Map<string, Candidate>, jira: DayRead["inputs"]["jira"], weather: DayWeather | undefined) {
    const { store, now } = deps;
    const plan = await readPlan(store, "day", input.date, now);
    const picks: BriefPick[] = listOf(plan).filter((task) => !task.evening).slice(0, MAX_PICKS).map((task) => {
        const reason = task.keys.map((key) => reasons.get(key)).find((candidate) => candidate && candidate.kind !== "week");
        return { text: withoutMoveLinks(task.text), minutes: task.minutes, ...(reason ? { because: reason.because } : {}) };
    });
    const followUps = followUpsOf(jira);
    const followUpTitle = t("caius.daily.follow_up");
    const sections = [
        ...(followUps.length ? [ { title: followUpTitle, markdown: followUps.map((f) => `- ${f.sentence}`).join("\n") } ] : []),
        ...input.brief.sections.filter((section) => sameTitle(section.title) !== sameTitle(followUpTitle))
    ];
    const { start, end, workEnd } = read.rhythm;
    const events = drawnEvents(read);
    const header = { start, end, workEnd, events, work: workBlocks(plan, { start, end, workEnd }, events, input.date, now).work };
    const result = await writeBrief({
        store,
        draw: (noteId) => drawHeader(noteId, header, weather).attachmentId,
        render: deps.render,
        plannedAt: deps.plannedAt
    }, {
        date: input.date, headline: input.brief.headline, acts: input.brief.acts, picks, sections, header,
        followUps: followUps.map(({ key, commentId }) => ({ key, commentId }))
    });
    if (result.error !== undefined) return { error: result.error, detail: result.detail };
    if (!("writes" in result) || !result.writes) return { error: "failed", detail: "the brief was not written" };
    const { briefNoteId, headerNoteId, attachmentId, plannedAt, writes } = result;
    return { briefNoteId, headerNoteId, attachmentId, plannedAt, writes, picks };
}
