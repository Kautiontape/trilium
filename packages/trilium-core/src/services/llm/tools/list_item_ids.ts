import { HTMLElement, parse } from "node-html-parser";

import { getCrypto } from "../../encryption/crypto.js";

const ID_ATTRIBUTE = "data-list-item-id";

/** Minimum Sørensen–Dice similarity for an edited item to keep the id of its old counterpart. */
const MIN_SIMILARITY = 0.5;

interface ListItem {
    element: HTMLElement;
    text: string;
    id: string | undefined;
    parent: ListItem | undefined;
}

/**
 * Gives each list item of `html` the `data-list-item-id` of its counterpart in `previousHtml`, or
 * a fresh one from `newId`. Items match by their own text first, then by similarity between the
 * matched neighbours. Only the `<li` opening tags change; the rest of `html` stays as it is.
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
        let id = counterparts[index]?.id;
        if (!id || used.has(id)) {
            id = newId();
        }
        used.add(id);

        const start = item.element.range[0];
        const attrsAt = html.indexOf(item.element.rawAttrs, start + "<li".length);
        const end = html.indexOf(">", attrsAt + item.element.rawAttrs.length) + 1;
        const rest = html.slice(start + "<li".length, end - 1)
            .replace(new RegExp(`\\s${ID_ATTRIBUTE}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`), "");
        splices.push({ start, end, tag: `<li ${ID_ATTRIBUTE}="${id}"${rest}>` });
    }

    let result = html;
    for (const { start, end, tag } of splices.reverse()) {
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
            parent: undefined
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
    const oldIndex = new Map(oldItems.map((item, index) => [item, index]));
    const oldFor = new Map<ListItem, ListItem>();
    const taken = new Set<ListItem>();

    // Pass 1: exact own text, preferring an old item under the counterpart of the new parent.
    for (const [index, item] of newItems.entries()) {
        const candidates = oldItems.filter((old) => !taken.has(old) && old.text === item.text);
        const expectedParent = item.parent ? oldFor.get(item.parent) : undefined;
        const match = (!item.parent || expectedParent
            ? candidates.find((old) => old.parent === expectedParent)
            : undefined) ?? candidates[0];
        if (match) {
            matches[index] = match;
            taken.add(match);
            oldFor.set(item, match);
        }
    }

    // Pass 2: edited in place, between the old counterparts of the nearest matched neighbours.
    const pass1 = matches.slice();
    for (const [index, item] of newItems.entries()) {
        if (matches[index]) {
            continue;
        }

        let lower = -1;
        for (let i = index - 1; i >= 0; i--) {
            const before = matches[i];
            if (before) {
                lower = oldIndex.get(before) ?? -1;
                break;
            }
        }
        let upper = oldItems.length;
        for (let i = index + 1; i < newItems.length; i++) {
            const after = pass1[i];
            if (after) {
                upper = oldIndex.get(after) ?? oldItems.length;
                break;
            }
        }

        let best: ListItem | undefined;
        let bestScore = 0;
        for (let o = lower + 1; o < upper; o++) {
            const old = oldItems[o];
            if (taken.has(old)) {
                continue;
            }
            const score = similarity(old.text, item.text);
            if (score >= MIN_SIMILARITY && score > bestScore) {
                best = old;
                bestScore = score;
            }
        }
        if (best) {
            matches[index] = best;
            taken.add(best);
        }
    }

    return matches;
}

/** Sørensen–Dice coefficient over character bigrams, counting repeated bigrams. */
function similarity(a: string, b: string) {
    if (a === b) {
        return 1;
    }

    const bigramsOfA = bigrams(a);
    const bigramsOfB = bigrams(b);
    const total = a.length - 1 + (b.length - 1);
    if (a.length < 2 || b.length < 2) {
        return 0;
    }

    let common = 0;
    for (const [bigram, count] of bigramsOfA) {
        common += Math.min(count, bigramsOfB.get(bigram) ?? 0);
    }
    return (2 * common) / total;
}

function bigrams(text: string) {
    const counts = new Map<string, number>();
    for (let i = 0; i < text.length - 1; i++) {
        const bigram = text.slice(i, i + 2);
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }
    return counts;
}
