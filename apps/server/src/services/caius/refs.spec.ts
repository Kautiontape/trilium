import { describe, expect, it } from "vitest";

import { resolveIn, resolveName, withRefs } from "./refs.js";

const open = withRefs([
    { id: "e111", text: "ZAP-111 Check the invoice export in QA" },
    { id: "e101", text: "ZAP-101 Verify the export retry on staging" },
    { id: "edave", text: "Message Dave if he knows anyone who will hang lights as a small job from Mon 26 Oct" },
    { id: "ebag", text: "Pack the climbing gym bag from Tue 3 Nov" }
], "o");

describe("withRefs", () => {
    it("numbers the items from 1 with the prefix, beside their own fields", () => {
        expect(open.map((item) => [ item.ref, item.id ])).toEqual([ [ "o1", "e111" ], [ "o2", "e101" ], [ "o3", "edave" ], [ "o4", "ebag" ] ]);
    });
});

describe("resolveName", () => {
    it("takes an id, a ref, a ticket key, its number or a distinctive word", () => {
        expect(resolveName(open, "e101")).toEqual({ id: "e101" });
        expect(resolveName(open, "o3")).toEqual({ id: "edave" });
        expect(resolveName(open, "O3")).toEqual({ id: "edave" });
        expect(resolveName(open, "zap-111")).toEqual({ id: "e111" });
        expect(resolveName(open, "101")).toEqual({ id: "e101" });
        expect(resolveName(open, "the bag")).toEqual({ id: "ebag" });
        expect(resolveName(open, "Dave")).toEqual({ id: "edave" });
        expect(resolveName(open, "Pack the climbing gym bag")).toEqual({ id: "ebag" });
    });

    it("answers ambiguous with the matching texts when more than one item matches", () => {
        expect(resolveName(open, "the export")).toEqual({ ambiguous: [ "ZAP-111 Check the invoice export in QA", "ZAP-101 Verify the export retry on staging" ] });
    });

    it("answers null when nothing matches, and a number matches only a key's own number", () => {
        expect(resolveName(open, "laundry")).toBeNull();
        expect(resolveName(open, "10")).toBeNull();
        expect(resolveName(withRefs([ { id: "a", text: "ZAP-1010 Other" } ], "o"), "101")).toBeNull();
        expect(resolveName(open, "o9")).toBeNull();
        expect(resolveName(open, "the")).toBeNull();
    });
});

describe("resolveIn", () => {
    const list = withRefs([ { id: "t101", text: "ZAP-101 Verify the export retry on staging" }, { id: "tmemo", text: "Write the memo" } ], "l");
    const candidates = withRefs([ { id: "ZAP-150", text: "Get ZAP-150 Check the memo done" } ], "c");

    it("takes an id or ref from any pool before a name, then a name from the first pool that has it", () => {
        expect(resolveIn([ list, candidates ], "c1")).toEqual({ id: "ZAP-150" });
        expect(resolveIn([ list, candidates ], "memo")).toEqual({ id: "tmemo" });
        expect(resolveIn([ list, candidates ], "150")).toEqual({ id: "ZAP-150" });
        expect(resolveIn([ list, candidates ], "gate")).toBeNull();
    });
});
