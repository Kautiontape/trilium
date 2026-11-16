// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TodayData } from "../lib/store.js";

const startDay = vi.fn(async (_back?: boolean) => ({ results: [ { status: "updated" } ] }));

vi.mock("../lib/store.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/store.js")>()),
    api: () => ({ startDay }),
    runWrite: async (send: () => Promise<unknown>) => { await send(); return true; }
}));

const { DayFlip } = await import("./DayFlip.js");

let root: HTMLElement;

beforeEach(() => {
    startDay.mockClear();
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

function show(now: Date, extra: Partial<TodayData> = {}) {
    const data = { key: "2026-11-15", rhythm: { rollover: "04:00" }, started: null, offline: false, ...extra } as unknown as TodayData;
    act(() => render(<DayFlip data={data} now={now} />, root));
    return root.querySelector("button");
}

describe("DayFlip", () => {
    it("offers Start before the rollover and starts the day on a tap", () => {
        const button = show(new Date(2026, 10, 16, 3, 0));
        expect(button?.textContent).toBe("Start Monday now");
        act(() => button?.click());
        expect(startDay).toHaveBeenCalledWith(false);
    });

    it("offers Back while the day is started early and takes it back on a tap", () => {
        const button = show(new Date(2026, 10, 16, 3, 0), { started: "2026-11-16T00:20:00" });
        expect(button?.textContent).toBe("Back to Sunday");
        act(() => button?.click());
        expect(startDay).toHaveBeenCalledWith(true);
    });

    it("shows nothing outside the window and disables the button offline", () => {
        expect(show(new Date(2026, 10, 16, 5, 0))).toBeNull();
        expect(show(new Date(2026, 10, 16, 23, 0))).toBeNull();
        expect(show(new Date(2026, 10, 16, 3, 0), { offline: true })?.disabled).toBe(true);
    });
});
