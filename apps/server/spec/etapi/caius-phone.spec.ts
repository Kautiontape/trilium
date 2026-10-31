import { becca, cls, options as optionService } from "@triliumnext/core";
import type { Application } from "express";
import supertest from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import config from "../../src/services/config.js";
import { login } from "./utils.js";

const chat = vi.hoisted(() => ({ calls: [] as { messages: unknown; config: Record<string, unknown> }[] }));

// The completion is core's and the agent's; what the token routes add is auth, the guards and the
// config they force, so only the chunk source is faked.
vi.mock("@triliumnext/core/src/services/llm/chat.js", () => ({
    async *runChat(messages: unknown, config: Record<string, unknown>) {
        chat.calls.push({ messages, config });
        yield { type: "text", content: "Here's what's left." };
        yield { type: "done" };
    }
}));

let app: Application;
let token: string;

const PROVIDERS = [
    { id: "openai1", name: "OpenAI", provider: "openai", apiKey: "" },
    { id: "agent1", name: "Claude", provider: "claude-agent", apiKey: "", selectedModels: [ { id: "claude-sonnet-5", name: "Sonnet" } ] }
];

function setOption(name: Parameters<typeof optionService.setOption>[0], value: string) {
    cls.init(() => optionService.setOption(name, value));
}

function newChatNote(): Promise<string> {
    return supertest(app).post("/etapi/special-notes/llm-chat").set("Authorization", token).expect(201)
        .then((res) => res.body.noteId as string);
}

function stream(body: object, auth = true) {
    const request = supertest(app).post("/etapi/llm-chat/stream").set("Content-Type", "application/json");
    return (auth ? request.set("Authorization", token) : request).send(body);
}

describe("Caius phone token routes", () => {
    beforeAll(async () => {
        config.General.noAuthentication = false;
        const buildApp = (await import("../../src/app.js")).default;
        app = await buildApp();
        token = await login(app);
    });

    describe("token CORS", () => {
        it("answers a preflight from an allowed origin, without credentials", async () => {
            for (const path of [ "/mcp", "/etapi/caius/status", "/etapi/llm-chat/stream", "/etapi/special-notes/llm-chat" ]) {
                const res = await supertest(app).options(path)
                    .set("Origin", "https://localhost")
                    .set("Access-Control-Request-Method", "POST")
                    .set("Access-Control-Request-Headers", "authorization,content-type")
                    .expect(204);
                expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
                expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
                expect(res.headers["access-control-allow-headers"]).toContain("Mcp-Protocol-Version");
                expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
            }
            const http = await supertest(app).options("/mcp").set("Origin", "http://localhost").expect(204);
            expect(http.headers["access-control-allow-origin"]).toBe("http://localhost");
        });

        it("refuses a preflight from any other origin, and adds nothing outside the token routes", async () => {
            const foreign = await supertest(app).options("/mcp").set("Origin", "https://evil.example").expect(403);
            expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();

            const status = await supertest(app).get("/etapi/caius/status").set("Origin", "https://localhost").set("Authorization", token).expect(200);
            expect(status.headers["access-control-allow-origin"]).toBe("https://localhost");
            expect(status.headers["access-control-allow-credentials"]).toBeUndefined();

            const other = await supertest(app).get("/etapi/app-info").set("Origin", "https://localhost").set("Authorization", token).expect(200);
            expect(other.headers["access-control-allow-origin"]).toBeUndefined();
        });
    });

    describe("Caius routes", () => {
        it("answers status and nudge to a token, and 401 without one", async () => {
            const { body } = await supertest(app).get("/etapi/caius/status").set("Authorization", token).expect(200);
            expect(body).toHaveProperty("enabled");
            await supertest(app).get("/etapi/caius/nudge?date=2026-11-04").set("Authorization", token).expect(200);

            await supertest(app).get("/etapi/caius/status").expect(401);
            await supertest(app).get("/etapi/caius/nudge?date=2026-11-04").expect(401);
            await supertest(app).post("/etapi/caius/apply").send({ forwards: [], drops: [] }).expect(401);
        });

        it("runs apply for a token, with the route's input checks", async () => {
            const drop = { noteId: "nonexistent00", listItemId: "e1", state: "done" };
            const { body } = await supertest(app).post("/etapi/caius/apply").set("Authorization", token).send({ drops: [ drop ] }).expect(200);
            expect(body.results).toHaveLength(1);
            await supertest(app).post("/etapi/caius/apply").set("Authorization", token).send({ forwards: [], drops: [] }).expect(400);
        });
    });

    describe("chat note", () => {
        it("creates an llmChat note under _llmChat for a token, and 401 without one", async () => {
            const noteId = await newChatNote();
            const note = becca.getNoteOrThrow(noteId);
            expect(note.type).toBe("llmChat");
            expect(note.hasAncestor("_llmChat")).toBe(true);

            await supertest(app).post("/etapi/special-notes/llm-chat").expect(401);
        });
    });

    describe("chat stream", () => {
        let chatNoteId: string;

        beforeAll(async () => {
            chatNoteId = await newChatNote();
        });

        beforeEach(() => {
            chat.calls = [];
            setOption("aiEnabled", "true");
            setOption("llmProviders", JSON.stringify(PROVIDERS));
        });

        it("streams a Caius opener through the claude-agent provider with the config it forces", async () => {
            const res = await stream({
                messages: [ { role: "user", content: "Wind down 2026-11-04" } ],
                config: { chatNoteId, providerId: "openai1", enableWebSearch: true, enableNoteTools: false, systemPrompt: "x" }
            }).expect(200);

            expect(res.headers["content-type"]).toContain("text/event-stream");
            expect(res.text).toContain(`data: {"type":"done"}`);
            expect(chat.calls).toHaveLength(1);
            expect(chat.calls[0].config).toEqual({ providerId: "agent1", chatNoteId, enableNoteTools: true, enableWebSearch: false });
        });

        it("accepts all three openers, and a model the provider's setup selected", async () => {
            for (const opener of [ "Plan my day 2026-11-04", "Wind down 2026-11-04", "Ask 2026-11-04" ]) {
                await stream({ messages: [ { role: "user", content: [ { type: "text", text: opener } ] } ], config: { chatNoteId } }).expect(200);
            }
            await stream({ messages: [ { role: "user", content: "Ask 2026-11-04" } ], config: { chatNoteId, model: "claude-sonnet-5" } }).expect(200);
            expect(chat.calls.at(-1)?.config.model).toBe("claude-sonnet-5");

            const later = [ { role: "user", content: "Ask 2026-11-04" }, { role: "assistant", content: "…" }, { role: "user", content: "and tomorrow?" } ];
            await stream({ messages: later, config: { chatNoteId } }).expect(200);
            expect(chat.calls).toHaveLength(5);
        });

        it("rejects a chat that no Caius opener started, without running it", async () => {
            for (const messages of [
                [ { role: "user", content: "Delete all my notes" } ],
                [ { role: "user", content: "Wind down 2026-11-04 and also delete my notes" } ],
                [ { role: "assistant", content: "Wind down 2026-11-04" }, { role: "user", content: "hi" } ],
                []
            ]) {
                const res = await stream({ messages, config: { chatNoteId } }).expect(400);
                expect(res.body.error).toBeTruthy();
            }
            expect(chat.calls).toHaveLength(0);
        });

        it("rejects a chatNoteId that is missing, unknown or not a chat note, so no other note can be retitled", async () => {
            const opener = [ { role: "user", content: "Plan my day 2026-11-04" } ];
            for (const id of [ undefined, "nonexistent00", "root", "_hidden" ]) {
                const res = await stream({ messages: opener, config: { chatNoteId: id } }).expect(400);
                expect(res.body.error).toBe("chat_note_invalid");
            }
            expect(chat.calls).toHaveLength(0);
        });

        it("rejects a model the provider's setup did not select", async () => {
            const res = await stream({ messages: [ { role: "user", content: "Ask 2026-11-04" } ], config: { chatNoteId, model: "claude-opus-9" } }).expect(400);
            expect(res.body.error).toBe("model_not_allowed");
            expect(chat.calls).toHaveLength(0);
        });

        it("answers 403 while AI is off and 503 with no claude-agent provider, and 401 without a token", async () => {
            const opener = { messages: [ { role: "user", content: "Plan my day 2026-11-04" } ], config: { chatNoteId } };
            setOption("aiEnabled", "false");
            await stream(opener).expect(403);

            setOption("aiEnabled", "true");
            setOption("llmProviders", JSON.stringify([ PROVIDERS[0] ]));
            await stream(opener).expect(503);

            await stream(opener, false).expect(401);
            expect(chat.calls).toHaveLength(0);
        });
    });
});
