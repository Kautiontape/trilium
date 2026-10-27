import { addTasks, readPlan } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { beforeAll, expect, it } from "vitest";

import { createBeccaStore } from "./store.js";

const store = createBeccaStore();
const DAY = "2031-05-06";
const now = new Date(2031, 4, 6);

beforeAll(async () => {
    await sql_init.dbReady;
});

it("adds a task to a day note on becca and reads the plan back", async () => {
    const [added] = await cls.init(async () => {
        const day = await store.calendarDay(DAY);
        await store.putContent(day.noteId, "<h3>Work</h3>");
        return addTasks(store, [
            { date: DAY, section: "Work", text: "Reply to Pat", source: "ZAP-7", est: "30m" },
        ], { now });
    });
    expect(added).toMatchObject({ status: "added", key: "ZAP-7" });

    const view = await readPlan(store, "day", DAY, now);
    expect(view.noteId).not.toBeNull();
    expect(view.sections[0]?.tasks[0]).toMatchObject({ estMinutes: 30 });
    expect(view.sections[0]?.tasks[0]?.text).toContain("Reply to Pat");
});
