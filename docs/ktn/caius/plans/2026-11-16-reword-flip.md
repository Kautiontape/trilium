# Plan: rewording and the day flip

Builds Parts 3 and 4 of `design/2026-11-16-subtasks-reword-flip.md` on branch `ktn-caius-reword-flip`, one PR
against `ktn`. Part 1 (`ktn-caius-catchup-fixes`) and Part 2 (`ktn-caius-nesting`) are other branches; they change
`daily.ts`, `apply.ts`, `plan-read.ts`, `plan-html.ts`, `tools.ts`, `schemas.ts`, the skill sheet and the phone's
Today, Plan and TaskRow. This branch keeps its edits to those files small and additive: new logic goes in new
modules, and the phone's Today button and Edit action are components of their own with one-line mounts.

Every task is test-first: the failing spec, then the code, then green. Tests run narrow (see each task). No
changelog entry or User Guide page: Caius is fork-only and its commits carry neither.

## Shape

### The day flip

- **One function.** `effectiveRollover(rollover, started, now)` in `packages/caius/src/workday.ts`: the rollover in
  minutes, or 0 when `started` (a `#caiusStarted` value, `YYYY-MM-DDTHH:mm:ss`) is dated on `now`'s calendar date
  and `now`'s clock is before `rollover`. Past the real rollover it returns the real one, so the label changes
  nothing. It takes the rollover as a number, as `workdayNow` and `workdayMinutes` do; the doc's sketch passed the
  Rhythm. The server and the phone both call it.
- **The server reads it once.** The service builds the Rhythm in one helper that reads the standing note and, only
  while the real clock is before the real rollover, the `#caiusStarted` label on the day note of the real calendar
  date. The Rhythm it hands on carries the effective rollover. `rolloverOf(read.rhythm)` in `apply.ts`,
  `day-read.ts` and `planFromOf` then follow with no edit, so the files the other workers change stay untouched.
  The rejected alternative, threading `started` through `DayFrame`/`DayRead` to every `rolloverOf` call, edits
  those files and lets a missed reader fall back to 04:00 silently.
- **The trap.** A `now` worked out with rollover 0 and read with 04:00 makes 03:00 Monday read 27:00: `planFrom`
  and the drawing's `notBefore` jump past the day's end. The integration tests check exactly that.
- **`caius_start_day`** writes the label on the real calendar date's note (never the next date), only between
  midnight and the rollover; `back: true` removes it. Status answers `rollover` (the effective one) and `started`.
- **The phone** re-reads the status on every refresh, keeps the Rhythm's real rollover for the Start/Back window,
  and feeds `dayMinutes` the effective one.

### Rewording

- **Pure transform** in a new `packages/caius/src/trilium/reword-html.ts`: replaces a task's words, keeps the rest.
- **Batch writer** in a new `packages/caius/src/trilium/reword.ts`, shaped like `setAreas`: one compare-and-swap
  per note.
- **Server:** `caius_reword`, and `rewords` on `/api/caius/apply` (which `/etapi/caius/apply` reuses).
- **Phone:** an Edit action on the task sheet, a held write with Undo in the notice, through `/etapi/caius/apply`.

## Rules for every task

- `packages/caius`: 2-space indent, single quotes. Everywhere else: 4 spaces, double quotes. Match the file.
- No `!` non-null assertion (the files around you use them; don't copy that), no `Array.prototype.forEach`.
  Helpers go below the export they serve. Comments in plain present tense naming real identifiers; never a
  comment about something removed.
- Invented people, tickets and hosts only (`Ana`, `ABC-12`, `https://jira.example.com/browse/ABC-12`). A bare
  `ABC-12` in task text is not a key (only the configured prefixes are), so a fixture's ticket is a `/browse/` link.
- Commit by explicit path with a fresh message file: `git commit -F <file> -- <paths>`. Subject
  `caius: <imperative outcome>`, a body that explains what and why, ending with `Assisted-by: Claude Code`.
- No git stash, `checkout --` or `restore`. No ESLint. No whole-package runs.

## Tasks

### 1. `effectiveRollover`

Files: `packages/caius/src/workday.ts`, `workday.spec.ts`, export from `packages/caius/src/index.ts`.

- `effectiveRollover(rollover: number, started: string | null | undefined, now: Date): number`.
- 0 only when `started` begins with `now`'s local `YYYY-MM-DD` and `now`'s clock (hours × 60 + minutes) is before
  `rollover`; otherwise `rollover`.
- Failing tests first: 00:00, 03:59, 04:00 and 05:00 on Mon 2026-11-16, each with no label, with a label dated
  2026-11-16, and with one dated 2026-11-15. Also a rollover of 0 (no window) and one of 03:00.
- Test: `cd packages/caius && pnpm exec vitest run src/workday.spec.ts`.
- Done: the matrix passes; the function is exported.

### 2. The server's clock goes through it

Files: `apps/server/src/services/caius/brief.ts` (a `STARTED_LABEL = "caiusStarted"` constant beside the other day
labels), `service.ts`, `apps/server/src/routes/api/caius.ts`, `day-boundary.integration.spec.ts`.

- One service helper, called under the lock, that reads the standing note and returns the Rhythm with its
  `rollover` set to `effectiveRollover(rolloverOf(rhythm), started, caiusNow())` as `HH:MM`, plus `started` and the
  workday `now`. It reads the label (`dayLabels(store, <real calendar date>, STARTED_LABEL)`) only when the real
  clock is before the real rollover.
- Use it in `dayRead` (lines ~200 and ~209: once, under the lock, both the `now` and the returned Rhythm),
  `dayFrame` (~229), `todayHeld` (~278), the status read (~352) and `briefWrite` (~638). `placeOf` reads only
  coordinates and stays.
- The status read becomes `{ rollover, started? }` (the effective rollover); the status route spreads it.
- Failing tests first, in `day-boundary.integration.spec.ts` (its standing note rolls over at 04:00, standup
  10:00), with the label added by hand on the Monday note:
  - Mon 03:00, no label: `caius_plan` is Sunday; status rollover `04:00`; `caius_planday` for Monday without
    `early` answers `not_today`.
  - Mon 03:00, label: `caius_plan` is Monday; status `rollover: "00:00"` and `started`; `caius_planday` for Monday
    needs no `early`; no `planFrom` (it would read `27:00` if a reader fell back to 04:00).
  - Mon 04:30 with the label: as without it.
  - Tue 01:00 with the label still on Monday's note: still Monday.
- Then `grep -n "rolloverOf(" apps/server/src/services/caius/*.ts`: every caller reads a Rhythm the helper built.
- Test: `cd apps/server && pnpm exec vitest run src/services/caius/day-boundary.integration.spec.ts
  src/routes/api/caius.spec.ts` ("reports Caius as enabled" fails before this work; leave it).
- Done: those tests pass; no `rolloverOf` caller reads a raw Rhythm.

### 3. `caius_start_day`

Files: `writes.ts` (beside `skipCatchupOn`), `schemas.ts`, `service.ts`, `tools.ts`, `tools.integration.spec.ts`
(the exact tool list at ~60), `day-boundary.integration.spec.ts`.

- Input `{ back?: boolean }`. The service op takes the lock, reads the real rollover (`rolloverOf` of the standing
  Rhythm, not the effective one) and calls the writer with `caiusNow()`.
- Start: between 00:00 and the real rollover, labels the day note of the real calendar date (made if missing)
  `#caiusStarted=<YYYY-MM-DDTHH:mm:ss>`; `unchanged` when any `caiusStarted` label is on it. A protected note is
  `bad_request`, as in `skipCatchupOn`. Outside the window it writes nothing: `skipped`, `not_small_hours`, with
  a `detail` naming the day that is today.
- Back: removes every `caiusStarted` label on that note; `updated`, or `unchanged` when there was none.
- Answers `status`, `date` (the day that is now today), its `dateLabel` (the steps' `dateLabel`), `noteId` and
  `created`.
- Description: one call, nothing to ask; "It's Monday now" after midnight.
- Failing tests first: start at Mon 03:00 → `updated`, the label's value, `caius_plan` is Monday; again →
  `unchanged`; `back: true` → Sunday again; Mon 05:00 and Sun 22:00 → `not_small_hours`, no label written; a
  missing Monday note is made. The tool list names `caius_start_day`.
- Test: `cd apps/server && pnpm exec vitest run src/services/caius/day-boundary.integration.spec.ts
  src/services/caius/tools.integration.spec.ts`.

### 4. The reword transform

Files: new `packages/caius/src/trilium/reword-html.ts` and `reword-html.spec.ts`.

- `rewordTask(html, id, text, states)` → `{ ok: true; html; unchanged; dropped: { text, href }[]; droppedKeys:
  string[] }` or `{ ok: false; reason: 'not_found' | 'not_live' | 'moved' | 'cancelled' | 'suggested' | 'empty' }`.
- What may be reworded: `itemState` open, doing or done. Rescheduled is `moved`, cancelled `cancelled`, other
  `not_live`; a task under a prose heading is `not_live`; one under Suggested is `suggested`.
- The words are what sits between the leading run (marker, then clock) and the tail. The tail starts at the first
  trail child of the description span (the "from …" link, `backLinkOf`, or an `<em>` holding "scheduled" and a
  `#root/` link) or at the trailing-token zone (`tokenZoneStartInHtml`, with `&nbsp;` masked as `setTaskEstimate`
  does), whichever comes first, less the whitespace before it. Everything outside the words is kept byte for byte:
  the `<li>` tag (id, state), the checkbox, the marker, the tail and the sub-items.
- The new words: trimmed; a leading marker and trailing tokens are taken off (the task keeps its own); nothing left
  is `empty`. A new leading clock replaces the old one; without one, the old clock stays.
- Links in the old words: each whose text appears in the new words wraps its first unclaimed occurrence, with its
  original open tag. The rest go in `dropped` with their text and `href`. Other markup in the words is not kept.
- `droppedKeys`: the Jira-shaped keys (`/^[A-Z][A-Z0-9]+-\d+$/`) of `taskKeys(text, hrefs)` on the old span that
  the new span lacks. Filtering to that shape leaves out the text hash `taskKeys` falls back to.
- The new words are escaped (`escapeHtml`); `unchanged` when the result equals the input.
- Failing tests first: marker, `~est`, from link and scheduled trail kept; clock kept, and replaced by a new one;
  id, state and checked box kept for a doing and a done task; sub-items untouched; a link kept on its text and one
  dropped; `droppedKeys` for a lost `/browse/ABC-12` link and none for a keyless task; `&` and `<` escaped;
  `&nbsp;` before the marker's words and the tokens; a leading marker and a trailing `~45m` in the new words
  stripped; each refusal; `unchanged`.
- Test: `cd packages/caius && pnpm exec vitest run src/trilium/reword-html.spec.ts`.

### 5. `rewordTasks` and `caius_reword`

Files: new `packages/caius/src/trilium/reword.ts` and `reword.spec.ts`; `plan.ts` (only `export` on the batch
helpers it needs, and `moved`, `cancelled`, `suggested` in `PlanSkip`); `index.ts`; server `schemas.ts`,
`service.ts`, `tools.ts`, `tools.integration.spec.ts`.

- `rewordTasks(api, reqs, opts)` as `setAreas` writes: the tasks of one note changed together and written once as
  a compare-and-swap, `edited` when the note changed, a dry run with the diff on the first. An updated result
  carries `dropped` and `droppedKeys` when either is non-empty. Each skip has a `detail` a person can read (the
  phone shows it): `moved` "a moved copy is history: reword the copy it was moved to", `suggested` "accept it
  first", `empty` as `bad_request`.
- Schema item `{ noteId, listItemId, text }` (`text` trimmed, at least one character, described as the new words
  only). `toolInputs.reword = writes(item)`, `routeInputs.reword = writes(item.safeExtend(version))`.
- Service op `reword`: the lock, `unlessStale`, `withBlobIds`, `presentResult`, as `setArea`. Tool `caius_reword`:
  replaces the words and keeps the id, state, marker, estimate, trail links and clock; reports dropped links and
  keys; refuses a moved copy.
- Failing tests first: the library spec on a fake store (batch, `edited`, dry run, skip details); the tool list;
  through the tool, a reword that keeps marker, estimate and from link, a dropped link and key, a moved source
  refused while its copy is reworded and the source keeps its words, and a stale `expectedBlobId` (the way the
  `caius_place` stale test calls it).
- Test: `cd packages/caius && pnpm exec vitest run src/trilium/reword.spec.ts`, then
  `cd apps/server && pnpm exec vitest run src/services/caius/tools.integration.spec.ts`.

### 6. `rewords` on the apply route

Files: `schemas.ts` (`routeInputs.apply`), `service.ts` (`apply`), `apps/server/src/routes/api/caius.spec.ts`, and
`apps/server/spec/etapi/caius-phone.spec.ts` if it has an apply test.

- `rewords: z.array(rewordItem).default([])`. Both refines count it; the first message becomes "Give at least one
  forward, drop or reword" (grep the specs for the old one first).
- `apply` tells the items apart by `"to"`, `"state"` and `"text"`, behind the one version check, results in the
  order the items went in (forwards, drops, rewords).
- Failing tests first: a POST with only `rewords` rewords the task; one with an `expectedBlobId` that no longer
  matches skips it as `stale`; an empty body still answers 400.
- Test: `cd apps/server && pnpm exec vitest run src/routes/api/caius.spec.ts` (and the etapi spec if touched).

### 7. The phone's day flip

Files: `apps/caius-app/src/lib/caius.ts`, `lib/store.ts`, `lib/day.ts`, new `components/DayFlip.tsx` (and its
spec), `screens/Today.tsx` (the mount and the `dayMinutes` calls), `screens/Chat.tsx` (~414).

- `CaiusStatus.started?`; `api().startDay(back?)` calls `caius_start_day`.
- `refreshToday` reads the status on every refresh, beside the catch-up and nudge; a non-null answer updates
  `serverStatus` (and the clock offset), a null one keeps the old. `TodayData.started` holds it.
- `dayMinutes(now, rhythm, started?)` reads `effectiveRollover`. `TodayData.rhythm` keeps the standing note's real
  rollover, which the Start/Back window needs. Every `dayMinutes` caller passes `started`.
- Pure `flipOffer(now, rhythm, started)` in `day.ts`: between 00:00 and the real rollover, `{ kind: "start", day }`
  (now's weekday name) without a valid label, `{ kind: "back", day }` (the day before's name) with one; else null.
- `DayFlip` shows **Start Monday now** or **Back to Sunday** from `flipOffer`, disabled offline; a tap runs
  `startDay` through `runWrite`, which reads Today again. One line mounts it in Today.
- `Chat.tsx`'s refresh regex gains `reword|start_day`.
- Failing tests first: `flipOffer` and `dayMinutes` at 00:30, 03:59 and 04:00 with and without a label;
  `DayFlip` renders Start at 03:00, Back with the label, nothing at 05:00 and 23:00, and a tap calls the tool; if
  Today renders in happy-dom from a fixture, at 03:00 with the label it shows Plan my day rather than Wind down.
- Test: `cd apps/caius-app && pnpm exec vitest run`.

### 8. The phone's Edit action

Files: `lib/caius.ts`, `lib/store.ts`, new `components/RewordSheet.tsx` (and its spec), `components/sheets.tsx`
(one `SheetAction`), `components/TaskRow.tsx` (one line).

- `api().reword(items)` POSTs `{ rewords: items }` to `/etapi/caius/apply` with the token; a non-200 is an
  `HttpError`.
- `holdReword(task, words, send)` in `store.ts`: the 4-second hold with Undo in the notice that `holdWrite` gives,
  sharing its one pending slot (a second held write, or opening a sheet, sends it), but never touching `held`,
  which marks a row not live and takes it out of Terrain and Now. A `rewording` signal holds the new words by task
  key until the write lands or is undone; `TaskRow` shows them meanwhile.
- `RewordSheet`: a text field holding only the words (`displayText(task.text).text`), Save disabled when empty or
  unchanged; Save closes the sheet and holds the write, notice `Edited: <words>`.
- The task sheet shows **Edit** for an open, doing or done task, online and not a suggestion.
- Failing tests first: the field holds the words without marker, clock, estimate or links' markup; Save sends one
  POST after the hold with `{ rewords: [{ noteId, listItemId, text }] }`; Undo sends nothing; the row shows the new
  words during the hold and stays live; Edit is absent on a suggestion and a cancelled task.
- Test: `cd apps/caius-app && pnpm exec vitest run`.

### 9. The skill sheet

File: `apps/server/src/assets/llm/caius/skill.md`. Two short rows in the tools table: `caius_reword` (change a
task's words with it, never by cancelling and adding again; say what `dropped` and `droppedKeys` name) and
`caius_start_day` ("It's Monday now" after midnight; one call). Keep both under about 400 characters together.

- Test: `cd apps/server && pnpm exec vitest run src/services/caius/register.spec.ts` (the 48,000 cap).

## Finish

- `pnpm typecheck` once, from the repo root.
- One quality review over the whole diff (`feature-dev:code-reviewer`, opus), fixes through an implementer.
- `git push -u origin ktn-caius-reword-flip`; `gh pr create --repo Kautiontape/trilium --base ktn` with the body
  grouped by area from the commit bodies.
- Report to `caius-2d`.
