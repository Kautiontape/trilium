import { HTMLElement, parse } from "node-html-parser";

import { getCrypto } from "../../encryption/crypto.js";

const ID_ATTRIBUTE = "data-list-item-id";

/** Minimum Sørensen–Dice similarity for an edited line to keep the id of its old counterpart. */
const MIN_SIMILARITY = 0.5;

/** The most unused old siblings that one edited line is compared with. */
const MAX_CANDIDATES = 50;

/**
 * A list item or a heading. A node is identified by its parent node and its own text, and only
 * matches a node of the same kind. A top-level item's parent is the heading above it, a
 * heading's parent is the nearest heading above it with a lower level, and `undefined` is the
 * root of the note.
 */
interface Node {
    kind: "item" | "heading";
    element: HTMLElement;
    text: string;
    id: string | undefined;
    parent: Node | undefined;
    /** Position in document order among the nodes of its HTML. */
    index: number;
    /** Position among the nodes that share its parent. */
    position: number;
    /** The old node it continues, set while matching new nodes. */
    match?: Node;
    matchedInPass1?: boolean;
    bigrams?: Map<string, number>;
}

interface ParsedNodes {
    nodes: Node[];
    /** `<li>` elements whose parent is not a `<ul>` or `<ol>`. */
    strays: HTMLElement[];
}

/**
 * Gives each list item of `html` the `data-list-item-id` of its counterpart in `previousHtml`, or
 * a fresh one from `newId`. A line is the same line when its own text and its parent line (or the
 * heading above it) are the same, so two "Standup" items under different headings never trade
 * ids. An edited line keeps its id when it is similar enough to a line that is no longer there
 * in the same place. When a match is ambiguous the item gets a fresh id, because an id on a
 * different line is worse than one that no longer resolves. Only the `<li` opening tags change;
 * the rest of `html` stays as it is.
 */
export function carryListItemIds(
    previousHtml: string,
    html: string,
    newId: () => string = newListItemId
): string {
    if (!/<li/i.test(html)) {
        return html;
    }

    const { nodes, strays } = parseNodes(html);
    matchNodes(parseNodes(previousHtml).nodes, nodes);

    const used = new Set<string>();
    const splices: { start: number; end: number; tag: string }[] = [];
    for (const node of nodes) {
        if (node.kind !== "item") {
            continue;
        }
        const tag = openingTag(html, node.element);
        if (!tag) {
            continue;
        }

        let id = node.match?.id;
        if (!id || used.has(id)) {
            id = newId();
        }
        used.add(id);

        const attributes = withoutIdAttribute(tag.attributes);
        splices.push({ ...tag, tag: `<li ${ID_ATTRIBUTE}="${escapeAttribute(id)}"${attributes}>` });
    }
    for (const stray of strays) {
        const tag = openingTag(html, stray);
        const attributes = tag ? withoutIdAttribute(tag.attributes) : "";
        if (tag && attributes !== tag.attributes) {
            splices.push({ ...tag, tag: `<li${attributes}>` });
        }
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

/** Locates the `<li ...>` tag of `element` and returns its range and its attribute text. */
function openingTag(html: string, element: HTMLElement) {
    const start = element.range[0];
    const attributesAt = html.indexOf(element.rawAttrs, start + "<li".length);
    const end = html.indexOf(">", attributesAt + element.rawAttrs.length) + 1;
    if (attributesAt < 0 || end <= start) {
        return undefined;
    }
    return { start, end, attributes: html.slice(start + "<li".length, end - 1) };
}

/** Drops the attributes named `data-list-item-id`, keeping every other byte of `attributes`. */
function withoutIdAttribute(attributes: string) {
    return attributes.replace(
        /(\s+)([^\s=/"'>]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g,
        (attribute, _space, name: string) => (name.toLowerCase() === ID_ATTRIBUTE ? "" : attribute)
    );
}

function parseNodes(html: string): ParsedNodes {
    const root = parse(html);
    const elements: { element: HTMLElement; kind: Node["kind"] }[] = [];
    const strays: HTMLElement[] = [];

    for (const element of root.querySelectorAll("li")) {
        if (isList(element.parentNode)) {
            elements.push({ element, kind: "item" });
        } else {
            strays.push(element);
        }
    }
    for (const element of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
        if (!hasListAncestor(element)) {
            elements.push({ element, kind: "heading" });
        }
    }
    elements.sort((a, b) => a.element.range[0] - b.element.range[0]);

    const nodes: Node[] = [];
    const byElement = new Map<HTMLElement, Node>();
    const headings: Node[] = [];
    const childCount = new Map<Node | undefined, number>();

    for (const { element, kind } of elements) {
        let parent: Node | undefined;
        if (kind === "heading") {
            const level = Number(element.tagName.slice(1));
            while (headings.length > 0 && levelOf(headings[headings.length - 1]) >= level) {
                headings.pop();
            }
            parent = headings[headings.length - 1];
        } else {
            for (let up = element.parentNode?.parentNode; up && !parent; up = up.parentNode) {
                parent = up instanceof HTMLElement ? byElement.get(up) : undefined;
            }
            parent ??= headings[headings.length - 1];
        }

        const node: Node = {
            kind,
            element,
            text: ownText(element),
            id: element.getAttribute(ID_ATTRIBUTE) || undefined,
            parent,
            index: nodes.length,
            position: childCount.get(parent) ?? 0
        };
        childCount.set(parent, node.position + 1);
        byElement.set(element, node);
        nodes.push(node);
        if (kind === "heading") {
            headings.push(node);
        }
    }

    return { nodes, strays };
}

function isList(node: unknown) {
    return node instanceof HTMLElement && ["UL", "OL"].includes(node.tagName);
}

function hasListAncestor(element: HTMLElement) {
    for (let up = element.parentNode; up; up = up.parentNode) {
        if (isList(up)) {
            return true;
        }
    }
    return false;
}

function levelOf(heading: Node) {
    return Number(heading.element.tagName.slice(1));
}

function ownText(element: HTMLElement) {
    let text = "";
    for (const child of element.childNodes) {
        if (!isList(child)) {
            text += child.text;
        }
    }
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Sets `match` on each new node that continues an old node. Matching runs in two passes over
 * the new nodes in document order, and both keep a cursor: the old index of the counterpart of
 * the most recently matched new node.
 *
 * Pass 1 pairs a node with an unused old node of the same kind, text and parent, preferring one
 * after the cursor. A node under a parent that has no counterpart yet waits for pass 2.
 *
 * Pass 2 handles the rest:
 * - A node whose parent has a counterpart (or that sits at the root) compares itself with that
 *   counterpart's unused children of its kind. A node that waited for pass 2 first takes an
 *   exact-text child. Otherwise the most similar child wins, if it scores at least
 *   `MIN_SIMILARITY`, among those strictly between the counterparts of the nearest matched
 *   siblings before it (from either pass) and after it (pass 1 only).
 * - A node under a new parent takes an old node of the same kind only when its text occurs once
 *   in both HTML documents and the old node was top-level, under a heading or under a matched
 *   parent. Anything else gets a fresh id.
 */
function matchNodes(oldNodes: Node[], newNodes: Node[]) {
    const taken = new Set<Node>();
    const deferred = new Set<Node>();
    const keyOf = (node: Node) => `${node.kind}\0${node.text}`;
    const oldByKey = new Map<string, Node[]>();
    const newCount = new Map<string, number>();
    const oldChildren = new Map<Node | undefined, Node[]>();
    const newChildren = new Map<Node | undefined, Node[]>();
    for (const old of oldNodes) {
        pushTo(oldByKey, keyOf(old), old);
        pushTo(oldChildren, old.parent, old);
    }
    for (const node of newNodes) {
        newCount.set(keyOf(node), (newCount.get(keyOf(node)) ?? 0) + 1);
        pushTo(newChildren, node.parent, node);
    }

    let cursor = -1;
    const accept = (node: Node, old: Node | undefined, pass1 = false) => {
        if (old) {
            node.match = old;
            node.matchedInPass1 = pass1;
            taken.add(old);
            cursor = old.index;
        }
    };

    for (const node of newNodes) {
        if (node.parent && !node.parent.match) {
            deferred.add(node);
            continue;
        }
        const candidates = (oldByKey.get(keyOf(node)) ?? [])
            .filter((old) => !taken.has(old) && old.parent === node.parent?.match);
        accept(node, pickAfter(candidates, cursor), true);
    }

    for (const node of newNodes) {
        if (node.match) {
            continue;
        }

        if (node.parent && !node.parent.match) {
            const sameText = (oldByKey.get(keyOf(node)) ?? []).filter((old) => !taken.has(old));
            const [old] = sameText;
            const isOnlyOne = sameText.length === 1 && newCount.get(keyOf(node)) === 1
                && oldByKey.get(keyOf(node))?.length === 1;
            const canMove = !old?.parent || old.parent.kind === "heading" || taken.has(old.parent);
            accept(node, isOnlyOne && canMove ? old : undefined);
            continue;
        }

        const parentOld = node.parent?.match;
        const siblings = (oldChildren.get(parentOld) ?? [])
            .filter((old) => old.kind === node.kind);
        if (deferred.has(node)) {
            const exact = siblings.filter((old) => !taken.has(old) && old.text === node.text);
            const old = pickAfter(exact, cursor);
            if (old) {
                accept(node, old);
                continue;
            }
        }

        const [lower, upper] = windowOf(node, parentOld);
        const candidates: Node[] = [];
        for (let i = firstAfter(siblings, lower); i < siblings.length; i++) {
            const old = siblings[i];
            if (old.index >= upper || candidates.length >= MAX_CANDIDATES) {
                break;
            }
            if (!taken.has(old)) {
                candidates.push(old);
            }
        }
        accept(node, mostSimilar(node, candidates));
    }

    function windowOf(node: Node, parentOld: Node | undefined) {
        const siblings = newChildren.get(node.parent) ?? [];
        let lower = -1;
        for (let i = node.position - 1; i >= 0; i--) {
            const match = siblings[i].match;
            if (match && match.parent === parentOld) {
                lower = match.index;
                break;
            }
        }
        let upper = Infinity;
        for (let i = node.position + 1; i < siblings.length; i++) {
            const match = siblings[i].matchedInPass1 ? siblings[i].match : undefined;
            if (match && match.parent === parentOld) {
                upper = match.index;
                break;
            }
        }
        return [lower, upper];
    }
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/** Returns the first node after `cursor`, else the first node. */
function pickAfter(nodes: Node[], cursor: number) {
    return nodes.find((node) => node.index > cursor) ?? nodes[0];
}

/** Returns the position of the first node whose index is above `index`. */
function firstAfter(nodes: Node[], index: number) {
    let low = 0;
    let high = nodes.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (nodes[middle].index > index) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    return low;
}

/** Returns the earliest candidate with the highest similarity of at least `MIN_SIMILARITY`. */
function mostSimilar(node: Node, candidates: Node[]) {
    let best: Node | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
        const score = similarity(candidate, node);
        if (score >= MIN_SIMILARITY && score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

/** Sørensen–Dice coefficient over character bigrams, counting repeated bigrams. */
function similarity(a: Node, b: Node) {
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

    const bigramsOfB = bigramsOf(b);
    let common = 0;
    for (const [bigram, count] of bigramsOf(a)) {
        common += Math.min(count, bigramsOfB.get(bigram) ?? 0);
    }
    return (2 * common) / (countA + countB);
}

function bigramsOf(node: Node) {
    if (!node.bigrams) {
        node.bigrams = new Map();
        for (let i = 0; i < node.text.length - 1; i++) {
            const bigram = node.text.slice(i, i + 2);
            node.bigrams.set(bigram, (node.bigrams.get(bigram) ?? 0) + 1);
        }
    }
    return node.bigrams;
}
