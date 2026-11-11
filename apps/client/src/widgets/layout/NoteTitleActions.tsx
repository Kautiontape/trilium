import "./NoteTitleActions.css";

import { EditedNotesResponse } from "@triliumnext/commons";
import { useEffect, useState } from "preact/hooks";

import NoteContext from "../../components/note_context";
import FNote from "../../entities/fnote";
import froca from "../../services/froca";
import { t } from "../../services/i18n";
import server from "../../services/server";
import { checkFullHeight, getExtendedWidgetType } from "../NoteDetail";
import { PromotedAttributesContent, usePromotedAttributeData } from "../PromotedAttributes";
import Collapsible, { ExternallyControlledCollapsible } from "../react/Collapsible";
import { useNoteContext, useNoteLabel, useNoteProperty, useTriliumEvent, useTriliumOptionBool } from "../react/hooks";
import { NewNoteLink } from "../react/NoteLink";
import SearchDefinition from "../search/SearchDefinition";
import CaiusNudgeBar from "./CaiusNudgeBar";
import JournalNavigation from "./JournalNavigation";
import NoteTypeSwitcher from "./NoteTypeSwitcher";
import PinnedAttachments from "./PinnedAttachments";

export default function NoteTitleActions() {
    const { note, ntxId, componentId, noteContext, viewScope } = useNoteContext();
    const noteType = useNoteProperty(note, "type");
    const isDefaultView = !viewScope?.viewMode || viewScope.viewMode === "default";

    return (
        <div className="title-actions">
            <PromotedAttributes note={note} componentId={componentId} noteContext={noteContext} />
            {noteType === "search" && <SearchProperties note={note} ntxId={ntxId} />}
            <JournalNavigation note={note} />
            <CaiusNudgeBar note={note} />
            {isDefaultView && note && <PinnedAttachments note={note} />}
            <EditedNotes />
            {isDefaultView && <NoteTypeSwitcher note={note} />}
        </div>
    );
}

function SearchProperties({ note, ntxId }: { note: FNote | null | undefined, ntxId: string | null | undefined }) {
    return (note &&
        <Collapsible
            title={t("search_definition.search_parameters")}
            initiallyExpanded={note.isInHiddenSubtree()} // not saved searches
        >
            <SearchDefinition note={note} ntxId={ntxId} />
        </Collapsible>
    );
}

function PromotedAttributes({ note, componentId, noteContext }: {
    note: FNote | null | undefined,
    componentId: string,
    noteContext: NoteContext | undefined
}) {
    const [ cells, setCells ] = usePromotedAttributeData(note, componentId, noteContext);
    const [ expanded, setExpanded ] = useState(false);

    useEffect(() => {
        getExtendedWidgetType(note, noteContext).then(extendedNoteType => {
            const fullHeight = checkFullHeight(noteContext, extendedNoteType);
            setExpanded(!fullHeight);
        });
    }, [ note, noteContext ]);

    // Keyboard shortcut.
    useTriliumEvent("toggleRibbonTabPromotedAttributes", ({ ntxId }) => {
        if (!noteContext || ntxId !== noteContext.ntxId) return;
        setExpanded(!expanded);
    });

    if (!cells?.length) return false;
    return (note && (
        <ExternallyControlledCollapsible
            key={note.noteId}
            title={t("note_title.promoted_attributes")}
            expanded={expanded} setExpanded={setExpanded}
        >
            <PromotedAttributesContent note={note} componentId={componentId} cells={cells} setCells={setCells} />
        </ExternallyControlledCollapsible>
    ));
}

//#region Edited Notes
function EditedNotes() {
    const { note } = useNoteContext();
    const [ dateNote ] = useNoteLabel(note, "dateNote");
    const [ editedNotesOpenInRibbon ] = useTriliumOptionBool("editedNotesOpenInRibbon");
    // Fetched here rather than in the body, so the count is known while the section is closed.
    const editedNotes = useEditedNotes(dateNote ? note : null);

    return (note && dateNote &&
        <Collapsible
            className="edited-notes"
            title={editedNotes === undefined
                ? t("note_title.edited_notes")
                : t("note_title.edited_notes_count", { count: editedNotes.length })}
            initiallyExpanded={editedNotesOpenInRibbon}
        >
            <EditedNotesContent editedNotes={editedNotes} />
        </Collapsible>
    );
}

function EditedNotesContent({ editedNotes }: { editedNotes: EditedNotesResponse | undefined }) {
    return (editedNotes !== undefined &&
        (editedNotes.length > 0 ? editedNotes.map(editedNote => (
            <NewNoteLink
                key={editedNote.noteId}
                className="badge"
                notePath={editedNote.noteId}
                showNoteIcon
            />
        )) : (
            <div className="no-edited-notes-found">{t("edited_notes.no_edited_notes_found")}</div>
        )));
}

function useEditedNotes(note: FNote | null | undefined) {
    const [ editedNotes, setEditedNotes ] = useState<EditedNotesResponse>();

    useEffect(() => {
        // Drop the previous note's list first, so neither it nor its count shows under this note
        // while the fetch is in flight; a fetch the note has moved on from is discarded as well.
        setEditedNotes(undefined);
        if (!note) return;
        let stale = false;
        server.get<EditedNotesResponse>(`edited-notes/${note.getLabelValue("dateNote")}`).then(async editedNotes => {
            editedNotes = editedNotes.filter((n) => n.noteId !== note.noteId);
            const noteIds = editedNotes.flatMap((n) => n.noteId);
            await froca.getNotes(noteIds, true); // preload all at once
            if (!stale) {
                setEditedNotes(editedNotes);
            }
        });
        return () => {
            stale = true;
        };
    }, [ note ]);

    return editedNotes;
}
//#endregion
