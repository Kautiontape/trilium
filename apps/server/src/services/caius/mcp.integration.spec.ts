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
