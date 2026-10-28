/**
 * The recap an apply answers as `say`: one sentence of what it wrote and one of what it skipped,
 * built from its `written` and `skipped` entries alone, naming tasks by their ticket key or words and
 * days by their labels, never by an id.
 */

import { t } from "i18next";

import type { Skipped, Written } from "./apply.js";
import { dateLabel, plainText, weekdayName, withoutMoveLinks } from "./daily.js";

/**
 * `say` for an apply's result; `day` is the day its evening tasks and Context lines went to. It ends
 * with one plain question when an answer held items for being ambiguous, or `held` holds the texts
 * of items an earlier call held.
 */
export function sayOf({ written, skipped }: { written: Written[]; skipped: Skipped[] }, { day, held = [] }: { day: string; held?: string[] }): string {
    const made = written.filter((entry) => entry.status === "written");
    const of = (...kinds: string[]) => made.filter((entry) => kinds.includes(entry.kind));
    const labels = (entries: { text?: string; id?: string }[]) => unique(entries.map((entry) => labelOf(entry.text ?? entry.id ?? "")));
    const clause = (key: string, entries: { text?: string; id?: string }[], quoted = false) => {
        const items = labels(entries).map((label) => quoted ? `'${label}'` : label);
        return items.length ? [ t(`caius.say.${key}`, { items: andList(items), count: items.length }) ] : [];
    };
    const done = labels(of("done"));
    const moves = new Map<string, Written[]>();
    for (const entry of of("fate", "forward")) {
        if (entry.detail === "dropped") continue;
        const to = dateLabel(entry.detail ?? "") ?? entry.detail ?? "";
        moves.set(to, [ ...(moves.get(to) ?? []), entry ]);
    }
    const caught = of("catchup").filter((entry) => entry.detail !== "skip");
    const wrote = [
        ...(caught.length ? [ t("caius.say.caught_up", { count: caught.length }) ] : []),
        ...(of("catchup").some((entry) => entry.detail === "skip") ? [ t("caius.say.catchup_skipped") ] : []),
        ...clause("done", of("done")),
        ...[ ...moves ].map(([ to, entries ]) => t("caius.say.moved", { items: andList(labels(entries)), to })),
        ...clause("dropped", of("fate").filter((entry) => entry.detail === "dropped")),
        ...clause("accepted", of("accept")),
        ...of("place", "move").filter((entry) => entry.detail).map((entry) => t(`caius.say.${entry.detail}`, {
            item: labelOf(entry.text ?? entry.id ?? ""), anchor: labelOf(entry.anchor ?? "")
        })),
        ...clause("suggested", of("suggested")),
        ...clause("not_today", of("not_today")),
        ...clause("dismissed", of("dismiss")),
        ...clause("finished", of("finished").filter((entry) => !done.includes(labelOf(entry.id ?? "")))),
        ...(of("evening").length ? [ t("caius.say.evening", { items: andList(labels(of("evening"))), count: labels(of("evening")).length, weekday: weekdayName(day) }) ] : []),
        ...clause("noted", of("context"), true),
        ...clause("kept", of("keep", "carry"), true),
        ...(of("meetings").length ? [ t("caius.say.meetings") ] : []),
        ...(of("brief").length ? [ t("caius.say.brief") ] : [])
    ];
    const unnamed = skipped.filter((entry) => !entry.text && UNKNOWN.has(entry.reason)).length;
    const holding = skipped.filter((entry) => entry.reason === "ambiguous" && HOLDING.has(entry.kind));
    const missed = unique([
        ...skipped.filter((entry) => !holding.includes(entry)).flatMap((entry) => skipClause(entry)),
        ...(unnamed ? [ t("caius.say.unnamed", { count: unnamed }) ] : [])
    ]);
    const questions = holding.length
        ? unique(holding.map((entry) => {
            const noun = (entry.text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((word) => !QUESTION_FILLER.has(word)).join(" ");
            const matches = orList(unique((entry.detail ?? "").split("; ").map(labelOf)));
            return noun ? t("caius.say.which", { noun, matches }) : t("caius.say.which_held", { matches });
        }))
        : held.length ? [ t("caius.say.which_held", { matches: orList(unique(held.map(labelOf))) }) ] : [];
    const sentences = [ wrote, missed ].filter((clauses) => clauses.length).map((clauses) => `${capitalized(andList(clauses))}.`);
    if (!sentences.length && !questions.length) return t("caius.say.nothing");
    return [ ...sentences, ...questions ].join(" ");
}

/** Answers whose ambiguous items are held until he says which, so `say` asks. */
const HOLDING = new Set([ "done", "fate", "move" ]);

/** Words a which-question leaves out of what he said: "the export is done" asks "Which export". */
const QUESTION_FILLER = new Set([ "the", "a", "an", "my", "is", "are", "was", "done", "finished", "first", "it", "that", "this" ]);

/** Reasons that mean the answer named nothing the steps showed. */
const UNKNOWN = new Set([ "not_offered", "not_found", "not_on_list", "not_a_listed_day" ]);

/** One skipped answer as a clause about its item, or none for an unnamed one `sayOf` counts. */
function skipClause(entry: Skipped): string[] {
    const item = entry.text ? labelOf(entry.text) : null;
    if (entry.reason === "calendar_event" && entry.detail) return [ t("caius.say.calendar_event", { event: entry.detail }) ];
    if (entry.reason === "ambiguous") {
        return [ t("caius.say.ambiguous", { said: entry.text ?? "", matches: orList(unique((entry.detail ?? "").split("; ").map(labelOf))) }) ];
    }
    if (entry.reason === "calendar_unavailable") return [ t("caius.say.calendar_unavailable") ];
    if (UNKNOWN.has(entry.reason)) return item ? [ t("caius.say.not_found", { item }) ] : [];
    if (entry.reason === "duplicate" && item) return [ t("caius.say.duplicate", { item }) ];
    if (entry.reason === "stale") return [ item ? t("caius.say.stale", { item }) : t("caius.say.stale_unnamed") ];
    if (entry.reason === "third_person") return [ t("caius.say.not_noted", { item: entry.text ?? "" }) ];
    if (entry.reason === "edited") return [ t("caius.say.edited", { item: item ?? t("caius.say.a_task") }) ];
    if (entry.kind === "brief") return [ t("caius.say.brief_skipped") ];
    return [ t("caius.say.unchanged", { item: item ?? t("caius.say.a_task") }) ];
}

/**
 * A line for his notes in his voice: one that starts "Shawn takes X" becomes "Taking X"; one that
 * names him any other way is refused with the message the agent rewords it from. A line without his
 * name comes back as it is.
 */
export function inHisVoice(text: string): { text: string } | { error: string } {
    const name = new RegExp(`\\b${HIS_NAME}\\b`, "gi");
    const mentions = text.match(name)?.length ?? 0;
    if (!mentions) return { text };
    const simple = new RegExp(`^${HIS_NAME}\\s+([a-z]{2,})s\\s+(\\S.*)$`, "i").exec(text.trim());
    const verb = simple?.[1]?.toLowerCase();
    if (mentions === 1 && simple?.[2] && verb && !NOT_SIMPLE.has(verb)) return { text: `${capitalized(ingOf(verb))} ${simple[2]}` };
    return { error: t("caius.say.third_person", { name: HIS_NAME }) };
}

/** The name a line in his notes never uses for him. */
const HIS_NAME = "Shawn";

/** Verbs whose -ing form isn't their stem plus "ing" in his voice: "Shawn is out", "Shawn has the demo". */
const NOT_SIMPLE = new Set([ "i", "ha", "wa" ]);

/** The -ing form of a verb's stem: take → taking, see → seeing, run → running, cover → covering. */
function ingOf(stem: string): string {
    if (stem.endsWith("e") && !stem.endsWith("ee")) return `${stem.slice(0, -1)}ing`;
    if (/^[^aeiou]*[aeiou][bdgklmnprt]$/.test(stem)) return `${stem}${stem.at(-1)}ing`;
    return `${stem}ing`;
}

/** A task as `say` names it: its first ticket key, else its words without links, estimate or the Suggested wording. */
export function labelOf(text: string): string {
    const plain = plainText(withoutMoveLinks(text))
        .replace(/^Get (.+?) done(?:: because .*)?$/, "$1")
        .replace(/\s*\(~\d+m\)$/, "")
        .replace(/\s+~\d+(?:h\d*m?|m)$/, "")
        .trim();
    return /\b[A-Z][A-Z0-9]+-\d+\b/.exec(plain)?.[0] ?? plain;
}

function andList(items: string[]): string {
    return items.length > 1 ? t("caius.daily.list_and", { head: items.slice(0, -1).join(", "), last: items.at(-1) }) : items[0] ?? "";
}

function orList(items: string[]): string {
    return items.length > 1 ? t("caius.say.list_or", { head: items.slice(0, -1).join(", "), last: items.at(-1) }) : items[0] ?? "";
}

const unique = (items: string[]) => [ ...new Set(items.filter((item) => item !== "")) ];

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
