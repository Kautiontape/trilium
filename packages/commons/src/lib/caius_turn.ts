import type { LlmStreamChunk } from "./llm_api.js";
import type { ContentBlock, StoredMessage, ToolCall } from "./llm/chat_content.js";

/**
 * The chunks a turn is assembled from: the {@link LlmStreamChunk}s that change it, and the three
 * that carry nothing for it, left loose so the phone's `ChatChunk` (which types their payloads
 * as `unknown`) is assignable too.
 */
export type CaiusTurnChunk =
    | Exclude<LlmStreamChunk, { type: "status" | "citation" | "usage" | "error" }>
    | { type: "error"; error: string }
    | { type: "status" | "citation" | "usage" };

/** An assistant turn being assembled from chunks. */
export interface AssistantTurn {
    id: string;
    blocks: ContentBlock[];
    /**
     * What Caius worked through on the way to the reply, in order: each stretch of thinking, and
     * each text the server took back (narration before a tool call). Shown folded away.
     */
    notes?: string[];
    /** Whether the last chunk was thinking, so the next thinking carries on the same note. */
    noting?: boolean;
    error?: string;
    done: boolean;
}

/** A stored message; `partial` marks a reply saved while its turn is still running. */
export type CaiusStoredMessage = StoredMessage & { partial?: boolean };

/**
 * Applies one chunk to the turn being assembled. Text joins the last text block; a tool call gets
 * its own block; thinking and taken-back text go to the notes.
 */
export function applyChunk(turn: AssistantTurn, chunk: CaiusTurnChunk): AssistantTurn {
    const next = assemble(turn, chunk);
    return chunk.type === "thinking" || !next.noting ? next : { ...next, noting: false };
}

/**
 * The messages a turn is stored as: its notes as a thinking message just before the reply, which
 * the sidebar shows as the thought process, then the reply. A failed turn is kept as an error
 * message with no notes. With `partial`, the reply is marked as saved before the turn finished.
 */
export function turnMessages(turn: AssistantTurn, createdAt: string, { partial }: { partial?: boolean } = {}): CaiusStoredMessage[] {
    if (turn.error) {
        return [ { id: turn.id, role: "assistant", content: turn.error, createdAt, type: "error", ...(partial ? { partial } : {}) } ];
    }
    const reply: CaiusStoredMessage = { id: turn.id, role: "assistant", content: turn.blocks, createdAt, ...(partial ? { partial } : {}) };
    if (!turn.notes?.length) {
        return [ reply ];
    }
    return [ { id: `${turn.id}-notes`, role: "assistant", content: turn.notes.join("\n\n"), createdAt, type: "thinking" }, reply ];
}

function assemble(turn: AssistantTurn, chunk: CaiusTurnChunk): AssistantTurn {
    const notes = turn.notes ?? [];
    switch (chunk.type) {
        case "text": {
            const last = turn.blocks[turn.blocks.length - 1];
            if (last?.type === "text") {
                return { ...turn, blocks: [ ...turn.blocks.slice(0, -1), { type: "text", content: last.content + chunk.content } ] };
            }
            return { ...turn, blocks: [ ...turn.blocks, { type: "text", content: chunk.content } ] };
        }
        case "text_retract": {
            const last = turn.blocks[turn.blocks.length - 1];
            if (last?.type !== "text") {
                return turn;
            }
            const taken = last.content.trim();
            return { ...turn, blocks: turn.blocks.slice(0, -1), notes: taken ? [ ...notes, taken ] : notes };
        }
        case "thinking": {
            if (turn.noting && notes.length) {
                return { ...turn, notes: [ ...notes.slice(0, -1), notes[notes.length - 1] + chunk.content ] };
            }
            return { ...turn, notes: [ ...notes, chunk.content ], noting: true };
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
