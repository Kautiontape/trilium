import type { ElectronContextMenuParams } from "@triliumnext/commons";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    buildNoteContextMenuItems: vi.fn(async (): Promise<unknown[]> => [ { title: "caius.task" } ]),
    show: vi.fn()
}));

vi.mock("../components/zoom.js", () => ({ default: { getCurrentZoom: () => 2 } }));
vi.mock("./context_menu.js", () => ({ default: { show: h.show } }));
vi.mock("./note_context_menu.js", () => ({ buildNoteContextMenuItems: h.buildNoteContextMenuItems }));

import electronContextMenu from "./electron_context_menu.js";

describe("the Electron context menu", () => {
    it("hands the builder the element under the pointer, in CSS pixels", async () => {
        let onContextMenu: ((params: ElectronContextMenuParams) => Promise<void>) | undefined;
        window.electronApi = {
            contextMenu: {
                onContextMenu: (listener: typeof onContextMenu) => {
                    onContextMenu = listener;
                }
            }
        } as never;
        const task = document.createElement("li");
        const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(task);

        electronContextMenu.setupContextMenu();
        await onContextMenu?.({
            x: 300,
            y: 120,
            linkURL: "",
            linkText: "",
            mediaType: "none",
            isEditable: true,
            selectionText: "",
            misspelledWord: "",
            dictionarySuggestions: [],
            editFlags: { canCut: false, canCopy: false, canPaste: true }
        } as unknown as ElectronContextMenuParams);

        expect(elementFromPoint).toHaveBeenCalledWith(150, 60);
        expect(h.buildNoteContextMenuItems).toHaveBeenCalledWith(
            expect.objectContaining({ element: task, selectionText: "" }),
            expect.anything()
        );
        expect(h.show).toHaveBeenCalledWith(expect.objectContaining({ x: 150, y: 60 }));
    });
});
