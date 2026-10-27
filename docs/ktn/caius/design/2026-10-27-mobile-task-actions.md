> Copied from the caius repo on 2026-10-27. It is historical: where it differs from the code in this fork, the code is authoritative.

# Spike B report: task actions in the mobile layout

**Status:** DONE_WITH_CONCERNS (concerns: long-press could not be reproduced as a real OS gesture in headless Chromium; answer 3 rests on a code reading plus two Playwright observations. Concerns on list item ids are in Q2.)

Setup: dev server from this worktree on 8092 (`TRILIUM_GENERAL_NOAUTHENTICATION=true`, fixture `document.db` copied into the gitignored `apps/server/data`), headless Chromium driven by `playwright` with the `Pixel 7` profile (touch on) and cookie `trilium-device=mobile`. Scripts: `.caius-task/spike{1..4}.mjs`. Never touched 8080/8091 or the yuffie host. Server stopped; nothing committed.

How the client picks the mobile layout: `?mobile` URL param, then the `trilium-device` cookie, then `(pointer:coarse)`/UA (`apps/client/src/index.ts:97-111`; server mirror `apps/server/src/routes/index.ts:198-235`). The `Pixel 7` profile alone also yields `glob.device === "mobile"`.

## 1. Toolbar hook

- Mobile toolbar component: `apps/client/src/widgets/type_widgets/text/mobile_editor_toolbar.tsx`. It mounts the CKEditor toolbar element into a div on every `textEditorRefreshed` event (`:33-53`) and has the live `editor` right there.
- `b4f06c88e9` adds `list_context_toolbar.ts`, called at `mobile_editor_toolbar.tsx:41-46` (`attachListContextToolbar(editor, { onPinned })`, detached on the next refresh and on unmount at `:71`). It subscribes to `editor.model.document.on("change", update)` (`list_context_toolbar.ts:82`), tests `isSelectionInList` (`:102-108`, `block.hasAttribute("listItemId")` over `selection.getSelectedBlocks()`), then `toolbar.items.add(view, index)` / `remove` (`:59-69`). Views come from `editor.ui.componentFactory.create(name)` (`:49`), with a class stamped via `extendTemplate` before first render (`:51`), and `onPinned` scrolls the bar to its start.
- So yes: `editor.model.document.selection` is reachable, and the show/hide-on-selection mechanism already exists and is tested (`list_context_toolbar.spec.ts`).
- Hook for a Task button: generalise `list_context_toolbar.ts` (or add a sibling next to line 82) with a second predicate `isSelectionInTodo` (first selected block has `listType === "todo"`), and a custom view (a `ButtonView` registered in the component factory, or created inline) pinned at index 0 when true. Wire it at `mobile_editor_toolbar.tsx:44` beside the existing call. Evidence it works as a pin target: in Playwright, tapping a todo item gave `.tn-list-context-pinned` count 2 (outdent+indent), and 0 after tapping the outro paragraph (spike2 output).
- Note the list pinning fires for any list, so Task must test `listType === "todo"` (bulleted items also carry `listItemId`).

## 2. Identify the item

Proof (`spike2.mjs`, tap into "Task two" in the mobile layout):

```
isInTodo: true, listType: "todo",
listItemId: "ebb84b49f43bd3d36df56d7b16d93ef6f",
domIds (all li[data-list-item-id]): [..."e88f72…", "ebb84b…"],   // 2nd one equals the model id
noteIdFromHash: "bZ1SOq5n6mp4"   // location.hash "#root/<noteId>?ntxId=…"
```

In code: `const block = editor.model.document.selection.getFirstPosition().parent; block.getAttribute("listItemId")`; the editable is reachable as `el.ckeditorInstance` for a throwaway probe. In real code use `noteContext.noteId` (the toolbar already has `useNoteContext()` at `mobile_editor_toolbar.tsx:22`) rather than the hash.

**Concern: id stability.** `editor.getData()` does emit `data-list-item-id` (`spike3.mjs`), so ids are saved with the note and survive reload once stored (`spike4.mjs`: id `aaa111` PUT into the note came back as `aaa111` after two reloads). But content that has never been saved by the editor has no ids: reloading my API-created note regenerated different ids each load (`ids1` vs `ids2` in spike3). Implications for `/api/caius/*`:
- The id the client reads from the editor model may not exist in the stored HTML yet (unsaved edit, autosave delay, or first open of an old note). The server then cannot find the `<li>`. The client must flush/save the editor (or the route must accept content) before calling, and the route must return a clear "item not found" for a miss.
- Also, after the server rewrites the note HTML, the open editor must reload it (it does via froca/ws content refresh, but I did not test round-tripping while the editor holds a dirty buffer).

## 3. Context menu on mobile

Almost certainly **no custom menu on mobile**; the right-click menu cannot double as the mobile UI.
- Code: `setupBrowserContextMenu()` (the `contextmenu` listener in `apps/client/src/menus/note_context_menu.ts:53-91`) is installed only in `apps/client/src/desktop.ts:62-65`. `mobile.ts` never imports it (grep of `ContextMenu|setup` in `mobile.ts` finds nothing relevant).
- Even on desktop the handler returns early unless there is a non-empty text selection and the pointer is inside it (`note_context_menu.ts:~66-79`), and a bare caret keeps the native menu, so a todo item with a caret would not trigger it anyway.
- Playwright (`spike2.mjs`): a CDP touch long-press (1.2 s) on a todo item produced **no `contextmenu` event at all** and no selection under headless Chromium's touch emulation (`longpress: {"events":[],"sel":"","menus":0}`, `04-longpress.png`); that is a limit of the emulation, not proof of real Android behaviour. A synthetic `contextmenu` event dispatched over a selected todo item reached the document but opened no Trilium menu (`synthetic: events:[{prevented:false}], menus:0`, `05-synthetic-contextmenu.png`), consistent with the missing listener. Real device long-press would give the native selection handles/toolbar.

## 4. Sheet component to reuse

Two candidates, both existing:
- **`ContextMenu` (`apps/client/src/menus/context_menu.ts`)**: on mobile it already renders as a bottom sheet over a cover (`mobile-bottom-menu` class, `context_menu.ts:118`; option `forcePositionOnMobile` to anchor instead, `:16`), handles submenus on mobile by drill-in (`:392`), and takes the same `MenuItem[]` structure the desktop editor menu builds. **Best fit**: build one `MenuItem[]` for task actions and show it from either surface (`contextMenu.show({ x, y, items, selectMenuItemHandler })`), so Forward ▸ submenus and Drop… reuse one definition. `mobile_detail_menu.tsx` is an existing mobile user of this family.
- **`Dropdown` with `mobileBottomSheet`** (`widgets/react/Dropdown.tsx:76`, `:92`): the Preact route if the Task button is a Preact component; its docs say prefer it to hand-placed menus. Not directly usable from a CKEditor `ButtonView` without a React host, so for a toolbar button the `ContextMenu` singleton is simpler.
- `Modal` has `isFullPageOnMobile` (`Modal.tsx:101`) for the Drop…/Why-is-this-here confirmations and explanations.

## 5. Which mobile client

- **Server-served mobile layout** (phone browser at the server URL, what I tested): `/api/caius/*` routes on the server work normally.
- **`apps/mobile`** is Capacitor around the standalone build (`apps/mobile/package.json:4,9`): no server; core runs in a Web Worker and the client calls it through `standaloneApi.localFetch` / `local-bridge.ts`. Its router (`apps/standalone/src/lightweight/browser_routes.ts:309-311`) registers only `buildSharedApiRoutes` from core plus a few extras; server-only routes (`apps/server/src/routes/routes.ts`) do not exist and an unregistered path gets the router's own 404 (`browser_routes.ts:466`).
- Meaning: a Task button that calls `/api/caius/*` would show in the Capacitor app but every action would 404. Options without building anything now: (a) put the Caius logic in `packages/trilium-core` and register it in `buildSharedApiRoutes` so all three runtimes get it (and keep it free of Node built-ins per CLAUDE.md); (b) accept server-only and hide the button when the backend lacks the route (feature-detect, or gate on `isMobileApp()`/standalone); (c) leave Capacitor out of scope for v1. Which client Shawn actually uses on the phone decides this (I could not determine it from the repo).

## Recommendation

- **Task button**: extend the `list_context_toolbar.ts` pattern with a todo-only pinned button, hooked from `mobile_editor_toolbar.tsx:44`, shown while `listType === "todo"` for the first selected block. It should call the same action-building function the desktop right-click menu uses and present it through the `ContextMenu` bottom sheet.
- **One shared action list**: factor the Caius `MenuItem[]` builder so desktop (right-click, inside `buildNoteContextMenuItems`) and mobile (toolbar button) both consume it; the mobile layout has no right-click path at all.
- **Design changes**: (1) the action payload must tolerate ids not yet in stored HTML — save the editor before calling and handle "not found"; (2) decide server-only vs core-shared for `/api/caius/*` now, because it determines whether Capacitor works; (3) on desktop the right-click menu only opens with a text selection under the pointer (`note_context_menu.ts`), so Caius items need either that to be relaxed for todo items or a second entry point (toolbar/keyboard) there too.

## Surprising

- `getData()` emits `data-list-item-id` but a never-edited note has none, so ids only become stable after the first editor save (Q2).
- The browser context-menu hook is desktop-only and selection-gated, so even desktop right-click on a bare caret in a todo item opens the native menu.
- Chromium's installed Playwright build here (1234) differs from the one `playwright` expects (1243); I launched via `executablePath`. `pkill -f`/`pgrep -f` patterns matched my own shell in this environment, so I killed by PID/cwd instead (the editor-spike worker's server on 8091 is untouched).
- Screenshots: `.caius-task/02-note.png`, `03-in-todo.png`, `04-longpress.png`, `05-synthetic-contextmenu.png`, `06-toolbar-pinned.png`.
