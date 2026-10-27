import type { CKTextEditor, ModelElement, ModelPosition } from "@triliumnext/ckeditor5";

import appContext from "../../../components/app_context";
import content_renderer from "../../../services/content_renderer";
import froca from "../../../services/froca";
import link, { ViewScope } from "../../../services/link";
import utils from "../../../services/utils";

export async function loadIncludedNote(noteId: string, $el: JQuery<HTMLElement>, boxSize?: string) {
    const note = await froca.getNote(noteId);
    if (!note) return;

    // The box size is supplied explicitly by the editing-view downcast; for the other
    // callers (read-only rendering, script API refresh) fall back to reading it from the DOM.
    const effectiveBoxSize = boxSize ?? $el.closest('section.include-note').attr('data-box-size');
    const isExpandable = effectiveBoxSize === 'expandable';

    // The editing-view downcast passes the `.include-note-wrapper` element itself as $el, whereas the
    // read-only and refresh paths pass the outer `section.include-note`. Build the content in a
    // detached wrapper either way (so the old content stays visible during the async render — no
    // flicker), then swap it in; when $el is already the wrapper we move the built children straight
    // into it instead of nesting a redundant second `.include-note-wrapper`.
    const isWrapper = $el.hasClass('include-note-wrapper');
    const $wrapper = $('<div class="include-note-wrapper">');
    const $link = await link.createLink(note.noteId, {
        showTooltip: false,
        showNoteIcon: true
    });

    if (isExpandable) {
        // Create expandable structure with toggle
        const $titleRow = $('<div class="include-note-title-row">');
        const $toggle = $('<button class="include-note-toggle bx bx-chevron-right" aria-expanded="false">');
        const $title = $('<h4 class="include-note-title">').append($link);

        $titleRow.append($toggle, $title);
        $wrapper.append($titleRow);

        // The include widget itself is the first level of inclusion, so the included note's own
        // includes are rendered as reference links rather than expanded (see includesAsReferenceLinks).
        const { $renderedContent, type } = await content_renderer.getRenderedContent(note, { interactive: true, includesAsReferenceLinks: true, mediaEnvironment: "embedded" });
        const $content = $(`<div class="include-note-content type-${type}" style="display: none;">`).append($renderedContent);
        $wrapper.append($content);

        // Add toggle functionality
        $toggle.on('click', (e) => {
            e.stopPropagation();
            const isExpanded = $toggle.attr('aria-expanded') === 'true';
            $toggle.attr('aria-expanded', String(!isExpanded));
            $toggle.toggleClass('expanded');
            $content.slideToggle(200);
        });
    } else {
        // Standard display
        $wrapper.append($('<h4 class="include-note-title">').append($link));

        // The include widget itself is the first level of inclusion, so the included note's own
        // includes are rendered as reference links rather than expanded (see includesAsReferenceLinks).
        const { $renderedContent, type } = await content_renderer.getRenderedContent(note, { interactive: true, includesAsReferenceLinks: true, mediaEnvironment: "embedded" });
        $wrapper.append($(`<div class="include-note-content type-${type}">`).append($renderedContent));
    }

    // Unmount any interactive widgets from a previous render of this include (e.g. on a box-size
    // change or refreshIncludedNote) before $el.empty() discards their DOM — otherwise their
    // standalone Preact roots (collections, web views) would leak.
    content_renderer.disposeInteractiveContent($el);
    $el.empty().append(isWrapper ? $wrapper.children() : $wrapper);
}

export function refreshIncludedNote(container: HTMLDivElement, noteId: string) {
    const includedNotes = container.querySelectorAll(`section[data-note-id="${noteId}"]`);
    for (const includedNote of includedNotes) {
        loadIncludedNote(noteId, $(includedNote as HTMLElement));
    }
}

/**
 * Replaces the content of the editor and puts the selection back on the same content.
 * `editor.setData()` alone moves the caret to the start of the note. Top-level blocks that match
 * between the old and the new document carry the selection along when blocks are inserted or
 * removed above it; otherwise it goes back to the same model path, clamped to the new document.
 * Restoring it applies no operations, so it adds no undo step and fires no `change:data`.
 */
export function setDataKeepingSelection(
    editor: Pick<CKTextEditor, "model" | "setData">,
    data: string
) {
    const { model } = editor;
    const oldRoot = model.document.getRoot();
    const saved = oldRoot ? saveSelection(model, oldRoot) : null;

    editor.setData(data);

    const root = model.document.getRoot();
    if (!saved || !root) return;

    try {
        restoreSelection(model, root, saved);
    } catch (e) {
        // The selection `setData()` left at the start of the document stays in place.
        console.warn("Unable to restore the selection after reloading the note content", e);
    }
}

type Model = CKTextEditor["model"];
type Path = readonly number[];

/** What a top-level block is compared by when matching the old document against the new one. */
interface BlockIdentity {
    name: string;
    text: string;
    listItemId?: string;
}

interface SavedSelection {
    blocks: BlockIdentity[];
    ranges: { start: Path; end: Path }[];
    isBackward: boolean;
    /** The object the selection is on (an image, an included note), by the path before it. */
    selectedElement?: { name: string; path: Path };
}

function saveSelection(model: Model, root: ModelElement): SavedSelection | null {
    const { selection } = model.document;
    const ranges = [ ...selection.getRanges() ].map((range) => ({
        start: range.start.path,
        end: range.end.path
    }));
    if (!ranges.length) return null;

    const selectedElement = selection.getSelectedElement();
    return {
        blocks: getBlockIdentities(model, root),
        ranges,
        isBackward: selection.isBackward,
        selectedElement: selectedElement
            ? { name: selectedElement.name, path: model.createPositionBefore(selectedElement).path }
            : undefined
    };
}

function restoreSelection(model: Model, root: ModelElement, saved: SavedSelection) {
    const mapPath = createPathMapper(saved.blocks, getBlockIdentities(model, root));
    const positionAt = (path: Path) => clampPosition(model, root, mapPath(path));

    if (saved.selectedElement) {
        const element = positionAt(saved.selectedElement.path).nodeAfter;
        if (element?.is("element", saved.selectedElement.name) && model.schema.isObject(element)) {
            model.enqueueChange({ isUndoable: false }, (writer) => {
                writer.setSelection(element, "on");
            });
            return;
        }
    }

    if (saved.ranges.length > 1) {
        // Several ranges select table cells. Snapping them to text positions would turn the cell
        // selection into a text range, so they are restored as they are and left to the post-fixer.
        const ranges = saved.ranges.map(({ start, end }) => {
            const [ from, to ] = [ positionAt(start), positionAt(end) ];
            return from.isAfter(to) ? model.createRange(to, from) : model.createRange(from, to);
        });
        model.enqueueChange({ isUndoable: false }, (writer) => {
            writer.setSelection(ranges, { backward: saved.isBackward });
        });
        return;
    }

    const [ { start, end } ] = saved.ranges;
    const [ anchorPath, focusPath ] = saved.isBackward ? [ end, start ] : [ start, end ];
    const anchor = toSelectablePosition(model, positionAt(anchorPath));
    const focus = toSelectablePosition(model, positionAt(focusPath));
    if (!anchor || !focus) return;

    model.enqueueChange({ isUndoable: false }, (writer) => {
        writer.setSelection(anchor);
        writer.setSelectionFocus(focus);
    });
}

function getBlockIdentities(model: Model, root: ModelElement): BlockIdentity[] {
    const blocks: BlockIdentity[] = [];
    for (const child of root.getChildren()) {
        if (!child.is("element")) continue;

        let text = "";
        for (const item of model.createRangeIn(child).getItems()) {
            if (item.is("$textProxy")) {
                text += item.data;
            }
        }

        const listItemId = child.getAttribute("listItemId");
        blocks.push({
            name: child.name,
            text,
            listItemId: typeof listItemId === "string" ? listItemId : undefined
        });
    }
    return blocks;
}

/**
 * Moves the top-level index of a path from the old document to the new one. The blocks before the
 * first difference keep their index and the blocks after the last one shift by the change in the
 * block count. A block in between follows its list item if that still exists, or keeps its index.
 */
function createPathMapper(oldBlocks: BlockIdentity[], newBlocks: BlockIdentity[]) {
    const newListItemIds = new Set(newBlocks.map((block) => block.listItemId));

    // A list item whose id is still in the document matches by id only, so an edited item still
    // matches and items with the same text stay apart. Other blocks match by name and text, which
    // covers list items that got new ids because the content had no `data-list-item-id`.
    function isSameBlock(oldBlock: BlockIdentity, newBlock: BlockIdentity) {
        if (oldBlock.listItemId !== undefined && newListItemIds.has(oldBlock.listItemId)) {
            return oldBlock.listItemId === newBlock.listItemId;
        }
        return oldBlock.name === newBlock.name && oldBlock.text === newBlock.text;
    }

    const shared = Math.min(oldBlocks.length, newBlocks.length);
    let head = 0;
    while (head < shared && isSameBlock(oldBlocks[head], newBlocks[head])) {
        head++;
    }
    let tail = 0;
    const fromEnd = (blocks: BlockIdentity[]) => blocks[blocks.length - 1 - tail];
    while (tail < shared - head && isSameBlock(fromEnd(oldBlocks), fromEnd(newBlocks))) {
        tail++;
    }

    function mapIndex(index: number) {
        if (index < head) return index;
        if (index >= oldBlocks.length - tail) return index + newBlocks.length - oldBlocks.length;

        const listItemId = oldBlocks[index]?.listItemId;
        if (!listItemId) return index;

        // A list item can span several blocks; keep the caret in the same one of them.
        const isInItem = (block: BlockIdentity) => block.listItemId === listItemId;
        const blockInItem = oldBlocks.slice(0, index).filter(isInItem).length;
        const itemIndexes = [ ...newBlocks.entries() ]
            .filter(([ , block ]) => isInItem(block))
            .map(([ blockIndex ]) => blockIndex);
        return itemIndexes[Math.min(blockInItem, itemIndexes.length - 1)] ?? index;
    }

    return ([ index, ...rest ]: Path) => {
        return index === undefined ? [] : [ mapIndex(index), ...rest ];
    };
}

/** Resolves `path` in `root`, clamping each offset to what the new document has. */
function clampPosition(model: Model, root: ModelElement, path: Path) {
    let parent = root;
    let offset = 0;

    for (const [ depth, pathOffset ] of path.entries()) {
        offset = Math.min(Math.max(pathOffset, 0), parent.maxOffset);
        if (depth === path.length - 1) break;

        const child = parent.getChild(parent.offsetToIndex(offset));
        if (!child?.is("element") || child.startOffset !== offset) break;

        parent = child;
    }

    return model.createPositionAt(parent, offset);
}

function toSelectablePosition(model: Model, position: ModelPosition) {
    return model.schema.getNearestSelectionRange(position)?.start ?? null;
}

export function setupImageOpening(container: HTMLDivElement, singleClickOpens: boolean) {
    const $container = $(container);
    $container.on("dblclick", "img", (e) => openImageInCurrentTab($(e.target)));
    $container.on("click", "img", (e) => {
        e.stopPropagation();
        const isLeftClick = e.which === 1;
        const isMiddleClick = e.which === 2;
        const ctrlKey = utils.isCtrlKey(e);
        const activate = (isLeftClick && ctrlKey && e.shiftKey) || (isMiddleClick && e.shiftKey);

        if ((isLeftClick && ctrlKey) || isMiddleClick) {
            openImageInNewTab($(e.target), activate);
        } else if (isLeftClick && singleClickOpens) {
            openImageInCurrentTab($(e.target));
        }
    });
}

async function openImageInCurrentTab($img: JQuery<HTMLElement>) {
    const parsedImage  = await parseFromImage($img);

    if (parsedImage) {
        appContext.tabManager.getActiveContext()?.setNote(parsedImage.noteId, { viewScope: parsedImage.viewScope });
    } else {
        window.open($img.prop("src"), "_blank");
    }
}

async function openImageInNewTab($img: JQuery<HTMLElement>, activate: boolean = false) {
    const parsedImage = await parseFromImage($img);

    if (parsedImage) {
        appContext.tabManager.openTabWithNoteWithHoisting(parsedImage.noteId, { activate, viewScope: parsedImage.viewScope });
    } else {
        window.open($img.prop("src"), "_blank");
    }
}

async function parseFromImage($img: JQuery<HTMLElement>): Promise<{ noteId: string; viewScope: ViewScope } | null> {
    const imgSrc = $img.prop("src");

    const imageNoteMatch = imgSrc.match(/\/api\/images\/([A-Za-z0-9_]+)\//);
    if (imageNoteMatch) {
        return {
            noteId: imageNoteMatch[1],
            viewScope: {}
        };
    }

    const attachmentMatch = imgSrc.match(/\/api\/attachments\/([A-Za-z0-9_]+)\/image\//);
    if (attachmentMatch) {
        const attachmentId = attachmentMatch[1];
        const attachment = await froca.getAttachment(attachmentId);
        if (!attachment) return null;

        return {
            noteId: attachment.ownerId,
            viewScope: {
                viewMode: "attachments",
                attachmentId: attachmentId
            }
        };
    }

    return null;
}
