import { type CaiusConversation, type CaiusEffort, caiusOpener } from "@triliumnext/commons/src/lib/caius_openers.js";
import { applyChunk, type AssistantTurn, turnMessages } from "@triliumnext/commons/src/lib/caius_turn.js";
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
         * Runs one turn at `effort`: sends the whole history and the `turn` the server saves, and calls
         * `onChunk` for each chunk as it arrives. This is one of the two calls made with the WebView's
         * own `fetch`, because the native HTTP plugin hands back a body only once it is complete. The
         * server answers it with CORS for the app. A turn already running for the note is a `TurnRunningError`.
         */
        stream: async (messages: { role: "user" | "assistant"; content: string }[], chatNoteId: string, effort: CaiusEffort,
            turn: { replyId: string; transcript: StoredMessage[] }, onChunk: (chunk: ChatChunk) => void, signal?: AbortSignal) => {
            let res: Response;
            try {
                res = await fetch(`${conn.url}/etapi/llm-chat/stream`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${conn.token}`,
                        "Content-Type": "application/json",
                        Accept: "text/event-stream"
                    },
                    body: JSON.stringify({ messages, config: { chatNoteId, reasoningEffort: effort }, turn }),
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
            if (res.status === 409) {
                throw new TurnRunningError();
            }
            if (!res.ok || !res.body) {
                const body = await res.text().catch(() => "");
                throw res.status === 429 && errorOf(body) === "too_many_turns" ? new TooManyTurnsError(body) : new HttpError(res.status, body);
            }
            await readChunks(res.body, onChunk, signal);
        },

        /** What the server holds of the note's latest turn: the saved transcript, whether it still runs, and how many chunks it has. */
        turnState: async (noteId: string): Promise<TurnState> => {
            const res = await request({
                method: "GET",
                url: `${conn.url}/etapi/llm-chat/${encodeURIComponent(noteId)}/turn`,
                headers: { Authorization: `Bearer ${conn.token}` }
            });
            if (res.status === 404) {
                throw new NeedsServerUpdateError();
            }
            if (res.status < 200 || res.status >= 300) {
                throw new HttpError(res.status, res.text);
            }
            return JSON.parse(res.text) as TurnState;
        },

        /**
         * Rejoins the note's turn: replays its chunks from index `from`, then follows it live until it
         * ends. Made with the WebView's `fetch` like `stream`. No turn on the server is a `NoTurnError`.
         */
        reattach: async (noteId: string, from: number, onChunk: (chunk: ChatChunk) => void, signal?: AbortSignal) => {
            let res: Response;
            try {
                res = await fetch(`${conn.url}/etapi/llm-chat/${encodeURIComponent(noteId)}/stream?from=${from}`, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${conn.token}`, Accept: "text/event-stream" },
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
                const body = await res.text().catch(() => "");
                if (errorOf(body) === "no_turn") {
                    throw new NoTurnError();
                }
                throw new NeedsServerUpdateError();
            }
            if (!res.ok || !res.body) {
                throw new HttpError(res.status, await res.text().catch(() => ""));
            }
            await readChunks(res.body, onChunk, signal);
        }
    };
}

export type ChatApi = ReturnType<typeof chatApi>;

/** The body of `GET /etapi/llm-chat/{id}/turn`. */
export interface TurnState {
    content: LlmChatContent | null;
    running: boolean;
    replyId: string | null;
    chunks: number;
}

/** Reads an SSE body to its end, calling `onChunk` for each chunk. */
async function readChunks(body: ReadableStream<Uint8Array<ArrayBuffer>>, onChunk: (chunk: ChatChunk) => void, signal?: AbortSignal) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    const feed = sseParser((data) => {
        try {
            onChunk(JSON.parse(data) as ChatChunk);
        } catch {
            // A line that isn't JSON is not a chunk.
        }
    });
    for (;;) {
        let read: ReadableStreamReadResult<string>;
        try {
            read = await reader.read();
        } catch (e) {
            if (signal?.aborted) {
                throw e;
            }
            throw new StreamBrokenError();
        }
        if (read.done) {
            break;
        }
        feed(read.value);
    }
    feed("\n\n");
}

function errorOf(body: string): string | undefined {
    try {
        return (JSON.parse(body) as { error?: string }).error;
    } catch {
        return undefined;
    }
}

export type ChatKind = CaiusConversation;
export { applyChunk, type AssistantTurn, turnMessages };
export type { ContentBlock, LlmChatContent, StoredMessage, ToolCall };

/** The first message of a Caius conversation, in the words the server's opener check reads. */
export const opener = caiusOpener;

/** The chunks of `/etapi/llm-chat/stream`, as the server's `LlmStreamChunk` defines them. */
export type ChatChunk =
    | { type: "status"; status: string }
    | { type: "text"; content: string }
    | { type: "text_retract" }
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

/**
 * The history sent with a turn: user and assistant turns as text. A failed attempt (an error
 * message, and the user message it answered) is left out, so the model never reads an error as
 * its own words and a message sent again isn't there twice. Caius's notes are left out too: they
 * are the working, not the replies, and the server's session saw only the replies.
 */
export function historyForServer(all: StoredMessage[]): { role: "user" | "assistant"; content: string }[] {
    const messages = all.filter((m) => m.type !== "thinking");
    const sent: { role: "user" | "assistant"; content: string }[] = [];
    for (const [ index, message ] of messages.entries()) {
        const next = messages[index + 1];
        if (message.role === "system" || message.type === "error" || (message.role === "user" && next?.type === "error")) {
            continue;
        }
        sent.push({ role: message.role, content: typeof message.content === "string" ? message.content : turnText(message.content) });
    }
    return sent;
}

export function turnText(blocks: ContentBlock[]) {
    return blocks.map((b) => b.type === "text" ? b.content : "").join("");
}

/**
 * A ritual step the agent ran, read from a successful `caius_winddown` / `caius_planday` result:
 * the step's name, Caius's question and its data, for a step card. A day that hasn't started
 * (`error: "not_today"`) is the step `not_today`, whose card asks to plan it now. Null for any
 * other tool, a failed call, or a result that isn't a step.
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
    const later = parsed as { error?: string; date?: string; dateLabel?: string; title?: string };
    if (later.error === "not_today") {
        return { ritual: "plan", step: "not_today", title: later.title ?? null, question: null, data: { date: later.date }, dateLabel: later.dateLabel };
    }
    const step = parsed as { step: string; title?: string; question?: string | null; data?: Record<string, unknown>; dateLabel?: string };
    return {
        ritual: tool === "caius_winddown" ? "winddown" : "plan",
        step: step.step,
        title: step.title ?? null,
        question: step.question ?? null,
        data: step.data ?? {},
        dateLabel: step.dateLabel
    };
}

/** A tool result: its JSON, or the JSON in an MCP `content[0].text` envelope. */
export function parseResult(result: string): unknown {
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
    /** The card's heading; null from a server that predates titles, where the question stands in. */
    title: string | null;
    question: string | null;
    data: Record<string, unknown>;
    dateLabel?: string;
}

/**
 * Whether a step's card has anything to answer or read: a card with nothing in it is left out, and
 * the ask lives in Caius's message. A sentence alone (the capacity, a summary) is worth a card.
 */
export function stepHasBody(step: RitualStep): boolean {
    const d = step.data as Record<string, any>;
    const some = (list: unknown) => Array.isArray(list) && list.length > 0;
    switch (`${step.ritual}:${step.step}`) {
        case "plan:not_today":
            return true;
        case "plan:catchup":
            return some(d.tasks);
        case "winddown:open":
            return some(d.items);
        case "plan:inputs":
            return some(d.onDeck) || some(d.candidates) || some(d.unmarked);
        case "winddown:next":
            return some(d.candidates) || !!d.capacity?.sentence || !!d.summary;
        case "winddown:context":
            return some(d.context);
        default:
            return false;
    }
}

/** The server has no phone chat routes: it predates them. */
export class NeedsServerUpdateError extends Error {
    constructor() {
        super("Needs the Caius server update.");
        this.name = "NeedsServerUpdateError";
    }
}

/** Another turn is still running for the chat note; the server takes one at a time. */
export class TurnRunningError extends Error {
    constructor() {
        super("Caius is still answering the last message.");
        this.name = "TurnRunningError";
    }
}

/** The server refused the turn (429) because it runs as many as it allows. */
export class TooManyTurnsError extends HttpError {
    constructor(body: string) {
        super(429, body);
        this.message = "Caius is busy with other chats. Try again in a minute.";
        this.name = "TooManyTurnsError";
    }
}

/** The body broke off after the server took the turn: the phone lost its network, or the server restarted (a deploy). */
export class StreamBrokenError extends Error {
    constructor() {
        super("Lost the connection to the server partway through the reply.");
        this.name = "StreamBrokenError";
    }
}

/** The server has no turn for the chat note to rejoin. */
export class NoTurnError extends Error {
    constructor() {
        super("The server has no running turn for this chat.");
        this.name = "NoTurnError";
    }
}

/** The line the transcript shows while Caius works and the turn has no text yet. */
export function workingLine(turn: AssistantTurn | null): string {
    return turn?.blocks.some((b) => b.type === "tool_call") ? "Caius is writing…" : "Caius is reading the Journal…";
}

/**
 * The mini bar's line for a chat: while Caius works, the streaming text's last line or the working
 * line; once done, the error or the first line of the last reply. Null before the chat has a reply.
 */
export function activityLine(working: boolean, streaming: AssistantTurn | null, messages: StoredMessage[], error: string | null): string | null {
    if (working) {
        return (streaming && latestLine(turnText(streaming.blocks))) || workingLine(streaming);
    }
    if (error) {
        return firstLine(error);
    }
    const reply = messages.findLast((m) => m.role === "assistant" && m.type !== "thinking");
    if (!reply) {
        return null;
    }
    return firstLine(typeof reply.content === "string" ? reply.content : turnText(reply.content));
}

/** The last non-blank line of `text`, as plain words for the mini bar and the notification. */
export function latestLine(text: string): string {
    return plainLine(text.split("\n").reverse());
}

/** The first non-blank line of `text`, as plain words for the mini bar and the notification. */
export function firstLine(text: string): string {
    return plainLine(text.split("\n"));
}

function plainLine(lines: string[]): string {
    for (const line of lines) {
        const plain = line
            .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*•]\s+|\d+[.)]\s+)/, "")
            .replace(/\*\*|[*_]/g, "")
            .trim();
        if (plain) {
            return plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
        }
    }
    return "";
}
