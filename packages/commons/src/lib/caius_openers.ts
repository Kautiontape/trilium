/**
 * The openers that start a Caius conversation in the AI chat: the first user message, a kind and a
 * date. The server reads the kind from it to give the agent Caius's prompt and tools.
 */

/** A Caius conversation: the Plan my day and Wind down rituals, or questions about the Journal. */
export type CaiusConversation = "plan" | "winddown" | "ask";

/** The first message of a Caius conversation, in the words the `caius` skill sheet reads: `Plan my day 2026-11-04`. */
export function caiusOpener(kind: CaiusConversation, date: string): string {
    return `${OPENER_WORDS[kind]} ${date}`;
}

/** The conversation `text` opens, or `null` when it is not exactly an opener. */
export function caiusConversationOf(text: string): CaiusConversation | null {
    const match = OPENER.exec(text.trim());
    return match ? KINDS[match[1]] : null;
}

const OPENER_WORDS: Record<CaiusConversation, string> = {
    plan: "Plan my day",
    winddown: "Wind down",
    ask: "Ask"
};

const KINDS: Record<string, CaiusConversation> = Object.fromEntries(
    Object.entries(OPENER_WORDS).map(([ kind, words ]) => [ words, kind as CaiusConversation ])
);

const OPENER = /^(Plan my day|Wind down|Ask) \d{4}-\d{2}-\d{2}$/;
