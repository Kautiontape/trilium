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
        "\"Later this week\" and \"this week\" are the week ref `w1` in `data.days`, and \"next week\" is `w2`: never a date.",
        "Name each item in an answer by its `ref` from the step data (such as `o3fa9c` or `d1`) or by his own words: a ticket key or its number (\"101\"), or a distinctive word (\"the bag\")",
        "When `say` ends with a which-question, the items it names stay open until he answers; his answer is one more apply call naming them.",
        "A ref names the same item for the whole conversation. One whose item changed since the step is skipped as `stale`: ask him about that item in one clause.",
        "the heavy-day move question (if any)",
        "Ask only what the steps' `question` fields need answered: a question answered once for a day, in this conversation or an earlier one, is not in them, so never ask it again.",
        "On `catchup: \"review\"`, run Wind down for `data.oldestDay` in this conversation, then come back to Plan my day",
        "When the catch-up step asks about held items (`data.held`), one he says is done goes in `finished`; anything else he says about them is `catchup: \"review\"`.",
        "Never ask permission for anything the apply tool does.",
        "Never claim a write that isn't in the result: its `say` is the whole recap of the apply.",
        "After the apply, reply with the result's `say`, then the headline and the top pick, and nothing else.",
        "After the apply, reply with the result's `say` and nothing else, but for one sentence when the result's `load.over` is true and you didn't already say the day was over before the apply",
        "Once he said to do it anyway, don't say it again.",
        "Open the message with how the day went, as the Voice section says: no scripted question, and no preamble of your own about what follows",
        "When it answers `duplicate`, the task already exists: find it with `caius_open` or `caius_plan` and `caius_forward` it to that day",
        "Never narrate tools, ids, protocol or data quality.",
        "Never write \"still\", \"outstanding\", \"unanswered\", \"waiting\", \"no reply\" or \"haven't answered\".",
        "Only \"drop\", \"cancel\" or \"not doing\" drops a task or dismisses a candidate; anything vaguer (\"skip that\", \"not now\") is `notToday`",
        "Never offer to drop a Context line.",
        "Ask about a Context line only when the step data returns it in `data.carry` (Plan my day) or `data.noticed` (Wind down)",
        "never ask whether it still holds, whether to keep it or whether to carry it",
        "Once he says to stop, never ask about it again",
        "Map \"first\", \"after 105\" or \"before the report\" onto the accept's `first`, `before` or `after`",
        "Never refuse a reorder he asks for",
        "\"Put X first\" or \"X after Y\", at any point in the conversation, even after the plan is written, is one `caius_plan_apply` call with `said` and only `move`: no `brief`, no other answer.",
        "Whenever a move changes the order of the picks, send a fresh `headline` with it, in the new order, and `groups` when the move changes which work belongs together.",
        "his whole list as this call leaves it: his own tasks, the catch-up's tasks moved in, On deck items put on it and the candidates taken, cut into 1 to 6 runs of related work",
        "On a day already under way the step gives `data.planFrom`: the drawing lays his work out from there, never in the part of the day already past.",
        "Never mention ids, steps, tools, arrays, fields, permissions or \"the wrong value\"",
        "Foundation is the day job and has no marker: an unmarked line is Foundation.",
        "You may suggest a Growth or Recharge task for the afternoon when it fits better there (an errand with a deadline); never suggest work in the Evening.",
        "Foundation is the only area that counts toward the day's work.",
        "| `caius_set_area` |",
        "`asOffered` never takes a pick: only his word does.",
        "`data.unmarked` lists tasks on his list with no marker, no Jira key and no area heading",
        "A `foundation` answer writes nothing and the task isn't asked about again.",
        "never ask \"anything for the evening?\"",
        "Every Caius tool is available, with the note reads and `search_notes`; the generic note tools that write are off",
        "Each ritual has a goal, and the steps below are the default path to it",
        "Say capacity as the step's `data.capacity.sentence`, `data.load.sentence` or `summary` puts it, in gist",
        "Never work out or round a figure of your own",
        "When the apply answers with `planday`, a morning Review of an older day closed it against today, and Plan my day's `catchup` and `inputs` steps have already run for today",
        "Never ask whether to plan or whether to write the brief, and never call those steps again.",
        "Never ask what else to do when the step returns no candidates",
        "say so when the day is half booked or more",
        "The Meetings block is yours: the apply writes it from the calendar. Never ask about updating it",
        "Lines you write into his notes (Context, drop reasons) are in his voice or neutral",
        "A Context line skipped as `third_person` is not written: reword it in his voice and call the same apply again with `said` and only that line in `context`, no `brief`, then reply.",
        "Use `move` only when he asks for an order",
        "On an `edited` skip, run the same apply call once more with the same answers",
        "If a Caius tool fails, say so in one clause and stop that item.",
        "The day is whatever the step data says; never compare it with any other date you know; always call the step first.",
        "At the end of a wind-down, never offer to run Plan my day for another day.",
        "A day that hasn't started is planned only on his say-so: only the step says a day is later than today, by answering `not_today`.",
        "Never pass `early` on your own."
    ]) expect(sheet, rule).toContain(rule);
    // A guide, not a script: an ask off the path is answered in the same conversation with the right tool.
    const openers = sheet.slice(sheet.indexOf("## Wind down and Plan my day"), sheet.indexOf("## Reading results"));
    for (const name of [ "caius_add", "caius_inputs", "caius_plan", "caius_forward", "caius_assign_ids", "search_notes" ]) {
        expect(openers, name).toMatch(new RegExp(`${name}(?![a-z_])`));
    }
    expect(openers).toContain("Never tell him to start a new chat for it, and never tell him a tool is switched off.");
    expect(openers).toContain("Never pass it to the apply tool, and never move anything he didn't name.");
    expect(openers).toContain("call `search_notes` yourself and say what you found");
    expect(openers).toContain("when a step or apply answer has `warnings`, end the message with each warning as given");
    // What holds while he flexes, and the pushback.
    for (const rule of [
        "One fate per leftover", "Nothing lands untracked", "Write only what he said.", "is a dry run first, shown to him, and written on his yes",
        "Push back when an ask undoes the goal, then do what he decides.",
        "When the answer to his question depends on data", "Never state a guess as fact",
        "When `load.over` is true", "split it, or send it up to the week to sort out when he plans", "It is advice: when he says to do it anyway, do it",
        "`caius_add` to that day, with `onDeck: true` when he would like to do it then",
        "\"need to\", \"have to\", \"must\" put it on that day's list",
        "`data.onDeck` is the day's On deck", "Every item he doesn't name takes its proposed fate, so none stays on deck.",
        "yesterday in a sentence from `data.yesterday`"
    ]) expect(openers, rule).toContain(rule);
    // Who he is comes first, and the tools' words stay factual.
    expect(sheet.indexOf("## Who you are")).toBeLessThan(sheet.indexOf("## The Journal"));
    expect(sheet).toContain("You are Caius, the planner for his Journal, and you speak in the first person.");
    expect(sheet).toContain("The apply's `say` stays as it is; the steps' `question` and `summary` are what you cover in your own words.");
    expect(sheet).not.toContain("stay as they are; your voice is in what you write around them");
    expect(sheet).toContain("Never quote the game or play the character.");
    for (const old of [ "A ref holds only for the reply it came in", "and \"Anything for the evening?\"", "`data.evening` is the evening", "eveningAnswered: true", "map it to the ids in the step data", "Name the other item by its `listItemId`", "No recap after an apply", "Add one more short line", "one short line that the day is closed", "Dry run first, and wait for a yes", "`caius_brief_write` with `data.shape`", "droppedPicks", "caius_context_keep` and `date: data.keepDate" ]) {
        expect(sheet, old).not.toContain(old);
    }
    expect(sheet).not.toMatch(/Shawn(?!")/);

    unregister();
    expect(readSkill("caius")).toBeNull();
});

it("speaks in a rundown that leads into the cards, in gist, never reading a question out", () => {
    const sheet = sheetOnce();
    const voice = sheet.slice(sheet.indexOf("## Voice"), sheet.indexOf("## The Journal"));
    expect(voice).toContain("Say \"you\" and \"I\", in plain words");
    for (const step of [
        "How the day went, naming two or three real things he finished.",
        "What didn't happen and where you put it, as a phrase, not a list",
        "The next day's shape in gist, by area: work first, then Growth and Recharge.",
        "A last line that leads into the cards below the message."
    ]) expect(voice, step).toContain(step);
    expect(voice).toContain("Plan my day has the same shape in the morning: yesterday in a sentence, today's shape by area, then a last line into the cards.");
    expect(voice).toContain("the message never repeats a card's items");
    expect(voice).toContain("It is one sentence, never a run of questions");
    expect(voice).toContain("Before you send, check the message: three short paragraphs at most; no more than two items named in all");
    expect(voice).toContain("The step's `question` is what it needs answered: cover it in your own words, in the rundown or its last line, and do not read it out.");
    expect(voice).toContain("**The gist, not the data.**");
    expect(voice).toContain("A time, a number, a key or a name goes in only when he has to act on it, such as a deadline or a meeting to prepare for");
    expect(voice).toContain("> Good Monday: the hills shipped and Trilium was bumped to a newer version. A couple of work things didn't happen; they're on Tuesday's deck.\n>\n> Tuesday's light in the morning, with a couple of meetings in the afternoon. The ballot's due by 8 pm, so I'd put it first in your evening, or in the afternoon if there's a gap.\n>\n> The rest is below; change anything before I close the day.");
    // Nothing tells Caius to ask the question word for word or to start with it.
    for (const old of [ "in their words", "Start the message with its first question or item", "Ask every question a step's `question` holds", "stay as they are" ]) expect(sheet, old).not.toContain(old);
});

it("writes the brief in the plan's first turn when there is nothing to ask, after a Review as after the bar", () => {
    const sheet = sheetOnce();
    expect(sheet).toContain("When no step has a question and `data.candidates` is empty, there is nothing to ask: send no message. Call `caius_plan_apply` at once with `said: \"\"` and the brief's prose and `groups`, then reply as step 4 says.");
    expect(sheet).toContain("With nothing to ask in `planday`, call `caius_plan_apply` at once, as Plan my day's step 2 says, and reply with the wind-down's `say`, then the plan's `say`, headline and top pick.");
    expect(sheet).toContain("Never ask whether to plan or whether to write the brief");
    expect(sheet).not.toContain("then take his reply to `caius_plan_apply` (its step 3). Never ask whether to plan");
});

it("has no evening question: Growth and Recharge picks take its place, and a thing for the evening is added with an area", () => {
    const sheet = sheetOnce();
    expect(sheet).toContain("`data.candidates` holds the picks for all three areas side by side.");
    expect(sheet).toContain("A Growth or Recharge pick (`kind: \"project\"`) is an hour of an active project, `Caius: the fate menu`, with `because` \"it's one of your active projects\".");
    expect(sheet).toContain("They replace any question about the evening: offer them as you offer the others, and never ask \"anything for the evening?\".");
    expect(sheet).toContain("it is written with its marker under Evening, or under the `block` he names");
    expect(sheet).toContain("add it with `caius_add` (`area`, `block: \"evening\"`); the `evening` answer is retired and the apply skips it.");
    expect(sheet).toContain("The evening has no question and no suggestion of its own.");
    expect(sheet).toContain("Cover everything a step's `question` holds, in your own words: never fold one into a summary of what there is nothing to decide, such as \"no leftovers to decide on\".");
    expect(sheet).not.toContain("`data.evening`");
    expect(sheet).not.toContain("eveningAnswered");
});

it("parks a stale item only on his word, and keeps a personal errand out of the headline", () => {
    const sheet = sheetOnce();
    expect(sheet).toContain("An item with `park` has been carried on three workdays or more, and the `open` question asks to park it in that month. Only his word parks it: pass its fate with `to` set to `park.month`. Without it, the item goes on as proposed.");
    expect(sheet).toContain("His yes to the park question (\"yes\", \"park it\", \"sure\") is that fate: pass it. The tool parks nothing from his words alone: a bare yes without the month fate is a `check`, and a call that answers otherwise leaves the item on its proposed fate.");
    expect(sheet).toContain("The headline names his first work task: never a Growth or Recharge task when work is on his list. The tool writes your headline as you send it");
});

it("maps his yes onto asOffered or the fields, since the tool writes nothing from his words alone", () => {
    const sheet = sheetOnce();
    expect(sheet).toContain("Map his yes or fine onto the call: `asOffered: true` for everything offered (the Foundation candidates in the order shown, every keep or carry line, but never a Growth or Recharge pick), or the specific fields for what it answers. The heavy-day move is a `forward` with the suggestion's `listItemId` and `to`, and a park is the item's month fate: `asOffered` makes neither. The tool writes nothing from his words alone: a bare yes or fine with neither is a `check`. Never read a yes as a skip.");
    expect(sheet).not.toContain("accepts the proposals as offered");
    expect(sheet).toContain("A bare yes to a set with one yes/no question in it (the park, the heavy-day move, a keep line) answers that question only: pass its field alone, without `asOffered`.");
});

/** The sheet's text, read while the skill is registered for that read alone. */
function sheetOnce(): string {
    const unregister = registerCaiusSkill();
    try {
        return readSkill("caius") ?? "";
    } finally {
        unregister();
    }
}

it("registers the caius skill when the tools load, and not when they fail to", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await loadCaiusTools(() => Promise.reject(new Error("boom")));
    expect(listSkills().map((s) => s.name)).not.toContain("caius");

    await loadCaiusTools(async () => ({ caiusTools: defineTools({}) }));
    expect(listSkills().map((s) => s.name)).toContain("caius");

    registerCaiusSkill()();
});
