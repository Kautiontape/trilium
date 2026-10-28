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
            description: "Accept suggested tasks: move them from a Suggested section to the end of the user's main list, in the order given, or into a section the user names or the Important block. Takes a list of items.",
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
            description: "Write the Meetings block of a day note, today or an earlier day (a later date answers error not_today): plain clock lines such as \"10:00 Standup (Sam, Riley)\", never tasks. Without items, the lines come from the day's calendar: declined and all-day events left out, up to four first names, and (overlaps) on meetings that overlap. Replaces only that block; creates the day note if missing. dryRun shows the change without writing. In Plan my day, caius_plan_apply writes it.",
            inputSchema: toolInputs.meetings,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.meetings, service.meetings)
        },

        caius_context_add: {
            description: "Add one Context line to a day note (date) or an ISO week note (week): a plain bullet under ### Context, never a task. A line about the state of things goes in the week note; only a line about one day goes in that day's note. Given date, a line with a clock time or today, tonight, this morning, afternoon or evening stays on the day; otherwise these move to a week note, with detail \"moved to the week note\": next week, to next week's note; a weekday range (Thu-Fri), until its last day; this week, all week, until a weekday or date, or a ticket key, with no end; a state (is open, out, off or down, away, on leave, covering, freeze, on PTO, vacation or holiday), ending that day. Anything else stays on the day. until is written as (until Fri 6 Nov). Text already in force is skipped as duplicate. Creates the heading and the note if missing. dryRun shows the change without writing.",
            inputSchema: toolInputs.contextAdd,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.contextAdd, service.contextAdd)
        },

        caius_context_keep: {
            description: "Keep Context lines the user agreed to keep or carry: writes each to the ISO week note of date, the day being planned or wound down to (the step's data.keepDate), never to a day note. A line already in force there is skipped as duplicate. The user's yes to the keep or carry question is the yes; no second dry run is needed.",
            inputSchema: toolInputs.contextKeep,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.contextKeep, service.contextKeep)
        },

        caius_brief_write: {
            description: "Write the day's Morning Brief, today's or an earlier day's (a later date answers error not_today): a \"🌅 Morning Brief\" child of the day note holding the header's include-note, the picks as \"Get X done: because Y (~30m)\" lines (only those that name a task of the day's main list, in its order; the rest come back in droppedPicks) and each section rendered from markdown, plus its \"Header\" child with the date line, the headline, the drawing (as caius_header draws it, with the work bars laid out again from the main list) and the three acts. Adds one include-note of the header at the top of the day note if it isn't there, and records each ask in followUps that a section names (#caiusRaised), so it isn't raised again for 7 days. A re-run updates the same notes, and the weather's coordinates come from the standing note. dryRun shows the change without writing. In Plan my day, caius_plan_apply writes the brief.",
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
            description: "Record that the user says tickets are finished when they are not tasks to tick: labels today's day note #caiusFinished=<key>, so Wind down and Plan my day leave them out of the candidates for 30 days, and caius_add won't suggest them. Also dismisses their Suggested items on day notes from today on. Use it whenever the user says a ticket is done that isn't on the list. No dry run: the user's word is the yes.",
            inputSchema: toolInputs.finished,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.finished, service.finished)
        },

        caius_winddown: {
            description: "Run one step of the Wind down conversation for the day being closed (date); every step works against the next workday. Steps in order: open (the live tasks of the day, the last three workdays and the week, each with a proposed fate and jiraDone when Jira calls its ticket done, and older overdue tasks as a count), next (candidates for the next workday's Suggested, its capacity, overlaps and evening), context (the Context in force and the lines to keep or carry, which caius_winddown_apply writes from the user's answer; its question always ends with the one line asking what to add). Returns { step, data, question, next, standing }: ask question word for word, in the one message the conversation sends; a null question means nothing to ask. Call the step named by next, send the one message, then call caius_winddown_apply once with the user's answers. Reads only; every date comes with a display string (the …Label fields) to use as given.",
            inputSchema: toolInputs.winddown,
            async: true,
            execute: parsed(toolInputs.winddown, service.winddown)
        },

        caius_planday: {
            description: "Run one step of the Plan my day conversation for date, today or a missed earlier day; a later date answers error not_today. Steps in order: catchup (the open tasks of every workday since the last closed one, unless the catch-up was skipped for date), inputs (candidates new since the last brief, the Meetings block to write, overlaps, the day's one capacity block, and on a day at least half booked a task to move to the next workday when the work is over the focus target, or a summary that it fits; the lines to carry, which caius_plan_apply writes from the user's answer), brief (the day's span from the standing note's Rhythm, the main list the picks come from, the work blocks for the drawing, the standing note's Brief rules and the input caius_brief_write takes). Returns { step, data, question, next, standing }: ask question word for word, in the one message the conversation sends; a null question means nothing to ask. Call catchup, then inputs, send the one message, then call caius_plan_apply once with the user's answers; the brief step is for caius_brief_write outside that flow. Reads only; every date comes with a display string (the …Label fields) to use as given.",
            inputSchema: toolInputs.planday,
            async: true,
            execute: parsed(toolInputs.planday, service.planday)
        },

        caius_plan_apply: {
            description: "Make every write of a Plan my day conversation in one call, after the user has answered the one question set: the catch-up, the candidates the user took in the user's order (each to the end of the list, or first, before or after an item the user names), items of the list the user asked to reorder, the keep or carry lines, finished tickets, candidates put off for today (not a dismissal), evening tasks, Context lines, forwards, the Meetings block, and the brief with its picks, Follow up, drawing and weather. Every id comes from caius_planday's step data. Write only the brief's headline, acts and extra sections. No dry run: the user has answered. Answers what was written and what was skipped, with a reason; a re-run with the same input changes nothing. A call with only move and no brief, at any point in the conversation, just reorders the list, and redraws the header when that changes the picks.",
            inputSchema: toolInputs.planApply,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.planApply, service.planApply)
        },

        caius_winddown_apply: {
            description: "Make every write of a Wind down conversation in one call, after the user has answered the one question set: what is done, the fates the user named (a forward, or a drop only on the user's word drop, cancel or not doing, with the reason), the proposed fate for every open item not named, the next workday's candidates the user took in order (each to the end of the list, or first, before or after an item the user names), items of its list the user asked to reorder, the keep and carry lines, finished tickets, candidates put off (not a dismissal), evening tasks and Context lines for the next workday, and last, the header of a day that has a brief, drawn again from the note as it ends. Every id comes from caius_winddown's step data. No dry run: the user has answered. Answers what was written and what was skipped, with a reason, and next: \"planday\" with nextCall { tool: \"caius_planday\", date } when the next workday is today (a morning Review of an older day), so Plan my day goes on for it at once; a re-run changes nothing. A correction after the apply is one more call with only what he corrected, such as one fate; it changes only that.",
            inputSchema: toolInputs.windDownApply,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.windDownApply, service.windDownApply)
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
