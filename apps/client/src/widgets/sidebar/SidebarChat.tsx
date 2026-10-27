import "./SidebarChat.css";

import type { SaveLlmChatResponse } from "@triliumnext/commons";
import type { Dropdown as BootstrapDropdown } from "bootstrap";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import appContext from "../../components/app_context.js";
import dateNoteService, { type RecentLlmChat } from "../../services/date_notes.js";
import dialog from "../../services/dialog.js";
import { t } from "../../services/i18n.js";
import { resolveSelectedModel } from "../../services/llm_providers.js";
import server from "../../services/server.js";
import toast from "../../services/toast.js";
import { randomString } from "../../services/utils.js";
import ws from "../../services/ws.js";
import { formatDateTime } from "../../utils/formatters";
import ActionButton from "../react/ActionButton.js";
import Dropdown from "../react/Dropdown.js";
import { FormDropdownDivider, FormListItem } from "../react/FormList.js";
import { useActiveNoteContext, useNote, useNoteLabelBoolean, useNoteProperty, useSpacedUpdate } from "../react/hooks.js";
import { useChatContextMenu } from "../type_widgets/llm_chat/chat_context_menu.js";
import { useChatHighlights } from "../type_widgets/llm_chat/chat_highlights.js";
import ChatInputBar from "../type_widgets/llm_chat/ChatInputBar.js";
import ChatMessageList from "../type_widgets/llm_chat/ChatMessageList.js";
import ChatReadOnlyNotice from "../type_widgets/llm_chat/ChatReadOnlyNotice.js";
import type { LlmChatContent } from "../type_widgets/llm_chat/llm_chat_types.js";
import { useLlmChat } from "../type_widgets/llm_chat/useLlmChat.js";
import RightPanelWidget from "./RightPanelWidget.js";

/**
 * Sidebar chat widget that appears in the right panel.
 * Uses a hidden LLM chat note for persistence across all notes.
 * The same chat persists when switching between notes.
 *
 * Unlike the LlmChat type widget which receives a valid FNote from the
 * framework, the sidebar creates notes lazily. We use useSpacedUpdate with
 * a direct server.put (using the string noteId) instead of useEditorSpacedUpdate
 * (which requires an FNote and silently no-ops when it's null).
 */
export default function SidebarChat() {
    const [chatNoteId, setChatNoteId] = useState<string | null>(null);
    const [recentChats, setRecentChats] = useState<RecentLlmChat[]>([]);
    const historyDropdownRef = useRef<BootstrapDropdown | null>(null);

    // Get the current active note context
    const { noteId: activeNoteId, note: activeNote } = useActiveNoteContext();

    // Reactively watch the chat note's title (updates via WebSocket sync after auto-rename)
    const chatNote = useNote(chatNoteId);
    const chatTitle = useNoteProperty(chatNote, "title") || t("sidebar_chat.title");

    // A `#readOnly` chat is immutable: reply bar replaced by a notice, mutating commands suppressed.
    const [readOnly] = useNoteLabelBoolean(chatNote, "readOnly");

    // Refs for stable access in the spaced update callback
    const chatNoteIdRef = useRef(chatNoteId);
    chatNoteIdRef.current = chatNoteId;

    // Use shared chat hook with sidebar-specific options
    const chat = useLlmChat(
        // onMessagesChange - trigger save
        () => spacedUpdate.scheduleUpdate(),
        { defaultEnableNoteTools: true, supportsExtendedThinking: true }
    );

    const chatRef = useRef(chat);
    chatRef.current = chat;

    // Enable highlighting (painting + right-click add/remove) in the sidebar chat. No note context is
    // passed: the sidebar chat is itself the right pane, so there's no slot for the highlights list —
    // the highlights live in the messages only. Save-to-sub-note is likewise unavailable (no parent).
    const highlights = useChatHighlights(chat, undefined);

    // Right-click menu over the timeline, with highlights contributing their add/remove items.
    useChatContextMenu({ chat, noteContext: undefined, contextMenuItems: highlights.highlightMenuItems, readOnly });

    // Save directly via server.put using the string noteId.
    // This avoids the FNote dependency that useEditorSpacedUpdate requires.
    const spacedUpdate = useSpacedUpdate(async () => {
        const noteId = chatNoteIdRef.current;
        if (!noteId) return;

        const content = chatRef.current.getContent();
        try {
            await server.put(`notes/${noteId}/data`, {
                content: JSON.stringify(content)
            });
        } catch (err) {
            console.error("Failed to save chat:", err);
        }
    });

    // Update chat context when active note changes
    useEffect(() => {
        chat.setContextNoteId(activeNoteId ?? undefined);
    }, [activeNoteId, chat.setContextNoteId]);

    // Sync chatNoteId into the hook for auto-title generation
    useEffect(() => {
        chat.setChatNoteId(chatNoteId ?? undefined);
    }, [chatNoteId, chat.setChatNoteId]);

    // A conversation started from elsewhere (see openNewChat): its opener, sent once the new chat
    // renders empty with note tools on, since `handleSubmit` reads both from the render it belongs to.
    const [opener, setOpener] = useState<string | null>(null);
    const openerStartedRef = useRef(false);
    // A start in flight, from openNewChat until its opener is sent; a second call meanwhile is ignored.
    // `endStart` ends it, and so does a timer after START_TIMEOUT_MS, so a start that never finishes
    // can't block the next one.
    const startingRef = useRef(false);
    const startTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const endStart = useCallback(() => {
        startingRef.current = false;
        clearTimeout(startTimerRef.current);
        startTimerRef.current = undefined;
    }, []);
    const mountOpenerRef = useRef<string | null>(null);

    // Load the most recent chat on mount (runs once), unless an opener is waiting to start a new one.
    useEffect(() => {
        let cancelled = false;
        mountOpenerRef.current = takePendingOpener();
        if (mountOpenerRef.current !== null) return;

        const loadMostRecentChat = async () => {
            try {
                const existingChat = await dateNoteService.getMostRecentLlmChat();

                if (cancelled || openerStartedRef.current) return;

                if (existingChat) {
                    setChatNoteId(existingChat.noteId);
                    // Load content
                    try {
                        const blob = await server.get<{ content: string }>(`notes/${existingChat.noteId}/blob`);
                        if (cancelled || openerStartedRef.current) return;
                        if (blob?.content) {
                            const parsed: LlmChatContent = JSON.parse(blob.content);
                            chatRef.current.loadFromContent(parsed);
                        }
                    } catch (err) {
                        console.error("Failed to load chat content:", err);
                    }
                } else {
                    setChatNoteId(null);
                    chatRef.current.clearMessages();
                }
            } catch (err) {
                console.error("Failed to load sidebar chat:", err);
            }
        };

        loadMostRecentChat();

        return () => {
            cancelled = true;
        };
    }, []);

    // Custom submit handler that ensures chat note exists first
    const handleSubmit = useCallback(async (e: Event) => {
        e.preventDefault();
        if ((!chat.hasInputText && chat.pendingAttachments.length === 0) || chat.isStreaming) return;

        // Snapshot the draft before any await: as soon as this handler suspends, the input
        // bar clears the editor, which zeroes the live draft ref the delegated
        // chat.handleSubmit below reads.
        const draft = chat.getInput();

        // Ensure chat note exists before sending (lazy creation)
        let noteId = chatNoteId;
        if (!noteId) {
            try {
                const note = await dateNoteService.getOrCreateLlmChat();
                if (note) {
                    setChatNoteId(note.noteId);
                    noteId = note.noteId;
                }
            } catch (err) {
                console.error("Failed to create sidebar chat:", err);
                return;
            }
        }

        if (!noteId) {
            console.error("Cannot send message: no chat note available");
            return;
        }

        // Ensure the hook has the chatNoteId before submitting (state update from
        // setChatNoteId above won't be visible until next render)
        chat.setChatNoteId(noteId);

        // Restore the draft (the editor clear wiped it during the awaits above), then
        // delegate to the shared handler.
        chat.setInput(draft);
        await chat.handleSubmit(e);
    }, [chatNoteId, chat]);

    const handleNewChat = useCallback(async () => {
        // Save any pending changes before switching
        await spacedUpdate.updateNowIfNecessary();

        try {
            const note = await dateNoteService.createLlmChat();
            if (note) {
                setChatNoteId(note.noteId);
                chatRef.current.clearMessages();
            }
        } catch (err) {
            console.error("Failed to create new chat:", err);
        }
    }, [spacedUpdate]);

    // Resolves the waits of startWithOpener once a render shows no reply streaming.
    const idleWaitersRef = useRef<(() => void)[]>([]);
    useEffect(() => {
        if (!chat.isStreaming) {
            for (const resolve of idleWaitersRef.current.splice(0)) resolve();
        }
    }, [chat.isStreaming]);

    const startWithOpener = useCallback(async (text: string) => {
        if (startingRef.current) return;
        startingRef.current = true;
        startTimerRef.current = setTimeout(endStart, START_TIMEOUT_MS);

        try {
            // A reply still streaming would land in the new chat, and the opener could not be sent.
            if (chatRef.current.isStreaming) {
                chatRef.current.stopStreaming();
                if (!(await untilIdle(idleWaitersRef.current))) {
                    toast.showMessage(t("sidebar_chat.opener_still_replying"), 5000, "bx bx-bot");
                    endStart();
                    return;
                }
            }
            await spacedUpdate.updateNowIfNecessary();

            const note = await dateNoteService.createLlmChat();
            if (!note) {
                endStart();
                return;
            }
            const current = chatRef.current;
            // Set only now, so a failed start leaves the startup load of the most recent chat alone.
            openerStartedRef.current = true;
            setChatNoteId(note.noteId);
            current.clearMessages();
            current.setEnableNoteTools(true);
            for (const attachment of current.pendingAttachments) {
                current.removePendingAttachment(attachment.attachmentId);
            }
            setOpener(text);
        } catch (err) {
            endStart();
            console.error("Failed to create new chat:", err);
        }
    }, [spacedUpdate, endStart]);
    const startWithOpenerRef = useRef(startWithOpener);
    startWithOpenerRef.current = startWithOpener;

    useEffect(() => {
        takeOpener = (text) => void startWithOpenerRef.current(text);
        if (mountOpenerRef.current !== null) {
            takeOpener(mountOpenerRef.current);
            mountOpenerRef.current = null;
        }
        return () => {
            takeOpener = null;
            endStart();
        };
    }, [endStart]);

    useEffect(() => {
        if (opener === null || !chatNoteId || chat.isStreaming || chat.messages.length > 0 || !chat.enableNoteTools || chat.isCheckingProvider) return;
        setOpener(null);
        endStart();
        // `handleSubmit` sends nothing without a model, which would drop the opener without a word.
        if (!resolveSelectedModel(chat.availableModels, chat.selectedModel, chat.selectedProvider, chat.selectedProviderId)) {
            toast.showMessage(t("sidebar_chat.opener_no_model"), 5000, "bx bx-bot");
            return;
        }
        // `handleSubmit` sends the input; the draft in the input bar is put back once it has read it.
        const draft = chat.getInput();
        chat.setChatNoteId(chatNoteId);
        chat.setInput(opener);
        void chat.handleSubmit(new Event("submit"));
        chat.setInput(draft);
    }, [opener, chatNoteId, chat, endStart]);

    const handleSaveChat = useCallback(async () => {
        if (!chatNoteId) return;

        // Save any pending changes before moving the chat
        await spacedUpdate.updateNowIfNecessary();

        try {
            const { notePath } = await server.post<SaveLlmChatResponse>("special-notes/save-llm-chat", { llmChatNoteId: chatNoteId });
            // Create a new empty chat after saving so the sidebar starts fresh.
            const note = await dateNoteService.createLlmChat();
            if (note) {
                setChatNoteId(note.noteId);
                chatRef.current.clearMessages();
            }
            // Open the saved note in a new tab so the user can view and reorganize it. Wait for the
            // clone's entity changes to reach froca first, otherwise the new note path can't resolve.
            if (notePath) {
                await ws.waitForMaxKnownEntityChangeId();
                await appContext.tabManager.openTabWithNoteWithHoisting(notePath, { activate: true });
            }
        } catch (err) {
            console.error("Failed to save chat to permanent location:", err);
        }
    }, [chatNoteId, spacedUpdate]);

    const loadRecentChats = useCallback(async () => {
        try {
            const chats = await dateNoteService.getRecentLlmChats(10);
            setRecentChats(chats);
        } catch (err) {
            console.error("Failed to load recent chats:", err);
        }
    }, []);

    const handleViewAllChats = useCallback(() => {
        historyDropdownRef.current?.hide();
        appContext.tabManager.openInNewTab("_llmChat", "_llmChat", true);
    }, []);

    const handleSelectChat = useCallback(async (noteId: string) => {
        historyDropdownRef.current?.hide();

        if (noteId === chatNoteId) return;

        // Save any pending changes before switching
        await spacedUpdate.updateNowIfNecessary();

        // Load the selected chat's content
        try {
            const blob = await server.get<{ content: string }>(`notes/${noteId}/blob`);
            if (blob?.content) {
                const parsed: LlmChatContent = JSON.parse(blob.content);
                setChatNoteId(noteId);
                chatRef.current.loadFromContent(parsed);
            }
        } catch (err) {
            console.error("Failed to load selected chat:", err);
        }
    }, [chatNoteId, spacedUpdate]);

    const handleDeleteChat = useCallback(async (noteId: string) => {
        if (!(await dialog.confirm(t("sidebar_chat.delete_confirm")))) return;

        try {
            // Same soft-delete the tree uses (see branches.deleteNotes), minus the delete-notes dialog.
            await server.remove(`notes/${noteId}?taskId=${randomString(10)}&eraseNotes=false&last=true`);
            setRecentChats(prev => prev.filter(c => c.noteId !== noteId));

            // If the open chat was the one deleted, reset the sidebar to a blank state. Don't create a
            // replacement note here — the sidebar lazily creates one on the first message (handleSubmit),
            // so creating one now would leave an empty, timestamp-titled chat cluttering the history.
            // Null the ref too so the clearMessages save below can't write back to the deleted note.
            if (noteId === chatNoteId) {
                setChatNoteId(null);
                chatNoteIdRef.current = null;
                chatRef.current.clearMessages();
            }
        } catch (err) {
            console.error("Failed to delete chat:", err);
        }
    }, [chatNoteId]);

    const handleRenameChat = useCallback(async () => {
        if (!chatNoteId) return;

        const newTitle = await dialog.prompt({
            title: t("sidebar_chat.rename_title"),
            message: t("sidebar_chat.rename_message"),
            defaultValue: chatNote?.title ?? ""
        });
        // null = cancelled; ignore empty or unchanged names.
        const trimmed = newTitle?.trim();
        if (!trimmed || trimmed === chatNote?.title) return;

        try {
            // The header title updates reactively once the change syncs back to froca.
            await server.put(`notes/${chatNoteId}/title`, { title: trimmed });
        } catch (err) {
            console.error("Failed to rename chat:", err);
        }
    }, [chatNoteId, chatNote]);

    return (
        <RightPanelWidget
            id="sidebar-chat"
            title={chatTitle}
            grow
            // Keep the chat mounted when collapsed: it holds live conversation state and its context-menu /
            // highlight / scroll listeners are wired in this (always-mounted) component, so unmounting the
            // body on collapse would orphan them and they wouldn't re-attach on expand.
            keepMounted
            buttons={
                <>
                    <ActionButton
                        icon="bx bx-plus"
                        text={t("sidebar_chat.new_chat")}
                        onClick={handleNewChat}
                    />
                    <Dropdown
                        text=""
                        buttonClassName="bx bx-history"
                        title={t("sidebar_chat.history")}
                        iconAction
                        hideToggleArrow
                        dropdownContainerClassName="tn-dropdown-menu-scrollable"
                        dropdownOptions={{ popperConfig: { strategy: "fixed" } }}
                        // In peek mode #right-pane has a backdrop-filter, which becomes the containing
                        // block for the fixed-positioned menu and offsets it — portal to body to escape it.
                        portalToBody
                        dropdownRef={historyDropdownRef}
                        onShown={loadRecentChats}
                    >
                        {recentChats.length === 0 ? (
                            <FormListItem disabled>
                                {t("sidebar_chat.no_chats")}
                            </FormListItem>
                        ) : (
                            recentChats.map(chatItem => (
                                <FormListItem
                                    key={chatItem.noteId}
                                    icon="bx bx-message-square-dots"
                                    className={`sidebar-chat-history-item ${chatItem.noteId === chatNoteId ? "active" : ""}`}
                                    onClick={() => handleSelectChat(chatItem.noteId)}
                                >
                                    <div className="sidebar-chat-history-item-content">
                                        {chatItem.noteId === chatNoteId
                                            ? <strong>{chatItem.title}</strong>
                                            : <span>{chatItem.title}</span>}
                                        <span className="sidebar-chat-history-date">
                                            {formatDateTime(new Date(chatItem.dateModified), "short", "short")}
                                        </span>
                                    </div>
                                    <ActionButton
                                        icon="bx bx-trash"
                                        text={t("sidebar_chat.delete_chat")}
                                        className="sidebar-chat-history-delete"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void handleDeleteChat(chatItem.noteId);
                                        }}
                                    />
                                </FormListItem>
                            ))
                        )}
                        <FormDropdownDivider />
                        <FormListItem
                            icon="bx bx-folder-open"
                            onClick={handleViewAllChats}
                        >
                            {t("sidebar_chat.view_all_chats")}
                        </FormListItem>
                    </Dropdown>
                    <Dropdown
                        text=""
                        buttonClassName="bx bx-dots-vertical-rounded"
                        title={t("sidebar_chat.more_actions")}
                        iconAction
                        hideToggleArrow
                        dropdownOptions={{ popperConfig: { strategy: "fixed" } }}
                        // See the history dropdown above: portal to body so peek mode's backdrop-filter
                        // containing block doesn't offset the fixed menu.
                        portalToBody
                    >
                        <FormListItem
                            icon="bx bx-save"
                            onClick={() => void handleSaveChat()}
                            disabled={chat.messages.length === 0}
                        >
                            {t("sidebar_chat.save_chat")}
                        </FormListItem>
                        <FormListItem
                            icon="bx bx-edit-alt"
                            onClick={() => void handleRenameChat()}
                            disabled={!chatNoteId}
                        >
                            {t("sidebar_chat.rename")}
                        </FormListItem>
                        <FormDropdownDivider />
                        <FormListItem
                            icon="bx bx-trash"
                            onClick={() => { if (chatNoteId) void handleDeleteChat(chatNoteId); }}
                            disabled={!chatNoteId}
                        >
                            {t("sidebar_chat.delete")}
                        </FormListItem>
                    </Dropdown>
                </>
            }
        >
            <div className="sidebar-chat-container">
                <ChatMessageList
                    chat={chat}
                    className="sidebar-chat-messages"
                    emptyStateText={t("sidebar_chat.empty_state")}
                />
                {readOnly ? (
                    <ChatReadOnlyNotice />
                ) : (
                    <ChatInputBar
                        chat={chat}
                        activeNoteId={activeNoteId ?? undefined}
                        activeNoteTitle={activeNote?.title}
                        onSubmit={handleSubmit}
                        inSidebar
                    />
                )}
            </div>
        </RightPanelWidget>
    );
}

/** How long an opener sent before the chat mounted stays good; an older one is dropped. */
export const PENDING_OPENER_TTL_MS = 10_000;

/** How long a new chat waits for a running reply to stop before giving up. */
export const STOP_TIMEOUT_MS = 5000;

/** How long a start can stay in flight before the next one is taken anyway. */
export const START_TIMEOUT_MS = 10_000;

/** An opener sent before the chat mounted, and the mounted chat's handler for one. */
let pendingOpener: { text: string; at: number } | null = null;
let takeOpener: ((text: string) => void) | null = null;

/**
 * Starts a new conversation in the sidebar chat, with note tools on, and sends `text` as its first
 * message. The chat mounts when its tab is first shown, so a call made before then waits for it.
 */
export function openNewChat(text: string) {
    if (takeOpener) {
        takeOpener(text);
    } else {
        pendingOpener = { text, at: Date.now() };
    }
}

/** Takes the opener sent before mount, unless it is older than {@link PENDING_OPENER_TTL_MS}. */
function takePendingOpener() {
    const pending = pendingOpener;
    pendingOpener = null;
    return pending && Date.now() - pending.at <= PENDING_OPENER_TTL_MS ? pending.text : null;
}

/** Waits for the chat's next render without a streaming reply; `false` after {@link STOP_TIMEOUT_MS}. */
function untilIdle(waiters: (() => void)[]) {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        waiters.push(() => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}
