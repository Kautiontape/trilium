// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Icon } from "./ui.js";

let root: HTMLElement;

beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
});

afterEach(() => {
    act(() => render(null, root));
    root.remove();
});

describe("Icon", () => {
    it("sizes its box in px, 24 by default", () => {
        act(() => render(<><Icon name="check" /><Icon name="close" size={18} /></>, root));
        const boxes = [ ...root.querySelectorAll<HTMLElement>(".icon") ].map((icon) => [ icon.style.width, icon.style.height ]);
        expect(boxes).toEqual([ [ "24px", "24px" ], [ "18px", "18px" ] ]);
    });
});
