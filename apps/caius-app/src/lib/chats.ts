import type { CaiusEffort } from "@triliumnext/commons/src/lib/caius_openers.js";
import type { CaiusStoredMessage } from "@triliumnext/commons/src/lib/caius_turn.js";

import { applyChunk, type AssistantTurn, type ChatApi, type ChatKind, type LlmChatContent, NeedsServerUpdateError, NoTurnError, type StoredMessage, StreamBrokenError } from "./chat.js";
import { HttpError, UnreachableError } from "./http.js";
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

/**
 * What a turn does after `stream` throws, or after a resume detached it (`detached`):
 * - `"follow"`: the server took the turn, so the phone follows it (a broken body, a detach).
 * - `"refused"`: the server answered a status that refuses the turn (`HttpError`, including 429,
 *   or `NeedsServerUpdateError`), so the phone keeps the error and saves the transcript itself.
 * - `"resync"`: the server might hold the turn or be writing another one (`TurnRunningError`,
 *   `UnreachableError`, anything else), so the phone reads the chat back with `resync` before it
 *   saves or sends anything.
 */
export function afterStreamError(error: unknown, detached = false): "follow" | "refused" | "resync" {
    if (detached || error instanceof StreamBrokenError) {
        return "follow";
    }
    if (error instanceof HttpError || error instanceof NeedsServerUpdateError) {
        return "refused";
    }
    return "resync";
}

/**
 * The chat as the server saved it, for a phone whose transcript might have drifted from it: the
 * restored messages, and the reply still being written while a turn runs. Rejects as `turnState` does.
 */
export async function resync(api: Pick<ChatApi, "turnState">, noteId: string): Promise<SyncedChat> {
    const state = await api.turnState(noteId);
    return { messages: restoredMessages(state.content), replyId: state.running ? state.replyId : null };
}

export interface SyncedChat {
    messages: StoredMessage[];
    /** The reply a running turn writes, to follow; null when no turn runs. */
    replyId: string | null;
}

/**
 * What the server made of the message `askedId`, sent before the phone's transcript drifted:
 * `"missed"` when the server never got it, `"unanswered"` when it is the last saved message and no
 * turn runs (the turn ended without a reply, as on a server restart), and `"held"` otherwise.
 */
export function askedFate(synced: SyncedChat, askedId: string): "held" | "missed" | "unanswered" {
    const index = synced.messages.findIndex((m) => m.id === askedId);
    if (index < 0) {
        return "missed";
    }
    return !synced.replyId && index === synced.messages.length - 1 ? "unanswered" : "held";
}

/**
 * What a message sent on a stale chat does once `catchUp` has read the chat back (`caught`, null
 * while the server can't be read): `"send"` once the chat is in step with the server and holds every
 * earlier message, `"with-missed"` when an earlier message's words came back to the box, so the new
 * words join them there, and `"back"` while the chat is still stale.
 */
export function staleSendAction(caught: { stale: boolean; missed: boolean } | null): "send" | "with-missed" | "back" {
    if (caught?.missed) {
        return "with-missed";
    }
    return !caught || caught.stale ? "back" : "send";
}

/** The box once words come back to it: `typed` since, then each of `words`, blank ones skipped, a blank line apart. */
export function putBackInto(typed: string, ...words: string[]): string {
    return [ typed.trimEnd(), ...words ].filter((part) => part.trim()).join("\n\n");
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

/** A reply typed into a chat notification, for the chat in `slot`; `noteId` is the stored chat it was meant for. */
export interface PendingReply {
    slot: ChatSlot;
    noteId: string | null;
    text: string;
}

/**
 * What the chat in `slot` does with a queued notification reply: `"send"` once it is ready on the
 * note the reply was meant for; `"draft"`, into the box, once it settles on another note, on none,
 * or after a reopen that failed; `"wait"` while a turn runs, before its day is known, or for a
 * reply to the other slot.
 */
export function pendingReplyAction(queued: PendingReply | null,
    chat: { slot: ChatSlot; date: string; noteId: string | null; busy: boolean; ready: boolean }): "wait" | "send" | "draft" {
    if (queued?.slot !== chat.slot || !chat.date || chat.busy) {
        return "wait";
    }
    return chat.ready && queued.noteId !== null && queued.noteId === chat.noteId ? "send" : "draft";
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
