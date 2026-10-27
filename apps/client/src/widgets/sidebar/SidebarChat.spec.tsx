import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import options from "../../services/options";
import { renderInto } from "../../test/render";

const h = vi.hoisted(() => ({
    getMostRecentLlmChat: vi.fn(),
    createLlmChat: vi.fn(),
    get: vi.fn(async (url: string): Promise<unknown> => (url === "keyboard-actions" ? [] : {})),
    put: vi.fn(async () => {}),
    streamChatCompletion: vi.fn(async () => {})
}));

vi.mock("../../services/date_notes.js", () => ({
    default: { getMostRecentLlmChat: h.getMostRecentLlmChat, createLlmChat: h.createLlmChat }
}));
vi.mock("../../services/server.js", () => ({ default: { get: h.get, put: h.put } }));
vi.mock("../../services/llm_chat.js", () => ({ streamChatCompletion: h.streamChatCompletion }));
vi.mock("../../services/i18n.js", () => ({ t: (key: string) => key }));
vi.mock("../type_widgets/llm_chat/ChatInputBar.js", () => ({ default: () => <div /> }));
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

import SidebarChat, { openNewChat } from "./SidebarChat";

const OLD_CHAT = {
    version: 1,
    messages: [ { id: "m1", role: "user", content: "An older question", createdAt: "2026-11-03T10:00:00.000Z" } ],
    enableNoteTools: false
};

describe("openNewChat", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        options.load({
            llmProviders: JSON.stringify([ {
                id: "p1", name: "Anthropic", provider: "anthropic",
                selectedModels: [ { id: "model-1", name: "Model", isDefault: true } ]
            } ])
        } as Parameters<typeof options.load>[0]);
        h.getMostRecentLlmChat.mockResolvedValue({ noteId: "old" });
        h.get.mockResolvedValue({ content: JSON.stringify(OLD_CHAT) });
        h.createLlmChat.mockResolvedValue({ noteId: "new" });
    });

    it("starts a new conversation with note tools on and sends only the opener, leaving the open chat alone", async () => {
        act(() => {
            renderInto(<SidebarChat />);
        });
        await flush();
        expect(h.get).toHaveBeenCalledWith("notes/old/blob");

        openNewChat("Plan my day 2026-11-04");
        await flush();

        expect(h.createLlmChat).toHaveBeenCalledTimes(1);
        expect(h.streamChatCompletion).toHaveBeenCalledTimes(1);
        expect(sent()).toEqual({
            messages: [ expect.objectContaining({ role: "user", content: "Plan my day 2026-11-04" }) ],
            config: expect.objectContaining({ enableNoteTools: true, chatNoteId: "new", model: "model-1" })
        });
    });

    it("keeps an opener sent before the chat mounts, and starts with it instead of the most recent chat", async () => {
        openNewChat("Wind down 2026-11-03");
        act(() => {
            renderInto(<SidebarChat />);
        });
        await flush();

        expect(h.getMostRecentLlmChat).not.toHaveBeenCalled();
        expect(sent()).toEqual({
            messages: [ expect.objectContaining({ role: "user", content: "Wind down 2026-11-03" }) ],
            config: expect.objectContaining({ enableNoteTools: true, chatNoteId: "new" })
        });
    });
});

function sent() {
    const [ messages, config ] = h.streamChatCompletion.mock.calls[0] as unknown as [ unknown, unknown ];
    return { messages, config };
}

async function flush() {
    for (let i = 0; i < 10; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}
