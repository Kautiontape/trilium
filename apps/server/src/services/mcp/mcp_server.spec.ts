import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted above the module-under-test import) ---

// Capture every (name, config, callback) passed to registerTool.
interface Registered {
    name: string;
    config: any;
    callback: (args: any) => any;
}
const registered: Registered[] = [];

class FakeMcpServer {
    constructor(public info: any) {}
    registerTool(name: string, config: any, callback: (args: any) => any) {
        registered.push({ name, config, callback });
        return { name };
    }
}

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: FakeMcpServer }));

const mockSql = {
    transactional: vi.fn((cb: () => unknown) => cb()),
    transactionalAsync: vi.fn(async (cb: () => Promise<unknown>) => cb())
};
vi.mock("../sql.js", () => ({ default: mockSql }));

const clsCalls: { init: number; set: Array<[string, unknown]> } = { init: 0, set: [] };
const mockCls = {
    init: vi.fn((cb: () => unknown) => {
        clsCalls.init++;
        return cb();
    }),
    set: vi.fn((key: string, value: unknown) => clsCalls.set.push([key, value]))
};

vi.mock("@triliumnext/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@triliumnext/core")>();
    return {
        ...actual,
        cls: mockCls,
        app_info: { ...actual.app_info, appVersion: "9.9.9-test" }
    };
});

// Two tools: one read-only, one mutating, so both branches of the ternary run.
const readExecute = vi.fn(() => ({ ok: "read" }));
const mutateExecute = vi.fn(() => ({ ok: "mutate" }));

const failExecute = vi.fn(() => ({ error: "Note not found" }));
const asyncReadExecute = vi.fn(async () => ({ ok: "async-read" }));
const asyncMutateExecute = vi.fn(async () => ({ ok: "async-mutate" }));
const asyncFailExecute = vi.fn(async () => ({ error: "Note not found" }));
const asyncRegistry: any = [
    ["async_read_tool", { description: "ar", inputSchema: {}, async: true, execute: asyncReadExecute }],
    ["async_mutate_tool", { description: "am", inputSchema: {}, async: true, mutates: true, execute: asyncMutateExecute }],
    ["async_fail_tool", { description: "af", inputSchema: {}, async: true, execute: asyncFailExecute }]
];

const readRegistry: any = [
    ["read_tool", { description: "r", inputSchema: {}, execute: readExecute }],
    ["fail_tool", { description: "f", inputSchema: {}, execute: failExecute }]
];
const mutateRegistry: any = [
    ["mutate_tool", { description: "m", inputSchema: {}, mutates: true, execute: mutateExecute }],
    ["add_tool", { description: "a", inputSchema: {}, mutates: true, additive: true, execute: mutateExecute }]
];

const resolveToolRegistriesMock = vi.fn(async () => {});
vi.mock("@triliumnext/core/src/services/llm/tools/index.js", () => ({
    allToolRegistries: [readRegistry, mutateRegistry, asyncRegistry],
    resolveToolRegistries: resolveToolRegistriesMock
}));

const { createMcpServer } = await import("./mcp_server.js");

beforeEach(() => {
    registered.length = 0;
    clsCalls.init = 0;
    clsCalls.set.length = 0;
    vi.clearAllMocks();
    mockSql.transactional.mockImplementation((cb: () => unknown) => cb());
});

afterEach(() => vi.restoreAllMocks());

describe("createMcpServer", () => {
    it("registers every tool from all registries, after resolving the lazy ones", async () => {
        const server = await createMcpServer();

        expect(server).toBeInstanceOf(FakeMcpServer);
        expect((server as any).info).toMatchObject({ name: "trilium-notes", version: "9.9.9-test" });
        expect(registered.map((r) => r.name)).toEqual([
            "read_tool", "fail_tool", "mutate_tool", "add_tool", "async_read_tool", "async_mutate_tool", "async_fail_tool"
        ]);
        expect(resolveToolRegistriesMock).toHaveBeenCalled();
    });

    it("lets the session add to a call's arguments before the tool runs", async () => {
        await createMcpServer({ withArgs: (name, args) => name === "read_tool" ? { ...args, early: true } : args });

        registered.find((r) => r.name === "read_tool")!.callback({ foo: 1 });
        await registered.find((r) => r.name === "async_read_tool")!.callback({ a: 1 });

        expect(readExecute).toHaveBeenCalledWith({ foo: 1, early: true });
        expect(asyncReadExecute).toHaveBeenCalledWith({ a: 1 });
    });

    it("runs a read-only tool inside CLS without a transaction", async () => {
        await createMcpServer();
        const read = registered.find((r) => r.name === "read_tool")!;

        const result = read.callback({ foo: 1 });

        expect(readExecute).toHaveBeenCalledWith({ foo: 1 });
        expect(mockSql.transactional).not.toHaveBeenCalled();
        expect(mockCls.set).toHaveBeenCalledWith("componentId", "mcp");
        expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: "read" }) }] });
    });

    it("runs a mutating tool inside CLS + a transaction", async () => {
        await createMcpServer();
        const mutate = registered.find((r) => r.name === "mutate_tool")!;

        const result = mutate.callback({ bar: 2 });

        expect(mutateExecute).toHaveBeenCalledWith({ bar: 2 });
        expect(mockSql.transactional).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: "mutate" }) }] });
    });

    it("awaits an async tool and returns its object, not an empty Promise", async () => {
        await createMcpServer();
        const tool = registered.find((r) => r.name === "async_read_tool")!;

        const result = await tool.callback({ a: 1 });

        expect(asyncReadExecute).toHaveBeenCalledWith({ a: 1 });
        expect(mockSql.transactional).not.toHaveBeenCalled();
        expect(mockSql.transactionalAsync).not.toHaveBeenCalled();
        expect(mockCls.set).toHaveBeenCalledWith("componentId", "mcp");
        expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: "async-read" }) }] });
    });

    it("runs a mutating async tool in no transaction, since it manages its own", async () => {
        await createMcpServer();
        const tool = registered.find((r) => r.name === "async_mutate_tool")!;

        const result = await tool.callback({ b: 2 });

        expect(asyncMutateExecute).toHaveBeenCalledWith({ b: 2 });
        expect(mockSql.transactionalAsync).not.toHaveBeenCalled();
        expect(mockSql.transactional).not.toHaveBeenCalled();
        expect(mockCls.set).toHaveBeenCalledWith("componentId", "mcp");
        expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: "async-mutate" }) }] });
    });

    it("flags the { error } a tool returns as a failed call", async () => {
        await createMcpServer();
        const fail = registered.find((r) => r.name === "fail_tool");
        const asyncFail = registered.find((r) => r.name === "async_fail_tool");
        expect(fail).toBeDefined();
        expect(asyncFail).toBeDefined();

        const failed = {
            content: [{ type: "text", text: JSON.stringify({ error: "Note not found" }) }],
            isError: true
        };
        expect(fail?.callback({})).toEqual(failed);
        expect(await asyncFail?.callback({})).toEqual(failed);
    });
});

describe("tool annotations", () => {
    it("tells the client which tools only read, which only add and which overwrite or remove", async () => {
        await createMcpServer();
        const annotationsOf = (name: string) => registered.find((r) => r.name === name)?.config.annotations;

        expect(annotationsOf("read_tool")).toEqual({ readOnlyHint: true, openWorldHint: false });
        expect(annotationsOf("add_tool")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
        expect(annotationsOf("mutate_tool")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    });

    it("leaves the hints out when asked to", async () => {
        await createMcpServer({ toolHints: false });

        expect(registered.map((r) => r.name)).toContain("read_tool");
        expect(registered.map((r) => r.config.annotations)).toEqual(registered.map(() => undefined));
    });
});
