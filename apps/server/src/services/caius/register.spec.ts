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
    // Each conversation is one question set, then one apply call that makes every write.
    expect(sheet).toContain("For `Wind down` and `Plan my day` openers, follow only this section.");
    expect(sheet).toContain("call `caius_plan_apply` **once**");
    expect(sheet).toContain("call `caius_winddown_apply` **once**");
    expect(sheet).toContain("Send **one message**");
    for (const rule of [
        "Call him \"you\", never \"Shawn\".",
        "Use the date strings the step data gives (the `…Label` fields) as they are. Never work out a weekday.",
        "Map a day he names to one of `data.days` (a week to `data.weeks`, a month to `data.months`); never compute a date.",
        "\"Later this week\" is the week ref `w1` in `data.days`, and \"next week\" is `w2`: never a date.",
        "Name each item in an answer by its `ref` from the step data (`o1`, `c1`, `l1`, `x1`, `d1`) or by his own words: a ticket key or its number (\"101\"), or a distinctive word (\"the bag\")",
        "A ref holds only for the reply it came in; after an apply, name items by his words.",
        "the heavy-day move question (if any)",
        "Ask only what the steps' `question` fields ask, in their words: a question answered once for a day, in this conversation or an earlier one, is not in them, so never ask it again.",
        "On `catchup: \"review\"`, run Wind down for `data.oldestDay` in this conversation, then come back to Plan my day",
        "and the heavy-day move as suggested",
        "Never ask permission for anything the apply tool does.",
        "Never claim a write that isn't in the result: its `say` is the whole recap.",
        "After the apply, reply with the result's `say`, then the headline and the top pick, and nothing else.",
        "After the apply, reply with the result's `say` and nothing else.",
        "Never narrate tools, ids, protocol or data quality.",
        "A vague reply (\"fine\", \"yeah\") accepts the proposals as offered",
        "Never write \"still\", \"outstanding\", \"unanswered\", \"waiting\", \"no reply\" or \"haven't answered\".",
        "Only \"drop\", \"cancel\" or \"not doing\" drops a task or dismisses a candidate; anything vaguer (\"skip that\", \"not now\") is `notToday`",
        "Never offer to drop a Context line.",
        "Ask about a Context line only when the step data returns it in `data.carry` (Plan my day) or `data.noticed` (Wind down)",
        "never ask whether it still holds, whether to keep it or whether to carry it",
        "Once he says to stop, never ask about it again",
        "Map \"first\", \"after 105\" or \"before the report\" onto the accept's `first`, `before` or `after`",
        "Never refuse a reorder he asks for",
        "\"Put X first\" or \"X after Y\", at any point in the conversation, even after the plan is written, is one `caius_plan_apply` call with only `move`: no `brief`, nothing else.",
        "name his work in the order of his list as this call leaves it",
        "Never mention ids, steps, tools, arrays, fields, permissions or \"the wrong value\"",
        "An evening calendar event is not a task",
        "`say` names the skip (\"Call Mom is already on the calendar\")",
        "In these conversations only these tools are available",
        "| `caius_planday` | Plan my day's steps: `catchup`, `inputs`. |",
        "| `caius_winddown_apply` | Wind down's one write. |",
        "State capacity only from the step's `data.capacity`",
        "When the apply answers with `nextCall`, call it at once, in this conversation: `caius_planday` for its `date`, from step `catchup`, without waiting for another press or another word from him.",
        "Pass `answered` to its `inputs` step: what he already said about the evening (even nothing) and the lines he said to keep, so it doesn't ask them again.",
        "Never ask what else to do when the step returns no candidates",
        "say so when the day is half booked or more",
        "The Meetings block is yours: the apply writes it from the calendar. Never ask about updating it",
        "Lines you write into his notes (Context, evening tasks, drop reasons) are in his voice or neutral",
        "Use `move` only when he asks for an order",
        "On an `edited` skip, run the same apply call once more with the same answers, each item named by his words",
        "If a Caius tool fails, say so in one clause and stop that item.",
        "Never run Plan my day for a future day."
    ]) expect(sheet, rule).toContain(rule);
    // The opener conversations have only the step and apply tools, so their section names no other.
    const openers = sheet.slice(sheet.indexOf("## Wind down and Plan my day"), sheet.indexOf("## Reading results"));
    for (const name of [
        "caius_plan", "caius_open", "caius_explain", "caius_inputs", "caius_context", "caius_add", "caius_accept", "caius_dismiss",
        "caius_set_state", "caius_forward", "caius_assign_ids", "caius_context_add", "caius_context_keep", "caius_meetings",
        "caius_brief_write", "caius_header", "caius_skip_catchup", "caius_finished"
    ]) expect(openers, name).not.toMatch(new RegExp(`${name}(?![a-z_])`));
    expect(openers).not.toContain("generic note tools");
    for (const old of [ "and \"Anything for the evening?\"", "map it to the ids in the step data", "Name the other item by its `listItemId`", "No recap after an apply", "Add one more short line", "one short line that the day is closed", "Dry run first, and wait for a yes", "`caius_brief_write` with `data.shape`", "droppedPicks", "caius_context_keep` and `date: data.keepDate" ]) {
        expect(sheet, old).not.toContain(old);
    }
    expect(sheet).not.toMatch(/Shawn(?!\")/);

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
