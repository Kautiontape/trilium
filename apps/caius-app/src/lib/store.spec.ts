// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaiusApi, PlanView } from "./caius.js";
import { connection, held, holdReword, holdWrite, refreshToday, rewording, serverStatus, today } from "./store.js";

const h = vi.hoisted(() => ({ fake: {} as Record<string, unknown> }));

vi.mock("./caius.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("./caius.js")>(),
    caiusApi: () => h.fake
}));

const ref = { noteId: "n1", listItemId: "li1" };
const key = "n1/li1";
const status = { enabled: true, rollover: "04:00" };

function fakeApi(over: Partial<Record<keyof CaiusApi, unknown>> = {}) {
    h.fake = {
        status: vi.fn(async () => status),
        plan: vi.fn(async () => ({ key: "2026-11-16" } as PlanView)),
        catchup: vi.fn(async () => null),
        nudge: vi.fn(async () => null),
        ...over
    };
    return h.fake as Record<string, ReturnType<typeof vi.fn>>;
}

function deferred() {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

beforeEach(() => {
    vi.useFakeTimers();
    connection.value = { url: "https://notes.example.com", token: "tok" };
    serverStatus.value = status;
    today.value = null;
    held.value = {};
    rewording.value = {};
    fakeApi();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("refreshToday", () => {
    it("queues one follow-up read when asked during a read, and resolves after it", async () => {
        const gate = deferred();
        const api = fakeApi({ plan: vi.fn(async () => { await gate.promise; return { key: "2026-11-16" }; }) });
        const first = refreshToday();
        const second = refreshToday();
        const third = refreshToday();
        gate.resolve();
        await Promise.all([ first, second, third ]);
        expect(api.plan).toHaveBeenCalledTimes(2);
    });

    it("keeps a started stamp only when it is dated on the plan's day", async () => {
        const api = fakeApi({ status: vi.fn(async () => ({ ...status, rollover: "00:00", started: "2026-11-16T00:20:00" })) });
        await refreshToday();
        expect(today.value?.started).toBe("2026-11-16T00:20:00");
        api.plan.mockResolvedValue({ key: "2026-11-15" });
        api.status.mockRejectedValue(new Error("down"));
        await refreshToday();
        expect(today.value?.key).toBe("2026-11-15");
        expect(today.value?.started).toBeNull();
    });
});

describe("held writes", () => {
    it("keeps the new words on the row until the read after the write lands", async () => {
        const gate = deferred();
        const api = fakeApi({ plan: vi.fn(async () => { await gate.promise; return { key: "2026-11-16" }; }) });
        holdReword(ref, "Y", async () => ({ results: [ { status: "updated" } ] }));
        await vi.advanceTimersByTimeAsync(4000);
        expect(api.plan).toHaveBeenCalled();
        expect(rewording.value[key]).toBe("Y");
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(rewording.value[key]).toBeUndefined();
    });

    it("keeps a done row held until the read after the write lands", async () => {
        const gate = deferred();
        fakeApi({ plan: vi.fn(async () => { await gate.promise; return { key: "2026-11-16" }; }) });
        holdWrite(ref, "done", "Done", async () => ({}));
        await vi.advanceTimersByTimeAsync(4000);
        expect(held.value[key]).toBe("done");
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(held.value[key]).toBeUndefined();
    });

    it("leaves the second reword's words until its own send", async () => {
        holdReword(ref, "X", async () => ({}));
        holdReword(ref, "Y", async () => ({}));
        await vi.advanceTimersByTimeAsync(0);
        expect(rewording.value[key]).toBe("Y");
        await vi.advanceTimersByTimeAsync(4000);
        expect(rewording.value[key]).toBeUndefined();
    });
});
