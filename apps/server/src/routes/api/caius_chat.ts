import {
    caiusConversationOfMessages,
    type CaiusStoredMessage,
    isCaiusEffort,
    type LlmChatContent,
    type LlmMessage
} from "@triliumnext/commons";
import { options as optionService, special_notes as specialNotesService } from "@triliumnext/core";
import type { LlmProviderSetup } from "@triliumnext/core/src/services/llm/index.js";
import type { LlmProviderConfig } from "@triliumnext/core/src/services/llm/types.js";
import type { Request, Response } from "express";

import {
    MAX_CHAT_CONTENT_LENGTH,
    phoneChatNoteOf,
    startTurn,
    subscribe,
    type Turn,
    turnOf
} from "../../services/caius/turns.js";
import { SSE_HEARTBEAT_FRAME, startSseHeartbeat } from "./llm_chat.js";

/**
 * The AI chat for a client holding an ETAPI token, the Caius phone app. It runs only a Caius
 * conversation (a first user message such as `Wind down 2026-11-04`, see `caiusOpener`) and only
 * on the `claude-agent` provider, which is the one that gives such a conversation Caius's prompt
 * and leaves the generic note tools that write out of it. The turn registry in `turns.ts` runs
 * each turn to its end whether or not the client still reads it.
 */
export default {
    /**
     * `POST /etapi/llm-chat/stream`: starts a turn, as `checkCaiusChat` leaves it, and streams it
     * as SSE. A note whose turn still runs answers 409 `turn_running`.
     */
    streamCaiusChat: (req: Request, res: Response) => {
        const checked = checkCaiusChat(req.body);
        if ("error" in checked) {
            res.status(checked.status).json({ error: checked.error });
            return;
        }
        const turn = startTurn({
            noteId: checked.noteId,
            messages: checked.messages,
            config: checked.config,
            transcript: checked.turn?.transcript,
            replyId: checked.turn?.replyId
        });
        if (turn === "running") {
            res.status(409).json({ error: "turn_running" });
            return;
        }
        streamTurn(turn, 0, res);
    },

    /**
     * `GET /etapi/llm-chat/:noteId/turn`: the chat note's saved content, and whether its latest
     * turn still runs, that turn's reply id and how many chunks it has given.
     */
    turnState: (req: Request<{ noteId: string }>) => {
        const note = phoneChatNoteOf(req.params.noteId);
        if (!note) {
            return [ 400, { error: "chat_note_invalid" } ];
        }
        const turn = turnOf(note.noteId);
        return {
            content: parsedContent(note.getContent()),
            running: turn?.running ?? false,
            replyId: turn?.replyId ?? null,
            chunks: turn?.chunks.length ?? 0
        };
    },

    /**
     * `GET /etapi/llm-chat/:noteId/stream?from=N`: the chat note's latest turn as SSE, from chunk
     * `from` on, live until the turn ends. A note with no turn answers 404 `no_turn`.
     */
    reattachTurn: (req: Request<{ noteId: string }>, res: Response) => {
        const note = phoneChatNoteOf(req.params.noteId);
        if (!note) {
            res.status(400).json({ error: "chat_note_invalid" });
            return;
        }
        const turn = turnOf(note.noteId);
        if (!turn) {
            res.status(404).json({ error: "no_turn" });
            return;
        }
        const { from } = req.query;
        streamTurn(turn, typeof from === "string" && /^\d+$/.test(from) ? Number(from) : 0, res);
    },

    /** `POST /etapi/special-notes/llm-chat`: a new chat note, where the sidebar puts its own. */
    createChatNote: () => {
        const note = specialNotesService.createLlmChat();
        return [ 201, { noteId: note.noteId, title: note.title } ];
    },

    /**
     * `PUT /etapi/llm-chat/:noteId/content`: the transcript the client keeps, as `LlmChatContent`,
     * written to a chat note only, so the sidebar shows the conversation.
     */
    saveChatContent: (req: Request<{ noteId: string }>) => {
        const note = phoneChatNoteOf(req.params.noteId);
        if (!note) {
            return [ 400, { error: "chat_note_invalid" } ];
        }
        if (!isChatContent(req.body)) {
            return [ 400, { error: "content_invalid" } ];
        }
        const json = JSON.stringify(req.body);
        if (json.length > MAX_CHAT_CONTENT_LENGTH) {
            return [ 413, { error: "content_too_large" } ];
        }
        note.setContent(json);
        return undefined;
    }
};

/** What the registry saves a turn as: the reply's message id, and the messages before the reply. */
export interface CaiusTurnRequest {
    replyId: string;
    transcript: CaiusStoredMessage[];
}

export type CaiusChatCheck =
    | { status: number; error: string }
    | {
        noteId: string;
        messages: LlmMessage[];
        config: LlmProviderConfig;
        turn?: CaiusTurnRequest;
    };

/**
 * Checks a token client's chat request and builds the config it runs with. Only `chatNoteId`,
 * `model` and `reasoningEffort` (one of `CAIUS_EFFORTS`) are read from the client's config: the
 * provider, the note tools on and web search off are set here. `chatNoteId` must name a chat note
 * (`phoneChatNoteOf`), since the first turn renames it. The optional `turn` is what the server
 * saves the turn to the note as; without it the turn runs and nothing is saved.
 */
export function checkCaiusChat(body: unknown): CaiusChatCheck {
    const { messages, config, turn } = (body ?? {}) as {
        messages?: unknown;
        config?: Partial<LlmProviderConfig>;
        turn?: unknown;
    };

    if (optionService.getOptionOrNull("aiEnabled") !== "true") {
        return { status: 403, error: "ai_disabled" };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        return { status: 400, error: "messages_required" };
    }
    if (!messages.every(isChatMessage)) {
        return { status: 400, error: "message_not_allowed" };
    }
    // The provider decides with the same function, so a chat this lets through is Caius's there too.
    if (!caiusConversationOfMessages(messages)) {
        return { status: 400, error: "not_a_caius_opener" };
    }

    const chatNote = phoneChatNoteOf(config?.chatNoteId);
    if (!chatNote) {
        return { status: 400, error: "chat_note_invalid" };
    }

    const setup = configuredProviders().find((provider) => provider.provider === "claude-agent");
    if (!setup) {
        return { status: 503, error: "no_claude_agent_provider" };
    }
    const model = config?.model;
    if (model !== undefined && !setup.selectedModels?.some((selected) => selected.id === model)) {
        return { status: 400, error: "model_not_allowed" };
    }
    const effort = config?.reasoningEffort;
    if (effort !== undefined && !isCaiusEffort(effort)) {
        return { status: 400, error: "effort_not_allowed" };
    }

    if (turn !== undefined) {
        if (!isTurnRequest(turn)) {
            return { status: 400, error: "turn_invalid" };
        }
        if (JSON.stringify(turn.transcript).length > MAX_CHAT_CONTENT_LENGTH) {
            return { status: 413, error: "content_too_large" };
        }
    }

    return {
        noteId: chatNote.noteId,
        messages,
        ...(turn !== undefined ? { turn } : {}),
        config: {
            providerId: setup.id,
            chatNoteId: chatNote.noteId,
            enableNoteTools: true,
            enableWebSearch: false,
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { reasoningEffort: effort } : {})
        }
    };
}

/**
 * Answers `res` as SSE with `turn`'s chunks from index `from`, then live ones, and ends it once
 * the turn ends. A closed response only stops this reader; the turn runs on.
 */
function streamTurn(turn: Turn, from: number, res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.triliumResponseHandled = true;

    const flushable = res as Response & { flush?: () => void };
    let stopped = false;
    const write = (frame: string) => {
        if (stopped) {
            return;
        }
        res.write(frame);
        flushable.flush?.();
    };
    const heartbeat = startSseHeartbeat(() => write(SSE_HEARTBEAT_FRAME));
    let unsubscribe = () => {};
    const stop = () => {
        stopped = true;
        heartbeat.stop();
        unsubscribe();
    };
    // Registered before `subscribe`, which ends a finished turn's replay at once.
    res.on("close", stop);
    unsubscribe = subscribe(turn, from, (chunk) => {
        write(`data: ${JSON.stringify(chunk)}\n\n`);
        heartbeat.reset();
    }, () => {
        stop();
        res.end();
    });
}

/** A chat note's content as JSON, or null when it is empty or not JSON. */
function parsedContent(content: string | Uint8Array): unknown {
    if (typeof content !== "string" || !content) {
        return null;
    }
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Whether `value` has the shape the chat views read (`LlmChatContent`): version 1, and messages
 * that each carry a string `id` and `createdAt`, a role, and string or block content.
 */
function isChatContent(value: unknown): value is LlmChatContent {
    const content = value as Partial<LlmChatContent> | undefined;
    return content?.version === 1 && Array.isArray(content.messages)
        && content.messages.every(isStoredMessage);
}

/** A non-empty transcript of stored messages and a `replyId` of 1 to 64 `[A-Za-z0-9_-]`. */
function isTurnRequest(value: unknown): value is CaiusTurnRequest {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const { replyId, transcript } = value as Record<string, unknown>;
    return typeof replyId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(replyId)
        && Array.isArray(transcript) && transcript.length > 0 && transcript.every(isStoredMessage);
}

function isStoredMessage(message: unknown): message is CaiusStoredMessage {
    if (typeof message !== "object" || message === null) {
        return false;
    }
    const { id, role, content: body, createdAt } = message as Record<string, unknown>;
    return typeof id === "string" && typeof createdAt === "string"
        && (role === "user" || role === "assistant" || role === "system")
        && (typeof body === "string" || (Array.isArray(body) && body.every(isBlock)));
}

function isBlock(block: unknown): boolean {
    return typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string";
}

/** A user or assistant turn; a `system` message from the client would sit beside Caius's prompt. */
function isChatMessage(message: unknown): message is LlmMessage {
    if (typeof message !== "object" || message === null) {
        return false;
    }
    const { role, content } = message as Partial<LlmMessage>;
    return (role === "user" || role === "assistant") && (typeof content === "string" || Array.isArray(content));
}

function configuredProviders(): LlmProviderSetup[] {
    try {
        return JSON.parse(optionService.getOptionOrNull("llmProviders") ?? "[]") as LlmProviderSetup[];
    } catch {
        return [];
    }
}
