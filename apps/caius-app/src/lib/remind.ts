/**
 * Reading a "remind me…" request typed into Ask, and the times the reminder sheet offers. Nothing
 * is scheduled from here: the app shows the parsed reminder as a chip and only a tap sets it.
 */

/** `remind me at 3 to call the pharmacy` → 15:00 today and "Call the pharmacy", or null when the text isn't a reminder. */
export function parseRemindMe(text: string, now: Date): { at: Date; text: string } | null {
    const body = /^\s*(?:please\s+)?remind me\s+(.*)$/i.exec(text)?.[1]?.trim().replace(/[.!?]+$/, "");
    if (!body) {
        return null;
    }

    // "at 3 to call X", "in 20 minutes to call X", "tomorrow at 9 to call X"
    const timeFirst = /^((?:tomorrow\s+)?(?:at\s+)?[^\s]+(?:\s*(?:am|pm|a\.m\.|p\.m\.))?|in\s+\d+\s*\w+)\s+(?:to|about)\s+(.+)$/i.exec(body);
    // "to call X at 3", "to call X in 20 minutes", "to call X tomorrow at 9"
    const timeLast = /^(?:to|about)\s+(.+?)\s+((?:tomorrow\s+)?at\s+\S+(?:\s*(?:am|pm|a\.m\.|p\.m\.))?|in\s+\d+\s*\w+|tomorrow)$/i.exec(body);

    const [ when, what ] = timeFirst ? [ timeFirst[1], timeFirst[2] ] : timeLast ? [ timeLast[2], timeLast[1] ] : [ null, null ];
    if (!when || !what) {
        return null;
    }
    const at = parseWhen(when, now);
    return at ? { at, text: capitalize(what.trim()) } : null;
}

/** `at 3`, `3pm`, `15:30`, `in 20 minutes`, `in 1 hour`, `tomorrow at 9`, `tomorrow`. */
export function parseWhen(input: string, now: Date): Date | null {
    const text = input.trim().toLowerCase();
    const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(text);
    if (inMatch) {
        const minutes = Number(inMatch[1]) * (inMatch[2].startsWith("h") ? 60 : 1);
        return new Date(now.getTime() + minutes * 60_000);
    }

    const tomorrow = text.startsWith("tomorrow");
    const clock = text.replace(/^tomorrow\s*/, "").replace(/^at\s+/, "");
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (tomorrow ? 1 : 0));
    if (!clock) {
        return tomorrow ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 30) : null;
    }

    const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(clock);
    if (!match) {
        return null;
    }
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const meridiem = match[3]?.replace(/\./g, "");
    if (hour > 23 || minute > 59) {
        return null;
    }
    if (meridiem === "pm" && hour < 12) {
        hour += 12;
    } else if (meridiem === "am" && hour === 12) {
        hour = 0;
    }

    let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    // "at 3" with no am or pm and no minutes past 24h: the next 3 o'clock that is still ahead.
    if (!meridiem && hour < 12 && !match[1].startsWith("0") && at <= now) {
        at = new Date(at.getTime() + 12 * 3_600_000);
    }
    if (at <= now && !tomorrow) {
        at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, at.getHours(), at.getMinutes());
    }
    return at;
}

/** The reminder sheet's choices: In 1 h, This evening (at the end of work), Tomorrow at standup. */
export function reminderChoices(now: Date, workEnd: string, standup: string): { label: string; at: Date }[] {
    const [ endH, endM ] = workEnd.split(":").map(Number);
    const [ upH, upM ] = standup.split(":").map(Number);
    const choices = [ { label: "In 1 h", at: new Date(now.getTime() + 3_600_000) } ];
    const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), endH, endM);
    if (evening.getTime() - now.getTime() > 30 * 60_000) {
        choices.push({ label: "This evening", at: evening });
    }
    choices.push({ label: `Tomorrow ${standup}`, at: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, upH, upM) });
    return choices;
}

/** `15:00`, `Tomorrow 09:30` or `Mon 9 Nov 10:30`, for a reminder's time. */
export function whenLabel(at: Date, now: Date) {
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
        - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
    if (days === 0) {
        return `Today ${clock}`;
    }
    if (days === 1) {
        return `Tomorrow ${clock}`;
    }
    const weekday = [ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" ][at.getDay()];
    const month = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ][at.getMonth()];
    return `${weekday} ${at.getDate()} ${month} ${clock}`;
}

function capitalize(text: string) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
