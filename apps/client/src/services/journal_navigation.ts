import { dayjs, getWeekString, parseWeekString, WeekSettings } from "@triliumnext/commons";

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

/**
 * Returns the calendar value one unit before or after `value`, at the same level.
 *
 * Day stepping uses dayjs, which parses a date-only string to *local* midnight and
 * delegates `.add()` to `Date.prototype.setDate` — calendar-based and therefore
 * DST-safe. Never use `new Date(dateStr)` (spec-mandated UTC parsing) or
 * `.toISOString()` (shifts the date in non-UTC zones).
 *
 * @returns the stepped value, or null if `value` is malformed.
 */
export function stepValue(
    level: CalendarLevel,
    value: string,
    delta: 1 | -1,
    settings: WeekSettings
): string | null {
    if (!isValidValue(level, value)) {
        return null;
    }

    switch (level) {
        case "day":
            return dayjs(value).add(delta, "day").format("YYYY-MM-DD");

        case "week":
            // Digit math on the label is wrong: a year has 52 or 53 weeks depending on
            // all three week settings. Go through real dates instead.
            return getWeekString(parseWeekString(value, settings).add(delta * 7, "day"), settings);

        case "month":
            return dayjs(`${value}-01`).add(delta, "month").format("YYYY-MM");

        case "quarter": {
            const [ yearStr, quarterStr ] = value.split("-Q");
            const stepped = dayjs(`${yearStr}-01-01`)
                .quarter(parseInt(quarterStr, 10))
                .add(delta, "quarter");
            // The server writes quarters unpadded: `${year}-Q${quarter}`.
            return `${stepped.year()}-Q${stepped.quarter()}`;
        }

        case "year":
            return String(parseInt(value, 10) + delta);
    }
}

/** Which optional levels the resolved calendar root has enabled. */
export interface EnabledLevels {
    week: boolean;
    quarter: boolean;
}

export interface ExpectedAncestor {
    level: CalendarLevel;
    labelName: string;
    value: string;
}

/**
 * Computes the calendar values of every level coarser than `level`, broad to narrow.
 *
 * These are matched against cached ancestors to build the breadcrumb. For a week note
 * the anchor date is the week's start date, but the *year* comes from the week-year
 * encoded in the label: 2026-W01 begins 2025-12-29, yet belongs to 2026.
 */
export function expectedAncestors(
    level: CalendarLevel,
    value: string,
    settings: WeekSettings,
    enabled: EnabledLevels
): ExpectedAncestor[] {
    if (!isValidValue(level, value)) {
        return [];
    }

    const anchor = anchorDate(level, value, settings);
    if (!anchor) {
        return [];
    }

    const year = level === "week" ? parseInt(value.split("-W")[0], 10) : anchor.year();

    // A week's anchor is its *start* date, which for week 1 can fall in the previous
    // calendar year (2026-W01 starts 2025-12-29). When that happens the month/quarter
    // ancestors must come from the week's *end* date instead: the server clones a
    // cross-month week note into both months it touches (see date_notes.ts), and the
    // clone filed under the week's own year is the one the real ancestor walk finds.
    const monthQuarterAnchor = level === "week" && anchor.year() !== year ? anchor.add(6, "day") : anchor;

    const all: ExpectedAncestor[] = [
        { level: "year", labelName: "yearNote", value: String(year) },
        { level: "quarter", labelName: "quarterNote", value: `${monthQuarterAnchor.year()}-Q${monthQuarterAnchor.quarter()}` },
        { level: "month", labelName: "monthNote", value: monthQuarterAnchor.format("YYYY-MM") },
        { level: "week", labelName: "weekNote", value: getWeekString(anchor, settings) }
    ];

    const ownLevelIndex = all.findIndex((a) => a.level === level);
    const coarserThanCurrent = all.slice(0, ownLevelIndex === -1 ? all.length : ownLevelIndex);

    return coarserThanCurrent.filter((ancestor) => {
        if (ancestor.level === "week") return enabled.week;
        if (ancestor.level === "quarter") return enabled.quarter;
        return true;
    });
}

/** The representative date for a calendar value, used to derive coarser levels. */
function anchorDate(level: CalendarLevel, value: string, settings: WeekSettings) {
    switch (level) {
        case "day":
            return dayjs(value);
        case "week":
            return parseWeekString(value, settings);
        case "month":
            return dayjs(`${value}-01`);
        case "quarter": {
            const [ yearStr, quarterStr ] = value.split("-Q");
            return dayjs(`${yearStr}-01-01`).quarter(parseInt(quarterStr, 10));
        }
        case "year":
            return dayjs(`${value}-01-01`);
    }
}
