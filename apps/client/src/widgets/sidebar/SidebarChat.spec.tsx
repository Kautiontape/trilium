import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import options from "../../services/options";
import { renderInto } from "../../test/render";
import type { UseLlmChatReturn } from "../type_widgets/llm_chat/useLlmChat.js";

const h = vi.hoisted(() => ({
    getMostRecentLlmChat: vi.fn(),
    createLlmChat: vi.fn(),
    get: vi.fn(async (url: string): Promise<unknown> => (url === "keyboard-actions" ? [] : {})),
    put: vi.fn(async (_url: string, _body: { content: string }) => {}),
    streamChatCompletion: vi.fn(),
    showMessage: vi.fn(),
    chat: null as UseLlmChatReturn | null
}));

vi.mock("../../services/date_notes.js", () => ({
    default: { getMostRecentLlmChat: h.getMostRecentLlmChat, createLlmChat: h.createLlmChat }
}));
vi.mock("../../services/server.js", () => ({ default: { get: h.get, put: h.put } }));
vi.mock("../../services/llm_chat.js", () => ({ streamChatCompletion: h.streamChatCompletion }));
vi.mock("../../services/i18n.js", () => ({ t: (key: string) => key }));
vi.mock("../../services/toast.js", () => ({ default: { showMessage: h.showMessage } }));
vi.mock("../type_widgets/llm_chat/ChatInputBar.js", () => ({
    default: ({ chat }: { chat: UseLlmChatReturn }) => {
        h.chat = chat;
        return <div />;
    }
}));
vi.mock("../type_widgets/llm_chat/ChatMessageList.js", () => ({ default: () => <div /> }));
vi.mock("../type_widgets/llm_chat/chat_context_menu.js", () => ({ useChatContextMenu: () => {} }));
vi.mock("../type_widgets/llm_chat/chat_highlights.js", () => ({ useChatHighlights: () => ({ highlightMenuItems: [] }) }));
vi.mock("../react/Dropdown.js", () => ({ default: ({ children }: { children: ComponentChildren }) => <div>{children}</div> }));
vi.mock("./RightPanelWidget.js", () => ({ default: ({ children }: { children: ComponentChildren }) => <div>{children}</div> }));
vi.mock("../react/hooks.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../react/hooks.js")>()),
    useActiveNoteContext: () => ({ noteId: "day", note: null }),
    useNote: () => null,
    useNoteProperty: () => undefined,
    useNoteLabelBoolean: () => [ false ]
}));

import SidebarChat, { openNewChat, PENDING_OPENER_TTL_MS, START_TIMEOUT_MS, STOP_TIMEOUT_MS } from "./SidebarChat";

const OLD_CHAT = {
    version: 1,
    messages: [ { id: "m1", role: "user", content: "An older question", createdAt: "2026-11-03T10:00:00.000Z" } ],
    enableNoteTools: false
};

/** A stream that runs until it is aborted, then rejects as the real one does. */
function endlessStream(_messages: unknown, _config: unknown, _callbacks: unknown, signal: AbortSignal) {
    return new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
}

describe("openNewChat", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.chat = null;
        options.load({
            llmProviders: JSON.stringify([ {
                id: "p1", name: "Anthropic", provider: "anthropic",
                selectedModels: [ { id: "model-1", name: "Model", isDefault: true } ]
            } ])
        } as Parameters<typeof options.load>[0]);
        h.getMostRecentLlmChat.mockResolvedValue({ noteId: "old" });
        h.get.mockImplementation(async (url: string) => (url === "keyboard-actions" ? [] : { content: JSON.stringify(OLD_CHAT) }));
        h.createLlmChat.mockReset().mockResolvedValue({ noteId: "new" });
        h.streamChatCompletion.mockImplementation(async () => {});
    });

    afterEach(() => vi.useRealTimers());

    it("starts a new conversation with note tools on and sends only the opener, leaving the open chat alone", async () => {
        await mount();
        expect(h.get).toHaveBeenCalledWith("notes/old/blob");

        openNewChat("Plan my day 2026-11-04");
        await flush();

        expect(h.createLlmChat).toHaveBeenCalledTimes(1);
        expect(h.streamChatCompletion).toHaveBeenCalledTimes(1);
        expect(sent(0)).toEqual({
            messages: [ expect.objectContaining({ role: "user", content: "Plan my day 2026-11-04" }) ],
            config: expect.objectContaining({ enableNoteTools: true, chatNoteId: "new", model: "model-1" })
        });
    });

    it("keeps an opener sent before the chat mounts, and starts with it instead of the most recent chat", async () => {
        openNewChat("Wind down 2026-11-03");
        await mount();

        expect(h.getMostRecentLlmChat).not.toHaveBeenCalled();
        expect(sent(0)).toEqual({
            messages: [ expect.objectContaining({ role: "user", content: "Wind down 2026-11-03" }) ],
            config: expect.objectContaining({ enableNoteTools: true, chatNoteId: "new" })
        });
    });

    it("drops an opener that waited too long for the chat to mount", async () => {
        vi.useFakeTimers({ toFake: [ "Date" ] });
        const queuedAt = new Date(2026, 10, 4, 9, 0, 0).getTime();
        vi.setSystemTime(queuedAt);
        openNewChat("Plan my day 2026-11-04");
        vi.setSystemTime(queuedAt + PENDING_OPENER_TTL_MS + 1000);
        await mount();

        expect(h.getMostRecentLlmChat).toHaveBeenCalled();
        expect(h.createLlmChat).not.toHaveBeenCalled();
        expect(h.streamChatCompletion).not.toHaveBeenCalled();
    });

    it("stops a running reply first, then sends the opener into the new chat without the old conversation", async () => {
        await mount();
        h.streamChatCompletion.mockImplementation(endlessStream);
        h.createLlmChat.mockResolvedValueOnce({ noteId: "first" }).mockResolvedValueOnce({ noteId: "second" });
        openNewChat("First");
        await flush();
        expect(sent(0).config).toMatchObject({ chatNoteId: "first" });

        openNewChat("Second");
        await flush();

        expect(h.streamChatCompletion).toHaveBeenCalledTimes(2);
        expect(sent(1)).toEqual({
            messages: [ expect.objectContaining({ role: "user", content: "Second" }) ],
            config: expect.objectContaining({ chatNoteId: "second", enableNoteTools: true })
        });
        await waitForSaves();
        expect(savedTo("second").join()).toContain("Second");
        expect(savedTo("second").join()).not.toContain("First");
    });

    it("says so, and leaves the chat as it is, when the running reply does not stop", async () => {
        await mount();
        // A stream that ignores its abort signal.
        h.streamChatCompletion.mockImplementation(() => new Promise(() => {}));
        h.createLlmChat.mockResolvedValueOnce({ noteId: "first" }).mockResolvedValueOnce({ noteId: "second" });
        openNewChat("First");
        await flush();

        vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout" ] });
        openNewChat("Second");
        await flush();
        expect(h.showMessage).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(STOP_TIMEOUT_MS);
        });
        await flush();

        expect(h.showMessage).toHaveBeenCalledWith("sidebar_chat.opener_still_replying", expect.any(Number), expect.any(String));
        expect(h.createLlmChat).toHaveBeenCalledTimes(1);
        expect(h.streamChatCompletion).toHaveBeenCalledTimes(1);
    });

    it("still loads the most recent chat when an opener fails to create its own during startup", async () => {
        let deliverRecent: (value: unknown) => void = () => {};
        h.getMostRecentLlmChat.mockImplementation(() => new Promise((resolve) => {
            deliverRecent = resolve;
        }));
        h.createLlmChat.mockRejectedValueOnce(new Error("offline"));
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await mount();

        openNewChat("Plan my day 2026-11-04");
        await flush();
        deliverRecent({ noteId: "old" });
        await flush();

        expect(h.get).toHaveBeenCalledWith("notes/old/blob");
        expect(h.chat?.messages).toEqual([ expect.objectContaining({ content: "An older question" }) ]);
        expect(h.streamChatCompletion).not.toHaveBeenCalled();
        error.mockRestore();
    });

    it("keeps an older chat that loads late from overwriting the opener's chat", async () => {
        let deliverBlob: (value: unknown) => void = () => {};
        h.get.mockImplementation((url: string) => (url === "keyboard-actions"
            ? Promise.resolve([])
            : new Promise((resolve) => {
                deliverBlob = resolve;
            })));
        await mount();

        openNewChat("Plan my day 2026-11-04");
        await flush();
        expect(sent(0).config).toMatchObject({ chatNoteId: "new", enableNoteTools: true });

        deliverBlob({ content: JSON.stringify(OLD_CHAT) });
        await flush();
        expect(h.chat?.enableNoteTools).toBe(true);
        await waitForSaves();
        expect(savedTo("new").join()).toContain("Plan my day 2026-11-04");
        expect(savedTo("new").join()).not.toContain("An older question");
    });

    it("says to pick a model, keeping the new chat, when no model resolves, and takes the next start", async () => {
        options.load({ llmProviders: "[]" } as Parameters<typeof options.load>[0]);
        await mount();
        openNewChat("Plan my day 2026-11-04");
        await flush();

        expect(h.createLlmChat).toHaveBeenCalledTimes(1);
        expect(h.streamChatCompletion).not.toHaveBeenCalled();
        expect(h.showMessage).toHaveBeenCalledWith("sidebar_chat.opener_no_model", expect.any(Number), expect.any(String));
        expect(h.chat?.chatNoteId).toBe("new");

        openNewChat("Plan my day 2026-11-04");
        await flush();
        expect(h.createLlmChat).toHaveBeenCalledTimes(2);
    });

    it("takes a new start 10 s after one that never finished, and leaves no timer behind on unmount", async () => {
        const container = await mount();
        vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout" ] });
        h.createLlmChat.mockReturnValueOnce(new Promise(() => {}));
        openNewChat("First");
        await flush();
        openNewChat("Second");
        await flush();
        expect(h.createLlmChat).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(START_TIMEOUT_MS);
        });
        openNewChat("Second");
        await flush();
        expect(h.createLlmChat).toHaveBeenCalledTimes(2);

        h.createLlmChat.mockReturnValueOnce(new Promise(() => {}));
        openNewChat("Third");
        await flush();
        const pending = vi.getTimerCount();
        act(() => render(null, container));
        expect(vi.getTimerCount()).toBe(pending - 1);
    });

    it("keeps a start that succeeds after 10 s from taking over the start that replaced it", async () => {
        await mount();
        vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout" ] });
        h.createLlmChat.mockReturnValueOnce(later(START_TIMEOUT_MS + 2000, { noteId: "first" })).mockResolvedValueOnce({ noteId: "second" });
        openNewChat("First");
        await flush();
        await elapse(START_TIMEOUT_MS);
        openNewChat("Second");
        await flush();
        expect(sent(0)).toMatchObject({ messages: [ expect.objectContaining({ content: "Second" }) ], config: expect.objectContaining({ chatNoteId: "second" }) });

        await elapse(2000);
        expect(h.streamChatCompletion).toHaveBeenCalledTimes(1);
        expect(h.chat?.chatNoteId).toBe("second");
    });

    it("keeps a start that fails after 10 s from freeing the guard of the start in flight", async () => {
        await mount();
        vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout" ] });
        h.createLlmChat.mockReturnValueOnce(later(START_TIMEOUT_MS + 2000, null)).mockReturnValueOnce(new Promise(() => {}));
        openNewChat("First");
        await flush();
        await elapse(START_TIMEOUT_MS);
        openNewChat("Second");
        await flush();
        expect(h.createLlmChat).toHaveBeenCalledTimes(2);

        await elapse(2000);
        openNewChat("Third");
        await flush();
        expect(h.createLlmChat).toHaveBeenCalledTimes(2);
    });

    it("starts one chat for two quick calls", async () => {
        await mount();
        openNewChat("Plan my day 2026-11-04");
        openNewChat("Plan my day 2026-11-04");
        await flush();

        expect(h.createLlmChat).toHaveBeenCalledTimes(1);
        expect(h.streamChatCompletion).toHaveBeenCalledTimes(1);
    });

    it("leaves the typed draft in place and sends none of the open chat's attachments", async () => {
        await mount();
        act(() => {
            h.chat?.setInput("A half-written question");
            h.chat?.addPendingAttachment({ type: "image", attachmentId: "a1", mime: "image/png", title: "shot.png", url: "api/attachments/a1/image/shot.png" });
        });
        await flush();
        expect(h.chat?.pendingAttachments).toHaveLength(1);

        openNewChat("Plan my day 2026-11-04");
        await flush();

        expect(sent(0).messages).toEqual([ expect.objectContaining({ content: "Plan my day 2026-11-04" }) ]);
        expect(h.chat?.getInput()).toBe("A half-written question");
        expect(h.chat?.pendingAttachments).toEqual([]);
    });
});

/** A promise that resolves to `value` after `ms` on the (fake) timers. */
function later<T>(ms: number, value: T) {
    return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}

/** Advances the fake timers by `ms` and lets the renders settle. */
async function elapse(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
    await flush();
}

async function mount() {
    let container: HTMLElement | undefined;
    act(() => {
        container = renderInto(<SidebarChat />);
    });
    await flush();
    if (!container) throw new Error("SidebarChat did not render");
    return container;
}

function sent(call: number) {
    const [ messages, config ] = h.streamChatCompletion.mock.calls[call] as unknown as [ unknown, unknown ];
    return { messages, config };
}

/** The content of each save to the chat note `noteId`. */
function savedTo(noteId: string) {
    return h.put.mock.calls.filter(([ url ]) => url === `notes/${noteId}/data`).map(([ , body ]) => body.content);
}

/** Lets the chat's spaced save (one second) run. */
async function waitForSaves() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1300));
    });
    await flush();
}

async function flush() {
    for (let i = 0; i < 10; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}
