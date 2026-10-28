import { describe, expect, it } from "vitest";

import { isRef, namesOf, numbered, refOf, resolveIn, resolveName, saidCloses, saidNames, saidPlaces, vagueYes, withRefs } from "./refs.js";

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

describe("saidPlaces", () => {
    const days = [
        { id: "2026-11-03", ref: "d1", text: "Tue 3 Nov" },
        { id: "2026-11-09", ref: "d5", text: "Mon 9 Nov" },
        { id: "2026-11-10", ref: "d6", text: "Tue 10 Nov" },
        { id: "2026-W45", ref: "w1", text: "later this week", aliases: [ "later this week", "this week" ] },
        { id: "2026-W46", ref: "w2", text: "next week", aliases: [ "next week" ] }
    ];
    const heard = (said: string) => saidPlaces(said, open, days).map(({ id, to }) => [ id, to ]);

    it("hears every item a clause with a place names, the round-5 replies among them, a full key too", () => {
        expect(heard("110 is done. 111 later this week. evening pack the climbing gym bag")).toEqual([ [ "e111", "2026-W45" ] ]);
        expect(saidPlaces("111 was later this week, not tomorrow", open, days)).toEqual([ { id: "e111", clause: "111 was later this week", to: "2026-W45" } ]);
        expect(heard("laundry's done, dave can go to monday")).toEqual([ [ "edave", "2026-11-09" ] ]);
        expect(heard("101 next week and the bag tuesday")).toEqual([ [ "e101", "2026-W46" ], [ "ebag", "2026-11-03" ] ]);
        expect(heard("ZAP-111 later this week")).toEqual([ [ "e111", "2026-W45" ] ]);
    });

    it("reads for recall: a negation, a question or a shared word is heard too, for the apply to check, never to write", () => {
        expect(heard("111 not this week")).toEqual([ [ "e111", "2026-W45" ] ]);
        expect(heard("should 111 go tuesday?")).toEqual([ [ "e111", "2026-11-03" ] ]);
        expect(heard("the export later this week")).toEqual([ [ "e111", "2026-W45" ], [ "e101", "2026-W45" ] ]);
        expect(heard("111, 101 and the bag are done. incident review. evening laundry")).toEqual([]);
        expect(heard("")).toEqual([]);
    });
});

describe("saidCloses and saidNames", () => {
    const jordan = { id: "ZAP-105", names: namesOf({ key: "ZAP-105", author: "Jordan Placeholder", text: "" }) };
    const gate = { id: "ZAP-120", names: namesOf({ key: "ZAP-120", text: "Tidy the gate" }) };
    const closes = (said: string) => saidCloses(said, [ jordan, gate ]).map(({ id, answered }) => [ id, answered ]);

    it("hears every item a clause with a closing or answering word names, negated or not, for the apply to check", () => {
        expect(closes("111 not today. answered jordan in chat")).toEqual([ [ "ZAP-105", true ] ]);
        expect(closes("haven't answered jordan yet")).toEqual([ [ "ZAP-105", true ] ]);
        expect(closes("responded to jordan, kill 120")).toEqual([ [ "ZAP-105", true ], [ "ZAP-120", false ] ]);
        expect(closes("don't dismiss 105")).toEqual([ [ "ZAP-105", false ] ]);
        expect(closes("I answered nothing in chat")).toEqual([]);
        expect(closes("fine")).toEqual([]);
    });

    it("finds an item named by its key, number, author or a longer word of it", () => {
        expect(saidNames("forget 120", gate.names)).toBe(true);
        expect(saidNames("zap-120 can go", gate.names)).toBe(true);
        expect(saidNames("ask jordan's question later", jordan.names)).toBe(true);
        expect(saidNames("fine", jordan.names)).toBe(false);
    });
});

describe("vagueYes", () => {
    it("is a reply that is only a yes, never one that says more", () => {
        for (const said of [ "fine", "Fine.", "ok", "sounds good!", "yeah" ]) expect(vagueYes(said), said).toBe(true);
        for (const said of [ "fine, but not 111", "skip it", "nothing", "" ]) expect(vagueYes(said), said).toBe(false);
    });
});
