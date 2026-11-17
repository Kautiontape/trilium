import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Component from "../../components/component";
import options from "../../services/options";
import { ParentComponent } from "../react/react_utils";
import CaiusForwardDialog, { type CaiusForwardPick, isForwardKey } from "./caius_forward";

// i18next is never initialised under test, so `t` echoes the key it is given.
vi.mock("../../services/i18n", () => ({ t: (key: string) => key }));
vi.mock("../../services/caius", () => ({ caiusNow: () => new Date() }));

describe("CaiusForwardDialog", () => {
    let container: HTMLElement;
    let host: Component;
    let answers: (CaiusForwardPick | null)[];

    beforeEach(() => {
        // Tuesday 27 October 2026, in ISO week 44.
        vi.useFakeTimers({ toFake: [ "Date" ] });
        vi.setSystemTime(new Date(2026, 9, 27, 12));
        options.load({ firstDayOfWeek: 1, firstWeekOfYear: 0, minDaysInFirstWeek: 4 } as Parameters<typeof options.load>[0]);
        answers = [];
        container = document.createElement("div");
        document.body.appendChild(container);
        host = new Component();
        act(() => {
            render(
                <ParentComponent.Provider value={host}>
                    <CaiusForwardDialog />
                </ParentComponent.Provider>,
                container);
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        render(null, container);
        container.remove();
    });

    it("fills the box from a day, a week number or the month's name", async () => {
        await open();
        expect(dialog()?.querySelector(".caius-forward-month")?.textContent).toContain("2026");

        await press(found(`[data-calendar-date="2026-10-29"]`));
        expect(field().value).toBe("2026-10-29");
        expect(placements()).toEqual([ "caius.forward_pick_on_deck", "caius.forward_pick_list", "caius.forward_pick_critical" ]);

        await press(found(`a[data-calendar-week-number="43"]`));
        expect(field().value).toBe("2026-W43");
        expect(placements()).toEqual([]);

        await press(found(".caius-forward-month"));
        expect(field().value).toBe("2026-10");
        expect(placements()).toEqual([]);
    });

    it("answers with the pick, and for a day where on it the task goes", async () => {
        await open();
        await press(found(`[data-calendar-date="2026-10-29"]`));
        await submit();
        expect(answers).toEqual([ { to: "2026-10-29", onDeck: false } ]);

        await open();
        await press(found(`[data-calendar-date="2026-10-30"]`));
        await press(placementButton("caius.forward_pick_critical"));
        await submit();
        await open();
        await press(found(`a[data-calendar-week-number="44"]`));
        await submit();
        expect(answers.slice(1)).toEqual([ { to: "2026-10-30", critical: true }, { to: "2026-W44" } ]);
    });

    it("forwards only a day, a week or a month, typed or picked", async () => {
        await open();
        expect(submitButton().disabled).toBe(true);

        await type("next tuesday");
        expect(submitButton().disabled).toBe(true);
        expect(dialog()?.textContent).toContain("caius.forward_pick_invalid");
        await submit();
        expect(answers).toEqual([]);

        await type(" 2026-11 ");
        expect(submitButton().disabled).toBe(false);
        await submit();
        expect(answers).toEqual([ { to: "2026-11" } ]);
    });

    it("answers with nothing when closed without a pick", async () => {
        await open();
        await press(found(`[data-calendar-date="2026-10-29"]`));
        await close();
        expect(answers).toEqual([ null ]);
    });

    async function open() {
        await act(async () => {
            await host.handleEvent("showCaiusForwardDialog", { callback: (pick: CaiusForwardPick | null) => answers.push(pick) });
            await Promise.resolve();
        });
    }

    /** Submits the form, then sends the event Bootstrap fires once the dialog has closed. */
    async function submit() {
        const closes = !submitButton().disabled;
        await act(async () => {
            dialog()?.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            await Promise.resolve();
        });
        if (closes) await close();
    }

    async function close() {
        await act(async () => {
            dialog()?.dispatchEvent(new Event("hidden.bs.modal", { bubbles: true }));
            await Promise.resolve();
        });
    }

    async function press(element: HTMLElement) {
        await act(async () => {
            element.click();
            await Promise.resolve();
        });
    }

    async function type(value: string) {
        await act(async () => {
            const input = field();
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await Promise.resolve();
        });
    }

    function dialog() {
        return document.querySelector<HTMLElement>(".modal.caius-forward-dialog");
    }

    function found(selector: string) {
        const element = dialog()?.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`No ${selector}`);
        return element;
    }

    function field() {
        return found("input.form-control") as HTMLInputElement;
    }

    function submitButton() {
        return found(".modal-footer .btn-primary") as HTMLButtonElement;
    }

    function placements() {
        return [ ...(dialog()?.querySelectorAll<HTMLElement>(".form-group:last-child button") ?? []) ]
            .map((button) => button.textContent?.trim() ?? "")
            .filter((text) => text.startsWith("caius.forward_pick_"));
    }

    function placementButton(label: string) {
        const button = [ ...(dialog()?.querySelectorAll<HTMLElement>("button") ?? []) ]
            .find((candidate) => candidate.textContent?.trim() === label);
        if (!button) throw new Error(`No button ${label}`);
        return button;
    }
});

describe("isForwardKey", () => {
    it("recognizes a day, an ISO week or a month", () => {
        for (const key of [ "2026-10-28", "2026-W01", "2026-W53", "2026-11" ]) {
            expect(isForwardKey(key)).toBe(true);
        }
        for (const key of [ "2026-13", "2026-W54", "2026-W00", "2026-10-32", "26-10-28", "tomorrow" ]) {
            expect(isForwardKey(key)).toBe(false);
        }
    });
});
