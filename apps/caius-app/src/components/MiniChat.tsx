import "./mini-chat.css";

import type { JSX } from "preact";
import { useRef } from "preact/hooks";

import { CHAT_TITLES, type ChatActivity, chatActivity, restoreRitual, ritual, settingsOpen, tab } from "../app-state.js";
import { Icon } from "./ui.js";

/**
 * The mini bar above the bottom tabs: the minimized ritual, or Ask from another tab while Caius
 * works on it or has a reply not yet seen. It shows whether Caius is working and his latest line;
 * a tap opens the chat again.
 */
export function MiniChat() {
    const open = ritual.value;
    if (settingsOpen.value || (open && !open.minimized)) {
        return null;
    }
    const ask = chatActivity.value.ask;
    let title: string;
    let activity: ChatActivity | undefined;
    let reopen: () => void;
    if (open) {
        title = CHAT_TITLES[open.kind];
        activity = chatActivity.value.ritual;
        reopen = restoreRitual;
    } else if (tab.value !== "ask" && ask && (ask.working || ask.unseen)) {
        title = ask.title;
        activity = ask;
        reopen = () => {
            tab.value = "ask";
        };
    } else {
        return null;
    }

    const working = !!activity?.working;
    return (
        <button type="button" class={`mini-chat${working ? " working" : ""}${activity?.unseen ? " unseen" : ""}`} onClick={() => reopen()}>
            <span class="mini-chat-dot" aria-hidden="true" />
            <span class="mini-chat-text">
                <span class="mini-chat-title">
                    <strong>{title}</strong>
                    {activity && <span class="ink-2"> · {working ? "Working" : "Replied"}</span>}
                </span>
                {activity?.line && <span class="mini-chat-line ink-2">{activity.line}</span>}
            </span>
            <span class="mini-chat-open"><Icon name="keyboard_arrow_down" size={20} /></span>
        </button>
    );
}

/**
 * Pointer handlers that call `onSwipe` once a drag goes `distance` px down. The pointer is captured
 * only once it moves, so a tap on a button inside still lands on that button.
 */
export function useSwipeDown(onSwipe: () => void, distance = 60) {
    const from = useRef<number | null>(null);
    const end = () => {
        from.current = null;
    };
    return {
        onPointerDown: (e: JSX.TargetedPointerEvent<HTMLElement>) => {
            from.current = e.clientY;
        },
        onPointerMove: (e: JSX.TargetedPointerEvent<HTMLElement>) => {
            if (from.current === null) {
                return;
            }
            const dy = e.clientY - from.current;
            if (dy > distance) {
                end();
                onSwipe();
            } else if (dy > 8 && !e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.setPointerCapture(e.pointerId);
            }
        },
        onPointerUp: end,
        onPointerCancel: end
    };
}
