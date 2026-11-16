# Plan: the Plan my day fixes (Part 1, items 1–6)

Design: [`design/2026-11-16-subtasks-reword-flip.md`](../design/2026-11-16-subtasks-reword-flip.md), Part 1. Item 7
(parents matched by text) belongs to the sub-tasks branch and is not in this plan.

One PR against `ktn` from `ktn-caius-catchup-fixes`. Every task is test-first: the failing test, a red run, the code,
a green run. Each task is one commit (`caius: …`), by explicit path, with its own lines of `docs/ktn/caius/README.md`
or `phone.md` when it changes what they describe.

Order: T1, T2 and T4 all edit `apps/server/src/services/caius/apply.ts`, so they run one after another. T3 and T5
touch other files and can run beside them.

## T1 · Week refs anchored on the target day in a catch-up review

**Files.** `apps/server/src/services/caius/daily.ts` (`namedDays`, a new exported `catchUpReview` below
`windDownTarget`); `daily.spec.ts`; a new `catchup-review.integration.spec.ts`; README line 207 (`data.days`).

**Change.** `catchUpReview(date, targetDay)` is true when `dayKey(nextWorkday(localDay(date))) < targetDay`.
`namedDays(date, first)` anchors `monday`, the list's end and the months on `first` when `catchUpReview(date, first)`,
else on `date`. No caller changes: Plan my day passes `first = nextWorkday(date)`, which is never a catch-up.
`windDownTarget`'s body is left alone.

**Tests first.**
- `daily.spec.ts`: `namedDays("2026-11-10", "2026-11-16")` gives weeks `2026-W47`, `2026-W48` (w1, w2), days 16 to
  27 Nov, months `2026-11` to `2027-01`. `namedDays("2026-11-13", "2026-11-16")` gives w1 `2026-W46`, w2 `2026-W47`,
  days 16 to 20 Nov. `namedDays("2026-10-27", "2026-11-16")` lists day refs from 16 Nov (it has none today).
- Integration: with the clock at `2026-11-16T19:00` (past work end, so no Plan my day chain), a
  `caius_winddown_apply` of 2026-11-10 with a fate `to: "w1"` writes to `2026-W47` (red: `2026-W46`).

**Done.** Both specs green; the existing exact `data.days` assertions (`round2` about line 571–587, `round4` about
563) pass unchanged.

## T2 · A catch-up review writes only the reviewed day

**Files.** `apply.ts` (`windDownApply`), `say.ts` (one grouped clause), `apps/server/src/assets/translations/en/server.json`
(`caius.say.review_only_one/_other`, plus an agent-facing `caius.say.review_only_detail`); the T1 integration spec;
README lines 207 (the `review_only` reason) and 225 (what a catch-up review writes).

**Rule.** With `catchUpReview(date, targetDay)`, the apply writes the answers about the reviewed day and leaves the
target day to Plan my day. Each answer passed for the target day is skipped `review_only`; implicit target-day writes
are not made. Verdict per call (goes in the commit body):

| Call | Catch-up review | Why |
| --- | --- | --- |
| `done`, holds, fates (a forward to the target day included), drops, parks, `putOffWeek`, `#caiusSettled`, `#caiusWoundDown`, `pruneSettled` | run | the reviewed day's own items |
| `areas` | run for the reviewed day's open items; skipped for the target day's list items | same rule |
| `finish` | runs | a finished ticket is a done answer about the reviewed day's work, and `doneOf` already turns it into done items; skipping it would re-offer a ticket he just finished |
| `accept` (and its places) | skipped | a target-day offer |
| `move` | runs for an item this call forwards to the target day (`moved`), skipped otherwise | the doc's rule |
| `keep`, `carry` | skipped | the closing Context lines; Plan my day runs its own carry check |
| `notToday`, `dismiss` | skipped | target-day offers |
| `shelve` | not run | target-day offers |
| `contextLines` | skipped | the context step asks about the target day |
| `takeOverlaps` | skipped | the target day's calendar |
| `recordFocus` | not run | the target day's plan |
| `#caiusAsked` for the closing lines on `date`, `#caiusAsked`/`#caiusAskSeen` from the next step on the target day | not written | they record questions this apply does not answer, and would hide them from Plan my day |
| header redraw of the target day | runs | it follows the forwards; no answer of his |

Also: the `placed` set is computed from the gated answers, so a skipped accept's anchor doesn't move a fate off
On deck; the Plan my day chain's `answered.keep` holds only lines actually written; `review_only` is reported only for
answers the call passed, not for ones an `asOffered` expansion would add (in a catch-up review `asOffered` adds no
accepts, keeps or carries). The recap names the skipped items in one clause, "ABC-21 and ABC-22 are left for Plan my
day", instead of one "stays as it was" each.

**Tests first** (in `catchup-review.integration.spec.ts`, invented tickets and names). Review 2026-11-10 from Mon
2026-11-16 with Jira hand-offs ABC-21, ABC-22, ABC-23 on offer, a target-day list item, a carry line and an
overlap-free calendar. One call passes `done`, a fate to 2026-11-16, a drop, an area for an open item, `accept`
ABC-21, `notToday` ABC-23, `carry`, `context`, a `move` of the forwarded item and a `move` of the target-day list
item. Assert: done, the fates, the drop, the area and the forwarded item's move are written; accept, not today,
carry, context and the list item's move are skipped `review_only`; the target day's note has no Suggested (ABC-22 not
shelved), no accepted ticket, no new Context line and no `#caiusFocus`; `say` has the grouped clause. A second case
at 09:00 (the morning chain): the skipped carry line is still in `planday.inputs.data.carry`.

**Done.** New cases green; `cd apps/server && pnpm exec vitest run src/services/caius` green apart from known
failures. Any older spec whose stubbed clock makes its review a catch-up and that changes is listed in the commit body.

## T3 · Two skill-sheet lines

**Files.** `apps/server/src/assets/llm/caius/skill.md`, `register.spec.ts`.

**Lines** (in `### Rules` of "Wind down and Plan my day", after the "Map a day he names" bullet):
- "A weekday he names reads from the ritual's date, not the clock: that date's own weekday name is that date, any
  other is the next one after it."
- "A task you bring into a day laid out in blocks needs its block: put it there with `caius_place` (or `block` on
  `caius_add`) and say which in one clause."

**Tests first.** Add both sentences to the verbatim rule list in `register.spec.ts`; red, then add the lines; green.
The sheet stays under 48,000 characters.

## T4 · A move after an item in a block joins that block

**Files.** `apply.ts` (`placeOnList`); `areas.integration.spec.ts` (it has `dayWith` for blocked days); README line
212–213 (accepts' places and moves).

**Change.** `placeOnList` sends a `before`/`after` place through `placeTasks` (the `caius_place` path,
`placeInDay`) instead of `moveTasks`; `first` stays on `moveTasks`, since `placeInDay` has no `first`. Accept places
use the same function and gain the same behavior.

**Tests first.** On a day with Morning, Afternoon and Evening lists, `caius_plan_apply` with only `move: [{ listItemId:
<a Morning item>, after: <an Evening item> }]` writes it, and the Morning item now sits right after the Evening item
(red: skipped `not_in_main_list`). A move within one list still works (existing specs).

**Side finding, not fixed here.** `commitTasks` (On deck onto the list with a place) still uses `moveInMainList`.

## T5 · Enter adds a line in the phone chat

**Files.** `apps/caius-app/src/screens/Chat.tsx` (`Composer`, exported for its spec); a new
`apps/caius-app/src/screens/Chat.spec.tsx`; `docs/ktn/caius/phone.md` (the rituals and Ask rows).
`QuickAdd.tsx` is not touched.

**Change.** The textarea's `onKeyDown` Enter handler goes, so Enter is the textarea's own newline; Send sends. The box
shows three rows once the text has a line break, as it does past 60 characters.

**Tests first.** Render `Composer` with a stub chat. Enter on the textarea is not `defaultPrevented` and sends
nothing; a click on Send sends the text. Red: Enter sends.

## Finish

`pnpm typecheck` once from the root. Push, open the PR with `--repo Kautiontape/trilium --base ktn`, body grouped by
area from the commit bodies. Report to `caius-2d`.
