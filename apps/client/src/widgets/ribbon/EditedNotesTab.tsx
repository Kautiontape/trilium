import { EditedNotesResponse } from "@triliumnext/commons";
import { useEffect, useState } from "preact/hooks";

import FNote from "../../entities/fnote";
import froca from "../../services/froca";
import { t } from "../../services/i18n";
import server from "../../services/server";
import NoteLink from "../react/NoteLink";
import { joinElements } from "../react/react_utils";
import { TabContext } from "./ribbon-interface";

export default function EditedNotesTab({ note }: TabContext) {
    const editedNotes = useEditedNotes(note);

    return (
        <div className="edited-notes-widget" style={{
            padding: "12px",
            maxHeight: "200px",
            width: "100%",
            overflow: "auto"
        }}>
            {editedNotes?.length ? (
                <div className="edited-notes-list use-tn-links">
                    {joinElements(editedNotes.map(editedNote => {
                        return (
                            <span key={editedNote.noteId} className="edited-note-line">
                                {editedNote.isDeleted ? (
                                    <i>{`${editedNote.title} ${t("edited_notes.deleted")}`}</i>
                                ) : (
                                    <>
                                        {editedNote.notePath ? <NoteLink notePath={editedNote.notePath} showNotePath /> : <span>{editedNote.title}</span> }
                                    </>
                                )}
                            </span>
                        );
                    }), " ")}
                </div>
            ) : (
                <div className="no-edited-notes-found">{t("edited_notes.no_edited_notes_found")}</div>
            )}
        </div>
    );
}

export function useEditedNotes(note: FNote | null | undefined) {
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
