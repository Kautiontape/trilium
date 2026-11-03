/**
 * `caius_show`: the views the phone draws. Each row carries its ids and a ref, and the Day view's
 * rows add up to its load the way the phone counts them again after a tap.
 */

import { dayLoad, liveMinutes, readPlan, type ShownView, type ViewTask } from "@triliumnext/caius";
import { cls, sql_init } from "@triliumnext/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_REPLY_CHARS } from "./daily.js";
import { readDay, readDays } from "./day-read.js";
import type { TicketCard } from "./inputs/jira.js";
import type { CaiusInputs, CalendarEvent } from "./inputs/types.js";
import { createCaiusService } from "./service.js";
import { createBeccaStore, createChildNote, withCaiusLock } from "./store.js";
import { createCaiusTools } from "./tools.js";

const store = createBeccaStore();

const li = (id: string, text: string, sub = "") =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label>${sub}</li>`;
const doneLi = (id: string, text: string, sub = "") =>
    `<li data-list-item-id="${id}"><label class="todo-list__label"><input type="checkbox" checked="checked" disabled="disabled">`
    + `<span class="todo-list__label__description">${text}</span></label>${sub}</li>`;
const ul = (...items: string[]) => `<ul class="todo-list">${items.join("")}</ul>`;
const critical = (...items: string[]) => `<aside class="admonition important">${ul(...items)}</aside>`;
const event = (start: string, end: string, title: string): CalendarEvent => ({ start, end, title, attendees: [], allDay: false, declined: false, source: [ 0 ] });

const STANDING = "<h2>Rhythm</h2><ul><li>Work starts at standup, 10:00.</li>"
    + "<li>The day runs to bedtime, and the evening is planned too. Bedtime: 23:00. Evening: something away from screens, a chore or a Recharge item.</li>"
    + "<li>Capacity: 180–240 work minutes a day, and 45–60 minutes in the evening.</li></ul>";

const MON = "2034-03-06";
const TUE = "2034-03-07";
const WED = "2034-03-08";
const THU = "2034-03-09";
const FRI = "2034-03-10";
const WEEK = "2034-W10";

const calendars: Record<string, CalendarEvent[]> = {
    [TUE]: [ event("10:00", "10:15", "Daily Standup"), event("13:00", "14:00", "Vendor sync") ]
};

const ticketCard = (key: string, summary: string): TicketCard => ({
    key, summary, status: "In Review", resolution: null, url: `https://jira.example.com/browse/${key}`, assignee: "Sam Lee",
    updated: "2034-03-06T12:00:00.000Z", daysInStatus: 3, done: false,
    lastComment: { author: "Sam Lee", created: "2034-03-06T12:00:00.000Z", excerpt: "Pushed a fix." },
    asks: [
        { ticket: { key, summary, status: "In Review", resolution: null, url: "", assignee: null, updated: "" }, author: "Riley", created: "2034-03-05T09:00:00.000Z", commentId: "1", excerpt: "Older ask" },
        { ticket: { key, summary, status: "In Review", resolution: null, url: "", assignee: null, updated: "" }, author: "Riley", created: "2034-03-06T09:00:00.000Z", commentId: "2", excerpt: "Can you look?" }
    ]
});
const tickets: Record<string, TicketCard> = {
    "ZAP-4101": ticketCard("ZAP-4101", "Write the export spec"),
    "ZAP-4200": ticketCard("ZAP-4200", "Fix the export")
};

const inputsOf = async (): Promise<CaiusInputs> => {
    throw new Error("Jira is not to be read");
};
const service = createCaiusService(store, undefined, inputsOf, () => 0, async (key) => tickets[key] ?? { error: "not_found" }, async (date) => ({ events: calendars[date] ?? [], errors: [] }));

const run = <T>(fn: () => Promise<T>) => cls.init(fn) as Promise<T>;
const dayWith = (date: string, html: string) => run(async () => {
    const day = await store.calendarDay(date);
    await store.putContent(day.noteId, html);
    return day.noteId;
});
const dayId = (date: string) => run(async () => (await store.calendarDay(date)).noteId);
/** The `listItemId` of the live task on `date` whose words include `words`. */
const idOn = async (date: string, words: string) => {
    const plan = await run(() => readPlan(store, "day", date, new Date(`${TUE}T09:30:00`)));
    const task = [ ...plan.critical, ...plan.sections.flatMap((s) => s.tasks), ...plan.onDeck ]
        .find((t) => t.text.includes(words) && (t.state === "open" || t.state === "in_progress"));
    if (!task?.listItemId) throw new Error(`no task "${words}" on ${date}`);
    return task.listItemId;
};
const forward = async (noteId: string, listItemIds: string[], to: string) => {
    const moved = await run(() => service.forward({ items: listItemIds.map((listItemId) => ({ noteId, listItemId, to, onDeck: false })) }));
    expect(moved.results.map((r: { status: string }) => r.status)).toEqual(listItemIds.map(() => "moved"));
};
const show = (input: object) => run(() => service.show(input as never)) as Promise<ShownView | { error: string; detail?: string }>;
/** A `caius_show` answer of view `name`, failing on an error answer or another view. */
async function shown<V extends ShownView["view"]>(name: V, input: object): Promise<Extract<ShownView, { view: V }>> {
    const answer = await show({ view: name, ...input });
    if ("error" in answer || answer.view !== name) throw new Error(`answered ${JSON.stringify(answer)}`);
    return answer as Extract<ShownView, { view: V }>;
}
const plain = (task: ViewTask) => task.text.replace(/\s*\[from [^\]]*\]\([^)]*\)/g, "");
const isLive = (task: ViewTask) => (task.state === "open" || task.state === "in_progress") && task.text.trim() !== "";

beforeAll(async () => {
    await sql_init.dbReady;
    vi.stubEnv("CAIUS_NOW", `${TUE}T09:30`);
    vi.stubEnv("CAIUS_ICAL_URLS", "");
    await run(async () => {
        const [ root ] = await store.search("#calendarRoot");
        const calendarRoot = root ?? (await store.calendarDay(MON), (await store.search("#calendarRoot"))[0]);
        if (!calendarRoot) throw new Error("no #calendarRoot note");
        await store.addLabel(calendarRoot.noteId, "enableWeekNote", "");
        await store.addLabel(createChildNote("root", "🧭 How I work", STANDING), "assistantContext", "");
    });

    const mon = await dayWith(MON, `<h3>Work</h3>${ul(li("m-plumber", "Ring the plumber ~30m"))}`);
    await dayWith(TUE, critical(li("d-rent", "Pay the rent ~10m"))
        + `<h3>Work</h3>${ul(
            li("d-spec", "Write the export spec ZAP-4101 ~2h"),
            li("d-parent", "Plan the demo", ul(li("d-sub1", "Draft the slides ~45m"), li("d-sub2", "Book the room ~15m"))),
            li("d-big", "Rebuild the archive ~1h30m"),
            doneLi("d-donep", "Sort the invoices", ul(li("d-orphan", "File the last one ~20m")))
        )}`
        + `<h3>Personal</h3>${ul(li("d-growth", "🌱 Read a chapter ~1h"), li("d-charge", "🔋 Walk round the park ~30m"))}`
        + `<h2>On deck</h2>${ul(li("d-deck", "Tidy the backlog ~1h"))}`);
    await forward(mon, [ "m-plumber" ], TUE);
    const added = await run(() => service.contextAdd({ week: WEEK, text: "ZAP-4101 is blocked", until: FRI }));
    expect(added.results[0]).toMatchObject({ status: "added" });
});

afterAll(() => {
    vi.unstubAllEnvs();
});

describe("the day view", () => {
    it("weighs the day as readDay and caius_plan do, opens on the area that is over, and lists every row with its ids", async () => {
        const view = await shown("day", { date: TUE });
        const { data } = view;

        const now = new Date(`${TUE}T09:30:00`);
        const frame = await run(() => service.dayFrame(TUE));
        const day = await run(() => withCaiusLock("spec_day_read", async () => readDay(store, frame, await readPlan(store, "day", TUE, now), { date: TUE, now })));
        const plan = await run(() => service.plan({ period: "day", date: TUE }));
        if ("error" in plan || !("load" in plan.capacity)) throw new Error(`caius_plan answered ${JSON.stringify(plan)}`);
        expect(data.load).toEqual(day.load);
        expect(data.load).toEqual(plan.capacity.load);
        // 10 + 120 + 45 + 15 + 90 + 20 + 30: the done parent's live sub-item counts, the parent of live sub-items doesn't.
        expect(data.load.foundation).toMatchObject({ minutes: 330, focus: { min: 180, max: 240 }, over: true, overMinutes: 90 });

        // The phone counts the rows again with the same formulas and gets the same figures.
        const list = data.tasks.filter((t) => t.place === "list");
        const onDeck = data.tasks.filter((t) => t.place === "onDeck");
        expect(dayLoad({
            foundation: liveMinutes(list, "foundation"),
            onDeck: liveMinutes(onDeck, "foundation"),
            growth: liveMinutes(list, "growth"),
            recharge: list.filter((t) => !t.parent && t.area === "recharge" && isLive(t)).length
        }, { focus: data.load.foundation.focus, growthTarget: data.load.growth.target })).toEqual(data.load);

        expect(view.title).toBe("Tuesday 7 Mar");
        expect(view.sentence).toBe("Tuesday: 5 h 30 m of work against 3–4 h, 1 h 30 m over; On deck would add 1 h; Growth: 1 h of 45–60 min; Recharge: 1 thing.");
        expect(data).toMatchObject({ date: TUE, dateLabel: "Tue 7 Mar", openOn: "foundation", calendarFailed: false, drawn: null });
        expect(data.capacity).toEqual({ windowMinutes: day.capacity.windowMinutes, bookedMinutes: 75, openMinutes: day.capacity.openMinutes });
        expect(data.span).toEqual({ start: frame.rhythm.start, noon: frame.rhythm.noon, workEnd: frame.rhythm.workEnd, end: "23:00" });
        expect(data.meetings.map((m) => m.title)).toEqual([ "Daily Standup", "Vendor sync" ]);
        expect(data.unplacedMinutes).toBe(day.layout.unplaced.reduce((n, u) => n + u.minutes, 0));
        expect(data.context).toContainEqual({ text: expect.stringContaining("ZAP-4101 is blocked"), until: FRI, untilLabel: "Fri 10 Mar" });

        const words = data.tasks.map(plain);
        expect(words[0]).toBe("Pay the rent");
        expect(words.at(-1)).toBe("Tidy the backlog");
        expect(words.slice(words.indexOf("Plan the demo"), words.indexOf("Plan the demo") + 3)).toEqual([ "Plan the demo", "Draft the slides", "Book the room" ]);
        expect(words).toEqual(expect.arrayContaining([ "Ring the plumber", "File the last one", "🌱 Read a chapter", "🔋 Walk round the park" ]));
        expect(words).not.toContain("Sort the invoices");
        expect(data.tasks).toHaveLength(11);
        const tuesday = await dayId(TUE);
        for (const task of data.tasks) {
            expect(task).toMatchObject({ noteId: tuesday, listItemId: expect.any(String), ref: expect.stringMatching(/^v[0-9a-f]{5}$/), period: { kind: "day", key: TUE } });
        }
        const row = (text: string) => data.tasks.find((t) => plain(t).startsWith(text));
        expect(row("Pay the rent")).toMatchObject({ critical: true, place: "list", slips: 0 });
        expect(row("Tidy the backlog")).toMatchObject({ place: "onDeck" });
        expect(row("Ring the plumber")).toMatchObject({ slips: 1 });
        expect(row("Write the export spec")?.ticket).toEqual({ key: "ZAP-4101" });
        expect(data.tasks.filter((t) => t.ticket).map(plain)).toEqual([ "Write the export spec ZAP-4101" ]);
        expect(row("Draft the slides")).toMatchObject({ parentListItemId: "d-parent", parent: "Plan the demo" });
    });

    it("opens on the area asked for, and on nothing for a day that fits", async () => {
        expect((await shown("day", { date: TUE, area: "growth" })).data.openOn).toBe("growth");
        await dayWith(THU, `<h3>Work</h3>${ul(li("t-small", "Answer the vendor ~30m"))}`);
        const thursday = await shown("day", { date: THU });
        expect(thursday.data.openOn).toBeNull();
        expect(thursday.data.load.foundation).toMatchObject({ minutes: 30, over: false });
    });
});

describe("the days view", () => {
    it("reads two days and seven, each weighed as the day view weighs it, with the Week row", async () => {
        const week = await run(async () => (await store.calendarWeek(WEEK)).noteId);
        await run(async () => store.putContent(week, `${await store.content(week)}<h3>Work</h3>${ul(li("w-open", "Draft the plan ~2h"))}`));

        const two = await shown("days", { from: MON, count: 2 });
        expect(two.data.days.map((d) => [ d.date, d.dateLabel, d.workday ])).toEqual([ [ MON, "Mon 6 Mar", true ], [ TUE, "Tue 7 Mar", true ] ]);
        const tuesday = two.data.days[1];
        expect(tuesday?.load).toEqual((await shown("day", { date: TUE })).data.load);
        expect(tuesday?.meetingMinutes).toBe(75);
        expect(tuesday?.calendarFailed).toBe(false);
        expect(tuesday?.tasks).toHaveLength(11);
        expect(two.title).toBe("Mon 6 Mar to Tue 7 Mar");
        expect(two.sentence).toContain("Tue over by 1 h 30 m");

        const seven = await shown("days", { from: MON, count: 7 });
        expect(seven.data.days.map((d) => d.workday)).toEqual([ true, true, true, true, true, false, false ]);
        expect(seven.data.from).toBe(MON);
        const now = new Date(`${TUE}T09:30:00`);
        const read = await run(() => readDays({ store, dayFrame: (date) => service.dayFrame(date), locked: withCaiusLock }, MON, 7, now));
        expect(seven.data.week.key).toBe(WEEK);
        expect(seven.data.week.label).toBe("Week 10");
        expect(seven.data.week.foundation).toEqual({ minutes: read.week.foundation.minutes, target: { min: 720, max: 900 } });
        expect(seven.data.week.tasks.map((t) => [ plain(t), t.period, t.place, t.listItemId, t.noteId ])).toEqual([
            [ "Draft the plan", { kind: "week", key: WEEK }, "list", "w-open", week ]
        ]);
        expect(seven.data.week.tasks[0]?.ref).toMatch(/^v[0-9a-f]{5}$/);
        expect(seven.sentence.split("; ")[0]).toMatch(/^Mon /);
    });

    it("refuses a count outside 2 to 7", async () => {
        for (const count of [ 1, 8 ]) {
            expect(await show({ view: "days", from: MON, count })).toMatchObject({ error: "bad_request", detail: expect.stringContaining("2") });
        }
    });
});

describe("the item view", () => {
    it("gives a task forwarded Monday and Tuesday a trail of two moves, and its origin", async () => {
        const mon = await dayId(MON);
        await run(async () => store.putContent(mon, `${await store.content(mon)}<h3>Home</h3>${ul(li("i-shelf", "Build the garage shelf ~1h"))}`));
        await forward(mon, [ "i-shelf" ], TUE);
        await forward(await dayId(TUE), [ await idOn(TUE, "Build the garage shelf") ], WED);
        const wednesday = await dayId(WED);
        const id = await idOn(WED, "Build the garage shelf");

        const view = await shown("item", { item: { noteId: wednesday, listItemId: id } });
        expect(view.data.task).toMatchObject({ noteId: wednesday, listItemId: id, period: { kind: "day", key: WED }, place: "list", slips: 2, area: "foundation", estMinutes: 60 });
        expect(view.data.trail).toEqual([
            { period: { kind: "day", key: MON }, label: "Mon 6 Mar", movedOn: true, state: expect.any(String) },
            { period: { kind: "day", key: TUE }, label: "Tue 7 Mar", movedOn: true, state: expect.any(String) },
            { period: { kind: "day", key: WED }, label: "Wed 8 Mar", movedOn: false, state: "open" }
        ]);
        expect(view.data.origin).toMatchObject({ noteId: mon });
        expect(view.data).toMatchObject({ ticket: null, context: [], dispositions: [], today: TUE, nextWorkday: WED, week: WEEK });
        expect(view.title).toBe("Build the garage shelf");
        expect(view.sentence).toBe("Build the garage shelf: moved on from Mon 6 Mar and Tue 7 Mar; on Wed 8 Mar now.");
    });

    it("gives a key no task names the ticket alone", async () => {
        const view = await shown("item", { key: "zap-4200" });
        expect(view.data).toMatchObject({ task: null, trail: [], origin: null });
        expect(view.data.ticket).toEqual({
            key: "ZAP-4200", summary: "Fix the export", status: "In Review", daysInStatus: 3, assignee: "Sam Lee",
            url: "https://jira.example.com/browse/ZAP-4200", done: false,
            lastComment: { author: "Sam Lee", created: "2034-03-06T12:00:00.000Z", excerpt: "Pushed a fix." },
            ask: { author: "Riley", created: "2034-03-06T09:00:00.000Z", excerpt: "Can you look?" }
        });
        expect(view.title).toBe("ZAP-4200 Fix the export");
        expect(view.sentence).toBe("ZAP-4200: In Review for 3 days; last comment from Sam Lee.");
        expect(await shown("item", { key: "ZAP-4999" })).toMatchObject({ data: { task: null, ticket: { key: "ZAP-4999", error: "not_found" } } });
        expect(await show({ view: "item" })).toMatchObject({ error: "bad_request" });
        expect(await show({ view: "item", item: { noteId: "nope", listItemId: "nope" } })).toMatchObject({ error: "not_found" });
    });

    it("gives a key a task names both, with the Context lines naming it and what was said about it", async () => {
        const tuesday = await dayId(TUE);
        expect(await run(() => service.finished({ keys: [ "ZAP-4101" ] }))).not.toHaveProperty("error");
        await run(() => store.addLabel(tuesday, "caiusNotToday", "ZAP-4101"));
        await run(() => store.addLabel(tuesday, "caiusDismissed", "ZAP-4101"));
        const old = await dayId("2034-01-02");
        await run(() => store.addLabel(old, "caiusDismissed", "ZAP-4101"));

        const view = await shown("item", { key: "ZAP-4101" });
        expect(view.data.task).toMatchObject({ noteId: tuesday, listItemId: "d-spec", ticket: { key: "ZAP-4101", status: "In Review" } });
        expect(view.data.ticket).toMatchObject({ key: "ZAP-4101", status: "In Review" });
        expect(view.data.context).toEqual([ { text: expect.stringContaining("ZAP-4101 is blocked"), until: FRI, untilLabel: "Fri 10 Mar" } ]);
        expect(view.data.dispositions).toEqual([
            { kind: "dismissed", until: "2034-03-21" },
            { kind: "finished", until: "2034-04-06" },
            { kind: "not_today", until: TUE }
        ]);

        // The task's own ids lead to its key's ticket too.
        const byIds = await shown("item", { item: { noteId: tuesday, listItemId: "d-spec" } });
        expect(byIds.data.ticket).toMatchObject({ key: "ZAP-4101" });
        expect(byIds.sentence).toContain("ZAP-4101: In Review for 3 days");
    });
});

describe("the slipping view", () => {
    const S1 = "2034-03-13";
    const S2 = "2034-03-14";
    const S3 = "2034-03-15";
    const S4 = "2034-03-16";

    it("lists the tasks with two moves or more, longest first, and the overdue lane by age", async () => {
        const before = await shown("slipping", {});

        const first = await dayWith(S1, `<h3>Work</h3>${ul(li("s-gate", "Fix the gate ~30m"), li("s-fence", "Paint the fence ~1h"), li("s-once", "Oil the hinge ~10m"))}`);
        await forward(first, [ "s-gate", "s-fence", "s-once" ], S2);
        await forward(await dayId(S2), [ await idOn(S2, "Fix the gate"), await idOn(S2, "Paint the fence") ], S3);
        await forward(await dayId(S3), [ await idOn(S3, "Fix the gate") ], S4);
        await dayWith("2034-03-03", `<h3>Work</h3>${ul(li("o-week", "Late by four days"))}`);
        await dayWith("2034-02-25", `<h3>Work</h3>${ul(li("o-two", "Late by ten days"))}`);
        await dayWith("2034-01-30", `<h3>Work</h3>${ul(li("o-old", "Late by five weeks"))}`);

        const view = await shown("slipping", {});
        const mine = view.data.tasks.filter((t) => [ "Fix the gate", "Paint the fence", "Oil the hinge" ].some((w) => plain(t).startsWith(w)));
        expect(mine.map((t) => [ plain(t), t.slips, t.period.key ])).toEqual([ [ "Fix the gate", 3, S4 ], [ "Paint the fence", 2, S3 ] ]);
        expect(view.data.tasks.every((t) => t.slips >= 2)).toBe(true);
        const slips = view.data.tasks.map((t) => t.slips);
        expect(slips).toEqual([ ...slips ].sort((a, b) => b - a));
        for (const task of view.data.tasks) {
            expect(task).toMatchObject({ noteId: expect.any(String), listItemId: expect.any(String), ref: expect.stringMatching(/^v[0-9a-f]{5}$/), place: "list" });
        }
        expect(view.data.overdue).toEqual({
            underWeek: before.data.overdue.underWeek + 1,
            oneToTwoWeeks: before.data.overdue.oneToTwoWeeks + 1,
            older: before.data.overdue.older + 1
        });
        expect(view.data.parkMonth).toBe("2034-03");
        expect(view.title).toBe("What keeps slipping");
        expect(view.sentence).toMatch(/^\d+ tasks keep slipping; the longest has moved \d+ times\. \d+ overdue\.$/);

        const inWeek = await shown("slipping", { period: "2034-W11" });
        expect(inWeek.data.tasks.map(plain)).toEqual([ "Fix the gate", "Paint the fence" ]);
        expect(await show({ view: "slipping", period: "next week" })).toMatchObject({ error: "bad_request" });
    });
});

describe("the size of a reply", () => {
    const words = (n: number) => `Task number ${n} with a long description that goes on about what it is for and why`;

    it("keeps a Days reply within MAX_REPLY_CHARS by capping each day's rows", async () => {
        for (const date of [ "2034-03-20", "2034-03-21", "2034-03-22", "2034-03-23", "2034-03-24" ]) {
            await dayWith(date, `<h3>Work</h3>${ul(...Array.from({ length: 30 }, (_, n) => li(`${date}-${n}`, `${words(n)} ~15m`)))}`);
        }
        const view = await shown("days", { from: "2034-03-20", count: 7 });
        expect(JSON.stringify(view).length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
        expect(view.data.days).toHaveLength(7);
        expect(view.data.days[0]?.load.foundation.minutes).toBe(450);
        const rows = view.data.days.reduce((n, d) => n + d.tasks.length, 0);
        expect(rows).toBeGreaterThan(0);
        expect(rows).toBeLessThan(150);
        expect((view.data as { omitted?: Record<string, number> }).omitted).toBeDefined();
    });

    it("cuts a parent together with its sub-items, never a sub-item alone", async () => {
        const DATE = "2034-04-03";
        const subs = Array.from({ length: 30 }, (_, n) => li(`cap-sub-${n}`, `${words(n)} ~10m`));
        await dayWith(DATE, `<h3>Work</h3>${ul(...Array.from({ length: 25 }, (_, n) => li(`cap-${n}`, `${words(n)} ~15m`)), li("cap-parent", "Plan the move", ul(...subs)))}`);
        const view = await shown("day", { date: DATE });
        const ids = view.data.tasks.map((task) => task.listItemId);
        expect(JSON.stringify(view).length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
        expect(ids).toContain("cap-0");
        expect(ids).not.toContain("cap-parent");
        expect(view.data.tasks.filter((task) => task.parentListItemId === "cap-parent")).toEqual([]);
        expect(ids.length + ((view.data as { omitted?: Record<string, number> }).omitted?.tasks ?? 0)).toBe(56);
    });

    it("keeps a Slipping reply within MAX_REPLY_CHARS, with its rows capped", async () => {
        const first = await dayWith("2034-03-27", `<h3>Work</h3>${ul(...Array.from({ length: 40 }, (_, n) => li(`slip-${n}`, words(n))))}`);
        await forward(first, Array.from({ length: 40 }, (_, n) => `slip-${n}`), "2034-03-28");
        const plan = await run(() => readPlan(store, "day", "2034-03-28", new Date(`${TUE}T09:30:00`)));
        const second = await dayId("2034-03-28");
        await forward(second, plan.sections.flatMap((s) => s.tasks).flatMap((t) => t.listItemId ? [ t.listItemId ] : []), "2034-03-29");

        const view = await shown("slipping", {});
        expect(JSON.stringify(view).length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
        expect(view.data.tasks.length).toBeLessThanOrEqual(30);
        expect(view.data.tasks.length).toBeGreaterThan(0);
    });
});

describe("the tool", () => {
    it("caius_show reads only, and answers as the service does", async () => {
        const tools = createCaiusTools(store, async () => undefined, inputsOf);
        const def = [ ...tools ].find(([ name ]) => name === "caius_show")?.[1];
        expect(def?.mutates).toBeFalsy();
        const answer = await run(() => Promise.resolve(def?.execute({ view: "day", date: THU }))) as ShownView;
        expect(answer).toMatchObject({ view: "day", title: "Thursday 9 Mar", data: { date: THU } });
    });
});

describe("a day whose calendar fails", () => {
    it("is flagged, and its load still matches caius_plan's", async () => {
        const failing = createCaiusService(store, undefined, inputsOf, () => 0, undefined,
            async () => ({ events: [], errors: [ { source: "calendar" as const, error: "feed_0_timeout" } ] }));
        const view = await run(() => failing.show({ view: "day", date: FRI } as never)) as ShownView;
        if (view.view !== "day") throw new Error("not a day view");
        const plan = await run(() => failing.plan({ period: "day", date: FRI }));
        if ("error" in plan || !("load" in plan.capacity)) throw new Error("no plan");
        expect(view.data.calendarFailed).toBe(true);
        expect(view.data.load).toEqual(plan.capacity.load);
        expect(view.data.capacity.bookedMinutes).toBe(0);
    });
});
