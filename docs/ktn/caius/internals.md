# How Caius works

For the method see [method.md](method.md); for using it see [README.md](README.md). The code wins over this page, and over [design/](design/), where they differ.

## Package layout

| Where | What |
|---|---|
| `packages/caius/` | The library. No Trilium imports. `core/` is the task-line grammar, `resolve/` the horizon rules, `index/` the scan, `trilium/` the note-level logic: `journal`, `plan`, `plan-read`, `daynote`, `until`, `context`, `plan-html`, `forward`, `forward-html`, `sections`, `keys`, `markdown`, `html-util`, `present`, `brief-html`, and `store` (the `NoteStore` interface). `daily/` holds the pure parts of Wind down and Plan my day: `meetings`, `candidates`, `standing`, `blocks` and `format`. Beside them are `clock.ts` (the one place the time is read) and `workday.ts`. It reaches notes only through that interface. |
| `apps/server/src/services/caius/` | `store.ts` (the becca `NoteStore` and the lock), `service.ts` (the operations), `schemas.ts` (zod inputs), `tools.ts` (the tool registry), `register.ts` (the defensive loader and the skill). |
| `apps/server/src/services/caius/daily.ts`, `brief.ts` | The Wind down and Plan my day steps, and `caius_brief_write`. |
| `apps/server/src/services/caius/weather.ts` | `fetchDayWeather()`: today's WMO code from Open-Meteo, `undefined` on any failure or after 3 s. |
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

### Meetings and Context

`buildDoc` finds the `### Meetings` and `### Context` sections with `ProseTracker` in `sections.ts`: a heading's level decides where one ends, and names compare like section names. Their lines lose any checkbox in both `text` and `fullText`, except lines in the Important block, so every reader (the scan, lanes, capacity, the duplicate check) sees plain bullets. The bullets are kept as `TriliumDoc.meetings` and `contextLines`. `readPlan` returns them as `meetings`, `context` and `expiredContext`.

`parseContext` (`until.ts`) takes off a trailing `(until …)` that parses as a date: `Fri 6 Nov`, `6 Nov` or `2026-11-06`, a year-less one resolved forward to the next occurrence on or after the note's date (the previous one when that is over 300 days ahead). An unparseable suffix stays in the text. A line is expired when its date is before the plan's date: the day itself, or for a week or month note today when it falls in the period, else the nearer end of it.

The HTML side refuses the same sections. `inProseSection` stops `forward` and the state changes from touching a to-do under them, `addTasks` and `acceptTasks` skip a placement that would land inside them (`prose_section`, checked on the resulting note), and `placeForwarded` and the template check skip their lists. A forwarded Important task goes to the target's Important block, which is created when missing. `replaceMeetings` splices a plain `<ul>` between the Meetings heading and the next heading of the same or a higher level, or the Important block; with no heading it adds one at the top, below a leading include-note. `setMeetings` writes it as a compare-and-swap, creating a missing day note unless it is a dry run (whose diff is then against an empty note, and says so). It answers `unchanged` when the bullet texts already match, and keeps the existing item ids by position otherwise. `caius_meetings` calls it under the lock. `withListItemIds` still gives an id to any other list item without one in that write.

`gatherContext` (`context.ts`) reads the date's day note, the last three workday notes before it (`lastWorkday`), the current ISO week note and, on a Monday, last week's. It never creates a note and skips a missing, protected or non-text one. It keeps the newest of two lines with the same text, expired or not, then drops the expired ones, so a newer note that ends a line hides the older open-ended copy (compared ignoring case and spacing). A day note is dated by its day, a week note by its Monday, and a day beats a week that starts the same day. The service runs it as `caius_context`.

### The clock

Every read of the time goes through `now()` (`clock.ts`, exported as `caiusClock`). With `TRILIUM_ENV=dev` and `CAIUS_NOW` set it returns that local time; otherwise it returns the real one, which on the server is Trilium's own (`caiusNow()` in `service.ts`). `scanDocs`, `readPlan` and `addTasks` default to it. When the dev clock is set, `/api/caius/status` also answers `now`, and the client's `caiusNow()` (`services/caius.ts`) keeps the gap between that and the browser's clock. The Plan tab and the task actions read "today" from it. `nextWorkday` and `lastWorkday` (`workday.ts`) step over Saturday and Sunday; the Tomorrow fates stay the literal next day.

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

## The day's drawing

`renderDayTerrain()` (`packages/caius/src/draw/terrain.ts`) is a pure function from `{ start, end, events, work, workEnd?, weather? }` to an SVG string: a port of the daily brief's `brief-terrain`, with an evening divider and a weather icon added. It keeps `width`, `height` and `viewBox`, uses mid-tone colours that read on light and dark (an SVG attachment shows as an `<img>` and cannot see the theme), and sets every `font-size` so text is at least 11 px when shown 700 px wide. Every text is escaped. The weather icon comes from the WMO code (`weatherIcon()`).

`caius_header` (`service.header`) fetches the weather first, outside the lock, then takes the lock, renders, and calls `putAttachment()` in `store.ts`. That function updates the note's attachment with the same role and title through `note.saveAttachment()`, or creates it, in one transaction. Attachments are not in `NoteStore`: the interface is note-level, and `etapiClient` would need an implementation of it too. `createCaiusService` and `createCaiusTools` take the weather fetcher as an optional argument, so tests never reach the network.

## The routes and the `stale` token

`/api/caius/*` runs the same operations as the tools, with the same zod schemas plus an optional `expectedBlobId` on each item of accept, dismiss, set-state and forward:

| Route | |
|---|---|
| `GET status`, `plan`, `open`, `explain` | Reads. `status` always answers 200: `{ enabled: true }` or `{ enabled: false, detail }`. |
| `POST add`, `accept`, `dismiss`, `set-state`, `forward`, `assign-ids` | Writes. Body `{ items, dryRun }`; answer `{ results, blobIds }`, one result per item. |
| `POST apply` | Closes a period in one request. Body `{ forwards, drops, expectedBlobId? }`. Runs the forwards, then the drops, in one lock, checks the token once before the first write, and answers `{ results, blobIds }`. There is no MCP tool for it. |

`blobIds` maps each note the results name to its `blobId` after the writes, read inside the lock (`withBlobIds()`). A forward that fails after writing the target copy still lists the target in `writtenNoteIds`. The plan and open results carry `parentListItemId` on a sub-item, and `journal: false` when the document has no `#calendarRoot`.

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
7. **Unlocks**, in a `finally`, once its editors hold the final version. `postWrite()` records each response's `blobIds`, the last call of a multi-call write wins, and a note counts as changed when its final `blobId` differs from the one froca held before. An editor's wait is met only by a `set` that happens while froca holds that final `blobId`, so a three-item batch stays locked through the reload of an intermediate version. After a refetch, any reload counts.

**Time bounds.** The save and the request each get 10 s (`ANSWER_TIMEOUT_MS`); past that the write is abandoned with "Caius didn't answer in time. The change may still arrive…". The editor lock is held for the whole write.

`EditableText` keeps the caret across the reload when the reloaded note is the same note, through `setDataKeepingSelection`.

**Known limits.** A key pressed while the editor is read-only is dropped. The table of contents no longer saves a note on open or reload: it keeps each heading's id in a `WeakMap`, not a `tocId` attribute in the model, so there is no echo save to send a mid-reload version back and revert a later write (this fix is in the editor-reload PR, not Caius). The one save Caius adds is `flushEditors` forcing a save (`saveNoteDetailNow` with `{ force: true }`) when the editor holds list item ids its note lacks, which CKEditor invents for id-less items. It forces only when froca's content equals what the editor last loaded or saved (`noteSavedDataStore`), so an outside write the editor has not loaded yet is never overwritten. `flushEditors` decides which editors to force before any of them saves. `apply` rejects an `expectedBlobId` when its items span more than one note (400), since the token versions one note. Without a token, items from several notes are accepted.

Two known issues:

- A collapsed list that auto-expands when the restored caret lands inside it saves the note on reload (`collapsible_list_items.ts:348-374`). That save is unchecked, so it could revert a Caius write the way the table of contents did.
- With two editors on the same id-less note, the last forced save wins (`flushEditors` saves in DOM order), and the action can answer `not_found` if the clicked editor is not the last. `caius_assign_ids` removes the case.

Writes that do not start in the open editor (MCP, the Plan tab on another note, another device) can still race someone typing in that note, as Trilium sync does today.

## Tools, skill and loading

`tools.ts` is registered with `registerToolRegistryLoader`, which puts the eighteen tools on `/mcp` and in the AI assistant. `loadCaiusTools` never throws: a failure logs `Caius disabled: <message>` and yields an empty registry. The `caius` skill sheet is registered only once the tools load, so it is listed only where they exist. `explain` returns `lane`, `rule`, `source` and a one-sentence `summary` from the server catalogue.

## `caius_inputs`

`apps/server/src/services/caius/inputs/` holds `jira.ts`, `calendar.ts` and `index.ts` (`readInputs`). The capacity arithmetic is `dayCapacity` in `packages/caius/src/inputs/capacity.ts`. The tool reads no notes, so it does not take `withCaiusLock`: holding the lock across Jira and feed requests would stall the Plan tab. Each source takes `fetch`, the environment and the clock as arguments, and a spec runs on recorded files under `services/caius/fixtures/`.

| Setting | Meaning |
|---|---|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` | Jira Cloud site and basic-auth credentials. With any unset the Jira source answers `not_configured`. |
| `CAIUS_ICAL_URLS` | Comma-separated secret iCal URLs. Unset answers `calendar: not_configured`. |
| `CAIUS_USER_EMAILS` | Optional, comma-separated. Addresses that count as you when reading an attendee's `PARTSTAT`, in addition to `JIRA_EMAIL`. |

- **Jira.** REST v3 with a 10 s timeout per request. A 429, 502, 503 or 504 is retried once after `Retry-After` (at most 5 s, else 1 s). The identity and the two searches are fatal; a failure on one ticket's comments or changelog is not (`asks_partial`, `handoff_partial`). At most 80 tickets are scanned for asks (`asks_truncated`) and each search stops at 10 pages (`search_truncated`). Comments and changelogs are fetched four at a time. The search window is `updated >= -8d`; the exact 7 days are applied to each comment. Ticket keys in Context lines match in any case. Issues come from `/search/jql` and are followed with `nextPageToken`; comments and the changelog page with `startAt`. `HANDOFF_STATUSES` (`jira.ts`) is compared case-insensitively and in full, so "QA" alone matches none of the longer QA statuses. `daysInStatus` is the age of the last changelog move into the current status, else of `statuscategorychangedate`. A comment mentions you when it has a `mention` node with your account id. Errors are codes (`not_configured`, `http_401`, `timeout`, `network`, `bad_response`); they never carry a URL, header or token.
- **Calendar.** `ical.js` expands RRULE and EXDATE, and a RECURRENCE-ID override stands as its own event at its new time. Times are the server's local time; a `VTIMEZONE` in the feed is registered before reading. Cancelled events are skipped. All-day events read `00:00`–`24:00` and never count as booked. Events with the same title and start are merged across feeds and within one feed, sources combined, and one decline marks the merged event declined. Overlap is strict: back-to-back meetings don't overlap. A cancelled instance (STATUS:CANCELLED with a RECURRENCE-ID) removes its slot from the master. A feed's error is `feed_<index>_<http_NNN|timeout|network|parse>`, and `feed_<index>_unknown_tz` is a warning; the URL is never reported.
- **Capacity.** Booked time is the union of the non-declined timed meetings clipped to the window, so overlapping meetings count once.

## Wind down and Plan my day

**The pure parts** live in `packages/caius/src/daily/`:
- `meetingLines` and `overlapPairs` (`meetings.ts`) turn calendar events into the Meetings block's clock lines and the overlapping pairs.
- `readRhythm` and `sectionOf` (`standing.ts`) read the standing note's markdown.
- `layoutWork` (`blocks.ts`) places the main list in the free time.
- `dayCandidates`, `liveKeys` and `keysOf` (`candidates.ts`) hold the candidate rules.

`addContext` and `addContextLine` sit beside `setMeetings` in `daynote.ts`, and the brief's markup is built by `brief-html.ts`.

**Keys.** `keysOf` derives a task's keys the way `caius_add` and `caius_dismiss` do: its Jira keys and links, else a hash of its text. A candidate that was suggested and then dismissed therefore matches the `#caiusDismissed` label. A Jira candidate's key is its ticket key, which is what `caius_add` stores for `source`.

**The steps** are in `apps/server/src/services/caius/daily.ts`, behind two service entry points. Neither holds the lock across the network.
1. `dayRead` reads the Context in force (`gatherContext`) and the standing note under the lock.
2. It then calls `caius_inputs` outside the lock.
3. Each step reads the notes it needs under the lock again.

The lock is never taken twice by one call, since it isn't re-entrant.

**The inputs cache** lives in the service instance. Its key is the whole `caius_inputs` input (date, Context lines and the work window from the Rhythm), so an answer read without the Context's overrides is never reused for one that needs them. An entry lasts `INPUTS_TTL_MS` (15 minutes), timed on the real clock (`Date.now`, injectable), since the dev clock `CAIUS_NOW` stands still. An answer with an error that `isInputWarning` (`inputs/index.ts`) does not call a warning is not stored, so a failed source is tried again on the next call. `createCaiusService` and `createCaiusTools` take the inputs reader as an argument, as they do the weather fetcher, so specs stub `caius_inputs`.

**Lanes in the wind-down.** `open` works out lanes from noon of `date`, not from now, so a wind-down run the next morning still treats `date` as today.

**`caius_brief_write`** (`brief.ts`) finds the brief as the push script does: a child of the day note labelled `#morningBrief=<date>` without `#morningBriefPage` or `#morningBriefRevision`. It finds the header as the brief's child titled `Header`. `NoteStore` can neither create a child note nor set a label in place, so two helpers sit beside `putAttachment` in `store.ts`:
- `createChildNote` creates the note through `noteService.createNewNote`.
- `setLabel` sets a label through `BNote.setLabel`, so a re-run replaces `#caiusPlannedAt` instead of adding a second one.

Each runs in its own transaction. Content goes through the store's compare-and-swap. The sections go through `markdownImportService.renderToHtml`, as the note tools' markdown does. The drawing step is `drawHeader`, shared with `caius_header`. `withInclude` adds the include-note (`data-box-size="full"`, as the demo stores it) only when no include-note of the header is anywhere in the day note.

**Strings.** The questions, the reasons, the date line and the pick line are in the server catalogue under `caius.brief.*` and `caius.daily.*`. The `(until …)` suffix is not, because `parseContext` reads it back in English.

## Not done

- Pushing a task to its project note.
- The "Automatic" scheduled-fates switch.
- Editing a task's text or estimate in place. A write must change the one `<li>`, never round-trip the note through markdown.
- Following `<section class="include-note">`.
- A SQLite index; tools compute from live notes. Bring one back only if Journal-wide reads turn slow.
