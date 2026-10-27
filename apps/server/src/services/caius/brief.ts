/**
 * `caius_brief_write`: the Morning Brief note under a day note, its `Header` child with the drawing,
 * and the include-note of the header at the top of the day note. The caller holds `withCaiusLock`
 * and has fetched the weather. Re-runs find the same notes and replace their content.
 */

import {
    briefBodyHtml,
    diffSummary,
    findPeriodNote,
    formatEstimate,
    headerHtml,
    label,
    type NoteStore,
    type StoreNote,
    withInclude
} from "@triliumnext/caius";
import { t } from "i18next";

import type { BriefWriteInput } from "./schemas.js";
import { createChildNote, setLabel } from "./store.js";

export const BRIEF_TITLE = "🌅 Morning Brief";
export const HEADER_TITLE = "Header";
const CSS_CLASS = "briefdemo";
const BRIEF_LABEL = "morningBrief";
export const PLANNED_AT_LABEL = "caiusPlannedAt";
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
interface NoteWrite {
    noteId: string;
    role: "header" | "brief" | "day";
    status: "updated" | "unchanged" | "skipped";
    reason?: "edited";
}

export async function writeBrief(deps: BriefDeps, input: BriefWriteInput) {
    const { store } = deps;
    const { date, dryRun } = input;
    let day = await findPeriodNote(store, "day", date);
    if (day && (day.type !== "text" || day.isProtected)) {
        return { date, error: "bad_request", detail: `The day note for ${date} is protected or not a text note` };
    }
    let brief = day ? await findBrief(store, day.noteId, date) : null;
    let header = brief ? await findHeader(store, brief.noteId) : null;
    const picks = input.picks.map((pick) => t("caius.brief.pick", {
        text: pick.text.trim(),
        because: pick.because.trim().replace(/^because\s+/i, ""),
        estimate: formatEstimate(pick.minutes)
    }));
    const sections = input.sections.map(({ title, markdown }) => ({ title, html: deps.render(markdown, title) }));
    const headerContent = (attachmentId: string) => headerHtml({
        dateLine: dateLine(date),
        headline: input.headline,
        image: { src: `api/attachments/${attachmentId}/image/terrain.svg`, alt: t("caius.brief.image_alt") },
        acts: input.acts
    });
    const bodyContent = (headerNoteId: string) => briefBodyHtml({ headerNoteId, picksTitle: t("caius.brief.picks_title"), picks, sections });

    if (dryRun) {
        const headerNoteId = header?.noteId ?? "NEW-HEADER";
        const dayBefore = day ? await store.content(day.noteId) : "";
        return {
            date, dryRun: true,
            dayNoteId: day?.noteId ?? null, briefNoteId: brief?.noteId ?? null, headerNoteId: header?.noteId ?? null,
            ...(day ? {} : { detail: `${date} has no day note yet; a real run creates it from the Journal template` }),
            header: headerContent("NEW-ATTACHMENT"),
            brief: bodyContent(headerNoteId),
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
    setLabel(brief.noteId, PLANNED_AT_LABEL, deps.plannedAt);
    setLabel(brief.noteId, "cssClass", CSS_CLASS);
    setLabel(header.noteId, "cssClass", CSS_CLASS);

    const attachmentId = deps.draw(header.noteId);
    const writes = [
        await replace(store, header.noteId, "header", () => headerContent(attachmentId)),
        await replace(store, brief.noteId, "brief", () => bodyContent(header.noteId)),
        await replace(store, day.noteId, "day", (before) => withInclude(before, header.noteId))
    ];
    return {
        date, dayNoteId: day.noteId, briefNoteId: brief.noteId, headerNoteId: header.noteId, attachmentId,
        plannedAt: deps.plannedAt, created,
        includeAdded: writes[2]?.status === "updated",
        writes
    };
}

/** The day's brief: a child of the day note labelled `#morningBrief=<date>` that is not one of its pages. */
async function findBrief(store: NoteStore, dayNoteId: string, date: string): Promise<StoreNote | null> {
    const found = await store.search(`#${BRIEF_LABEL}="${date}"`);
    return found.find((note) => note.parentNoteIds.includes(dayNoteId)
        && label(note, BRIEF_LABEL) === date
        && !PAGE_LABELS.some((name) => label(note, name) !== undefined)) ?? null;
}

async function findHeader(store: NoteStore, briefNoteId: string): Promise<StoreNote | null> {
    for (const childId of (await store.note(briefNoteId)).childNoteIds) {
        const child = await store.note(childId);
        if (child.title === HEADER_TITLE) return child;
    }
    return null;
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
