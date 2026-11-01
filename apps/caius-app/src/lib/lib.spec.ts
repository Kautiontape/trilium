import { describe, expect, it } from "vitest";

import { applyChunk, type AssistantTurn, type ChatChunk, opener, sseParser, stepOf, turnText } from "./chat.js";
import { normalizeServerUrl } from "./connection.js";
import { addMonths, addWeeks, dayLabel, mondayOf, nextWorkdayKey, parseMeeting, periodLabel, relativePeriod, weekLabel, weekOf } from "./day.js";
import { McpError, parseToolReply } from "./mcp.js";
import { originView, type TaskOrigin } from "./origin.js";
import { parseRemindMe, parseWhen, whenLabel } from "./remind.js";

describe("parseToolReply", () => {
    const framed = (message: object) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

    it("reads the tool's JSON out of an SSE-framed JSON-RPC reply", () => {
        const body = framed({ jsonrpc: "2.0", id: 7, result: { content: [ { type: "text", text: "{\"key\":\"2026-11-04\"}" } ] } });
        expect(parseToolReply(body, 7)).toEqual({ key: "2026-11-04" });
        expect(parseToolReply(JSON.stringify({ id: 1, result: { content: [ { type: "text", text: "[1,2]" } ] } }))).toEqual([ 1, 2 ]);
    });

    it("turns a tool error and a protocol error into an McpError without the MCP prefix", () => {
        const toolError = framed({ id: 1, result: { isError: true, content: [ { type: "text", text: "MCP error -32602: expected string at date" } ] } });
        expect(() => parseToolReply(toolError, 1)).toThrow(new McpError("expected string at date"));
        expect(() => parseToolReply(framed({ id: 1, error: { code: -1, message: "nope" } }), 1)).toThrow("nope");
        expect(() => parseToolReply("", 1)).toThrow("no answer");
    });
});

describe("sseParser and applyChunk", () => {
    it("assembles a turn from chunks split anywhere, ignoring heartbeats", () => {
        const chunks: ChatChunk[] = [];
        const feed = sseParser((data) => chunks.push(JSON.parse(data)));
        const wire = [
            ": heartbeat\n\n",
            "data: {\"type\":\"text\",\"content\":\"Here's \"}\n\ndata: {\"type\":\"te",
            "xt\",\"content\":\"what's left.\"}\n\n",
            "data: {\"type\":\"tool_use\",\"toolCallId\":\"t1\",\"toolName\":\"caius_winddown\",\"toolInput\":{\"step\":\"open\"}}\r\n\r\n",
            "data: {\"type\":\"tool_result\",\"toolCallId\":\"t1\",\"toolName\":\"caius_winddown\",\"result\":\"{\\\"step\\\":\\\"open\\\",\\\"question\\\":\\\"Which are done?\\\",\\\"data\\\":{\\\"items\\\":[]}}\"}\n\n",
            "data: {\"type\":\"done\"}\n\n"
        ];
        for (const part of wire) {
            feed(part);
        }
        expect(chunks.map((c) => c.type)).toEqual([ "text", "text", "tool_use", "tool_result", "done" ]);

        let turn: AssistantTurn = { id: "a", blocks: [], done: false };
        for (const chunk of chunks) {
            turn = applyChunk(turn, chunk);
        }
        expect(turn.done).toBe(true);
        expect(turnText(turn.blocks)).toBe("Here's what's left.");
        const call = turn.blocks.find((b) => b.type === "tool_call");
        expect(call?.type === "tool_call" && stepOf(call.toolCall)).toEqual({
            ritual: "winddown", step: "open", question: "Which are done?", data: { items: [] }, dateLabel: undefined
        });
    });

    it("finds a step in a prefixed tool name or an MCP envelope, and none in a failure or another tool", () => {
        const step = JSON.stringify({ step: "catchup", question: "Move all?", data: {} });
        const envelope = JSON.stringify({ content: [ { type: "text", text: step } ] });
        expect(stepOf({ id: "1", toolName: "mcp__trilium__caius_planday", input: {}, result: envelope })?.ritual).toBe("plan");
        expect(stepOf({ id: "1", toolName: "caius_planday", input: {}, result: step, isError: true })).toBeNull();
        expect(stepOf({ id: "1", toolName: "caius_plan", input: {}, result: step })).toBeNull();
        expect(stepOf({ id: "1", toolName: "caius_planday", input: {}, result: "not json" })).toBeNull();
    });

    it("writes the openers the server's check reads", () => {
        expect(opener("plan", "2026-11-04")).toBe("Plan my day 2026-11-04");
        expect(opener("winddown", "2026-11-04")).toBe("Wind down 2026-11-04");
        expect(opener("ask", "2026-11-04")).toBe("Ask 2026-11-04");
    });
});

describe("day keys", () => {
    it("names and steps days, weeks and months", () => {
        expect(dayLabel("2026-11-04")).toBe("Wed 4 Nov");
        expect(nextWorkdayKey("2026-11-06")).toBe("2026-11-09");
        expect(weekOf("2026-11-04")).toBe("2026-W45");
        expect(weekOf("2027-01-01")).toBe("2026-W53");
        expect(mondayOf("2026-W45")).toBe("2026-11-02");
        expect(addWeeks("2026-W53", 1)).toBe("2027-W01");
        expect(weekLabel("2026-W44")).toBe("Week 44 · 26 Oct – 1 Nov");
        expect(addMonths("2026-12", 1)).toBe("2027-01");
        expect(periodLabel("2026-11")).toBe("November 2026");
        expect(periodLabel("2026-W45")).toBe("Week of Mon 2 Nov");
        expect(relativePeriod("2026-10-31", "2026-10-31")).toEqual({ name: "Today", detail: "Sat 31 Oct" });
        expect(relativePeriod("2026-11-01", "2026-10-31")).toEqual({ name: "Tomorrow", detail: "Sun 1 Nov" });
        expect(relativePeriod("2026-11-04", "2026-10-31")).toEqual({ name: "Wed 4 Nov", detail: null });
        expect(relativePeriod("2026-W44", "2026-10-31")).toEqual({ name: "This week", detail: "26 Oct – 1 Nov" });
        expect(relativePeriod("2026-W45", "2026-10-31")).toEqual({ name: "Next week", detail: "2 – 8 Nov" });
        expect(relativePeriod("2026-W47", "2026-10-31")).toEqual({ name: "Week of Mon 16 Nov", detail: null });
        expect(relativePeriod("2026-10", "2026-10-31")).toEqual({ name: "This month", detail: "October" });
        expect(relativePeriod("2026-11", "2026-10-31")).toEqual({ name: "Next month", detail: "November" });
    });

    it("reads a Meetings bullet with or without an end", () => {
        expect(parseMeeting("09:30 Standup")).toEqual({ start: "09:30", end: "10:00", title: "Standup" });
        expect(parseMeeting("14:00–15:30 Design review")).toEqual({ start: "14:00", end: "15:30", title: "Design review" });
        expect(parseMeeting("Lunch")).toBeNull();
    });
});

describe("remind me", () => {
    const now = new Date(2026, 10, 4, 14, 2);

    it("reads the time and the task in either order", () => {
        expect(parseRemindMe("Remind me at 3 to call the pharmacy", now)).toEqual({ at: new Date(2026, 10, 4, 15, 0), text: "Call the pharmacy" });
        expect(parseRemindMe("remind me to water the plants at 6pm.", now)).toEqual({ at: new Date(2026, 10, 4, 18, 0), text: "Water the plants" });
        expect(parseRemindMe("remind me in 20 minutes to stretch", now)?.at).toEqual(new Date(2026, 10, 4, 14, 22));
        expect(parseRemindMe("remind me to send the invoice tomorrow", now)?.at).toEqual(new Date(2026, 10, 5, 9, 30));
        expect(parseRemindMe("what should I work on now?", now)).toBeNull();
    });

    it("takes the next occurrence of a bare hour", () => {
        expect(parseWhen("at 9", now)).toEqual(new Date(2026, 10, 4, 21, 0));
        expect(parseWhen("13:00", now)).toEqual(new Date(2026, 10, 5, 13, 0));
        expect(parseWhen("tomorrow at 9", now)).toEqual(new Date(2026, 10, 5, 9, 0));
        expect(parseWhen("soon", now)).toBeNull();
    });

    it("labels a reminder's time relative to today", () => {
        expect(whenLabel(new Date(2026, 10, 4, 15, 0), now)).toBe("Today 15:00");
        expect(whenLabel(new Date(2026, 10, 5, 9, 30), now)).toBe("Tomorrow 09:30");
        expect(whenLabel(new Date(2026, 10, 9, 10, 30), now)).toBe("Mon 9 Nov 10:30");
    });
});

describe("normalizeServerUrl", () => {
    it("adds https, drops trailing slashes and refuses what isn't http", () => {
        expect(normalizeServerUrl("trilium.example.net/")).toBe("https://trilium.example.net");
        expect(normalizeServerUrl("http://10.0.2.2:8080")).toBe("http://10.0.2.2:8080");
        expect(normalizeServerUrl("https://example.net/trilium/")).toBe("https://example.net/trilium");
        expect(normalizeServerUrl("ftp://example.net")).toBeNull();
        expect(normalizeServerUrl("  ")).toBeNull();
    });
});

describe("addTarget", () => {
    it("gives every capture exactly one placement, as caius_add requires", async () => {
        const { addTarget } = await import("./store.js");
        const targets = [
            { kind: "onDeck", date: "2026-11-04" },
            { kind: "list", date: "2026-11-04" },
            { kind: "list", date: "2026-11-04", section: "Work" },
            { kind: "critical", date: "2026-11-04" },
            { kind: "week", week: "2026-W46" },
            { kind: "month", month: "2026-12" },
            { kind: "day", date: "2026-11-09" }
        ] as const;
        for (const target of targets) {
            const item = addTarget(target) as Record<string, unknown>;
            expect([ "section", "critical", "onDeck" ].filter((k) => item[k] !== undefined)).toHaveLength(1);
        }
        expect(addTarget({ kind: "list", date: "2026-11-04" })).toEqual({ date: "2026-11-04", section: "☑️ Tasks" });
    });
});

describe("withDay", () => {
    it("runs at once with a day, and holds an action from a cold start until Today has been read", async () => {
        const { runWaiting, withDay } = await import("../app-state.js");
        const ran: string[] = [];
        withDay((day) => ran.push(`now ${day}`), "2026-11-04");
        withDay((day) => ran.push(`plan ${day}`), undefined);
        withDay((day) => ran.push(`skip ${day}`), undefined);
        expect(ran).toEqual([ "now 2026-11-04" ]);
        runWaiting("2026-11-05");
        runWaiting("2026-11-05");
        expect(ran).toEqual([ "now 2026-11-04", "plan 2026-11-05", "skip 2026-11-05" ]);
    });
});

describe("originView", () => {
    const origin = (o: Partial<TaskOrigin> = {}): TaskOrigin => ({
        noteId: "meet", title: "2026-08-11 Pilot call", date: "2026-08-11", headings: [ "Follow-ups" ], parent: null,
        neighbours: [ "Confirm the price per seat" ], lead: "Before the next call.", matched: true, ...o
    });

    it("shows a copy's source: its title, its heading, the items beside it and the lead", () => {
        expect(originView(origin(), "day")).toEqual({
            noteId: "meet", heading: "2026-08-11 Pilot call", place: "under Follow-ups", neighbours: [ "Confirm the price per seat" ], lead: "Before the next call."
        });
        expect(originView(origin({ title: "Pilot call" }), "day")?.heading).toBe("Pilot call · 2026-08-11");
        expect(originView(origin({ date: "Tue 28 Apr", title: "28 - Tuesday" }), "day")?.heading).toBe("Tue 28 Apr");
    });

    it("names the parent of a nested task, and only the title of a reworded copy", () => {
        expect(originView(origin({ noteId: "day", parent: "Prepare the release" }), "day"))
            .toEqual({ noteId: "day", heading: null, place: "part of: Prepare the release", neighbours: [], lead: null });
        expect(originView(origin({ date: "2026-10-31" }), "day")?.heading).toBe("2026-08-11 Pilot call");
        expect(originView(origin({ matched: false, headings: [], neighbours: [], lead: null }), "day"))
            .toMatchObject({ place: null, neighbours: [], lead: null });
    });

    it("shows nothing without an origin, or for a task written where it is under no other item", () => {
        expect(originView(undefined, "day")).toBeNull();
        expect(originView(null, "day")).toBeNull();
        expect(originView(origin({ noteId: "day" }), "day")).toBeNull();
    });
});
