import { HTMLElement, parse } from "node-html-parser";

import { getCrypto } from "../../encryption/crypto.js";

const ID_ATTRIBUTE = "data-list-item-id";

/** Minimum Sørensen–Dice similarity for an edited item to keep the id of its old counterpart. */
const MIN_SIMILARITY = 0.5;

/** The most unused old items that one edited top-level item is compared with. */
const MAX_CANDIDATES = 50;

interface ListItem {
    element: HTMLElement;
    text: string;
    id: string | undefined;
    parent: ListItem | undefined;
    /** Position in document order among the items of its HTML. */
    index: number;
    bigrams?: Map<string, number>;
}

/**
 * Gives each list item of `html` the `data-list-item-id` of its counterpart in `previousHtml`, or
 * a fresh one from `newId`. When a match is ambiguous the item gets a fresh id, because an id
 * that lands on a different line is worse than one that no longer resolves. Only the `<li`
 * opening tags change; the rest of `html` stays as it is.
 */
export function carryListItemIds(
    previousHtml: string,
    html: string,
    newId: () => string = newListItemId
): string {
    if (!/<li/i.test(html)) {
        return html;
    }

    const items = collectItems(html);
    if (items.length === 0) {
        return html;
    }

    const counterparts = matchItems(collectItems(previousHtml), items);

    const used = new Set<string>();
    const splices: { start: number; end: number; tag: string }[] = [];
    for (const [index, item] of items.entries()) {
        const start = item.element.range[0];
        const attrs = item.element.rawAttrs;
        const attrsAt = html.indexOf(attrs, start + "<li".length);
        const end = html.indexOf(">", attrsAt + attrs.length) + 1;
        if (attrsAt < 0 || end <= start) {
            continue;
        }

        let id = counterparts[index]?.id;
        if (!id || used.has(id)) {
            id = newId();
        }
        used.add(id);

        const rest = html.slice(start + "<li".length, end - 1)
            .replace(new RegExp(`\\s${ID_ATTRIBUTE}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`), "");
        splices.push({ start, end, tag: `<li ${ID_ATTRIBUTE}="${escapeAttribute(id)}"${rest}>` });
    }

    let result = html;
    for (const { start, end, tag } of splices.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, start) + tag + result.slice(end);
    }
    return result;
}

/** Returns a new id in the format CKEditor's `uid()` writes: `e` and 32 lowercase hex digits. */
export function newListItemId() {
    let id = "e";
    for (const byte of getCrypto().randomBytes(16)) {
        id += byte.toString(16).padStart(2, "0");
    }
    return id;
}

function escapeAttribute(value: string) {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function collectItems(html: string) {
    const items: ListItem[] = [];
    const byElement = new Map<HTMLElement, ListItem>();

    for (const element of parse(html).querySelectorAll("li")) {
        const list = element.parentNode;
        if (!(list instanceof HTMLElement) || !["UL", "OL"].includes(list.tagName)) {
            continue;
        }

        const item: ListItem = {
            element,
            text: ownText(element),
            id: element.getAttribute(ID_ATTRIBUTE) || undefined,
            parent: undefined,
            index: items.length
        };
        const owner = list.parentNode;
        item.parent = owner instanceof HTMLElement ? byElement.get(owner) : undefined;
        byElement.set(element, item);
        items.push(item);
    }

    return items;
}

function ownText(element: HTMLElement) {
    let text = "";
    for (const child of element.childNodes) {
        if (child instanceof HTMLElement && ["UL", "OL"].includes(child.tagName)) {
            continue;
        }
        text += child.text;
    }
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Returns, for each new item, the old item it continues, or `undefined`. */
function matchItems(oldItems: ListItem[], newItems: ListItem[]) {
    const matches: (ListItem | undefined)[] = newItems.map(() => undefined);
    const counterpart = new Map<ListItem, ListItem>();
    const taken = new Set<ListItem>();
    const byText = new Map<string, ListItem[]>();
    const childrenOf = new Map<ListItem, ListItem[]>();
    for (const old of oldItems) {
        pushTo(byText, old.text, old);
        if (old.parent) {
            pushTo(childrenOf, old.parent, old);
        }
    }

    // Old index of the counterpart of the most recently matched new item.
    let cursor = -1;
    const accept = (index: number, old: ListItem | undefined) => {
        if (old) {
            matches[index] = old;
            counterpart.set(newItems[index], old);
            taken.add(old);
            cursor = old.index;
        }
    };

    // Pass 1: exact text. A sub-item under an unmatched parent waits for pass 2.
    for (const [index, item] of newItems.entries()) {
        if (item.parent && !counterpart.has(item.parent)) {
            continue;
        }
        const parent = item.parent ? counterpart.get(item.parent) : undefined;

        const sameParent = (byText.get(item.text) ?? [])
            .filter((old) => !taken.has(old) && old.parent === parent);
        accept(index, pickAfter(sameParent, cursor));
    }

    // Pass 2: edited in place, or moved under a new parent.
    const pass1 = matches.slice();
    for (const [index, item] of newItems.entries()) {
        if (matches[index]) {
            continue;
        }

        if (item.parent) {
            const parent = counterpart.get(item.parent);
            if (parent) {
                const children = (childrenOf.get(parent) ?? []).filter((old) => !taken.has(old));
                const exact = children.filter((old) => old.text === item.text);
                accept(index, pickAfter(exact, cursor) ?? mostSimilar(item, children));
            } else {
                const sameText = (byText.get(item.text) ?? []).filter((old) => !taken.has(old));
                accept(index, sameText.length === 1 ? sameText[0] : undefined);
            }
            continue;
        }

        let lower = -1;
        for (let i = index - 1; i >= 0; i--) {
            const before = matches[i];
            if (before) {
                lower = before.index;
                break;
            }
        }
        let upper = oldItems.length;
        for (let i = index + 1; i < newItems.length; i++) {
            const after = pass1[i];
            if (after) {
                upper = after.index;
                break;
            }
        }

        const candidates: ListItem[] = [];
        for (let o = lower + 1; o < upper && candidates.length < MAX_CANDIDATES; o++) {
            if (!taken.has(oldItems[o]) && !oldItems[o].parent) {
                candidates.push(oldItems[o]);
            }
        }
        accept(index, mostSimilar(item, candidates));
    }

    return matches;
}

function pushTo<K>(map: Map<K, ListItem[]>, key: K, item: ListItem) {
    const list = map.get(key);
    if (list) {
        list.push(item);
    } else {
        map.set(key, [item]);
    }
}

/** Returns the first item after `cursor`, else the first item. */
function pickAfter(items: ListItem[], cursor: number) {
    return items.find((item) => item.index > cursor) ?? items[0];
}

/** Returns the earliest candidate with the highest similarity of at least `MIN_SIMILARITY`. */
function mostSimilar(item: ListItem, candidates: ListItem[]) {
    let best: ListItem | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
        const score = similarity(candidate, item);
        if (score >= MIN_SIMILARITY && score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

/** Sørensen–Dice coefficient over character bigrams, counting repeated bigrams. */
function similarity(a: ListItem, b: ListItem) {
    if (a.text === b.text) {
        return 1;
    }
    if (a.text.length < 2 || b.text.length < 2) {
        return 0;
    }

    const countA = a.text.length - 1;
    const countB = b.text.length - 1;
    if ((2 * Math.min(countA, countB)) / (countA + countB) < MIN_SIMILARITY) {
        return 0;
    }

    const bigramsOfA = bigramsOf(a);
    const bigramsOfB = bigramsOf(b);
    let common = 0;
    for (const [bigram, count] of bigramsOfA) {
        common += Math.min(count, bigramsOfB.get(bigram) ?? 0);
    }
    return (2 * common) / (countA + countB);
}

function bigramsOf(item: ListItem) {
    if (!item.bigrams) {
        item.bigrams = new Map();
        for (let i = 0; i < item.text.length - 1; i++) {
            const bigram = item.text.slice(i, i + 2);
            item.bigrams.set(bigram, (item.bigrams.get(bigram) ?? 0) + 1);
        }
    }
    return item.bigrams;
}
