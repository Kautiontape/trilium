# Plan: three small server fixes

One PR against `ktn` from `ktn-caius-server-fixes`. Every task is test-first: the failing test, a red run, the code,
a green run. Each task is one commit (`caius: …`), by explicit path, with its own lines of `docs/ktn/caius/README.md`
when it changes what the README describes.

Order: T2 and T3 both edit `apps/server/src/services/caius/apply.ts`, and the server suite shares one database, so
the three tasks run one after another: T1, T2, T3.

Suite for every task: `cd apps/server && pnpm exec vitest run src/services/caius src/routes/api/caius.spec.ts`.
`routes/api/caius.spec.ts` "reports Caius as enabled" fails before this work; leave it.

## T1 · A single weekday name places a Context line on that day

**Cause.** `weekPlace(text, date)` (`apps/server/src/services/caius/writes.ts`) reads weekday ranges, "next week",
"this week", "until …", ticket keys and states. A single weekday name is never read, so "Ana is out Tuesday", given on
Monday, is a state line: this week's note, `until: date`. It shows on Monday and lapses before Tuesday.

**Rule** (the manager's default). A Context line that names exactly one weekday is placed on that day: `from` and
`until` both that date, in the week of `date`, or next week's when that day is already before `date`. "next Tuesday"
is the Tuesday of the following week. The rule runs after the range, "next week", "this week/all week" and "until"
rules, and before the ticket-key and state rules, so "ABC-12 ships Tuesday" goes to Tuesday. Clock times and "today"
still return null first.

What counts as a weekday name: a full name in any case (`tuesday`), or an abbreviation with a capital
(`Tue`, `Tues`, `Thu`, `Thur`, `Thurs`), so "sat", "sun", "wed" and "mon…" in ordinary words are not days. Not read
as a single day, so the existing rules apply: a plural ("Tuesdays"); a weekday followed by a day number ("Tue 24 Nov",
the shape Plan my day's `tomorrow` writes); a weekday after `until`, `till`, `through`, `thru`, `since`, `from`, `by`,
`before`, `after`, `last` or `every`; two or more weekday names that are not a range.

**Where it is read.** `addContext` writes `(from Tue 17 Nov until Tue 17 Nov)`; `parseContext` holds the line back
until `from` (pending) and lapses it after `until`; `planOffer`'s Heads-up takes lines whose `from` is the planned
day; `carryLines`/`keepLines` read `until`. No reader changes; the integration test proves the line shows on Tuesday
only and is Tuesday's Heads-up.

Both entry points anchor on the day planned: Plan my day passes `date`, the wind-down `targetDay`
(`apply.ts`, the two `contextLines` calls), so "Friday" said in a Friday wind-down is next week's Friday.

**Files.** `writes.ts` (`weekPlace`, its comment, which also swaps the real-looking ticket key for `ABC-12`);
`tools.ts` (the `caius_context_add` description's list of rules); a new `writes.spec.ts`; `week.integration.spec.ts`;
`catchup-review.integration.spec.ts`; `docs/ktn/caius/README.md` line 16.

**Tests first.**
- `writes.spec.ts` (new, unit): a table of `weekPlace(text, date)` cases, the cheap exact red run. A weekday later
  this week, the weekday that is `date`, a weekday already past (next ISO week's key and date), "next Friday",
  "ABC-12 ships Tuesday", and the exclusions keeping today's answers: "Ana is out Tuesdays", "Vendor freeze since
  Monday", "Code freeze from Wednesday", "I sat with Ana", "Ana is out Tue 24 Nov", "Ana is out Tuesday and
  Thursday", "Ana is out until Friday", "Demo Tuesday at 15:00".
- `week.integration.spec.ts`, "where a Context line goes": `[ "Riley is out Thursday", day ]` encodes the bug (it
  ends on Wednesday 25 Nov); it becomes `"2026-11-26"`. Add lines for: a weekday already past this week ("Pat is out
  Monday" on Wed 25 Nov: Mon 30 Nov, `2026-W49`), "next Friday" (Fri 4 Dec, `2026-W49`), the weekday that is `date`
  itself, and the exclusions ("Ana is out Tuesdays", "Vendor freeze since Monday", "I sat with Ana") keeping their old
  places.
- An integration test with the clock on a Monday: `caius_context_add` "Ana is out Tuesday" on Monday writes
  `(from Tue … until Tue …)`; `caius_context` holds it on Tuesday only, not Monday or Wednesday; Tuesday's
  `caius_planday` inputs step has it in `headsUp`.
- `catchup-review.integration.spec.ts` lines ~173 and ~368 assert Monday's Context holds "Ana is out Tuesday" and
  "Ben is out Thursday": they become "not on Monday, on Tuesday/Thursday". These cover the wind-down entry point.

**Done.** The new and changed assertions red before the change, the suite green after. Any other failure in the
suite is a placement change to weigh and report, not an assertion to edit.

## T2 · The brief's groups follow a catch-up item to the copy `move_all` made

**Cause.** `groupWords(pools)` (`apply.ts`) reads a group item's ref only against `pools.candidates`, `pools.open`
and `pools.deck` as the call's step data stands. After a `move_all` in an earlier call, the catch-up items are moved,
so `catchupOf` no longer offers them and their `o…` refs are in no pool. `groupWords` returns the raw ref,
`groupsFrom` matches it against nothing, and every item comes back `ungrouped`.

Every other answer reads refs through `nameReader(…).read`: a ref missing from its pools is looked up in the
`refTable` (every list item of the Journal, in any state) and `settle` follows a moved item along `chainEnd` to its
live copy. The fix reuses that path rather than a second one.

**Change.** `groupWords(pools, refs)` takes the `table`, `copies` and `collided` of the call's `refTable`. A ref it
finds in the pools reads as now. A ref it doesn't is read with a `nameReader` (its `skipped` thrown away: an unmatched
group item is already reported as `ungrouped`), and the live copy's id comes back as its `l…` ref (`refOf("l", id)`),
which `groupsFrom` resolves against the day's list. Both callers pass the refs: `planApply` (the brief) and `reorder`
(groups at the top with a moves-only call).

The same-call path stays as it is: `move_all` and `groups` in one call (`apply.integration.spec.ts` about line 115)
work today because the `o…` refs are still in `pools.open` and match the copies by text. The new branch runs only for
a ref absent from every pool, so that spec passes unchanged.

**Files.** `apply.ts` (`groupWords`, its two callers); `round4.integration.spec.ts` (next to "a catch-up task's ref
still names it after move_all moved it").

**Test first.** Tuesday holds two leftovers, Wednesday one task. On Wednesday, the catch-up step gives the leftovers'
`o…` refs; `caius_plan_apply` with `catchup: "move_all"` and a brief; then `caius_plan_apply` with a brief whose
`groups` name the two leftovers by those `o…` refs (and the own task by its words). Expected: no `ungrouped`, and the
brief's saved groups (`drawnNamesOf` / the `caius_planday` brief step's header groups) hold the copies' ids. Red:
`ungrouped` lists both refs.

**Done.** Red then green; the suite green.

## T3 · No words hash for empty words, and the right words for a followed copy

**Cause.** `giveAreas` records `areaAskIds(listItemId, on.textOf(listItemId) ?? "")`. `textOf` looks only in the
step's own lists: Plan my day's list, On deck, catch-up and held tasks; the wind-down's open items and the target
day's main list (`listItems`, which leaves On deck out). An area answer whose ref `nameReader` followed to a live copy
outside those lists (`input.follows`), such as an On deck item a first wind-down call forwarded to the target day's
On deck and a second call names by its old `o…` ref, gets `undefined`, so the words hashed are `""`. Every such copy
records `area:~da39a3ee5e` (the SHA-1 of nothing) and not its own words, so its next forwarded copy is asked again.
The task brief reports On deck copies with the empty hash; no commit or PR body records the scenario, so the red
test confirms this path before the fix. The `areaAskIds` guard ships either way; if the follow-path test is not red,
the cause stays unconfirmed and the task reports that.

**Change.**
- `areaAskIds(listItemId, text)` (`daily.ts`) returns only `area:<id>` when the words are empty. `unmarkedOf` reads
  through the same function, so an empty-words task never matches a words hash either.
- Both `giveAreas` callers fall back, after their lists, to the followed copy's words (`input.follows`) and then the
  ref table's item (every list item of the Journal), so a followed copy hashes its own words.

**Files.** `daily.ts` (`areaAskIds` only); `apply.ts` (the two `textOf` lambdas passed to `giveAreas`);
`daily.spec.ts`; an integration spec (`areas.integration.spec.ts` or `winddown-forward.integration.spec.ts`, wherever
a two-call wind-down fits).

**Tests first.**
- `daily.spec.ts`: `areaAskIds("x1", "")` and `areaAskIds("x1", "[from Mon 16 Nov](#root/abc)")` are `["area:x1"]`;
  `areaAskIds("x1", "Call the printer")` still has two values. `unmarkedOf` offers a task whose words are empty (a
  clock-only text, or a link with no label) even when `asked` holds `area:~da39a3ee5e`.
- Integration: the two-call wind-down above. After the second call, the target day's `#caiusAsked` holds
  `area:<copy id>` and `area:~<hash of the copy's words>` (equal to `areaAskIds(copyId, <copy text>)[1]`), and not
  `area:~da39a3ee5e`. Red: the empty hash is there.

**Not done.** Labels already on Shawn's notes stay. After the fix nothing computes the empty-words hash, so an old
`area:~da39a3ee5e` matches nothing: it is inert. What it cost is only that those copies' forwarded copies were asked
their area again.

**Done.** Red then green; the suite green.

## After the tasks

`pnpm typecheck` once from the root. Push, open the PR against `ktn` on `Kautiontape/trilium`, report to `caius-2d`.
