import { describe, expect, it } from "vitest";

import { carryListItemIds } from "./list_item_ids.js";

function counter() {
    let n = 0;
    return () => `fresh${++n}`;
}

function idsOf(html: string) {
    return [...html.matchAll(/data-list-item-id="([^"]*)"/g)].map((match) => match[1]);
}

function list(items: string[], tag = "ul") {
    return `<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`;
}

function withIds(items: [string, string][], tag = "ul") {
    const lis = items.map(([id, text]) => `<li data-list-item-id="${id}">${text}</li>`);
    return `<${tag}>${lis.join("")}</${tag}>`;
}

function todo(id: string, text: string, state = "", sub = "") {
    const attrs = (id ? ` data-list-item-id="${id}"` : "")
        + (state ? ` data-trilium-task-state="${state}"` : "");
    const open = `<li${attrs}`;
    return `${open}><label class="todo-list__label"><input type="checkbox" disabled="disabled">`
        + `<span class="todo-list__label__description">${text}</span></label>${sub}</li>`;
}

describe("carryListItemIds", () => {
    it("keeps ids of unchanged items and leaves other markup byte for byte", () => {
        const html = `<p>Intro &nbsp; text</p><ul><li>Alpha</li><li>Beta</li></ul>`
            + `<ol><li>One</li></ol><ul class="todo-list"><li><label>Task</label></li></ul>`;
        const previous = `<ul><li data-list-item-id="ea">Alpha</li>`
            + `<li data-list-item-id="eb">Beta</li></ul>`
            + `<ol><li data-list-item-id="e1">One</li></ol>`
            + `<ul class="todo-list"><li data-list-item-id="et"><label>Task</label></li></ul>`;

        const result = carryListItemIds(previous, html, counter());

        expect(idsOf(result)).toEqual(["ea", "eb", "e1", "et"]);
        expect(result.replace(/ data-list-item-id="[^"]*"/g, "")).toBe(html);
        expect(result).toContain(`<li data-list-item-id="ea">Alpha</li>`);
    });

    it("returns html unchanged when it has no list items", () => {
        const result = carryListItemIds("<ul><li>x</li></ul>", "<p>none</p>", counter());

        expect(result).toBe("<p>none</p>");
    });

    it("keeps the id of an item reworded in place, not one with unrelated text", () => {
        const previous = withIds([["e1", "Pick a contract shape"], ["e2", "Count the seats"]]);
        const html = list(["Pick the contract shape", "Book the venue"]);

        expect(idsOf(carryListItemIds(previous, html, counter()))).toEqual(["e1", "fresh1"]);
    });

    it("matches a reworded item below an inserted line", () => {
        const previous = withIds([["e1", "Pick a contract shape"], ["e2", "Send the invoice"]]);
        const html = list(["Brand new line", "Pick a contract shape", "Send the invoices"]);

        expect(idsOf(carryListItemIds(previous, html, counter()))).toEqual(["fresh1", "e1", "e2"]);
    });

    it("keeps each id through a reorder", () => {
        const previous = withIds([["e1", "Alpha"], ["e2", "Bravo"], ["e3", "Charlie"]]);
        const html = list(["Charlie", "Alpha", "Bravo"]);

        expect(idsOf(carryListItemIds(previous, html, counter()))).toEqual(["e3", "e1", "e2"]);
    });

    it("pairs duplicate texts in order", () => {
        const ab = withIds([["e1", "A"], ["e2", "B"]]);
        expect(idsOf(carryListItemIds(ab, list(["A", "A", "B"]), counter())))
            .toEqual(["e1", "fresh1", "e2"]);

        const aa = withIds([["e1", "A"], ["e2", "A"]]);
        expect(idsOf(carryListItemIds(aa, list(["A", "A"]), counter()))).toEqual(["e1", "e2"]);
    });

    it("keeps todo items and nested sub-items, ignoring a task-state change", () => {
        const sub = (id: string) => `<ul class="todo-list">${todo(id, "Draft")}</ul>`;
        const parent = todo("eone", "Count the seats", "", sub("esub"));
        const previous = `<ul class="todo-list">${parent}</ul>`;
        const html = `<ul class="todo-list">`
            + `${todo("", "Count the seats", "_rescheduled", sub(""))}</ul>`;

        const result = carryListItemIds(previous, html, counter());

        expect(idsOf(result)).toEqual(["eone", "esub"]);
        expect(result.replace(/ data-list-item-id="[^"]*"/g, "")).toBe(html);
    });

    it("keeps same-text sub-items with their swapped parents", () => {
        const group = (id: string, name: string, subId: string) =>
            todo(id, name, "", `<ul>${todo(subId, "Draft")}</ul>`);
        const previous = `<ul>${group("ep1", "Parent one", "es1")}`
            + `${group("ep2", "Parent two", "es2")}</ul>`;
        const html = `<ul>${group("", "Parent two", "")}${group("", "Parent one", "")}</ul>`;

        expect(idsOf(carryListItemIds(previous, html, counter())))
            .toEqual(["ep2", "es2", "ep1", "es1"]);
    });

    it("falls back to the first same-text item when the parent has no counterpart", () => {
        const nested = (id: string) => `<ul>${todo(id, "Draft")}</ul>`;
        const previous = `<ul>${todo("ep", "Plan the offsite", "", nested("es"))}`
            + `${todo("et", "Draft")}</ul>`;
        const html = `<ul>${todo("", "Plan the offsite with Ana", "", nested(""))}`
            + `${todo("", "Draft")}</ul>`;

        expect(idsOf(carryListItemIds(previous, html, counter()))).toEqual(["ep", "es", "et"]);
    });

    it("matches an edited item only between its matched neighbours", () => {
        const previous = withIds([["ea", "A"], ["ex", "Pick a contract shape"], ["eb", "B"],
            ["ec", "C"]]);
        const html = list(["A", "B", "Pick the contract shape", "C"]);

        expect(idsOf(carryListItemIds(previous, html, counter())))
            .toEqual(["ea", "eb", "fresh1", "ec"]);
    });

    it("gives equally similar candidates to the earliest one", () => {
        // "email cy" shares 5 of 7 bigrams with both "email ana" and "email ben" (8 each).
        const previous = withIds([["eh", "Head"], ["ex1", "Email Ana"], ["ex2", "Email Ben"],
            ["et", "Tail"]]);
        const html = list(["Head", "Email Cy", "Tail"]);

        expect(idsOf(carryListItemIds(previous, html, counter()))).toEqual(["eh", "ex1", "et"]);
    });

    it("matches at a similarity of exactly 0.5 and not below", () => {
        // abcde / abcxy: 2 common of 4 + 4 bigrams = 4/8. abcdef / abcxyz: 2 of 5 + 5 = 4/10.
        const at = carryListItemIds(withIds([["e1", "abcde"]]), list(["abcxy"]), counter());
        const below = carryListItemIds(withIds([["e1", "abcdef"]]), list(["abcxyz"]), counter());

        expect(idsOf(at)).toEqual(["e1"]);
        expect(idsOf(below)).toEqual(["fresh1"]);
    });

    it("matches upper-case list markup", () => {
        const result = carryListItemIds(withIds([["e1", "A"]]), "<UL><LI>A</LI></UL>", counter());

        expect(idsOf(result)).toEqual(["e1"]);
    });

    it("never reuses an id and gives fresh ids to items without a counterpart id", () => {
        const dup = withIds([["e1", "A"], ["e1", "B"]]);
        expect(idsOf(carryListItemIds(dup, list(["A", "B"]), counter()))).toEqual(["e1", "fresh1"]);

        const noId = `<ul><li>A</li><li data-list-item-id="e2">B</li></ul>`;
        const replaced = withIds([["estale", "A"], ["estale2", "B"]]);
        expect(idsOf(carryListItemIds(noId, replaced, counter()))).toEqual(["fresh1", "e2"]);
    });

    it("gives every item a fresh id from an empty previous, in the CKEditor format", () => {
        const html = list(["A", "B"]);

        expect(idsOf(carryListItemIds("", html, counter()))).toEqual(["fresh1", "fresh2"]);
        const ids = idsOf(carryListItemIds("", html));
        expect(ids).toHaveLength(2);
        expect(ids[0]).toMatch(/^e[0-9a-f]{32}$/);
        expect(ids[0]).not.toBe(ids[1]);
    });
});
