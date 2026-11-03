import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyChunk, type AssistantTurn, type ChatApi, type ChatChunk, type LlmChatContent, NeedsServerUpdateError, NoTurnError, type StoredMessage, StreamBrokenError, TurnRunningError, type TurnState } from "./chat.js";
import { afterStreamError, askedFate, followTurn, readStoredChats, restoredMessages, resync, storeChat } from "./chats.js";
import { HttpError, UnreachableError } from "./http.js";

const AT = "2026-11-04T09:00:00.000Z";

const asked: StoredMessage[] = [
    { id: "u0", role: "user", content: "Wind down 2026-11-04", createdAt: AT },
    { id: "a0", role: "assistant", content: [ { type: "text", content: "Which are done?" } ], createdAt: AT },
    { id: "u1", role: "user", content: "Laundry is done.", createdAt: AT }
];

const finishedReply: StoredMessage[] = [
    { id: "r1-notes", role: "assistant", content: "Laundry goes to done.", createdAt: AT, type: "thinking" },
    { id: "r1", role: "assistant", content: [ { type: "text", content: "Marked it done." } ], createdAt: AT }
];

const partialReply = [
    { id: "r1-notes", role: "assistant", content: "Laundry goes", createdAt: AT, type: "thinking" },
    { id: "r1", role: "assistant", content: [ { type: "text", content: "Mark" } ], createdAt: AT, partial: true }
] as StoredMessage[];

const content = (messages: StoredMessage[]): LlmChatContent => ({ version: 1, messages, enableNoteTools: true, enableWebSearch: false });

describe("restoredMessages", () => {
    it("drops a partial reply and its notes, and keeps a finished one", () => {
        expect(restoredMessages(content([ ...asked, ...partialReply ]))).toEqual(asked);
        expect(restoredMessages(content([ ...asked, ...finishedReply ]))).toEqual([ ...asked, ...finishedReply ]);
        expect(restoredMessages(null)).toEqual([]);
    });
});

describe("afterStreamError", () => {
    it("takes a refusal only from a status the server answered, and follows a broken or detached stream", () => {
        expect(afterStreamError(new HttpError(500, ""))).toBe("refused");
        expect(afterStreamError(new HttpError(429, "{\"error\":\"too_many_turns\"}"))).toBe("refused");
        expect(afterStreamError(new NeedsServerUpdateError())).toBe("refused");
        expect(afterStreamError(new StreamBrokenError())).toBe("follow");
        expect(afterStreamError(new DOMException("Aborted", "AbortError"), true)).toBe("follow");
    });

    it("resyncs when the server might hold the turn or another one runs", () => {
        expect(afterStreamError(new TurnRunningError())).toBe("resync");
        expect(afterStreamError(new UnreachableError("https://caius.example", new TypeError("Failed to fetch")))).toBe("resync");
        expect(afterStreamError(new Error("Something else"))).toBe("resync");
    });
});

describe("resync", () => {
    const api = (state: TurnState) => ({ turnState: vi.fn(async () => state) }) as unknown as ChatApi;

    it("keeps the reply the server saved, so the next transcript starts from it", async () => {
        const local = [ ...asked, { id: "e1", role: "assistant", content: "Lost the connection.", createdAt: AT, type: "error" } ] as StoredMessage[];
        const synced = await resync(api({ content: content([ ...asked, ...finishedReply ]), running: false, replyId: "r1", chunks: 4 }), "n1");
        expect(synced).toEqual({ messages: [ ...asked, ...finishedReply ], replyId: null });
        expect(synced.messages).not.toEqual(local);
    });

    it("drops a reply still being written and names it to follow", async () => {
        const synced = await resync(api({ content: content([ ...asked, ...partialReply ]), running: true, replyId: "r1", chunks: 2 }), "n1");
        expect(synced).toEqual({ messages: asked, replyId: "r1" });
    });

    it("passes on an unreachable server", async () => {
        const unreachable = { turnState: vi.fn(async () => {
            throw new UnreachableError("https://caius.example");
        }) } as unknown as ChatApi;
        await expect(resync(unreachable, "n1")).rejects.toBeInstanceOf(UnreachableError);
    });
});

describe("askedFate", () => {
    it("tells a message the server never got from one it answered, is answering, or dropped", () => {
        const before = asked.slice(0, 2);
        expect(askedFate({ messages: before, replyId: null }, "u1")).toBe("missed");
        expect(askedFate({ messages: [ ...asked, ...finishedReply ], replyId: null }, "u1")).toBe("held");
        expect(askedFate({ messages: asked, replyId: "r1" }, "u1")).toBe("held");
        expect(askedFate({ messages: asked, replyId: null }, "u1")).toBe("unanswered");
    });
});

describe("the stored chats", () => {
    beforeEach(() => {
        const store = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key)
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps a ritual and an Ask chat apart, and clears one without the other", () => {
        expect(readStoredChats()).toEqual({ ritual: null, ask: null });

        const ritual = { noteId: "n1", kind: "winddown", date: "2026-11-04", effort: "low" } as const;
        const ask = { noteId: "n2", kind: "ask", date: "2026-11-04", effort: "high" } as const;
        storeChat("ritual", ritual);
        storeChat("ask", ask);
        expect(readStoredChats()).toEqual({ ritual, ask });

        storeChat("ritual", null);
        expect(readStoredChats()).toEqual({ ritual: null, ask });
    });
});

describe("followTurn", () => {
    const chunks: ChatChunk[] = [
        { type: "thinking", content: "Laundry goes to done." },
        { type: "text", content: "Marked " },
        { type: "text", content: "it done." },
        { type: "done" }
    ];
    const replayed = chunks.reduce<AssistantTurn>((turn, chunk) => applyChunk(turn, chunk), { id: "r1", blocks: [], done: false });
    const state = (over: Partial<TurnState>): TurnState => ({ content: null, running: false, replyId: null, chunks: 0, ...over });

    /** A chat API whose `turnState` answers `states` in order and whose `reattach` runs `attaches` in order. */
    function mockApi(states: TurnState[], attaches: ((onChunk: (chunk: ChatChunk) => void) => Promise<void>)[]) {
        const turnState = vi.fn(async () => {
            const next = states.shift();
            if (!next) {
                throw new Error("No more turn states.");
            }
            return next;
        });
        const reattach = vi.fn(async (_noteId: string, _from: number, onChunk: (chunk: ChatChunk) => void) => {
            const next = attaches.shift();
            if (!next) {
                throw new Error("No more reattaches.");
            }
            await next(onChunk);
        });
        return { api: { turnState, reattach } as unknown as ChatApi, turnState, reattach };
    }

    const replay = (list: ChatChunk[]) => async (onChunk: (chunk: ChatChunk) => void) => {
        for (const chunk of list) {
            onChunk(chunk);
        }
    };

    it("rebuilds a running turn from its replay, showing it as it goes", async () => {
        const { api, reattach } = mockApi([ state({ running: true, replyId: "r1", chunks: 2 }) ], [ replay(chunks) ]);
        const shown: AssistantTurn[] = [];

        const followed = await followTurn(api, "n1", "r1", (turn) => shown.push(turn), undefined, { waitMs: 0 });
        expect(followed).toEqual({ kind: "finished", turn: replayed });
        expect(reattach.mock.calls[0].slice(0, 2)).toEqual([ "n1", 0 ]);
        expect(shown).toHaveLength(chunks.length);
        expect(shown[shown.length - 1]).toEqual(replayed);
    });

    it("takes the saved transcript when the turn ended and left the registry during a pause", async () => {
        const saved = content([ ...asked, ...finishedReply ]);
        const { api, turnState } = mockApi(
            [ state({ running: false, replyId: "r1", content: content([ ...asked, ...partialReply ]) }), state({ content: saved }) ],
            [ async () => {
                throw new NoTurnError();
            } ]
        );

        const followed = await followTurn(api, "n1", "r1", () => {}, undefined, { waitMs: 0 });
        expect(followed).toEqual({ kind: "saved", messages: [ ...asked, ...finishedReply ] });
        expect(turnState).toHaveBeenCalledTimes(2);
    });

    it("never follows another turn, and calls a reply lost when nothing holds it", async () => {
        const other = mockApi([ state({ running: true, replyId: "r2", content: content(asked) }) ], []);
        await expect(followTurn(other.api, "n1", "r1", () => {}, undefined, { waitMs: 0 })).resolves.toEqual({ kind: "lost" });
        expect(other.reattach).not.toHaveBeenCalled();

        const partial = mockApi([ state({ content: content([ ...asked, ...partialReply ]) }) ], []);
        await expect(followTurn(partial.api, "n1", "r1", () => {}, undefined, { waitMs: 0 })).resolves.toEqual({ kind: "lost" });

        const nothing = mockApi([ state({}) ], []);
        await expect(followTurn(nothing.api, "n1", "r1", () => {}, undefined, { waitMs: 0 })).resolves.toEqual({ kind: "lost" });
    });

    it("tries again when the reattach breaks, rebuilding from the start", async () => {
        const running = state({ running: true, replyId: "r1" });
        const { api, reattach } = mockApi([ running, running ], [
            async (onChunk) => {
                await replay(chunks.slice(0, 2))(onChunk);
                throw new StreamBrokenError();
            },
            replay(chunks)
        ]);

        const followed = await followTurn(api, "n1", "r1", () => {}, undefined, { waitMs: 0 });
        expect(followed).toEqual({ kind: "finished", turn: replayed });
        expect(reattach).toHaveBeenCalledTimes(2);
    });

    it("gives up after its attempts, and stops on an abort", async () => {
        const running = state({ running: true, replyId: "r1" });
        const broken = async () => {
            throw new StreamBrokenError();
        };
        const { api, reattach } = mockApi([ running, running, running ], [ broken, broken, broken ]);
        await expect(followTurn(api, "n1", "r1", () => {}, undefined, { waitMs: 0 })).resolves.toEqual({ kind: "lost" });
        expect(reattach).toHaveBeenCalledTimes(3);

        const abort = new AbortController();
        const aborted = mockApi([ running ], [ async () => {
            abort.abort();
            throw new DOMException("Aborted", "AbortError");
        } ]);
        await expect(followTurn(aborted.api, "n1", "r1", () => {}, abort.signal, { waitMs: 0 })).rejects.toThrow("Aborted");
    });
});
