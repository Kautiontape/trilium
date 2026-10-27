import { becca, cls, note_service as noteService, sql_init } from "@triliumnext/core";
import { beforeAll, describe, expect, it } from "vitest";

import sql from "../sql.js";
import { createBeccaStore } from "./store.js";

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
    });

    it("writes content as is and reads it back", async () => {
        const day = await inRequest(() => store.calendarDay("2031-03-05"));
        const html = "<h3>Work</h3><ul><li>a &amp; b</li></ul>";
        await inRequest(() => store.putContent(day.noteId, html));
        expect(await store.content(day.noteId)).toBe(html);
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
