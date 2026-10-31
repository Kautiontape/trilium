import type { NextFunction, Request, Response } from "express";

/**
 * CORS for the routes that authenticate with an ETAPI bearer token and never with the session:
 * `/mcp`, `/etapi/caius/*`, `/etapi/llm-chat/*` and `/etapi/special-notes/llm-chat`. It lets the
 * Caius phone app's WebView, at an origin in `allowedOrigins` (`[Network] tokenCorsOrigins`), call
 * them with `fetch` and read a streamed answer.
 *
 * The answer never carries `Access-Control-Allow-Credentials`, so the browser sends no cookie and a
 * page at an allowed origin gets nothing without the token. A preflight from any other origin
 * answers 403. Other paths pass through untouched, to the global `corsAllowOrigin` block.
 */
export function tokenCors(allowedOrigins: () => string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isTokenRoute(req.path)) {
            next();
            return;
        }

        const origin = req.get("Origin");
        const allowed = typeof origin === "string" && allowedOrigins().includes(origin);
        if (allowed) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
        }
        res.append("Vary", "Origin");

        if (req.method !== "OPTIONS") {
            next();
            return;
        }
        if (!allowed) {
            res.sendStatus(403);
            return;
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        res.setHeader("Access-Control-Max-Age", "600");
        res.sendStatus(204);
    };
}

/** Splits the comma-separated `tokenCorsOrigins` setting; an empty one allows no origin. */
export function parseOrigins(setting: string): string[] {
    return setting.split(",").map((origin) => origin.trim()).filter(Boolean);
}

const ALLOWED_HEADERS = "Authorization, Content-Type, Accept, Mcp-Protocol-Version";

/** `Content-Type` is readable anyway; the MCP headers are what a streamable HTTP client reads. */
const EXPOSED_HEADERS = "Mcp-Session-Id, Mcp-Protocol-Version";

function isTokenRoute(path: string): boolean {
    return path === "/mcp"
        || path.startsWith("/etapi/caius/")
        || path.startsWith("/etapi/llm-chat/")
        || path === "/etapi/special-notes/llm-chat";
}
