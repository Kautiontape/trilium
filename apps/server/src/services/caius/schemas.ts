/**
 * The input schemas of the Caius operations. The `caius_*` tools take `toolInputs`; the
 * `/api/caius/*` routes take `routeInputs`, which add an optional `expectedBlobId` to each item
 * that acts on a note of its own.
 */

import { isPeriodKey, PERIODS } from "@triliumnext/caius";
import { z } from "zod";

export const LANES = ["overdue", "today", "week", "orbit", "planning_ahead", "someday", "suggested"] as const;
export const DEFAULT_OPEN_LIMIT = 50;

/** A string that names a day, ISO week or month that exists, such as `2026-10-27`, `2026-W44` or `2026-10`. */
const periodKey = (kind: "day" | "week" | "month") =>
    z.string().regex(PERIODS[kind].pattern).refine((key) => isPeriodKey(kind, key), `Must be a ${PERIODS[kind].shape} that exists`);

const taskRef = {
    noteId: z.string().describe("The note the task is in, as returned by caius_open or caius_plan"),
    listItemId: z.string().describe("The task's list item id, as returned by caius_open or caius_plan")
};

const version = {
    expectedBlobId: z.string().optional().describe("The note's blobId the client acted on; the item is skipped as stale when the note has changed since")
};

const dryRun = z.boolean().optional().describe("Report what would change without writing anything");
const html = z.boolean().optional().describe("On a dry run, return each note's full before and after HTML instead of a summary of the change");

const addItem = z.object({
    date: periodKey("day").optional().describe("Day note, YYYY-MM-DD"),
    week: periodKey("week").optional().describe("Week note, YYYY-Www"),
    month: periodKey("month").optional().describe("Month note, YYYY-MM"),
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
    to: z.string().refine(
        (to) => isPeriodKey("day", to) || isPeriodKey("week", to) || isPeriodKey("month", to),
        "Forwarding takes a day YYYY-MM-DD, an ISO week YYYY-Www or a month YYYY-MM that exists"
    )
        .describe("The note to forward the task to: a day YYYY-MM-DD, an ISO week YYYY-Www or a month YYYY-MM")
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:MM, such as 09:30");

const header = z.object({
    noteId: z.string().describe("The note to draw the header on, as an image attachment named terrain.svg"),
    start: clock.describe("Where the day starts, HH:MM: standup, such as 10:00"),
    end: clock.describe("Where the day ends, HH:MM: bedtime, such as 23:00"),
    workEnd: clock.optional().describe("Where work ends and the evening begins, HH:MM. Defaults to 18:00."),
    events: z.array(z.object({
        start: clock,
        end: clock,
        title: z.string(),
        overlap: z.boolean().optional().describe("Draw it as a hollow circle: it overlaps another meeting. Meetings that overlap in time are found anyway.")
    })).describe("The day's meetings"),
    work: z.array(z.object({
        start: clock,
        end: clock,
        label: z.string(),
        focus: z.boolean().optional().describe("The one focus block, drawn in the accent colour")
    })).describe("Planned work blocks"),
    latitude: z.number().min(-90).max(90).optional().describe("With longitude, adds the day's weather to the drawing"),
    longitude: z.number().min(-180).max(180).optional().describe("With latitude, adds the day's weather to the drawing")
}).refine(
    (input) => (input.latitude === undefined) === (input.longitude === undefined),
    "Give latitude and longitude together, or neither"
);

const writes = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item).min(1), dryRun, html });

const reads = {
    plan: z.object({
        period: z.enum(["day", "week", "month"]).describe("The kind of period note"),
        date: z.string().optional().describe("YYYY-MM-DD for a day, YYYY-Www for a week or YYYY-MM for a month. Defaults to the current period.")
    }),
    open: z.object({
        lane: z.enum(LANES).optional().describe("Only tasks in this lane"),
        limit: z.number().int().positive().optional().describe(`Maximum number of tasks to return. Defaults to ${DEFAULT_OPEN_LIMIT}.`)
    }),
    explain: z.object(taskRef),
    assignIds: z.object({
        dryRun: z.boolean().default(true).describe("Report what would change without writing anything. Defaults to true; pass false to write."),
        html
    })
};

export const toolInputs = {
    ...reads,
    add: writes(addItem),
    accept: writes(acceptItem),
    dismiss: writes(dismissItem),
    setState: writes(stateItem),
    forward: writes(forwardItem),
    header
};

export const routeInputs = {
    ...reads,
    add: writes(addItem),
    accept: writes(acceptItem.safeExtend(version)),
    dismiss: writes(dismissItem.extend(version)),
    setState: writes(stateItem.safeExtend(version)),
    forward: writes(forwardItem.extend(version)),
    /** The Plan tab's Close: forwards, then state changes, behind one version check. */
    apply: z.object({
        forwards: z.array(forwardItem).default([]),
        drops: z.array(stateItem).default([]),
        expectedBlobId: version.expectedBlobId
    }).refine((input) => input.forwards.length + input.drops.length > 0, "Give at least one forward or drop")
        .refine(
            ({ expectedBlobId, forwards, drops }) => expectedBlobId === undefined
                || new Set([ ...forwards, ...drops ].map(({ noteId }) => noteId)).size === 1,
            "An expectedBlobId versions one note, so every forward and drop must be in one note"
        )
};

export type PlanInput = z.infer<typeof reads.plan>;
export type OpenInput = z.infer<typeof reads.open>;
export type ExplainInput = z.infer<typeof reads.explain>;
export type AssignIdsInput = z.infer<typeof reads.assignIds>;
export type HeaderInput = z.infer<typeof header>;
export type AddInput = z.infer<typeof toolInputs.add>;
export type AcceptInput = z.infer<typeof routeInputs.accept>;
export type DismissInput = z.infer<typeof routeInputs.dismiss>;
export type SetStateInput = z.infer<typeof routeInputs.setState>;
export type ForwardInput = z.infer<typeof routeInputs.forward>;
export type ApplyInput = z.infer<typeof routeInputs.apply>;
