/**
 * `caius_brief_write`: the Morning Brief note under a day note, its `Header` child with the drawing,
 * and the include-note of the header at the top of the day note. The caller holds `withCaiusLock`
 * and has fetched the weather. Re-runs find the same notes and replace their content.
 */

import {
    briefBodyHtml,
    diffSummary,
    ensureListItemIds,
    findPeriodNote,
    formatEstimate,
    headerHtml,
    label,
    leadingInclude,
    type NoteStore,
    type StoreNote,
    withInclude,
    withoutImages
} from "@triliumnext/caius";
import { createHash } from "crypto";
import { t } from "i18next";

import type { BriefWriteInput } from "./schemas.js";
import { createChildNote, setLabel } from "./store.js";

export const BRIEF_TITLE = "🌅 Morning Brief";
export const HEADER_TITLE = "Header";
const CSS_CLASS = "briefdemo";
export const BRIEF_LABEL = "morningBrief";
export const PLANNED_AT_LABEL = "caiusPlannedAt";
/** On a brief: an ask its Follow up raised, as `#caiusRaised=ZAP-104:10` (the ticket and the comment). */
export const RAISED_LABEL = "caiusRaised";
/** On a day note: a keep or carry line asked about that day, by its lineId, so it is asked once. */
export const ASKED_LABEL = "caiusAsked";
/** On a day note: a candidate he said not today to, by its candidateId; offered again on the next workday. */
export const NOT_TODAY_LABEL = "caiusNotToday";
/** On a day note: the day was wound down, so the catch-up looks no further back than it. */
export const WOUND_DOWN_LABEL = "caiusWoundDown";
/** On a day note: Plan my day's catch-up of the last workday is skipped for that day. */
export const SKIP_CATCHUP_LABEL = "caiusSkipCatchup";
/** Children of a brief that the old push script labels; they are pages of a brief, never the brief. */
const PAGE_LABELS = [ "morningBriefPage", "morningBriefRevision" ];

export interface BriefDeps {
    store: NoteStore;
    /** Draws `header` on the note and answers the attachment's id. */
    draw: (noteId: string) => string;
    /** Trilium's markdown import renderer, as the note tools use it. */
    render: (markdown: string, title: string) => string;
    /** `YYYY-MM-DDTHH:mm:ss` local time from the Caius clock. */
    plannedAt: string;
}

/** One note's write: `updated`, `unchanged`, or `edited` when it changed between the read and the write. */
export interface NoteWrite {
    noteId: string;
    role: "header" | "brief" | "day";
    status: "updated" | "unchanged" | "skipped";
    reason?: "edited";
}

/** One "Get done today" line: a task of his list, with why when it is known. */
export interface BriefPick {
    text: string;
    because?: string;
    minutes: number;
}

export async function writeBrief(deps: BriefDeps, input: Omit<BriefWriteInput, "picks"> & { picks: BriefPick[] }) {
    const { store } = deps;
    const { date, dryRun } = input;
    let day = await findPeriodNote(store, "day", date);
    if (day && (day.type !== "text" || day.isProtected)) {
        return { date, error: "bad_request", detail: `The day note for ${date} is protected or not a text note` };
    }
    let brief = day ? await findBrief(store, day.noteId, date) : null;
    let header = brief ? await findHeader(store, brief.noteId) : null;
    for (const [ name, note ] of [ [ "brief", brief ], [ "Header", header ] ] as const) {
        if (note?.isProtected) {
            return { date, error: "bad_request", detail: `The ${name} note of ${date}, or a child of the brief, is protected` };
        }
    }
    const picks = input.picks.map((pick) => pick.because?.trim()
        ? t("caius.brief.pick", {
            text: pick.text.trim(),
            because: pick.because.trim().replace(/^because\s+/i, ""),
            estimate: formatEstimate(pick.minutes)
        })
        : t("caius.brief.pick_plain", { text: pick.text.trim(), estimate: formatEstimate(pick.minutes) }));
    const sections = input.sections.map(({ title, markdown }) => ({ title, html: withoutImages(deps.render(markdown, title)) }));
    const headerContent = (attachmentId: string) => headerHtml({
        dateLine: dateLine(date),
        headline: input.headline,
        image: { src: `api/attachments/${attachmentId}/image/terrain.svg`, alt: t("caius.brief.image_alt") },
        acts: input.acts
    });
    // The list items get ids derived from the brief and their place, so an identical re-run writes
    // the same HTML and answers unchanged instead of a new revision with fresh random ids.
    const bodyContent = (headerNoteId: string, briefNoteId: string) => {
        let index = 0;
        const newId = () => `e${createHash("sha1").update(`${briefNoteId}:${index++}`).digest("hex").slice(0, 32)}`;
        return ensureListItemIds(briefBodyHtml({ headerNoteId, picksTitle: t("caius.brief.picks_title"), picks, sections }), newId);
    };

    if (dryRun) {
        const headerNoteId = header?.noteId ?? "NEW-HEADER";
        const dayBefore = day ? await store.content(day.noteId) : "";
        return {
            date, dryRun: true,
            dayNoteId: day?.noteId ?? null, briefNoteId: brief?.noteId ?? null, headerNoteId: header?.noteId ?? null,
            ...(day ? {} : { detail: `${date} has no day note yet; a real run creates it from the Journal template` }),
            header: headerContent("NEW-ATTACHMENT"),
            brief: bodyContent(headerNoteId, brief?.noteId ?? "NEW-BRIEF"),
            day: diffSummary(dayBefore, withInclude(dayBefore, headerNoteId))
        };
    }

    const created = { day: !day, brief: !brief, header: !header };
    day ??= await store.calendarDay(date);
    if (!brief) {
        brief = await store.note(createChildNote(day.noteId, BRIEF_TITLE, "<p></p>"));
    }
    if (!header) {
        header = await store.note(createChildNote(brief.noteId, HEADER_TITLE, "<p></p>"));
    }
    setLabel(brief.noteId, BRIEF_LABEL, date);
    setLabel(brief.noteId, "cssClass", CSS_CLASS);
    setLabel(header.noteId, "cssClass", CSS_CLASS);

    // A new Header takes the place of the include-note of one that was deleted or replaced.
    const leading = created.header ? leadingInclude(await store.content(day.noteId)) : null;
    const stale = leading && await isStaleHeader(store, leading, date) ? leading : null;
    const attachmentId = deps.draw(header.noteId);
    const writes = [
        await replace(store, header.noteId, "header", () => headerContent(attachmentId)),
        await replace(store, brief.noteId, "brief", () => bodyContent(header.noteId, brief.noteId)),
        await replace(store, day.noteId, "day", (before) => withInclude(before, header.noteId, (id) => id === stale))
    ];
    // The planned time marks a finished plan, so a write that lost its compare-and-swap leaves the old one.
    const complete = writes.every((write) => write.status !== "skipped");
    if (complete) setLabel(brief.noteId, PLANNED_AT_LABEL, deps.plannedAt);
    // Every ask passed counts as raised once the brief has a Follow up with text, however it is worded.
    const followUp = input.sections.find(({ title }) => sameTitle(title) === sameTitle(t("caius.daily.follow_up")));
    const asked = complete && !!followUp?.markdown.trim();
    const raised = new Set(brief.attributes.filter((a) => a.type === "label" && a.name === RAISED_LABEL).map((a) => a.value));
    for (const { key, commentId } of asked ? input.followUps ?? [] : []) {
        const value = `${key}:${commentId}`;
        if (raised.has(value)) continue;
        await store.addLabel(brief.noteId, RAISED_LABEL, value);
        raised.add(value);
    }
    return {
        date, dayNoteId: day.noteId, briefNoteId: brief.noteId, headerNoteId: header.noteId, attachmentId,
        plannedAt: complete ? deps.plannedAt : null, created,
        includeAdded: writes[2]?.status === "updated",
        writes
    };
}

/**
 * The day's brief: a child of the day note labelled `#morningBrief=<date>` that is not one of its
 * pages. Read through the children rather than a search, which leaves protected notes out.
 */
export async function findBrief(store: NoteStore, dayNoteId: string, date: string): Promise<StoreNote | null> {
    for (const childId of (await store.note(dayNoteId)).childNoteIds) {
        const child = await store.note(childId);
        if (label(child, BRIEF_LABEL) === date && !PAGE_LABELS.some((name) => label(child, name) !== undefined)) return child;
    }
    return null;
}

/** Whether `noteId` is gone, or is the Header of a `#morningBrief=<date>` brief. */
async function isStaleHeader(store: NoteStore, noteId: string, date: string): Promise<boolean> {
    const note = await store.note(noteId).catch(() => null);
    if (!note) return true;
    if (note.title !== HEADER_TITLE) return false;
    for (const parentId of note.parentNoteIds) {
        const parent = await store.note(parentId).catch(() => null);
        if (parent && label(parent, BRIEF_LABEL) === date) return true;
    }
    return false;
}

/** The brief's child titled `Header`; a protected child, whose title can't be read, answers as a protected header. */
async function findHeader(store: NoteStore, briefNoteId: string): Promise<StoreNote | null> {
    const children = await Promise.all((await store.note(briefNoteId)).childNoteIds.map((id) => store.note(id)));
    return children.find((child) => child.title === HEADER_TITLE) ?? children.find((child) => child.isProtected) ?? null;
}

/** Replaces a note's content with what `build` makes of it, as a compare-and-swap. */
async function replace(store: NoteStore, noteId: string, role: NoteWrite["role"], build: (before: string) => string): Promise<NoteWrite> {
    const before = await store.content(noteId);
    const after = build(before);
    if (after === before) return { noteId, role, status: "unchanged" };
    return await store.putContent(noteId, after, before)
        ? { noteId, role, status: "updated" }
        : { noteId, role, status: "skipped", reason: "edited" };
}

/** A section title compared ignoring case, spacing and punctuation: "Follow-up" is "Follow up". */
export function sameTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** `Tuesday · October 27 2026`, with names from the server catalogue. */
export function dateLine(date: string): string {
    const [ year, month, day ] = date.split("-").map(Number) as [ number, number, number ];
    const at = new Date(Date.UTC(year, month - 1, day));
    return t("caius.brief.date_line", {
        weekday: t(`weekdays.${WEEKDAYS[at.getUTCDay()]}`),
        month: t(`months.${MONTHS[month - 1]}`),
        day,
        year
    });
}

const WEEKDAYS = [ "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday" ];
const MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
];
