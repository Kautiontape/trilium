import type { PlanTask, PlanView, PeriodKind } from "@triliumnext/caius/src/trilium/plan-read.js";

import type { Connection } from "./connection.js";
import { HttpError, request } from "./http.js";
import { callTool } from "./mcp.js";
import type { TaskOrigin } from "./origin.js";

export type { PeriodKind, PlanTask, PlanView };

/**
 * Caius over the token: the `caius_*` tools on `/mcp` for reads and task actions, and the
 * `/etapi/caius/*` routes for what no tool covers (status, the nudge state). A server without
 * those routes answers 404; the app then runs without them (see `ServerFeatures`).
 */
export function caiusApi(conn: Connection) {
    const tool = <T>(name: string, args: Record<string, unknown>) => callTool<T>(conn, name, args);
    const etapi = async <T>(path: string): Promise<T | null> => {
        const res = await request({ method: "GET", url: `${conn.url}/etapi/${path}`, headers: { Authorization: `Bearer ${conn.token}` } });
        if (res.status === 404) {
            return null;
        }
        if (res.status !== 200) {
            throw new HttpError(res.status, res.text);
        }
        return JSON.parse(res.text) as T;
    };

    return {
        plan: (period: PeriodKind, date?: string) => tool<PlanView>("caius_plan", date ? { period, date } : { period }),
        open: (lane?: Lane, limit?: number) => tool<OpenResult>("caius_open", { ...(lane ? { lane } : {}), ...(limit ? { limit } : {}) }),
        explain: (item: TaskRef) => tool<Explanation>("caius_explain", { ...item }),
        setState: (items: (TaskRef & { state: "done" | "doing" | "cancelled"; reason?: string })[]) =>
            tool<WriteResult>("caius_set_state", { items }),
        forward: (items: (TaskRef & { to: string; onDeck?: boolean; critical?: boolean })[]) => tool<WriteResult>("caius_forward", { items }),
        add: (items: AddItem[]) => tool<WriteResult>("caius_add", { items }),
        accept: (items: (TaskRef & { section?: string; critical?: boolean })[]) => tool<WriteResult>("caius_accept", { items }),
        dismiss: (items: TaskRef[]) => tool<WriteResult>("caius_dismiss", { items }),
        context: (date: string) => tool<{ date: string; context: ContextLine[] }>("caius_context", { date }),
        skipCatchup: (date: string) => tool<unknown>("caius_skip_catchup", { date }),
        /** Plan my day's catch-up step: read only. Also carries the standing note, for the Rhythm. */
        catchup: (date: string) => tool<CatchupStep>("caius_planday", { date, step: "catchup" }),
        /** `GET /etapi/app-info`: proves the token. */
        appInfo: async () => {
            const res = await request({ method: "GET", url: `${conn.url}/etapi/app-info`, headers: { Authorization: `Bearer ${conn.token}` } });
            if (res.status !== 200) {
                throw new HttpError(res.status, res.text);
            }
            return JSON.parse(res.text) as { appVersion: string };
        },
        /** null when the server has no phone routes (it answers 404, or anything but the status shape). */
        status: async (): Promise<CaiusStatus | null> => {
            try {
                const status = await etapi<CaiusStatus>("caius/status");
                return status && typeof status.enabled === "boolean" ? status : null;
            } catch (e) {
                if (e instanceof HttpError) {
                    return null;
                }
                throw e;
            }
        },
        nudge: (date: string) => etapi<Nudge>(`caius/nudge?${new URLSearchParams({ date }).toString()}`)
    };
}

export type CaiusApi = ReturnType<typeof caiusApi>;

export interface TaskRef {
    noteId: string;
    listItemId: string;
}

export type Lane = "overdue" | "today" | "week" | "orbit" | "planning_ahead" | "someday" | "suggested";

export interface OpenTask extends PlanTask {
    period: string;
    lane: Lane;
    horizon: string | null;
    daysLate?: number;
    onDeck: boolean;
}

export interface OpenResult {
    total: number;
    tasks: OpenTask[];
}

export interface Explanation {
    summary?: string;
    lane?: string;
    rule?: string;
    source?: string;
    error?: string;
    /** Where the task came from; left out by a server from before origins. */
    origin?: TaskOrigin | null;
}

export interface AddItem {
    date?: string;
    week?: string;
    month?: string;
    section?: string;
    critical?: boolean;
    onDeck?: boolean;
    text: string;
    est?: string;
}

/** What a write tool answers: one result per item, each with a status such as `updated` or `skipped`. */
export interface WriteResult {
    results?: { status?: string; reason?: string; detail?: string; noteId?: string; listItemId?: string }[];
    error?: string;
    [key: string]: unknown;
}

export interface ContextLine {
    text: string;
    until?: string;
    period: "day" | "week";
    key: string;
    noteId: string;
}

export interface CaiusStatus {
    enabled: boolean;
    /** The server's local time when its dev clock is set, `YYYY-MM-DDTHH:mm:ss`. */
    now?: string;
    /** When the day rolls over, `HH:MM`. */
    rollover?: string;
}

export type Nudge = { date: string; lastWorkday: string } & (
    | { state: "catchup"; days?: string[]; tasks: { noteId: string; listItemId: string | null; text: string }[] }
    | { state: "unplanned" }
    | { state: "planned"; plannedAt: string | null }
    | { state: "wound_down"; woundDownAt: string | null }
);

export interface CatchupTask {
    noteId: string;
    listItemId: string;
    text: string;
    period: string;
    periodLabel: string;
}

export interface CatchupStep {
    date: string;
    dateLabel: string;
    question: string | null;
    standing: string | null;
    data: {
        lastWorkday: string;
        lastWorkdayLabel: string;
        oldestDay?: string;
        oldestDayLabel?: string;
        moveTo: string;
        moveToLabel: string;
        skipped: boolean;
        tasks: CatchupTask[];
    };
}

/** Whether a write tool's answer reports any item as not done. */
export function writeProblem(result: WriteResult): string | null {
    if (result.error) {
        return String(result.error);
    }
    const bad = result.results?.find((r) => r.status && !/^(updated|added|moved|accepted|dismissed|unchanged)$/.test(r.status));
    return bad ? (bad.detail ?? bad.reason ?? bad.status ?? null) : null;
}
