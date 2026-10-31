/// <reference types='vitest' />
import { defineConfig } from "vite";

/**
 * `CAIUS_DEV_PROXY` (for example a local test server's origin) makes the dev server forward `/mcp`
 * and `/etapi` to it, so the app runs in a desktop browser same-origin, without CORS. Connect then
 * takes the dev server's own origin as the server URL.
 */
const proxyTarget = process.env.CAIUS_DEV_PROXY;

export default defineConfig(() => ({
    root: import.meta.dirname,
    cacheDir: "../../.cache/vite-caius-app",
    base: "",
    oxc: {
        jsx: {
            runtime: "automatic" as const,
            importSource: "preact"
        }
    },
    resolve: {
        alias: {
            react: "preact/compat",
            "react-dom": "preact/compat"
        }
    },
    server: {
        port: 8095,
        strictPort: true,
        proxy: proxyTarget
            ? {
                "/mcp": { target: proxyTarget, changeOrigin: true },
                "/etapi": { target: proxyTarget, changeOrigin: true }
            }
            : undefined
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022"
    },
    test: {
        environment: "node",
        include: [ "src/**/*.spec.ts", "src/**/*.spec.tsx" ]
    }
}));
