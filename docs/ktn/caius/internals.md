# How Caius works

For the method see [method.md](method.md); for using it see [README.md](README.md). The code wins over this page, and over [design/](design/), where they differ.

## Package layout

| Where | What |
|---|---|
| `packages/caius/` | The library. No Trilium imports. `core/` is the task-line grammar, `resolve/` the horizon rules, `index/` the scan, `trilium/` the note-level logic: `journal`, `plan`, `plan-read`, `plan-html`, `forward`, `forward-html`, `sections`, `keys`, `markdown`, `html-util`, `present`, and `store` (the `NoteStore` interface). It reaches notes only through that interface. |
| `apps/server/src/services/caius/` | `store.ts` (the becca `NoteStore` and the lock), `service.ts` (the operations), `schemas.ts` (zod inputs), `tools.ts` (the tool registry), `register.ts` (the defensive loader and the skill). |
| `apps/server/src/routes/api/caius.ts` | The `/api/caius/*` routes. |
| `apps/server/src/assets/llm/caius/skill.md` | The `caius` skill sheet. |
| `apps/client/src/services/caius.ts` | The route client and the write protocol. |
| `apps/client/src/menus/task_actions.ts` | The task action list, shared by the right-click menu, the commands and the mobile sheet. |
| `apps/client/src/widgets/sidebar/plan/` | The Plan tab. |
| `apps/client/src/widgets/type_widgets/text/list_context_toolbar.ts` | The mobile Task button. |

## How Caius reads the Journal

Periodic notes are found by label under `#calendarRoot` and given paths, so the horizon rules work on dates (`TRILIUM_CONFIG` in `packages/caius/src/trilium/config.ts`):

| Trilium | Path | Current / future / past |
|---|---|---|
| `#dateNote=2026-10-26` | `Journal/Daily/2026-10-26.md` | today / week / overdue |
| `#weekNote=2026-W44` | `Journal/Weekly/2026-W44.md` | week / orbit / overdue |
| `#monthNote=2026-10` | `Journal/Monthly/2026-10.md` | orbit / planning_ahead / overdue |

Week labels are ISO weeks. A periodic note's direct children that are not periodic themselves count as part of that period, at `Journal/Daily/2026-10-26/2026-10-26 <title>.md`. Skipped: protected notes, non-text notes, anything labelled `#morningBrief`. Each document keeps its `noteId`. Label searches quote the value (`#dateNote="2026-10-26"`); Trilium reads a bare date as arithmetic and finds nothing.

### Task states

Day notes use CKEditor to-do lists. The fork stores extra states as `data-trilium-task-state` on the `<li>`, defined by the notes under `_taskStates`, each with a `markdownSymbol`. Caius reads the symbols from `_taskStates` at scan time. Shawn's are none ` `, Doing `/`, Done `x`, Rescheduled `>` (id `_rescheduled`), Cancelled `-` and Maybe `?`. The first five are Caius's states. Maybe stays outside the grammar, so `[?]` items are not indexed.

The note's HTML becomes markdown only to be parsed: text is not escaped (so `~2h` stays a token and a typed `[>]` is still a marker), and a nested list sits directly under its parent line. Nothing is ever written back through markdown.

### Sections, critical, Suggested

Each task gets a `section` (nearest heading above) and a `sectionKind`: `slot` for Morning / Afternoon / Evening, `area` for Foundation / Growth / Recharge, otherwise `group`. Names compare ignoring case, emoji and spacing. A task inside an Important block is critical: the derived markdown gets a trailing `!!!` (tier 3) and nothing is written back. Tasks under Suggested lose their checkbox in what the scanner sees, so they reach no horizon and no capacity.

## `NoteStore` and its two adapters

`NoteStore` (`packages/caius/src/trilium/store.ts`) is the whole of what the library needs from Trilium: `search`, `note`, `content`, `putContent`, `calendarDay` / `calendarWeek` / `calendarMonth`, and `addLabel`.

- **`createBeccaStore()`** (`apps/server/src/services/caius/store.ts`) is the one in use. It works on becca and the core services directly, with no HTTP, and mirrors the ETAPI handlers call for call. Search ignores the client's hoisted note (`ignoreHoistedNote`), as ETAPI does, so a user hoisted into a subtree still sees the whole Journal. With no `#calendarRoot`, the reads (`open`, `explain`, `assign_ids`) answer empty rather than failing.
- **`etapiClient()`** (`packages/caius/src/trilium/etapi.ts`) is the original adapter on ETAPI. Nothing in the fork uses it. It is what an ETAPI command-line tool would be built on, if a fallback is ever wanted.

`withListItemIds(store)` wraps either one so that every `putContent` passes through `ensureListItemIds`.

## The compare-and-swap and the lock

- `putContent(noteId, html, expected)` compares the note's stored HTML with `expected` and writes in **one synchronous `sql.transactional`**. A mismatch writes nothing and resolves `false`, and the library reports that item as skipped with reason `edited`. It does not rely on the store never yielding.
- **Every store write is its own transaction**, one per call.
- **One process-wide lock** (`withCaiusLock`) serializes every Caius call, tools and routes alike. Each entry point takes it, so entry points never call one another. It has no timeout, because releasing early would let two calls overlap. A call that holds it over 30 seconds logs `Caius call <name> has held the lock for over 30 s` and logs again when it releases. Calls keep their own CLS context.
- A batch that fails partway keeps what succeeded. Target-first ordering and idempotent re-runs cover the rest.
- Known, upstream: `putContent` starts Trilium's detached `asyncPostProcessContent`, which can rewrite a note after fetching link-preview images (only for `link-embed` and `link-mention` markup). ETAPI does the same.

### Async tools, no outer transaction

The tool layer originally took only synchronous tools. It now also takes tools declared `async: true`, which MCP and the chat pipeline await. An async tool manages its own transactions, so there is **no transaction around a call**. The step 2 review found that an outer `transactionalAsync` breaks when an MCP batch or parallel tool calls start in the same tick, and that a failed nested write can hide earlier committed writes from open editors. (`caius_assign_ids` and the other writes set `mutates: true` and `async: true`.)

## The routes and the `stale` token

`/api/caius/*` runs the same operations as the tools, with the same zod schemas plus an optional `expectedBlobId` on each item of accept, dismiss, set-state and forward:

| Route | |
|---|---|
| `GET status`, `plan`, `open`, `explain` | Reads. `status` always answers 200: `{ enabled: true }` or `{ enabled: false, detail }`. |
| `POST add`, `accept`, `dismiss`, `set-state`, `forward`, `assign-ids` | Writes. Body `{ items, dryRun }`; answer `{ results }`, one per item. |

The service loads on the first request, off the startup path. If it fails to load, the cause is logged once as `Caius disabled: …`, the failure is cached until restart, and every route answers `503 caius_unavailable`. A `bad_request` or `not_found` result becomes a 400 or 404.

**`stale`.** Before any write, inside the lock, `unlessStale` compares each item's `expectedBlobId` with `becca.notes[id].blobId` (a hash of the content). A mismatch skips that item as `reason: "stale"` with the note's current `blobId`, and the library never sees it. All `blobId`s of a batch are read before its first write, so several items on one note share one token. The tools take no token, since an agent is not holding an editor open.

Without the token, an editor save already in flight would silently overwrite the Caius write: the client's save path, `PUT /api/notes/:id/data`, has no version check.

## Server-assigned list ids

CKEditor keeps any `data-list-item-id` it is given but invents a random one for an item without, and for a note without headings it may differ on every load (found by the editor spike, [design/](design/2026-10-27-editor-writes-and-ids.md)). So Caius assigns ids on the server, in the same format (`e` + 32 hex), to every list item (`<li>` in a `<ul>` or `<ol>`) that lacks one, in every write it makes. An id is treated as changeable: pasted items get new ones. `caius_assign_ids` backfills the notes Caius has not written to; it is a dry run unless `dryRun: false`.

## Forwarding

Forwarding moves a task the way you do by hand. The old item becomes Rescheduled (state `_rescheduled`, title "Rescheduled", box checked) with a trailing italic `scheduled Tuesday 27` linking to the target. An open copy appears in the target with a `from Monday 26` link back. Nothing goes through markdown: `forward-html.ts` parses the HTML with `node-html-parser` for positions only and splices the changes into the original string, so every other byte of the note stays as Trilium stored it.

- **Target.** A copy under the heading with the same name as the source's section (compared ignoring case and spacing), else the end of the first task list, else a new `<h2>☑️ Tasks</h2>` list at the end. Never the critical block or Suggested. The copy is open (Doing stays Doing), has a fresh id, and carries only open sub-items, also with fresh ids. The target note comes from the calendar service and is created from the template if missing. Into an untouched template day, the copy replaces the `[…]` placeholder.
- **Source.** The item and its live sub-items become Rescheduled; closed sub-items stay.
- **Order and idempotence.** Target first, then source, so a failure never leaves a task marked moved with no copy. An item already Rescheduled is `already_moved`. A copy already in the target (identical text and a `from` link to the source) is not duplicated; the run just marks the source.
- **Edit guard.** A changed target skips the item as `edited` with nothing written. A source that changed after the target was written is reported `failed`, and re-running finishes it.
- **Week and month.** `to` may be a day, an ISO week or a month, and the source may be any of them.
- Items in a batch run one at a time, each reading fresh.

### Plain internal links

The links written into forwarded tasks (`scheduled Tuesday 27`, `from Monday 26`) are **plain internal links**, `<a href="#root/<noteId>">text</a>`, not `reference-link` anchors. CKEditor treats a `reference-link` as a live reference: when the note is opened and saved it replaces the link text with the target note's title (`27 - Tuesday`) and loses the italic around it. A plain link keeps its text and its italic through the editor. Both readers still understand the old reference-link markup in notes written earlier.

### Finding the item

Each CKEditor `<li>` has a `data-list-item-id`. The scan records it per markdown line (`TriliumDoc.itemIds`; it never becomes a `^id`), and the tools return it as `listItemId` beside `noteId`. A `listItemId` is `null` for an item without an id (older notes) and for a plain bullet; those cannot be targeted until `caius_assign_ids` runs.

## The write rule and the client protocol

Every Caius write happens on the server. Caius logic is never re-implemented against CKEditor's model. For an action started on a note that is open in an editor, `caiusWrite()` in `apps/client/src/services/caius.ts`:

1. **Locks.** Finds every live editor holding the note (and any in `alsoLock`, such as a forward's target) and calls `enableReadOnlyMode` on each, with a `Symbol` of its own, so one write ending does not unlock the editor for another.
2. **Waits its turn.** Writes on the same note go through a per-note queue (`writeQueues`), one at a time. When its turn comes, a write looks up the open editors of its notes again, locks any that appeared during the wait with its own `Symbol`, and unlocks exactly the ones it locked.
3. **Saves.** Triggers `saveNoteDetailNow` on each editor, then `ws.waitForMaxKnownEntityChangeId()`, so `froca.notes[id].blobId` is the saved content's. Without that wait the client would send the pre-save `blobId` and spend its retry on its own lag.
4. **Sends the token.** POSTs the route with `expectedBlobId`.
5. **Retries once.** On a `stale` skip, saves again and repeats once. A second `stale` is shown as the "changed while Caius was writing" toast.
6. **Waits for the reload.** If any result changed something, waits until each locked editor of a note that was actually written has had its data replaced. A forward's `moved` result carries `writtenNoteIds` (the target, then the source; only the source when the target already held the copy), and editors of other locked notes stop listening and unlock at once. The reload shows as an `editor.data` `set` event, with listeners registered before the request, since the reload can beat the response over the WebSocket. Editors that miss it for 3 s (`RELOAD_TIMEOUT_MS`) have the note fetched again and get another 3 s; if that fails too, the "Reload the note before typing" toast appears.
7. **Unlocks**, in a `finally`.

**Time bounds.** The save and the request each get 10 s (`ANSWER_TIMEOUT_MS`); past that the write is abandoned with "Caius didn't answer in time. The change may still arrive…". The editor lock is held for the whole write.

`EditableText` keeps the caret across the reload when the reloaded note is the same note, through `setDataKeepingSelection`.

**Known limits.** A key pressed while the editor is read-only is dropped. Opening a note with headings saves it (the table of contents writes `tocId` into the model), so every Caius write to an open day note is followed by one harmless echo save. Writes that do not start in the open editor (MCP, the Plan tab on another note, another device) can still race someone typing in that note, as Trilium sync does today.

## Tools, skill and loading

`tools.ts` is registered with `registerToolRegistryLoader`, which puts the nine tools on `/mcp` and in the AI assistant. `loadCaiusTools` never throws: a failure logs `Caius disabled: <message>` and yields an empty registry. The `caius` skill sheet is registered only once the tools load, so it is listed only where they exist. `explain` returns `lane`, `rule`, `source` and a one-sentence `summary` from the server catalogue.

## Not done

- Pushing a task to its project note.
- The "Automatic" scheduled-fates switch.
- Editing a task's text or estimate in place. A write must change the one `<li>`, never round-trip the note through markdown.
- Following `<section class="include-note">`.
- A SQLite index; tools compute from live notes. Bring one back only if Journal-wide reads turn slow.
