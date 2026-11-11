import type { CKTextEditor } from "@triliumnext/ckeditor5";
import { attachmentIcon } from "@triliumnext/commons";
import {
    _getModelData, _setModelData, ClassicEditor, CodeBlock, Essentials, HorizontalLine, List,
    Paragraph, Table
} from "ckeditor5";
import type { VNode } from "preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type FAttachment from "../../../entities/fattachment";
import type FNote from "../../../entities/fnote";

const MediaPreviewStub = vi.hoisted(() => () => null);

vi.mock("../../../services/froca", () => ({
    default: { getNote: vi.fn(), getAttachment: vi.fn() }
}));
vi.mock("../../../services/link", () => ({
    default: { createLink: vi.fn() }
}));
vi.mock("../../../services/content_renderer", () => ({
    default: {
        getRenderedContent: vi.fn(),
        getRenderingType: vi.fn(),
        isSelfUpdatingType: (type: string) => type === "canvasDrawing",
        disposeInteractiveContent: vi.fn(),
        mountInteractiveWidget: vi.fn()
    },
    CONTENT_RENDERERS: { file: { media: async () => ({ default: MediaPreviewStub }) } },
    getEmbedContentInfo: (entity: { mime?: string }) => ({
        defaultBoxSize: "resizable",
        hasCompactContent: !!entity.mime?.startsWith("audio/")
    })
}));
vi.mock("./ContentEmbed", () => ({
    default: () => null,
    CompactContentEmbed: () => null,
    ContentEmbedError: () => null,
    getNoteActions: vi.fn()
}));
vi.mock("../../../services/i18n", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    t: (key: string, options?: object) => `${key} ${JSON.stringify(options)}`
}));
vi.mock("../../../services/attachment_actions", () => ({
    getOpenExternallyAction: vi.fn(),
    getDownloadAction: vi.fn()
}));
vi.mock("../../../menus/link_context_menu", () => ({
    default: {
        openContextMenu: vi.fn(),
        openEmbedContextMenu: vi.fn(),
        getOriginBelow: vi.fn((anchor: Element, target: Element) => ({ anchor, target }))
    }
}));

import linkContextMenu from "../../../menus/link_context_menu";
import { getDownloadAction, getOpenExternallyAction } from "../../../services/attachment_actions";
import content_renderer from "../../../services/content_renderer";
import froca from "../../../services/froca";
import link from "../../../services/link";
import LoadResults from "../../../services/load_results";
import { registerContentEmbedTools } from "./content_embed_tools";
import ContentEmbed, {
    ContentEmbedError,
    getNoteActions,
    type ContentEmbedAction,
    type ContentEmbedProps,
    CompactContentEmbed,
    type CompactContentEmbedProps
} from "./ContentEmbed";
import EmbedHistories from "./embed_history";
import {
    getAttachmentHref,
    loadEmbeddedAttachment,
    loadEmbeddedNote,
    loadUnknownEmbed,
    loadMediaEmbed,
    openContentEmbedMenu,
    refreshAttachmentImages,
    refreshEmbeddedNote,
    setDataKeepingSelection,
    setupTodoCheckboxTaps,
    showsAttachmentSave,
    watchContentEmbeds
} from "./utils";

const note = { noteId: "noteY", getIcon: () => "bx bx-note" } as unknown as FNote;
const attachment = {
    attachmentId: "att1",
    ownerId: "owner",
    role: "file",
    mime: "application/pdf",
    contentLength: 2048
} as unknown as FAttachment;
const ATTACHMENT_SCOPE = { viewMode: "attachments", attachmentId: "att1" };

let title: HTMLElement;
let content: HTMLElement;

beforeEach(() => {
    vi.clearAllMocks();
    title = document.createElement("span");
    content = document.createElement("div");
    vi.mocked(froca.getNote).mockResolvedValue(note);
    vi.mocked(froca.getAttachment).mockResolvedValue(attachment);
    vi.mocked(link.createLink).mockResolvedValue($(title));
    vi.mocked(content_renderer.getRenderedContent)
        .mockResolvedValue({ $renderedContent: $(content), type: "pdf" } as never);
});

function action(title: string): ContentEmbedAction {
    return { title, icon: `bx bx-${title}`, run: vi.fn() };
}

/** The embed box mounted last, and the element it was mounted in. */
function lastMount() {
    const call = vi.mocked(content_renderer.mountInteractiveWidget).mock.lastCall;
    if (!call) {
        throw new Error("Expected a mounted embed box.");
    }
    const vnode = call[0] as VNode<ContentEmbedProps & CompactContentEmbedProps>;
    return { type: vnode.type, props: vnode.props, container: call[1] };
}

afterEach(() => {
    document.body.replaceChildren();
});

/** Puts `element` in the page, where the embeds that load are. */
function inPage<T extends HTMLElement>(element: T) {
    document.body.append(element);
    return element;
}

function createWrapper() {
    const wrapper = inPage(document.createElement("div"));
    wrapper.className = "include-note-wrapper";
    return wrapper;
}

describe("loadEmbeddedNote", () => {
    it("mounts a box with the note, whose embeds show in boxes too", async () => {
        const wrapper = createWrapper();
        const seenNoteIds = new Set([ "host" ]);

        await loadEmbeddedNote("noteY", $(wrapper), "medium", { seenNoteIds });

        expect(link.createLink).toHaveBeenCalledWith("noteY", {
            showTooltip: false,
            showNoteIcon: true
        });
        expect(content_renderer.getRenderedContent).toHaveBeenCalledWith(note, {
            interactive: true,
            embedBoxes: true,
            seenNoteIds: new Set([ "host" ]),
            mediaEnvironment: "embedded",
            hasDisplayModes: true
        });
        // The renderer adds the note to the set it is given.
        expect(vi.mocked(content_renderer.getRenderedContent).mock.lastCall?.[1]?.seenNoteIds)
            .not.toBe(seenNoteIds);
        const mount = lastMount();
        expect(mount.type).toBe(ContentEmbed);
        expect(mount.container).toBe(wrapper);
        expect(mount.props).toEqual({
            boxSize: "medium",
            title,
            content,
            contentType: "pdf",
            notePath: "noteY",
            isExcerpt: false
        });
    });

    it("mounts a box that tells a note no longer exists", async () => {
        vi.mocked(froca.getNote).mockResolvedValue(null);
        const wrapper = createWrapper();

        await loadEmbeddedNote("noteY", $(wrapper), "small");

        expect(froca.getNote).toHaveBeenCalledWith("noteY", true);
        expect(link.createLink).not.toHaveBeenCalled();
        expect(content_renderer.getRenderedContent).not.toHaveBeenCalled();
        const mount = lastMount();
        expect(mount.type).toBe(ContentEmbedError);
        expect(mount.container).toBe(wrapper);
        expect(mount.props).toEqual({
            boxSize: "small",
            icon: "bx bx-error-alt",
            text: 'include_note.missing_note {"noteId":"noteY"}'
        });
    });

    it("mounts a Compact box with the note's path, without the note or a caption", async () => {
        const actions = [ action("edit"), action("open") ];
        vi.mocked(getNoteActions).mockReturnValue(actions);
        const figure = inPage(document.createElement("figure"));
        figure.className = "include-note";
        figure.dataset.boxSize = "compact";
        figure.innerHTML = "<figcaption>Caption</figcaption>";

        await loadEmbeddedNote("noteY", $(figure));

        expect(link.createLink).toHaveBeenCalledWith("noteY", {
            showTooltip: false,
            showNotePath: true
        });
        expect(content_renderer.getRenderedContent).not.toHaveBeenCalled();
        expect(getNoteActions).toHaveBeenCalledWith("noteY");
        const mount = lastMount();
        expect(mount.type).toBe(CompactContentEmbed);
        expect([ ...figure.childNodes ]).toEqual([ mount.container ]);
        expect(mount.props).toEqual({
            icon: "bx bx-note",
            title,
            notePath: "noteY",
            actions
        });
    });
});

describe("loadEmbeddedNote of blocks", () => {
    it("shows only the blocks, and opens the note at them", async () => {
        const wrapper = createWrapper();
        const figure = inPage(document.createElement("figure"));
        figure.className = "include-note";
        figure.dataset.boxSize = "compact";

        const onBlockChange = vi.fn();
        await loadEmbeddedNote("noteY", $(wrapper), "medium", { block: "b1:b2", onBlockChange });

        const viewScope = { block: "b1:b2" };
        expect(link.createLink)
            .toHaveBeenCalledWith("noteY", expect.objectContaining({ viewScope }));
        expect(content_renderer.getRenderedContent).toHaveBeenCalledWith(note,
            expect.objectContaining({ block: "b1:b2", onBlockChange }));
        expect(lastMount().props).toMatchObject({ viewScope, isExcerpt: true });

        await loadEmbeddedNote("noteY", $(figure), undefined, { block: "b1" });

        expect(lastMount().type).toBe(CompactContentEmbed);
        expect(lastMount().props.viewScope).toEqual({ block: "b1" });
        expect(lastMount().container.classList.contains("excerpt")).toBe(true);
    });

    it("marks the wrapper of an excerpt, and unmarks it for a whole note", async () => {
        const wrapper = createWrapper();

        await loadEmbeddedNote("noteY", $(wrapper), "medium", { block: "b1" });
        expect(wrapper.className).toBe("include-note-wrapper excerpt");

        await loadEmbeddedNote("noteY", $(wrapper), "medium");
        expect(wrapper.className).toBe("include-note-wrapper");
        expect(lastMount().props.isExcerpt).toBe(false);
    });
});

describe("loadEmbeddedAttachment", () => {
    it("mounts a box with the attachment, opened in its note", async () => {
        const wrapper = createWrapper();

        await loadEmbeddedAttachment("att1", $(wrapper), "full");

        expect(froca.getAttachment).toHaveBeenCalledWith("att1", true);
        expect(link.createLink).toHaveBeenCalledWith("owner", {
            showTooltip: false,
            showNoteIcon: true,
            viewScope: ATTACHMENT_SCOPE
        });
        expect(content_renderer.getRenderedContent).toHaveBeenCalledWith(attachment, {
            interactive: true,
            embedBoxes: true,
            seenNoteIds: new Set(),
            mediaEnvironment: "embedded",
            hasDisplayModes: true
        });
        const mount = lastMount();
        expect(mount.type).toBe(ContentEmbed);
        expect(mount.container).toBe(wrapper);
        expect(mount.props).toEqual({
            boxSize: "full",
            title,
            content,
            contentType: "pdf",
            notePath: "owner",
            viewScope: ATTACHMENT_SCOPE
        });
    });

    it("passes the attachment editor to the renderer, and the focus to the box", async () => {
        const attachmentEditor = { canEdit: vi.fn() } as never;
        const histories = new EmbedHistories(() => null);

        await loadEmbeddedAttachment("att1", $(createWrapper()), "medium", {
            attachmentEditor,
            histories,
            isFocused: true
        });

        expect(content_renderer.getRenderedContent).toHaveBeenCalledWith(attachment, {
            interactive: true,
            embedBoxes: true,
            seenNoteIds: new Set(),
            mediaEnvironment: "embedded",
            hasDisplayModes: true,
            attachmentEditor,
            histories
        });
        expect(lastMount().props).toMatchObject({ isFocusedOnMount: true });
    });

    it("renders a code file or note in the language and lines that its embed sets", async () => {
        const wrapper = createWrapper();
        const embed = inPage(document.createElement("figure"));
        embed.className = "include-note";
        embed.setAttribute("data-code-language", "text/x-sh");
        embed.setAttribute("data-code-wrap-lines", "false");
        embed.setAttribute("data-code-line-numbers", "false");
        embed.append(wrapper);
        const getLastOptions = () =>
            vi.mocked(content_renderer.getRenderedContent).mock.lastCall?.[1];

        await loadEmbeddedAttachment("att1", $(wrapper), "full");
        expect(getLastOptions()).toMatchObject({
            codeLanguage: "text/x-sh", isCodeWrapped: false, hasCodeLineNumbers: false
        });

        // A note keeps its language and line wrapping in its own labels.
        await loadEmbeddedNote("noteY", $(wrapper), "full");
        expect(getLastOptions()).toMatchObject({ hasCodeLineNumbers: false });
        expect(getLastOptions()).not.toHaveProperty("codeLanguage");
        expect(getLastOptions()).not.toHaveProperty("isCodeWrapped");
    });

    it("tells when every box of an attachment shows its saves by itself", async () => {
        const drawing = { ...attachment, title: "Canvas.excalidraw" } as FAttachment;
        vi.mocked(froca.getAttachment).mockResolvedValue(drawing);
        vi.mocked(content_renderer.getRenderingType).mockReturnValue("canvasDrawing");
        const container = inPage(document.createElement("div"));
        const addBox = () => {
            const embed = document.createElement("figure");
            embed.className = "include-note";
            embed.dataset.attachmentId = "att1";
            const wrapper = document.createElement("div");
            wrapper.className = "include-note-wrapper";
            embed.append(wrapper);
            container.append(embed);
            return wrapper;
        };
        const draw = async (wrapper: HTMLElement, type: string) => {
            vi.mocked(content_renderer.getRenderedContent)
                .mockResolvedValueOnce({ $renderedContent: $(content), type } as never);
            await loadEmbeddedAttachment("att1", $(wrapper), "medium");
        };
        expect(showsAttachmentSave(container, drawing)).toBe(false);

        const first = addBox();
        expect(showsAttachmentSave(container, drawing)).toBe(false);
        await draw(first, "canvasDrawing");
        expect(showsAttachmentSave(container, drawing)).toBe(true);

        // A new title, or another type of content, draws the box again.
        expect(showsAttachmentSave(container, { ...drawing, title: "Renamed" } as FAttachment))
            .toBe(false);
        vi.mocked(content_renderer.getRenderingType).mockReturnValueOnce("file");
        expect(showsAttachmentSave(container, drawing)).toBe(false);

        // So does every box, once one of them shows content that does not follow the saves.
        const second = addBox();
        await draw(second, "pdf");
        expect(showsAttachmentSave(container, drawing)).toBe(false);
        await draw(second, "canvasDrawing");
        await draw(first, "pdf");
        expect(showsAttachmentSave(container, drawing)).toBe(false);
    });

    it("mounts a box that tells an attachment no longer exists, at any box size", async () => {
        vi.mocked(froca.getAttachment).mockResolvedValue(null);
        const wrapper = createWrapper();

        await loadEmbeddedAttachment("att1", $(wrapper), "compact");

        expect(link.createLink).not.toHaveBeenCalled();
        expect(content_renderer.getRenderedContent).not.toHaveBeenCalled();
        const mount = lastMount();
        expect(mount.type).toBe(ContentEmbedError);
        expect(mount.container).toBe(wrapper);
        expect(mount.props).toEqual({
            boxSize: "compact",
            icon: "bx bx-error-alt",
            text: 'include_note.missing_attachment {"attachmentId":"att1"}'
        });
    });

    it("mounts a Compact box with the size of the attachment, and its file actions", async () => {
        const [ openExternally, download ] = [ action("open-externally"), action("download") ];
        vi.mocked(getOpenExternallyAction).mockReturnValue(openExternally);
        vi.mocked(getDownloadAction).mockReturnValue(download);
        const wrapper = createWrapper();

        await loadEmbeddedAttachment("att1", $(wrapper), "compact");

        expect(link.createLink).toHaveBeenCalledWith("owner", {
            showTooltip: false,
            viewScope: ATTACHMENT_SCOPE
        });
        expect(content_renderer.getRenderedContent).not.toHaveBeenCalled();
        expect(getOpenExternallyAction).toHaveBeenCalledWith(attachment);
        expect(getDownloadAction).toHaveBeenCalledWith(attachment);
        const mount = lastMount();
        expect(mount.type).toBe(CompactContentEmbed);
        expect(mount.container).toBe(wrapper);
        expect(mount.props).toEqual({
            icon: attachmentIcon("file", "application/pdf"),
            title,
            description: "2 KiB",
            notePath: "owner",
            viewScope: ATTACHMENT_SCOPE,
            actions: [ openExternally, download ]
        });
    });
});

describe("loadUnknownEmbed", () => {
    it("mounts an error box in the editor's wrapper, even before it is in the page", async () => {
        const wrapper = document.createElement("div");
        wrapper.className = "include-note-wrapper";

        await loadUnknownEmbed(wrapper, "small");

        const mount = lastMount();
        expect(mount.type).toBe(ContentEmbedError);
        expect(mount.container).toBe(wrapper);
        expect(mount.props).toEqual({
            boxSize: "small",
            icon: "bx bx-error",
            text: "include_note.unknown_kind undefined"
        });
    });

    it("mounts it in a wrapper of its own in a read-only box", async () => {
        const box = inPage(document.createElement("section"));
        box.className = "include-note";

        await loadUnknownEmbed(box, undefined);

        const { type, container } = lastMount();
        expect(type).toBe(ContentEmbedError);
        expect(container.parentElement).toBe(box);
        expect(container.className).toBe("include-note-wrapper");
    });
});

describe("loadMediaEmbed", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

    it("mounts the cover of the video under its title, even before it is in the page", async () => {
        const wrapper = document.createElement("div");
        wrapper.className = "include-note-wrapper";

        await loadMediaEmbed({
            url,
            embedType: "youtube",
            title: "A <video>",
            image: "api/attachments/abc123/image/youtube-dQw4w9WgXcQ.jpg"
        }, wrapper);

        const { type, props, container } = lastMount();
        expect(type).toBe(ContentEmbed);
        expect(container).toBe(wrapper);
        expect(props).toEqual({
            title: expect.any(HTMLElement),
            content: expect.any(HTMLElement),
            contentType: "mediaEmbed"
        });
        expect(props.title?.outerHTML).toBe(`<span><span class="bx bxl-youtube"></span>`
            + `<a href="${url}" target="_blank" rel="noopener noreferrer">A &lt;video&gt;</a>`
            + `</span>`);
        expect(props.content.className).toBe("rendered-content");
        const facade = props.content.querySelector(".link-embed-video > .link-embed-video-facade");
        expect(facade?.getAttribute("data-video-id")).toBe("dQw4w9WgXcQ");
        expect(facade?.querySelector("img")?.getAttribute("src"))
            .toBe("api/attachments/abc123/image/youtube-dQw4w9WgXcQ.jpg");
    });

    it("titles a video by its host without a title, and opens its menu in the editor", async () => {
        await loadMediaEmbed({ url, embedType: "youtube" }, createWrapper(), { hasMenu: true });

        const { props } = lastMount();
        expect(props.title?.textContent).toBe("www.youtube.com");
        const origin = { pageX: 1, pageY: 2, target: null };
        props.openMenu?.(origin);
        expect(linkContextMenu.openEmbedContextMenu).toHaveBeenCalledExactlyOnceWith(origin);
    });

    it("mounts the media player for a video or an audio file, named by its file name", async () => {
        const mounts = vi.mocked(content_renderer.mountInteractiveWidget);
        const fileUrl = "https://example.com/media/clip.mp4";
        await loadMediaEmbed({
            url: fileUrl, embedType: "video", image: "api/attachments/abc/image/clip.jpg"
        }, createWrapper());

        const [ player, media ] = mounts.mock.calls[0] ?? [];
        const playerProps = (player as VNode<{ source: object; environment: string }>).props;
        expect((player as VNode).type).toBe(MediaPreviewStub);
        expect(playerProps).toEqual({
            source: expect.objectContaining({
                id: fileUrl, kind: "video", streamUrl: fileUrl, isExternal: true,
                title: "clip.mp4", poster: "api/attachments/abc/image/clip.jpg"
            }),
            environment: "embedded"
        });
        const { props } = lastMount();
        expect(media?.className).toBe("rendered-media");
        expect(media?.parentElement).toBe(props.content);
        expect(props.title?.innerHTML).toBe(`<span class="bx bx-movie"></span>`
            + `<a href="${fileUrl}" target="_blank" rel="noopener noreferrer">clip.mp4</a>`);

        await loadMediaEmbed({ url: "https://example.com/a.mp3", embedType: "audio" },
            createWrapper());
        expect(lastMount().props.title?.querySelector(".bx-music")).not.toBeNull();
    });

    it("sizes the box by the box size it is given, over the one in the page", async () => {
        const mounts = vi.mocked(content_renderer.mountInteractiveWidget);
        const hasPlayer = () => mounts.mock.calls
            .some(([ vnode ]) => (vnode as VNode).type === MediaPreviewStub);
        const video = { url: "https://example.com/media/clip.mp4", embedType: "video" } as const;
        const figure = inPage(document.createElement("figure"));
        figure.className = "include-note";
        figure.dataset.boxSize = "compact";
        const wrapper = document.createElement("div");
        wrapper.className = "include-note-wrapper";
        figure.append(wrapper);

        await loadMediaEmbed(video, wrapper, { boxSize: "resizable" });
        expect(hasPlayer()).toBe(true);

        mounts.mockClear();
        figure.dataset.boxSize = "resizable";
        await loadMediaEmbed(video, wrapper, { boxSize: "compact" });
        expect(hasPlayer()).toBe(false);

        const detached = document.createElement("div");
        detached.className = "include-note-wrapper";
        await loadMediaEmbed({ url: "https://example.com/a.mp3", embedType: "audio" }, detached,
            { boxSize: "compact" });
        expect([ hasPlayer(), lastMount().props.boxSize ]).toEqual([ true, "compact" ]);
    });

    it("drops a load that a later one into the same box overtook", async () => {
        const wrapper = createWrapper();
        const first = loadMediaEmbed({ url: "https://example.com/a.mp3", embedType: "audio" },
            wrapper);
        await loadMediaEmbed({ url, embedType: "youtube" }, wrapper);
        await first;

        const boxes = vi.mocked(content_renderer.mountInteractiveWidget).mock.calls
            .filter(([ vnode ]) => (vnode as VNode).type === ContentEmbed);
        expect(boxes).toHaveLength(1);
        expect(content_renderer.disposeInteractiveContent).toHaveBeenCalledOnce();
    });
});

describe("the element an embed box is mounted in", () => {
    it("is a wrapper created in a read-only embed ahead of its caption", async () => {
        const figure = inPage(document.createElement("figure"));
        figure.className = "include-note";
        figure.dataset.boxSize = "expandable";
        figure.innerHTML = "&nbsp;<figcaption>Caption</figcaption>";
        const caption = figure.querySelector("figcaption");

        await loadEmbeddedNote("noteY", $(figure));

        const { container, props } = lastMount();
        expect(caption).not.toBeNull();
        expect([ ...figure.childNodes ]).toEqual([ container, caption ]);
        expect(container.className).toBe("include-note-wrapper");
        expect(props.boxSize).toBe("expandable");

        // Loading again, as a refresh does, reuses the wrapper.
        await loadEmbeddedNote("noteY", $(figure), "small");
        expect(lastMount().container).toBe(container);
        expect(lastMount().props.boxSize).toBe("small");
    });

    it("is a wrapper created in a legacy <section> embed", async () => {
        const section = inPage(document.createElement("section"));
        section.className = "include-note";
        section.dataset.boxSize = "medium";

        await loadEmbeddedNote("noteY", $(section));

        expect([ ...section.childNodes ]).toEqual([ lastMount().container ]);
        expect(lastMount().props.boxSize).toBe("medium");
    });

    it("is the wrapper an editor embed holds, leaving the editor's own elements", async () => {
        const figure = inPage(document.createElement("figure"));
        figure.className = "include-note ck-widget";
        figure.dataset.boxSize = "full";
        const wrapper = createWrapper();
        const caption = document.createElement("figcaption");
        const typeAround = document.createElement("div");
        figure.append(wrapper, caption, typeAround);

        await loadEmbeddedAttachment("att1", $(figure));

        expect(lastMount().container).toBe(wrapper);
        expect(lastMount().props.boxSize).toBe("full");
        expect([ ...figure.children ]).toEqual([ wrapper, caption, typeAround ]);
    });
});

describe("an embed that leaves the page while it loads", () => {
    it("gets no box, and the content rendered for it is disposed", async () => {
        const loads: [ (wrapper: HTMLElement) => Promise<void>, boolean ][] = [
            [ (wrapper) => loadEmbeddedNote("noteY", $(wrapper), "medium"), true ],
            [ (wrapper) => loadEmbeddedNote("noteY", $(wrapper), "compact"), false ],
            [ (wrapper) => loadEmbeddedAttachment("att1", $(wrapper), "full"), true ],
            [ (wrapper) => loadEmbeddedAttachment("att1", $(wrapper), "compact"), false ]
        ];

        for (const [ load, rendersContent ] of loads) {
            vi.mocked(content_renderer.mountInteractiveWidget).mockClear();
            vi.mocked(content_renderer.disposeInteractiveContent).mockClear();
            const wrapper = createWrapper();
            vi.mocked(link.createLink).mockImplementation(async () => {
                wrapper.remove();
                return $(title);
            });

            await load(wrapper);

            expect(content_renderer.mountInteractiveWidget).not.toHaveBeenCalled();
            expect(vi.mocked(content_renderer.disposeInteractiveContent).mock.calls
                .map(([ $element ]) => $element[0])).toEqual(rendersContent ? [ content ] : []);
        }
    });

    it("gets its box out of the page while nested in content still rendering", async () => {
        const loads: ((wrapper: HTMLElement) => Promise<void>)[] = [
            (wrapper) => loadEmbeddedNote("noteY", $(wrapper), "medium", { isNested: true }),
            (wrapper) => loadEmbeddedNote("noteY", $(wrapper), "compact", { isNested: true }),
            (wrapper) => loadEmbeddedAttachment("att1", $(wrapper), "full", { isNested: true }),
            (wrapper) => loadEmbeddedAttachment("att1", $(wrapper), "compact", { isNested: true })
        ];

        for (const load of loads) {
            vi.mocked(content_renderer.mountInteractiveWidget).mockClear();
            const wrapper = document.createElement("div");
            wrapper.className = "include-note-wrapper";

            await load(wrapper);

            expect(lastMount().container).toBe(wrapper);
            expect(content_renderer.disposeInteractiveContent).not.toHaveBeenCalled();
        }
    });
});

describe("refreshEmbeddedNote", () => {
    it("reloads every embed of the note, of either element", async () => {
        const container = inPage(document.createElement("div"));
        container.innerHTML = `<figure class="include-note" data-note-id="noteY"></figure>`
            + `<section class="include-note" data-note-id="noteY" data-block="b1"></section>`
            + `<figure class="include-note" data-note-id="other"></figure>`;
        const [ figure, section ] = [ ...container.children ];
        const histories = new EmbedHistories(() => null);

        refreshEmbeddedNote(container, "noteY", { histories });

        await vi.waitFor(() => {
            expect(content_renderer.mountInteractiveWidget).toHaveBeenCalledTimes(2);
        });
        const mountedIn = vi.mocked(content_renderer.mountInteractiveWidget).mock.calls
            .map(([ , wrapper ]) => wrapper.parentElement);
        expect(mountedIn).toEqual([ figure, section ]);
        expect(vi.mocked(content_renderer.getRenderedContent).mock.calls
            .map(([ , options ]) => [ options?.block, options?.histories ]))
            .toEqual([ [ undefined, histories ], [ "b1", histories ] ]);
    });

    it("reloads a box nested in another read-only, knowing the notes around it", async () => {
        const container = inPage(document.createElement("div"));
        container.innerHTML = `<figure class="include-note" data-note-id="outer" data-block="b2">`
            + `<div class="include-note-wrapper">`
            + `<figure class="include-note" data-attachment-id="att">`
            + `<div class="include-note-wrapper"><figure class="include-note" data-note-id="noteY">`
            + `</figure></div></figure></div></figure>`;
        const histories = new EmbedHistories(() => null);
        const noteEditor = { canEdit: vi.fn() } as never;

        refreshEmbeddedNote(container, "noteY", {
            noteEditor, histories, seenNoteIds: new Set([ "host" ])
        });

        await vi.waitFor(() => {
            expect(content_renderer.mountInteractiveWidget).toHaveBeenCalledTimes(1);
        });
        expect(lastMount().container.parentElement?.dataset.noteId).toBe("noteY");
        const options = vi.mocked(content_renderer.getRenderedContent).mock.lastCall?.[1];
        expect(options?.seenNoteIds).toEqual(new Set([ "host", "att", "outer", "outer:b2" ]));
        expect(options?.noteEditor).toBeUndefined();
        expect(options?.histories).toBeUndefined();
    });
});

describe("watchContentEmbeds", () => {
    let container: HTMLElement;
    const update = vi.fn();
    const editor = { ui: { update } } as unknown as CKTextEditor;

    beforeEach(() => {
        container = document.createElement("div");
        container.innerHTML = `<p>text</p><figure class="include-note"></figure>`
            + `<blockquote><figure class="include-note"></figure></blockquote>`;
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    function disposed() {
        return vi.mocked(content_renderer.disposeInteractiveContent).mock.calls
            .map(([ $element ]) => $element[0]);
    }

    function flush() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("unmounts what is removed from the container, but not what is moved within it", async () => {
        const stop = watchContentEmbeds(container);
        const [ paragraph, embed, quote ] = [ ...container.children ];

        embed.remove();
        quote.remove();
        container.append(quote);
        paragraph.firstChild?.remove();
        await flush();

        expect(disposed()).toEqual([ embed ]);
        stop();
    });

    it("unmounts what is left on stop, and stops watching", async () => {
        const stop = watchContentEmbeds(container);
        const embed = container.querySelector("figure");
        embed?.remove();

        stop();
        expect(disposed()).toEqual([ embed, container ]);

        container.querySelector("blockquote")?.remove();
        await flush();
        expect(disposed()).toHaveLength(2);
    });

    it("updates the editor when content in an embed adds or removes toolbar buttons", () => {
        const provider = { getTools: () => [], execute: vi.fn(), subscribe: () => () => {} };
        const [ inside, outside ] = [ container, document.body ].map((parent) => {
            const element = document.createElement("div");
            parent.append(element);
            return element;
        });
        update.mockClear();
        const stop = watchContentEmbeds(container, editor);

        const unregisterInside = registerContentEmbedTools(inside, provider);
        expect(update).toHaveBeenCalledTimes(1);
        registerContentEmbedTools(outside, provider)();
        expect(update).toHaveBeenCalledTimes(1);
        unregisterInside();
        expect(update).toHaveBeenCalledTimes(2);

        stop();
        registerContentEmbedTools(inside, provider)();
        expect(update).toHaveBeenCalledTimes(2);
        outside.remove();
    });
});

describe("openContentEmbedMenu", () => {
    it("opens the menu of the note or attachment an embed shows, below the anchor", async () => {
        const anchor = document.createElement("button");
        const noteEmbed = inPage(document.createElement("figure"));
        noteEmbed.dataset.noteId = "noteY";
        const blockEmbed = inPage(document.createElement("figure"));
        blockEmbed.dataset.noteId = "noteY";
        blockEmbed.dataset.block = "b1";
        const embed = inPage(document.createElement("figure"));
        embed.dataset.attachmentId = "att1";

        await openContentEmbedMenu(noteEmbed, anchor);
        await openContentEmbedMenu(blockEmbed, anchor);
        await openContentEmbedMenu(embed, anchor);

        expect(vi.mocked(linkContextMenu.openContextMenu).mock.calls).toEqual([
            [ "noteY", { anchor, target: noteEmbed }, {} ],
            [ "noteY", { anchor, target: blockEmbed }, { block: "b1" } ],
            [ "owner", { anchor, target: embed }, ATTACHMENT_SCOPE ]
        ]);
    });

    it("opens the commands of the embed itself for a source or media", async () => {
        const anchor = document.createElement("button");
        const source = inPage(document.createElement("figure"));
        source.dataset.language = "mermaid";
        const video = inPage(document.createElement("figure"));
        video.className = "include-note media-embed audio-embed";

        await openContentEmbedMenu(source, anchor);
        await openContentEmbedMenu(video, anchor);

        expect(vi.mocked(linkContextMenu.openEmbedContextMenu).mock.calls).toEqual([
            [ { anchor, target: source } ],
            [ { anchor, target: video } ]
        ]);
        expect(linkContextMenu.openContextMenu).not.toHaveBeenCalled();
    });

    it("opens nothing for an embed of a deleted attachment, or of nothing", async () => {
        vi.mocked(froca.getAttachment).mockResolvedValue(null);
        const embed = inPage(document.createElement("figure"));
        embed.dataset.attachmentId = "att1";

        await openContentEmbedMenu(embed, document.createElement("button"));
        await openContentEmbedMenu(inPage(document.createElement("figure")), document.createElement("button"));

        expect(linkContextMenu.openContextMenu).not.toHaveBeenCalled();
    });
});

describe("getAttachmentHref", () => {
    it("links to the attachment in its note, or to nothing once it is deleted", async () => {
        vi.mocked(froca.getAttachment)
            .mockResolvedValueOnce({ ownerId: "owner" } as unknown as FAttachment)
            .mockResolvedValueOnce(null);

        expect(await getAttachmentHref("att1"))
            .toBe("#root/owner?viewMode=attachments&attachmentId=att1");
        expect(await getAttachmentHref("att1")).toBeNull();
    });
});

describe("setupTodoCheckboxTaps", () => {
    let container: HTMLDivElement;
    let cleanup: () => void;

    beforeEach(() => {
        // Two items, their 16px checkboxes in the gutter of the list, 24px apart.
        container = document.createElement("div");
        container.innerHTML = `
            <ul class="todo-list">
                <li><span class="todo-list__label"><span contenteditable="false"><input type="checkbox"></span></span>First</li>
                <li><span class="todo-list__label"><span contenteditable="false"><input type="checkbox"></span></span>Second</li>
            </ul>`;
        document.body.appendChild(container);
        for (const [ index, checkbox ] of checkboxes().entries()) {
            const top = 100 + index * 24;
            vi.spyOn(checkbox, "getBoundingClientRect").mockReturnValue(
                { left: 15, right: 31, top, bottom: top + 16, width: 16, height: 16 } as DOMRect);
        }
        cleanup = setupTodoCheckboxTaps(container);
    });

    afterEach(() => {
        cleanup();
        container.remove();
        document.getElementById("root-widget")?.remove();
    });

    function checkboxes() {
        return [ ...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ];
    }

    function touch(target: Element, type: string, clientX: number, clientY: number) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const point = [ { clientX, clientY } ];
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : point });
        Object.defineProperty(event, "changedTouches", { value: point });
        target.dispatchEvent(event);
        return event;
    }

    function tap(target: Element, clientX: number, clientY: number) {
        const start = touch(target, "touchstart", clientX, clientY);
        const end = touch(target, "touchend", clientX, clientY);
        return { start, end };
    }

    it("toggles the nearest checkbox, cancelling the touch so the editor does not take the focus", () => {
        const list = container.querySelector("ul");
        expect(list).not.toBeNull();
        if (!list) return;
        const onChange = vi.fn();
        container.addEventListener("change", onChange);
        const [ first, second ] = checkboxes();

        const direct = tap(first, 23, 108);
        expect(first.checked).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(direct.start.defaultPrevented).toBe(true);
        expect(direct.end.defaultPrevented).toBe(true);

        // 6px left of the first box, outside every label.
        const nearMiss = tap(list, 9, 108);
        expect(first.checked).toBe(false);
        expect(second.checked).toBe(false);
        expect(nearMiss.start.defaultPrevented).toBe(true);

        // Between the rows, closer to the second box.
        tap(list, 23, 122);
        expect(first.checked).toBe(false);
        expect(second.checked).toBe(true);
    });

    it("blurs a focused editor whose keyboard is closed, so the toggle does not bring it back", () => {
        const editable = document.createElement("div");
        editable.tabIndex = 0;
        container.appendChild(editable);
        const root = document.createElement("div");
        root.id = "root-widget";
        document.body.appendChild(root);
        const [ first ] = checkboxes();

        root.classList.add("virtual-keyboard-opened");
        editable.focus();
        tap(first, 23, 108);
        expect(first.checked).toBe(true);
        expect(document.activeElement).toBe(editable);

        root.classList.remove("virtual-keyboard-opened");
        tap(first, 23, 108);
        expect(first.checked).toBe(false);
        expect(document.activeElement).not.toBe(editable);
    });

    it("leaves taps away from a checkbox, drags and long presses alone", () => {
        const [ first ] = checkboxes();
        const text = container.querySelector("li");
        expect(text).not.toBeNull();
        if (!text) return;

        const away = tap(text, 120, 108);
        expect(first.checked).toBe(false);
        expect(away.start.defaultPrevented).toBe(false);
        expect(away.end.defaultPrevented).toBe(false);

        touch(first, "touchstart", 23, 108);
        touch(first, "touchmove", 23, 140);
        touch(first, "touchend", 23, 140);
        expect(first.checked).toBe(false);

        // A long press.
        touch(first, "touchstart", 23, 108);
        first.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        touch(first, "touchend", 23, 108);
        expect(first.checked).toBe(false);
    });

});

describe("refreshAttachmentImages", () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement("div");
        container.innerHTML = `
            <figure class="include-note" data-note-id="header"><div class="include-note-wrapper">
                <img src="api/attachments/drawn/image/terrain.svg">
                <img src="api/attachments/kept/image/a.png">
            </div></figure>
            <p><img src="api/attachments/drawn/image/terrain.svg"></p>`;
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    function sources(selector: string) {
        return [ ...container.querySelectorAll(selector) ].map((img) => img.getAttribute("src"));
    }

    function changeAttachment(attachmentId: string) {
        const loadResults = new LoadResults([]);
        loadResults.addAttachmentRow({ attachmentId, ownerId: "header" } as never);
        refreshAttachmentImages(container, loadResults);
    }

    it("asks again for the images in embeds of an attachment that changed, keeping the rest", () => {
        changeAttachment("drawn");

        const [ drawn, kept ] = sources(".include-note img");
        expect(drawn).toMatch(/^api\/attachments\/drawn\/image\/terrain\.svg\?timestamp=\d+$/);
        expect(kept).toBe("api/attachments/kept/image/a.png");
        // An image outside an embed is one of the note itself.
        expect(sources("p img")).toEqual([ "api/attachments/drawn/image/terrain.svg" ]);
    });

    it("gives the version to images that an embed renders later, while the embeds are watched", async () => {
        const stop = watchContentEmbeds(container);
        changeAttachment("redrawn");

        // An embed renders its content again after its note changes, with the stored URL.
        const preview = document.createElement("div");
        preview.innerHTML = `<img src="api/attachments/redrawn/image/terrain.svg">`;
        container.querySelector(".include-note-wrapper")?.append(preview);
        const outside = document.createElement("img");
        outside.setAttribute("src", "api/attachments/redrawn/image/terrain.svg");
        container.append(outside);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(preview.querySelector("img")?.getAttribute("src"))
            .toMatch(/^api\/attachments\/redrawn\/image\/terrain\.svg\?timestamp=\d+$/);
        expect(outside.getAttribute("src")).toBe("api/attachments/redrawn/image/terrain.svg");
        stop();
    });
});

describe("setDataKeepingSelection", () => {
    let editor: ClassicEditor;

    beforeAll(async () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = await ClassicEditor.create(el, {
            plugins: [ Essentials, Paragraph, Table, List, CodeBlock, HorizontalLine ],
            licenseKey: "GPL"
        });
    });

    afterAll(async () => {
        await editor.destroy();
    });

    function reload(data: string) {
        setDataKeepingSelection(editor, data);
        return _getModelData(editor.model);
    }

    /** How far `model.document.version` moves, which is the number of operations applied. */
    function operationsApplied(run: () => void) {
        const before = editor.model.document.version;
        run();
        return editor.model.document.version - before;
    }

    it("keeps a collapsed caret where it was, applying no operations beyond setData()", () => {
        const initial = "<paragraph>first</paragraph><paragraph>sec[]ond</paragraph>";
        const data = "<p>first, edited on the server</p><p>second</p>";

        _setModelData(editor.model, initial);
        const plain = operationsApplied(() => editor.setData(data));
        _setModelData(editor.model, initial);
        const keeping = operationsApplied(() => setDataKeepingSelection(editor, data));

        // An operation would fire `change:data` and schedule a save.
        expect(keeping).toBe(plain);
        expect(_getModelData(editor.model)).toBe(
            "<paragraph>first, edited on the server</paragraph><paragraph>sec[]ond</paragraph>"
        );
    });

    it("keeps a backward selection backward", () => {
        _setModelData(editor.model, "<paragraph>one</paragraph><paragraph>two three</paragraph>");
        editor.model.change((writer) => {
            const root = editor.model.document.getRoot();
            if (!root) throw new Error("No root");
            writer.setSelection(writer.createRange(
                writer.createPositionFromPath(root, [ 0, 1 ]),
                writer.createPositionFromPath(root, [ 1, 3 ])
            ), { backward: true });
        });

        expect(reload("<p>one</p><p>two three</p>"))
            .toBe("<paragraph>o[ne</paragraph><paragraph>two] three</paragraph>");
        expect(editor.model.document.selection.isBackward).toBe(true);
    });

    it("clamps a selection the new document is too short for, instead of throwing", () => {
        _setModelData(
            editor.model,
            "<paragraph>a</paragraph><paragraph>b</paragraph><paragraph>long [text] end</paragraph>"
        );

        expect(reload("<p>a</p><p>bc</p>"))
            .toBe("<paragraph>a</paragraph><paragraph>bc[]</paragraph>");

        _setModelData(
            editor.model,
            "<paragraph>a</paragraph><paragraph>a much longer line[]</paragraph>"
        );

        expect(reload("<p>a</p><p>short</p>"))
            .toBe("<paragraph>a</paragraph><paragraph>short[]</paragraph>");
    });

    it("follows its block when blocks are inserted or removed above it", () => {
        _setModelData(editor.model, "<paragraph>a</paragraph><paragraph>b[]c</paragraph>");
        expect(reload("<p>new</p><p>a</p><p>bc</p>"))
            .toBe("<paragraph>new</paragraph><paragraph>a</paragraph><paragraph>b[]c</paragraph>");

        _setModelData(
            editor.model,
            "<paragraph>x</paragraph><paragraph>a</paragraph><paragraph>b[]c</paragraph>"
        );
        expect(reload("<p>a</p><p>bc</p>"))
            .toBe("<paragraph>a</paragraph><paragraph>b[]c</paragraph>");
    });

    it("stays put when only blocks below it change", () => {
        _setModelData(editor.model, "<paragraph>a[]b</paragraph><paragraph>c</paragraph>");
        expect(reload("<p>ab</p><p>c, edited</p><p>new</p>")).toBe(
            "<paragraph>a[]b</paragraph><paragraph>c, edited</paragraph><paragraph>new</paragraph>"
        );
    });

    it("follows a caret in a code block", () => {
        const codeBlock = (text: string) => `<codeBlock language="plaintext">${text}</codeBlock>`;
        _setModelData(editor.model, `<paragraph>p</paragraph>${codeBlock("const[] x")}`);

        const pre = "<pre><code class=\"language-plaintext\">const x</code></pre>";
        expect(reload(`<p>new</p><p>p</p>${pre}`))
            .toBe(`<paragraph>new</paragraph><paragraph>p</paragraph>${codeBlock("const[] x")}`);
    });

    it("follows a list item that moved, by its list item id", () => {
        _setModelData(editor.model, listBlock("a", "alpha") + listBlock("b", "be[]ta"));

        const item = (id: string, text: string) => `<li data-list-item-id="${id}">${text}</li>`;
        const reordered = `<ul>${item("b", "beta")}${item("a", "alpha")}</ul>`;
        expect(reload(reordered)).toBe(listBlock("b", "be[]ta") + listBlock("a", "alpha"));
    });

    it("tells list items with the same text apart by their ids", () => {
        _setModelData(editor.model, listBlock("r1", "Review") + listBlock("r2", "Rev[]iew"));

        const item = (id: string) => `<li data-list-item-id="${id}">Review</li>`;
        expect(reload(`<ul>${item("r3")}${item("r1")}${item("r2")}</ul>`)).toBe(
            listBlock("r3", "Review") + listBlock("r1", "Review") + listBlock("r2", "Rev[]iew")
        );
    });

    it("matches unchanged list items by text when the content has no list item ids", () => {
        _setModelData(
            editor.model,
            `${listBlock("a", "one")}<paragraph>be[]tween</paragraph>${listBlock("b", "two")}`
        );
        reload("<p>new</p><ul><li>one</li></ul><p>between</p><ul><li>two</li></ul>");

        expect(editor.model.document.selection.getFirstPosition()?.path).toEqual([ 2, 2 ]);
    });

    it("lands inside a table that replaced the caret's paragraph", () => {
        _setModelData(editor.model, "<paragraph>a</paragraph><paragraph>b[]c</paragraph>");

        expect(reload(`<p>a</p>${tableHtml("x")}`)).toBe(
            "<paragraph>a</paragraph>"
            + "<table><tableRow><tableCell><paragraph>x[]</paragraph></tableCell></tableRow>"
            + "</table>"
        );
    });

    it("keeps a selected object selected", () => {
        const hr = "<horizontalLine></horizontalLine>";
        _setModelData(editor.model, `<paragraph>a</paragraph>[${hr}]<paragraph>b</paragraph>`);

        expect(reload("<p>new</p><p>a</p><hr><p>b</p>")).toBe(
            `<paragraph>new</paragraph><paragraph>a</paragraph>[${hr}]<paragraph>b</paragraph>`
        );
    });

    it("keeps every selected table cell selected", () => {
        const cell = (text: string) => `<tableCell><paragraph>${text}</paragraph></tableCell>`;
        const table = `<table><tableRow>[${cell("x")}][${cell("y")}]</tableRow></table>`;
        _setModelData(editor.model, `<paragraph>a</paragraph>${table}`);

        expect(reload(`<p>new</p><p>a</p>${tableHtml("x", "y")}`))
            .toBe(`<paragraph>new</paragraph><paragraph>a</paragraph>${table}`);
    });
});

function listBlock(listItemId: string, text: string) {
    const attributes = `listIndent="0" listItemId="${listItemId}" listType="bulleted"`;
    return `<paragraph ${attributes}>${text}</paragraph>`;
}

function tableHtml(...cells: string[]) {
    const row = cells.map((cell) => `<td>${cell}</td>`).join("");
    return `<figure class="table"><table><tbody><tr>${row}</tr></tbody></table></figure>`;
}
