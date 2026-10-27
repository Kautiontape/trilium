/**
 * `caius_inputs`: what the day's planning needs from outside the notes. Jira and the calendar
 * are read independently, so a source that fails adds an entry to `errors` and the others still
 * return. It reads no notes and takes no `withCaiusLock`, since holding the lock across network
 * calls would stall the Plan tab.
 */

import { dayCapacity } from "@triliumnext/caius";

import type { InputsInput } from "../schemas.js";
import { JiraError, type JiraDeps, readJira } from "./jira.js";
import type { CaiusInputs, InputError, JiraInputs } from "./types.js";

export type { CaiusInputs } from "./types.js";

export type InputsDeps = JiraDeps;

export async function readInputs(input: InputsInput, deps: InputsDeps = defaultDeps()): Promise<CaiusInputs> {
    const errors: InputError[] = [];
    let jira: JiraInputs = { handoff: [], asks: [], done: [] };
    try {
        jira = await readJira(deps, input.context);
    } catch (e) {
        errors.push({ source: "jira", error: e instanceof JiraError ? e.code : "unexpected" });
    }

    return {
        date: input.date,
        jira,
        calendar: [],
        capacity: dayCapacity([], { workStart: input.workStart, workEnd: input.workEnd }),
        errors
    };
}

function defaultDeps(): InputsDeps {
    return { fetch: globalThis.fetch, env: process.env, now: () => new Date() };
}
