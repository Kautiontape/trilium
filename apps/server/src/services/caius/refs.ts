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

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/** Words that name nothing in an answer: "the bag is done", "my laundry". */
const FILLER = new Set([ "the", "a", "an", "my", "is", "are", "was", "and", "done", "finished", "task", "one", "it", "that", "this", "to", "of" ]);

function jiraKeys(text: string): string[] {
    return [ ...text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g) ].map((m) => m[0]);
}

function words(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
