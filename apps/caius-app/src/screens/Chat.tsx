import "./chat.css";

import { KeepAwake } from "@capacitor-community/keep-awake";
import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import { useEffect, useRef, useState } from "preact/hooks";

import { addReminder } from "../components/sheets.js";
import { displayText } from "../components/TaskRow.js";
import { Button, Chip, haptic, Icon } from "../components/ui.js";
import { ritual } from "../app-state.js";
import { applyChunk, type AssistantTurn, chatApi, type ChatKind, type ContentBlock, type LlmChatContent, NeedsServerUpdateError, opener, type RitualStep, stepOf, type StoredMessage, turnText } from "../lib/chat.js";
import { dayLabel } from "../lib/day.js";
import { parseRemindMe, whenLabel } from "../lib/remind.js";
import { appNow, connection, messageOf, refreshToday, revision, serverStatus, snack, today } from "../lib/store.js";

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
                {chat.messages.length > 0 && <button type="button" class="icon-btn" aria-label="New conversation" onClick={chat.reset}><Icon name="edit_square" /></button>}
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

interface Chat {
    state: ChatState;
    messages: StoredMessage[];
    streaming: AssistantTurn | null;
    error: string | null;
    /** His next message as taps on step cards build it; the composer edits and sends it. */
    draft: string;
    setDraft: (text: string) => void;
    start: (first?: string) => Promise<void>;
    send: (text: string) => Promise<void>;
    reset: () => void;
}

/**
 * One Caius conversation: a chat note made on the server, the opener as the first message, each
 * turn streamed, and the transcript saved to the note after each turn as the sidebar saves it.
 */
function useChat(kind: ChatKind, date: string): Chat {
    const [ state, setState ] = useState<ChatState>(serverStatus.value === null ? "needs-update" : "idle");
    const [ messages, setMessages ] = useState<StoredMessage[]>([]);
    const [ streaming, setStreaming ] = useState<AssistantTurn | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    const [ draft, setDraft ] = useState("");
    const noteId = useRef<string | null>(null);
    const history = useRef<StoredMessage[]>([]);

    const turn = async (text: string) => {
        const conn = connection.value;
        if (!conn || !noteId.current) {
            return;
        }
        const chats = chatApi(conn);
        const user: StoredMessage = { id: newId(), role: "user", content: text, createdAt: new Date().toISOString() };
        history.current = [ ...history.current, user ];
        setMessages(history.current);
        setState("streaming");
        setError(null);
        setDraft("");

        let assembled: AssistantTurn = { id: newId(), blocks: [], done: false };
        setStreaming(assembled);
        try {
            await chats.stream(
                history.current.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: typeof m.content === "string" ? m.content : turnText(m.content) })),
                noteId.current,
                (chunk) => {
                    assembled = applyChunk(assembled, chunk);
                    setStreaming(assembled);
                }
            );
        } catch (e) {
            assembled = { ...assembled, error: messageOf(e), done: true };
        }

        const reply: StoredMessage = assembled.error && !assembled.blocks.length
            ? { id: assembled.id, role: "assistant", content: assembled.error, createdAt: new Date().toISOString(), type: "error" }
            : { id: assembled.id, role: "assistant", content: assembled.blocks, createdAt: new Date().toISOString() };
        history.current = [ ...history.current, reply ];
        setMessages(history.current);
        setStreaming(null);
        setError(assembled.error ?? null);
        setState("ready");
        if (assembled.blocks.some((b) => b.type === "tool_call" && /apply|set_state|forward|add|accept|dismiss|skip/.test(b.toolCall.toolName))) {
            revision.value++;
            void refreshToday();
        }

        const content: LlmChatContent = { version: 1, messages: history.current, enableNoteTools: true, enableWebSearch: false };
        await chats.save(noteId.current, content).catch((e) => {
            snack.value = { text: `The transcript wasn't saved: ${messageOf(e)}`, tone: "error" };
        });
    };

    /**
     * Makes the chat note and opens the conversation. A ritual's opener is a turn of its own; Ask
     * sends its opener with the first question, as two user messages in one turn.
     */
    const start = async (first?: string) => {
        const conn = connection.value;
        if (!conn || !date) {
            return;
        }
        if (serverStatus.value === null) {
            setState("needs-update");
            return;
        }
        setState("starting");
        try {
            noteId.current = await chatApi(conn).createNote();
        } catch (e) {
            if (e instanceof NeedsServerUpdateError) {
                setState("needs-update");
            } else {
                setError(messageOf(e));
                setState("failed");
            }
            return;
        }
        if (first) {
            history.current = [ { id: newId(), role: "user", content: opener(kind, date), createdAt: new Date().toISOString() } ];
            await turn(first);
        } else {
            await turn(opener(kind, date));
        }
    };

    const send = async (text: string) => {
        if (!text.trim() || state === "streaming" || state === "starting" || state === "needs-update") {
            return;
        }
        if (!noteId.current) {
            await start(text.trim());
        } else {
            await turn(text.trim());
        }
    };

    const reset = () => {
        noteId.current = null;
        history.current = [];
        setMessages([]);
        setStreaming(null);
        setError(null);
        setDraft("");
        setState(serverStatus.value === null ? "needs-update" : "idle");
    };

    return { state, messages, streaming, error, draft, setDraft, start, send, reset };
}

function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function Transcript({ chat }: { chat: Chat }) {
    const end = useRef<HTMLDivElement>(null);
    const box = useRef<HTMLDivElement>(null);
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
    return (
        <div class="transcript" ref={box} aria-live="polite">
            {chat.messages.map((m, i) => (
                i === 0 && m.role === "user" ? null : <Message key={m.id} message={m} chat={chat} live={i === lastStepIndex && chat.state === "ready"} />
            ))}
            {chat.streaming && <AssistantBlocks blocks={chat.streaming.blocks} chat={chat} live={false} pending />}
            {(chat.state === "starting" || (chat.streaming && !chat.streaming.blocks.length)) && <p class="caius-thinking ink-2">Caius is reading the Journal…</p>}
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

function Message({ message, chat, live }: { message: StoredMessage; chat: Chat; live: boolean }) {
    if (message.role === "user") {
        return <p class="bubble-user">{typeof message.content === "string" ? message.content : turnText(message.content)}</p>;
    }
    if (message.type === "error" || typeof message.content === "string") {
        return <p class="chat-error">{typeof message.content === "string" ? message.content : ""}</p>;
    }
    return <AssistantBlocks blocks={message.content} chat={chat} live={live} />;
}

/**
 * One assistant turn. Caius asks every step's question in one message after the steps ran, so its
 * text comes first and the step cards follow with the data to answer from; the bullet lists in the
 * text repeat what the cards show, and are left out when there are cards.
 */
function AssistantBlocks({ blocks, chat, live, pending }: { blocks: ContentBlock[]; chat: Chat; live: boolean; pending?: boolean }) {
    const steps = blocks.flatMap((b) => {
        const step = b.type === "tool_call" ? stepOf(b.toolCall) : null;
        return step && b.type === "tool_call" ? [ { id: b.toolCall.id, step } ] : [];
    });
    const text = turnText(blocks);
    return (
        <div class={`caius-turn${pending ? " pending" : ""}`}>
            {text && <CaiusText text={text} withoutLists={steps.length > 0} />}
            {steps.map(({ id, step }) => (
                <StepCard key={id} step={step} chat={chat} live={live && !pending} askedInText={!!step.question && text.includes(step.question)} />
            ))}
        </div>
    );
}

/** Caius's prose: paragraphs and bullets, no markup beyond that. */
function CaiusText({ text, withoutLists }: { text: string; withoutLists?: boolean }) {
    return (
        <div class="caius-text">
            {text.split(/\n{2,}/).map((para, i) => {
                const lines = para.split("\n");
                if (lines.every((l) => /^\s*[-*•]\s/.test(l))) {
                    return withoutLists ? null : <ul key={i}>{lines.map((l, j) => <li key={j}>{strip(l.replace(/^\s*[-*•]\s/, ""))}</li>)}</ul>;
                }
                return <p key={i}>{strip(para)}</p>;
            })}
        </div>
    );
}

function strip(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

function Composer({ chat, placeholder, onSend }: { chat: Chat; placeholder: string; onSend?: (text: string) => void }) {
    const text = chat.draft;
    const setText = chat.setDraft;
    const busy = chat.state === "streaming" || chat.state === "starting";
    const send = () => {
        if (!text.trim() || busy) {
            return;
        }
        (onSend ?? ((t: string) => void chat.send(t)))(text.trim());
        setText("");
    };
    return (
        <footer class="composer">
            {chat.error && chat.state === "ready" && <p class="chat-error">{chat.error}</p>}
            <div class="composer-row">
                <textarea class="field" rows={text.length > 60 ? 3 : 1} placeholder={placeholder} value={text} disabled={chat.state === "needs-update"}
                    onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        }
                    }} />
                <Button kind="primary" aria-label="Send" disabled={busy || !text.trim()} onClick={send}><Icon name="arrow_upward" /></Button>
            </div>
        </footer>
    );
}

// ---- Step cards --------------------------------------------------------------------------------

/**
 * A ritual step as a card: Caius's question word for word (unless his text already asked it) over
 * its data, with quick replies. A tap adds a plain sentence to his next message, so one message
 * answers every step of the turn; the agent does the judgment and the write.
 */
function StepCard({ step, chat, live, askedInText }: { step: RitualStep; chat: Chat; live: boolean; askedInText: boolean }) {
    const reply = (text: string) => {
        haptic("tick");
        const current = chat.draft.trim();
        const sentence = /[.?!]$/.test(text) ? text : `${text}.`;
        chat.setDraft(current ? `${current.replace(/[.]?$/, ".")} ${sentence}` : sentence);
    };
    const disabled = !live;
    return (
        <section class={`step-card step-${step.ritual}`}>
            {step.question && !askedInText && <p class="step-question">{step.question}</p>}
            <StepBody step={step} reply={reply} disabled={disabled} />
        </section>
    );
}

interface FateItem {
    text: string;
    proposal: string;
    options: string[];
}

function StepBody({ step, reply, disabled }: { step: RitualStep; reply: (text: string) => void; disabled: boolean }) {
    const d = step.data as Record<string, any>;

    if (step.step === "catchup") {
        const tasks: { text: string; periodLabel?: string }[] = Array.isArray(d.tasks) ? d.tasks : [];
        if (!tasks.length) {
            return <Replies replies={[ "Carry on" ]} reply={reply} disabled={disabled} />;
        }
        return (
            <>
                <ul class="step-list">{tasks.map((t, i) => <li key={i}>{displayText(t.text).text}{t.periodLabel && <span class="ink-2"> · {t.periodLabel}</span>}</li>)}</ul>
                <Replies replies={[ "Move all to today", "Let's review them", "Skip the catch-up" ]} reply={reply} disabled={disabled} />
            </>
        );
    }

    if (step.ritual === "winddown" && step.step === "open") {
        const items: FateItem[] = (Array.isArray(d.items) ? d.items : []).map((it: any) => ({
            text: displayText(String(it.text ?? "")).text,
            proposal: fateLabel(it.fate),
            options: [ "Done", it.fate?.forwardLabel ? `${shortDay(it.fate.forwardLabel)} · On deck` : "Next workday · On deck", it.fate?.forwardLabel ? `${shortDay(it.fate.forwardLabel)} · list` : "Next workday · list", "Next week", "Drop" ]
        }));
        return <FateList items={items} reply={reply} disabled={disabled} />;
    }

    if (step.ritual === "plan" && step.step === "inputs") {
        const onDeck: FateItem[] = (Array.isArray(d.onDeck) ? d.onDeck : []).map((it: any) => ({
            text: displayText(String(it.text ?? "")).text,
            proposal: it.fate?.list ? "On the list" : it.fate?.week ? "Up to the week" : fateLabel(it.fate),
            options: [ "On the list", "Stay on deck", "Up to the week", "Drop" ]
        }));
        const candidates: { text: string; because?: string; minutes?: number }[] = Array.isArray(d.candidates) ? d.candidates : [];
        return (
            <>
                {d.yesterday?.sentence && <p class="step-note ink-2">{d.yesterday.sentence}</p>}
                {onDeck.length > 0 && <FateList items={onDeck} reply={reply} disabled={disabled} withoutFoot />}
                {candidates.length > 0 && <Candidates items={candidates} reply={reply} disabled={disabled} />}
                <Replies replies={[ "Looks right", "Nothing tonight" ]} reply={reply} disabled={disabled} />
            </>
        );
    }

    if (step.step === "next") {
        const candidates: { text: string; because?: string; minutes?: number }[] = Array.isArray(d.candidates) ? d.candidates : [];
        return (
            <>
                {d.capacity?.sentence && <p class="step-note">{d.capacity.sentence}</p>}
                {d.summary && <p class="step-note ink-2">{d.summary}</p>}
                {candidates.length > 0 && <Candidates items={candidates} reply={reply} disabled={disabled} />}
                <Replies replies={[ "Nothing tonight", "Looks right" ]} reply={reply} disabled={disabled} />
            </>
        );
    }

    if (step.step === "context") {
        const lines: { text: string; untilLabel?: string }[] = Array.isArray(d.context) ? d.context : [];
        return (
            <>
                {lines.length > 0 && (
                    <ul class="step-list">
                        {lines.map((l, i) => (
                            <li key={i} class="context-line">
                                <span>{displayText(l.text).text}{l.untilLabel && <span class="mono ink-2"> until {l.untilLabel}</span>}</span>
                                <span class="chip-row">
                                    <Chip disabled={disabled} onClick={() => reply(`Keep "${l.text}".`)}>Keep</Chip>
                                    <Chip disabled={disabled} onClick={() => reply(`Let "${l.text}" end.`)}>Let it end</Chip>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <Replies replies={[ "Nothing to add", "Write it" ]} reply={reply} disabled={disabled} />
            </>
        );
    }

    return <Replies replies={[ "Looks right" ]} reply={reply} disabled={disabled} />;
}

/** Leftovers with their proposed fate as a chip; a tap cycles the fate, and Looks right adds the exceptions to the reply as one sentence. */
function FateList({ items, reply, disabled, withoutFoot }: { items: FateItem[]; reply: (text: string) => void; disabled: boolean; withoutFoot?: boolean }) {
    const [ changed, setChanged ] = useState<Record<number, string>>({});
    const [ reason, setReason ] = useState<Record<number, string>>({});
    const cycle = (i: number) => {
        const item = items[i];
        const current = changed[i] ?? item.proposal;
        const at = item.options.indexOf(current);
        const next = item.options[(at + 1) % item.options.length];
        setChanged({ ...changed, [i]: next === item.proposal ? (undefined as unknown as string) : next });
    };
    const sentence = () => {
        const parts = Object.entries(changed).filter(([ , v ]) => v).map(([ k, v ]) => {
            const item = items[Number(k)];
            if (v === "Drop") {
                return `drop "${item.text}"${reason[Number(k)] ? `: ${reason[Number(k)]}` : ""}`;
            }
            return v === "Done" ? `"${item.text}" is done` : `"${item.text}" ${fatePhrase(v)}`;
        });
        return parts.length ? `${capitalize(parts.join("; "))}. The rest as you said.` : "Looks right.";
    };
    return (
        <>
            <ul class="fate-list">
                {items.map((item, i) => {
                    const fate = changed[i] ?? item.proposal;
                    return (
                        <li key={i}>
                            <span class="fate-text">{item.text}</span>
                            <Chip selected={!!changed[i]} disabled={disabled} onClick={() => cycle(i)}>{fate}</Chip>
                            {fate === "Drop" && (
                                <input class="field fate-reason" placeholder="Why?" value={reason[i] ?? ""} disabled={disabled}
                                    onInput={(e) => setReason({ ...reason, [i]: (e.target as HTMLInputElement).value })} />
                            )}
                        </li>
                    );
                })}
            </ul>
            {!withoutFoot && (
                <div class="step-foot">
                    <Button kind="primary" disabled={disabled} onClick={() => reply(sentence())}>Looks right</Button>
                    <Button kind="quiet" disabled={disabled} onClick={() => reply("All of them are done.")}>All done</Button>
                </div>
            )}
            {withoutFoot && Object.values(changed).some(Boolean) && (
                <div class="step-foot">
                    <Button kind="primary" disabled={disabled} onClick={() => reply(sentence())}>Add the changes</Button>
                </div>
            )}
        </>
    );
}

function Candidates({ items, reply, disabled }: { items: { text: string; because?: string; minutes?: number }[]; reply: (text: string) => void; disabled: boolean }) {
    return (
        <div class="candidates">
            <div class="label-caps">New since yesterday</div>
            {items.map((c, i) => (
                <div key={i} class="candidate">
                    <p>{displayText(c.text).text}{c.minutes ? <span class="mono ink-2"> ~{formatEstimate(c.minutes)}</span> : null}</p>
                    {c.because && <p class="ink-2 candidate-why">because {c.because}</p>}
                    <div class="chip-row">
                        <Chip disabled={disabled} onClick={() => reply(`Take "${c.text}".`)}>Take</Chip>
                        <Chip disabled={disabled} onClick={() => reply(`Not today for "${c.text}".`)}>Not today</Chip>
                        <Chip disabled={disabled} onClick={() => reply(`Dismiss "${c.text}".`)}>Dismiss</Chip>
                        <Chip disabled={disabled} onClick={() => reply(`"${c.text}" is finished.`)}>Finished</Chip>
                    </div>
                </div>
            ))}
            <p class="ink-2 candidate-why">Left alone, they go to Suggested.</p>
        </div>
    );
}

function Replies({ replies, reply, disabled }: { replies: string[]; reply: (text: string) => void; disabled: boolean }) {
    return (
        <div class="chip-row replies">
            {replies.map((r) => <Chip key={r} disabled={disabled} onClick={() => reply(r)}>{r}</Chip>)}
        </div>
    );
}

function fateLabel(fate: any): string {
    if (!fate || typeof fate !== "object") {
        return "Leave it";
    }
    if (fate.done) return "Done";
    if (fate.drop || fate.cancel) return "Drop";
    if (fate.forward) return `${shortDay(fate.forwardLabel ?? fate.forward)} · ${fate.onDeck ? "On deck" : "list"}`;
    if (fate.week) return "Up to the week";
    if (fate.month) return "Month";
    if (fate.list) return "On the list";
    return "Leave it";
}

/** A fate chip as words in his reply: `Thu · On deck` → `to Thu's On deck`, `Thu · list` → `on Thu's list`. */
function fatePhrase(fate: string) {
    const [ day, place ] = fate.split(" · ");
    if (place === "On deck") return `to ${day}'s On deck`;
    if (place === "list") return `on ${day}'s list`;
    if (fate === "On the list") return "on today's list";
    if (fate === "Stay on deck") return "stays on deck";
    if (fate === "Up to the week" || fate === "Next week") return fate === "Next week" ? "to next week" : "up to the week";
    return `to ${fate}`;
}

function shortDay(label: string) {
    return String(label).split(" ")[0];
}

function capitalize(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
