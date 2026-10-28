import { ValidationError } from "@triliumnext/core";
import type { Request } from "express";
import type { z } from "zod";

type CaiusModule = typeof import("../../services/caius/service.js");

/**
 * The `/api/caius/*` routes the client reaches Caius through. Each runs the operation of
 * `services/caius/service.ts` that the matching `caius_*` tool runs, with the same input schema
 * plus the optional `expectedBlobId` on items that act on a note. The service and the library
 * load on the first request, so they stay off the startup path. If they fail to load, every route
 * answers `503 caius_unavailable` and `status` answers `enabled: false`; the rest of Trilium is
 * unaffected.
 */
export default {
    status: async () => {
        try {
            const caius = await loadCaius();
            const now = caius.caiusDevNow();
            return { enabled: true, ...(now ? { now } : {}), rollover: await caius.caiusService.rollover().catch(() => undefined) };
        } catch (e) {
            return { enabled: false, detail: messageOf(e) };
        }
    },
    plan: caiusRoute((caius, req) => caius.caiusService.plan(parse(caius.routeInputs.plan, { period: req.query.period, date: req.query.date }))),
    open: caiusRoute((caius, req) => caius.caiusService.open(parse(caius.routeInputs.open, {
        lane: req.query.lane,
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit)
    }))),
    explain: caiusRoute((caius, req) => caius.caiusService.explain(parse(caius.routeInputs.explain, { noteId: req.query.noteId, listItemId: req.query.listItemId }))),
    add: caiusRoute((caius, req) => caius.caiusService.add(parse(caius.routeInputs.add, req.body))),
    accept: caiusRoute((caius, req) => caius.caiusService.accept(parse(caius.routeInputs.accept, req.body))),
    dismiss: caiusRoute((caius, req) => caius.caiusService.dismiss(parse(caius.routeInputs.dismiss, req.body))),
    setState: caiusRoute((caius, req) => caius.caiusService.setState(parse(caius.routeInputs.setState, req.body))),
    forward: caiusRoute((caius, req) => caius.caiusService.forward(parse(caius.routeInputs.forward, req.body))),
    assignIds: caiusRoute((caius, req) => caius.caiusService.assignIds(parse(caius.routeInputs.assignIds, req.body))),
    apply: caiusRoute((caius, req) => caius.caiusService.apply(parse(caius.routeInputs.apply, req.body))),
    nudge: caiusRoute((caius, req) => caius.caiusService.nudge(parse(caius.routeInputs.nudge, { date: req.query.date }))),
    context: caiusRoute((caius, req) => caius.caiusService.context(parse(caius.routeInputs.context, { date: req.query.date }))),
    skipCatchup: caiusRoute((caius, req) => caius.caiusService.skipCatchup(parse(caius.routeInputs.skipCatchup, req.body)))
};

let loading: Promise<CaiusModule> | undefined;

/** Imports the Caius service once. A failure stays cached, so Caius stays off until a restart. */
function loadCaius(): Promise<CaiusModule> {
    loading ??= import("../../services/caius/service.js").catch((e: unknown) => {
        console.warn(`Caius disabled: ${messageOf(e)}`);
        throw e;
    });
    return loading;
}

/**
 * Wraps a Caius operation as a route handler: `503` when the service cannot load, and the
 * service's own `bad_request` and `not_found` answers as `400` and `404`.
 */
function caiusRoute(run: (caius: CaiusModule, req: Request) => Promise<object>) {
    return async (req: Request) => {
        let caius: CaiusModule;
        try {
            caius = await loadCaius();
        } catch (e) {
            return [503, { error: "caius_unavailable", detail: messageOf(e) }];
        }

        const result = await run(caius, req);
        const error = "error" in result ? result.error : undefined;
        if (error === "bad_request") {
            return [400, result];
        }
        if (error === "not_found") {
            return [404, result];
        }
        return result;
    };
}

/** Parses `value` against `schema`, throwing a `ValidationError` (400) that carries zod's messages. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new ValidationError(result.error.issues
            .map((issue) => issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)
            .join("; "));
    }
    return result.data;
}

function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
