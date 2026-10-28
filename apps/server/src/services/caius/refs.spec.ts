import { describe, expect, it } from "vitest";

import { hisWord, isRef, numbered, refOf, resolveIn, resolveName, saidFates, withRefs } from "./refs.js";

const open = withRefs([
    { id: "e111", text: "ZAP-111 Check the invoice export in QA" },
    { id: "e101", text: "ZAP-101 Verify the export retry on staging" },
    { id: "edave", text: "Message Dave if he knows anyone who will hang lights as a small job from Mon 26 Oct" },
    { id: "ebag", text: "Pack the climbing gym bag from Tue 3 Nov" }
], "o", (item) => item.id).map((item) => ({ ...item, ref: item.ref ?? "" }));

describe("withRefs", () => {
    it("gives each item a ref from its own id, so a ref names the same item whatever leaves the list", () => {
        expect(open.map((item) => item.ref)).toEqual([ "e111", "e101", "edave", "ebag" ].map((id) => refOf("o", id)));
        expect(open.every((item) => isRef(item.ref))).toBe(true);
        const fewer = withRefs([ { id: "e101" }, { id: "ebag" } ], "o", (item) => item.id);
        expect(fewer.map((item) => item.ref)).toEqual([ refOf("o", "e101"), refOf("o", "ebag") ]);
        expect(withRefs([ { id: null } ], "o", (item) => item.id)).toEqual([ { id: null } ]);
        expect(numbered([ { date: "a" }, { date: "b" } ], "d").map((day) => day.ref)).toEqual([ "d1", "d2" ]);
    });
});

describe("resolveName", () => {
    it("takes an id, a ref, a ticket key, its number or a distinctive word", () => {
        expect(resolveName(open, "e101")).toEqual({ id: "e101" });
        expect(resolveName(open, refOf("o", "edave"))).toEqual({ id: "edave" });
        expect(resolveName(open, refOf("o", "edave").toUpperCase())).toEqual({ id: "edave" });
        expect(resolveName(open, "zap-111")).toEqual({ id: "e111" });
        expect(resolveName(open, "101")).toEqual({ id: "e101" });
        expect(resolveName(open, "the bag")).toEqual({ id: "ebag" });
        expect(resolveName(open, "Dave")).toEqual({ id: "edave" });
        expect(resolveName(open, "Pack the climbing gym bag")).toEqual({ id: "ebag" });
    });

    it("answers ambiguous with the matching texts when more than one item matches", () => {
        expect(resolveName(open, "the export")).toEqual({
            ambiguous: [ "ZAP-111 Check the invoice export in QA", "ZAP-101 Verify the export retry on staging" ], ids: [ "e111", "e101" ]
        });
    });

    it("answers null when nothing matches, and a number matches only a key's own number", () => {
        expect(resolveName(open, "laundry")).toBeNull();
        expect(resolveName(open, "10")).toBeNull();
        expect(resolveName(numbered([ { id: "a", text: "ZAP-1010 Other" } ], "o"), "101")).toBeNull();
        expect(resolveName(open, refOf("o", "egone"))).toBeNull();
        expect(resolveName(open, "the")).toBeNull();
    });
});

describe("resolveIn", () => {
    const list = numbered([ { id: "t101", text: "ZAP-101 Verify the export retry on staging" }, { id: "tmemo", text: "Write the memo" } ], "l");
    const candidates = numbered([ { id: "ZAP-150", text: "Get ZAP-150 Check the memo done" } ], "c");

    it("takes an id or ref from any pool before a name, then a name from the first pool that has it", () => {
        expect(resolveIn([ list, candidates ], "c1")).toEqual({ id: "ZAP-150" });
        expect(resolveIn([ list, candidates ], "memo")).toEqual({ id: "tmemo" });
        expect(resolveIn([ list, candidates ], "150")).toEqual({ id: "ZAP-150" });
        expect(resolveIn([ list, candidates ], "gate")).toBeNull();
    });
});

describe("saidFates", () => {
    const days = [
        { id: "2026-11-03", ref: "d1", text: "Tue 3 Nov" },
        { id: "2026-11-09", ref: "d5", text: "Mon 9 Nov" },
        { id: "2026-11-10", ref: "d6", text: "Tue 10 Nov" },
        { id: "2026-W45", ref: "w1", text: "later this week", aliases: [ "later this week", "this week" ] },
        { id: "2026-W46", ref: "w2", text: "next week", aliases: [ "next week" ] }
    ];

    it("reads the fate of each item he sent somewhere in his own words, the round-5 replies among them", () => {
        expect(saidFates("110 is done. 111 later this week. evening pack the climbing gym bag", open, days)).toEqual([ { listItemId: "e111", to: "2026-W45" } ]);
        expect(saidFates("111 was later this week, not tomorrow. and don't dismiss 105. also ZAP-2590 is open, Jira's Done is wrong", open, days))
            .toEqual([ { listItemId: "e111", to: "2026-W45" } ]);
        expect(saidFates("laundry's done, dave can go to monday. yes keep the 2590 line. nothing else", open, days)).toEqual([ { listItemId: "edave", to: "2026-11-09" } ]);
        expect(saidFates("101 next week and the bag tuesday", open, days)).toEqual([ { listItemId: "e101", to: "2026-W46" }, { listItemId: "ebag", to: "2026-11-03" } ]);
    });

    it("reads nothing from a clause with no place, two places, a negation or a name that fits two items", () => {
        expect(saidFates("111, 101 and the bag are done. incident review. evening laundry", open, days)).toEqual([]);
        expect(saidFates("not 111 this week", open, days)).toEqual([]);
        expect(saidFates("111 this week or next week", open, days)).toEqual([]);
        expect(saidFates("the export later this week", open, days)).toEqual([]);
        expect(saidFates("", open, days)).toEqual([]);
    });
});

describe("hisWord", () => {
    it("finds his word to dismiss, drop or close in his reply, and none in a negated one", () => {
        expect(hisWord("answered jordan in chat")).toBe(true);
        expect(hisWord("111 not today. answered jordan in chat. ZAP-2590 is open")).toBe(true);
        expect(hisWord("dismiss 105")).toBe(true);
        expect(hisWord("drop the bucket question, not doing it")).toBe(true);
        expect(hisWord("111 was later this week, not tomorrow. and don't dismiss 105.")).toBe(false);
        expect(hisWord("110 is done. 111 later this week. evening pack the climbing gym bag")).toBe(false);
        expect(hisWord("fine")).toBe(false);
        expect(hisWord("")).toBe(false);
    });
});
