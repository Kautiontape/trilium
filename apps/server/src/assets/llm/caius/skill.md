# Planning with Caius

Caius is Shawn's planning method, kept in the Journal: day, week and month notes in Trilium. The `caius_*` tools read those notes and change tasks in them. Use them for anything about what to do today, this week or this month. Do not edit the Journal's task lists with the generic note tools; the Caius tools keep the markup, the edit guard and the Rescheduled links right.

## The Journal

A day, week or month note has the same shape, top to bottom:

1. The critical block, if any: an Important admonition holding the one or two tasks that must happen. Most days have none.
2. Tasks in priority order under headers. The order is the priority; the first three live tasks after the critical block are the Top 3. The headers are whatever the note uses (Morning / Afternoon / Evening, Work / Home / Chores, Foundation / Growth / Recharge). Read them, don't impose a set.
3. Suggested, last. Items that might be tasks. They are not tasks until Shawn accepts them, and they do not count toward capacity.

Keys: a day is `YYYY-MM-DD`, a week is `YYYY-Www` (ISO), a month is `YYYY-MM`.

## The method

- **The cascade.** Someday, then Planning ahead (future month notes), then Orbit (this month's note, the committed set), then Week (pulled from the month), then Today (pulled from the week). Pull down only: if a task isn't in the month, it doesn't get a week slot.
- **One fate on close.** When a period ends, every unchecked task gets exactly one fate, and nothing stays in a closed note:
  - Pull it into the next period (`caius_forward` to the next day or week).
  - Park it in a future month (`caius_forward` to `YYYY-MM`).
  - Drop it with a reason (`caius_set_state` with `cancelled`).
  - Pushing it to a project note is not available yet. Ask Shawn to do that one by hand.
- **Capacity.** Day: 180 to 240 minutes of planned work. Week: 720 to 900 (12 to 15 hours). Month: no target; it is a committed set, not a schedule. A live task with no `~30m` style estimate counts as 30 minutes. A task with live sub-items counts through them, not twice.

## Tools

Every write tool takes an `items` list. Every write also takes `dryRun`, and `html: true` on a dry run returns the full before and after HTML.

| Tool | Use it to | Example |
|---|---|---|
| `caius_plan` | Read one period's sections, tasks, estimates and capacity. | `{ "period": "day", "date": "2026-10-27" }` (date defaults to the current period) |
| `caius_open` | List open tasks across the Journal by lane, with `noteId`, `listItemId` and `daysLate`. Lanes: overdue, today, week, orbit, planning_ahead, someday, suggested. | `{ "lane": "overdue", "limit": 20 }` |
| `caius_explain` | Say why a task sits in its lane. | `{ "noteId": "abc", "listItemId": "e123" }` |
| `caius_add` | Add a task to a period, under a section, in the critical block, or under Suggested. | `{ "items": [{ "date": "2026-10-27", "section": "Work", "text": "Write the spec", "est": "1h" }] }` |
| `caius_accept` | Move a Suggested item up under a section or into the critical block. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "section": "Work", "position": 1 }] }` |
| `caius_dismiss` | Remove a Suggested item and keep it from being suggested again on that note. | `{ "items": [{ "noteId": "abc", "listItemId": "e123" }] }` |
| `caius_set_state` | Mark tasks `done`, `doing` or `cancelled`. Cancelled needs a `reason`. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "state": "cancelled", "reason": "no longer needed" }] }` |
| `caius_forward` | Move a task to another day, week or month. The old copy is marked Rescheduled with a link; an open copy appears under the same header in the target. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "to": "2026-W45" }] }` |
| `caius_assign_ids` | Give every Journal list item that has no `listItemId` one, so the other tools can target it. Reports per note how many items get an id and, on a dry run, their text. It is a dry run unless `dryRun` is `false`. Only when Shawn asks; show him the dry run first. | `{}` for the dry run, then `{ "dryRun": false }` |

`noteId` and `listItemId` always come from `caius_plan` or `caius_open`. Never guess them.

Forwarding works between any two periods: day to week, week to day, day to month, and so on. A task that was Doing stays Doing in the copy. Only the open sub-items come along.

## Daily planning

1. `caius_plan` for today. Note the critical block, the order and the capacity total against 180 to 240 minutes.
2. `caius_open` with `lane: "overdue"`. These slipped. Each one needs a decision: pull it in, park it, or drop it.
3. Go through the Suggested items for today (`caius_open` with `lane: "suggested"`). Ask Shawn, then `caius_accept` the ones he wants and `caius_dismiss` the rest.
4. `caius_open` with `lane: "week"` for what the week note holds. Pull tasks down into today with `caius_forward` until the day fits its capacity. Don't go over the top of the range.
5. Put the one or two must-do tasks in the critical block, and check the order: the first three are what Shawn will do first.
6. Ask for a guess on any task flagged as unestimated, and `caius_plan` again to confirm the total.

## Daily shutdown

1. `caius_plan` for today.
2. Take every task that is still open: not done, not cancelled, not Rescheduled. Including tasks in the critical block.
3. Give each one a single fate:
   - Carry on tomorrow or later this week: `caius_forward` to that day, or back up to the week note.
   - Not this month: `caius_forward` to a future `YYYY-MM`.
   - Not doing it: `caius_set_state` with `cancelled` and a short reason from Shawn.
4. Do the batch as a dry run first (see the rules) and show Shawn the summary.
5. `caius_plan` for today again. No open task should be left.

A week or month ends the same way at its own grain: forward to the next week or month, park it in a later month, or drop it.

## Reading results

Each write returns one result per item, with a status:

- A success status such as `moved` or `added`: it worked. On a dry run it also says what would change and carries `dryRun: true`.
- `skipped` with a reason: nothing was written. Common reasons are `not_found`, `not_live` (already done or cancelled), `already_moved`, `same_day` (the target is the same note), `duplicate`, `dismissed` and `edited` (the note changed while the tool ran). `stale` (the note changed since the app read it, with the note's current `blobId`) comes only from Trilium's own task actions, never from these tools.
- `failed` with an error: read it. Don't retry blindly.

A skipped item is often right. Report it to Shawn instead of working around it.

## Rules

- Run any batch with `dryRun: true` first and show Shawn the summary. Apply it only after he agrees.
- Never drop a task without a reason, and take the reason from Shawn, not from a guess.
- Only pull down the cascade. Do not add a task to a week note that isn't in the month, unless Shawn says so.
- The daily brief writes only to Suggested (`caius_add` with `suggested: true` and a `source`). It never writes above that section, and it does not suggest something already open anywhere in the Journal or already dismissed.
- After an `edited` skip, read the note again with `caius_plan` before you run the item again.
