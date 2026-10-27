/**
 * The Caius planning tools for the AI assistant and the MCP server, backed by the becca
 * `NoteStore`. Each tool composes the `@triliumnext/caius` library the way the Caius CLI does for
 * its Trilium commands, without the argv and process I/O. The writes are async and mutating, so
 * the tool layer runs them in `transactionalAsync`.
 */

import {
    acceptTasks,
    addTasks,
    daysLate,
    dismissTasks,
    forwardTasks,
    loadJournal,
    loadStateSymbols,
    openTasks,
    type OpenTask,
    presentResult,
    readPlan,
    scanDocs,
    setStates,
    type StateAction,
    suggestedTasks,
    TRILIUM_CONFIG
} from "@triliumnext/caius";
import { date_utils as dateUtils } from "@triliumnext/core";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import { z } from "zod";

import { createBeccaStore } from "./store.js";

const LANES = ["overdue", "today", "week", "orbit", "planning_ahead", "someday", "suggested"] as const;
const DEFAULT_OPEN_LIMIT = 50;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = /^\d{4}-W\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const taskRef = {
    noteId: z.string().describe("The note the task is in, as returned by caius_open or caius_plan"),
    listItemId: z.string().describe("The task's list item id, as returned by caius_open or caius_plan")
};

const dryRun = z.boolean().optional().describe("Report what would change without writing anything");
const html = z.boolean().optional().describe("On a dry run, return each note's full before and after HTML instead of a summary of the change");

const addItem = z.object({
    date: z.string().regex(DAY).optional().describe("Day note, YYYY-MM-DD"),
    week: z.string().regex(WEEK).optional().describe("Week note, YYYY-Www"),
    month: z.string().regex(MONTH).optional().describe("Month note, YYYY-MM"),
    section: z.string().optional().describe("Heading to add the task under"),
    critical: z.boolean().optional().describe("Add the task to the Important block"),
    suggested: z.boolean().optional().describe("Add the task to the Suggested section"),
    text: z.string().describe("The task text"),
    source: z.string().optional().describe("A Jira key or URL, linked in the task and used to spot duplicates"),
    est: z.string().optional().describe("Estimate such as 30m, 2h or 1h30m")
}).refine(
    (item) => [item.date, item.week, item.month].filter((v) => v !== undefined).length === 1,
    "Give exactly one of date, week or month"
).refine(
    (item) => [item.section !== undefined, item.critical, item.suggested].filter(Boolean).length === 1,
    "Give exactly one of section, critical or suggested"
);

const acceptItem = z.object({
    ...taskRef,
    section: z.string().optional().describe("Heading to move the task under"),
    critical: z.boolean().optional().describe("Move the task into the Important block"),
    position: z.number().int().positive().optional().describe("1-based place in the destination list; default the end")
}).refine(
    (item) => [item.section !== undefined, item.critical].filter(Boolean).length === 1,
    "Give exactly one of section or critical"
);

const dismissItem = z.object(taskRef);

const stateItem = z.object({
    ...taskRef,
    state: z.enum(["done", "doing", "cancelled"]).describe("The state to put the task in"),
    reason: z.string().optional().describe("Why the task was cancelled; required for cancelled")
}).refine((item) => item.state !== "cancelled" || !!item.reason?.trim(), "A cancelled task needs a reason");

const forwardItem = z.object({
    ...taskRef,
    to: z.string().regex(DAY, "Forwarding takes a day, YYYY-MM-DD; weeks and months are not supported yet")
        .describe("The day to forward the task to, YYYY-MM-DD")
});

const STATE_ACTION: Record<"done" | "doing" | "cancelled", StateAction> = {
    done: "done",
    doing: "start",
    cancelled: "drop"
};

/**
 * The moment the planning tools treat as "now": Trilium's local date and time, which follows the
 * `trilium-local-now-datetime` header when the request carries one and the server clock otherwise.
 */
export function caiusNow(): Date {
    const match = dateUtils.localNowDateTime().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!match) {
        return new Date();
    }
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
    return new Date(year, month - 1, day, hour, minute, second);
}

function currentKey(period: "day" | "week" | "month", now: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (period === "day") {
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
    if (period === "month") {
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    }
    // ISO week: the year and number of the week's Thursday.
    const thursday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
    const week = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    return `${thursday.getUTCFullYear()}-W${pad(week)}`;
}

function keyMatches(period: "day" | "week" | "month", key: string): boolean {
    return (period === "day" ? DAY : period === "week" ? WEEK : MONTH).test(key);
}

/** An open task as the library reports it, plus the lane it sits in and, when overdue, how late it is. */
type LaneTask = OpenTask & { lane: string | null; daysLate?: number };

function toLaneTask(task: OpenTask, lane: string | null, now: Date): LaneTask {
    const lateBy = lane === "overdue" ? daysLate(task.period, now) : null;
    return { ...task, lane, ...(lateBy === null ? {} : { daysLate: lateBy }) };
}

export function createCaiusTools(store = createBeccaStore()) {
    return defineTools({
        caius_plan: {
            description: "Read the plan of one day, week or month note: its sections, tasks, estimates and capacity. Use it to see what is planned for a period.",
            inputSchema: z.object({
                period: z.enum(["day", "week", "month"]).describe("The kind of period note"),
                date: z.string().optional().describe("YYYY-MM-DD for a day, YYYY-Www for a week or YYYY-MM for a month. Defaults to the current period.")
            }),
            async: true,
            execute: async ({ period, date }) => {
                const now = caiusNow();
                const key = date ?? currentKey(period, now);
                if (!keyMatches(period, key)) {
                    return { error: `"${key}" is not a valid ${period} key` };
                }
                return readPlan(store, period, key, now);
            }
        },

        caius_open: {
            description: "List open tasks across the Journal by lane (overdue, today, week, orbit, planning_ahead, someday, suggested), with each task's noteId and listItemId and, for overdue tasks, how many days late. Use it to find what needs attention.",
            inputSchema: z.object({
                lane: z.enum(LANES).optional().describe("Only tasks in this lane"),
                limit: z.number().int().positive().optional().describe(`Maximum number of tasks to return. Defaults to ${DEFAULT_OPEN_LIMIT}.`)
            }),
            async: true,
            execute: async ({ lane, limit = DEFAULT_OPEN_LIMIT }) => {
                const now = caiusNow();
                const { docs } = await loadJournal(store);
                const result = scanDocs(docs, TRILIUM_CONFIG, now);
                const tasks = [
                    ...openTasks(docs, result).map((t) => toLaneTask(t, t.horizon, now)),
                    ...suggestedTasks(docs, now).map((t) => toLaneTask(t, "suggested", now))
                ].filter((t) => !lane || t.lane === lane);
                return { total: tasks.length, tasks: tasks.slice(0, limit) };
            }
        },

        caius_explain: {
            description: "Explain why a task is in its lane: the rule and the source that placed it. Use it when asked why a task is overdue, due today or suggested.",
            inputSchema: z.object(taskRef),
            async: true,
            execute: async ({ noteId, listItemId }) => {
                const now = caiusNow();
                const { docs } = await loadJournal(store);
                const doc = docs.find((d) => d.noteId === noteId);
                const line = doc && [...doc.itemIds].find(([, id]) => id === listItemId)?.[0];
                if (!doc || line === undefined) {
                    return { error: "not_found", detail: `No task ${listItemId} in note ${noteId}` };
                }

                const period = doc.path.match(/^Journal\/\w+\/([^/]+?)(?:\.md|\/)/)?.[1] ?? "";
                if (doc.suggested.has(line)) {
                    return {
                        noteId, listItemId, lane: "suggested", period,
                        rule: "Suggested section",
                        source: "The task is under the note's Suggested heading, so it is not part of any lane until accepted"
                    };
                }

                const task = scanDocs(docs, TRILIUM_CONFIG, now).tasks.find((t) => t.file === doc.path && t.line === line);
                const horizon = task?.derivations.find((d) => d.axis === "horizon");
                if (!task || !horizon) {
                    return { error: "not_found", detail: `Task ${listItemId} was not found in the scan of note ${noteId}` };
                }
                const lateBy = horizon.value === "overdue" ? daysLate(period, now) : null;
                return {
                    noteId, listItemId, text: task.text, state: task.state, period,
                    lane: horizon.value, rule: horizon.rule, source: horizon.source,
                    ...(lateBy === null ? {} : { daysLate: lateBy })
                };
            }
        },

        caius_add: {
            description: "Add tasks to a day, week or month note, in a section, the Important block or the Suggested section. Takes a list of items.",
            inputSchema: z.object({ items: z.array(addItem).min(1), dryRun, html }),
            async: true,
            mutates: true,
            execute: async ({ items, dryRun, html }) => ({ results: (await addTasks(store, items, { dryRun, now: caiusNow() })).map((r) => presentResult(r, html)) })
        },

        caius_accept: {
            description: "Accept suggested tasks: move them from a Suggested section into a section or the Important block. Takes a list of items.",
            inputSchema: z.object({ items: z.array(acceptItem).min(1), dryRun, html }),
            async: true,
            mutates: true,
            execute: async ({ items, dryRun, html }) => ({ results: (await acceptTasks(store, items, { dryRun })).map((r) => presentResult(r, html)) })
        },

        caius_dismiss: {
            description: "Dismiss suggested tasks so they are not suggested again. Takes a list of items.",
            inputSchema: z.object({ items: z.array(dismissItem).min(1), dryRun, html }),
            async: true,
            mutates: true,
            execute: async ({ items, dryRun, html }) => ({ results: (await dismissTasks(store, items, { dryRun })).map((r) => presentResult(r, html)) })
        },

        caius_set_state: {
            description: "Mark tasks done, doing or cancelled. A cancelled task needs a reason. Takes a list of items.",
            inputSchema: z.object({ items: z.array(stateItem).min(1), dryRun, html }),
            async: true,
            mutates: true,
            execute: async ({ items, dryRun, html }) => {
                const states = await loadStateSymbols(store);
                const results: object[] = [];
                for (const { state, ...item } of items) {
                    results.push(...(await setStates(store, STATE_ACTION[state as keyof typeof STATE_ACTION], [item], { dryRun, states })).map((r) => presentResult(r, html)));
                }
                return { results };
            }
        },

        caius_forward: {
            description: "Forward tasks to a later day: marks each as rescheduled and copies it to the day note. Takes a list of items; days only.",
            inputSchema: z.object({ items: z.array(forwardItem).min(1), dryRun, html }),
            async: true,
            mutates: true,
            execute: async ({ items, dryRun, html }) => ({ results: (await forwardTasks(store, items, { dryRun })).map((r) => presentResult(r, html)) })
        }
    });
}

export const caiusTools = createCaiusTools();
