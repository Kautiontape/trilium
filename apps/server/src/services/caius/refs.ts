/**
 * The short references the steps give every item the agent can name (`o1` an open item, `c1` a
 * candidate, `l1` an item of his list, `x1` a Context line, `d1` a day), and the one resolver the
 * apply tools read an answer with: an id, a ref, a ticket key or its number, or a distinctive word.
 */

/** An item an answer can name: its id in the step data, its ref and its text. */
export interface Named {
    id: string;
    ref: string;
    text: string;
}

/** What an answer names: one item's id, the texts of several that match, or null for none. */
export type Resolved = { id: string } | { ambiguous: string[] } | null;

/** `items` each with a `ref`, the prefix and its 1-based place: `o1`, `o2`… */
export function withRefs<T extends object>(items: T[], prefix: string): (T & { ref: string })[] {
    return items.map((item, i) => ({ ...item, ref: `${prefix}${i + 1}` }));
}

/**
 * The item of `pool` that `said` names: by id or ref, then by ticket key ("ZAP-101") or its number
 * ("101"), then by its words ("the bag"), each word a word of the item's text. A key, number or word
 * that matches more than one item is ambiguous.
 */
export function resolveName(pool: Named[], said: string): Resolved {
    const value = said.trim();
    const exact = pool.find((item) => item.id === value) ?? pool.find((item) => item.ref.toLowerCase() === value.toLowerCase());
    if (exact) return { id: exact.id };
    const one = (matches: Named[]): Resolved => matches.length === 1 && matches[0]
        ? { id: matches[0].id }
        : matches.length > 1 ? { ambiguous: matches.map((item) => item.text) } : null;
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
        const exact = pool.find((item) => item.id.toLowerCase() === value || item.ref.toLowerCase() === value);
        if (exact) return { id: exact.id };
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
