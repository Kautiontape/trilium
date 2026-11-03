// Caius's prose as blocks to render: paragraphs, bullets, numbered steps, quotes and headings, with
// bold and code inline. Only the Markdown Caius writes; anything else reads as plain text.

export interface Span {
    text: string;
    bold?: true;
    code?: true;
}

export type ProseBlock =
    | { kind: "p" | "heading"; text: Span[] }
    | { kind: "ul" | "ol"; items: Span[][] }
    | { kind: "quote"; blocks: ProseBlock[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const QUOTE = /^\s*>\s?/;
const HEADING = /^\s*#{1,6}\s+/;

type Line = "blank" | "quote" | "ul" | "ol" | "heading" | "p";

function kindOf(line: string): Line {
    if (!line.trim()) return "blank";
    if (QUOTE.test(line)) return "quote";
    if (HEADING.test(line)) return "heading";
    if (BULLET.test(line)) return "ul";
    if (NUMBERED.test(line)) return "ol";
    return "p";
}

/** `text` as blocks: a run of lines of one kind is one block; a blank line ends a block. */
export function proseBlocks(text: string): ProseBlock[] {
    const blocks: ProseBlock[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length;) {
        const kind = kindOf(lines[i]!);
        if (kind === "blank") {
            i++;
            continue;
        }
        if (kind === "heading") {
            blocks.push({ kind: "heading", text: spans(lines[i]!.replace(HEADING, "")) });
            i++;
            continue;
        }
        const run: string[] = [];
        while (i < lines.length && kindOf(lines[i]!) === kind) run.push(lines[i++]!);
        if (kind === "quote") blocks.push({ kind: "quote", blocks: proseBlocks(run.map((line) => line.replace(QUOTE, "")).join("\n")) });
        else if (kind === "ul" || kind === "ol") blocks.push({ kind, items: run.map((line) => spans(line.replace(kind === "ul" ? BULLET : NUMBERED, ""))) });
        else blocks.push({ kind: "p", text: spans(run.map((line) => line.trim()).join(" ")) });
    }
    return blocks;
}

/** A line's words with `**bold**` and `` `code` `` marked, and a `[label](url)` read as its label. */
function spans(line: string): Span[] {
    const out: Span[] = [];
    const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
    const plain = (words: string) => words && out.push({ text: words.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") });
    let at = 0;
    for (const match of line.matchAll(pattern)) {
        plain(line.slice(at, match.index));
        out.push(match[1] !== undefined ? { text: match[1], bold: true } : { text: match[2]!, code: true });
        at = match.index! + match[0].length;
    }
    plain(line.slice(at));
    return out;
}
