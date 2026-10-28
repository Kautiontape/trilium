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

/** A Suggested line in its one format, `Get ZAP-1 Check the export done: because it waits (~30m)`. */
const SUGGESTED_LINE = /^Get \S.* done: because \S.* \(~\d+m\)$/;
const SUGGESTED_SHAPE = "A Suggested item takes key, title, because and minutes, written as \"Get KEY title done: because why (~30m)\"; text is accepted only in that shape";

const addItem = z.object({
    date: periodKey("day").optional().describe("Day note, YYYY-MM-DD"),
    week: periodKey("week").optional().describe("Week note, YYYY-Www"),
    month: periodKey("month").optional().describe("Month note, YYYY-MM"),
    section: z.string().optional().describe("Heading to add the task under"),
    critical: z.boolean().optional().describe("Add the task to the Important block"),
    suggested: z.boolean().optional().describe("Add the task to the Suggested section, from key, title, because and minutes"),
    text: z.string().optional().describe("The task text. Not for a Suggested item, unless already in its \"Get KEY title done: because why (~30m)\" shape."),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9]+-\d+$/, "Must be a Jira key such as ZAP-101").transform((key) => key.toUpperCase()).optional()
        .describe("Suggested: the Jira key, linked in the line"),
    title: z.string().trim().min(1).optional().describe("Suggested: what to get done, such as \"Check the invoice export in QA\""),
    because: z.string().trim().min(1).optional().describe("Suggested: why today, such as \"sitting in QA Testing for 3 days\""),
    minutes: z.number().int().positive().optional().describe("Suggested: the size in minutes"),
    source: z.string().optional().describe("A Jira key or URL, linked in the task and used to spot duplicates"),
    est: z.string().optional().describe("Estimate such as 30m, 2h or 1h30m; not for a Suggested item")
}).refine(
    (item) => [item.date, item.week, item.month].filter((v) => v !== undefined).length === 1,
    "Give exactly one of date, week or month"
).refine(
    (item) => [item.section !== undefined, item.critical, item.suggested].filter(Boolean).length === 1,
    "Give exactly one of section, critical or suggested"
).refine(
    (item) => item.suggested || (!!item.text?.trim() && [item.key, item.title, item.because, item.minutes].every((v) => v === undefined)),
    "Give text; key, title, because and minutes are for a Suggested item"
).refine(
    (item) => !item.suggested || (item.text === undefined
        ? item.title !== undefined && item.because !== undefined && item.minutes !== undefined
        : SUGGESTED_LINE.test(item.text.trim()) && [item.key, item.title, item.because, item.minutes].every((v) => v === undefined)),
    SUGGESTED_SHAPE
).refine(
    (item) => !item.suggested || item.est === undefined,
    "A Suggested item carries its size in minutes; don't give est as well"
).transform(({ key, title, because, minutes, text, ...item }) => ({
    ...item,
    text: text ?? `Get ${key ? `${key} ` : ""}${title} done: because ${because?.replace(/^because\s+/i, "")} (~${minutes}m)`,
    ...(key && item.source === undefined ? { source: key } : {})
}));

const acceptItem = z.object({
    ...taskRef,
    section: z.string().optional().describe("Heading to move the task under, only when the user names one. Without section or critical, the task joins the end of the main list."),
    critical: z.boolean().optional().describe("Move the task into the Important block"),
    position: z.number().int().positive().optional().describe("With section or critical: 1-based place in the destination list; default the end")
}).refine(
    (item) => [item.section !== undefined, item.critical].filter(Boolean).length <= 1,
    "Give at most one of section or critical"
).refine(
    (item) => item.position === undefined || item.section !== undefined || !!item.critical,
    "position needs a section or critical"
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

const headerClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:MM, such as 09:30");

const headerDay = z.object({
    start: headerClock.describe("Where the day starts, HH:MM: standup, such as 10:00"),
    end: headerClock.describe("Where the day ends, HH:MM: bedtime, such as 23:00"),
    workEnd: headerClock.optional().describe("Where work ends and the evening begins, HH:MM. Defaults to 18:00."),
    events: z.array(z.object({
        start: headerClock,
        end: headerClock,
        title: z.string(),
        overlap: z.boolean().optional().describe("Draw it as a hollow circle: it overlaps another meeting. Meetings that overlap in time are found anyway.")
    })).describe("The day's meetings"),
    work: z.array(z.object({
        start: headerClock,
        end: headerClock,
        label: z.string(),
        focus: z.boolean().optional().describe("The one focus block, drawn in the accent colour")
    })).describe("Planned work blocks")
});

const coordinates = {
    latitude: z.number().min(-90).max(90).optional().describe("With longitude, adds the day's weather to the drawing"),
    longitude: z.number().min(-180).max(180).optional().describe("With latitude, adds the day's weather to the drawing")
};

const bothOrNeither = (input: { latitude?: number; longitude?: number }) => (input.latitude === undefined) === (input.longitude === undefined);

const header = headerDay.extend({
    noteId: z.string().describe("The note to draw the header on, as an image attachment named terrain.svg"),
    ...coordinates
}).refine(bothOrNeither, "Give latitude and longitude together, or neither");

const briefWrite = z.object({
    date: periodKey("day").describe("The day the brief is for, YYYY-MM-DD"),
    headline: z.string().trim().min(1).describe("One sentence of 14 words or fewer that names the work"),
    acts: z.array(z.object({
        range: z.string().describe("The act's span, such as \"10:00 to 12:30\" or \"Evening\""),
        text: z.string().describe("One sentence: what fits in that span")
    })).length(3).describe("The day in three acts, the third the evening"),
    picks: z.array(z.object({
        text: z.string().describe("\"Get X done\""),
        because: z.string().describe("Why today, such as \"sitting in Dev Verify for 6 days\""),
        minutes: z.number().int().positive().describe("The size in minutes")
    })).describe("What to get done today, written as \"Get X done: because Y (~30m)\" lines"),
    sections: z.array(z.object({
        title: z.string().trim().min(1).describe("The section's heading, such as \"Follow up\" or \"Heads-up\""),
        markdown: z.string().describe("The section's body as markdown")
    })).describe("The sections after the picks, in order"),
    header: headerDay.describe("The drawing, as caius_header takes it without noteId"),
    followUps: z.array(z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/, "Must be a Jira key such as ZAP-101"), commentId: z.string() })).optional()
        .describe("The asks the brief step offered, as given. With a Follow up that has text, all are recorded so they aren't raised again for 7 days"),
    ...coordinates,
    dryRun
}).refine(bothOrNeither, "Give latitude and longitude together, or neither");

/** A finished answer: a Jira key, upper-cased, or anything else he called done, read as a done answer. */
const finishedAnswers = z.array(z.string().trim().min(1).transform((value) => /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(value) ? value.toUpperCase() : value)).default([])
    .describe("Tickets the user says are finished, by key; a key that names an open item ticks it too. Anything else he called done is read as a done answer");
/** What an answer may name an item by, as `refs.ts` resolves it. */
const NAMED = "its id or ref from the step data (such as o3fa9c), a ticket key or its number, or a distinctive word of its text";
/** A day, week or month an answer sends a task to. */
const DESTINATION = "A day's ref (d1) or date YYYY-MM-DD, a week YYYY-Www or a month YYYY-MM, from the step's data.days, data.weeks or data.months";
const candidateRef = z.object({ candidateId: z.string().min(1).describe(`A candidate: ${NAMED}`) });
const lineRef = z.object({ lineId: z.string().min(1).describe(`A keep or carry line: ${NAMED}`) });
/** Where an item goes in his main list: first, or before or after an item of `data.list` or a candidate taken in the same call. */
const place = {
    first: z.boolean().optional().describe("true puts it at the top of his list"),
    before: z.string().min(1).optional().describe(`Put it just before this item of his list or a candidate taken in the same call: ${NAMED}`),
    after: z.string().min(1).optional().describe(`Put it just after this item of his list or a candidate taken in the same call: ${NAMED}`)
};
const placed = (item: { first?: boolean; before?: string; after?: string }) => [ item.first || undefined, item.before, item.after ].filter((v) => v !== undefined).length;
const acceptRef = candidateRef.extend(place).refine((item) => placed(item) <= 1, "Give at most one of first, before or after");
const moveRef = z.object({ listItemId: z.string().min(1).describe(`An item of his main list: ${NAMED}`), ...place })
    .refine((item) => placed(item) === 1, "Give exactly one of first, before or after");
const moves = z.array(moveRef).default([]).describe("Only when the user asks to reorder: items of his main list moved first, before or after another");
/** His reply word for word, which the apply reads the fates he named from and checks a dismissal against. */
const said = z.string().describe("His reply this call answers, word for word, such as \"110 is done. 111 later this week\": a fate he named there that the call leaves out is applied as he named it, and a dismissal needs his word (dismiss, drop, cancel, not doing, answered) in it. \"\" only for a call no reply of his asked for, such as a refresh");
const answerTexts = (what: string) => z.array(z.string().trim().min(1)).default([]).describe(what);

const overlapAnswers = z.array(z.object({
    overlapId: z.string().min(1).describe("The overlap's overlapId from the step data"),
    take: z.string().trim().min(1).describe("The meeting he takes, by its title as the step gives it")
})).default([]).describe("His answer to each overlap question: the meeting he takes. Written as \"Taking X, not Y, at 11:00\" in the day's Context, and the other meeting leaves the day's Meetings, drawing and capacity");

const planApply = z.object({
    date: periodKey("day").describe("The day being planned, YYYY-MM-DD"),
    said,
    catchup: z.enum([ "move_all", "skip", "review" ]).optional().describe("The answer to the catch-up question, when one was asked"),
    accept: z.array(acceptRef).default([]).describe("The candidates the user took, in the order the user gave; each goes to the end of the list unless the user names a place (first, before or after)"),
    move: moves,
    keep: z.array(lineRef).default([]).describe("The keep or carry lines the user said yes to"),
    finished: finishedAnswers,
    notToday: z.array(candidateRef).default([]).describe("Candidates the user put off (\"skip\", \"not today\"): a ticket or week item is offered again on the next workday, an ask comes back as a Follow up. Not a dismissal"),
    dismiss: z.array(candidateRef).default([]).describe("Only candidates the user says to dismiss, drop or isn't doing, in his words in said: kept off every list for 14 days. A Follow up he says he answered (\"answered Jordan in chat\") goes here by its key and never comes back, unless a newer comment does"),
    evening: answerTexts("Things the user named for the evening, each written as a task under an Evening heading"),
    context: answerTexts("What the user said is worth knowing, each written as a Context line"),
    overlaps: overlapAnswers,
    forward: z.array(z.object({
        listItemId: z.string().min(1).describe(`A task: ${NAMED}`),
        to: z.string().min(1).describe(DESTINATION)
    })).optional().describe("Tasks the user moved, such as the heavy day's suggestion, each to one of the inputs step's data.days, data.weeks or data.months"),
    brief: z.object({
        headline: z.string().trim().min(1).describe("One sentence of 14 words or fewer that names the work"),
        acts: z.array(z.object({ range: z.string(), text: z.string() })).length(3).describe("The day in three acts, the third the evening"),
        sections: z.array(z.object({ title: z.string().trim().min(1), markdown: z.string() })).default([])
            .describe("Sections after the picks, such as Heads-up; Follow up is written by the tool")
    }).optional().describe("The brief's prose; the picks, the Follow up, the drawing and the weather come from the notes. Left out only on a call that just moves items of his list or just adds Context lines"),
    acts: z.array(z.union([ z.string(), z.object({ range: z.string(), text: z.string() }) ])).length(3).optional()
        .describe("Only with a call that just moves: the header's three acts in the new order, sent when the move changes the first task, each a sentence or { range, text }; a sentence takes the drawing's range. The tool writes the third, the evening")
}).refine((input) => input.brief !== undefined || onlyMoves(input) || onlyContext(input), "Give brief, unless the call only moves items of his list or only adds Context lines");

type Answers = { move: unknown[]; catchup?: unknown; accept: unknown[]; keep: unknown[]; finished: unknown[]; notToday: unknown[]; dismiss: unknown[]; evening: unknown[]; context: unknown[]; overlaps: unknown[]; forward?: unknown[] };

/** Whether a Plan my day answer only reorders his list: `move` and nothing else. */
export function onlyMoves(input: Answers): boolean {
    return input.move.length > 0 && input.catchup === undefined && !input.forward?.length
        && [ input.accept, input.keep, input.finished, input.notToday, input.dismiss, input.evening, input.context, input.overlaps ].every((answers) => answers.length === 0);
}

/** Whether a Plan my day answer only adds Context lines, as the retry of a line skipped as third person does. */
export function onlyContext(input: Answers): boolean {
    return input.context.length > 0 && input.catchup === undefined && !input.forward?.length
        && [ input.move, input.accept, input.keep, input.finished, input.notToday, input.dismiss, input.evening, input.overlaps ].every((answers) => answers.length === 0);
}

const windDownApply = z.object({
    date: periodKey("day").describe("The day being closed, YYYY-MM-DD; the rest works against the next workday"),
    said,
    done: z.array(z.string().min(1)).default([]).describe(`The open items the user says are done, each by ${NAMED}`),
    fates: z.array(z.object({
        listItemId: z.string().min(1).describe(`An open item: ${NAMED}`),
        to: z.string().min(1).optional().describe(`Where the user sends it. ${DESTINATION}`),
        drop: z.string().trim().min(1).optional().describe("Only when the user says drop, cancel or not doing: the user's reason")
    }).refine((fate) => (fate.to === undefined) !== (fate.drop === undefined), "Give exactly one of to or drop")).default([])
        .describe("Fates the user named. Every open item not named keeps the fate the open step proposed"),
    accept: z.array(acceptRef).default([]).describe("Candidates the user took for the next workday, in the user's order; each goes to the end of the list unless the user names a place (first, before or after)"),
    move: moves,
    keep: z.array(lineRef).default([]).describe("Keep lines the user said yes to"),
    carry: z.array(lineRef).default([]).describe("Carry lines the user said yes to"),
    finished: finishedAnswers,
    notToday: z.array(candidateRef).default([]).describe("Candidates the user put off for the next workday: a ticket or week item is offered again the workday after, an ask comes back as a Follow up. Not a dismissal"),
    dismiss: z.array(candidateRef).default([]).describe("Only candidates the user says to dismiss, drop or isn't doing, in his words in said: kept off every list for 14 days. A Follow up he says he answered (\"answered Jordan in chat\") goes here by its key and never comes back, unless a newer comment does"),
    evening: answerTexts("Things the user named for the next workday's evening, each a task under an Evening heading"),
    context: answerTexts("What the user said is worth knowing for the next workday, each a Context line"),
    overlaps: overlapAnswers
});

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
    context: z.object({
        date: periodKey("day").describe("The day to gather Context for, YYYY-MM-DD")
    }),
    assignIds: z.object({
        dryRun: z.boolean().default(true).describe("Report what would change without writing anything. Defaults to true; pass false to write."),
        html
    })
};

const inputsClock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Must be HH:MM, from 00:00 to 24:00");

const inputs = z.object({
    date: periodKey("day").describe("The day to read inputs for, YYYY-MM-DD"),
    context: z.array(z.string()).optional().describe("The day's Context lines. A line that names a ticket key and says it is open overrides Jira's Done."),
    keys: z.array(z.string()).optional().describe("More ticket keys to check for Done, such as those named in the week note's items and the Context lines"),
    workStart: inputsClock.optional().describe("Start of the work window, HH:MM. Defaults to 10:00."),
    workEnd: inputsClock.optional().describe("End of the work window, HH:MM. Defaults to 18:00.")
});

const meetings = z.object({
    date: periodKey("day").describe("The day note to write the Meetings block of, YYYY-MM-DD"),
    items: z.array(z.string()).optional().describe("The clock lines to write, such as \"10:00 Standup (Sam, Riley)\". Without them, the lines come from the day's calendar."),
    dryRun,
    refresh: z.boolean().optional().describe("Without items: read the calendar again instead of reusing what was read for that day in the last 15 minutes")
});

const contextAdd = z.object({
    date: periodKey("day").optional().describe("The day note to add the line to, YYYY-MM-DD: for a fact about that one day. A line that names a ticket, a state or a span of days goes to a week note instead (next week's for \"next week\"), unless it has a clock time or a part of today."),
    week: periodKey("week").optional().describe("The ISO week note to add the line to, YYYY-Www: the default for a fact about the state of things"),
    text: z.string().trim().min(1).describe("The line, such as \"ZAP-2590 is open\""),
    until: periodKey("day").optional().describe("The last day the line holds, YYYY-MM-DD; written as (until Fri 6 Nov)"),
    dryRun
}).refine((input) => (input.date === undefined) !== (input.week === undefined), "Give exactly one of date or week");

const contextKeep = z.object({
    date: periodKey("day").describe("The day being planned (Plan my day) or wound down to (Wind down's next workday), YYYY-MM-DD: the step's data.keepDate. The lines go to that day's ISO week note."),
    lines: z.array(z.object({
        text: z.string().trim().min(1).describe("The line, such as \"ZAP-2590 is open\""),
        until: periodKey("day").optional().describe("The last day the line holds, YYYY-MM-DD")
    })).min(1).describe("The lines the user wants kept"),
    dryRun
});

const finished = z.object({
    keys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]+-\d+$/, "Must be a Jira key such as ZAP-101").transform((key) => key.toUpperCase()))
        .min(1).describe("The tickets he says are finished, such as [\"ZAP-101\"]"),
    note: z.string().optional().describe("The day or week note to record it on, by noteId. Defaults to today's day note.")
});

const skipCatchup = z.object({
    date: periodKey("day").describe("The day being planned, YYYY-MM-DD, whose catch-up is skipped")
});

const refresh = z.boolean().optional().describe("Fetch Jira and the calendar again instead of reusing what was read for that day in the last 15 minutes");

const winddown = z.object({
    date: periodKey("day").describe("The day being closed, YYYY-MM-DD. The steps work against the next workday after it."),
    step: z.enum([ "open", "next", "context" ]).describe("open, then next, then context"),
    refresh,
    older: z.boolean().optional().describe("open: count the older overdue tasks on a day other than Friday, only when the user asks about them")
});

const planday = z.object({
    date: periodKey("day").describe("The day being planned, YYYY-MM-DD"),
    step: z.enum([ "catchup", "inputs", "brief" ]).describe("catchup, then inputs, then brief"),
    refresh,
    answered: z.object({
        evening: z.array(z.string()).optional().describe("What he already said about the evening in this conversation, even nothing: the step doesn't ask about it"),
        keep: z.array(z.string()).optional().describe("The Context lines he already said to keep in this conversation, by their words, lineId or ref: the step doesn't offer them to carry")
    }).optional().describe("inputs: the answers he already gave in this conversation, such as in the wind-down just before")
});

export const toolInputs = {
    ...reads,
    inputs: inputs.extend({
        refresh: z.boolean().optional().describe("Fetch Jira and the calendar again instead of reusing what was read for the same input in the last 15 minutes")
    }),
    meetings,
    contextAdd,
    contextKeep,
    briefWrite,
    skipCatchup,
    finished,
    winddown,
    planday,
    planApply,
    windDownApply,
    add: writes(addItem),
    accept: writes(acceptItem),
    dismiss: writes(dismissItem),
    setState: writes(stateItem),
    forward: writes(forwardItem),
    header
};

/** The nudge bar's state for a day note. */
const nudge = z.object({
    date: periodKey("day").describe("The day note the bar is on, YYYY-MM-DD")
});

export const routeInputs = {
    ...reads,
    nudge,
    skipCatchup,
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

export type InputsInput = z.infer<typeof inputs>;
export type InputsToolInput = z.infer<typeof toolInputs.inputs>;
export type MeetingsInput = z.infer<typeof meetings>;
export type ContextAddInput = z.infer<typeof contextAdd>;
export type ContextKeepInput = z.infer<typeof contextKeep>;
export type PlanInput = z.infer<typeof reads.plan>;
export type OpenInput = z.infer<typeof reads.open>;
export type ExplainInput = z.infer<typeof reads.explain>;
export type ContextInput = z.infer<typeof reads.context>;
export type AssignIdsInput = z.infer<typeof reads.assignIds>;
export type HeaderInput = z.infer<typeof header>;
export type HeaderDay = z.infer<typeof headerDay>;
export type BriefWriteInput = z.infer<typeof briefWrite>;
export type SkipCatchupInput = z.infer<typeof skipCatchup>;
export type FinishedInput = z.infer<typeof finished>;
export type NudgeInput = z.infer<typeof nudge>;
export type WindDownInput = z.infer<typeof winddown>;
export type PlanDayInput = z.infer<typeof planday>;
export type PlanApplyInput = z.output<typeof planApply>;
export type WindDownApplyInput = z.output<typeof windDownApply>;
export type AddInput = z.infer<typeof toolInputs.add>;
export type AcceptInput = z.infer<typeof routeInputs.accept>;
export type DismissInput = z.infer<typeof routeInputs.dismiss>;
export type SetStateInput = z.infer<typeof routeInputs.setState>;
export type ForwardInput = z.infer<typeof routeInputs.forward>;
export type ApplyInput = z.infer<typeof routeInputs.apply>;
