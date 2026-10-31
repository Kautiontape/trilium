import { caiusConversationOfMessages, type LlmChatContent, type LlmMessage } from "@triliumnext/commons";
import { becca, options as optionService, special_notes as specialNotesService } from "@triliumnext/core";
import type { LlmProviderSetup } from "@triliumnext/core/src/services/llm/index.js";
import type { LlmProviderConfig } from "@triliumnext/core/src/services/llm/types.js";
import type { Request, Response } from "express";

import llmChatRoute from "./llm_chat.js";

/**
 * The AI chat for a client holding an ETAPI token, the Caius phone app. It runs only a Caius
 * conversation (a first user message such as `Wind down 2026-11-04`, see `caiusOpener`) and only
 * on the `claude-agent` provider, which is the one that gives such a conversation Caius's prompt
 * and leaves the generic note tools that write out of it. `streamChat` then runs it as it runs
 * the sidebar's.
 */
export default {
    /** `POST /etapi/llm-chat/stream`: a turn, as `checkCaiusChat` leaves it. */
    streamCaiusChat: async (req: Request, res: Response) => {
        const checked = checkCaiusChat(req.body);
        if ("error" in checked) {
            res.status(checked.status).json({ error: checked.error });
            return;
        }
        req.body = checked;
        await llmChatRoute.streamChat(req, res);
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
        const note = chatNoteOf(req.params.noteId);
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

export type CaiusChatCheck =
    | { status: number; error: string }
    | { messages: LlmMessage[]; config: LlmProviderConfig };

/**
 * Checks a token client's chat request and builds the config it runs with. Only `chatNoteId`
 * and `model` are read from the client's config: the provider, the note tools on and web search
 * off are set here. `chatNoteId` must name a chat note (`chatNoteOf`), since the first turn renames it.
 */
export function checkCaiusChat(body: unknown): CaiusChatCheck {
    const { messages, config } = (body ?? {}) as { messages?: unknown; config?: Partial<LlmProviderConfig> };

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

    const chatNote = chatNoteOf(config?.chatNoteId);
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

    return {
        messages,
        config: {
            providerId: setup.id,
            chatNoteId: chatNote.noteId,
            enableNoteTools: true,
            enableWebSearch: false,
            ...(model !== undefined ? { model } : {})
        }
    };
}

/**
 * The chat note `noteId` names, when it is one a token client may use: an unprotected `llmChat`
 * note under `_llmChat`, where the sidebar and `createChatNote` create them.
 */
function chatNoteOf(noteId: unknown) {
    const note = typeof noteId === "string" ? becca.getNote(noteId) : null;
    return note && note.type === "llmChat" && !note.isProtected && note.hasAncestor("_llmChat") ? note : null;
}

/** The largest transcript `saveChatContent` writes, in characters of JSON: 2 MB of text. */
const MAX_CHAT_CONTENT_LENGTH = 2 * 1024 * 1024;

/**
 * Whether `value` has the shape the chat views read (`LlmChatContent`): version 1, and messages
 * that each carry a string `id` and `createdAt`, a role, and string or block content.
 */
function isChatContent(value: unknown): value is LlmChatContent {
    const content = value as Partial<LlmChatContent> | undefined;
    return content?.version === 1 && Array.isArray(content.messages) && content.messages.every((message: unknown) => {
        if (typeof message !== "object" || message === null) {
            return false;
        }
        const { id, role, content: body, createdAt } = message as Record<string, unknown>;
        return typeof id === "string" && typeof createdAt === "string"
            && (role === "user" || role === "assistant" || role === "system")
            && (typeof body === "string" || (Array.isArray(body) && body.every(isBlock)));
    });
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
