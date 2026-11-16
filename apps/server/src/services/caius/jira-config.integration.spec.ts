/**
 * The Jira projects and site come from the standing note's Rhythm "Jira:" line and `JIRA_BASE_URL`,
 * read under the lock, so a bare key counts only for a configured project.
 */

import { dayCapacity, setKeyConfig } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CaiusInputs, JiraInputs } from "./inputs/types.js";
import type { InputsInput } from "./schemas.js";
import { createBeccaStore, createChildNote } from "./store.js";
import type { NoteStore } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const RHYTHM = "<li>Work starts at standup, 10:00.</li>";
const standingWith = (...lines: string[]) => `<h2>Rhythm</h2><ul>${RHYTHM}${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;

const jira: JiraInputs = { handoff: [], asks: [], done: [] };
async function stubInputs(input: InputsInput): Promise<CaiusInputs> {
    return { date: input.date, jira, calendar: [], capacity: dayCapacity([], { workStart: input.workStart, workEnd: input.workEnd }), errors: [] };
}

const tools = createCaiusTools(undefined, async () => undefined, stubInputs);

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

let standingId = "";
const setStanding = (html: string) => cls.init(async () => { await store.putContent(standingId, html); });

const dayWith = (date: string, items: string[]) => cls.init(async () => {
    const day = await store.calendarDay(date);
    await store.putContent(day.noteId, `<h2>☑️ Tasks</h2>${ul(...items)}`);
    return day.noteId;
});
const dayHtml = (date: string) => cls.init(async () => store.content((await store.calendarDay(date)).noteId));

afterEach(() => vi.unstubAllEnvs());

beforeAll(async () => {
    await sql_init.dbReady;
    await cls.init(async () => {
        await store.calendarDay("2026-11-02");
        standingId = createChildNote("root", "🧭 How I work", standingWith());
        await store.addLabel(standingId, "assistantContext", "");
    });
});

describe("Jira projects from the standing note", () => {
    it("counts a bare key only for a project on the Jira line, and sees an edit on the next call", async () => {
        const without = "2026-11-03";
        await dayWith(without, [ li("a1", "Check ABC-12") ]);
        const plain = await call("caius_add", { items: [ { date: without, area: "foundation", text: "Review ABC-12 notes" } ] });
        expect(plain.results[0].status).toBe("added");

        await setStanding(standingWith("Jira: ABC"));
        const withLine = "2026-11-04";
        await dayWith(withLine, [ li("b1", "Check ABC-12") ]);
        const dup = await call("caius_add", { items: [ { date: withLine, area: "foundation", text: "Review ABC-12 again" } ] });
        expect(dup.results[0]).toMatchObject({ status: "skipped", reason: "duplicate" });

        await setStanding(standingWith("Jira: XYZ"));
        const other = "2026-11-05";
        await dayWith(other, [ li("c1", "Check ABC-12") ]);
        const again = await call("caius_add", { items: [ { date: other, area: "foundation", text: "Review ABC-12 later" } ] });
        expect(again.results[0].status).toBe("added");
    });
});

describe("the Jira site from JIRA_BASE_URL", () => {
    it("links a source key to the site, or writes it as text without one, and still spots the duplicate", async () => {
        await setStanding(standingWith("Jira: ABC"));
        const linked = "2026-11-09";
        await dayWith(linked, []);
        const lk = await call("caius_add", { items: [ { date: linked, area: "foundation", text: "Draft the reply", source: "ABC-20" } ] });
        expect(lk.results[0]).toMatchObject({ status: "added" });
        expect(await dayHtml(linked)).toContain("https://example.atlassian.net/browse/ABC-20");

        vi.stubEnv("JIRA_BASE_URL", "");
        const plain = "2026-11-10";
        await dayWith(plain, []);
        const first = await call("caius_add", { items: [ { date: plain, area: "foundation", text: "Send the summary", source: "ABC-21" } ] });
        expect(first.results[0].status).toBe("added");
        const html = await dayHtml(plain);
        expect(html).toContain("ABC-21");
        expect(html).not.toContain("href");
        const second = await call("caius_add", { items: [ { date: plain, area: "foundation", text: "Send the summary", source: "ABC-21" } ] });
        expect(second.results[0]).toMatchObject({ status: "skipped", reason: "duplicate" });
    });
});

describe("when the standing note cannot be read", () => {
    it("still links a source key to the site when the first read fails", async () => {
        setKeyConfig({ projects: [], browseBase: null });
        let failed = false;
        const unreadable: NoteStore = {
            ...store,
            search: (query: string) => {
                if (query.includes("assistantContext") && !failed) {
                    failed = true;
                    return Promise.reject(new Error("search failed"));
                }
                return store.search(query);
            }
        };
        const failing = [ ...createCaiusTools(unreadable, async () => undefined, stubInputs) ].find(([ n ]) => n === "caius_add")?.[1];
        if (!failing) throw new Error("Tool caius_add not registered");

        const date = "2026-11-11";
        await dayWith(date, []);
        const added = await cls.init(() => failing.execute({ items: [ { date, area: "foundation", text: "Answer the thread", source: "ABC-30" } ] })) as any;
        expect(added.results[0].status).toBe("added");
        expect(await dayHtml(date)).toContain("https://example.atlassian.net/browse/ABC-30");
    });
});
