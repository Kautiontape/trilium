import { dayjs } from "@triliumnext/commons";

/** A level of the Trilium calendar hierarchy, from most to least specific. */
export type CalendarLevel = "day" | "week" | "month" | "quarter" | "year";

/** The label that marks a note as belonging to a given calendar level. */
export const LEVEL_LABELS: Record<CalendarLevel, string> = {
    day: "dateNote",
    week: "weekNote",
    month: "monthNote",
    quarter: "quarterNote",
    year: "yearNote"
};

/**
 * Precedence order, most specific first. A note carrying several calendar labels
 * (reachable via bulk actions or a bad import) is treated as its most specific level,
 * so exactly one navigator is ever rendered.
 */
const LEVEL_PRECEDENCE: CalendarLevel[] = [ "day", "week", "month", "quarter", "year" ];

const VALUE_PATTERNS: Record<CalendarLevel, RegExp> = {
    day: /^\d{4}-\d{2}-\d{2}$/,
    week: /^\d{4}-W\d{2}$/,
    month: /^\d{4}-\d{2}$/,
    quarter: /^\d{4}-Q[1-4]$/,
    year: /^\d{4}$/
};

/** The subset of FNote that the pure module depends on, so tests need no froca. */
export interface CalendarLabelSource {
    getOwnedLabelValue(name: string): string | null | undefined;
}

/**
 * Validates a calendar label value. Invalid values must never reach the server: the
 * internal date routes have no validation, so `#dateNote=someday` would otherwise
 * create junk notes labelled `"Invalid Da"` / `"Invalid"` / `"Inva"`.
 */
export function isValidValue(level: CalendarLevel, value: string | null | undefined): boolean {
    if (!value || !VALUE_PATTERNS[level].test(value)) {
        return false;
    }

    // Structural match isn't enough — 2026-02-30 passes the day pattern but is not a
    // real date. Round-tripping catches it: dayjs parses it to 2026-03-02, which no
    // longer formats back to the input. (Strict parsing via a third argument is not an
    // option here — the shared dayjs in commons does not load `customParseFormat`.)
    if (level === "day") {
        return dayjs(value).format("YYYY-MM-DD") === value;
    }
    if (level === "month") {
        return dayjs(`${value}-01`).format("YYYY-MM") === value;
    }

    return true;
}

/**
 * Determines which calendar level a note represents, reading **owned** labels only so
 * that template-inherited labels don't trigger the navigation bar.
 */
export function detectLevel(note: CalendarLabelSource): { level: CalendarLevel; value: string } | null {
    for (const level of LEVEL_PRECEDENCE) {
        const value = note.getOwnedLabelValue(LEVEL_LABELS[level]);
        if (value && isValidValue(level, value)) {
            return { level, value };
        }
    }

    return null;
}
