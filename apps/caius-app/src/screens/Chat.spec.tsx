// @vitest-environment happy-dom
import { render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "./Chat.js";

type ComposerChat = Parameters<typeof Composer>[0]["chat"];

let root: HTMLElement;
let sent: string[];

beforeEach(() => {
    sent = [];
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

function Harness({ initial }: { initial: string }) {
    const [ draft, setDraft ] = useState(initial);
    const chat = {
        draft,
        setDraft,
        pending: null,
        state: "idle",
        send: vi.fn(async (text: string) => {
            sent.push(text);
        }),
        leaveOut: vi.fn()
    } as unknown as ComposerChat;
    return <Composer chat={chat} placeholder="Say something" />;
}

function box(): HTMLTextAreaElement {
    const found = root.querySelector("textarea");
    if (!found) {
        throw new Error("no textarea");
    }
    return found;
}

describe("Composer", () => {
    it("adds a line on Enter and sends only from the Send button", () => {
        act(() => render(<Harness initial="" />, root));
        act(() => {
            box().value = "Ana is out Tuesday";
            box().dispatchEvent(new Event("input", { bubbles: true }));
        });

        const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        act(() => {
            box().dispatchEvent(enter);
        });
        expect(enter.defaultPrevented).toBe(false);
        expect(sent).toEqual([]);

        const button = root.querySelector<HTMLButtonElement>("[aria-label='Send']");
        if (!button) {
            throw new Error("no Send button");
        }
        act(() => button.click());
        expect(sent).toEqual(["Ana is out Tuesday"]);
    });

    it("shows three rows once the text has a line break", () => {
        act(() => render(<Harness initial={"Ana is out\nTuesday"} />, root));
        expect(Number(box().rows)).toBe(3);
        act(() => render(null, root));
        act(() => render(<Harness initial="Ana" />, root));
        expect(Number(box().rows)).toBe(1);
    });
});
