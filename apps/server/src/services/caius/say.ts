/**
 * The recap an apply answers as `say`: one sentence of what it wrote and one of what it skipped,
 * built from its `written` and `skipped` entries alone, naming tasks by their ticket key or words and
 * days by their labels, never by an id.
 */

import { t } from "i18next";

import type { Skipped, Written } from "./apply.js";
import { dateLabel, plainText, weekdayName, withoutMoveLinks } from "./daily.js";

/** `say` for an apply's result; `day` is the day its evening tasks and Context lines went to. */
export function sayOf({ written, skipped }: { written: Written[]; skipped: Skipped[] }, { day }: { day: string }): string {
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
    const missed = [
        ...skipped.flatMap((entry) => skipClause(entry)),
        ...(unnamed ? [ t("caius.say.unnamed", { count: unnamed }) ] : [])
    ];
    const sentences = [ wrote, missed ].filter((clauses) => clauses.length).map((clauses) => `${capitalized(andList(clauses))}.`);
    return sentences.length ? sentences.join(" ") : t("caius.say.nothing");
}

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
    if (entry.reason === "edited") return [ t("caius.say.edited", { item: item ?? t("caius.say.a_task") }) ];
    if (entry.kind === "brief") return [ t("caius.say.brief_skipped") ];
    return [ t("caius.say.unchanged", { item: item ?? t("caius.say.a_task") }) ];
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
