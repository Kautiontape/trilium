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
| `caius_add` | Add a task to a period, under a section or in the critical block (`text`), or under Suggested (`key`, `title`, `because`, `minutes`, which it writes as "Get KEY title done: because why (~30m)"). | `{ "items": [{ "date": "2026-10-27", "suggested": true, "key": "ZAP-111", "title": "Check the invoice export in QA", "because": "sitting in QA Testing for 3 days", "minutes": 30 }] }` |
| `caius_accept` | Move a Suggested item to the end of his main list, or under a section or into the critical block he names. Never pass a section unless he names one. | `{ "items": [{ "noteId": "abc", "listItemId": "e123" }] }` |
| `caius_dismiss` | Remove a Suggested item and keep it from being suggested again on that note. | `{ "items": [{ "noteId": "abc", "listItemId": "e123" }] }` |
| `caius_set_state` | Mark tasks `done`, `doing` or `cancelled`. Cancelled needs a `reason`. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "state": "cancelled", "reason": "no longer needed" }] }` |
| `caius_forward` | Move a task to another day, week or month. The old copy is marked Rescheduled with a link; an open copy appears under the same header in the target. | `{ "items": [{ "noteId": "abc", "listItemId": "e123", "to": "2026-W45" }] }` |
| `caius_assign_ids` | Give every Journal list item that has no `listItemId` one, so the other tools can target it. Reports per note how many items get an id and, on a dry run, their text. It is a dry run unless `dryRun` is `false`. Only when Shawn asks; show him the dry run first. | `{}` for the dry run, then `{ "dryRun": false }` |
| `caius_inputs` | Read the day's Jira hand-offs, asks and done checks, the calendar events and the capacity the meetings leave. Read-only; pass the day's Context lines. A failed source is named in `errors`. | `{ "date": "2026-10-27", "context": ["ZAP-2590 is open"] }` |
| `caius_meetings` | Write the day note's Meetings block: clock lines, never tasks. Without `items` the lines come from the calendar. Replaces only that block. | `{ "date": "2026-11-09", "dryRun": true }` |
| `caius_context_add` | Add one Context line to a day note (`date`) or a week note (`week`), with an optional `until`. Text already in force is a `duplicate`. | `{ "week": "2026-W46", "text": "Sam is out all week", "until": "2026-11-13", "dryRun": true }` |
| `caius_context_keep` | Keep Context lines Shawn agreed to keep or carry: each goes to the week note of `date`, the step's `data.keepDate`, never to a day note. | `{ "date": "2026-11-09", "lines": [{ "text": "ZAP-2590 is open" }] }` |
| `caius_brief_write` | Write the day's Morning Brief and its header, and include the header at the top of the day note. A re-run updates the same notes. | The `shape` from `caius_planday` step `brief`, filled in |
| `caius_finished` | Record that Shawn says a ticket is finished when it isn't a task to tick. Candidates and Suggested leave it out for 30 days. No dry run: his word is the yes. | `{ "keys": ["ZAP-101"] }` |
| `caius_skip_catchup` | Skip Plan my day's catch-up for a day: the last workday's open tasks stay where they are. | `{ "date": "2026-11-09" }` |
| `caius_winddown` | One step of Wind down: `open`, `next`, `context`. Returns the data and the question to ask. | `{ "date": "2026-11-06", "step": "open" }` |
| `caius_planday` | One step of Plan my day: `catchup`, `inputs`, `brief`. Returns the data and the question to ask. | `{ "date": "2026-11-09", "step": "catchup" }` |
| `caius_plan_apply` | Every write of Plan my day in one call, from his answers mapped to the step data's ids. | `{ "date": "2026-11-09", "accept": [{ "candidateId": "ZAP-111" }], "brief": { "headline": "…", "acts": […], "sections": [] } }` |
| `caius_header` | Draw the day as terrain, from standup to bedtime, and attach it to a note as `terrain.svg`. A second call updates the same attachment. Returns `attachmentId` and the `<img>` `snippet` to put in the note; the note's text is not changed. Give `latitude` and `longitude` to add the weather. | `{ "noteId": "…", "start": "10:00", "end": "23:00", "events": [{ "start": "10:00", "end": "10:15", "title": "Standup" }], "work": [{ "start": "13:00", "end": "14:00", "label": "ZAP-1", "focus": true }] }` |

`noteId` and `listItemId` always come from `caius_plan` or `caius_open`. Never guess them.

Forwarding works between any two periods: day to week, week to day, day to month, and so on. A task that was Doing stays Doing in the copy. Only the open sub-items come along.

## Daily planning

1. `caius_plan` for today. Note the critical block, the order and the capacity total against 180 to 240 minutes.
2. `caius_open` with `lane: "overdue"`. These slipped. Each one needs Shawn's decision: pull it in, park it, or drop it.
3. Go through the Suggested items for today (`caius_open` with `lane: "suggested"`). Ask Shawn, then `caius_accept` the ones he wants and `caius_dismiss` the rest.
4. `caius_open` with `lane: "week"` for what the week note holds. Show Shawn what fits the day's capacity, and pull down into today with `caius_forward` only the tasks he names. Don't go over the top of the range.
5. Ask Shawn which one or two tasks must happen, if any, for the critical block, and check the order with him: the first three are what he will do first. Never reorder his list yourself.
6. Ask for a guess on any task flagged as unestimated, and `caius_plan` again to confirm the total.

## Daily shutdown

1. `caius_plan` for today.
2. Take every task that is still open: not done, not cancelled, not Rescheduled. Including tasks in the critical block.
3. Give each one a single fate, as Shawn decides:
   - Carry on tomorrow or later this week: `caius_forward` to that day, or back up to the week note.
   - Not this month: `caius_forward` to a future `YYYY-MM`.
   - Not doing it: `caius_set_state` with `cancelled` and a short reason from Shawn.
4. Do the batch as a dry run first (see the rules) and show Shawn the summary.
5. `caius_plan` for today again. No open task should be left.

A week or month ends the same way at its own grain: forward to the next week or month, park it in a later month, or drop it.

## Wind down and Plan my day

For `Wind down` and `Plan my day` openers, follow only this section. The Daily planning and Daily shutdown steps above are for other requests.

Two conversations, each started by an opener that names a day: `Wind down 2026-11-06` closes that day, and `Plan my day 2026-11-09` plans it. Call the steps of `caius_winddown` or `caius_planday` in order, following `next`. Each answers `{ step, data, question, next, standing }`.

- **The standing note.** `standing` is Shawn's "How I work" note. Follow its Brief rules. When it is null, say `standingMissing` in one line and use the defaults: nothing before standup; open time is work time; never echo what Shawn did himself; a follow-up is worded as a follow-up, never "still open", "still waiting", "outstanding" or "haven't answered".
- **The questions.** Each `question` is asked word for word, folded into the one message below. A null `question` means nothing to ask; still do the step's writes.
- **Shawn's list.** Only `caius_accept`, a `caius_forward` he named, or an evening task he named puts anything on his list. Candidates go to Suggested with `caius_add` and `suggested: true`, passing `key`, `title`, `because` and `minutes` as given.
- **Week items.** A candidate with `kind: "week"` is already on the week's list: don't add it; `caius_forward` it (its `noteId` and `listItemId`) to the day when he names it.
- **Finished work.** When he says a ticket is done and it isn't a task to tick, call `caius_finished` with its key.

### Plan my day

1. Call `catchup` and `inputs` first. Add the ticket candidates to that day's Suggested with `caius_add` and `suggested: true` (no yes needed).
2. Send one short message:
   - the catch-up question first, if there is one;
   - the candidates, each with its reason and size, then "Which of these today, in what order?";
   - the `inputs` question (overlaps, a heavy day, Context to carry) in the same message.
3. After his answer, do everything in one go, with no further yes:
   - `caius_accept` what he named, in the order he named it, with no `section` unless he names one: each joins the end of his list, after what's already there;
   - the catch-up: forward all, `caius_skip_catchup`, or run Wind down for `data.lastWorkday` on "review";
   - `caius_meetings` when `data.meetings.changed`;
   - the Context he kept with `caius_context_keep` and `date: data.keepDate`, and an overlap's answer with `caius_context_add` on the day;
   - the brief: call `brief`, then `caius_brief_write` with `data.shape` filled in.
4. End with the headline and the top pick in two lines, and the link `#root/<briefNoteId>`.

The brief takes about 60 seconds to read:
- `headline`: 14 words or fewer, naming the work; say so when the day is over 60% booked.
- `acts`: three sentences, grouped by what fits around the meetings; the third is the evening.
- `picks`: up to 5 of his list; fewer is fine. Each is a task of `data.list`, as "Get X done" with its `because` and `minutes`; candidates he didn't take aren't picks. Never mention `droppedPicks` to him.
- `sections`: Follow up, only from `data.followUps`: for each, its ticket key, who asked what and when, ending "if you already answered in Chat, dismiss this". Never "no reply", "unanswered", "still open", "still waiting", "outstanding" or "haven't answered". Heads-up only for an outside event.
- Keep `header` and `followUps` as given.

### Wind down

`date` is the day being closed; every step works against `targetDay`, the next workday.

1. Call `open`, `next` and `context` first. Add the `next` ticket candidates to that day's Suggested with `caius_add` and `suggested: true`.
2. Send one message:
   - what's open (`data.items`) with the `open` question, which asks which are done; say which ones Jira calls done (`jiraDone: true`); `data.olderCount` older tasks get one line, as not tonight's job, never a list or a question;
   - then the `next` and `context` questions about the next day.
3. After his answer, apply everything in one go: `caius_set_state` for what he calls done, `caius_forward` the rest to their `fate`, the Context he kept with `caius_context_keep` and `date: data.keepDate`, anything new he says with `caius_context_add` and `date: targetDay`.

### Behaviour

- Never narrate tool calls or internals, and never mention files, shell or fetching. Never retry a tool with another tool.
- On a tool error, say one plain sentence and carry on with the rest.
- Say only what the tools' data says about people and tickets. Never guess pronouns, and never say Jira "confirms" something it didn't return.
- Never run Plan my day for a future day. A wind-down sets the next day up; it doesn't plan it.
- Dry run first, and wait for a yes, only for forwards and drops of his own tasks that he hasn't already answered.
- When he names an evening thing (laundry), `caius_add` it as a task under an `Evening` heading, on his word.

## Reading results

Each write returns one result per item, with a status:

- A success status such as `moved` or `added`: it worked. On a dry run it also says what would change and carries `dryRun: true`.
- `skipped` with a reason: nothing was written. Common reasons are `not_found`, `not_live` (already done or cancelled), `already_moved`, `same_day` (the target is the same note), `duplicate`, `dismissed` and `edited` (the note changed while the tool ran). `stale` (the note changed since the app read it, with the note's current `blobId`) comes only from Trilium's own task actions, never from these tools.
- `failed` with an error: read it. Don't retry blindly.

A skipped item is often right. Report it to Shawn instead of working around it.

`journal: false` on an answer from `caius_open`, `caius_explain` or `caius_assign_ids` means this Trilium has no Journal (no note carries `#calendarRoot`). That is not "nothing to do": say so to Shawn rather than reporting an empty plan.

## Rules

- Outside Wind down and Plan my day, run any batch with `dryRun: true` first and show Shawn the summary. Apply it only after he agrees.
- Never drop a task without a reason, and take the reason from Shawn, not from a guess.
- Only pull down the cascade. Do not add a task to a week note that isn't in the month, unless Shawn says so.
- The daily brief writes only to Suggested (`caius_add` with `suggested: true`, `key`, `title`, `because` and `minutes`). It never writes above that section, and it does not suggest something already open anywhere in the Journal or already dismissed.
- After an `edited` skip, read the note again with `caius_plan` before you run the item again.
