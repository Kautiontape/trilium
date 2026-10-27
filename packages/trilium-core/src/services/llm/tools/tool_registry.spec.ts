import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const transactionalMock = vi.hoisted(() => vi.fn(<T>(cb: () => T) => cb()));
const transactionalAsyncMock = vi.hoisted(() => vi.fn(<T>(cb: () => Promise<T>) => cb()));

// toToolSet wraps mutating tools in sql.transactional; stub it to just run the
// callback so we can assert the wrapping happens without a real transaction.
vi.mock("../../sql/index.js", () => ({
    getSql: () => ({ transactional: transactionalMock, transactionalAsync: transactionalAsyncMock })
}));

import { allToolRegistries } from "./index.js";
import { defineTools, ToolRegistry } from "./tool_registry.js";

describe("ToolRegistry", () => {
    const registry = defineTools({
        read_thing: {
            description: "read",
            inputSchema: z.object({ id: z.string() }),
            execute: ({ id }) => ({ id, read: true })
        },
        write_thing: {
            description: "write",
            inputSchema: z.object({ id: z.string() }),
            mutates: true,
            execute: ({ id }) => ({ id, written: true })
        }
    });

    it("defineTools returns a ToolRegistry", () => {
        expect(registry).toBeInstanceOf(ToolRegistry);
    });

    it("allToolRegistries aggregates every tool group as ToolRegistry instances", () => {
        expect(allToolRegistries.length).toBeGreaterThan(0);
        expect(allToolRegistries.every((r) => r instanceof ToolRegistry)).toBe(true);
        // Every registry yields at least one named tool.
        for (const reg of allToolRegistries) {
            expect([...reg].length).toBeGreaterThan(0);
        }
    });

    it("is iterable over [name, definition] pairs", () => {
        const names = [...registry].map(([name]) => name);
        expect(names).toEqual(["read_thing", "write_thing"]);
        const [, def] = [...registry][1];
        expect(def.mutates).toBe(true);
    });

    it("toToolSet exposes each tool with its description and inputSchema", () => {
        const set = registry.toToolSet();
        expect(Object.keys(set)).toEqual(["read_thing", "write_thing"]);
        expect(set.read_thing.description).toBe("read");
        expect(set.write_thing.inputSchema).toBeDefined();
    });

    it("toToolSet runs read-only tools directly and wraps mutating tools in a transaction", async () => {
        transactionalMock.mockClear();
        const set = registry.toToolSet();

        const readResult = await set.read_thing.execute!({ id: "r1" }, {} as any);
        expect(readResult).toEqual({ id: "r1", read: true });
        // Read-only tools are not transaction-wrapped.
        expect(transactionalMock).not.toHaveBeenCalled();

        const writeResult = await set.write_thing.execute!({ id: "w1" }, {} as any);
        expect(writeResult).toEqual({ id: "w1", written: true });
        expect(transactionalMock).toHaveBeenCalledTimes(1);
    });

    it("toToolSet awaits async tools and wraps only the mutating one in transactionalAsync", async () => {
        transactionalMock.mockClear();
        transactionalAsyncMock.mockClear();
        const asyncRegistry = defineTools({
            read_async: {
                description: "r",
                inputSchema: z.object({}),
                async: true,
                execute: async () => ({ value: 1 })
            },
            write_async: {
                description: "w",
                inputSchema: z.object({}),
                async: true,
                mutates: true,
                execute: async () => ({ value: 2 })
            }
        });
        const set = asyncRegistry.toToolSet();

        expect(await set.read_async.execute!({}, {} as any)).toEqual({ value: 1 });
        expect(transactionalAsyncMock).not.toHaveBeenCalled();

        expect(await set.write_async.execute!({}, {} as any)).toEqual({ value: 2 });
        expect(transactionalAsyncMock).toHaveBeenCalledTimes(1);
        expect(transactionalMock).not.toHaveBeenCalled();
    });
});
