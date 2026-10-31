import { type CaiusConversation, caiusOpener } from "@triliumnext/commons/src/lib/caius_openers.js";
import type { ContentBlock, LlmChatContent, StoredMessage, ToolCall } from "@triliumnext/commons/src/lib/llm/chat_content.js";

import type { Connection } from "./connection.js";
import { HttpError, request, UnreachableError } from "./http.js";

/**
 * The server's Caius chat over the token routes: `POST /etapi/special-notes/llm-chat` makes the
 * chat note, `POST /etapi/llm-chat/stream` runs one turn as SSE, and the transcript is saved by
 * `PUT /etapi/llm-chat/{id}/content` in the sidebar's `LlmChatContent` shape, so the chat opens on
 * the desktop too. The server only takes a conversation that starts with a Caius opener (`opener()`).
 */
export function chatApi(conn: Connection) {
    return {
        createNote: async (): Promise<string> => {
            const res = await request({
                method: "POST",
                url: `${conn.url}/etapi/special-notes/llm-chat`,
                headers: { Authorization: `Bearer ${conn.token}` },
                json: {}
            });
            if (res.status === 404) {
                throw new NeedsServerUpdateError();
            }
            if (res.status < 200 || res.status >= 300) {
                throw new HttpError(res.status, res.text);
            }
            const body = JSON.parse(res.text) as { noteId?: string; note?: { noteId?: string } };
            const noteId = body.noteId ?? body.note?.noteId;
            if (!noteId) {
                throw new Error("The server made no chat note.");
            }
            return noteId;
        },

        save: async (noteId: string, content: LlmChatContent) => {
            const res = await request({
                method: "PUT",
                url: `${conn.url}/etapi/llm-chat/${encodeURIComponent(noteId)}/content`,
                headers: { Authorization: `Bearer ${conn.token}` },
                json: content
            });
            if (res.status < 200 || res.status >= 300) {
                throw new HttpError(res.status, res.text);
            }
        },

        /**
         * Runs one turn: sends the whole history and calls `onChunk` for each chunk as it arrives.
         * This is the one call made with the WebView's own `fetch`, because the native HTTP plugin
         * hands back a body only once it is complete. The server answers it with CORS for the app.
         */
        stream: async (messages: { role: "user" | "assistant"; content: string }[], chatNoteId: string,
            onChunk: (chunk: ChatChunk) => void, signal?: AbortSignal) => {
            let res: Response;
            try {
                res = await fetch(`${conn.url}/etapi/llm-chat/stream`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${conn.token}`,
                        "Content-Type": "application/json",
                        Accept: "text/event-stream"
                    },
                    body: JSON.stringify({ messages, config: { chatNoteId } }),
                    redirect: "error",
                    signal
                });
            } catch (e) {
                if (signal?.aborted) {
                    throw e;
                }
                throw new UnreachableError(conn.url, e);
            }
            if (res.status === 404) {
                throw new NeedsServerUpdateError();
            }
            if (!res.ok || !res.body) {
                throw new HttpError(res.status, await res.text().catch(() => ""));
            }

            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            const feed = sseParser((data) => {
                try {
                    onChunk(JSON.parse(data) as ChatChunk);
                } catch {
                    // A line that isn't JSON is not a chunk.
                }
            });
            for (;;) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                feed(value);
            }
            feed("\n\n");
        }
    };
}

export type ChatApi = ReturnType<typeof chatApi>;

export type ChatKind = CaiusConversation;
export type { ContentBlock, LlmChatContent, StoredMessage, ToolCall };

/** The first message of a Caius conversation, in the words the server's opener check reads. */
export const opener = caiusOpener;

/** The chunks of `/etapi/llm-chat/stream`, as the server's `LlmStreamChunk` defines them. */
export type ChatChunk =
    | { type: "status"; status: string }
    | { type: "text"; content: string }
    | { type: "thinking"; content: string }
    | { type: "tool_input_start"; toolCallId: string; toolName: string }
    | { type: "tool_input_delta"; toolCallId: string; delta: string }
    | { type: "tool_use"; toolCallId: string; toolName: string; toolInput: Record<string, unknown> }
    | { type: "tool_result"; toolCallId: string; toolName: string; result: string; isError?: boolean }
    | { type: "citation"; citation: unknown }
    | { type: "usage"; usage: unknown }
    | { type: "error"; error: string }
    | { type: "done" };

/** Feeds text in; calls `onData` with the `data:` payload of each complete SSE event. Comments (`:`) are heartbeats. */
export function sseParser(onData: (data: string) => void) {
    let buffer = "";
    return (text: string) => {
        buffer += text;
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
            const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
            if (data) {
                onData(data);
            }
        }
    };
}

/** An assistant turn being assembled from chunks. */
export interface AssistantTurn {
    id: string;
    blocks: ContentBlock[];
    error?: string;
    done: boolean;
}

/** Applies one chunk to the turn being assembled. Text joins the last text block; a tool call gets its own block. */
export function applyChunk(turn: AssistantTurn, chunk: ChatChunk): AssistantTurn {
    switch (chunk.type) {
        case "text": {
            const last = turn.blocks[turn.blocks.length - 1];
            if (last?.type === "text") {
                return { ...turn, blocks: [ ...turn.blocks.slice(0, -1), { type: "text", content: last.content + chunk.content } ] };
            }
            return { ...turn, blocks: [ ...turn.blocks, { type: "text", content: chunk.content } ] };
        }
        case "tool_use": {
            if (turn.blocks.some((b) => b.type === "tool_call" && b.toolCall.id === chunk.toolCallId)) {
                return turn;
            }
            const toolCall: ToolCall = { id: chunk.toolCallId, toolName: chunk.toolName, input: chunk.toolInput };
            return { ...turn, blocks: [ ...turn.blocks, { type: "tool_call", toolCall } ] };
        }
        case "tool_result": {
            const existing = turn.blocks.some((b) => b.type === "tool_call" && b.toolCall.id === chunk.toolCallId);
            const blocks: ContentBlock[] = existing
                ? turn.blocks.map((b) => b.type === "tool_call" && b.toolCall.id === chunk.toolCallId
                    ? { type: "tool_call", toolCall: { ...b.toolCall, result: chunk.result, isError: chunk.isError } }
                    : b)
                : [ ...turn.blocks, { type: "tool_call", toolCall: { id: chunk.toolCallId, toolName: chunk.toolName, input: {}, result: chunk.result, isError: chunk.isError } } ];
            return { ...turn, blocks };
        }
        case "error":
            return { ...turn, error: chunk.error, done: true };
        case "done":
            return { ...turn, done: true };
        default:
            return turn;
    }
}

export function turnText(blocks: ContentBlock[]) {
    return blocks.map((b) => b.type === "text" ? b.content : "").join("");
}

/**
 * A ritual step the agent ran, read from a successful `caius_winddown` / `caius_planday` result:
 * the step's name, Caius's question and its data, for a step card. Null for any other tool, a
 * failed call, or a result that isn't a step.
 */
export function stepOf(call: ToolCall): RitualStep | null {
    const tool = call.toolName.replace(/^mcp__\w+__/, "");
    if ((tool !== "caius_winddown" && tool !== "caius_planday") || call.isError || !call.result) {
        return null;
    }
    const parsed = parseResult(call.result);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { step?: unknown }).step !== "string") {
        return null;
    }
    const step = parsed as { step: string; question?: string | null; data?: Record<string, unknown>; dateLabel?: string };
    return {
        ritual: tool === "caius_winddown" ? "winddown" : "plan",
        step: step.step,
        question: step.question ?? null,
        data: step.data ?? {},
        dateLabel: step.dateLabel
    };
}

/** A tool result: its JSON, or the JSON in an MCP `content[0].text` envelope. */
function parseResult(result: string): unknown {
    try {
        const parsed = JSON.parse(result) as unknown;
        const nested = (parsed as { content?: { text?: string }[] })?.content?.[0]?.text;
        if (typeof nested === "string") {
            return JSON.parse(nested);
        }
        return parsed;
    } catch {
        return null;
    }
}

export interface RitualStep {
    ritual: "plan" | "winddown";
    step: string;
    question: string | null;
    data: Record<string, unknown>;
    dateLabel?: string;
}

/** The server has no phone chat routes: it predates them. */
export class NeedsServerUpdateError extends Error {
    constructor() {
        super("Needs the Caius server update.");
        this.name = "NeedsServerUpdateError";
    }
}
