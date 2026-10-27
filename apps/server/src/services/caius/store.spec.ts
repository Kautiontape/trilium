import { becca, cls, note_service as noteService, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import sql from "../sql.js";
import { createBeccaStore, LOCK_WARN_MS, withCaiusLock } from "./store.js";

const store = createBeccaStore();

/** Runs `fn` in the CLS context an ETAPI request provides. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
    return cls.init(() => {
        cls.set("componentId", "caius");
        return fn();
    });
}

describe("becca NoteStore", () => {
    beforeAll(async () => {
        await sql_init.dbReady;
    });

    it("creates period notes through the calendar and maps only the StoreNote fields", async () => {
        const day = await inRequest(() => store.calendarDay("2031-03-04"));
        expect(day).toEqual({
            noteId: day.noteId,
            title: expect.any(String),
            type: "text",
            isProtected: false,
            parentNoteIds: expect.any(Array),
            childNoteIds: [],
            attributes: expect.arrayContaining([{ type: "label", name: "dateNote", value: "2031-03-04" }]),
            utcDateModified: expect.any(String),
        });
        expect(day.parentNoteIds).toHaveLength(1);
        expect(await inRequest(() => store.note(day.noteId))).toEqual(day);

        const month = await inRequest(() => store.calendarMonth("2031-03"));
        expect(day.parentNoteIds).toContain(month.noteId);
        expect(month.childNoteIds).toContain(day.noteId);
        await expect(store.calendarDay("nope")).rejects.toThrow("not valid");
        await expect(store.calendarWeek("nope")).rejects.toThrow("not valid");
        await expect(store.calendarMonth("nope")).rejects.toThrow("not valid");
        await expect(inRequest(() => store.calendarDay("2026-02-30"))).rejects.toThrow("not valid");
        await expect(inRequest(() => store.calendarWeek("2025-W53"))).rejects.toThrow("not valid");
        await expect(inRequest(() => store.calendarMonth("2026-13"))).rejects.toThrow("not valid");
    });

    it("writes content as is and reads it back", async () => {
        const day = await inRequest(() => store.calendarDay("2031-03-05"));
        const html = "<h3>Work</h3><ul><li>a &amp; b</li></ul>";
        expect(await inRequest(() => store.putContent(day.noteId, html))).toBe(true);
        expect(await store.content(day.noteId)).toBe(html);

        expect(await inRequest(() => store.putContent(day.noteId, "<p>stale</p>", "<p>not what it holds</p>"))).toBe(false);
        expect(await store.content(day.noteId)).toBe(html);
        expect(await inRequest(() => store.putContent(day.noteId, "<p>swapped</p>", html))).toBe(true);
        expect(await store.content(day.noteId)).toBe("<p>swapped</p>");
    });

    it("finds notes by label under an ancestor, and adds a repeated label", async () => {
        const month = await inRequest(() => store.calendarMonth("2031-04"));
        const day = await inRequest(() => store.calendarDay("2031-04-02"));
        await inRequest(async () => {
            await store.addLabel(day.noteId, "caiusTest", "one");
            await store.addLabel(day.noteId, "caiusTest", "two");
        });

        const labels = (await store.note(day.noteId)).attributes.filter((a) => a.name === "caiusTest");
        expect(labels).toEqual([
            { type: "label", name: "caiusTest", value: "one" },
            { type: "label", name: "caiusTest", value: "two" },
        ]);
        expect(becca.getNote(day.noteId)?.getOwnedAttributes("label", "caiusTest")[0]?.isInheritable).toBe(false);

        const under = await store.search("#caiusTest", month.noteId);
        expect(under.map((n) => n.noteId)).toEqual([day.noteId]);
        expect(await store.search("#caiusTest", "root")).toHaveLength(1);
        const elsewhere = await inRequest(() => store.calendarMonth("2031-03"));
        expect(await store.search("#caiusTest", elsewhere.noteId)).toEqual([]);
        await expect(store.search("  ")).rejects.toThrow("empty");

        // A route runs with the client's hoisted note, which must not narrow what Caius sees.
        for (const hoisted of [ elsewhere.noteId, "null" ]) {
            const found = await cls.init(() => {
                cls.set("hoistedNoteId", hoisted);
                return store.search("#caiusTest");
            });
            expect(found.map((n) => n.noteId)).toEqual([day.noteId]);
        }
    });

    it("throws where ETAPI answers 404 or 400", async () => {
        await expect(store.note("missing")).rejects.toThrow("Note 'missing' not found.");
        await expect(store.content("missing")).rejects.toThrow("not found");
        await expect(store.putContent("missing", "x")).rejects.toThrow("not found");
        await expect(store.addLabel("missing", "a", "b")).rejects.toThrow("not found");

        const secret = await inRequest(async () => noteService.createNewNote({
            parentNoteId: "root", title: "s", content: "x", type: "text", isProtected: false,
        }).note);
        becca.getNote(secret.noteId)!.isProtected = true;
        await expect(store.content(secret.noteId)).rejects.toThrow("protected");
        await expect(store.putContent(secret.noteId, "x")).rejects.toThrow("protected");
    });
});

describe("withCaiusLock", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("warns once when a call holds the lock too long, timed from when it gets the lock, and again on release", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const finish: Record<string, () => void> = {};
        const hold = (name: string) => withCaiusLock(name, () => new Promise<void>((resolve) => {
            finish[name] = resolve;
        }));

        const first = hold("caius_first");
        const second = hold("caius_second");
        await vi.advanceTimersByTimeAsync(LOCK_WARN_MS - 5_000);
        finish.caius_first?.();
        await first;
        expect(warn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(LOCK_WARN_MS - 1);
        expect(warn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(LOCK_WARN_MS * 2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("Caius call caius_second has held the lock for over 30 s");

        finish.caius_second?.();
        await second;
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1]?.[0]).toBe("Caius call caius_second released the lock after 90 s.");

        await withCaiusLock("caius_quick", async () => {});
        await vi.advanceTimersByTimeAsync(LOCK_WARN_MS * 2);
        expect(warn).toHaveBeenCalledTimes(2);
    });
});
