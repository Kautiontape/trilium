import { sql_init } from "@triliumnext/core";
import { registerToolRegistryLoader } from "@triliumnext/core/src/services/llm/tools/registration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { listSkills, readSkill } from "@triliumnext/core/src/services/llm/skills.js";
import { defineTools } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";

import { createMcpServer } from "../mcp/mcp_server.js";

import { loadCaiusTools, registerCaiusSkill } from "./register.js";

registerToolRegistryLoader(() => loadCaiusTools(() => Promise.reject(new Error("cannot import the library"))));

beforeAll(async () => {
    await sql_init.dbReady;
});

afterEach(() => vi.restoreAllMocks());

it("returns an empty registry and warns when the import fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry = await loadCaiusTools(() => Promise.reject(new Error("boom")));

    expect([...registry]).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Caius disabled: boom");
});

it("keeps every other tool listed when Caius fails to load", async () => {
    const server = await createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain("search_notes");
    expect(names.some((n) => n.startsWith("caius_"))).toBe(false);
});

it("offers the caius skill only while it is registered, and names every tool the sheet teaches", async () => {
    expect(listSkills().map((s) => s.name)).not.toContain("caius");

    const unregister = registerCaiusSkill();
    expect(listSkills().map((s) => s.name)).toContain("caius");
    const sheet = readSkill("caius") ?? "";
    const { caiusTools } = await import("./tools.js");
    for (const [name] of caiusTools) {
        expect(sheet, `the sheet should mention ${name}`).toContain(`\`${name}\``);
    }
    expect(sheet.split("\n").length).toBeGreaterThanOrEqual(80);
    // The openers follow only their own section, and no step lets the agent choose the main list.
    expect(sheet).toContain("For `Wind down` and `Plan my day` openers, follow only this section.");
    expect(sheet).not.toContain("until the day fits its capacity");
    expect(sheet).toContain("A null `question` means nothing to ask; still do the step's writes (dry run first)");
    expect(sheet).toContain("On \"keep\", write it again with `caius_context_add` to the next workday's week, `data.targetWeek`, not the closing week");
    expect(sheet).toContain("Add the candidates to that day's Suggested with `caius_add` and `suggested: true`");

    unregister();
    expect(readSkill("caius")).toBeNull();
});

it("registers the caius skill when the tools load, and not when they fail to", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await loadCaiusTools(() => Promise.reject(new Error("boom")));
    expect(listSkills().map((s) => s.name)).not.toContain("caius");

    await loadCaiusTools(async () => ({ caiusTools: defineTools({}) }));
    expect(listSkills().map((s) => s.name)).toContain("caius");

    registerCaiusSkill()();
});
