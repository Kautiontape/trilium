import type { Connection } from "./connection.js";
import { HttpError, request } from "./http.js";

/**
 * Calls one tool on the server's `/mcp` with the ETAPI token and returns the tool's own answer.
 *
 * The transport is stateless Streamable HTTP: one JSON-RPC POST, no `initialize`. The `Accept`
 * header must name both JSON and SSE (JSON alone gets 406), and even a single reply comes in SSE
 * framing. A tool answers with its JSON as a string in `result.content[0].text`.
 */
export async function callTool<T>(conn: Connection, name: string, args: Record<string, unknown>): Promise<T> {
    const id = ++nextId;
    const res = await request({
        method: "POST",
        url: `${conn.url}/mcp`,
        headers: {
            Authorization: `Bearer ${conn.token}`,
            Accept: "application/json, text/event-stream"
        },
        json: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
    });
    if (res.status === 403) {
        throw new McpError("The MCP server is off in Trilium. Turn it on in Options → AI → MCP.");
    }
    if (res.status < 200 || res.status >= 300) {
        throw new HttpError(res.status, res.text);
    }
    return parseToolReply<T>(res.text, id);
}

let nextId = 0;

/** The tool's answer out of a JSON-RPC reply in SSE framing (or bare JSON). */
export function parseToolReply<T>(body: string, id?: number): T {
    const messages = rpcMessages(body);
    const reply = messages.find((m) => id === undefined || m.id === id) ?? messages[messages.length - 1];
    if (!reply) {
        throw new McpError("The server sent no answer.");
    }
    if (reply.error) {
        throw new McpError(reply.error.message ?? "The tool call failed.");
    }
    const text = reply.result?.content?.[0]?.text;
    if (reply.result?.isError) {
        throw new McpError(text ?? "The tool call failed.");
    }
    if (typeof text !== "string") {
        throw new McpError("The tool answered with nothing.");
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        return text as T;
    }
}

/** Every JSON-RPC message in a body: the `data:` lines of an SSE stream, or the body itself. */
function rpcMessages(body: string): RpcMessage[] {
    const trimmed = body.trim();
    if (trimmed.startsWith("{")) {
        return [ JSON.parse(trimmed) as RpcMessage ];
    }
    const messages: RpcMessage[] = [];
    for (const event of trimmed.split(/\r?\n\r?\n/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (data) {
            messages.push(JSON.parse(data) as RpcMessage);
        }
    }
    return messages;
}

interface RpcMessage {
    id?: number;
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    error?: { code: number; message?: string };
}

export class McpError extends Error {
    constructor(message: string) {
        super(message.replace(/^MCP error -?\d+:\s*/, ""));
        this.name = "McpError";
    }
}
