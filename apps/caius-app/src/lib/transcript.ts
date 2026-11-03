import type { CaiusEffort } from "@triliumnext/commons/src/lib/caius_openers.js";

import type { ChatKind, StoredMessage } from "./chat.js";

/** A tool result longer than this is cut, so one big read doesn't bury the conversation. */
export const RESULT_LIMIT = 2000;

const KIND_NAMES: Record<ChatKind, string> = { plan: "Plan my day", winddown: "Wind down", ask: "Ask" };

/**
 * The whole conversation as plain text, to share for review: a header, then every message in
 * order. His messages already carry the step cards' answers as the sentences Caius read, so they
 * are printed as sent. Caius's notes (thinking) are marked as such; tool calls show their input
 * in full and their result cut at `RESULT_LIMIT`.
 */
export function chatTranscript({ kind, date, effort, appVersion, exportedAt, messages }: {
    kind: ChatKind;
    date: string;
    effort: CaiusEffort;
    appVersion?: string;
    exportedAt: Date;
    messages: StoredMessage[];
}): string {
    const lines = [
        `Caius chat: ${KIND_NAMES[kind]}, ${date}`,
        ...(appVersion ? [ `App version: ${appVersion}` ] : []),
        `Effort: ${effort}`,
        `Exported: ${exportedAt.toISOString()}`,
        ""
    ];

    for (const message of messages) {
        const at = message.createdAt ? ` (${message.createdAt})` : "";
        if (message.type === "thinking") {
            lines.push(`--- Caius's notes (thinking)${at} ---`, String(message.content), "");
        } else if (message.type === "error") {
            lines.push(`--- Error${at} ---`, String(message.content), "");
        } else if (message.role === "user") {
            lines.push(`--- Shawn${at} ---`, String(message.content), "");
        } else if (typeof message.content === "string") {
            lines.push(`--- Caius${at} ---`, message.content, "");
        } else {
            lines.push(`--- Caius${at} ---`);
            for (const block of message.content) {
                if (block.type === "text") {
                    lines.push(block.content);
                } else if (block.type === "tool_call") {
                    const { toolName, input, result, isError } = block.toolCall;
                    lines.push(`[tool call] ${toolName} ${JSON.stringify(input)}`);
                    if (result !== undefined) {
                        const cut = result.length > RESULT_LIMIT ? `${result.slice(0, RESULT_LIMIT)}… [cut, ${result.length} chars in all]` : result;
                        lines.push(`[tool result${isError ? ", error" : ""}] ${cut}`);
                    }
                }
            }
            lines.push("");
        }
    }
    return lines.join("\n").trimEnd() + "\n";
}
