/**
 * The short references the steps give every item the agent can name (`o3fa9c` an open item, `c…` a
 * candidate, `l…` an item of his list, `x…` a Context line, each from a hash of the item's id; `d1`
 * a day, by its place in a list the date alone decides), and the one resolver the apply tools read
 * an answer with: an id, a ref, a ticket key or its number, or a distinctive word.
 */

import { createHash } from "crypto";

/** An item an answer can name: its id in the step data, its ref, its text and phrases that name it exactly. */
export interface Named {
    id: string;
    ref: string;
    text: string;
    aliases?: string[];
}

/** What an answer names: one item's id, the texts and ids of several that match, or null for none. */
export type Resolved = { id: string } | { ambiguous: string[]; ids: string[] } | null;

/**
 * `items` each with a `ref` made from its id (`idOf`), so it names the same item whatever else joins
 * or leaves the list. An item without an id gets none: it can't be named.
 */
export function withRefs<T extends object>(items: T[], prefix: string, idOf: (item: T) => string | null | undefined): (T & { ref?: string })[] {
    return items.map((item) => {
        const id = idOf(item);
        return id ? { ...item, ref: refOf(prefix, id) } : item;
    });
}

/** The ref of the item `id` under `prefix`: the prefix and the first five hex digits of a hash of the id. */
export function refOf(prefix: string, id: string): string {
    return `${prefix}${createHash("sha1").update(id).digest("hex").slice(0, 5)}`;
}

/** Whether `value` has the shape `refOf` gives an open item, candidate, list item or Context line. */
export function isRef(value: string): boolean {
    return /^[oclx][0-9a-f]{5}$/i.test(value.trim());
}

/** `items` each with a `ref`, the prefix and its 1-based place (`d1`, `d2`…), for a list whose order never changes. */
export function numbered<T extends object>(items: T[], prefix: string): (T & { ref: string })[] {
    return items.map((item, i) => ({ ...item, ref: `${prefix}${i + 1}` }));
}

/**
 * The item of `pool` that `said` names: by id, ref or exact phrase, then by ticket key ("ZAP-101") or its number
 * ("101"), then by its words ("the bag"), each word a word of the item's text. A key, number or word
 * that matches more than one item is ambiguous.
 */
export function resolveName(pool: Named[], said: string): Resolved {
    const value = said.trim();
    const one = (matches: Named[]): Resolved => matches.length === 1 && matches[0]
        ? { id: matches[0].id }
        : matches.length > 1 ? { ambiguous: matches.map((item) => item.text), ids: matches.map((item) => item.id) } : null;
    const byId = pool.find((item) => item.id === value);
    if (byId) return { id: byId.id };
    // Two items whose ids hash to one ref share it: that ref names neither.
    const byRef = pool.filter((item) => item.ref.toLowerCase() === value.toLowerCase());
    if (byRef.length) return one(byRef);
    const exact = pool.find((item) => item.aliases?.some((alias) => alias === value.toLowerCase()));
    if (exact) return { id: exact.id };
    if (JIRA_KEY.test(value)) return one(pool.filter((item) => jiraKeys(item.text).includes(value.toUpperCase())));
    if (/^\d+$/.test(value)) return one(pool.filter((item) => jiraKeys(item.text).some((key) => key.endsWith(`-${value}`))));
    const wanted = words(value).filter((word) => !FILLER.has(word));
    if (!wanted.length) return null;
    return one(pool.filter((item) => {
        const has = new Set(words(item.text));
        return wanted.every((word) => has.has(word) || has.has(`${word}s`) || (word.endsWith("s") && has.has(word.slice(0, -1))));
    }));
}

/**
 * The item `said` names in `pools`, which are tried in order: an id or ref in any pool first, then
 * a name in the first pool where it matches anything.
 */
export function resolveIn(pools: Named[][], said: string): Resolved {
    const value = said.trim().toLowerCase();
    for (const pool of pools) {
        const byId = pool.find((item) => item.id.toLowerCase() === value);
        if (byId) return { id: byId.id };
        if (pool.some((item) => item.ref.toLowerCase() === value)) return resolveName(pool, said);
    }
    for (const pool of pools) {
        const found = resolveName(pool, said);
        if (found) return found;
    }
    return null;
}

/**
 * The fates `said`, his reply word for word, gives open items: in each clause with one place, a day
 * (by weekday, the first listed) or a week (`later this week`, `next week`) from `days`, and one item
 * of `open` named by its other words. A clause that starts with a negation, names two places or a
 * name that fits two items gives none.
 */
export function saidFates(said: string, open: Named[], days: Named[]): { listItemId: string; to: string }[] {
    const places = [
        ...days.flatMap((day) => (day.aliases ?? []).map((phrase) => ({ phrase, id: day.id }))),
        ...days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.id)).map((day) => ({ phrase: weekdayOf(day.id), id: day.id }))
    ].sort((a, b) => b.phrase.length - a.phrase.length);
    const fates: { listItemId: string; to: string }[] = [];
    for (const clause of said.toLowerCase().split(/[.;,\n]|\band\b|\balso\b/)) {
        if (NEGATION.test(clause)) continue;
        let rest = ` ${words(clause).join(" ")} `;
        const found = new Set<string>();
        for (const { phrase, id } of places) {
            if (!rest.includes(` ${phrase} `)) continue;
            found.add(id);
            rest = rest.replace(` ${phrase} `, " ");
        }
        const [ to ] = found;
        if (found.size !== 1 || !to) continue;
        const named = rest.split(" ").filter((word) => word && !FILLER.has(word) && !FATE_WORDS.has(word)).map((word) => resolveName(open, word));
        if (named.some((found) => found && "ambiguous" in found)) continue;
        const ids = new Set(named.flatMap((found) => found && "id" in found ? [ found.id ] : []));
        const [ listItemId ] = ids;
        if (ids.size === 1 && listItemId) fates.push({ listItemId, to });
    }
    return fates;
}

/**
 * Whether `said` holds his word to close something: dismiss, drop, cancel, not doing, or that he
 * answered, replied or handled it, not negated ("don't dismiss 105").
 */
export function hisWord(said: string): boolean {
    const text = said.toLowerCase();
    for (const match of text.matchAll(/\b(?:dismiss\w*|drop\w*|cancel\w*|not doing|answered|replied|handled)\b/g)) {
        const before = text.slice(0, match.index).trim().split(/\s+/).slice(-2).join(" ");
        if (!/(?:^|\s)(?:not|never|no|don'?t|do not|didn'?t)$/.test(before)) return true;
    }
    return false;
}

/**
 * The keys of the follow-ups `said` says he answered: with his word (`hisWord`), each follow-up whose
 * key, its number or its author's name is in it, or the only one when it names none of them.
 */
export function saidAnswered(said: string, followUps: { key: string; author: string }[]): string[] {
    if (!hisWord(said)) return [];
    const heard = new Set(words(said));
    const named = followUps.filter((followUp) => heard.has(followUp.key.toLowerCase()) || heard.has(followUp.key.split("-")[1] ?? "")
        || words(followUp.author).some((name) => name.length > 2 && heard.has(name)));
    const [ only ] = followUps;
    return named.length ? named.map((followUp) => followUp.key) : followUps.length === 1 && only && heard.has("chat") ? [ only.key ] : [];
}

/** Whether `said` holds every word of `phrase`, in order and together, such as "incident review" for Incident Review. */
export function saysPhrase(said: string, phrase: string): boolean {
    const wanted = words(phrase).join(" ");
    return wanted !== "" && ` ${words(said).join(" ")} `.includes(` ${wanted} `);
}

/** A clause that says where something doesn't go. */
const NEGATION = /^\s*(?:not|no|never|don'?t)\b/;

/** Words around a fate that name no item: "dave can go to monday". */
const FATE_WORDS = new Set([ "can", "go", "goes", "move", "moved", "push", "put", "off", "for", "later", "until", "till", "on", "in", "be", "should" ]);

/** A date's weekday in lower case, such as `tuesday`. */
function weekdayOf(date: string): string {
    return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
}

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/** Words that name nothing in an answer: "the bag is done", "my laundry". */
const FILLER = new Set([ "the", "a", "an", "my", "is", "are", "was", "and", "done", "finished", "task", "one", "it", "that", "this", "to", "of" ]);

function jiraKeys(text: string): string[] {
    return [ ...text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g) ].map((m) => m[0]);
}

function words(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
