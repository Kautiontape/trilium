import { beforeAll, describe, expect, it, vi } from "vitest";

import { type ApiTestContext, bootLoggedInApp } from "../../../spec/support/internal_api.js";

vi.mock("../../services/caius/service.js", () => {
    throw new Error("cannot load the library");
});

let ctx: ApiTestContext;

describe("Caius routes when the service fails to load", () => {
    beforeAll(async () => {
        ctx = await bootLoggedInApp();
    });

    it("answers 503 caius_unavailable on every operation route, and enabled: false on status, while Trilium keeps working", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const status = await ctx.agent.get("/api/caius/status").expect(200);
        expect(status.body).toEqual({ enabled: false, detail: expect.any(String) });

        const requests = [
            ...["plan?period=day", "open", "explain?noteId=root&listItemId=x", "nudge?date=2031-05-06", "context?date=2031-05-06"].map((path) => ({ path, send: () => ctx.agent.get(`/api/caius/${path}`) })),
            ...["add", "accept", "dismiss", "set-state", "forward", "assign-ids", "apply", "skip-catchup"].map((path) => ({
                path,
                send: () => ctx.agent.post(`/api/caius/${path}`).set("x-csrf-token", ctx.csrfToken).send({ items: [] })
            }))
        ];
        for (const { path, send } of requests) {
            const res = await send();
            expect(res.status, path).toBe(503);
            expect(res.body).toEqual({ error: "caius_unavailable", detail: expect.any(String) });
        }
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Caius disabled: "));

        await ctx.agent.get("/api/tree").expect(200);
    });
});
