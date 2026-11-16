import { beforeEach, describe, expect, it, vi } from "vitest";

import { caiusApi } from "./caius.js";
import { callTool } from "./mcp.js";

vi.mock("./mcp.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("./mcp.js")>(),
    callTool: vi.fn()
}));

const conn = { url: "https://notes.example.com", token: "tok" };

beforeEach(() => {
    vi.mocked(callTool).mockReset();
});

describe("caiusApi startDay", () => {
    it("sends no arguments to start and back: true to take it back, wrapping the answer", async () => {
        vi.mocked(callTool).mockResolvedValue({ date: "2026-11-16", status: "updated" });
        expect(await caiusApi(conn).startDay()).toEqual({ results: [ { date: "2026-11-16", status: "updated" } ] });
        expect(callTool).toHaveBeenLastCalledWith(conn, "caius_start_day", {});
        await caiusApi(conn).startDay(true);
        expect(callTool).toHaveBeenLastCalledWith(conn, "caius_start_day", { back: true });
    });

    it("turns an error answer into the write's error, preferring its detail", async () => {
        vi.mocked(callTool).mockResolvedValueOnce({ date: "2026-11-16", error: "bad_request", detail: "That note is protected." });
        expect(await caiusApi(conn).startDay()).toEqual({ error: "That note is protected." });
        vi.mocked(callTool).mockResolvedValueOnce({ error: "bad_request" });
        expect(await caiusApi(conn).startDay()).toEqual({ error: "bad_request" });
    });
});
