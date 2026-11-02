/**
 * His reply to a ritual's step cards, written out in full: every item on every card with its
 * fate, the untouched ones with the default their own step data gives. Nothing is left to a
 * catch-all; the skill sheet reads a bare "looks right" as a yes to everything offered, which
 * takes every candidate.
 */

/** A leftover's or On deck item's fate as the step proposes it (`fate` in the step data). */
export type StepFate =
    | { forward: string; forwardLabel?: string; onDeck?: boolean }
    | { stay: string; stayLabel?: string }
    | { list: true }
    | { held: true }
    | { done: true };

/** A fate he can pick on a chip. */
export type Choice =
    | { kind: "proposed" }
    | { kind: "done" }
    | { kind: "day"; label: string; onDeck: boolean }
    | { kind: "period"; label: string }
    | { kind: "list" }
    | { kind: "stay-deck" }
    | { kind: "drop"; reason: string };

/** The words for the fate a step proposed. */
export function proposedPhrase(fate: StepFate | null | undefined): string {
    if (!fate) {
        return "stays where it is";
    }
    if ("done" in fate) {
        return "is done";
    }
    if ("list" in fate) {
        return "goes on today's list";
    }
    if ("held" in fate) {
        return "stays where it is";
    }
    if ("stay" in fate) {
        return `stays on ${fate.stayLabel ?? fate.stay}`;
    }
    const label = fate.forwardLabel ?? fate.forward;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fate.forward)) {
        return `goes to ${label}`;
    }
    return fate.onDeck ? `goes to ${label}'s On deck` : `goes on ${label}'s list`;
}

/** The words for a fate he picked, or the proposed one. */
export function choicePhrase(choice: Choice, proposed: StepFate | null | undefined): string {
    switch (choice.kind) {
        case "proposed": return proposedPhrase(proposed);
        case "done": return "is done";
        case "day": return choice.onDeck ? `goes to ${choice.label}'s On deck` : `goes on ${choice.label}'s list`;
        case "period": return `goes to ${choice.label}`;
        case "list": return "goes on today's list";
        case "stay-deck": return "stays on today's On deck";
        case "drop": return choice.reason ? `drop it: ${choice.reason}` : "drop it";
    }
}

/** One sentence naming every item with its fate: `"A" goes to Thu 5 Nov's On deck; "B" is done.` */
export function itemsReply(lead: string, items: { text: string; fate: StepFate | null | undefined; choice: Choice }[]): string {
    if (!items.length) {
        return "";
    }
    return `${lead}: ${items.map((item) => `"${item.text}" ${choicePhrase(item.choice, item.fate)}`).join("; ")}.`;
}

/** A candidate as the step offers it. `kind` and `sourceLabel` say where it stays when he doesn't take it. */
export interface CandidateData {
    text: string;
    kind?: string;
    sourceLabel?: string;
}

export type CandidateAnswer = "take" | "notToday" | "dismiss" | "finished" | null;

/**
 * What happens to a candidate he leaves alone, from its step data: a candidate from the week's
 * list stays there, and any other goes to the day's Suggested (`shelve` in the apply tools).
 */
export function candidateDefault(candidate: CandidateData): string {
    return candidate.kind === "week"
        ? `stays on ${candidate.sourceLabel ?? "the week's list"}`
        : "goes to Suggested";
}

/** Every candidate with his answer, or its default and "not taken": `"A": take it; "B": not taken, stays on the week of Mon 2 Nov.` */
export function candidatesReply(candidates: CandidateData[], answers: CandidateAnswer[]): string {
    if (!candidates.length) {
        return "";
    }
    const parts = candidates.map((c, i) => {
        switch (answers[i]) {
            case "take": return `"${c.text}": take it`;
            case "notToday": return `"${c.text}": not today`;
            case "dismiss": return `"${c.text}": not doing it, dismiss it`;
            case "finished": return `"${c.text}": finished`;
            default: return `"${c.text}": not taken, ${candidateDefault(c)}`;
        }
    });
    return `Candidates: ${parts.join("; ")}.`;
}

/** The evening: his words, the tasks already there, or nothing. */
export function eveningReply(answer: string | null, tasks: string[]): string {
    if (answer) {
        return `Evening: ${answer}.`;
    }
    return tasks.length ? `Evening: ${tasks.map((t) => `"${t}"`).join(", ")} as it is, nothing else.` : "Evening: nothing.";
}

export type ContextAnswer = "keep" | "end" | null;

/** Every Context line with his answer, or left as it is, and what he adds (nothing unless he typed it). */
export function contextReply(lines: { text: string; untilLabel?: string }[], answers: ContextAnswer[], dayLabel: string | undefined): string {
    const parts = lines.map((line, i) => answers[i] === "keep"
        ? `keep "${line.text}"`
        : answers[i] === "end"
            ? `let "${line.text}" end`
            : `"${line.text}" stays as it is${line.untilLabel ? ` (until ${line.untilLabel})` : ""}`);
    return `Context: ${[ ...parts, `nothing to add${dayLabel ? ` for ${dayLabel}` : ""}` ].join("; ")}.`;
}

/** What he has answered on one step card; anything missing is untouched. */
export interface StepAnswers {
    fates?: Record<number, Choice>;
    candidates?: Record<number, CandidateAnswer>;
    evening?: string | null;
    context?: Record<number, ContextAnswer>;
    catchup?: string | null;
}

/**
 * His answer to one step, as sentences: every item the step offers, with his answer or the step's
 * own default. The catch-up has no default (the step asks him to choose), so it says nothing
 * until he picks one.
 */
export function stepReply(step: { ritual: "plan" | "winddown"; step: string; data: Record<string, unknown> }, answers: StepAnswers): string[] {
    const d = step.data as {
        items?: { text: string; fate?: StepFate }[];
        onDeck?: { text: string; fate?: StepFate }[];
        candidates?: CandidateData[];
        evening?: { tasks?: string[] } | null;
        context?: { text: string; untilLabel?: string }[];
        keepDateLabel?: string;
    };
    const fate = (items: { text: string; fate?: StepFate }[]) => items.map((item, i) => ({ text: item.text, fate: item.fate, choice: answers.fates?.[i] ?? { kind: "proposed" as const } }));
    const candidates = (list: CandidateData[]) => candidatesReply(list, list.map((_, i) => answers.candidates?.[i] ?? null));
    const evening = () => eveningReply(answers.evening ?? null, d.evening?.tasks ?? []);

    switch (`${step.ritual}:${step.step}`) {
        case "plan:catchup":
            return answers.catchup ? [ `Catch-up: ${answers.catchup}.` ] : [];
        case "winddown:open":
            return [ itemsReply("Leftovers", fate(d.items ?? [])) ].filter(Boolean);
        case "plan:inputs":
            return [ itemsReply("On deck", fate(d.onDeck ?? [])), candidates(d.candidates ?? []), evening() ].filter(Boolean);
        case "winddown:next":
            return [ candidates(d.candidates ?? []), evening() ].filter(Boolean);
        case "winddown:context":
            return [ contextReply(d.context ?? [], (d.context ?? []).map((_, i) => answers.context?.[i] ?? null), d.keepDateLabel) ];
        default:
            return [];
    }
}

/** A chip's short words for a fate: `Thu · On deck`, `Thu · list`, `Done`, `Week`. */
export function chipLabel(choice: Choice, proposed: StepFate | undefined): string {
    const short = (label: string) => label.startsWith("the week") ? "Week" : label.split(" ")[0];
    switch (choice.kind) {
        case "proposed":
            if (!proposed || "held" in proposed) return "Stays";
            if ("done" in proposed) return "Done";
            if ("list" in proposed) return "On the list";
            if ("stay" in proposed) return "Stays";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed.forward)) return short(proposed.forwardLabel ?? proposed.forward);
            return `${short(proposed.forwardLabel ?? proposed.forward)} · ${proposed.onDeck ? "On deck" : "list"}`;
        case "done": return "Done";
        case "day": return `${short(choice.label)} · ${choice.onDeck ? "On deck" : "list"}`;
        case "period": return short(choice.label);
        case "list": return "On the list";
        case "stay-deck": return "Stays on deck";
        case "drop": return "Drop";
    }
}

/** One thing he tapped on a step card, as the answers pill lists it, and the change that puts it back as proposed. */
export interface StepPick {
    what: string;
    choice: string;
    undo: Partial<StepAnswers>;
}

const CATCHUP_LABELS: Record<string, string> = { "move all to today": "Move all to today", "let's review them": "Review them", "skip the catch-up": "Skip" };

const CANDIDATE_LABELS: Record<Exclude<CandidateAnswer, null>, string> = { take: "Take", notToday: "Not today", dismiss: "Dismiss", finished: "Finished" };

/**
 * What he tapped on one step card, and how many items the card offers in all: the pill counts the
 * picks, and the rest go as the step proposed (`stepReply` still names every one of them).
 */
export function stepPicks(step: { ritual: "plan" | "winddown"; step: string; data: Record<string, unknown> }, answers: StepAnswers): { picks: StepPick[]; total: number } {
    const d = step.data as {
        items?: { text: string; fate?: StepFate }[];
        onDeck?: { text: string; fate?: StepFate }[];
        candidates?: CandidateData[];
        context?: { text: string }[];
    };
    const fates = (items: { text: string; fate?: StepFate }[]): StepPick[] => items.flatMap((item, i) => {
        const choice = answers.fates?.[i];
        if (!choice || choice.kind === "proposed") {
            return [];
        }
        const label = chipLabel(choice, item.fate);
        return [ { what: item.text, choice: choice.kind === "drop" && choice.reason.trim() ? `${label}: ${choice.reason.trim()}` : label, undo: { fates: { ...answers.fates, [i]: { kind: "proposed" } } } } ];
    });
    const candidates = (list: CandidateData[]): StepPick[] => list.flatMap((c, i) => {
        const answer = answers.candidates?.[i];
        return answer ? [ { what: c.text, choice: CANDIDATE_LABELS[answer], undo: { candidates: { ...answers.candidates, [i]: null } } } ] : [];
    });
    const evening = (): StepPick[] => answers.evening ? [ { what: "Evening", choice: capitalize(answers.evening), undo: { evening: null } } ] : [];

    switch (`${step.ritual}:${step.step}`) {
        // The catch-up has no default: until he picks, it isn't answered at all, so it counts only once picked.
        case "plan:catchup":
            return answers.catchup ? { picks: [ { what: "Catch-up", choice: CATCHUP_LABELS[answers.catchup] ?? capitalize(answers.catchup), undo: { catchup: null } } ], total: 1 } : { picks: [], total: 0 };
        case "winddown:open":
            return { picks: fates(d.items ?? []), total: (d.items ?? []).length };
        case "plan:inputs":
            return { picks: [ ...fates(d.onDeck ?? []), ...candidates(d.candidates ?? []), ...evening() ], total: (d.onDeck ?? []).length + (d.candidates ?? []).length + 1 };
        case "winddown:next":
            return { picks: [ ...candidates(d.candidates ?? []), ...evening() ], total: (d.candidates ?? []).length + 1 };
        case "winddown:context": {
            const lines = d.context ?? [];
            const picks = lines.flatMap((line, i) => {
                const answer = answers.context?.[i];
                return answer ? [ { what: line.text, choice: answer === "keep" ? "Keep" : "Let it end", undo: { context: { ...answers.context, [i]: null } } } ] : [];
            });
            return { picks, total: lines.length };
        }
        default:
            return { picks: [], total: 0 };
    }
}

function capitalize(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
