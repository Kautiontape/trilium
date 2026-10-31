import "./quick_add.css";

import { useEffect, useRef, useState } from "preact/hooks";

import { addDays, addMonths, addWeeks, dayLabel, monthLabel, nextWorkdayKey, weekLabel, weekOf } from "../lib/day.js";
import type { CaptureTarget } from "../lib/local.js";
import { capture, defaultCaptureTarget, outbox, snack, today } from "../lib/store.js";
import { Button, Chip, closeSheet, haptic, SheetTitle } from "./ui.js";

const ESTIMATES = [ "15m", "20m", "30m", "1h", "2h" ];

/**
 * Capture in two taps: type, Add. The default target is today's On deck (the next workday's once
 * today is wound down or past the end of work), where Plan my day sorts it. A day named in the text
 * ("thu", "next week") is offered as a chip and never taken silently; `~20m` sets the estimate.
 * Offline, the capture waits in the outbox.
 */
export function QuickAdd() {
    const data = today.value;
    const fallback = data ? defaultCaptureTarget(data) : null;
    const [ text, setText ] = useState("");
    const [ target, setTarget ] = useState<CaptureTarget | null>(fallback);
    const [ est, setEst ] = useState<string | undefined>(undefined);
    const [ sending, setSending ] = useState(false);
    const [ result, setResult ] = useState<string | null>(null);
    const [ picking, setPicking ] = useState(false);
    const input = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        input.current?.focus();
    }, []);

    if (!data || !target) {
        return (
            <>
                <SheetTitle title="Add a task" />
                <p class="ink-2">Caius hasn't said what today is yet. Connect first.</p>
            </>
        );
    }

    const typedEst = /(?:^|\s)~(\d+(?:h\d+m|h|m))\b/i.exec(text)?.[1]?.toLowerCase();
    const words = text.replace(/(?:^|\s)~\d+(?:h\d+m|h|m)\b/i, "").trim();
    const hint = dayHint(words, data.key);
    const estimate = est ?? typedEst;
    /** With the hint's chip taken, the day word leaves the task's text. */
    const taskText = hint && sameTarget(target, hint.target) ? words.replace(hint.word, "").replace(/\s{2,}/g, " ").trim() : words;
    const onDeckDay = fallback?.kind === "onDeck" ? fallback.date : data.key;

    const submit = async () => {
        if (!words) {
            return;
        }
        setSending(true);
        const outcome = await capture(taskText, target, estimate);
        setSending(false);
        if (outcome.status === "duplicate") {
            setResult(outcome.detail ? `Already open: ${outcome.detail.replace(/^already open in /, "")}` : "Already open.");
            return;
        }
        if (outcome.status === "failed") {
            setResult(outcome.detail ?? "Caius didn't take it.");
            return;
        }
        haptic("confirm");
        closeSheet();
        snack.value = outcome.status === "waiting"
            ? { text: `Saved on the phone. It goes to the server when it's back (${outbox.value.length} waiting).` }
            : { text: `Added to ${targetLabel(target, data.key)}.` };
    };

    return (
        <div class="quick-add">
            <SheetTitle title="Add a task" />
            <textarea
                ref={input}
                class="field quick-add-text"
                rows={2}
                placeholder="What is it?"
                value={text}
                onInput={(e) => {
                    setText((e.target as HTMLTextAreaElement).value);
                    setResult(null);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void submit();
                    }
                }}
            />
            <div class="label-caps">Goes to</div>
            <div class="chip-row">
                <Chip selected={target.kind === "onDeck" && target.date === onDeckDay} onClick={() => setTarget({ kind: "onDeck", date: onDeckDay })}>
                    On deck · {onDeckDay === data.key ? "today" : dayLabel(onDeckDay)}
                </Chip>
                <Chip selected={target.kind === "list"} onClick={() => setTarget({ kind: "list", date: data.key })}>Today's list</Chip>
                <Chip selected={target.kind === "critical"} onClick={() => setTarget({ kind: "critical", date: data.key })}>Critical</Chip>
                {hint && (
                    <Chip selected={sameTarget(target, hint.target)} onClick={() => setTarget(hint.target)}>{hint.label}?</Chip>
                )}
                <Chip selected={picking} onClick={() => setPicking(!picking)}>Pick…</Chip>
            </div>
            {picking && (
                <input class="field" type="date" min={data.key} aria-label="Pick a day"
                    onInput={(e) => {
                        const value = (e.target as HTMLInputElement).value;
                        if (value) {
                            setTarget({ kind: "day", date: value });
                        }
                    }} />
            )}
            {target.kind === "list" && sections(data).length > 1 && (
                <div class="chip-row">
                    {sections(data).map((name) => (
                        <Chip key={name} selected={target.section === name} onClick={() => setTarget({ kind: "list", date: data.key, section: name })}>{name}</Chip>
                    ))}
                </div>
            )}
            <div class="label-caps">Estimate</div>
            <div class="chip-row">
                {ESTIMATES.map((e) => <Chip key={e} selected={estimate === e} onClick={() => setEst(est === e ? undefined : e)}>{e}</Chip>)}
            </div>
            {result && <p class="quick-add-result">{result}</p>}
            <footer class="quick-add-foot">
                <span class="ink-2">{footLine(target, data.key)}</span>
                <Button kind="primary" disabled={!words || sending} onClick={() => void submit()}>Add</Button>
            </footer>
        </div>
    );
}

function sections(data: NonNullable<typeof today.value>) {
    return data.plan.sections.map((s) => s.name).filter((n): n is string => !!n && !/^(meetings|context|on deck)$/i.test(n));
}

function sameTarget(a: CaptureTarget, b: CaptureTarget) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** A day the text names, offered as a chip: `thu`, `tomorrow`, `next week`, `next month`. */
export function dayHint(text: string, todayKey: string): { label: string; target: CaptureTarget; word: RegExp } | null {
    const lower = ` ${text.toLowerCase()} `;
    if (/\snext week\s/.test(lower)) {
        const week = addWeeks(weekOf(todayKey), 1);
        return { label: weekLabel(week).split(" · ")[0], target: { kind: "week", week }, word: /\bnext week\b/i };
    }
    if (/\snext month\s/.test(lower)) {
        const month = addMonths(todayKey.slice(0, 7), 1);
        return { label: monthLabel(month), target: { kind: "month", month }, word: /\bnext month\b/i };
    }
    if (/\stomorrow\s/.test(lower)) {
        const date = addDays(todayKey, 1);
        return { label: dayLabel(date), target: { kind: "onDeck", date }, word: /\btomorrow\b/i };
    }
    const days = [ "sun", "mon", "tue", "wed", "thu", "fri", "sat" ];
    const match = /\s(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\s/.exec(lower);
    if (!match) {
        return null;
    }
    const want = days.indexOf(match[1]);
    let date = addDays(todayKey, 1);
    for (let i = 0; i < 7 && new Date(`${date}T12:00:00`).getDay() !== want; i++) {
        date = addDays(date, 1);
    }
    return { label: dayLabel(date), target: { kind: "onDeck", date }, word: new RegExp(`\\b${match[0].trim()}\\b`, "i") };
}

function targetLabel(target: CaptureTarget, todayKey: string) {
    switch (target.kind) {
        case "onDeck": return target.date === todayKey ? "today's On deck" : `${dayLabel(target.date)}'s On deck`;
        case "list": return target.section ? `today's ${target.section}` : "today's list";
        case "critical": return "today's Important";
        case "week": return weekLabel(target.week).split(" · ")[0];
        case "month": return monthLabel(target.month);
        case "day": return dayLabel(target.date);
    }
}

function footLine(target: CaptureTarget, todayKey: string) {
    if (target.kind === "onDeck") {
        return target.date === nextWorkdayKey(todayKey) || target.date !== todayKey
            ? `Lands on ${dayLabel(target.date)}'s On deck.`
            : "Lands on On deck. Plan my day sorts it.";
    }
    return `Lands on ${targetLabel(target, todayKey)}.`;
}
