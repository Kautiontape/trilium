import { describe, expect, it } from "vitest";

import { proseBlocks } from "./prose.js";

describe("proseBlocks", () => {
    it("reads paragraphs, bullets, numbered steps, quotes and headings, with bold and code inline", () => {
        const text = [
            "## Monday",
            "Good **Monday**: the `hills` shipped.",
            "- one\n- **two**",
            "1. first\n2. second",
            "> Tuesday's light in the morning.\n>\n> The rest is below.",
            "> one quoted line"
        ].join("\n\n");
        expect(proseBlocks(text)).toEqual([
            { kind: "heading", text: [ { text: "Monday" } ] },
            { kind: "p", text: [ { text: "Good " }, { text: "Monday", bold: true }, { text: ": the " }, { text: "hills", code: true }, { text: " shipped." } ] },
            { kind: "ul", items: [ [ { text: "one" } ], [ { text: "two", bold: true } ] ] },
            { kind: "ol", items: [ [ { text: "first" } ], [ { text: "second" } ] ] },
            { kind: "quote", blocks: [ { kind: "p", text: [ { text: "Tuesday's light in the morning." } ] }, { kind: "p", text: [ { text: "The rest is below." } ] } ] },
            { kind: "quote", blocks: [ { kind: "p", text: [ { text: "one quoted line" } ] } ] }
        ]);
    });

    it("keeps a quote whose lines follow a paragraph's, and joins a paragraph's lines", () => {
        expect(proseBlocks("Here it is:\n> quoted\nplain again")).toEqual([
            { kind: "p", text: [ { text: "Here it is:" } ] },
            { kind: "quote", blocks: [ { kind: "p", text: [ { text: "quoted" } ] } ] },
            { kind: "p", text: [ { text: "plain again" } ] }
        ]);
    });
});
