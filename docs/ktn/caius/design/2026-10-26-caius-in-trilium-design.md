> Copied from the caius repo on 2026-10-27. It is historical: where it differs from the code in this fork, the code is authoritative.

# Caius inside Trilium: design

Agreed with Shawn on 2026-10-26 (brainstorm). Caius stops being a separate app. The React board, the CLI and the Obsidian code go; Caius becomes a package inside the Trilium fork (`Kautiontape/trilium`, `ktn` branch), reached through Trilium's built-in MCP server, a planning panel in Trilium's right pane, and task actions on right-click (desktop) or a toolbar button (mobile).

The method (cascade, one fate on close, capacity) is in `docs/trilium-planning.md`; it stays authoritative. This doc covers where the code goes and how it is reached.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where do planning and shutdown happen? | Both in conversation (MCP) and in Trilium, equally | Shawn's call |
| Mobile? | Task actions on mobile; the planning panel is desktop only | The mobile layout has no right pane and loads no custom widgets |
| Script notes or native fork code? | Native in the fork, Caius as a fork package | Script notes can't add to the editor's right-click menu, don't load on mobile, and can't add editor plugins. The fork already builds and deploys itself (`ktn-build-publish.yml` → GHCR → `ktn-deploy.yml` on LXC 110), so native costs little |
| MCP: local or hosted? | Hosted for free: register on the fork's own `/mcp` | `apps/server/src/services/mcp/mcp_server.ts` serves every tool registry, behind an ETAPI token. The same registry also feeds Trilium's AI assistant |
| CLI? | Drop it; keep the note-store interface | A CLI on ETAPI fails whenever Trilium is down, so it is no backup for that. It would only survive a broken Caius build in the fork. The daily brief is the `/morning` skill run as a scheduled agent, so it can use MCP. With the interface kept, an ETAPI CLI can come back as a second adapter, never a second copy |
| SQLite index? | Dropped | Tools compute from live notes. Bring an index back only if Journal-wide reads turn out slow |
| This repo? | Archived after the move | The `obsidian` branch keeps the Obsidian version |

## Architecture

### `packages/caius` (fork): the library

No Trilium imports. It holds:
- `core`: the task-line grammar
- `resolve`: the horizon rules
- the HTML transforms and planning logic now in `packages/trilium/src`: `forward-html`, `plan-html`, `plan`, `plan-read`, `journal`, `keys`, `sections`, `markdown`, `html-util`

It reaches notes only through a `NoteStore` interface, which is today's `PlanEtapi` renamed: `search`, `note`, `content`, `putContent`, `calendarDay` / `calendarWeek` / `calendarMonth`, `addLabel`. Its existing tests move with it and must pass unchanged.

### `apps/server/src/services/caius/` (fork): the server side

- `store.ts` implements `NoteStore` directly on becca and the calendar service, with no HTTP calls.
- `tools.ts` is the `caius` tool registry, registered with `registerToolRegistryLoader` (`packages/trilium-core/src/services/llm/tools/registration.ts`). That puts it on `/mcp` and in the AI assistant. The tool layer used to accept only synchronous tools. It now also takes tools declared `async: true`, which MCP and the chat pipeline await. Async tools manage their own transactions: there's no outer transaction around a call. The step 2 quality review showed that an outer `transactionalAsync` breaks when an MCP batch or parallel tool calls start in the same tick, and that a failed nested write can hide earlier committed writes from open editors. So:
- **Every store write is its own `sql.transactional`.**
- **The edit guard is a compare-and-swap.** `putContent(noteId, html, expected)` compares and writes in one synchronous transaction, and a mismatch becomes the existing `edited` skip. It doesn't rely on the store never yielding.
- **One process-wide lock serializes every Caius call** (tools and routes), each keeping its own CLS context.
- **A batch that fails partway commits what succeeded.** Target-first ordering and idempotent re-runs cover the rest.
- **Known, upstream:** `putContent` fires Trilium's detached `asyncPostProcessContent`, which can rewrite a note after downloading link-preview images (only for `link-embed`/`link-mention` markup). ETAPI does the same.
- Internal routes, `/api/caius/*`, for the client. They call the same service functions as the tools.
- **Defensive loading.** The loader and every route catch errors. A failure logs its cause and switches Caius off (routes return `503 caius_unavailable`). Trilium, `/mcp` and the other tools must keep working.

### Client (fork)

- The Plan tab in the right pane (desktop).
- One list of task actions, which feeds both the editor's right-click menu (desktop) and a mobile toolbar sheet.

### The write rule

Every Caius write happens on the server, and Caius logic is never re-implemented against CKEditor's model. Spike A (2026-10-27) found the first version of this rule unsafe. For an action started from the client on a note open in the editor, the steps are:

1. **Lock and flush.** Put the editor in read-only mode (`enableReadOnlyMode("caius-write")`), then await its save. `saveNoteDetailNow` must be made awaitable first: today `EditableText.tsx:254-257` returns before the save is sent.
2. **Write with a version.** The client sends the note's `blobId`. Inside the Caius lock, before any write, the server compares it with `becca.notes[id].blobId` (a hash of the content). A mismatch makes that item `skipped` with reason `stale`, and the client flushes again and retries once. All of a batch's blobIds are read before its first write, so several items on one note can share one token. Without this, an editor save already in flight silently overwrites the Caius write: the client save path, `PUT /api/notes/:id/data`, has no version check.
3. **Reload, then unlock.** Trilium's entity sync reloads the editor (about 30–60 ms locally), then the client leaves read-only mode. Keystrokes during the gap would otherwise be lost or land at the top of the note.
4. **Keep the caret.** Fork change: `onContentChange` (`EditableText.tsx:75-82`) saves and restores the model selection when the reloaded note is the same note. Today every reload moves the caret to the start of the document.

Writes not started from the open editor (MCP, the Plan tab, another device) still race someone typing in that note, as Trilium sync does today. That's accepted.

**Ids.** CKEditor keeps any `data-list-item-id` it's given, but invents a random one for an item without (`@ckeditor/ckeditor5-list` upcast), and for a note without headings it may be different on every load. So Caius assigns ids on the server, in the same format (`e` + 32 hex), to every list item (`<li>` in a `<ul>` or `<ol>`, as CKEditor does) that lacks one, in every write it makes (`withListItemIds` wraps the store). Caius must also treat an id as changeable: pasted items get new ids. A one-off backfill, `caius_assign_ids` (dry run first), covers the 87 older Journal tasks without ids, and plain bullets as well. It writes to the live Journal, so it runs only with Shawn's go-ahead.

**Known echo.** Opening a note with headings saves it, because the table of contents writes `tocId` into the editor model (upstream code). So every Caius write to an open day note is followed by an echo save from the client. It's harmless; fixing it upstream is optional.

## Tools (`caius` registry)

Every write takes a list of items and a `dryRun` flag, and returns one result per item, as now: `moved` / `skipped` with a reason / `failed` with an error.

Reads:
- `caius_plan {period: day|week|month, date?}`: today's `caius day` JSON (critical, sections in order, top 3, suggested, capacity against target, dismissed keys).
- `caius_open {lane?, limit?}`: open tasks across the Journal with `noteId`, `listItemId`, lane (overdue, today, week, orbit, planning_ahead, someday) and days late. Replaces `open-trilium` and the planned `overdue`.
- `caius_explain {noteId, listItemId}`: why a task is in its lane.

Writes:
- `caius_add`, `caius_accept`, `caius_dismiss`: as built, including dedupe and `#caiusDismissed`.
- `caius_set_state {state: done|doing|cancelled, reason?}`: replaces `done` / `start` / `drop`. Cancelled needs a reason.
- `caius_forward {to}`: `to` is a day (`2026-10-27`), a week (`2026-W44`) or a month (`2026-11`). Week and month are new; the shutdown ritual needs them.

A `caius` skill sheet, served through the existing `load_skill`, gives the method and how to run daily planning and shutdown with these tools. Any agent (the brief, Claude, Trilium's assistant) reads the same rules from one place.

## The Plan tab (desktop)

A new tab in the right pane, beside Table of Contents, Highlights and Backlinks. It follows the active note: a day, week or month note shows that period; any other note shows today. A Day / Week / Month switcher with ‹ › arrows moves between periods. It shows only what the note itself doesn't:

1. **Capacity.** Planned minutes against the target (day 180–240, week 720–900, month none), plus "N unestimated, counted at 30m". Clicking it lists them so you can add estimates.
2. **Suggested.** Accept (pick a header or Critical) and Dismiss.
3. **Pull in.** Overdue, this week and this month lanes, each row with a button to bring it into the period. Clicking a row opens its note at that item.
4. **Close** (past or ending periods). Every open task gets a fate: Tomorrow / Next week / Next month / Drop (asks for a reason). A counter shows "5 of 8 decided" and one Apply writes them all.

It refreshes on entity-change events for Journal notes.

## Task actions (desktop right-click, mobile toolbar)

These appear on a todo item in a Journal note (a day, week or month note, or a child of one):
- Doing, Done
- Forward ▸ Tomorrow / Next week / Next month / Pick a date…
- Drop… (asks for a reason)
- Under Suggested only: Accept ▸ (the note's headers, plus Critical) and Dismiss
- Why is this here?

The menu is built per click, as `buildAiActionsMenuItem` is in `apps/client/src/menus/text_editor_context_menu.ts`, and shows only the actions that apply. The same actions are also registered as Trilium commands with no default keys, so they can be bound in shortcut settings.

**Right-click, browser and Electron.** Shawn uses both. Electron replaces the right-click menu everywhere, so its menu already opens on a bare caret. The browser's `setupContextMenu` (`note_context_menu.ts`) opens Trilium's menu only when text is selected under the pointer. Both build their items in the same function, so the Task submenu is added there once, and the browser gate gets one exception: a right-click on a todo item always opens Trilium's menu (you lose the browser's native menu, and its spellcheck suggestions, on task lines only).

**Mobile.** Shawn's phone uses the server's mobile web layout in a browser, not the Capacitor app, so the server routes are reachable. There's no right-click path on mobile. A Task button is pinned to the front of the mobile editor toolbar while the cursor is in a todo item. It extends `list_context_toolbar.ts` (commit `b4f06c88e9`) with a todo-only check: `listType === "todo"`, because bulleted items carry `listItemId` too. It opens the same `MenuItem[]` through `ContextMenu`, which already shows as a bottom sheet on mobile, with drill-in submenus. In the Capacitor build, which has no server routes, the button is hidden.

Tasks whose `<li>` has no `data-list-item-id` (older notes) can't be targeted. If saving through the editor writes ids (spike 2), "save first, then act" fixes them. Otherwise the action is greyed out with a reason.

## Testing

- `packages/caius`: today's suite, ported over and unchanged in behaviour.
- The server store and tool registry: specs against the fork's test database, written like `mcp_server.spec.ts`.
- The action builder and the Plan tab: client specs, written like `text_editor_context_menu.spec.ts`.
- One e2e test in `packages/trilium-e2e`: right-click → Forward → Tomorrow.
- After each deploy: dry runs of the tools against the live Journal before any real writes.

## Rollout

Each step is its own PR to `ktn` (CI builds and deploys it).

0. **Spikes**, run before anything is built on them:
   1. Does the open editor reload cleanly after a server-side write to its note?
   2. Does saving through the editor add `data-list-item-id` to older items?
   3. Can the mobile toolbar tell the cursor is inside a todo item?
1. **`packages/caius`**: the library moves in and its tests pass. It is a plain copy from this branch, with no git history and no changes. Every change after that (the `NoteStore` rename, week and month forwarding, `caius_set_state`) is made in the fork only; nothing is changed here first and ported later.
2. **Server store, tool registry and skill sheet.** MCP works, and the brief writes its suggestions with `caius_add` into the Suggested section.
3. **Right-click Task submenu** (desktop).
4. **Plan tab.**
5. **Mobile Task button.**
6. **Archive this repo.** A final commit removes `api`, `gui`, `write`, `watch`, the disk scan in `index`, `cli`, and the Obsidian config and links, and adds a README pointing to the fork. The docs (`trilium.md`, `trilium-planning.md`, this spec) move to the fork's `docs/ktn/caius/`.

## Deferred

- Pushing a task to its project note (the fourth fate): needs rules for finding a project's note.
- The "Automatic" scheduled fates switch (off by default in `trilium-planning.md`).
- Editing a task's text or estimate in place.
- Drag and drop in the Plan tab, and choosing a position on accept.
- An ETAPI CLI, as a second `NoteStore` adapter, if a fallback is ever wanted.
- Following `<section class="include-note">`.
