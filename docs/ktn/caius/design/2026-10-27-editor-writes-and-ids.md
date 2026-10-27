> Copied from the caius repo on 2026-10-27. It is historical: where it differs from the code in this fork, the code is authoritative.

# Spike A report: server-side writes vs the open editor, and list-item ids

**Status:** DONE_WITH_CONCERNS

The write rule as written ("flush the open editor, then write on the server, then let sync reload the editor") does **not** hold as written. It holds only with the four changes listed under the recommendation. The most serious problems:

- The "save now" hook returns before the save happens.
- The client save path has no version check, so a pending save can silently overwrite a Caius write (case b1).
- A server write while the user is typing silently loses keystrokes, and later keystrokes land at the **start of the document** (case d).

Q2 is mostly good news: server-assigned ids survive the editor, but the editor invents random ids for any item without one.

## Setup (what was run)

- Dev server from this worktree: `TRILIUM_PORT=8091 pnpm server:start`, with Vite HMR on 8101. The data dir is `apps/server/data` (gitignored, a fresh throwaway DB created with `POST /api/setup/new-document?skipDemoDb`).
- **`noAuthentication=true` was set in the throwaway `apps/server/data/config.ini`**, so I used ETAPI without a token (`etapi_utils.ts:48` honours it) instead of creating one.
- Nothing touched 8080, 8092 or `trilium.yuffie.ts.net`.
- Headless Playwright 1.63 drove the existing `~/.cache/ms-playwright/chromium_headless_shell-1234` through `executablePath`, because the revision 1243 browser is not installed. Shawn's Chrome was not used.
- Fidelity caveat: the spike's read-modify-write was two HTTP calls (an ETAPI GET and a PUT) about 2 ms apart, not one transaction as in the design. No outcome depended on that gap.
- All server writes are ETAPI `PUT /etapi/notes/:id/content`, which runs `note.setContent()` (`apps/server/src/etapi/notes.ts:150-162`), the same becca path Caius would use. Every Q1 write is a **read-modify-write**: ETAPI GET, change the text of one task, then PUT.
- Scripts:
  - `.caius-task/spike.mjs`: modes `q1`, `q1e` and `q2`.
  - `.caius-task/diag-open-save.mjs`: logs every CKEditor `change:data` with a stack, from editor construction onwards.
- Logs: `spike-log-*.txt` and `spike-results-*.json`. Diagnostics: `diag-*.txt`. Stored HTML: `q1-*-stored.html` and `q2*.html`. Screenshots: `q1-*.png` and `q2.png`.
- The test notes are a `<p>marker</p>`, the sample todo list under `<h2>Morning</h2>`, and 60 filler paragraphs. The caret sits at the end of "Filler paragraph 30" with the note scrolled to `scrollTop` 1168.

## Q1: does the open editor survive a server-side rewrite?

### Timing facts that shape the cases

- `SpacedUpdate` (`apps/client/src/services/spaced_update.ts`) uses a 1000 ms interval measured from the *last snapshot*, not the last keystroke (`:174`). After an idle period, the first keystroke saves after about 1 ms. While typing continues, the drain loop (`:265-266`, `while (true)`) keeps saving back to back. A real pending window of about 1 s therefore opens only once a drain has finished. The script types `TYPED-A`, waits for its PUT, then types `TYPED-B`, which stays pending.
- A server write reaches the editor through WS `frontend-update`, then `useNoteBlob` (`apps/client/src/widgets/react/hooks.tsx:846-858`). `isNoteContentReloaded(noteId, componentId)` (`load_results.ts:201-206`) is true because an ETAPI write carries no componentId. The blob is refetched, then `useEditorSpacedUpdate` (`hooks.tsx:172-178`) runs `spacedUpdate.allowUpdateWithoutChange(() => onContentChange(blob.content))`, and that calls `editor.setData(newContent)` (`apps/client/src/widgets/type_widgets/text/EditableText.tsx:75-82`).
- `allowUpdateWithoutChange` (`spaced_update.ts:155`) only suppresses *new* `scheduleUpdate()` calls during `setData`. It does **not** clear an already pending `changed` flag or the armed timer. It also does not merge anything: `setData` replaces the whole model.
- The client save, `PUT /api/notes/:id/data` (`hooks.tsx:133-143`, then `packages/trilium-core/src/services/notes.ts:1082-1093`), sends no base version, and the server writes it unconditionally. Last write wins.
- Server write to editor showing it: **27-65 ms** on localhost in every case.

### Results

| Case | What happened | Editor shows server content? | Typed edits | Final stored content | Conflict UI | Cursor / scroll |
|---|---|---|---|---|---|---|
| **(a)** no pending edits | Server RMW, then reload after 27-65 ms, then an **echo save** of the same content about 65 ms later (see the TOC note under "Surprising findings") | Yes | none | Server content (`q1-a-stored.html`: `Write the report ~30m [server-a]`) | None | **Selection reset to the start of the document** (`[33,42]` became `[0,0]`). `scrollTop` kept (1168 to 1168). Focus kept. |
| **(b1)** pending edit, server write lands while the client save is in flight (user still typing) | ETAPI GET saw TYPED-A only. The ETAPI PUT committed at 6797 ms. The client's PUT `{TYPED-A,TYPED-B}` committed at 6808 ms and **overwrote it**. The blob refetch then returned the client's content. | **No**: the server write is gone | kept | **Server write lost** (`q1-b1-stored.html` has no `[server-b1]`) | None | Selection still reset to `[0,0]`, because `setData` ran with the client's own content. Scroll kept. |
| **(b2)** pending edit (about 800 ms old), then server write | ETAPI GET saw `TYPED-A T` (the drain had caught " T"). The server write committed, and the editor reloaded after 27 ms. The pending timer then fired and saved `getData()`, which by then was the *server* content. | Yes | **Lost silently**: "YPED-B" is gone from the editor and the DB (`q1-b2-stored.html`: `...amet. TYPED-A T`) | Server content plus the part already saved | None. The header says "Saved" (`q1-b2.png`). | Selection `[0,0]`. Scroll kept. |
| **(c)** pending edit, `triggerCommand("saveNoteDetailNow")`, wait for the PUT, then server RMW | `triggerCommand` **resolved after 2 ms with `undefined`, before the PUT finished** (0 responses at resolve). The script had to wait for the PUT response itself. Then the server RMW, reload after 29 ms, and an echo save. | Yes | Kept (`TYPED-A TYPED-B` and `[server-c]` both stored) | Correct merge | None | Selection `[0,0]`. Scroll kept. |
| **(d)** idle, server RMW, user types `" TYPED-GAP"` during the write-to-reload gap | " T" was typed before the reload and wiped by `setData`. The remaining keystrokes went to the **reset caret at the start of the document**. | Yes | **Corrupted**: stored first paragraph is `YPED-GAPQ1-d-note` (`q1-d-stored.html`) | Server content plus the misplaced text | None | Caret at the start of the document. |
| **(e)** two server RMWs 0/20/60/150/400 ms apart, editor idle | Each reload triggers an echo save. In every run the echo carried only what the editor had already reloaded. | Yes, both | n/a | Both writes kept for every gap tested | None | n/a |

Script excerpt (case c, the flush):

```js
const comp = glob.getComponentByEl(window.__ed().editing.view.getDomRoot());   // same lookup as cuttonote.ts:61-64
const r = await comp.triggerCommand("saveNoteDetailNow");   // resolves after about 2 ms, before the PUT
await waitForPutResponse(page, record, n + 1);              // the wait the hook should provide
const cur = await getContent(noteId);                       // ETAPI GET
await putContent(noteId, cur.replace("Write the report ~30m", "Write the report ~30m [server-c]"));
```

Log excerpt (b2, `spike-log-q1.txt`):

```
[  6883ms] TYPED-B typed (pending)
[  7685ms] ETAPI GET content: has TYPED-A=true TYPED-B=false
[  7687ms] ETAPI PUT content done
[  7690ms] CLIENT GET /api/notes/87y87XWw5Zky/blob
[  7712ms] editor shows server content (+27ms after ETAPI PUT start)
[  7810ms] CLIENT PUT data → markers in body: {[server-b2],TYPED-A}      <- TYPED-B never saved
```

Q2 also produced incidental evidence of (b2) inside the list itself. A `" z"` typed into the "Write the report" `<li>` was pending when a server write landed. It vanished, and the client saved the server's content.

## Q2: do todo items without `data-list-item-id` get one?

Seed: the sample list with the two `data-list-item-id` attributes removed (`q2-0-seed.html`). Results:

| Step | Note with `<h2>` (Q2) | Note without a heading (Q2b) |
|---|---|---|
| Open, change nothing | **An automatic save happens** about 1.5 s after load. The stored HTML now has ids (`q2-1-after-open.html`). | **No save.** Stored ids `[null,null]`. The live editor shows random ids. |
| Reload, change nothing | Live ids equal the stored ones (stable). It saves again (the same content). | Live ids are **different** from the previous load: fresh random ids every load, still nothing stored. |
| Trivial edit, save | The stored ids equal the live ids and stay the same through a reload and a second edit (`q2-2…`, `q2-3…`). | The ids current in the editor get stored (`q2b-after-edit.html`) and are stable from then on. |
| Server write that keeps the ids, then an edit inside the `<li>` | The ids are kept (`q2-4…`). | n/a |
| Server write that **removes** the ids while the note is open | The editor reload assigns **new** ids (`e8760a…`, `e0cb14…`) and the echo save stores them. The old ids are gone. | n/a |

- **Server-assigned ids are respected.** Every Q1 note was seeded with the sample ids (`e0123…`, `efedcb…`), and they survived every editor save unchanged.
- **The `data-trilium-task-state="doing" title="Doing"` attributes round-trip** intact.
- **The editor normalizes the HTML.** The seed's newlines and indentation are stripped, and `data-list-item-id` is emitted first on the `<li>`, before the other attributes. Compare `q2-0-seed.html` with `q2-1-after-open.html`. Caius must parse the HTML, not string-match it.

Where the ids come from (`node_modules/@ckeditor/ckeditor5-list/dist/index.js`, v48.5.1):

- `:1979`, upcast `listItemUpcastConverter`: `data.viewItem.getAttribute("data-list-item-id") || ListItemUid.next()`. A missing id gets a random one on **every** load.
- `:230-238`, `ListItemUid.next()` returns `uid()`: `"e"` followed by 32 hex characters.
- `:1885-1915`, `fixListItemIds` post-fixer: it regenerates an id **only when it is a duplicate**, for example after copy-paste or a split.
- `:2721-2727`, `_setupListItemIdConversionStrategy` (registered at `:2459`): downcasts `listItemId` to `data-list-item-id` in both pipelines, but skips it for the clipboard (`isClipboardPipeline` / `skipListItemIds`). Pasted items therefore get new ids.
- The fork has no config of its own for this. Its plugins only *read* the attribute (`packages/ckeditor5/src/plugins/todo_list_multistate/todo_list_multistate_editing.ts:327,383,459-467`).

## Surprising findings

1. **Opening any text note that has a heading saves it** (no edit needed), and every server-side reload of such a note echoes a save back. The cause is the right-panel table of contents. `extractTocFromTextEditor` writes a `tocId` model attribute on each heading inside `textEditor.model.change()` (`apps/client/src/widgets/sidebar/TableOfContents.tsx:336`, `writer.setAttribute(TOC_ID, …)` at `:359`). That is an undoable `change:data`, so it reaches `onChange={() => spacedUpdate.scheduleUpdate()}` (`EditableText.tsx:488`, wired at `CKEditorWithWatchdog.tsx:389-393`). The stack is in `diag-noids.txt`. A note with no heading does not save on open (`diag-plain.txt`). This is upstream code (blame: Elian Doran), not fork-specific. Consequences:
   - Journal day notes (which have headings) get their missing ids persisted just by being opened with the TOC panel showing.
   - Each Caius write to an open note costs a second write (and possibly a revision) from the client.
   - The echo is a small extra race window for a server write that lands between the echo's `getData()` and its PUT. Case (e) could not make it lose data on localhost.
2. **`saveNoteDetailNow` cannot be awaited.** `EditableText.tsx:254-257`: `async saveNoteDetailNowCommand() { spacedUpdate.updateNowIfNecessary(); }` neither returns nor awaits the promise. `Component.callMethod` (`apps/client/src/components/component.ts:137-144`) returns whatever the handler returns, so `triggerCommand` resolves at once. `cuttonote.ts:58` already `await`s it as if it waited.
3. **Every content reload moves the caret to the start of the document**, even when the content is unchanged (b1). `onContentChange` calls `editor.setData()` without saving and restoring the selection (`EditableText.tsx:82`). The scroll position survives, so the user sees no jump, but the next keystroke goes to the top of the note (case d).
4. No conflict UI or toast appears in any case. The save indicator shows "Saved" throughout.

## Recommendation

The design's write rule does not hold as written. These are the smallest changes that make it safe for Caius-initiated writes from the client, in priority order:

1. **Make the flush awaitable** (one line). At `EditableText.tsx:254-257`, `return spacedUpdate.updateNowIfNecessary();` (or `await` it). `Component.callMethod` returns the handler's promise (`component.ts:137-144`), so after this change `await …triggerCommand("saveNoteDetailNow")` waits for the PUT. *I read this from the code but did not run it; the spike waited for the PUT response itself.*
2. **Block input from the flush until the reload lands.** Use `editor.enableReadOnlyMode("caius-write")` from just before the flush until the editor has reloaded that note's new content, then `disableReadOnlyMode`. Together with #1, this closes b1, b2 and d **for the editor that started the action**:
   - Nothing is pending when the server reads, so b1 has no stale save in flight and b2 has nothing to lose.
   - Nothing can be typed between the server write and the reload, so d cannot happen.
   - The server already reads, transforms and writes inside one `sql.transactional`, so it always transforms the latest content. That makes an optimistic version check on the Caius endpoint unnecessary: it runs before its own write and could never reject a client save that commits later, as in b1.
3. **Flush and lock every editor showing the note, not only the active one.** Each tab and split has its own type widget and its own `SpacedUpdate`. The runs showed restored background tabs keeping live editors. The flush and the read-only window must therefore cover every note context whose note is the target, for example by iterating `appContext.tabManager.getNoteContexts()` and running `executeWithTextEditor` per `ntxId`. **Not tested.**
4. **Preserve the selection across a reload of the same note** (a small fork change in `onContentChange`, `EditableText.tsx:75-82`). When `note.noteId` is unchanged, record the model selection path before `setData` and restore it clamped afterwards. Without it, every Caius write throws the caret to the top of the note.

**What stays exposed:**

- Any editor that the flush in #3 did not reach, such as one in another browser window or on another device, stays exposed to b1 (its later save overwrites the Caius write) and b2 (its pending keystrokes are dropped). The same is true for Caius writes with no client involved (scheduled jobs, MCP).
- The cause is that `PUT /api/notes/:id/data` (`hooks.tsx:139` to `notes.ts:1082`) carries no base version and always wins. That is Trilium's existing sync behaviour. Closing it would mean sending a base `blobId` with that PUT and rejecting stale saves, which is an upstream-wide change and out of scope for Caius. Caius can lower the risk by routing anything that touches today's note through the "user clicked in Caius" path.

**On ids (Q2):** do not rely on the editor to create ids. **Caius should assign ids on the server** to every todo `<li>` that lacks one, in the same format (`"e"` + 32 hex) and in the same transaction as its write, and run a one-off backfill over the 87 Journal tasks that have none. CKEditor keeps existing ids (`index.js:1979`) and replaces only duplicates (`:1885`). Caius must still treat an id as changeable when an item is duplicated or pasted (clipboard downcast skips ids, `:2725`). Never write an `<li>` without its id while the note may be open: the editor gives it a new random id and, for notes with headings, saves that back within about a second.

Optional, upstream-worthy: stop `TableOfContents.tsx` from writing `tocId` into the model (keep a `WeakMap<ModelElement, string>` instead), so that opening a note never saves it.

## Clean-up

The dev server (8091 / 8101) and all browsers are stopped; both ports are free. `noAuthentication` is set back to `false` in the throwaway config. Nothing was committed, and `git status --porcelain` is empty. The only other changes are in gitignored paths: the throwaway `apps/server/data/` and the repo-level `.cache/vite-8091`. `.caius-task/` is excluded in `.git/info/exclude`.
