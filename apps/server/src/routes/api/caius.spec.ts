import { becca, cls } from "@triliumnext/core";
import { beforeAll, describe, expect, it } from "vitest";

import { type ApiTestContext, bootLoggedInApp } from "../../../spec/support/internal_api.js";
import { explainSummary } from "../../services/caius/service.js";
import { createBeccaStore, withCaiusLock } from "../../services/caius/store.js";

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const PAST_DAY = "2031-05-04";
const TODAY = "2031-05-06";
const NOW = `${TODAY} 10:00:00.000+0000`;

const store = createBeccaStore();
const noteIds: Record<string, string> = {};
let ctx: ApiTestContext;

const get = (path: string) => ctx.agent.get(path).set("trilium-local-now-datetime", NOW);
const post = (path: string, body: object) => ctx.agent.post(path).set("x-csrf-token", ctx.csrfToken).set("trilium-local-now-datetime", NOW).send(body);
const blobOf = (noteId: string) => becca.getNoteOrThrow(noteId).blobId;

describe("Caius routes", () => {
    beforeAll(async () => {
        ctx = await bootLoggedInApp();
        await cls.init(async () => {
            const past = await store.calendarDay(PAST_DAY);
            await store.putContent(past.noteId, `<h3>Work</h3>${ul(li("o1", "Overdue thing"))}`);
            const today = await store.calendarDay(TODAY);
            await store.putContent(today.noteId, `<h3>Work</h3>${ul(li("t1", "Finish me"), li("t2", "Start me"), li("t3", "Drop me"), li("t4", "Move me"))}`
                + `<ul><li>Bullet without an id</li></ul><h2>Suggested</h2>${ul(li("s1", "Accept me"), li("s2", "Dismiss me"))}`);
            const older = await store.calendarDay("2031-05-01");
            await store.putContent(older.noteId, "<ul><li>Older task</li></ul>");
            Object.assign(noteIds, { past: past.noteId, today: today.noteId, older: older.noteId });
        });
    });

    it("reports Caius as enabled", async () => {
        expect((await ctx.agent.get("/api/caius/status").expect(200)).body).toEqual({ enabled: true });
    });

    it("plans the day of the request's local now by default, and answers 400 on bad input", async () => {
        const plan = await get("/api/caius/plan?period=day").expect(200);
        expect(plan.body).toMatchObject({ period: "day", key: TODAY, noteId: noteIds.today });

        expect((await get("/api/caius/plan?period=day&date=2031-02-30").expect(400)).body).toMatchObject({ error: "bad_request" });
        expect((await get("/api/caius/plan?period=year").expect(400)).body.message).toContain("period");
    });

    it("lists open tasks by lane, with the limit read from the query", async () => {
        const overdue = await get("/api/caius/open?lane=overdue&limit=5").expect(200);
        expect(overdue.body.tasks).toEqual([expect.objectContaining({ text: "Overdue thing", daysLate: 2, noteId: noteIds.past, listItemId: "o1" })]);

        expect((await get("/api/caius/open?limit=1").expect(200)).body.tasks).toHaveLength(1);
        expect((await get("/api/caius/open?limit=many").expect(400)).body.message).toContain("limit");
    });

    it("explains a task, and answers 404 and 400", async () => {
        const explained = await get(`/api/caius/explain?noteId=${noteIds.past}&listItemId=o1`).expect(200);
        expect(explained.body).toMatchObject({
            lane: "overdue", daysLate: 2,
            summary: "Overdue by 2 days: it's in the day note for Sunday 4 May, which is past."
        });
        expect(explained.body.rule).toContain("past");

        await get(`/api/caius/explain?noteId=${noteIds.past}&listItemId=nope`).expect(404);
        await get(`/api/caius/explain?noteId=${noteIds.past}`).expect(400);
    });

    it("adds a task, dry run first, and gives the note's id-less list items ids", async () => {
        const item = { date: TODAY, section: "Work", text: "Added over HTTP" };
        const dry = await post("/api/caius/add", { items: [item], dryRun: true }).expect(200);
        expect(dry.body.results[0]).toMatchObject({ status: "added", dryRun: true });
        expect(await store.content(noteIds.today)).not.toContain("Added over HTTP");

        const real = await post("/api/caius/add", { items: [item] }).expect(200);
        expect(real.body.blobIds).toEqual({ [noteIds.today]: blobOf(noteIds.today) });
        expect(real.body.results[0]).toMatchObject({ status: "added", writtenNoteId: noteIds.today });
        const html = await store.content(noteIds.today);
        expect(html).toContain("Added over HTTP");
        expect(html).toMatch(/<ul><li data-list-item-id="e[0-9a-f]{32}">Bullet without an id<\/li><\/ul>/);

        const bad = await post("/api/caius/add", { items: [{ section: "Work", text: "No period" }] }).expect(400);
        expect(bad.body.message).toContain("Give exactly one of date, week or month");
    });

    it("summarizes why a task is in its lane", () => {
        expect(explainSummary("overdue", "", "past day 2031-05-05 vs now", 1))
            .toBe("Overdue by 1 day: it's in the day note for Monday 5 May, which is past.");
        expect(explainSummary("today", "", "current day 2031-05-06 vs now", null))
            .toBe("Today: it's in the day note for Tuesday 6 May, which is today.");
        expect(explainSummary("orbit", "", "future week 2031-W20 vs now", null))
            .toBe("In orbit: it's in the note for week 20 of 2031, which is still ahead.");
        expect(explainSummary("orbit", "", "current month 2031-05 vs now", null))
            .toBe("In orbit: it's in the month note for May 2031, which is this month.");
        expect(explainSummary("later", "default", "no horizon rule matched", null))
            .toBe("later: default (no horizon rule matched).");
        expect(explainSummary(null, "default", "no horizon rule matched", null))
            .toBe("No lane: default (no horizon rule matched).");
    });

    it("accepts and dismisses Suggested items, skips an item whose note changed as stale, and skips the check without expectedBlobId", async () => {
        const stale = await post("/api/caius/dismiss", { items: [{ noteId: noteIds.today, listItemId: "s2", expectedBlobId: "an-old-blob" }] }).expect(200);
        expect(stale.body.results).toEqual([{ noteId: noteIds.today, listItemId: "s2", status: "skipped", reason: "stale", blobId: blobOf(noteIds.today) }]);
        expect(await store.content(noteIds.today)).toContain("Dismiss me");

        const blobBeforeAccept = blobOf(noteIds.today);
        const accepted = await post("/api/caius/accept", { items: [{ noteId: noteIds.today, listItemId: "s1", section: "Work", expectedBlobId: blobOf(noteIds.today) }] }).expect(200);
        expect(accepted.body.results[0]).toMatchObject({ status: "accepted" });
        expect(blobOf(noteIds.today)).not.toBe(blobBeforeAccept);

        expect(accepted.body.blobIds).toEqual({ [noteIds.today]: blobOf(noteIds.today) });
        const dismissed = await post("/api/caius/dismiss", { items: [{ noteId: noteIds.today, listItemId: "s2" }] }).expect(200);
        expect(dismissed.body.blobIds).toEqual({ [noteIds.today]: blobOf(noteIds.today) });
        expect(dismissed.body.results[0]).toMatchObject({ status: "dismissed" });
    });

    it("sets states, comparing every item of a batch with the blobId the note had before the batch", async () => {
        const blobId = blobOf(noteIds.today);
        const result = await post("/api/caius/set-state", {
            items: [
                { noteId: noteIds.today, listItemId: "t1", state: "done", expectedBlobId: blobId },
                { noteId: noteIds.today, listItemId: "t3", state: "cancelled", reason: "moot", expectedBlobId: "an-old-blob" },
                { noteId: noteIds.today, listItemId: "t2", state: "doing", expectedBlobId: blobId }
            ]
        }).expect(200);

        expect(result.body.results.map((r: { listItemId: string; status: string; reason?: string }) => [r.listItemId, r.status, r.reason])).toEqual([
            ["t1", "updated", undefined],
            ["t3", "skipped", "stale"],
            ["t2", "updated", undefined]
        ]);
        expect(blobOf(noteIds.today)).not.toBe(blobId);
        // The note's blobId after the whole batch, read inside the same lock.
        expect(result.body.blobIds).toEqual({ [noteIds.today]: blobOf(noteIds.today) });
        await post("/api/caius/set-state", { items: [{ noteId: noteIds.today, listItemId: "t3", state: "cancelled" }] }).expect(400);
    });

    it("forwards a task", async () => {
        const result = await post("/api/caius/forward", { items: [{ noteId: noteIds.today, listItemId: "t4", to: "2031-05-07", expectedBlobId: blobOf(noteIds.today) }] }).expect(200);
        const target = await cls.init(() => store.calendarDay("2031-05-07"));
        expect(result.body.results[0]).toMatchObject({ status: "moved", writtenNoteIds: [ target.noteId, noteIds.today ] });
        expect(result.body.blobIds).toEqual({ [noteIds.today]: blobOf(noteIds.today), [target.noteId]: blobOf(target.noteId) });
        await post("/api/caius/forward", { items: [{ noteId: noteIds.today, listItemId: "t4", to: "tomorrow" }] }).expect(400);
    });

    it("applies a Close in one request: forwards, then drops, behind one version check", async () => {
        const day = await cls.init(() => store.calendarDay("2031-05-10"));
        await cls.init(() => store.putContent(day.noteId, `<h3>Work</h3>${ul(li("c1", "Move on"), li("c2", "Drop one"), li("c3", "Drop two"))}`));
        const body = (expectedBlobId: string | undefined) => ({
            forwards: [ { noteId: day.noteId, listItemId: "c1", to: "2031-05-11" } ],
            drops: [
                { noteId: day.noteId, listItemId: "c2", state: "cancelled", reason: "moot" },
                { noteId: day.noteId, listItemId: "c3", state: "cancelled", reason: "also moot" }
            ],
            expectedBlobId
        });

        const stale = await post("/api/caius/apply", body("an-old-blob")).expect(200);
        expect(stale.body.results.map((r: { status: string; reason?: string }) => [ r.status, r.reason ])).toEqual([
            [ "skipped", "stale" ], [ "skipped", "stale" ], [ "skipped", "stale" ]
        ]);
        expect(await store.content(day.noteId)).not.toContain("_rescheduled");

        const applied = await post("/api/caius/apply", body(blobOf(day.noteId))).expect(200);
        expect(applied.body.results.map((r: { listItemId: string; status: string }) => [ r.listItemId, r.status ])).toEqual([
            [ "c1", "moved" ], [ "c2", "updated" ], [ "c3", "updated" ]
        ]);
        const html = await store.content(day.noteId);
        expect(html).toContain("_rescheduled");
        expect(html).toContain("<em>moot</em>");
        expect(html).toContain("<em>also moot</em>");
        const target = await cls.init(() => store.calendarDay("2031-05-11"));
        expect(applied.body.blobIds).toEqual({ [day.noteId]: blobOf(day.noteId), [target.noteId]: blobOf(target.noteId) });

        await post("/api/caius/apply", { forwards: [], drops: [] }).expect(400);
    });

    it("assigns missing list item ids, as a dry run unless told otherwise", async () => {
        const dry = await post("/api/caius/assign-ids", { dryRun: true }).expect(200);
        expect(dry.body).toMatchObject({ dryRun: true, notes: 1, added: 1, results: [{ noteId: noteIds.older, items: ["Older task"] }] });

        expect((await post("/api/caius/assign-ids", {}).expect(200)).body).toMatchObject({ dryRun: true, added: 1 });
        expect(await store.content(noteIds.older)).toBe("<ul><li>Older task</li></ul>");

        const real = await post("/api/caius/assign-ids", { dryRun: false }).expect(200);
        expect(real.body.blobIds).toEqual({ [noteIds.older]: blobOf(noteIds.older) });
        expect(real.body).toMatchObject({ notes: 1, added: 1 });
        expect(await store.content(noteIds.older)).toMatch(/^<ul><li data-list-item-id="e[0-9a-f]{32}">Older task<\/li><\/ul>$/);
        await post("/api/caius/assign-ids", { dryRun: "yes" }).expect(400);
    });

    it("runs every operation route under the Caius lock", async () => {
        let release = () => {};
        const held = withCaiusLock("spec", () => new Promise<void>((resolve) => {
            release = resolve;
        }));
        const requests = {
            plan: get("/api/caius/plan?period=day"),
            open: get("/api/caius/open"),
            explain: get(`/api/caius/explain?noteId=${noteIds.past}&listItemId=o1`),
            add: post("/api/caius/add", { items: [{ date: TODAY, section: "Work", text: "Queued" }], dryRun: true }),
            accept: post("/api/caius/accept", { items: [{ noteId: noteIds.today, listItemId: "s1", section: "Work" }], dryRun: true }),
            dismiss: post("/api/caius/dismiss", { items: [{ noteId: noteIds.today, listItemId: "s2" }], dryRun: true }),
            setState: post("/api/caius/set-state", { items: [{ noteId: noteIds.today, listItemId: "t1", state: "doing" }], dryRun: true }),
            forward: post("/api/caius/forward", { items: [{ noteId: noteIds.today, listItemId: "t1", to: "2031-05-08" }], dryRun: true }),
            assignIds: post("/api/caius/assign-ids", { dryRun: true }),
            apply: post("/api/caius/apply", { forwards: [], drops: [ { noteId: noteIds.today, listItemId: "zz", state: "done" } ] })
        };
        const answered: string[] = [];
        const pending = Object.entries(requests).map(([name, request]) => request.then((res) => {
            answered.push(name);
            return res;
        }));

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(answered).toEqual([]);

        release();
        await held;
        for (const res of await Promise.all(pending)) {
            expect(res.status).toBe(200);
        }
        expect(answered.sort()).toEqual(Object.keys(requests).sort());
    });
});
