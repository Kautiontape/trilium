# Plan: the desktop Plan tab's day flip and "N open"

Two gaps the sub-tasks and day-flip work (`design/2026-11-16-subtasks-reword-flip.md`, Parts 2 and 4) left in the
desktop Plan tab. One PR against `ktn` from `ktn-caius-desktop-plan`. Both are client-only: `/api/caius/plan`
already sends what task 2 needs (below), and task 1 reuses `/api/caius/status`.

Every task is test-first: the failing spec, a red run, the code, a green run. Each task is one commit
(`caius: …`) by explicit path, with its line of `docs/ktn/caius/README.md`. No changelog entry or User Guide page:
Caius is fork-only. The tasks run one after another, since both edit `PlanTab.spec.tsx`.

Tests: `cd apps/client && pnpm exec vitest run src/widgets/sidebar/plan src/services/caius.spec.ts`.

## T1 · The Plan tab follows a day flip without a reload

**Why it is stale.** `services/caius.ts` reads the status once per session (`isCaiusEnabled()` →
`fetchStatus()`), and keeps `rolloverMinutes` and `started` from it. "Start Monday now" on the phone (or
`caius_start_day`) writes `#caiusStarted` on Monday's day note; the desktop gets that row over the WebSocket, but
nothing asks for the status again, so `caiusNow()` stays on Sunday. The tab sets its period only when the active
note changes.

**Files.** `apps/client/src/services/caius.ts`, `caius.spec.ts`; `apps/client/src/widgets/sidebar/plan/PlanTab.tsx`,
`PlanTab.spec.tsx`; `docs/ktn/caius/README.md` (the Plan tab paragraph, line 62).

**Change.**
- `caius.ts` gains two exports:
  - `movesCaiusClock(loadResults)`: true when an attribute row is named `caiusStarted` (set or deleted, on any
    note: Monday's note may be new, so froca need not hold it), or `assistantContext` (the standing note's label),
    or when a changed note (`getNoteIds()`) is one froca holds with an owned `#assistantContext` label, since the
    standing note's Rhythm holds the rollover. Don't filter on `isDeleted`: a deleted `caiusStarted` row is
    "Back to Sunday".
  - `refreshCaiusClock()`: forgets the status and asks again (`forgetCaiusStatus()`, then `isCaiusEnabled()`),
    resolving once `caiusNow()` follows the new answer.
- `PlanTab` listens to `entitiesReloaded` (the tab already does, in `usePlanData`; this one goes in `PlanTab`,
  which owns `period`). On `movesCaiusClock`, it notes `periodOfNote(note, caiusNow())` before, awaits
  `refreshCaiusClock()`, and works it out again. A tab showing the period it had worked out (it follows the note)
  moves to the new one; a tab the user stepped elsewhere keeps its period but re-renders, so the Today badge,
  Pull in and Close read the new `caiusNow()`. The plan data reloads through the period key, as now.
- No timer. Past the real rollover a started night changes nothing (Monday either way), and later nights read
  right from the cached `rhythmRollover`; `caius.spec.ts` "keeps the standing rollover while a started night
  counts, and ends it with the night" covers that.

**Tests first.**
- `caius.spec.ts`:
  - `movesCaiusClock`: a `caiusStarted` row, set and deleted, on a note froca doesn't hold → true; an
    `assistantContext` row → true; a note row of a froca note with `#assistantContext` → true; a `caiusFocus`
    row or another note's row → false.
  - `refreshCaiusClock`: status at 01:30 without `started` gives the day before; after a refresh whose answer
    carries `rollover: "00:00"`, `started` and `rhythmRollover: "04:00"`, `caiusNow()` is the calendar day; after
    one without them again ("Back to Sunday"), the day before. Assert the status was fetched three times.
- `PlanTab.spec.tsx`. The spec mocks `isCaiusEnabled`, so the real `fetchStatus` never runs there: mock
  `refreshCaiusClock` (hoisted `vi.fn`) and make `caiusNow`/`caiusClockMinutes` read a hoisted clock that the
  mock sets, falling back to the originals so the other tests are untouched. Drive the event through
  `mountInPane(true).caiusWrote(...)` with a `caiusStarted` attribute row.
  - With a non-Journal active note at 2026-10-28 02:00, the tab shows 2026-10-27; after the flip row it shows
    2026-10-28 and has read the plan for it; after a deleted row and a clock back on the 27th, 2026-10-27 again.
  - With the 2026-10-27 day note active, the flip keeps 2026-10-27 (the tab follows its note) and the bar
    re-renders: the "current" badge gives way to the Today button.
  - A row with another label refreshes nothing (`refreshCaiusClock` not called).

**Done.** Specs green, each new assertion seen failing first. README line 62 says the tab follows a day started
early, or taken back, at once.

## T2 · "N open" on a ticked parent in On deck

**Why it is missing.** Not the data: `buildPlanView` (`packages/caius/src/trilium/plan-read.ts`) returns
`onDeck: deck.map(strip)`, every state, so a done parent and its sub-items reach the client. The view drops it:
`onDeckTasks` is `topLevelOf(...).filter(isLive)`, which removes the done parent and lifts its open sub-items to
loose rows. `subItemCount` already says "N open" for a done parent, but never gets one. The server's `rowsOf`
(views) is not on this path.

**Files.** `apps/client/src/widgets/sidebar/plan/plan_logic.ts` (`onDeckTasks`), `plan_logic.spec.ts`;
`PlanOnDeck.tsx`, `PlanOnDeck.css`; `PlanTab.spec.tsx`; `docs/ktn/caius/README.md` (the On deck bullet, line 66).

**Change.**
- `onDeckTasks(plan)` lists, in order: a parent when it is live, or done with at least one live sub-item (the
  design's "Done parent, open sub-items"); a live task with no parent; and a live sub-item whose parent is
  neither of those (for instance cancelled), as a loose row. A sub-item of a listed parent sits under it, never
  loose. This reverses the `topLevelOf` choice of 9c06fbf799 for a done parent only.
- `PlanOnDeck` draws a done parent like any parent (`subItemCount` gives "2 open"), with its words struck
  through as a done sub-item's are. The chevron opens its sub-items as now.
- Close is unchanged on purpose: a done parent is no close candidate, and each open sub-item needs its own fate,
  so `closeCandidates` still lists them.

**Tests first.**
- `plan_logic.spec.ts`: rewrite "keeps a done parent's open sub-item in On deck" (it asserts `["p2", "p3"]`, the
  old rule) to `["p"]`; add a done parent whose sub-items are all done or cancelled (not listed) and a cancelled
  parent with a live sub-item (the sub-item is listed, loose).
- `PlanTab.spec.tsx`: a done On deck parent with two of three sub-items open is one row reading "2 open", struck
  through, no loose sub-item rows; the chevron lists its sub-items.

**Done.** Specs green, each new assertion seen failing first. README's On deck bullet names the done parent's
"N open".

## Finish

`pnpm typecheck` once from the root; push; PR against `ktn` with `--repo Kautiontape/trilium`; report to
`caius-2d`.
