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
export function sayOf({ written, skipped }: { written: Written[]; skipped: Skipped[] }, { day, held = [], asking = [], already = [] }: { day: string; held?: HeldItem[]; asking?: { intent: string; texts: string[] }[]; already?: { text: string; how: string }[] }): string {
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
    // An answer found already settled is said, never folded silently into "already in place".
    const settled = [ "done", "dropped", "moved", "taken" ].flatMap((how) => clause(`already_${how}`, already.filter((entry) => entry.how === how)));
    const wrote = [
        ...settled,
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
            const said = (entry.text ?? "").trim();
            const key = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(said) ? said.toUpperCase() : null;
            const noun = key ?? said.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((word) => !QUESTION_FILLER.has(word)).join(" ");
            const texts = (entry.detail ?? "").split("; ");
            // Matches that share a key are told apart by their words.
            const labels = unique(texts.map(labelOf));
            const matches = orList(labels.length < texts.length ? texts.map((text) => labelWords(text, key)) : labels);
            return noun ? t("caius.say.which", { noun, matches }) : t("caius.say.which_held", { matches });
        }))
        : [ heldQuestion(held) ].filter((question): question is string => question !== null);
    // Items left held after an answer of another intent are asked about by name.
    const named = asking.filter((ask) => ask.texts.length).map((ask) => {
        const items = unique(ask.texts.map(labelOf));
        const what = t(`caius.say.intent_${ask.intent}`);
        return items.length > 1 ? t("caius.say.and_which", { items: orList(items), what }) : t("caius.say.and_is_it", { item: items[0], what });
    });
    questions.push(...named);
    const sentences = [ wrote, missed ].filter((clauses) => clauses.length).map((clauses) => `${capitalized(andList(clauses))}.`);
    if (!sentences.length && !questions.length) return t("caius.say.nothing");
    return [ ...sentences, ...questions ].join(" ");
}

/**
 * The one question about items held from an earlier call, by their texts: "Which do you mean:
 * ZAP-111 or ZAP-101?", "What about ZAP-101?" for one, or null for none. The catch-up step asks it too.
 */
export function heldQuestion(held: HeldItem[]): string | null {
    // Items held on several days are told apart by their day.
    const days = new Set(held.map((item) => item.period).filter((period) => period && dateLabel(period)));
    const labels = unique(held.map((item) => days.size > 1 && item.period ? `${labelOf(item.text)} (${dateLabel(item.period)})` : labelOf(item.text)));
    if (labels.length > 1) return t("caius.say.which_held", { matches: orList(labels) });
    return labels[0] ? t("caius.say.what_about", { item: labels[0] }) : null;
}

/** An item held from an earlier call: its words, and the period it sits on. */
export interface HeldItem {
    text: string;
    period?: string;
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
    if (entry.reason === "review") return [ t("caius.say.review") ];
    if (entry.reason === "not_a_move") return [ t("caius.say.acts_not_a_move") ];
    if (entry.reason === "third_person") return [ t("caius.say.not_noted", { item: entry.text ?? "" }) ];
    if (entry.reason === "edited") return [ t("caius.say.edited", { item: item ?? t("caius.say.a_task") }) ];
    if (entry.kind === "brief") return [ t("caius.say.brief_skipped") ];
    return [ t("caius.say.unchanged", { item: item ?? t("caius.say.a_task") }) ];
}

/**
 * A line for his notes in his voice: one that is exactly "Shawn", one verb of `HIS_VERBS` and the
 * rest is written with that verb's form ("Shawn takes X" becomes "Taking X"); any other line that
 * names him is refused with the message the agent rewords it from. A line without his name comes
 * back as it is.
 */
export function inHisVoice(text: string): { text: string } | { error: string } {
    const mentions = text.match(new RegExp(`\\b${HIS_NAME}\\b`, "gi"))?.length ?? 0;
    if (!mentions) return { text };
    const line = text.trim();
    if (mentions === 1) {
        for (const [ verb, form ] of HIS_VERBS) {
            const m = new RegExp(`^${HIS_NAME}\\s+${verb}\\s+(\\S.*)$`, "i").exec(line);
            if (m?.[1]) return { text: form ? `${form} ${m[1]}` : capitalized(m[1]) };
        }
    }
    return { error: t("caius.say.third_person", { name: HIS_NAME }) };
}

/** The name a line in his notes never uses for him. */
const HIS_NAME = "Shawn";

/** The only verbs `inHisVoice` rewrites, each with its form in his voice; "is" drops away ("Shawn is out" is "Out"). */
const HIS_VERBS: [string, string][] = [
    [ "takes", "Taking" ], [ "covers", "Covering" ], [ "joins", "Joining" ], [ "leaves", "Leaving" ], [ "has", "Having" ], [ "is", "" ],
    [ "was", "Was" ], [ "owns", "Owning" ], [ "runs", "Running" ], [ "handles", "Handling" ], [ "picks up", "Picking up" ], [ "works", "Working" ]
];

/** A task's words as `labelOf` reads them, without its ticket key `key` at the start. */
function labelWords(text: string, key: string | null): string {
    const words = plainText(withoutMoveLinks(text)).replace(/\s+~\d+(?:h\d*m?|m)$/, "").trim();
    return key && words.toUpperCase().startsWith(`${key} `) ? words.slice(key.length + 1) : words;
}

/** A task as `say` names it: its first ticket key, else its words without links, estimate or the Suggested wording. */
export function labelOf(text: string): string {
    const plain = plainText(withoutMoveLinks(text))
        .replace(/^Get (.+?) done(?:: because .*)?$/, "$1")
        .replace(/\s*\(~\d+m\)$/, "")
        .replace(/\s+_[^_]+_$/, "")
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
