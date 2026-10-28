/**
 * The Caius planning tools for the AI assistant and the MCP server. Each tool takes its input
 * schema from `schemas.ts` and runs the matching operation of `service.ts`, which holds the logic
 * and the lock; the routes under `/api/caius/*` call the same operations.
 */

import type { NoteStore } from "@triliumnext/caius";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import type { z } from "zod";

import { toolInputs } from "./schemas.js";
import { createCaiusService, type InputsReader } from "./service.js";
import type { DayWeather } from "./weather.js";

export function createCaiusTools(
    store?: NoteStore,
    weatherOf?: (latitude: number, longitude: number, date: string) => Promise<DayWeather | undefined>,
    inputsOf?: InputsReader
) {
    const service = createCaiusService(store, weatherOf, inputsOf);

    return defineTools({
        caius_plan: {
            description: "Read the plan of one day, week or month note: its sections, tasks, estimates and capacity, plus its Meetings bullets and the Context lines in force (expired ones apart). Use it to see what is planned for a period.",
            inputSchema: toolInputs.plan,
            async: true,
            execute: parsed(toolInputs.plan, service.plan)
        },

        caius_open: {
            description: "List open tasks across the Journal by lane (overdue, today, week, orbit, planning_ahead, someday, suggested), with each task's noteId and listItemId and, for overdue tasks, how many days late. Use it to find what needs attention.",
            inputSchema: toolInputs.open,
            async: true,
            execute: parsed(toolInputs.open, service.open)
        },

        caius_explain: {
            description: "Explain why a task is in its lane: the rule and the source that placed it. Use it when asked why a task is overdue, due today or suggested.",
            inputSchema: toolInputs.explain,
            async: true,
            execute: parsed(toolInputs.explain, service.explain)
        },

        caius_context: {
            description: "Read the Context in force for a day: the Context lines of that day's note, the last three workday notes, the current week note and, on a Monday, last week's. Expired lines are left out, and a line in several notes is returned once. Use it to see what is known about the state of things before planning a day.",
            inputSchema: toolInputs.context,
            async: true,
            execute: parsed(toolInputs.context, service.context)
        },

        caius_inputs: {
            description: "Read the day's outside inputs: Jira tickets handed off to the user (Dev Verify, QA, Code Review) with their age, recent comments that mention or ask the user, which tickets Jira calls done, the day's calendar events from the iCal feeds, and the capacity the meetings leave. Pass the day's Context lines so a line such as \"ZAP-2590 is open\" beats Jira's Done. A source that fails is named in errors and the rest still return. An answer is reused for 15 minutes; pass refresh to read again.",
            inputSchema: toolInputs.inputs,
            async: true,
            execute: parsed(toolInputs.inputs, service.inputs)
        },

        caius_add: {
            description: "Add tasks to a day, week or month note, in a section or the Important block (text), or the Suggested section (key, title, because and minutes, written as \"Get KEY title done: because why (~30m)\"; free text is rejected unless already in that shape). Takes a list of items.",
            inputSchema: toolInputs.add,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.add, service.add)
        },

        caius_accept: {
            description: "Accept suggested tasks: move them from a Suggested section to the end of Shawn's main list, in the order given, or into a section he names or the Important block. Takes a list of items.",
            inputSchema: toolInputs.accept,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.accept, service.accept)
        },

        caius_dismiss: {
            description: "Dismiss suggested tasks so they are not suggested again. Takes a list of items.",
            inputSchema: toolInputs.dismiss,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.dismiss, service.dismiss)
        },

        caius_set_state: {
            description: "Mark tasks done, doing or cancelled. A cancelled task needs a reason. Takes a list of items.",
            inputSchema: toolInputs.setState,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.setState, service.setState)
        },

        caius_forward: {
            description: "Forward tasks to another day, week or month note: marks each as rescheduled and copies it to the target. The source can be a day, week or month note too. Takes a list of items; `to` is YYYY-MM-DD, YYYY-Www or YYYY-MM.",
            inputSchema: toolInputs.forward,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.forward, service.forward)
        },

        caius_assign_ids: {
            description: "Give every list item in the Journal that has no list item id a stable one, so the caius_* tools and Trilium's task actions can target it. Reports, per note, how many items get an id and, on a dry run, their text. It is a dry run unless dryRun is false; show that first.",
            inputSchema: toolInputs.assignIds,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.assignIds, service.assignIds)
        },

        caius_meetings: {
            description: "Write the Meetings block of a day note: plain clock lines such as \"10:00 Standup (Sam, Riley)\", never tasks. Without items, the lines come from the day's calendar: declined and all-day events left out, up to four first names, and (overlaps) on meetings that overlap. Replaces only that block; creates the day note if missing. dryRun shows the change without writing; in Plan my day it is written without asking.",
            inputSchema: toolInputs.meetings,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.meetings, service.meetings)
        },

        caius_context_add: {
            description: "Add one Context line to a day note (date) or an ISO week note (week): a plain bullet under ### Context, never a task. A line about the state of things goes in the week note; only a line about one day goes in that day's note. Given date, a line that names a ticket or a state (is open, is out, on leave, until) is moved to that day's week note, with detail \"moved to the week note\". until is written as (until Fri 6 Nov). Text already in force is skipped as duplicate. Creates the heading and the note if missing. dryRun shows the change without writing.",
            inputSchema: toolInputs.contextAdd,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.contextAdd, service.contextAdd)
        },

        caius_context_keep: {
            description: "Keep Context lines Shawn agreed to keep or carry: writes each to the ISO week note of date, the day being planned or wound down to (the step's data.keepDate), never to a day note. A line already in force there is skipped as duplicate. His yes to the keep or carry question is the yes; no second dry run is needed.",
            inputSchema: toolInputs.contextKeep,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.contextKeep, service.contextKeep)
        },

        caius_brief_write: {
            description: "Write the day's Morning Brief: a \"🌅 Morning Brief\" child of the day note holding the header's include-note, the picks as \"Get X done: because Y (~30m)\" lines (only those that name a task of the day's main list, in its order; the rest come back in droppedPicks) and each section rendered from markdown, plus its \"Header\" child with the date line, the headline, the drawing (as caius_header draws it, with the work bars laid out again from the main list) and the three acts. Adds one include-note of the header at the top of the day note if it isn't there, and records each ask in followUps that a section names (#caiusRaised), so it isn't raised again for 7 days. A re-run updates the same notes. dryRun shows the change without writing; in Plan my day it is written without asking.",
            inputSchema: toolInputs.briefWrite,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.briefWrite, service.briefWrite)
        },

        caius_skip_catchup: {
            description: "Skip Plan my day's catch-up for a day: labels that day's note #caiusSkipCatchup=<date>, so the last workday's open tasks are left where they are and the catchup step no longer asks. Creates the day note if missing.",
            inputSchema: toolInputs.skipCatchup,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.skipCatchup, service.skipCatchup)
        },

        caius_finished: {
            description: "Record that Shawn says tickets are finished when they are not tasks to tick: labels today's day note #caiusFinished=<key>, so Wind down and Plan my day leave them out of the candidates for 30 days, and caius_add won't suggest them. Also dismisses their Suggested items on day notes from today on. Use it whenever he says a ticket is done that isn't on his list. No dry run: his word is the yes.",
            inputSchema: toolInputs.finished,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.finished, service.finished)
        },

        caius_winddown: {
            description: "Run one step of the Wind down conversation for the day being closed (date); every step works against the next workday. Steps in order: open (the live tasks of the day, the last three workdays and the week, each with a proposed fate, and older overdue tasks as a count), next (candidates for the next workday's Suggested, its capacity, overlaps and evening), context (the Context in force and the lines to keep or carry, which go to caius_context_keep with data.keepDate). Returns { step, data, question, next, standing }: ask question word for word, in the one message the conversation sends; a null question means nothing to ask; still do the step's writes. Then call the step named by next. Reads only; make the writes with the other caius_* tools.",
            inputSchema: toolInputs.winddown,
            async: true,
            execute: parsed(toolInputs.winddown, service.winddown)
        },

        caius_planday: {
            description: "Run one step of the Plan my day conversation for date, today or a missed earlier day; a later date answers error not_today. Steps in order: catchup (the last workday's open tasks, unless caius_skip_catchup was used for date), inputs (candidates new since the last brief, the Meetings block to write, overlaps, and on a day over 60% booked a task to move to the next workday; lines to carry go to caius_context_keep with data.keepDate), brief (the day's span from the standing note's Rhythm, the main list the picks come from, the work blocks for the drawing, the standing note's Brief rules and the input caius_brief_write takes). Returns { step, data, question, next, standing }: ask question word for word, in the one message the conversation sends; a null question means nothing to ask; still do the step's writes. Then call the step named by next. Reads only.",
            inputSchema: toolInputs.planday,
            async: true,
            execute: parsed(toolInputs.planday, service.planday)
        },

        caius_header: {
            description: "Draw the day as terrain, from standup to bedtime, and attach it to a note as terrain.svg: meetings raise the line, planned work sits in bars under it, with a divider where work ends. Give latitude and longitude to add today's weather. A second call updates the same attachment. Returns the attachment id and the <img> snippet to put in the note; it does not change the note's text.",
            inputSchema: toolInputs.header,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.header, service.header)
        }
    });
}

export const caiusTools = createCaiusTools();

/** Parses the arguments against `schema`, then runs `operation` on the result. */
function parsed<S extends z.ZodType, R>(schema: S, operation: (input: z.output<S>) => Promise<R>) {
    return (args: unknown) => operation(schema.parse(args));
}
