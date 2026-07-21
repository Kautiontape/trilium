import type { Request } from "express";

import becca from "../../becca/becca.js";
import { NotFoundError } from "../../errors.js";
import * as cls from "../../services/context.js";
import dateNoteService from "../../services/date_notes.js";
import specialNotesService, { type LauncherType } from "../../services/special_notes.js";
import { getSql } from "../../services/sql/index.js";

function getInboxNote(req: Request<{ date: string }>) {
    return specialNotesService.getInboxNote(req.params.date);
}

function getDayNote(req: Request<{ date: string }>) {
    return dateNoteService.getDayNote(req.params.date, resolveCalendarRoot(req));
}

function getWeekFirstDayNote(req: Request<{ date: string }>) {
    return dateNoteService.getWeekFirstDayNote(req.params.date, resolveCalendarRoot(req));
}

function getWeekNote(req: Request<{ week: string }>) {
    return dateNoteService.getWeekNote(req.params.week, resolveCalendarRoot(req));
}

function getMonthNote(req: Request<{ month: string }>) {
    return dateNoteService.getMonthNote(req.params.month, resolveCalendarRoot(req));
}

function getQuarterNote(req: Request<{ quarter: string }>) {
    return dateNoteService.getQuarterNote(req.params.quarter, resolveCalendarRoot(req));
}

function getYearNote(req: Request<{ year: string }>) {
    return dateNoteService.getYearNote(req.params.year, resolveCalendarRoot(req));
}

/**
 * Resolves the calendar root a date-note request should be scoped to.
 *
 * Returns null when absent, meaning "let the service pick" — which is hoisting-dependent
 * and therefore wrong for workspace calendars, hence the client always passing one.
 */
function resolveCalendarRoot(req: Request) {
    const calendarRootId = req.query.calendarRootId;
    if (typeof calendarRootId !== "string" || !calendarRootId) {
        return null;
    }

    const note = becca.getNote(calendarRootId);
    if (!note) {
        throw new NotFoundError(`Calendar root '${calendarRootId}' not found.`);
    }

    return note;
}

function getDayNotesForMonth(req: Request) {
    const month = req.params.month;
    const calendarRoot = req.query.calendarRoot;
    const query = `\
        SELECT
            attr.value AS date,
            notes.noteId
        FROM notes
        JOIN attributes attr USING(noteId)
        WHERE notes.isDeleted = 0
            AND attr.isDeleted = 0
            AND attr.type = 'label'
            AND attr.name = 'dateNote'
            AND attr.value LIKE ? || '%'`;

    const sql = getSql();
    if (calendarRoot) {
        const rows = sql.getRows<{ date: string; noteId: string }>(query, [month]);
        const result: Record<string, string> = {};
        for (const { date, noteId } of rows) {
            const note = becca.getNote(noteId);
            if (note?.hasAncestor(String(calendarRoot))) {
                result[date] = noteId;
            }
        }

        return result;
    }
    return sql.getMap(query, [month]);
}

async function saveSqlConsole(req: Request) {
    return await specialNotesService.saveSqlConsole(req.body.sqlConsoleNoteId);
}

function createSqlConsole() {
    return specialNotesService.createSqlConsole();
}

function saveSearchNote(req: Request) {
    return specialNotesService.saveSearchNote(req.body.searchNoteId);
}

function createSearchNote(req: Request) {
    const hoistedNote = getHoistedNote();
    const searchString = req.body.searchString || "";
    const ancestorNoteId = req.body.ancestorNoteId || hoistedNote?.noteId;

    return specialNotesService.createSearchNote(searchString, ancestorNoteId);
}

function getHoistedNote() {
    return becca.getNote(cls.getHoistedNoteId());
}

function createLauncher(req: Request<{ parentNoteId: string, launcherType: string }>) {
    return specialNotesService.createLauncher({
        parentNoteId: req.params.parentNoteId,
        // TODO: Validate the parameter
        launcherType: req.params.launcherType as LauncherType
    });
}

function resetLauncher(req: Request<{ noteId: string }>) {
    return specialNotesService.resetLauncher(req.params.noteId);
}

function createOrUpdateScriptLauncherFromApi(req: Request) {
    return specialNotesService.createOrUpdateScriptLauncherFromApi(req.body);
}

export default {
    getInboxNote,
    getDayNote,
    getWeekFirstDayNote,
    getWeekNote,
    getMonthNote,
    getQuarterNote,
    getYearNote,
    getDayNotesForMonth,
    createSqlConsole,
    saveSqlConsole,
    createSearchNote,
    saveSearchNote,
    createLauncher,
    resetLauncher,
    createOrUpdateScriptLauncherFromApi
};
