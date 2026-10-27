/**
 * The Caius planning tools for the AI assistant and the MCP server. Each tool takes its input
 * schema from `schemas.ts` and runs the matching operation of `service.ts`, which holds the logic
 * and the lock; the routes under `/api/caius/*` call the same operations.
 */

import type { NoteStore } from "@triliumnext/caius";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import type { z } from "zod";

import { toolInputs } from "./schemas.js";
import { createCaiusService } from "./service.js";

export function createCaiusTools(store?: NoteStore) {
    const service = createCaiusService(store);

    return defineTools({
        caius_plan: {
            description: "Read the plan of one day, week or month note: its sections, tasks, estimates and capacity. Use it to see what is planned for a period.",
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
        }
    });
}

export const caiusTools = createCaiusTools();

/** Parses the arguments against `schema`, then runs `operation` on the result. */
function parsed<S extends z.ZodType, R>(schema: S, operation: (input: z.output<S>) => Promise<R>) {
    return (args: unknown) => operation(schema.parse(args));
}
