import { cls, options as optionService } from "@triliumnext/core";
import type { Application } from "express";
import supertest from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import config from "../../src/services/config.js";
import { registerServerLlmExtensions } from "../../src/services/llm/index.js";
import { login } from "./utils.js";

const queryMock = vi.hoisted(() => vi.fn());

// Only the Agent SDK and the CLI lookup are faked: the route, `runChat` and `ClaudeAgentProvider`
// are the real ones, so a request the route lets through is classified by the provider itself.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("../../src/services/llm/providers/claude_binary.js", () => ({ resolveClaudeBinaryPath: async () => "/usr/bin/claude" }));

let app: Application;
let token: string;

const OPENER = { type: "text", text: "Ask 2026-11-04" };

describe("Caius phone chat gate, end to end through the Claude agent provider", () => {
    beforeAll(async () => {
        config.General.noAuthentication = false;
        const buildApp = (await import("../../src/app.js")).default;
        app = await buildApp();
        // Startup (`www.ts`) registers the host providers and the Caius tools; `buildApp` does not.
        registerServerLlmExtensions();
        token = await login(app);
        cls.init(() => {
            optionService.setOption("aiEnabled", "true");
            optionService.setOption("llmProviders", JSON.stringify([ { id: "agent1", name: "Claude", provider: "claude-agent", apiKey: "" } ]));
        });
    });

    beforeEach(() => {
        queryMock.mockReset();
        queryMock.mockImplementation(() => fakeQuery());
    });

    it("runs an accepted opener as a Caius conversation, with the generic note writes locked out", async () => {
        for (const content of [ "Ask 2026-11-04", [ OPENER ], "Wind down 2026-11-04" ]) {
            await turn([ { role: "user", content } ]).expect(200);
        }
        const chats = agentSessions();
        expect(chats).toHaveLength(3);
        for (const options of chats) {
            expect(options.disallowedTools).toEqual(expect.arrayContaining([ "mcp__trilium__set_note_content", "mcp__trilium__create_note" ]));
            expect(options.systemPrompt).toContain("You are Caius");
            expect(options.allowedTools).not.toContain("WebSearch");
        }
    });

    it("refuses the payloads the provider would not treat as Caius's, so none reaches it", async () => {
        for (const content of [
            [ { type: "text", text: "Ask " }, { type: "text", text: "2026-11-04" } ],
            [ OPENER, { type: "image", attachmentId: "a1", mime: "image/png" } ],
            [ OPENER, OPENER ]
        ]) {
            const res = await turn([ { role: "user", content } ]).expect(400);
            expect(res.body.error).toBe("not_a_caius_opener");
        }
        expect(queryMock).not.toHaveBeenCalled();
    });
});

async function newChatNote(): Promise<string> {
    const res = await supertest(app).post("/etapi/special-notes/llm-chat").set("Authorization", token).expect(201);
    return res.body.noteId as string;
}

async function turnBody(messages: object[]) {
    return { messages, config: { chatNoteId: await newChatNote() } };
}

function turn(messages: object[]) {
    return {
        expect: async (status: number) => supertest(app).post("/etapi/llm-chat/stream").set("Authorization", token)
            .send(await turnBody(messages)).expect(status)
    };
}

/** The options of every agent session the chat turns started (title generation passes no MCP server). */
function agentSessions(): { disallowedTools?: string[]; systemPrompt: string; allowedTools: string[] }[] {
    return queryMock.mock.calls.map(([ arg ]) => arg.options).filter((options) => options?.mcpServers);
}

/** A stand-in for the SDK's Query that ends the turn at once. */
function fakeQuery() {
    const generator = (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
    return Object.assign(generator, { setModel: vi.fn(), close: vi.fn() });
}
