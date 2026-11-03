# Plan: a Caius chat that keeps going in the background

Builds decisions 7–10 of `design/2026-11-03-views-and-background.md` (on `ktn-caius-views`): the
server owns a turn, an ongoing notification while it runs, "Caius replied" with inline reply when
it ends, and an in-app mini bar. Branch `ktn-caius-background`.

## Shape

### The server owns a turn

- **The turn POST carries the transcript.** `POST /etapi/llm-chat/stream` keeps `messages` and
  `config` and gains `turn: { replyId, transcript }`: the stored messages up to and including the
  new user message(s) (Ask's first turn has two: the opener and the question), and the id the phone
  gives the reply. The server checks `transcript` with `isChatContent`'s rules and the size cap, and
  `replyId` as a short string. Only the phone knows what a transcript holds beyond `{role, content}`
  (`answers` on a user message, ids, error and thinking messages), so it sends it; the server writes
  it back with the reply. A body without `turn` (an older app) runs as before, but the server saves
  nothing.
- **One assembler.** `applyChunk`, `AssistantTurn` and the step that turns a finished or partial
  turn into stored messages (the notes as a `thinking` message, then the reply or an error message,
  today inline in `useChat`) move to `packages/commons/src/lib/caius_turn.ts`. The server saves
  with it, the phone shows with it, so the two cannot drift. `lib/chat.ts` re-exports them, so
  `Chat.tsx`'s imports stay as they are.
- **A turn registry**, `apps/server/src/services/caius/turns.ts`, keyed by chat note. A turn runs
  core's `runChat` to its end with its own `AbortController`, whether or not anyone is reading.
  It keeps the chunk log for reattaching, and saves `transcript + turnMessages(assembled)` to the
  chat note: throttled while it runs (at most every 2 s), and at the end. Saves run in
  `cls.init`, because they happen after the request has closed. While the turn runs, the
  in-progress reply carries `partial: true`, and the final save drops it. A server restart mid-turn
  then leaves a reply marked unfinished, not one that looks complete.
- **Bounds.**
  - One running turn per chat note: a second POST answers 409 `turn_running`.
  - A wall-clock cap (`MAX_TURN_MS`, 15 min) aborts the turn and ends it with an error message.
  - A cap on the chunk log (`MAX_TURN_CHUNKS`).
  - A finished turn stays in the registry for `RETAIN_MS` (10 min) so a reattach can read its end,
    then goes.
  - The POST keeps `checkEtapiToken` and the 60-per-15-min limiter.
  - The sidebar's `streamChat` and its abort on close are left alone.
- **Reading a turn back.**
  - `GET /etapi/llm-chat/:noteId/turn` returns the saved `content` (or null), and `running`,
    `replyId` and `chunks` for the note's turn in the registry (`running: false, replyId: null`
    when there is none).
  - `GET /etapi/llm-chat/:noteId/stream?from=N` is SSE: it replays the turn's chunk log from `N`
    (default 0) and then goes live until the turn ends. It answers 404 `no_turn` when the registry
    has no turn for the note.
  - Both GETs need the token and `chatNoteOf`, and stay outside the turn limiter: they start no
    agent work. `isTokenRoute` already gives them CORS.
- `claude_agent.ts` keeps its session per chat note (`sessionsByChatNote`, matched on the
  transcript hash). One turn per note at a time is what it assumes already.

### The phone follows a turn

- **`lib/chat.ts`.**
  - `stream()` sends `turn` and maps 409 to a `TurnRunningError`.
  - `turnState(noteId)` reads the GET.
  - `reattach(noteId, from, onChunk, signal)` reads the SSE, sharing `stream`'s reader.
- **`useChat` follows the server.**
  - A turn's reply id is made before sending.
  - When the stream breaks (not a user abort), `useChat` asks `turnState`:
    - running, or finished in the registry: reattach from 0 and rebuild the turn;
    - not in the registry: take the saved transcript if it holds the reply;
    - otherwise the old error, with the words back in the box.
  - After a turn the server took, the phone no longer PUTs the transcript. The PUT stays only for a
    turn the server refused before starting, as today.
  - An app `resume` (a `resumed` counter signal that `App` bumps) runs the same check for a
    streaming chat: it drops the local reader and reattaches.
- **Restoring a chat.**
  - The open ritual and the Ask chat are stored locally (`writeLocal("chats", …)`: noteId, kind,
    date, effort, minimized).
  - `useChat` can open on an existing `noteId`. It loads the saved transcript, drops a `partial`
    reply, and reattaches if the turn still runs.
  - A cold start reopens the ritual as it was, minimized or not, and Ask on its tab. The
    notification's `extra` carries the same reference.

### The mini bar

- **Minimize keeps the chat mounted, hidden.** A step card's answers live in its own state and
  are reported on mount, so an unmount would empty the pill. The ritual stays mounted under a
  hidden wrapper while the shell shows (`ritual` gains `minimized`).
  - KeepAwake is released while it is minimized.
  - Back during a running turn minimizes. Back otherwise still closes.
  - A button by Close, and a swipe down on the header, minimize.
- **Ask stays mounted too**, hidden while another tab shows, so its conversation and its turn
  survive a tab switch (today they are lost).
- Each chat publishes `{ kind, title, working, line, unseen }` to a `chatActivity` signal.
  - `MiniChat` (`components/MiniChat.tsx`) sits above the bottom tabs. It shows the minimized
    ritual, or Ask while it works or has an unseen reply and another tab is showing.
  - A tap reopens the chat.
  - `line` is the latest line of the streaming text, or the working status, or the first line of
    the reply (`latestLine` in `lib/chat.ts`).

### Notifications

- **While a turn runs: a foreground service.** `@capawesome-team/capacitor-android-foreground-service`
  8.1.0 (Capacitor 8, MIT, maintained).
  - Type `dataSync` (1). The manifest's `<service android:foregroundServiceType="dataSync">` and
    the `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` permissions must match.
  - No overlay permission and no location type.
  - The notification reads "Caius is thinking…" with the latest line. It goes on a low-importance,
    silent channel `caius-working`, and updates at most once a second.
  - The service starts when a turn starts, while the app is in front, and stops when no chat is
    working.
- **When the turn ends:** "Caius replied" with the reply's first line, on channel `caius`, as a
  local notification.
  - It is posted only when the chat is not on screen (app hidden, chat minimized, or another tab).
  - Its action type `caius-reply` has Reply (`input: true`) and Open.
  - `extra` carries `{ chat: "ritual" | "ask", noteId, kind, date }`.
- **The action handler** (`App.onNotificationAction`).
  - Open, or a tap, restores the chat and shows it.
  - Reply restores the chat if the app started cold, then sends the input as the next message.
  - The plugin's action intents open the activity, so a reply brings the app forward. That still
    meets decision 9, and the report says so.
- Fixed ids: working 21, replied 22, clear of the nudge (11–14), snooze (111, 112) and test (99)
  ids.

## Tasks

Tasks 1, 2–3 and 6 can run in parallel; the phone tasks that touch `lib/chat.ts`, `Chat.tsx` or
`App.tsx` run one at a time. Each ends in one commit, `caius: …`.

### 1. One turn assembler in commons
- Files: new `packages/commons/src/lib/caius_turn.ts` (+ `caius_turn.spec.ts`), `packages/commons/src/index.ts`, `apps/caius-app/src/lib/chat.ts`, `apps/caius-app/src/lib/chat.spec.ts`, `apps/caius-app/src/screens/Chat.tsx` (`useChat.turn` uses `turnMessages`).
- Move `applyChunk`/`assemble`/`AssistantTurn` from `lib/chat.ts`, typed on `LlmStreamChunk`. Add `turnMessages(turn, createdAt, { partial })`, which returns the stored messages a turn ends as (notes, then reply or error), and marks the reply `partial` when asked. `lib/chat.ts` re-exports `applyChunk`/`AssistantTurn`.
- Tests: the existing `applyChunk` cases move to the commons spec; `turnMessages` for a reply with notes, an error, and a partial.
- Done: the commons spec and the `caius-app` suite pass; `Chat.tsx` builds the reply with `turnMessages`, same output as before.

### 2. The server's turn registry
- Files: new `apps/server/src/services/caius/turns.ts` + `turns.spec.ts`.
- `startTurn({ noteId, messages, config, transcript?, replyId? })` → the turn, or `"running"`. `turnOf(noteId)`. `subscribe(turn, from, onChunk, onEnd)` → unsubscribe. Runs `runChat` (lazy import), keeps the chunk log, saves throttled and finally (in `cls.init`, only when `transcript` is given and the note is still a chat note, within `MAX_CHAT_CONTENT_LENGTH`), the caps and the retention above. Ends every turn with a terminal chunk: `done`, or an `error` when `runChat` stopped without one or the cap fired.
- Tests (with `runChat` mocked as a generator held on a deferred):
  - a turn with no subscriber runs to the end and saves the whole transcript;
  - a mid-turn save has `partial: true` and the final one hasn't;
  - a second start while one runs is refused;
  - `subscribe(from)` replays then follows;
  - the time cap ends a turn with an error;
  - a finished turn is dropped after retention.
- Done: `vitest run src/services/caius/turns` passes.

### 3. The routes
- Files: `apps/server/src/routes/api/caius_chat.ts`, `apps/server/src/routes/routes.ts`, `apps/server/spec/etapi/caius-phone.spec.ts`.
- `checkCaiusChat` reads and checks `turn`. `streamCaiusChat` starts the turn through the registry (409 `turn_running`) and streams it with a heartbeat; a closed response only unsubscribes. Adds `turnState` (`GET /etapi/llm-chat/:noteId/turn`) and `reattachTurn` (`GET /etapi/llm-chat/:noteId/stream`).
- Tests:
  - a client that drops mid-stream (the mocked turn released after the response closed): the note ends up holding the transcript and the reply;
  - `GET …/turn` while running and after;
  - reattach from 0 and from an offset returns the rest;
  - 409 for a second turn;
  - 401 without a token, and 400 for a note that isn't a chat note, on both GETs;
  - the `turn` checks.
- Done: `vitest run spec/etapi/caius-phone src/services/caius/turns` passes.

### 4. The phone's chat API
- Files: `apps/caius-app/src/lib/chat.ts`, `apps/caius-app/src/lib/chat.spec.ts`.
- `stream(…, turn)` sends `turn`; 409 → `TurnRunningError`; `turnState(noteId)`; `reattach(noteId, from, onChunk, signal)` sharing the SSE reader with `stream`; `latestLine(turn | message)` for the mini bar and the notification.
- Tests: `fetch` mocked; the body carries `turn`; reattach parses chunks from the GET; 409 maps; `latestLine` cases.
- Done: the `caius-app` suite passes.

### 5. `useChat` follows the server, and restores a chat
- Files: `apps/caius-app/src/screens/Chat.tsx`, `apps/caius-app/src/app-state.ts`, `apps/caius-app/src/App.tsx` (resume bump, cold restore), new `apps/caius-app/src/lib/chats.ts` (+ spec: the pure parts, i.e. the stored-chat record and `restoredMessages(content)`, which drops a partial reply).
- The turn flow, break handling, resume and restore described above. No PUT after a turn the server took. `ritual` gains `noteId?` and `minimized?`; `Ask` and `Ritual` accept a stored chat.
- Tests: `restoredMessages` and the stored-chat record round-trip; a `useChat`-level check that a stream broken mid-turn, with the server's turn finished, ends with the saved reply (`fetch` mocked; the transcript survives a simulated pause).
- Done: the `caius-app` suite passes.

### 6. The foreground-service plugin and its manifest
- Files: `apps/caius-app/package.json`, `pnpm-lock.yaml`, `apps/caius-app/android/app/src/main/AndroidManifest.xml`, the `cap sync` gradle files it changes (`android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle`).
- Install 8.1.0 exactly. Add the `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC` permissions, and the plugin's receiver and service with `foregroundServiceType="dataSync"`. `cap sync android`.
- Done: `android:debug` builds an APK.

### 7. The mini bar
- Files: new `apps/caius-app/src/components/MiniChat.tsx` + `mini-chat.css`, `App.tsx`, `app-state.ts`, `Chat.tsx`, the chat CSS, `components/ui.tsx` (icons).
- The ritual is kept mounted and hidden while minimized, and Ask is kept mounted. The `chatActivity` signal. A minimize button by Close and a swipe down on the header. Back minimizes while a turn runs. KeepAwake is released while minimized. `MiniChat` sits above the nav.
- Tests: a rendered `MiniChat` from `chatActivity` (working line, replied line, tap reopens); the pill's answers are kept across minimize and reopen (render `Ritual`, report a card answer, minimize, reopen, `pending` unchanged).
- Done: the `caius-app` suite passes.

### 8. Notifications
- Files: `apps/caius-app/src/lib/notify.ts` (+ spec), new `apps/caius-app/src/lib/chat-notify.ts` (+ spec), `App.tsx`.
- Channels `caius-working` (low, silent; created through the plugin) and `caius`; the action type `caius-reply`.
- `chatNotice(activity, onScreen)` → working / replied / none, pure.
- A driver on `chatActivity` that starts, updates (throttled) and stops the service, and posts the replied notification when the chat is off screen.
- The handler for Reply (`inputValue`) and Open, working cold.
- Tests: `chatNotice` cases; the action handler restores and sends (plugin mocked); the ids stay clear of the nudge ids.
- Done: the `caius-app` suite passes.

### 9. Docs
- Files: `docs/ktn/caius/phone.md`, `docs/ktn/caius/internals.md`.
- Who saves the transcript now, the turn routes, reattach, the mini bar, the notifications, and the plugin's permissions.

### 10. Verification (by the controller, not a subagent)
- Narrow suites: `apps/server` `vitest run src/routes/api/caius_chat* spec/etapi/caius-phone src/services/llm/providers/claude_agent.spec.ts src/services/caius`; `apps/caius-app` `vitest run`; then `pnpm typecheck` once.
- Rig at 8092 (`~/documents/apps/caius-runs/background-rig`):
  - Start a turn with `curl --max-time` so it drops mid-stream, then read the note with `GET …/turn` until it stops running. It must hold the whole reply. (`chat.sh` PUTs the transcript itself, so it proves nothing here.)
  - Reattach from 0 and from an offset.
  - Dev app on 8096 in headless Chrome: start a ritual, minimize, and on Today the mini bar shows progress (screenshots).
- `android:debug` builds. The APK is not installed.
