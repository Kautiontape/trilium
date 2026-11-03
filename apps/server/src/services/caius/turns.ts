import {
    applyChunk,
    type AssistantTurn,
    type CaiusStoredMessage,
    type LlmChatContent,
    type LlmMessage,
    type LlmStreamChunk,
    turnMessages
} from "@triliumnext/commons";
import { becca, cls, getLog, utils } from "@triliumnext/core";
import type { LlmProviderConfig } from "@triliumnext/core/src/services/llm/types.js";

/** The largest transcript written to a chat note, in characters of JSON: 2 MB of text. */
export const MAX_CHAT_CONTENT_LENGTH = 2 * 1024 * 1024;
/** The shortest gap between two saves of a running turn's transcript. */
export const SAVE_INTERVAL_MS = 2000;
/** The longest a turn runs before it is aborted. */
export const MAX_TURN_MS = 15 * 60 * 1000;
/** The most chunks a turn's log holds before the turn is aborted. */
export const MAX_TURN_CHUNKS = 20_000;
/** How long a finished turn stays in the registry for a client to reattach to. */
export const RETAIN_MS = 10 * 60 * 1000;

/** A chat turn the server runs for a chat note, whether or not a client is reading it. */
export interface Turn {
    readonly noteId: string;
    /** The id of the assistant message the reply is stored as. */
    readonly replyId: string;
    /** When the turn started, as the reply's `createdAt`. */
    readonly createdAt: string;
    /** Every chunk `runChat` gave, ending in exactly one `done` or `error` once the turn ends. */
    readonly chunks: readonly LlmStreamChunk[];
    readonly running: boolean;
    /** Resolves once the turn has ended and its final transcript is saved. */
    readonly finished: Promise<void>;
}

export interface TurnStart {
    noteId: string;
    messages: LlmMessage[];
    config: LlmProviderConfig;
    /** The stored messages up to and including the new user message; nothing is saved without. */
    transcript?: CaiusStoredMessage[];
    replyId?: string;
}

export type ChunkListener = (chunk: LlmStreamChunk, index: number) => void;

/**
 * Starts a turn for a chat note and runs it to its end in the background, or returns `"running"`
 * when the note already has a running turn. A finished turn for the note is replaced.
 */
export function startTurn(start: TurnStart): Turn | "running" {
    const { noteId, messages, config, transcript } = start;
    if (registry.get(noteId)?.running) {
        return "running";
    }
    let resolveFinished = () => {};
    const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
    });
    const replyId = start.replyId ?? utils.newEntityId();
    const state: TurnState = {
        noteId,
        replyId,
        createdAt: new Date().toISOString(),
        chunks: [],
        running: true,
        finished,
        resolveFinished,
        assembled: { id: replyId, blocks: [], done: false },
        transcript,
        controller: new AbortController(),
        listeners: new Set(),
        lastSaveAt: 0,
        saveSkipLogged: false
    };
    registry.set(noteId, state);

    save(state, true);
    // The timers in this module never hold the process open.
    state.capTimer = setTimeout(() => end(state, OUT_OF_TIME), MAX_TURN_MS);
    state.capTimer.unref();
    // `runChat` gets a context of its own, so its writes after the request closed (the chat title)
    // never land in the request's.
    cls.init(() => run(state, messages, config)).catch((e: unknown) => {
        getLog().error(`The Caius chat turn for note ${noteId} failed: ${e}`);
        end(state);
    });
    return state;
}

/**
 * The chat note `noteId` names, when it is one the phone app may use and a turn may save to: an
 * unprotected `llmChat` note under `_llmChat`, where the sidebar and `createChatNote` create them.
 */
export function phoneChatNoteOf(noteId: unknown) {
    const note = typeof noteId === "string" ? becca.getNote(noteId) : null;
    return note && note.type === "llmChat" && !note.isProtected && note.hasAncestor("_llmChat")
        ? note
        : null;
}

/** The note's turn, running or finished and still retained. */
export function turnOf(noteId: string): Turn | undefined {
    return registry.get(noteId);
}

/**
 * Replays `turn.chunks` from index `from`, then passes each new chunk to `onChunk` as it comes.
 * `onEnd` runs once, after the terminal chunk and the final save. Returns the unsubscribe function.
 */
export function subscribe(turn: Turn, from: number, onChunk: ChunkListener, onEnd: () => void) {
    const length = turn.chunks.length;
    const start = Number.isFinite(from) ? Math.min(Math.max(Math.trunc(from), 0), length) : 0;
    for (let index = start; index < length; index++) {
        const chunk = turn.chunks[index];
        guarded(() => onChunk(chunk, index));
    }
    const state = registry.get(turn.noteId);
    if (state !== turn || !state.running) {
        guarded(onEnd);
        return () => {};
    }
    const listener: Listener = { onChunk, onEnd };
    state.listeners.add(listener);
    return () => {
        state.listeners.delete(listener);
    };
}

interface Listener {
    onChunk: ChunkListener;
    onEnd: () => void;
}

interface TurnState extends Turn {
    chunks: LlmStreamChunk[];
    running: boolean;
    resolveFinished: () => void;
    assembled: AssistantTurn;
    transcript?: CaiusStoredMessage[];
    controller: AbortController;
    listeners: Set<Listener>;
    lastSaveAt: number;
    saveTimer?: NodeJS.Timeout;
    capTimer?: NodeJS.Timeout;
    saveSkipLogged: boolean;
}

const STOPPED = "The reply stopped before it finished.";
const OUT_OF_TIME = "Caius ran out of time on this reply.";
const TOO_LONG = "The reply grew too long.";

/** Each chat note's latest turn; a turn no longer here has finished. */
const registry = new Map<string, TurnState>();

async function run(state: TurnState, messages: LlmMessage[], config: LlmProviderConfig) {
    // Imported here so the chat pipeline and the provider SDKs stay in lazy chunks.
    const { runChat } = await import("@triliumnext/core/src/services/llm/chat.js");
    for await (const chunk of runChat(messages, config, state.controller.signal)) {
        // After its terminal chunk `runChat` still releases the agent session and names the chat
        // note, so the generator is drained to its end rather than stopped.
        if (!state.running) {
            continue;
        }
        push(state, chunk);
        if (chunk.type === "done" || chunk.type === "error") {
            end(state);
        } else if (state.chunks.length >= MAX_TURN_CHUNKS) {
            end(state, TOO_LONG);
        } else {
            scheduleSave(state);
        }
    }
    end(state);
}

/**
 * Ends the turn once. When the log has no terminal chunk, aborts `runChat` and adds an `error`
 * chunk saying `error`. Then saves the final transcript and calls each listener's `onEnd`.
 */
function end(state: TurnState, error = STOPPED) {
    if (!state.running) {
        return;
    }
    clearTimeout(state.capTimer);
    clearTimeout(state.saveTimer);
    const last = state.chunks[state.chunks.length - 1];
    if (last?.type !== "done" && last?.type !== "error") {
        state.controller.abort();
        push(state, { type: "error", error });
    }
    state.running = false;
    save(state, false);
    for (const listener of state.listeners) {
        guarded(listener.onEnd);
    }
    state.listeners.clear();
    state.resolveFinished();
    const retention = setTimeout(() => {
        if (registry.get(state.noteId) === state) {
            registry.delete(state.noteId);
        }
    }, RETAIN_MS);
    retention.unref();
}

function push(state: TurnState, chunk: LlmStreamChunk) {
    const index = state.chunks.push(chunk) - 1;
    state.assembled = applyChunk(state.assembled, chunk);
    for (const listener of state.listeners) {
        guarded(() => listener.onChunk(chunk, index));
    }
}

/** Saves now when the last save is `SAVE_INTERVAL_MS` old, or else once it is. */
function scheduleSave(state: TurnState) {
    if (!state.transcript || state.saveTimer !== undefined) {
        return;
    }
    const wait = state.lastSaveAt + SAVE_INTERVAL_MS - Date.now();
    if (wait <= 0) {
        save(state, true);
        return;
    }
    state.saveTimer = setTimeout(() => {
        state.saveTimer = undefined;
        if (state.running) {
            save(state, true);
        }
    }, wait);
    state.saveTimer.unref();
}

/**
 * Writes the transcript and the reply so far to the chat note, when `phoneChatNoteOf` still names
 * it and the JSON fits in `MAX_CHAT_CONTENT_LENGTH`.
 */
function save(state: TurnState, partial: boolean) {
    const { transcript, noteId } = state;
    if (!transcript) {
        return;
    }
    state.lastSaveAt = Date.now();
    try {
        cls.init(() => {
            const note = phoneChatNoteOf(noteId);
            if (!note) {
                skipSave(state, "it is no longer an unprotected chat note");
                return;
            }
            const reply = turnMessages(state.assembled, state.createdAt, { partial });
            const content: LlmChatContent = {
                version: 1,
                messages: [ ...transcript, ...reply ],
                enableNoteTools: true,
                enableWebSearch: false
            };
            const json = JSON.stringify(content);
            if (json.length > MAX_CHAT_CONTENT_LENGTH) {
                skipSave(state, "the transcript is too large");
                return;
            }
            note.setContent(json);
        });
    } catch (e) {
        getLog().error(`Could not save the Caius chat turn to note ${noteId}: ${e}`);
    }
}

function skipSave(state: TurnState, reason: string) {
    if (!state.saveSkipLogged) {
        state.saveSkipLogged = true;
        getLog().info(`Not saving the Caius chat turn to note ${state.noteId}: ${reason}.`);
    }
}

/** Runs a listener's callback, so one that throws (a closed response) cannot stop the turn. */
function guarded(callback: () => void) {
    try {
        callback();
    } catch (e) {
        getLog().error(`A Caius chat turn listener failed: ${e}`);
    }
}
