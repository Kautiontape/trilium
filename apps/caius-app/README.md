# Caius for Android

The phone app for Caius. What it does and how to set it up on a phone: [`docs/ktn/caius/phone.md`](../../docs/ktn/caius/phone.md).

## Develop in a browser

```bash
CAIUS_DEV_PROXY=http://localhost:<port> pnpm --filter @triliumnext/caius-app dev   # http://127.0.0.1:8095
```

`CAIUS_DEV_PROXY` is a Trilium server with Caius and MCP on (a local test server, not your real Journal). The dev server forwards `/mcp` and `/etapi` to it, so the page is same-origin; at Connect, type the dev server's own address (`http://127.0.0.1:8095`) and the test server's ETAPI token. In a browser the connection lives in `sessionStorage` and notifications, haptics and the keystore are no-ops.

```bash
pnpm --filter @triliumnext/caius-app test     # the lib specs, including a recorded Wind down replayed through the chat parser
```

## Build the APK

Needs the Android SDK (platform 36, build-tools 36) and JDK 21.

```bash
export ANDROID_HOME=~/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk
pnpm --filter @triliumnext/caius-app android:debug
# → apps/caius-app/android/app/build/outputs/apk/debug/app-debug.apk
```

`android:debug` builds the web assets, runs `cap sync android` and `./gradlew assembleDebug`. The Android project is committed; `cap sync` only copies `dist/` and the plugin list into it.

On the emulator a server on the development machine is `http://10.0.2.2:<port>` (debug builds allow cleartext to it). The WebView is debuggable in a debug build: `adb forward tcp:9230 localabstract:webview_devtools_remote_<pid>` exposes it to the Chrome DevTools protocol.

## Layout

| Path | |
|---|---|
| `src/lib/` | No UI: `http.ts` (native HTTP on the phone, `fetch` in a browser), `mcp.ts`, `caius.ts` (the tools and `/etapi/caius/*`), `chat.ts` (the chat routes, the SSE parser, step cards from tool results), `store.ts` (signals and writes held behind Undo), `notify.ts`, `remind.ts`, `day.ts`, `connection.ts` |
| `src/components/` | `ui.tsx` (buttons, chips, sheets, icons, haptics), `TaskRow.tsx` (swipe), `sheets.tsx` (task, Forward, Drop, Why, Remind), `QuickAdd.tsx` |
| `src/screens/` | Connect, Today, Plan, Chat (rituals and Ask), Reminders, Settings |
| `android/` | The Capacitor Android project: manifest, network security configs, shortcuts, icons |
