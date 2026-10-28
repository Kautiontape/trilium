/**
 * MCP (Model Context Protocol) server for Trilium Notes.
 *
 * Exposes existing LLM tools via the MCP protocol so external AI agents
 * (e.g. Claude Desktop) can interact with Trilium.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { app_info as appInfo } from "@triliumnext/core";
import { cls } from "@triliumnext/core";

import { allToolRegistries, resolveToolRegistries } from "@triliumnext/core/src/services/llm/tools/index.js";
import type { ToolDefinition } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";

import sql from "../sql.js";

/**
 * Register a tool definition on the MCP server.
 *
 * Every call runs in a CLS context so that Becca entity tracking works, and a
 * sync tool's writes run in one transaction.
 */
function registerTool(server: McpServer, name: string, def: ToolDefinition) {
    server.registerTool(name, {
        description: def.description,
        inputSchema: def.inputSchema
    }, (args: any): CallToolResult | Promise<CallToolResult> => {
        const toContent = (result: object): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(result) }] });

        if (def.async) {
            return cls.init(async () => {
                cls.set("componentId", "mcp");

                return toContent(await def.execute(args));
            });
        }

        const result = cls.init(() => {
            cls.set("componentId", "mcp");

            return def.mutates
                ? sql.transactional(() => def.execute(args))
                : def.execute(args);
        });

        return toContent(result);
    });
}

/** Trilium's MCP server with every registered tool but those named in `omit`, which it never lists. */
export async function createMcpServer({ omit = [] }: { omit?: string[] } = {}): Promise<McpServer> {
    // Host-registered registries (the User Guide tools) load lazily; the array
    // is complete only after this resolves.
    await resolveToolRegistries();

    const server = new McpServer({
        name: "trilium-notes",
        version: appInfo.appVersion
    });

    for (const registry of allToolRegistries) {
        for (const [name, def] of registry) {
            if (omit.includes(name)) continue;
            registerTool(server, name, def);
        }
    }

    return server;
}
