/**
 * The Caius planning tools for the AI assistant and the MCP server. Each tool takes its input
 * schema from `schemas.ts` and runs the matching operation of `service.ts`, which holds the logic
 * and the lock; the routes under `/api/caius/*` call the same operations.
 */

import type { NoteStore } from "@triliumnext/caius";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import type { z } from "zod";

import { toolInputs } from "./schemas.js";
import { readInputs } from "./inputs/index.js";
import { createCaiusService, type InputsReader } from "./service.js";
import type { DayWeather } from "./weather.js";

export function createCaiusTools(
    store?: NoteStore,
    weatherOf?: (latitude: number, longitude: number) => Promise<DayWeather | undefined>,
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
            description: "Read the day's outside inputs live: Jira tickets handed off to the user (Dev Verify, QA, Code Review) with their age, recent comments that mention or ask the user, which tickets Jira calls done, the day's calendar events from the iCal feeds, and the capacity the meetings leave. Pass the day's Context lines so a line such as \"ZAP-2590 is open\" beats Jira's Done. A source that fails is named in errors and the rest still return.",
            inputSchema: toolInputs.inputs,
            async: true,
            execute: parsed(toolInputs.inputs, (input) => readInputs(input))
        },

        caius_add: {
            description: "Add tasks to a day, week or month note, in a section, the Important block or the Suggested section. Takes a list of items.",
            inputSchema: toolInputs.add,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.add, service.add)
        },

        caius_accept: {
            description: "Accept suggested tasks: move them from a Suggested section into a section or the Important block. Takes a list of items.",
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
            description: "Write the Meetings block of a day note: plain clock lines such as \"10:00 Standup (Sam, Riley)\", never tasks. Without items, the lines come from the day's calendar: declined and all-day events left out, up to four first names, and (overlaps) on meetings that overlap. Replaces only that block; creates the day note if missing. Dry run first.",
            inputSchema: toolInputs.meetings,
            async: true,
            mutates: true,
            execute: parsed(toolInputs.meetings, service.meetings)
        },

        caius_header: {
            description: "Draw the day as terrain, from standup to bedtime, and attach it to a note as terrain.svg: meetings raise the line, planned work sits in bars under it, with a divider where work ends. Give latitude and longitude to add the day's weather. A second call updates the same attachment. Returns the attachment id and the <img> snippet to put in the note; it does not change the note's text.",
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
