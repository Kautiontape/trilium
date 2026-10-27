import type { NoteStore } from "@triliumnext/caius";
import { becca, cls, getSql, sql_init } from "@triliumnext/core";
import { noteTools } from "@triliumnext/core/src/services/llm/tools/index.js";
import { registerToolRegistryLoader } from "@triliumnext/core/src/services/llm/tools/registration.js";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../mcp/mcp_server.js";
import sql from "../sql.js";
import { loadCaiusTools } from "./register.js";
import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const store = createBeccaStore();
const callOptions = { toolCallId: "t", messages: [] } as never;

registerToolRegistryLoader(() => loadCaiusTools());

/** Entity change ids the commit hook handed to the clients, as `ws.sendTransactionEntityChangesToAllClients()` does. */
const sent: number[] = [];
type Hooks = { onTransactionCommit: () => void; onTransactionRollback: () => void };
let hooks: Hooks;
let setupHooks: Hooks;

beforeAll(async () => {
    await sql_init.dbReady;
    hooks = (getSql() as unknown as { params: Hooks }).params;
    setupHooks = { ...hooks };

    // The hooks of `apps/server/src/core_init.ts`, which spec/setup.ts replaces with no-ops.
    hooks.onTransactionCommit = () => {
        void import("@triliumnext/core").then(({ cls }) => {
            sent.push(...cls.getAndClearEntityChangeIds());
        });
    };
    hooks.onTransactionRollback = () => {
        void import("@triliumnext/core").then(({ cls, becca_loader, entity_changes }) => {
            if (cls.getAndClearEntityChangeIds().length > 0) {
                becca_loader.load();
            }
            entity_changes.recalculateMaxEntityChangeId();
        });
    };

    await cls.init(async () => {
        await store.calendarDay("2032-01-01");
        const [root] = await store.search("#calendarRoot");
        if (!root) {
            throw new Error("The calendar has no root note");
        }
        await store.addLabel(root.noteId, "enableWeekNote", "");
    });
});

afterAll(() => Object.assign(hooks, setupHooks));

afterEach(() => vi.restoreAllMocks());

/** Lets the hooks' deferred imports run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function connect() {
    const server = await createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
    const [content] = result.content as { type: string; text: string }[];
    expect(result.isError, content?.text).toBeFalsy();
    return JSON.parse(content?.text ?? "null");
}

async function dayNote(date: string, html: string): Promise<string> {
    return cls.init(async () => {
        const note = await store.calendarDay(date);
        await store.putContent(note.noteId, html);
        return note.noteId;
    });
}

/** Runs a wrapped tool the way the chat route does: inside a CLS context of its own. */
function inContext<T>(values: Record<string, string>, fn: () => T): T {
    return cls.init(() => {
        for (const [key, value] of Object.entries(values)) {
            cls.set(key, value);
        }
        return fn();
    });
}

describe("caius tools under concurrent calls", () => {
    it("applies two caius_add calls made in the same tick to the same day note", async () => {
        const client = await connect();
        const date = "2032-01-05";
        const add = (text: string) => client.callTool({ name: "caius_add", arguments: { items: [{ date, section: "Work", text }] } });

        const results = await Promise.all([add("First same-tick task"), add("Second same-tick task")]);

        for (const result of results) {
            expect(parse(result).results[0]).toMatchObject({ status: "added" });
        }
        const html = await store.content(parse(results[0]).results[0].writtenNoteId);
        expect(html).toContain("First same-tick task");
        expect(html).toContain("Second same-tick task");
    });

    it("skips a write as edited when a sync tool changes the note after the read", async () => {
        const noteId = await dayNote("2032-01-06", `<h3>Work</h3>${ul(li("a1", "Existing task"))}`);
        const noteSet = noteTools.toToolSet();
        let inject = true;
        const racing: NoteStore = {
            ...store,
            async putContent(id, html, expected) {
                if (inject) {
                    inject = false;
                    inContext({}, () => noteSet.set_note_content.execute?.({ noteId: id, content: "Edited by hand" }, callOptions));
                }
                return store.putContent(id, html, expected);
            }
        };
        const caiusSet = createCaiusTools(racing).toToolSet();

        const result = await inContext({}, () => caiusSet.caius_add.execute?.({ items: [{ date: "2032-01-06", section: "Work", text: "Racing task" }] }, callOptions));

        expect(result.results[0]).toMatchObject({ status: "skipped", reason: "edited" });
        const html = await store.content(noteId);
        expect(html).toContain("Edited by hand");
        expect(html).not.toContain("Racing task");
    });

    it("sends the earlier items' changes to the clients when a later item's write throws", async () => {
        const first = await dayNote("2032-01-07", "<h3>Work</h3>");
        const second = await dayNote("2032-01-08", "<h3>Work</h3>");
        await settle();
        sent.length = 0;
        vi.spyOn(becca.getNoteOrThrow(second), "setContent").mockImplementation(() => {
            throw new Error("disk full");
        });
        const caiusSet = createCaiusTools(store).toToolSet();

        const result = await inContext({}, () => caiusSet.caius_add.execute?.({
            items: [
                { date: "2032-01-07", section: "Work", text: "Item one" },
                { date: "2032-01-08", section: "Work", text: "Item two" }
            ]
        }, callOptions));
        await settle();

        expect(result.results.map((r: { status: string }) => r.status)).toEqual(["added", "failed"]);
        const changed = sent.length
            ? sql.getColumn<string>(`SELECT entityId FROM entity_changes WHERE entityName = 'notes' AND id IN (${sent.join(",")})`)
            : [];
        expect(changed).toContain(first);
        expect(await store.content(first)).toContain("Item one");
    });

    it("keeps a note a sync tool created in the same tick as an async tool that failed", async () => {
        const noteSet = noteTools.toToolSet();
        const failing = defineTools({
            test_caius_write_then_throw: {
                description: "test only",
                inputSchema: z.object({}),
                async: true,
                mutates: true,
                execute: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    throw new Error("caius failed");
                }
            }
        }).toToolSet();

        const [caius, created] = await Promise.allSettled([
            inContext({}, () => failing.test_caius_write_then_throw.execute?.({}, callOptions)),
            inContext({}, () => noteSet.create_note.execute?.({ parentNoteId: "root", title: "Created beside a failing call", content: "", type: "text" }, callOptions))
        ]);
        await settle();

        expect(caius.status).toBe("rejected");
        expect(created.status).toBe("fulfilled");
        const { noteId } = (created as PromiseFulfilledResult<{ noteId: string }>).value;
        expect(sql.getValue("SELECT COUNT(*) FROM notes WHERE noteId = ? AND isDeleted = 0", [noteId])).toBe(1);
        expect(becca.notes[noteId]).toBeDefined();
    });

    it("runs queued calls one after another, each in its own CLS context", async () => {
        await dayNote("2032-02-01", "<h3>Work</h3>");
        const events: string[] = [];
        const recording: NoteStore = {
            ...store,
            async search(query, ancestorNoteId) {
                events.push(cls.getComponentId() ?? "none");
                await new Promise((resolve) => setImmediate(resolve));
                return store.search(query, ancestorNoteId);
            }
        };
        const caiusSet = createCaiusTools(recording).toToolSet();

        const [a, b, c] = await Promise.all([
            inContext({ componentId: "caller-a", localNowDateTime: "2032-02-01 09:00:00.000+0000" },
                () => caiusSet.caius_add.execute?.({ items: [{ date: "2032-02-01", section: "Work", text: "From caller a" }] }, callOptions)),
            inContext({ componentId: "caller-b", localNowDateTime: "2032-02-02 09:00:00.000+0000" },
                () => caiusSet.caius_plan.execute?.({ period: "day" }, callOptions)),
            inContext({ componentId: "caller-c", localNowDateTime: "2032-02-03 09:00:00.000+0000" },
                () => caiusSet.caius_add.execute?.({ items: [{ date: "2032-02-03", section: "Work", text: "From caller c" }] }, callOptions))
        ]);

        expect(events.filter((e, i) => e !== events[i - 1])).toEqual(["caller-a", "caller-b", "caller-c"]);
        expect(b.key).toBe("2032-02-02");
        const lastComponent = (noteId: string) =>
            sql.getValue("SELECT componentId FROM entity_changes WHERE entityName = 'notes' AND entityId = ? ORDER BY id DESC LIMIT 1", [noteId]);
        expect(lastComponent(a.results[0].writtenNoteId)).toBe("caller-a");
        expect(lastComponent(c.results[0].writtenNoteId)).toBe("caller-c");
    });

    it("does not let a rejected call block the next one", async () => {
        let fail = true;
        const flaky: NoteStore = {
            ...store,
            async search(query, ancestorNoteId) {
                if (fail) {
                    fail = false;
                    throw new Error("search failed");
                }
                return store.search(query, ancestorNoteId);
            }
        };
        const caiusSet = createCaiusTools(flaky).toToolSet();

        const [first, second] = await Promise.allSettled([
            inContext({}, () => caiusSet.caius_open.execute?.({}, callOptions)),
            inContext({}, () => caiusSet.caius_open.execute?.({}, callOptions))
        ]);

        expect(first.status).toBe("rejected");
        expect(second.status).toBe("fulfilled");
    });
});
