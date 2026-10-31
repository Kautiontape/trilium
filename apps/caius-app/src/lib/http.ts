import { Capacitor, CapacitorHttp } from "@capacitor/core";

/**
 * One HTTP exchange with the Trilium server. On the phone it goes through `CapacitorHttp`, which
 * runs natively: no CORS preflight (a server without the phone routes answers none) and no mixed
 * content block. In a desktop browser it is a plain `fetch` through the dev server's proxy. The
 * chat stream is the one call that needs the WebView's own `fetch`; see `chat.ts`.
 */
export async function request(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...req.headers };
    let body: string | undefined;
    if (req.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(req.json);
    } else if (req.text !== undefined) {
        headers["Content-Type"] = "text/plain";
        body = req.text;
    }

    try {
        if (Capacitor.isNativePlatform()) {
            const res = await CapacitorHttp.request({
                url: req.url,
                method: req.method,
                headers,
                // CapacitorHttp serializes an object as JSON and sends a string as it is.
                data: req.json !== undefined ? req.json : body,
                responseType: "text",
                connectTimeout: 15_000,
                readTimeout: req.readTimeout ?? 60_000
            });
            const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
            return { status: res.status, text };
        }

        const res = await fetch(req.url, { method: req.method, headers, body });
        return { status: res.status, text: await res.text() };
    } catch (e) {
        throw new UnreachableError(req.url, e);
    }
}

export interface HttpRequest {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    /** Sent as `application/json`. */
    json?: unknown;
    /** Sent as `text/plain`. */
    text?: string;
    readTimeout?: number;
}

export interface HttpResponse {
    status: number;
    text: string;
}

/** The server could not be reached at all: no network, no Tailscale, a TLS failure. */
export class UnreachableError extends Error {
    constructor(readonly url: string, readonly cause?: unknown) {
        super(`Can't reach ${hostOf(url)}`);
        this.name = "UnreachableError";
    }
}

/** The server answered, but not with what was asked for. */
export class HttpError extends Error {
    constructor(readonly status: number, readonly body: string) {
        super(status === 401 ? "The server didn't accept the token." : `The server answered ${status}.`);
        this.name = "HttpError";
    }
}

/** The host part of a URL, for messages: `trilium.example.net`, or the input when it isn't a URL. */
export function hostOf(url: string) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
