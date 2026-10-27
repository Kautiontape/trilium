import { sql_init } from "@triliumnext/core";
import { registerToolRegistry } from "@triliumnext/core/src/services/llm/tools/index.js";
import { registerToolRegistryLoader } from "@triliumnext/core/src/services/llm/tools/registration.js";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../mcp/mcp_server.js";
import sql from "../sql.js";
import { loadCaiusTools } from "./register.js";

const ROLLBACK_TITLE = "written before the throw";

// Writes a note through the store's own transaction, awaits, then throws.
registerToolRegistry(defineTools({
    test_write_then_throw: {
        description: "test only",
        inputSchema: z.object({}),
        async: true,
        mutates: true,
        execute: async () => {
            const { note_service: noteService } = await import("@triliumnext/core");
            sql.transactional(() => noteService.createNewNote({ parentNoteId: "root", title: ROLLBACK_TITLE, content: "", type: "text" }));
            await Promise.resolve();
            throw new Error("boom");
        }
    }
}));
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

it("rolls back what an async mutating tool wrote before it threw", async () => {
    const client = await connect();

    const result = await client.callTool({ name: "test_write_then_throw", arguments: {} });

    expect(result.isError).toBe(true);
    expect(sql.getValue("SELECT COUNT(*) FROM notes WHERE title = ?", [ROLLBACK_TITLE])).toBe(0);
});
