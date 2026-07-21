import "./JournalNavigation.css";

import { Fragment } from "preact";

import FNote from "../../entities/fnote";
import { t } from "../../services/i18n";
import { CalendarLevel } from "../../services/journal_navigation";
import ActionButton from "../react/ActionButton";
import NoteLink from "../react/NoteLink";
import { useJournalNavigation } from "./useJournalNavigation";

export default function JournalNavigation({ note }: { note: FNote | null | undefined }) {
    const nav = useJournalNavigation(note);

    if (!nav) {
        return null;
    }

    const levelName = levelNames()[nav.level];
    const blocked = !!nav.disabledReason;

    return (
        <div className={`journal-navigation${blocked ? " journal-nav-blocked" : ""}`}>
            <ActionButton
                icon="bx bx-chevron-left"
                className={nav.prev && !nav.prev.exists ? "journal-nav-will-create" : undefined}
                text={nav.disabledReason ?? prevNextLabel(nav.prev, levelName, "previous")}
                disabled={!nav.prev}
                onClick={() => void nav.navigate(-1)}
            />

            <div className="journal-nav-crumbs">
                {nav.crumbs.map((crumb, index) => (
                    <Fragment key={crumb.noteId}>
                        {index > 0 && <span className="journal-nav-separator">›</span>}
                        {blocked
                            ? <span>{crumb.title}</span>
                            : <NoteLink notePath={crumb.noteId} title={crumb.title} />}
                    </Fragment>
                ))}
            </div>

            <ActionButton
                icon="bx bx-chevron-right"
                className={nav.next && !nav.next.exists ? "journal-nav-will-create" : undefined}
                text={nav.disabledReason ?? prevNextLabel(nav.next, levelName, "next")}
                disabled={!nav.next}
                onClick={() => void nav.navigate(1)}
            />

            <span className="journal-nav-spacer" />

            <ActionButton
                icon="bx bx-calendar"
                text={nav.disabledReason ?? t("journal_navigation.today")}
                disabled={blocked}
                onClick={() => void nav.goToday()}
            />
        </div>
    );
}

/**
 * Spelled out as literal keys rather than an interpolated `level_${level}` lookup, so the
 * translation keys stay greppable and typecheck against the i18n resources.
 */
function levelNames(): Record<CalendarLevel, string> {
    return {
        day: t("journal_navigation.level_day"),
        week: t("journal_navigation.level_week"),
        month: t("journal_navigation.level_month"),
        quarter: t("journal_navigation.level_quarter"),
        year: t("journal_navigation.level_year")
    };
}

function prevNextLabel(
    neighbour: { value: string; exists: boolean } | null,
    levelName: string,
    direction: "previous" | "next"
) {
    if (!neighbour || neighbour.exists) {
        return direction === "previous"
            ? t("journal_navigation.previous", { level: levelName })
            : t("journal_navigation.next", { level: levelName });
    }

    return direction === "previous"
        ? t("journal_navigation.previous_create", { value: neighbour.value })
        : t("journal_navigation.next_create", { value: neighbour.value });
}
