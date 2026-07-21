import { dayjs } from "@triliumnext/commons";

import type { FNoteRow } from "../entities/fnote.js";
import froca from "./froca.js";
import server from "./server.js";
import ws from "./ws.js";

async function getInboxNote() {
    const note = await server.get<FNoteRow>(`special-notes/inbox/${dayjs().format("YYYY-MM-DD")}`, "date-note");

    return await froca.getNote(note.noteId);
}

async function getTodayNote() {
    return await getDayNote(dayjs().format("YYYY-MM-DD"));
}

async function getDayNote(date: string, calendarRootId?: string) {
    const note = await server.get<FNoteRow>(dateNoteUrl("days", date, calendarRootId), "date-note");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

async function getWeekFirstDayNote(date: string, calendarRootId?: string) {
    const note = await server.get<FNoteRow>(dateNoteUrl("week-first-day", date, calendarRootId), "date-note");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

/** Returns null when the calendar root does not have `#enableWeekNote`. */
async function getWeekNote(week: string, calendarRootId?: string) {
    const note = await server.get<FNoteRow | null>(dateNoteUrl("weeks", week, calendarRootId), "date-note");

    if (!note) {
        return null;
    }

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

async function getMonthNote(month: string, calendarRootId?: string) {
    const note = await server.get<FNoteRow>(dateNoteUrl("months", month, calendarRootId), "date-note");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

async function getQuarterNote(quarter: string, calendarRootId?: string) {
    const note = await server.get<FNoteRow>(dateNoteUrl("quarters", quarter, calendarRootId), "date-note");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

async function getYearNote(year: string, calendarRootId?: string) {
    const note = await server.get<FNoteRow>(dateNoteUrl("years", year, calendarRootId), "date-note");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

function dateNoteUrl(path: string, value: string, calendarRootId?: string) {
    const url = `special-notes/${path}/${encodeURIComponent(value)}`;
    return calendarRootId ? `${url}?calendarRootId=${encodeURIComponent(calendarRootId)}` : url;
}

async function createSqlConsole() {
    const note = await server.post<FNoteRow>("special-notes/sql-console");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

async function createSearchNote(opts = {}) {
    const note = await server.post<FNoteRow>("special-notes/search-note", opts);

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

async function createLlmChat() {
    const note = await server.post<FNoteRow>("special-notes/llm-chat");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

/**
 * Gets the most recently modified LLM chat.
 * Returns null if no chat exists.
 */
async function getMostRecentLlmChat() {
    const note = await server.get<FNoteRow | null>("special-notes/most-recent-llm-chat");

    if (!note) {
        return null;
    }

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

/**
 * Gets the most recent LLM chat, or creates a new one if none exists.
 * Used by sidebar chat for persistent conversations across page refreshes.
 */
async function getOrCreateLlmChat() {
    const note = await server.get<FNoteRow>("special-notes/get-or-create-llm-chat");

    await ws.waitForMaxKnownEntityChangeId();

    return await froca.getNote(note.noteId);
}

export interface RecentLlmChat {
    noteId: string;
    title: string;
    dateModified: string;
}

/**
 * Gets a list of recent LLM chats for the history popup.
 */
async function getRecentLlmChats(limit: number = 10): Promise<RecentLlmChat[]> {
    return await server.get<RecentLlmChat[]>(`special-notes/recent-llm-chats?limit=${limit}`);
}

export default {
    getInboxNote,
    getTodayNote,
    getDayNote,
    getWeekFirstDayNote,
    getWeekNote,
    getQuarterNote,
    getMonthNote,
    getYearNote,
    createSqlConsole,
    createSearchNote,
    createLlmChat,
    getMostRecentLlmChat,
    getOrCreateLlmChat,
    getRecentLlmChats
};
