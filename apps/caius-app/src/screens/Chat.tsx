import "./chat.css";

import { KeepAwake } from "@capacitor-community/keep-awake";
import { formatEstimate } from "@triliumnext/caius/src/daily/format.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { addReminder } from "../components/sheets.js";
import { displayText } from "../components/TaskRow.js";
import { Button, Chip, haptic, Icon } from "../components/ui.js";
import { ritual } from "../app-state.js";
import { applyChunk, type AssistantTurn, chatApi, type ChatKind, type ContentBlock, historyForServer, type LlmChatContent, NeedsServerUpdateError, opener, type RitualStep, stepOf, type StoredMessage, turnText } from "../lib/chat.js";
import { dayLabel } from "../lib/day.js";
import { parseRemindMe, whenLabel } from "../lib/remind.js";
import { type CandidateAnswer, type CandidateData, candidateDefault, type Choice, type ContextAnswer, type StepAnswers, type StepFate, stepReply } from "../lib/replies.js";
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

interface Chat {
    state: ChatState;
    messages: StoredMessage[];
    streaming: AssistantTurn | null;
    error: string | null;
    /** His next message as taps on step cards build it; the composer edits and sends it. */
    draft: string;
    setDraft: (text: string) => void;
    /** A live step card's sentences, under its own key; the draft is all of them, in card order. */
    report: (key: string, sentences: string[]) => void;
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
    const [ draft, setDraftState ] = useState("");
    const draftNow = useRef("");
    const setDraft = (text: string) => {
        draftNow.current = text;
        setDraftState(text);
    };
    const answers = useRef(new Map<string, string[]>());
    /** The draft as the cards last wrote it; once he edits the box, the cards stop overwriting it. */
    const generated = useRef("");
    const report = (key: string, sentences: string[]) => {
        answers.current.set(key, sentences);
        const next = [ ...answers.current.values() ].flat().join(" ");
        if (draftNow.current === generated.current || !draftNow.current.trim()) {
            setDraft(next);
        }
        generated.current = next;
    };
    const noteId = useRef<string | null>(null);
    const history = useRef<StoredMessage[]>([]);
    /** Bumped by New conversation and on close; a turn from an older conversation drops its reply. */
    const generation = useRef(0);
    const controller = useRef<AbortController | null>(null);

    useEffect(() => () => {
        generation.current++;
        controller.current?.abort();
    }, []);

    const turn = async (text: string) => {
        const conn = connection.value;
        const chatNoteId = noteId.current;
        if (!conn || !chatNoteId) {
            return;
        }
        const chats = chatApi(conn);
        const mine = generation.current;
        const abort = new AbortController();
        controller.current = abort;
        const user: StoredMessage = { id: newId(), role: "user", content: text, createdAt: new Date().toISOString() };
        history.current = [ ...history.current, user ];
        setMessages(history.current);
        setState("streaming");
        setError(null);
        answers.current.clear();
        generated.current = "";
        setDraft("");

        let assembled: AssistantTurn = { id: newId(), blocks: [], done: false };
        setStreaming(assembled);
        try {
            await chats.stream(historyForServer(history.current), chatNoteId, (chunk) => {
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
        history.current = [ ...history.current, reply ];
        setMessages(history.current);
        setStreaming(null);
        setError(assembled.error ?? null);
        if (assembled.error) {
            setDraft(text);
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
        generation.current++;
        controller.current?.abort();
        noteId.current = null;
        history.current = [];
        setMessages([]);
        setStreaming(null);
        setError(null);
        answers.current.clear();
        generated.current = "";
        setDraft("");
        setState(serverStatus.value === null ? "needs-update" : "idle");
    };

    return { state, messages, streaming, error, draft, setDraft, report, start, send, reset };
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
    // Caius's text streams as it is written; narration before a tool call is taken back and fades
    // out. The step cards wait for the turn to finish, so the turn reads from Caius's question down.
    const streaming = chat.streaming;
    const streamingText = !!streaming && turnText(streaming.blocks).trim() !== "";
    return (
        <div class="transcript" ref={box} aria-live="polite">
            {chat.messages.map((m, i) => (
                i === 0 && m.role === "user" ? null : <Message key={m.id} message={m} chat={chat} live={i === lastStepIndex && chat.state === "ready"} />
            ))}
            {streaming && (streamingText || streaming.fading) && <AssistantBlocks blocks={streaming.blocks} chat={chat} live={false} pending fading={streaming.fading} />}
            {(chat.state === "starting" || (streaming && !streamingText)) && (
                <p class="caius-thinking ink-2">{streaming?.blocks.some((b) => b.type === "tool_call") ? "Caius is writing…" : "Caius is reading the Journal…"}</p>
            )}
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
function AssistantBlocks({ blocks, chat, live, pending, fading }: { blocks: ContentBlock[]; chat: Chat; live: boolean; pending?: boolean; fading?: { key: number; text: string } }) {
    const steps = blocks.flatMap((b) => {
        const step = b.type === "tool_call" ? stepOf(b.toolCall) : null;
        return step && b.type === "tool_call" ? [ { id: b.toolCall.id, step } ] : [];
    });
    const text = turnText(blocks);
    return (
        <div class={`caius-turn${pending ? " pending" : ""}`}>
            {fading && <div key={fading.key} class="caius-retracted" aria-hidden="true"><CaiusText text={fading.text} /></div>}
            {text && <CaiusText text={text} withoutLists={steps.length > 0} />}
            {!pending && steps.map(({ id, step }) => (
                <StepCard key={id} id={id} step={step} chat={chat} live={live && !pending} askedInText={!!step.question && text.includes(step.question)} />
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
 * its data. Every item shows its fate as a chip, set to the step's own default until he taps it,
 * and the card writes its whole answer into the text box (`stepReply`), so the message he sends
 * names every item explicitly and he can still edit it. The agent does the judgment and the write.
 */
function StepCard({ id, step, chat, live, askedInText }: { id: string; step: RitualStep; chat: Chat; live: boolean; askedInText: boolean }) {
    const [ answers, setAnswers ] = useState<StepAnswers>({});
    const sentences = stepReply(step, answers);
    const joined = sentences.join(" ");
    // A layout effect, so the box holds the new sentence before the next paint and a quick Send never sends the old one.
    useLayoutEffect(() => {
        if (live) {
            chat.report(id, sentences);
        }
    }, [ live, joined ]);
    const update = (patch: Partial<StepAnswers>) => {
        haptic("tick");
        setAnswers({ ...answers, ...patch });
    };
    return (
        <section class={`step-card step-${step.ritual}`}>
            {step.question && !askedInText && <p class="step-question">{step.question}</p>}
            <StepBody step={step} answers={answers} update={update} disabled={!live} />
        </section>
    );
}

interface StepItem {
    text: string;
    fate?: StepFate;
}

function StepBody({ step, answers, update, disabled }: { step: RitualStep; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    const d = step.data as Record<string, any>;
    const kind = `${step.ritual}:${step.step}`;

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
                    <Button kind="quiet" disabled={disabled} onClick={() => update({ fates: Object.fromEntries(items.map((_, i) => [ i, { kind: "done" } ])) })}>All done</Button>
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
                <Evening tasks={d.evening?.tasks ?? []} answers={answers} update={update} disabled={disabled} />
            </>
        );
    }

    if (kind === "winddown:next") {
        return (
            <>
                {d.capacity?.sentence && <p class="step-note">{d.capacity.sentence}</p>}
                {d.summary && <p class="step-note ink-2">{d.summary}</p>}
                <Candidates items={Array.isArray(d.candidates) ? d.candidates : []} answers={answers} update={update} disabled={disabled} />
                <Evening tasks={d.evening?.tasks ?? []} answers={answers} update={update} disabled={disabled} />
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

/** Items with their fate as a chip, the step's proposal until he taps it; a tap moves to the next fate. Drop asks why. */
function FateList({ items, options, answers, update, disabled }: { items: StepItem[]; options: Choice[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    const choiceOf = (i: number): Choice => answers.fates?.[i] ?? { kind: "proposed" };
    const cycle = (i: number) => {
        const labels = options.map((o) => chipLabel(o, items[i].fate));
        const at = labels.indexOf(chipLabel(choiceOf(i), items[i].fate));
        let next = (at + 1) % options.length;
        // Skip a fate that reads the same as the proposal.
        while (next !== 0 && labels[next] === labels[0]) {
            next = (next + 1) % options.length;
        }
        update({ fates: { ...answers.fates, [i]: options[next] } });
    };
    return (
        <ul class="fate-list">
            {items.map((item, i) => {
                const choice = choiceOf(i);
                return (
                    <li key={i}>
                        <span class="fate-text">{displayText(item.text).text}</span>
                        <Chip selected={choice.kind !== "proposed"} disabled={disabled} onClick={() => cycle(i)}>{chipLabel(choice, item.fate)}</Chip>
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

/** A chip's short words for a fate: `Thu · On deck`, `Thu · list`, `Done`, `Week`. */
function chipLabel(choice: Choice, proposed: StepFate | undefined): string {
    const short = (label: string) => label.startsWith("the week") ? "Week" : label.split(" ")[0];
    switch (choice.kind) {
        case "proposed":
            if (!proposed || "held" in proposed) return "Stays";
            if ("done" in proposed) return "Done";
            if ("list" in proposed) return "On the list";
            if ("stay" in proposed) return "Stays";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(proposed.forward)) return short(proposed.forwardLabel ?? proposed.forward);
            return `${short(proposed.forwardLabel ?? proposed.forward)} · ${proposed.onDeck ? "On deck" : "list"}`;
        case "done": return "Done";
        case "day": return `${short(choice.label)} · ${choice.onDeck ? "On deck" : "list"}`;
        case "period": return short(choice.label);
        case "list": return "On the list";
        case "stay-deck": return "Stays on deck";
        case "drop": return "Drop";
    }
}

/** Candidates with Take / Not today / Dismiss / Finished, and what happens to each if he leaves it alone. */
function Candidates({ items, answers, update, disabled }: { items: (CandidateData & { minutes?: number; because?: string })[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    if (!items.length) {
        return null;
    }
    const set = (i: number, value: CandidateAnswer) => update({ candidates: { ...answers.candidates, [i]: answers.candidates?.[i] === value ? null : value } });
    const labels: [CandidateAnswer, string][] = [ [ "take", "Take" ], [ "notToday", "Not today" ], [ "dismiss", "Dismiss" ], [ "finished", "Finished" ] ];
    return (
        <div class="candidates">
            <div class="label-caps">New since yesterday</div>
            {items.map((c, i) => (
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

/** The evening: Nothing tonight, or the tasks already there. */
function Evening({ tasks, answers, update, disabled }: { tasks: string[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    return (
        <div class="chip-row replies">
            <span class="ink-2 evening-label">Evening{tasks.length ? `: ${tasks.join(", ")}` : ""}</span>
            <Chip disabled={disabled} selected={answers.evening === "nothing tonight"}
                onClick={() => update({ evening: answers.evening === "nothing tonight" ? null : "nothing tonight" })}>Nothing tonight</Chip>
        </div>
    );
}

function capitalize(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
