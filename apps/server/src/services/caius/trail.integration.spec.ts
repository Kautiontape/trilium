import { cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBeccaStore } from "./store.js";
import { createCaiusTools } from "./tools.js";
import { slipsOf, trailOf, trails } from "./trail.js";

const store = createBeccaStore();

const li = (id: string, text: string) =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label></li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;

const tools = createCaiusTools(undefined, async () => undefined, async () => { throw new Error("no inputs"); });

function call(name: string, args: object): Promise<any> {
    const def = [ ...tools ].find(([ n ]) => n === name)?.[1];
    if (!def) throw new Error(`Tool ${name} not registered`);
    return cls.init(() => def.execute(args)) as Promise<any>;
}

const MON = "2031-03-03";
const TUE = "2031-03-04";
const WED = "2031-03-05";
const NOW = new Date(`${WED}T12:00:00`);

const dayId = (date: string) => cls.init(async () => (await store.calendarDay(date)).noteId);
const trailsNow = () => cls.init(() => trails(store, NOW));

beforeAll(async () => {
    await sql_init.dbReady;
    vi.stubEnv("CAIUS_NOW", `${MON}T17:30`);
    await cls.init(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
    });
});

afterAll(() => {
    vi.unstubAllEnvs();
});

describe("a task forwarded Monday, Tuesday and Wednesday", () => {
    const WORDS = "Ring the plumber about the boiler";

    it("has a trail of three copies in order, two of them moved on, and two slips", async () => {
        const mon = await dayId(MON);
        await cls.init(() => store.putContent(mon, `<h3>Work</h3>${ul(li("t-mon", WORDS))}`));
        const first = await call("caius_forward", { items: [ { noteId: mon, listItemId: "t-mon", to: TUE } ] });
        expect(first.results[0].status).toBe("moved");
        const tue = await dayId(TUE);

        const tueId = await cls.init(async () => {
            const html = await store.content(tue);
            return /data-list-item-id="([^"]+)"/.exec(html)?.[1] ?? "";
        });
        await call("caius_forward", { items: [ { noteId: tue, listItemId: tueId, to: WED } ] });

        const all = await trailsNow();
        const trail = trailOf(all, { noteId: mon, listItemId: "t-mon", text: WORDS });
        expect(trail?.copies.map((copy) => [ copy.period, copy.state === "open" ? "open" : "moved", copy.movedOn ])).toEqual([
            [ MON, "moved", true ], [ TUE, "moved", true ], [ WED, "open", false ]
        ]);
        expect(trail?.copies.map((copy) => copy.noteId)).toEqual([ mon, tue, await dayId(WED) ]);
        const idOn = async (noteId: string) => /data-list-item-id="([^"]+)"/.exec(await cls.init(() => store.content(noteId)))?.[1];
        expect(trail?.copies.map((copy) => copy.listItemId)).toEqual([ "t-mon", tueId, await idOn(await dayId(WED)) ]);
        expect(slipsOf(all, { noteId: mon, listItemId: "t-mon", text: WORDS })).toBe(2);
    });
});

describe("a task given an area between two forwards", () => {
    it("keeps one trail of three copies and two slips", async () => {
        const [ mon2, tue2, wed2 ] = [ "2031-03-10", "2031-03-11", "2031-03-12" ];
        const idIn = async (noteId: string) => /data-list-item-id="([^"]+)"/.exec(await cls.init(() => store.content(noteId)))?.[1] ?? "";
        const mon = await dayId(mon2);
        await cls.init(() => store.putContent(mon, `<h3>Work</h3>${ul(li("a-mon", "Sort the tax receipts"))}`));
        await call("caius_forward", { items: [ { noteId: mon, listItemId: "a-mon", to: tue2 } ] });
        const tue = await dayId(tue2);
        const tueId = await idIn(tue);
        const grown = await call("caius_set_area", { items: [ { noteId: tue, listItemId: tueId, area: "growth" } ] });
        expect(grown.results[0].status).toBe("updated");
        await call("caius_forward", { items: [ { noteId: tue, listItemId: tueId, to: wed2 } ] });

        const all = await trailsNow();
        const wed = await dayId(wed2);
        const live = { noteId: wed, listItemId: await idIn(wed), text: `🌱 Sort the tax receipts [from Monday 10](#root/${mon})` };
        expect(trailOf(all, live)?.copies.map((copy) => [ copy.period, copy.movedOn ])).toEqual([ [ mon2, true ], [ tue2, true ], [ wed2, false ] ]);
        expect(slipsOf(all, live)).toBe(2);
    });
});

describe("a task moved from week to week", () => {
    it("counts no slip for the week hop", async () => {
        const w10 = await cls.init(async () => (await store.calendarWeek("2031-W10")).noteId);
        await cls.init(() => store.putContent(w10, `<h3>Work</h3>${ul(li("w-1", "Book the venue"))}`));
        const hop = await call("caius_forward", { items: [ { noteId: w10, listItemId: "w-1", to: "2031-W11" } ] });
        expect(hop.results[0].status).toBe("moved");

        const all = await trailsNow();
        const item = { noteId: w10, listItemId: "w-1", text: "Book the venue" };
        const trail = trailOf(all, item);
        expect(trail?.copies.map((copy) => [ copy.period, copy.movedOn ])).toEqual([ [ "2031-W10", true ], [ "2031-W11", false ] ]);
        expect(slipsOf(all, item)).toBe(0);
    });
});

describe("an item with no copies elsewhere", () => {
    it("has no trail and no slips", async () => {
        const all = await trailsNow();
        expect(trailOf(all, { noteId: "nope", listItemId: null, text: "Never written" })).toBeUndefined();
        expect(slipsOf(all, { noteId: "nope", listItemId: null, text: "Never written" })).toBe(0);
    });
});
