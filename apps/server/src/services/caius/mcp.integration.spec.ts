import { sql_init } from "@triliumnext/core";
import { registerToolRegistryLoader } from "@triliumnext/core/src/services/llm/tools/registration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, expect, it } from "vitest";

import { createMcpServer } from "../mcp/mcp_server.js";
import sql from "../sql.js";
import { loadCaiusTools } from "./register.js";

registerToolRegistryLoader(() => loadCaiusTools());

async function connect() {
    const server = await createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

beforeAll(async () => {
    await sql_init.dbReady;
});

it("lists the caius tools on /mcp and returns real JSON from one call", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["caius_plan", "caius_open", "caius_explain", "caius_add", "caius_accept", "caius_dismiss", "caius_set_state", "caius_forward"]));
    expect(names).toContain("search_notes");

    const result = await client.callTool({ name: "caius_plan", arguments: { period: "day", date: "2031-01-02" } });
    const [content] = result.content as { type: string; text: string }[];
    expect(JSON.parse(content!.text)).toMatchObject({ period: "day", key: "2031-01-02", noteId: null });
});

it("rejects days, weeks and months that don't exist, and creates no calendar note for them", async () => {
    const client = await connect();
    const isError = async (name: string, args: object) => (await client.callTool({ name, arguments: args })).isError;

    for (const when of [{ date: "2026-02-30" }, { week: "2025-W53" }, { month: "2026-13" }]) {
        expect(await isError("caius_add", { items: [{ ...when, section: "Work", text: "Never written" }] }), JSON.stringify(when)).toBe(true);
    }
    for (const to of ["2026-02-30", "2025-W53", "2026-13"]) {
        expect(await isError("caius_forward", { items: [{ noteId: "root", listItemId: "x", to }] }), to).toBe(true);
    }
    const plan = await client.callTool({ name: "caius_plan", arguments: { period: "day", date: "2026-02-30" } });
    const [content] = plan.content as { type: string; text: string }[];
    expect(plan.isError || "error" in JSON.parse(content?.text ?? "{}")).toBe(true);

    expect(sql.getValue(`SELECT COUNT(*) FROM attributes WHERE isDeleted = 0 AND name IN ('dateNote', 'weekNote', 'monthNote')
        AND value IN ('2026-02-30', '2025-W53', '2026-13')`)).toBe(0);
    // 2026 has 53 ISO weeks.
    for (const when of [{ date: "2026-02-28" }, { week: "2026-W53" }, { month: "2026-12" }]) {
        expect(await isError("caius_add", { items: [{ ...when, section: "Work", text: "Dry" }], dryRun: true }), JSON.stringify(when)).toBeFalsy();
    }
});
