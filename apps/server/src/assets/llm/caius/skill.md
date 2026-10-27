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

Most write tools take an `items` list, `dryRun`, and `html: true` on a dry run to return the full before and after HTML. `caius_meetings`, `caius_context_add` and `caius_brief_write` take one change and `dryRun`. `caius_skip_catchup` has no dry run: Shawn's "skip" is the yes.

| Tool | Use it to | Example |
|---|---|---|
| `caius_plan` | Read one period's sections, tasks, estimates and capacity. | `{ "period": "day", "date": "2026-10-27" }` (date defaults to the current period) |
| `caius_open` | List open tasks across the Journal by lane, with `noteId`, `listItemId` and `daysLate`. Lanes: overdue, today, week, orbit, planning_ahead, someday, suggested. | `{ "lane": "overdue", "limit": 20 }` |
| `caius_explain` | Say why a task sits in its lane. | `{ "noteId": "abc", "listItemId": "e123" }` |
| `caius_context` | Read the Context in force for a day: its note's Context lines, the last three workday notes' and the week note's (last week's too on a Monday), expired lines dropped. | `{ "date": "2026-11-09" }` |
| `caius_add` | Add a task to a period, under a section, in the critical block, or under Suggested. | `{ "items": [{ "date": "2026-10-27", "section": "Work", "text": "Write the spec", "est": "1h" }] }` |
| `caius_accept` | Move a Suggested item up under a section or into the critical block. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "section": "Work", "position": 1 }] }` |
| `caius_dismiss` | Remove a Suggested item and keep it from being suggested again on that note. | `{ "items": [{ "noteId": "abc", "listItemId": "e123" }] }` |
| `caius_set_state` | Mark tasks `done`, `doing` or `cancelled`. Cancelled needs a `reason`. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "state": "cancelled", "reason": "no longer needed" }] }` |
| `caius_forward` | Move a task to another day, week or month. The old copy is marked Rescheduled with a link; an open copy appears under the same header in the target. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "to": "2026-W45" }] }` |
| `caius_assign_ids` | Give every Journal list item that has no `listItemId` one, so the other tools can target it. Reports per note how many items get an id and, on a dry run, their text. It is a dry run unless `dryRun` is `false`. Only when Shawn asks; show him the dry run first. | `{}` for the dry run, then `{ "dryRun": false }` |
| `caius_inputs` | Read the day's Jira hand-offs, asks and done checks, the calendar events and the capacity the meetings leave. Read-only; pass the day's Context lines. A failed source is named in `errors`. | `{ "date": "2026-10-27", "context": ["ZAP-2590 is open"] }` |
| `caius_meetings` | Write the day note's Meetings block: clock lines, never tasks. Without `items` the lines come from the calendar. Replaces only that block. | `{ "date": "2026-11-09", "dryRun": true }` |
| `caius_context_add` | Add one Context line to a day note (`date`) or a week note (`week`), with an optional `until`. Text already in force is a `duplicate`. | `{ "week": "2026-W46", "text": "Sam is out all week", "until": "2026-11-13", "dryRun": true }` |
| `caius_brief_write` | Write the day's Morning Brief and its header, and include the header at the top of the day note. A re-run updates the same notes. | The `shape` from `caius_planday` step `brief`, filled in |
| `caius_skip_catchup` | Skip Plan my day's catch-up for a day: the last workday's open tasks stay where they are. | `{ "date": "2026-11-09" }` |
| `caius_winddown` | One step of Wind down: `open`, `next`, `context`. Returns the data and the question to ask. | `{ "date": "2026-11-06", "step": "open" }` |
| `caius_planday` | One step of Plan my day: `catchup`, `inputs`, `brief`. Returns the data and the question to ask. | `{ "date": "2026-11-09", "step": "catchup" }` |
| `caius_header` | Draw the day as terrain, from standup to bedtime, and attach it to a note as `terrain.svg`. A second call updates the same attachment. Returns `attachmentId` and the `<img>` `snippet` to put in the note; the note's text is not changed. Give `latitude` and `longitude` to add the weather. | `{ "noteId": "…", "start": "10:00", "end": "23:00", "events": [{ "start": "10:00", "end": "10:15", "title": "Standup" }], "work": [{ "start": "13:00", "end": "14:00", "label": "ZAP-1", "focus": true }] }` |

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

## Wind down and Plan my day

Two conversations, each started by a short opener that names a day: `Wind down 2026-11-06` closes that day, and `Plan my day 2026-11-09` plans it. The steps live in `caius_winddown` and `caius_planday`. Each answer is `{ step, data, question, next, standing }`:

- **The standing note first.** `standing` is Shawn's "How I work" note as markdown. Read it before anything else and follow its Brief rules. When it is null, say `standingMissing` in one line and carry on with the defaults.
- **The steps in order.** Call the first step, then the one `next` names, until `next` is null.
- **The questions.** Ask each `question` word for word. A step whose `question` is null has nothing to ask: go on to the next one. Say `data.summary` when there is one.
- **The writes.** Every write is a dry run first, shown to Shawn in two lines, then applied on his yes (`caius_skip_catchup` has none: his "skip" is the yes). Only `caius_accept`, or a `caius_forward` of a task Shawn names, puts anything into his main list. Everything else he wants goes to Suggested with `caius_add` (`suggested: true`) and stays there.
- **Never** ask Shawn to do something a tool can do, and never state a fact that is not in the tools' data.

### Wind down

`date` is the day being closed. Every step works against the next workday, `targetDay` (`targetDayName` in words): on a Friday that is Monday.

1. **`open`.** `data.items` is one list of what is still open: the day's leftovers (`group: "today"`), what slipped (`"overdue"`) and the week note's tasks (`"week"`), each with a proposed fate. After Shawn answers, mark the ones he calls done with `caius_set_state`, forward the rest whose fate is `{ forward }` to that day or week with `caius_forward`, and leave the `{ stay }` ones in the week note, unless he says otherwise.
2. **`next`.** `data.candidates` are what could go into the next workday's Suggested, each as `text` ("Get X done"), `because`, `minutes` and `source`.
   - Add the candidates to that day's Suggested with `caius_add`: the `text`, `source` (a Jira key), `est` from `minutes`.
   - A candidate with `noteId` and `listItemId` is a task in the week note already; `caius_add` would skip it as `duplicate`. Mention it, and forward it to the day with `caius_forward` only if Shawn names it.
   - The question covers what needs asking, in one go: the day over capacity ("which of these can wait?"), meetings that overlap, an empty evening. An overlap's answer goes to the day's Context with `caius_context_add`. An evening task he names goes in through Suggested and `caius_accept`, under the evening heading.
   - `data.errors` names a source that could not be read. Say which, in one line; with Jira missing there are no ticket candidates.
3. **`context`.** `data.noticed` holds a Context line that lapses before the next workday while it keeps a ticket open. On "keep", write it again with `caius_context_add`. Whatever Shawn says Caius should know goes in with `caius_context_add`: the week note (`week`) for the state of things ("Sam is out all week", "ABC-1 is open"), the day note (`date`) for one day only. When `question` is null, say "Anything to add for {targetDayName}? (Fine to skip.)" once, and stop if he skips.

### Plan my day

`date` is the day being planned.

1. **`catchup`.** When the last workday still has open tasks, the question offers three answers:
   - **Move all:** forward every task in `data.tasks` to `data.moveTo` with `caius_forward`.
   - **Review:** run Wind down for `data.lastWorkday`, then come back to Plan my day.
   - **Skip:** `caius_skip_catchup` for the day, which leaves them where they are.
2. **`inputs`.**
   - Add `data.candidates` to the day's Suggested as in Wind down. They are only what is new since the last brief, so a second plan adds only the new ones.
   - When `data.meetings.changed`, write `data.meetings.lines` with `caius_meetings`. Lines that are null mean the calendar could not be read: say so and leave the block as it is.
   - An overlap's answer goes to the day's Context. When `data.forwardSuggestion` is set and Shawn says yes, forward that task to its `to` day.
3. **`brief`.** Write the brief with `caius_brief_write`, filling in `data.shape`. It should take about 60 seconds to read:
   - `headline`: 14 words or fewer, naming the work. When the day is over 60% booked, say so.
   - `acts`: three, one sentence each, grouped by what fits around the meetings rather than listing them. The third is the evening. Their times come from `data.day` and `data.header`.
   - `picks`: 3 to 5, each "Get X done" with its `because` and `minutes`, from the main list and the candidates.
   - `sections`: Follow up, worded as the Brief rules say. Heads-up only when there is an outside event; drop it otherwise.
   - Keep `header` as given. It draws the day from standup to bedtime.
4. **In the chat**, end with the headline and the top pick in two lines, and the link to the brief (`#root/<briefNoteId>`).

Pressing Plan my day again later re-reads everything and rewrites the same brief.

## Reading results

Each write returns one result per item, with a status:

- A success status such as `moved` or `added`: it worked. On a dry run it also says what would change and carries `dryRun: true`.
- `skipped` with a reason: nothing was written. Common reasons are `not_found`, `not_live` (already done or cancelled), `already_moved`, `same_day` (the target is the same note), `duplicate`, `dismissed` and `edited` (the note changed while the tool ran). `stale` (the note changed since the app read it, with the note's current `blobId`) comes only from Trilium's own task actions, never from these tools.
- `failed` with an error: read it. Don't retry blindly.

A skipped item is often right. Report it to Shawn instead of working around it.

`journal: false` on an answer from `caius_open`, `caius_explain` or `caius_assign_ids` means this Trilium has no Journal (no note carries `#calendarRoot`). That is not "nothing to do": say so to Shawn rather than reporting an empty plan.

## Rules

- Run any batch with `dryRun: true` first and show Shawn the summary. Apply it only after he agrees.
- Never drop a task without a reason, and take the reason from Shawn, not from a guess.
- Only pull down the cascade. Do not add a task to a week note that isn't in the month, unless Shawn says so.
- The daily brief writes only to Suggested (`caius_add` with `suggested: true` and a `source`). It never writes above that section, and it does not suggest something already open anywhere in the Journal or already dismissed.
- After an `edited` skip, read the note again with `caius_plan` before you run the item again.
