import { describe, expect, it, vi } from "vitest";

// Every hash is the same, so every item of a pool gets one ref.
vi.mock("crypto", () => ({ createHash: () => ({ update: () => ({ digest: () => "abcde00000" }) }) }));

import { resolveIn, resolveName, withRefs } from "./refs.js";

describe("a ref two items share", () => {
    it("is ambiguous, listing both, never the first one's", () => {
        const pool = withRefs([ { id: "e111", text: "ZAP-111 Check the export" }, { id: "e101", text: "ZAP-101 Verify the retry" } ], "o", (item) => item.id)
            .map((item) => ({ ...item, ref: item.ref ?? "" }));
        expect(pool.map((item) => item.ref)).toEqual([ "oabcde", "oabcde" ]);
        const both = { ambiguous: [ "ZAP-111 Check the export", "ZAP-101 Verify the retry" ], ids: [ "e111", "e101" ] };
        expect(resolveName(pool, "oabcde")).toEqual(both);
        expect(resolveIn([ pool ], "oabcde")).toEqual(both);
        expect(resolveName(pool, "e101")).toEqual({ id: "e101" });
    });
});
