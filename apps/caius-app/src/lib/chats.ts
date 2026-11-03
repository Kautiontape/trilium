import type { CaiusEffort } from "@triliumnext/commons/src/lib/caius_openers.js";
import type { CaiusStoredMessage } from "@triliumnext/commons/src/lib/caius_turn.js";

import { applyChunk, type AssistantTurn, type ChatApi, type ChatKind, type LlmChatContent, NoTurnError, type StoredMessage, StreamBrokenError } from "./chat.js";
import { UnreachableError } from "./http.js";
import { readLocal, writeLocal } from "./local.js";

/**
 * Follows the server's turn for `replyId` after the phone's own stream broke: replays the turn from
 * its first chunk while the server's registry holds it, calling `onTurn` as it rebuilds, or reads
 * the saved transcript once the registry has let it go. A broken replay or an unreachable server is
 * tried again, `attempts` times in all; an abort rejects.
 */
export async function followTurn(api: Pick<ChatApi, "turnState" | "reattach">, noteId: string, replyId: string,
    onTurn: (turn: AssistantTurn) => void, signal?: AbortSignal, { attempts = 3, waitMs = 2000 } = {}): Promise<FollowedTurn> {
    for (let attempt = 1; ; attempt++) {
        let wait = true;
        try {
            const state = await api.turnState(noteId);
            if (state.replyId !== replyId) {
                return savedOrLost(state.content, replyId);
            }
            let turn: AssistantTurn = { id: replyId, blocks: [], done: false };
            await api.reattach(noteId, 0, (chunk) => {
                turn = applyChunk(turn, chunk);
                onTurn(turn);
            }, signal);
            if (turn.done) {
                return { kind: "finished", turn };
            }
        } catch (e) {
            if (signal?.aborted) {
                throw e;
            }
            if (!(e instanceof NoTurnError || e instanceof StreamBrokenError || e instanceof UnreachableError)) {
                return { kind: "lost" };
            }
            // After a `NoTurnError` the registry has let the turn go, so the next `turnState` reads the saved transcript at once.
            wait = !(e instanceof NoTurnError);
        }
        if (attempt >= attempts) {
            return { kind: "lost" };
        }
        if (wait) {
            await pause(waitMs, signal);
        }
    }
}

/** How a followed turn ended: rebuilt to its end, already in the saved transcript, or gone. */
export type FollowedTurn =
    | { kind: "finished"; turn: AssistantTurn }
    | { kind: "saved"; messages: StoredMessage[] }
    | { kind: "lost" };

/** The saved messages of a chat, without a reply the server saved while its turn was still running. */
export function restoredMessages(content: LlmChatContent | null): StoredMessage[] {
    const messages = (content?.messages ?? []) as CaiusStoredMessage[];
    const partial = new Set(messages.filter((m) => m.partial).map((m) => m.id));
    return messages.filter((m) => !partial.has(m.id) && !(m.type === "thinking" && partial.has(m.id.replace(/-notes$/, ""))));
}

/** A chat to reopen after a pause or a restart: the ritual on screen, or the Ask conversation. */
export interface StoredChat {
    noteId: string;
    kind: ChatKind;
    date: string;
    effort: CaiusEffort;
}

export type ChatSlot = "ritual" | "ask";

export function readStoredChats(): Record<ChatSlot, StoredChat | null> {
    const stored = readLocal<Partial<Record<ChatSlot, StoredChat | null>>>("chats", {});
    return { ritual: stored.ritual ?? null, ask: stored.ask ?? null };
}

/** Stores the chat in `slot`, or clears it with null. */
export function storeChat(slot: ChatSlot, chat: StoredChat | null) {
    writeLocal("chats", { ...readStoredChats(), [slot]: chat });
}

function savedOrLost(content: LlmChatContent | null, replyId: string): FollowedTurn {
    const reply = (content?.messages as CaiusStoredMessage[] | undefined)?.find((m) => m.id === replyId);
    return reply && !reply.partial ? { kind: "saved", messages: restoredMessages(content) } : { kind: "lost" };
}

function pause(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", stop);
            resolve();
        }, ms);
        const stop = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", stop, { once: true });
    });
}
