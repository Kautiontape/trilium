import "./chat.css";

import { KeepAwake } from "@capacitor-community/keep-awake";
import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import type { Area } from "@triliumnext/caius/src/trilium/areas.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { addReminder } from "../components/sheets.js";
import { displayText } from "../components/TaskRow.js";
import { Button, Chip, closeSheet, haptic, Icon, openSheet, SheetAction, SheetTitle } from "../components/ui.js";
import { CAIUS_EFFORTS, type CaiusEffort } from "@triliumnext/commons/src/lib/caius_openers.js";
import { ritual } from "../app-state.js";
import { applyChunk, type AssistantTurn, chatApi, type ChatKind, type ContentBlock, historyForServer, type LlmChatContent, NeedsServerUpdateError, opener, type RitualStep, stepHasBody, stepOf, type StoredMessage, turnText } from "../lib/chat.js";
import { dayLabel } from "../lib/day.js";
import { appVersion, shareText } from "../lib/share.js";
import { chatTranscript } from "../lib/transcript.js";
import { type ProseBlock, proseBlocks, type Span } from "../lib/prose.js";
import { parseRemindMe, whenLabel } from "../lib/remind.js";
import { type CandidateAnswer, type CandidateData, candidateDefault, chipLabel, type Choice, type ContextAnswer, type StepAnswers, type StepFate, stepPicks, stepReply, type UnmarkedData } from "../lib/replies.js";
import { appNow, connection, messageOf, refreshToday, revision, serverStatus, settings, snack, today } from "../lib/store.js";

/** A ritual, full screen: Plan my day on a clay wash, Wind down on dusk. The screen stays awake while it runs. */
export function Ritual({ kind, date }: { kind: "plan" | "winddown"; date: string }) {
    const chat = useChat(kind, date);
    useEffect(() => {
        KeepAwake.keepAwake().catch(() => undefined);
        return () => {
            KeepAwake.allowSleep().catch(() => undefined);
        };
    }, []);
    useEffect(() => {
        if (chat.state === "idle") {
            void chat.start();
        }
    }, []);
    const title = kind === "plan" ? "Plan my day" : "Wind down";
    return (
        <div class={`chat-screen ritual ritual-${kind}`}>
            <header class="chat-head">
                <div>
                    <h1>{title}</h1>
                    <p class="ink-2">{dayLabel(date)}</p>
                </div>
                <button type="button" class="icon-btn" aria-label="Chat menu" onClick={() => openSheet(<ChatMenu chat={chat} />)}><Icon name="more_vert" /></button>
                <button type="button" class="icon-btn" aria-label="Close" onClick={() => {
                    ritual.value = null;
                    void refreshToday();
                }}><Icon name="close" /></button>
            </header>
            <Transcript chat={chat} />
            <Composer chat={chat} placeholder="Say something else…" />
        </div>
    );
}

const STARTERS = [ "What should I work on now?", "What's left today?", "What's on tomorrow?" ];

/** Ask: the server's Caius chat with the notes. A "remind me…" is read on the phone into a reminder chip, and only a tap sets it. */
export function Ask() {
    const key = today.value?.key;
    const chat = useChat("ask", key ?? "");
    const [ reminders, setReminders ] = useState<{ id: string; at: Date; text: string; set?: boolean }[]>([]);
    if (!key) {
        return <div class="chat-screen"><p class="ink-2">Asking Caius what today is…</p></div>;
    }

    const send = (text: string) => {
        const reminder = parseRemindMe(text, appNow());
        if (reminder) {
            setReminders([ ...reminders, { id: String(Date.now()), ...reminder } ]);
            return;
        }
        void chat.send(text);
    };

    return (
        <div class="chat-screen ask">
            <header class="chat-head">
                <div>
                    <h1>Ask</h1>
                    <p class="ink-2">Caius · reads your Journal</p>
                </div>
                <button type="button" class="icon-btn" aria-label="Chat menu" onClick={() => openSheet(<ChatMenu chat={chat} />)}><Icon name="more_vert" /></button>
                {chat.messages.length > 0 && <button type="button" class="icon-btn" aria-label="New conversation"
                    disabled={chat.state === "streaming" || chat.state === "starting"} onClick={chat.reset}><Icon name="edit_square" /></button>}
            </header>
            <Transcript chat={chat} />
            {reminders.map((r) => (
                <div key={r.id} class="reminder-chip">
                    <span class="reminder-chip-text"><Icon name="alarm" size={20} /> <span class="mono">{whenLabel(r.at, appNow())}</span> · {r.text}</span>
                    {r.set ? <span class="ink-2">Set.</span> : (
                        <Button kind="primary" onClick={() => {
                            addReminder({ at: r.at.toISOString(), text: r.text, source: "ask" });
                            haptic("confirm");
                            setReminders(reminders.map((x) => x.id === r.id ? { ...x, set: true } : x));
                        }}>Set</Button>
                    )}
                </div>
            ))}
            {chat.state !== "needs-update" && chat.messages.length === 0 && (
                <div class="starters">
                    {STARTERS.map((s) => <Chip key={s} onClick={() => send(s)}>{s}</Chip>)}
                </div>
            )}
            <Composer chat={chat} placeholder="Ask about your notes…" onSend={send} />
        </div>
    );
}

// ---- The conversation --------------------------------------------------------------------------

type ChatState = "idle" | "starting" | "streaming" | "ready" | "needs-update" | "failed";

/** One thing he tapped, as the answers pill lists it; `undo` puts it back as the step proposed. */
interface Pick {
    what: string;
    choice: string;
    undo?: () => void;
}

/** A live step card's answer: the sentences Caius reads, what he tapped, and how many items the card offers. */
interface CardAnswer {
    sentences: string[];
    picks: Pick[];
    total: number;
}

/** The cards' answers waiting to go with his next message, in card order. */
interface PendingAnswers {
    sentences: string[];
    picks: Pick[];
    /** The items left as the step proposed. */
    rest: number;
}

/** His message, with the card answers it carried kept apart so the bubble folds them into a pill. `content` has them written out, then his words. */
type ChatMessage = StoredMessage & { answers?: { picks: { what: string; choice: string }[]; rest: number; comment: string } };

interface Chat {
    state: ChatState;
    messages: ChatMessage[];
    streaming: AssistantTurn | null;
    error: string | null;
    /** His own words for the next message; the cards' answers go with it from `pending`. */
    draft: string;
    setDraft: (text: string) => void;
    /** A live step card's answer, under its own key. */
    report: (key: string, answer: CardAnswer) => void;
    /** Every live card's answer, or null when no card has one. */
    pending: PendingAnswers | null;
    /** Sends the next message without the cards' answers, until he taps a card again. */
    leaveOut: () => void;
    start: (first?: string, answers?: PendingAnswers) => Promise<void>;
    send: (text: string, answers?: PendingAnswers) => Promise<void>;
    reset: () => void;
    /** How long Caius thinks on this chat's next turn: the Settings default until it is changed here. */
    effort: CaiusEffort;
    setEffort: (effort: CaiusEffort) => void;
    /** The conversation so far as plain text, for sharing. */
    exportText: () => Promise<string>;
}

/** The chat's menu: how hard Caius thinks from here on, and sending the conversation off for review. */
function ChatMenu({ chat }: { chat: Chat }) {
    const [ effort, setEffort ] = useState(chat.effort);
    return (
        <>
            <SheetTitle title="Chat" />
            <div class="label-caps">Caius's thinking</div>
            <div class="chip-row">
                {CAIUS_EFFORTS.map((e) => (
                    <Chip key={e} selected={effort === e} onClick={() => {
                        setEffort(e);
                        chat.setEffort(e);
                    }}>{e === "low" ? "Low" : e === "medium" ? "Medium" : "High"}</Chip>
                ))}
            </div>
            <SheetAction glyph="open_in_new" label="Submit chat for feedback" onClick={() => {
                closeSheet();
                void chat.exportText().then((text) => shareText("Caius chat", text, "caius-chat.txt"));
            }} />
        </>
    );
}

/**
 * One Caius conversation: a chat note made on the server, the opener as the first message, each
 * turn streamed, and the transcript saved to the note after each turn as the sidebar saves it.
 */
function useChat(kind: ChatKind, date: string): Chat {
    const [ state, setState ] = useState<ChatState>(serverStatus.value === null ? "needs-update" : "idle");
    const [ messages, setMessages ] = useState<ChatMessage[]>([]);
    const [ streaming, setStreaming ] = useState<AssistantTurn | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    const [ draft, setDraft ] = useState("");
    const [ effort, setEffort ] = useState(settings.value.caiusEffort);
    const cards = useRef(new Map<string, CardAnswer>());
    const [ pending, setPending ] = useState<PendingAnswers | null>(null);
    const gather = () => {
        const all = [ ...cards.current.values() ];
        const sentences = all.flatMap((a) => a.sentences);
        const picks = all.flatMap((a) => a.picks);
        setPending(sentences.length ? { sentences, picks, rest: all.reduce((n, a) => n + a.total, 0) - picks.length } : null);
    };
    const report = (key: string, answer: CardAnswer) => {
        cards.current.set(key, answer);
        gather();
    };
    const leaveOut = () => {
        cards.current.clear();
        setPending(null);
    };
    const noteId = useRef<string | null>(null);
    const history = useRef<ChatMessage[]>([]);
    /** Bumped by New conversation and on close; a turn from an older conversation drops its reply. */
    const generation = useRef(0);
    const controller = useRef<AbortController | null>(null);

    useEffect(() => () => {
        generation.current++;
        controller.current?.abort();
    }, []);

    const turn = async (text: string, answers?: PendingAnswers) => {
        const conn = connection.value;
        const chatNoteId = noteId.current;
        if (!conn || !chatNoteId) {
            return;
        }
        const chats = chatApi(conn);
        const mine = generation.current;
        const abort = new AbortController();
        controller.current = abort;
        const said = [ answers?.sentences.join(" "), text ].filter(Boolean).join("\n\n");
        const user: ChatMessage = {
            id: newId(), role: "user", content: said, createdAt: new Date().toISOString(),
            ...(answers ? { answers: { picks: answers.picks.map(({ what, choice }) => ({ what, choice })), rest: answers.rest, comment: text } } : {})
        };
        history.current = [ ...history.current, user ];
        setMessages(history.current);
        setState("streaming");
        setError(null);
        const sent = new Map(cards.current);
        cards.current.clear();
        setPending(null);
        setDraft("");

        let assembled: AssistantTurn = { id: newId(), blocks: [], done: false };
        setStreaming(assembled);
        try {
            await chats.stream(historyForServer(history.current), chatNoteId, effort, (chunk) => {
                if (generation.current === mine) {
                    assembled = applyChunk(assembled, chunk);
                    setStreaming(assembled);
                }
            }, abort.signal);
        } catch (e) {
            assembled = { ...assembled, error: messageOf(e), done: true };
        }
        if (generation.current !== mine) {
            return;
        }
        if (!assembled.done && !assembled.error) {
            assembled = { ...assembled, error: "The reply was cut off. Your message is back in the box: send it again." };
        }

        // A failed turn is kept as an error message (the sidebar shows it as one) and its words go back in the box.
        const reply: StoredMessage = assembled.error
            ? { id: assembled.id, role: "assistant", content: assembled.error, createdAt: new Date().toISOString(), type: "error" }
            : { id: assembled.id, role: "assistant", content: assembled.blocks, createdAt: new Date().toISOString() };
        // A reply's notes go just before it as a thinking message, which the sidebar shows as its thought process.
        const notes: StoredMessage[] = !assembled.error && assembled.notes?.length
            ? [ { id: `${assembled.id}-notes`, role: "assistant", content: assembled.notes.join("\n\n"), createdAt: reply.createdAt, type: "thinking" } ]
            : [];
        history.current = [ ...history.current, ...notes, reply ];
        setMessages(history.current);
        setStreaming(null);
        setError(assembled.error ?? null);
        if (assembled.error) {
            setDraft(text);
            if (answers) {
                cards.current = sent;
                gather();
            }
        }
        setState("ready");
        if (assembled.blocks.some((b) => b.type === "tool_call" && /apply|set_state|forward|add|accept|dismiss|skip/.test(b.toolCall.toolName))) {
            revision.value++;
            void refreshToday();
        }

        const content: LlmChatContent = { version: 1, messages: history.current, enableNoteTools: true, enableWebSearch: false };
        await chats.save(chatNoteId, content).catch((e) => {
            snack.value = { text: `The transcript wasn't saved: ${messageOf(e)}`, tone: "error" };
        });
    };

    /**
     * Makes the chat note and opens the conversation. A ritual's opener is a turn of its own; Ask
     * sends its opener with the first question, as two user messages in one turn.
     */
    const start = async (first?: string, answers?: PendingAnswers) => {
        const conn = connection.value;
        if (!conn || !date) {
            return;
        }
        if (serverStatus.value === null) {
            setState("needs-update");
            return;
        }
        setState("starting");
        const mine = generation.current;
        try {
            const created = await chatApi(conn).createNote();
            if (generation.current !== mine) {
                return;
            }
            noteId.current = created;
        } catch (e) {
            if (generation.current !== mine) {
                return;
            }
            if (e instanceof NeedsServerUpdateError) {
                setState("needs-update");
            } else {
                setError(messageOf(e));
                setState("failed");
            }
            return;
        }
        if (first !== undefined) {
            history.current = [ { id: newId(), role: "user", content: opener(kind, date), createdAt: new Date().toISOString() } ];
            await turn(first, answers);
        } else {
            await turn(opener(kind, date));
        }
    };

    const send = async (text: string, answers?: PendingAnswers) => {
        if ((!text.trim() && !answers) || state === "streaming" || state === "starting" || state === "needs-update") {
            return;
        }
        if (!noteId.current) {
            await start(text.trim(), answers);
        } else {
            await turn(text.trim(), answers);
        }
    };

    const reset = () => {
        generation.current++;
        controller.current?.abort();
        noteId.current = null;
        history.current = [];
        setMessages([]);
        setStreaming(null);
        setError(null);
        leaveOut();
        setDraft("");
        setEffort(settings.value.caiusEffort);
        setState(serverStatus.value === null ? "needs-update" : "idle");
    };

    const exportText = async () => chatTranscript({
        kind, date, effort, appVersion: await appVersion(), exportedAt: new Date(), messages: history.current
    });

    return { state, messages, streaming, error, draft, setDraft, report, pending, leaveOut, start, send, reset, effort, setEffort, exportText };
}

function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function Transcript({ chat }: { chat: Chat }) {
    const end = useRef<HTMLDivElement>(null);
    const box = useRef<HTMLDivElement>(null);
    // Open notes, by turn: the streaming turn and the reply it becomes share an id, so notes opened
    // while Caius works stay open when the reply lands.
    const [ openNotes, setOpenNotes ] = useState<ReadonlySet<string>>(new Set());
    const notesFor = (id: string, text: string | undefined): TurnNotes | undefined => text ? {
        text,
        open: openNotes.has(id),
        toggle: () => setOpenNotes((open) => {
            const next = new Set(open);
            if (!next.delete(id)) {
                next.add(id);
            }
            return next;
        })
    } : undefined;
    // While a turn streams, follow its end; once it lands, show it from its first line, where Caius asks.
    useEffect(() => {
        const last = chat.messages[chat.messages.length - 1];
        const turns = box.current?.querySelectorAll(".caius-turn, .chat-error");
        if (!chat.streaming && last?.role === "assistant" && turns?.length) {
            turns[turns.length - 1].scrollIntoView({ block: "start", behavior: "smooth" });
        } else {
            end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
        }
    }, [ chat.messages.length, !!chat.streaming ]);

    if (chat.state === "needs-update") {
        return (
            <div class="transcript">
                <div class="needs-update">
                    <p><strong>Needs the Caius server update.</strong></p>
                    <p class="ink-2">This server has no phone chat yet. Today, Plan, task actions and Quick add work without it.</p>
                </div>
            </div>
        );
    }

    const lastStepIndex = findLastStep(chat.messages);
    // Caius's text streams as it is written; the thinking, and narration before a tool call (taken
    // back), go to Caius's notes, folded under the working line. The step cards wait for the turn to
    // finish, so the turn reads from Caius's question down.
    const streaming = chat.streaming;
    const streamingText = !!streaming && turnText(streaming.blocks).trim() !== "";
    const working = streaming?.blocks.some((b) => b.type === "tool_call") ? "Caius is writing…" : "Caius is reading the Journal…";
    const notesOf = (i: number) => {
        const before = chat.messages[i - 1];
        return notesFor(chat.messages[i].id, before?.type === "thinking" && typeof before.content === "string" ? before.content : undefined);
    };
    return (
        <div class="transcript" ref={box} aria-live="polite">
            {chat.messages.map((m, i) => (
                (i === 0 && m.role === "user") || m.type === "thinking" ? null
                    : <Message key={m.id} message={m} chat={chat} live={i === lastStepIndex && chat.state === "ready"} notes={notesOf(i)} />
            ))}
            {streaming && (streamingText || streaming.notes?.length)
                ? <AssistantBlocks blocks={streaming.blocks} chat={chat} live={false} pending
                    notes={notesFor(streaming.id, streaming.notes?.join("\n\n"))} working={streamingText ? undefined : working} />
                : (chat.state === "starting" || streaming) && <p class="caius-thinking ink-2">{working}</p>}
            {chat.state === "failed" && chat.error && <p class="chat-error">{chat.error}</p>}
            <div ref={end} />
        </div>
    );
}

/**
 * The last turn with step cards: its cards stay live through follow-up turns that ask again
 * without new steps, and go quiet once a later turn has written the ritual (an `…_apply` call).
 */
function findLastStep(messages: StoredMessage[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (Array.isArray(m.content) && m.content.some((b) => b.type === "tool_call" && /_apply$/.test(b.toolCall.toolName))) {
            return -1;
        }
        if (Array.isArray(m.content) && m.content.some((b) => b.type === "tool_call" && stepOf(b.toolCall))) {
            return i;
        }
    }
    return -1;
}

function Message({ message, chat, live, notes }: { message: ChatMessage; chat: Chat; live: boolean; notes?: TurnNotes }) {
    if (message.role === "user" && message.answers) {
        return <SentAnswers answers={message.answers} />;
    }
    if (message.role === "user") {
        return <p class="bubble-user">{typeof message.content === "string" ? message.content : turnText(message.content)}</p>;
    }
    if (message.type === "error" || typeof message.content === "string") {
        return <p class="chat-error">{typeof message.content === "string" ? message.content : ""}</p>;
    }
    return <AssistantBlocks blocks={message.content} chat={chat} live={live} notes={notes} />;
}

/**
 * One assistant turn. Caius sends one rundown after the steps ran, so its text comes first and the
 * step cards follow with the data to answer from; a card with nothing to answer is left out, and
 * the bullet lists in the text repeat what the cards show, so they are left out when there are cards.
 */
function AssistantBlocks({ blocks, chat, live, pending, notes, working }: {
    blocks: ContentBlock[];
    chat: Chat;
    live: boolean;
    pending?: boolean;
    /** What Caius worked through on the way here; folded away under `working` or "Caius's notes". */
    notes?: TurnNotes;
    /** The working line, as the notes' label while the turn has no text yet. */
    working?: string;
}) {
    const steps = blocks.flatMap((b) => {
        const step = b.type === "tool_call" ? stepOf(b.toolCall) : null;
        return step && b.type === "tool_call" && stepHasBody(step) ? [ { id: b.toolCall.id, step } ] : [];
    });
    const text = turnText(blocks);
    return (
        <div class={`caius-turn${pending ? " pending" : ""}`}>
            {notes && <Notes notes={notes} label={working ?? "Caius's notes"} working={!!working} />}
            {text && <CaiusText text={text} withoutLists={steps.length > 0} />}
            {!pending && steps.map(({ id, step }) => (
                <StepCard key={id} id={id} step={step} chat={chat} live={live && !pending} />
            ))}
        </div>
    );
}

/** A turn's notes: Caius's thinking and taken-back narration, and whether they are open. */
interface TurnNotes {
    text: string;
    open: boolean;
    toggle: () => void;
}

/** Caius's notes, folded under one line; a tap opens them. */
function Notes({ notes, label, working }: { notes: TurnNotes; label: string; working: boolean }) {
    return (
        <div class={`caius-notes${notes.open ? " open" : ""}`}>
            <button type="button" class={`caius-notes-toggle ink-2${working ? " caius-thinking" : ""}`} aria-expanded={notes.open} onClick={notes.toggle}>
                <span>{label}</span>
                <Icon name="keyboard_arrow_down" size={20} />
            </button>
            {notes.open && <div class="caius-notes-body ink-2"><CaiusText text={notes.text} /></div>}
        </div>
    );
}

/** Caius's prose: paragraphs, bullets, numbered steps, quotes and headings, bold and code inline. `withoutLists` leaves the lists out. */
function CaiusText({ text, withoutLists }: { text: string; withoutLists?: boolean }) {
    return <div class="caius-text"><Blocks blocks={proseBlocks(text)} withoutLists={withoutLists} /></div>;
}

function Blocks({ blocks, withoutLists }: { blocks: ProseBlock[]; withoutLists?: boolean }) {
    return (
        <>
            {blocks.map((block, i) => {
                switch (block.kind) {
                    case "heading": return <p key={i} class="caius-heading"><Spans spans={block.text} /></p>;
                    case "p": return <p key={i}><Spans spans={block.text} /></p>;
                    case "quote": return <blockquote key={i}><Blocks blocks={block.blocks} withoutLists={withoutLists} /></blockquote>;
                    default: {
                        if (withoutLists) return null;
                        const items = block.items.map((item, j) => <li key={j}><Spans spans={item} /></li>);
                        return block.kind === "ol" ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
                    }
                }
            })}
        </>
    );
}

function Spans({ spans }: { spans: Span[] }) {
    return <>{spans.map((span, i) => span.bold ? <strong key={i}>{span.text}</strong> : span.code ? <code key={i}>{span.text}</code> : span.text)}</>;
}

/**
 * The box his next message is written in. Taps on step cards gather in the answers pill above it,
 * so the box holds only his own words; Send sends both, the answers written out first.
 */
function Composer({ chat, placeholder, onSend }: { chat: Chat; placeholder: string; onSend?: (text: string) => void }) {
    const text = chat.draft;
    const setText = chat.setDraft;
    const pending = chat.pending;
    const [ open, setOpen ] = useState(false);
    const busy = chat.state === "streaming" || chat.state === "starting";
    const canSend = !busy && chat.state !== "needs-update" && (!!pending || !!text.trim());
    const send = () => {
        if (!canSend) {
            return;
        }
        if (pending) {
            void chat.send(text.trim(), pending);
        } else {
            (onSend ?? ((t: string) => void chat.send(t)))(text.trim());
        }
        setText("");
        setOpen(false);
    };
    const box = (cls: string) => (
        <textarea class={cls} rows={text.length > 60 ? 3 : 1} placeholder={pending ? "Add a comment (optional)" : placeholder} value={text}
            aria-label={pending ? "Comment" : undefined} disabled={chat.state === "needs-update"}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                }
            }} />
    );
    return (
        <footer class="composer">
            <div class="composer-row">
                {pending ? (
                    <div class="composer-box">
                        {open && <AnswerList picks={pending.picks} rest={pending.rest} leaveOut={() => {
                            setOpen(false);
                            chat.leaveOut();
                        }} />}
                        <AnswersPill count={pending.picks.length} open={open} up toggle={() => setOpen(!open)} />
                        {box("composer-comment")}
                    </div>
                ) : box("field")}
                <Button kind="primary" aria-label="Send" disabled={!canSend} onClick={send}><Icon name="arrow_upward" /></Button>
            </div>
        </footer>
    );
}

/** The answers, folded: how many he tapped, or "All as proposed"; a tap opens the list. `up` when the list opens above it. */
function AnswersPill({ count, open, up, toggle }: { count: number; open: boolean; up?: boolean; toggle: () => void }) {
    const label = count === 0 ? "All as proposed" : count === 1 ? "1 answer" : `${count} answers`;
    return (
        <button type="button" class="answers-pill" aria-expanded={open} onClick={toggle}>
            <Icon name="check" size={18} />
            <span>{label}</span>
            <span class={`pill-chevron${open === !!up ? "" : " up"}`}><Icon name="keyboard_arrow_down" size={18} /></span>
        </button>
    );
}

/** Each tap, with a × that puts it back as proposed while the card is live, then how many go as proposed. */
function AnswerList({ picks, rest, leaveOut }: { picks: Pick[]; rest: number; leaveOut?: () => void }) {
    return (
        <ul class="answer-list">
            {picks.map((p, i) => (
                <li key={i}>
                    <span class="answer-text">{p.what} <span class="ink-2">→</span> <strong>{p.choice}</strong></span>
                    {p.undo && <button type="button" class="answer-undo" aria-label={`Put ${p.what} back as proposed`} onClick={p.undo}><Icon name="close" size={18} /></button>}
                </li>
            ))}
            {rest > 0 && <li class="ink-2">{rest === 1 ? "1 other goes" : `${rest} others go`} as proposed</li>}
            {leaveOut && <li><Button kind="quiet" onClick={leaveOut}>Send without them</Button></li>}
        </ul>
    );
}

/** His sent message: the answers folded into a pill he can open, and his own words under it. */
function SentAnswers({ answers }: { answers: NonNullable<ChatMessage["answers"]> }) {
    const [ open, setOpen ] = useState(false);
    return (
        <div class="bubble-user bubble-answers">
            <AnswersPill count={answers.picks.length} open={open} toggle={() => setOpen(!open)} />
            {open && <AnswerList picks={answers.picks} rest={answers.rest} />}
            {answers.comment && <p>{answers.comment}</p>}
        </div>
    );
}

// ---- Step cards --------------------------------------------------------------------------------

/**
 * A ritual step as a card: its title (the question, from a server without titles) over its data. Every item shows its fate as a chip, set to the step's own default until he taps it.
 * The card reports its whole answer to the composer: the sentences (`stepReply`), so the message
 * names every item explicitly, and his taps (`stepPicks`) for the answers pill. The agent does the
 * judgment and the write.
 */
function StepCard({ id, step, chat, live }: { id: string; step: RitualStep; chat: Chat; live: boolean }) {
    const [ answers, setAnswers ] = useState<StepAnswers>({});
    const update = (patch: Partial<StepAnswers>) => {
        haptic("tick");
        setAnswers({ ...answers, ...patch });
    };
    const sentences = stepReply(step, answers);
    const { picks, total } = stepPicks(step, answers);
    const joined = JSON.stringify([ sentences, picks.map((p) => [ p.what, p.choice ]) ]);
    // A layout effect, so the pill holds the new answer before the next paint and a quick Send never sends the old one.
    useLayoutEffect(() => {
        if (live) {
            chat.report(id, { sentences, total, picks: picks.map((p) => ({ what: displayText(p.what).text, choice: p.choice, undo: () => update(p.undo) })) });
        }
    }, [ live, joined ]);
    return (
        <section class={`step-card step-${step.ritual}`}>
            {(step.title ?? step.question) && <h3 class="step-title">{step.title ?? step.question}</h3>}
            <StepBody step={step} answers={answers} update={update} disabled={!live} chat={chat} />
        </section>
    );
}

interface StepItem {
    text: string;
    fate?: StepFate;
}

function StepBody({ step, answers, update, disabled, chat }: { step: RitualStep; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean; chat: Chat }) {
    const d = step.data as Record<string, any>;
    const kind = `${step.ritual}:${step.step}`;

    if (kind === "plan:not_today") {
        const day = step.dateLabel ?? "that day";
        return (
            <div class="step-foot">
                <Button kind="primary" disabled={disabled} onClick={() => void chat.send(`Yes, plan ${day} now.`)}>Plan {day} now</Button>
            </div>
        );
    }

    if (kind === "plan:catchup") {
        const tasks: { text: string; periodLabel?: string }[] = Array.isArray(d.tasks) ? d.tasks : [];
        const choices = [ "move all to today", "let's review them", "skip the catch-up" ];
        return (
            <>
                <ul class="step-list">{tasks.map((t, i) => <li key={i}>{displayText(t.text).text}{t.periodLabel && <span class="ink-2"> · {t.periodLabel}</span>}</li>)}</ul>
                <div class="chip-row replies">
                    {choices.map((c) => <Chip key={c} disabled={disabled} selected={answers.catchup === c} onClick={() => update({ catchup: c })}>{capitalize(c)}</Chip>)}
                </div>
            </>
        );
    }

    if (kind === "winddown:open") {
        const items: StepItem[] = Array.isArray(d.items) ? d.items : [];
        const day = items.map((it) => it.fate && "forward" in it.fate && /^\d{4}-\d{2}-\d{2}$/.test(it.fate.forward) ? it.fate.forwardLabel : null).find(Boolean)
            ?? d.days?.[0]?.dateLabel ?? "the next workday";
        const week = d.weeks?.[0]?.weekLabel as string | undefined;
        const options: Choice[] = [
            { kind: "proposed" }, { kind: "done" },
            { kind: "day", label: day, onDeck: true }, { kind: "day", label: day, onDeck: false },
            ...(week ? [ { kind: "period" as const, label: week } ] : []),
            { kind: "drop", reason: "" }
        ];
        return (
            <>
                <FateList items={items} options={options} answers={answers} update={update} disabled={disabled} />
                <div class="step-foot">
                    <Button kind="quiet" disabled={disabled} onClick={() => update({ fates: Object.fromEntries(items.map((_, i) => [ i, { kind: "done" } ])) })}>Mark all done</Button>
                </div>
            </>
        );
    }

    if (kind === "plan:inputs") {
        const onDeck: StepItem[] = Array.isArray(d.onDeck) ? d.onDeck : [];
        const options: Choice[] = [
            { kind: "proposed" }, { kind: "list" }, { kind: "stay-deck" },
            ...(d.targetWeekLabel ? [ { kind: "period" as const, label: d.targetWeekLabel as string } ] : []),
            { kind: "drop", reason: "" }
        ];
        return (
            <>
                {d.yesterday?.sentence && <p class="step-note ink-2">{d.yesterday.sentence}</p>}
                {onDeck.length > 0 && <FateList items={onDeck} options={options} answers={answers} update={update} disabled={disabled} />}
                <Candidates items={Array.isArray(d.candidates) ? d.candidates : []} answers={answers} update={update} disabled={disabled} />
                <Unmarked items={Array.isArray(d.unmarked) ? d.unmarked : []} answers={answers} update={update} disabled={disabled} />
            </>
        );
    }

    if (kind === "winddown:next") {
        return (
            <>
                {d.capacity?.sentence && <p class="step-note">{d.capacity.sentence}</p>}
                {d.summary && <p class="step-note ink-2">{d.summary}</p>}
                <Candidates items={Array.isArray(d.candidates) ? d.candidates : []} answers={answers} update={update} disabled={disabled} />
            </>
        );
    }

    if (kind === "winddown:context") {
        const lines: { text: string; untilLabel?: string }[] = Array.isArray(d.context) ? d.context : [];
        const set = (i: number, value: ContextAnswer) => update({ context: { ...answers.context, [i]: answers.context?.[i] === value ? null : value } });
        return (
            <ul class="step-list">
                {lines.map((l, i) => (
                    <li key={i} class="context-line">
                        <span>{displayText(l.text).text}{l.untilLabel && <span class="mono ink-2"> until {l.untilLabel}</span>}</span>
                        <span class="chip-row">
                            <Chip disabled={disabled} selected={answers.context?.[i] === "keep"} onClick={() => set(i, "keep")}>Keep</Chip>
                            <Chip disabled={disabled} selected={answers.context?.[i] === "end"} onClick={() => set(i, "end")}>Let it end</Chip>
                        </span>
                    </li>
                ))}
            </ul>
        );
    }

    return null;
}

/** Items with their fate as a chip, the step's proposal until he picks one; a tap opens a sheet of the fates. Drop asks why. */
function FateList({ items, options, answers, update, disabled }: { items: StepItem[]; options: Choice[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    const choiceOf = (i: number): Choice => answers.fates?.[i] ?? { kind: "proposed" };
    const pick = (i: number, choice: Choice) => {
        update({ fates: { ...answers.fates, [i]: choice } });
        closeSheet();
    };
    const choose = (i: number) => {
        const labels = options.map((o) => chipLabel(o, items[i].fate));
        const now = chipLabel(choiceOf(i), items[i].fate);
        openSheet(
            <>
                <SheetTitle title="Fate" sub={displayText(items[i].text).text} />
                {options.map((option, at) => (
                    // A fate that reads the same as the proposal is left out; the proposal itself stands for it.
                    at > 0 && labels[at] === labels[0] ? null
                        : <SheetAction key={labels[at]} glyph={labels[at] === now ? "check" : "·"} label={labels[at]} detail={at === 0 ? "proposed" : undefined} onClick={() => pick(i, option)} />
                ))}
            </>
        );
    };
    return (
        <ul class="fate-list">
            {items.map((item, i) => {
                const choice = choiceOf(i);
                return (
                    <li key={i}>
                        <span class="fate-text">{displayText(item.text).text}</span>
                        <Chip selected={choice.kind !== "proposed"} disabled={disabled} onClick={() => choose(i)}>{chipLabel(choice, item.fate)}</Chip>
                        {choice.kind === "drop" && (
                            <input class="field fate-reason" placeholder="Why?" value={choice.reason} disabled={disabled}
                                onInput={(e) => update({ fates: { ...answers.fates, [i]: { kind: "drop", reason: (e.target as HTMLInputElement).value } } })} />
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

type CandidateItem = CandidateData & { minutes?: number; because?: string; area?: Area };

/** Candidates in up to three lists, Work, Growth and Recharge, each with Take / Not today / Dismiss / Finished. */
function Candidates({ items, answers, update, disabled }: { items: CandidateItem[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    const lists: [ Area, string ][] = [ [ "foundation", "New since yesterday" ], [ "growth", "Growth" ], [ "recharge", "Recharge" ] ];
    return (
        <>
            {lists.map(([ area, heading ]) => {
                // The index is the candidate's place in the whole step, which is where its answer is kept.
                const mine = items.flatMap((c, i) => (c.area ?? "foundation") === area ? [ { c, i } ] : []);
                return mine.length > 0 && <CandidateList key={area} heading={heading} items={mine} answers={answers} update={update} disabled={disabled} />;
            })}
        </>
    );
}

/** One area's candidates, and what happens to each if he leaves it alone. */
function CandidateList({ heading, items, answers, update, disabled }: { heading: string; items: { c: CandidateItem; i: number }[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    const set = (i: number, value: CandidateAnswer) => update({ candidates: { ...answers.candidates, [i]: answers.candidates?.[i] === value ? null : value } });
    const labels: [CandidateAnswer, string][] = [ [ "take", "Take" ], [ "notToday", "Not today" ], [ "dismiss", "Dismiss" ], [ "finished", "Finished" ] ];
    return (
        <div class="candidates">
            <div class="label-caps">{heading}</div>
            {items.map(({ c, i }) => (
                <div key={i} class="candidate">
                    <p>{displayText(c.text).text}{c.minutes ? <span class="mono ink-2"> ~{formatEstimate(c.minutes)}</span> : null}</p>
                    {c.because && <p class="ink-2 candidate-why">because {c.because}</p>}
                    <div class="chip-row">
                        {labels.map(([ value, label ]) => (
                            <Chip key={label} disabled={disabled} selected={answers.candidates?.[i] === value} onClick={() => set(i, value)}>{label}</Chip>
                        ))}
                    </div>
                    {!answers.candidates?.[i] && <p class="ink-2 candidate-why">Left alone, it {candidateDefault(c)}.</p>}
                </div>
            ))}
        </div>
    );
}

/** Tasks with no marker and no Jira key, for him to file: Work, Growth or Recharge. */
function Unmarked({ items, answers, update, disabled }: { items: UnmarkedData[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    if (!items.length) {
        return null;
    }
    const set = (i: number, value: Area) => update({ areas: { ...answers.areas, [i]: answers.areas?.[i] === value ? null : value } });
    const labels: [Area, string][] = [ [ "foundation", "Work" ], [ "growth", "🌱 Growth" ], [ "recharge", "🔋 Recharge" ] ];
    return (
        <div class="candidates">
            <div class="label-caps">Which area?</div>
            {items.map((t, i) => (
                <div key={i} class="candidate">
                    <p>{displayText(t.text).text}</p>
                    <div class="chip-row">
                        {labels.map(([ value, label ]) => (
                            <Chip key={value} disabled={disabled} selected={answers.areas?.[i] === value} onClick={() => set(i, value)}>{label}</Chip>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function capitalize(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
