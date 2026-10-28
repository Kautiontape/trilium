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

/** A clause of his reply that seems to give an item something: the item's id, the clause as he wrote it, and the place it names. */
export interface Heard {
    id: string;
    clause: string;
    to?: string;
}

/**
 * The items `said`, his reply word for word, seems to give a place: in each clause that names a day
 * (by weekday, the first listed) or a week (`later this week`, `next week`) from `days`, every item
 * of `pool` one of its other words names. It reads for recall, not to act on: a negated clause, a
 * question or another item's word counts too, so the apply asks the agent to check rather than write.
 */
export function saidPlaces(said: string, pool: Named[], days: Named[]): Heard[] {
    const places = [
        ...days.flatMap((day) => (day.aliases ?? []).map((phrase) => ({ phrase, id: day.id }))),
        ...days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.id)).map((day) => ({ phrase: weekdayOf(day.id), id: day.id }))
    ].sort((a, b) => b.phrase.length - a.phrase.length);
    const heard: Heard[] = [];
    for (const clause of clausesOf(said)) {
        let rest = ` ${tokens(clause).join(" ")} `;
        let to: string | undefined;
        for (const { phrase, id } of places) {
            if (!rest.includes(` ${phrase} `)) continue;
            to ??= id;
            rest = rest.replace(` ${phrase} `, " ");
        }
        if (!to) continue;
        for (const id of namedIn(rest, pool)) if (!heard.some((entry) => entry.id === id)) heard.push({ id, clause, to });
    }
    return heard;
}

/**
 * The items `said` seems to close: in each clause with a word to dismiss or drop something, or to
 * say he answered it, every item whose `names` (a key, its number, an author's name) is in it, with
 * `answered` for the second. It reads for recall: a negated clause counts too.
 */
export function saidCloses(said: string, items: { id: string; names: string[] }[]): (Heard & { answered: boolean })[] {
    const heard: (Heard & { answered: boolean })[] = [];
    for (const clause of clausesOf(said)) {
        const text = clause.toLowerCase();
        const answered = ANSWERING.test(text);
        if (!answered && !CLOSING.test(text)) continue;
        const said = new Set(tokens(clause));
        for (const item of items) {
            if (item.names.some((name) => said.has(name)) && !heard.some((entry) => entry.id === item.id)) heard.push({ id: item.id, clause, answered });
        }
    }
    return heard;
}

/** Whether `said` names an item by one of its `names`: a key, its number, an author's name or a distinctive word. */
export function saidNames(said: string, names: string[]): boolean {
    const heard = new Set(tokens(said));
    return names.some((name) => heard.has(name));
}

/** The clauses of `said` that name an item by one of its `names`, as he wrote them. */
export function clausesNaming(said: string, names: string[]): string[] {
    return clausesOf(said).filter((clause) => tokens(clause).some((token) => names.includes(token)));
}

/**
 * The words an answer can name a candidate or follow-up by, lower case: its Jira key and number, its
 * author's names, and the longer words of its text.
 */
export function namesOf(item: { key?: string; author?: string; text: string }): string[] {
    const key = item.key?.toLowerCase();
    return [
        ...(key ? [ key, key.split("-")[1] ?? "" ] : []),
        ...words(item.author ?? "").filter((name) => name.length > 2),
        ...words(item.text).filter((word) => word.length >= 5 && !COMMON.has(word))
    ].filter((name) => name !== "");
}

/** The clauses of his reply, at sentence and list breaks, as he wrote them. */
function clausesOf(said: string): string[] {
    return said.split(/[.;,\n?!]|\band\b|\balso\b|\bbut\b/i).map((clause) => clause.trim()).filter((clause) => clause !== "");
}

/** The ids of `pool` the content words of `text` name, each word on its own; a word that fits several names them all. */
function namedIn(text: string, pool: Named[]): string[] {
    const ids: string[] = [];
    for (const word of text.split(" ").filter((each) => each && !FILLER.has(each) && !FATE_WORDS.has(each))) {
        const found = resolveName(pool, word);
        for (const id of !found ? [] : "id" in found ? [ found.id ] : found.ids) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

/** Whether `said` holds every word of `phrase`, in order and together, such as "incident review" for Incident Review. */
export function saysPhrase(said: string, phrase: string): boolean {
    const wanted = words(phrase).join(" ");
    return wanted !== "" && ` ${words(said).join(" ")} `.includes(` ${wanted} `);
}

/** Whether `said` is only a vague yes, such as "fine", "ok" or "sounds good", which takes the proposals as offered. */
export function vagueYes(said: string): boolean {
    return /^\s*(?:fine|ok|okay|sure|yes|yeah|yep|yup|good|great|perfect|sounds good|that works|go ahead|do it)[\s.!]*$/i.test(said);
}

/** Words that close something: dismiss, drop, kill, forget, remove, scrap, cancel, not doing, take it off, for good. */
const CLOSING = /\b(?:dismiss\w*|drop\w*|kill\w*|forget|remove\w*|scrap\w*|nuke\w*|cancel\w*|not doing|won'?t do|take (?:it |that |this )?off|for good)\b/;

/** Words that say he answered something: answered, replied, responded, got back to, took care of, dealt with, handled. */
const ANSWERING = /\b(?:answer\w*|repl\w*|respond\w*|got back|took care|dealt with|handled)\b/;

/** Words of a candidate's text too common to name it: "Get ZAP-1 Check the report done: because …". */
const COMMON = new Set([ "because", "answer", "question", "check", "about", "their", "there", "which" ]);

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

/** The words of `text` in lower case, a Jira key kept whole ("zap-111"). */
function tokens(text: string): string[] {
    return text.toLowerCase().match(/[a-z][a-z0-9]+-\d+|[\p{L}\p{N}']+/gu)?.map((token) => token.replace(/'s$/, "").replace(/'/g, "")) ?? [];
}

function words(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
