# Planning with Caius

Caius is the user's planning method, kept in the Journal: day, week and month notes in Trilium. The `caius_*` tools read those notes and change tasks in them. Use them for anything about what to do today, this week or this month. Do not edit the Journal's task lists with the generic note tools; the Caius tools keep the markup, the edit guard and the Rescheduled links right.

## The Journal

A day, week or month note has the same shape, top to bottom:

1. The critical block, if any: an Important admonition holding the one or two tasks that must happen. Most days have none.
2. Tasks in priority order under headers. The order is the priority; the first three live tasks after the critical block are the Top 3. The headers are whatever the note uses (Morning / Afternoon / Evening, Work / Home / Chores, Foundation / Growth / Recharge). Read them, don't impose a set.
3. Suggested, last. Items that might be tasks. They are not tasks until the user accepts them, and they do not count toward capacity.

Keys: a day is `YYYY-MM-DD`, a week is `YYYY-Www` (ISO), a month is `YYYY-MM`.

## The method

- **The cascade.** Someday, then Planning ahead (future month notes), then Orbit (this month's note, the committed set), then Week (pulled from the month), then Today (pulled from the week). Pull down only: if a task isn't in the month, it doesn't get a week slot.
- **One fate on close.** When a period ends, every unchecked task gets exactly one fate, and nothing stays in a closed note:
  - Pull it into the next period (`caius_forward` to the next day or week).
  - Park it in a future month (`caius_forward` to `YYYY-MM`).
  - Drop it with a reason (`caius_set_state` with `cancelled`).
  - Pushing it to a project note is not available yet. Ask the user to do that one by hand.
- **Capacity.** Day: 180 to 240 minutes of planned work. Week: 720 to 900 (12 to 15 hours). Month: no target; it is a committed set, not a schedule. A live task with no `~30m` style estimate counts as 30 minutes. A task with live sub-items counts through them, not twice.

## Tools

Most write tools take an `items` list, `dryRun`, and `html: true` on a dry run to return the full before and after HTML. `caius_meetings`, `caius_context_add` and `caius_brief_write` take one change and `dryRun`. `caius_skip_catchup` has no dry run: the user's "skip" is the yes.

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
| `caius_assign_ids` | Give every Journal list item that has no `listItemId` one, so the other tools can target it. Reports per note how many items get an id and, on a dry run, their text. It is a dry run unless `dryRun` is `false`. Only when the user asks; show him the dry run first. | `{}` for the dry run, then `{ "dryRun": false }` |
| `caius_inputs` | Read the day's Jira hand-offs, asks and done checks, the calendar events and the capacity the meetings leave. Read-only; pass the day's Context lines. A failed source is named in `errors`. | `{ "date": "2026-10-27", "context": ["ZAP-2590 is open"] }` |
| `caius_meetings` | Write the day note's Meetings block: clock lines, never tasks. Without `items` the lines come from the calendar. Replaces only that block. | `{ "date": "2026-11-09", "dryRun": true }` |
| `caius_context_add` | Add one Context line to a day note (`date`) or a week note (`week`), with an optional `until`. Text already in force is a `duplicate`. | `{ "week": "2026-W46", "text": "Sam is out all week", "until": "2026-11-13", "dryRun": true }` |
| `caius_context_keep` | Keep Context lines the user agreed to keep or carry: each goes to the week note of `date`, the step's `data.keepDate`, never to a day note. | `{ "date": "2026-11-09", "lines": [{ "text": "ZAP-2590 is open" }] }` |
| `caius_brief_write` | Write the day's Morning Brief and its header, and include the header at the top of the day note. A re-run updates the same notes. | The `shape` from `caius_planday` step `brief`, filled in |
| `caius_finished` | Record that the user says a ticket is finished when it isn't a task to tick. Candidates and Suggested leave it out for 30 days. No dry run: his word is the yes. | `{ "keys": ["ZAP-101"] }` |
| `caius_skip_catchup` | Skip Plan my day's catch-up for a day: the last workday's open tasks stay where they are. | `{ "date": "2026-11-09" }` |
| `caius_winddown` | One step of Wind down: `open`, `next`, `context`. Returns the data and the question to ask. | `{ "date": "2026-11-06", "step": "open" }` |
| `caius_planday` | One step of Plan my day: `catchup`, `inputs`, `brief`. Returns the data and the question to ask. | `{ "date": "2026-11-09", "step": "catchup" }` |
| `caius_plan_apply` | Every write of Plan my day in one call, from his answers mapped to the step data's ids. | `{ "date": "2026-11-09", "accept": [{ "candidateId": "ZAP-111", "after": "e105" }], "brief": { "headline": "…", "acts": […], "sections": [] } }` |
| `caius_winddown_apply` | Every write of Wind down in one call, from his answers mapped to the step data's ids. | `{ "date": "2026-11-06", "done": ["e123"], "fates": [{ "listItemId": "e456", "to": "2026-W46" }] }` |
| `caius_header` | Draw the day as terrain, from standup to bedtime, and attach it to a note as `terrain.svg`. A second call updates the same attachment. Returns `attachmentId` and the `<img>` `snippet` to put in the note; the note's text is not changed. Give `latitude` and `longitude` to add the weather. | `{ "noteId": "…", "start": "10:00", "end": "23:00", "events": [{ "start": "10:00", "end": "10:15", "title": "Standup" }], "work": [{ "start": "13:00", "end": "14:00", "label": "ZAP-1", "focus": true }] }` |

`noteId` and `listItemId` always come from `caius_plan` or `caius_open`. Never guess them.

Forwarding works between any two periods: day to week, week to day, day to month, and so on. A task that was Doing stays Doing in the copy. Only the open sub-items come along.

## Daily planning

1. `caius_plan` for today. Note the critical block, the order and the capacity total against 180 to 240 minutes.
2. `caius_open` with `lane: "overdue"`. These slipped. Each one needs the user's decision: pull it in, park it, or drop it.
3. Go through the Suggested items for today (`caius_open` with `lane: "suggested"`). Ask the user, then `caius_accept` the ones he wants and `caius_dismiss` the rest.
4. `caius_open` with `lane: "week"` for what the week note holds. Show the user what fits the day's capacity, and pull down into today with `caius_forward` only the tasks he names. Don't go over the top of the range.
5. Ask the user which one or two tasks must happen, if any, for the critical block, and check the order with him: the first three are what he will do first. Never reorder his list yourself.
6. Ask for a guess on any task flagged as unestimated, and `caius_plan` again to confirm the total.

## Daily shutdown

1. `caius_plan` for today.
2. Take every task that is still open: not done, not cancelled, not Rescheduled. Including tasks in the critical block.
3. Give each one a single fate, as the user decides:
   - Carry on tomorrow or later this week: `caius_forward` to that day, or back up to the week note.
   - Not this month: `caius_forward` to a future `YYYY-MM`.
   - Not doing it: `caius_set_state` with `cancelled` and a short reason from the user.
4. Do the batch as a dry run first (see the rules) and show the user the summary.
5. `caius_plan` for today again. No open task should be left.

A week or month ends the same way at its own grain: forward to the next week or month, park it in a later month, or drop it.

## Wind down and Plan my day

For `Wind down` and `Plan my day` openers, follow only this section. The Daily planning and Daily shutdown steps above are for other requests.

In these conversations only these tools are available; every other Caius tool and every generic note write is switched off:

| Tool | Use |
|---|---|
| `caius_planday` | Plan my day's steps: `catchup`, `inputs`. |
| `caius_plan_apply` | Plan my day's one write. |
| `caius_winddown` | Wind down's steps: `open`, `next`, `context`. |
| `caius_winddown_apply` | Wind down's one write. |
| `load_skill`, note reads | This sheet, and reading a note when the step data points at one. |

`Plan my day 2026-11-09` plans that day; `Wind down 2026-11-06` closes that day against the next workday. Each conversation is one question set, then one apply call that makes every write. You read, ask, pass his answers through as ids, and write the brief's prose. The tool does the rest. A correction he makes after the apply ("111 was later this week", "also ZAP-2590 is open") is one more call of the same apply tool for the same date, with his correction in `said` and only what he corrected (in Plan my day, with the brief's prose again): never another tool. It changes only what it names, and repeating it changes nothing.

### Plan my day

1. Call `caius_planday` steps `catchup`, then `inputs`.
2. Send **one message**: the catch-up question (if any), the candidates with their `because` and size, the carry question (only when `data.carry` has a line), the overlap question (if any), the heavy-day move question (if any) and the evening question (if any), each only when the step's `question` holds it.
3. Take his reply and call `caius_plan_apply` **once**: `said` (his reply, word for word), `catchup` (`move_all`, `skip` or `review`), `accept` (his order, each with the place he names), `move`, `keep`, `finished`, `notToday`, `dismiss`, `evening`, `context`, `overlaps` (each overlap he answered: its `overlapId` and the meeting he takes), `forward`, and `brief` with the `headline` (14 words or fewer, naming the work; say so when the day is half booked or more), two `acts`, one sentence each, naming his work in the order of his list as this call leaves it, after the accepts, moves and forwards: the first half of it, then the rest, each task by its key or its own words, never a list of meetings. The tool takes each act's time from the drawing, keeps your words only when they name the work the drawing puts there, and writes the evening act and any extra `sections`. The tool writes the picks, the Follow up, the Heads-up, the drawing and the weather.
4. After the apply, reply with the result's `say`, then the headline and the top pick, and nothing else.

On a day already under way the step gives `data.planFrom`: the acts start there, never in the part of the day already past.

When the catch-up step asks about held items (`data.held`), one he says is done goes in `finished`; anything else he says about them is `catchup: "review"`.

On `catchup: "review"`, run Wind down for `data.oldestDay` in this conversation, then come back to Plan my day: call `catchup` again and go on from there.

On a refresh (the day already has a brief), the step asks only what is new; with no question, call `caius_plan_apply` with `said: ""`, no other answer and the brief's prose.

### Wind down

1. Call `caius_winddown` steps `open`, `next`, then `context`.
2. Send **one message**: what's left (`data.items`) with the `open` question, the next workday's candidates, the keep or carry question (only when `data.noticed` has a line), and the `next` and `context` questions. Say which items Jira calls done (`jiraDone`). Mention `olderCount` only when the step data has it, in one line.
3. Take his reply and call `caius_winddown_apply` **once**: `said` (his reply, word for word), `done`, `fates` (only the items he named; every other item keeps its proposed fate), `accept`, `move`, `keep`, `carry`, `finished`, `notToday`, `dismiss`, `evening`, `context` and `overlaps` (each overlap he answered: its `overlapId` and the meeting he takes).
4. After the apply, reply with the result's `say` and nothing else. With a `nextCall`, go on as step 5 says. At the end of a wind-down, never offer to run Plan my day for another day.
5. When the apply answers with `planday`, a morning Review of an older day closed it against today, and Plan my day's `catchup` and `inputs` steps have already run for today, with the answers he gave here. Go straight on in the same reply: after the `say`, send Plan my day's one message (its step 2) from `planday.catchup` and `planday.inputs`, then take his reply to `caius_plan_apply` (its step 3). Never ask whether to plan, and never call those steps again.

### Rules

- Call him "you", never "Shawn".
- Use the date strings the step data gives (the `…Label` fields) as they are. Never work out a weekday.
- Name each item in an answer by its `ref` from the step data (such as `o3fa9c` or `d1`) or by his own words: a ticket key or its number ("101"), or a distinctive word ("the bag"). A name that fits more than one item is skipped, so use a ref when his words fit two.
- `said` never writes anything. When the apply answers with `check`, it wrote nothing: his reply seems to say something the call left out. For each entry, if he meant it, call again with it passed in its field; if he didn't, call again with the same answers and `checked: true`. Never tell him about the check.
- When `say` ends with a which-question, the items it names stay open until he answers; his answer is one more apply call naming them.
- A ref names the same item for the whole conversation. One whose item changed since the step is skipped as `stale`: ask him about that item in one clause.
- Map a day he names to one of `data.days` (a week to `data.weeks`, a month to `data.months`); never compute a date. An answer may name only items the steps showed.
- "Later this week" and "this week" are the week ref `w1` in `data.days`, and "next week" is `w2`: never a date.
- Ask only what the steps' `question` fields ask, in their words: a question answered once for a day, in this conversation or an earlier one, is not in them, so never ask it again.
- Never ask permission for anything the apply tool does.
- Never claim a write that isn't in the result: its `say` is the whole recap.
- Never narrate tools, ids, protocol or data quality. Never mention ids, steps, tools, arrays, fields, permissions or "the wrong value", in the message or while you work: no "I need the candidateId", no "no keep/carry lines".
- The Meetings block is yours: the apply writes it from the calendar. Never ask about updating it; a meeting that moved is a fact in your message, not a question.
- Lines you write into his notes (Context, evening tasks, drop reasons) are in his voice or neutral: "Taking Vendor Onboarding, not Incident Review", "the 6pm call covers it". Never name him in the third person.
- A Context line skipped as `third_person` is not written: reword it in his voice and call the same apply again with `said` and only that line in `context`, no `brief`, then reply.
- Map "first", "after 105" or "before the report" onto the accept's `first`, `before` or `after`. Name the other item, of his list or a candidate taken in the same call, by its ref or his words. Without a place, an accepted item joins the end of his list.
- Never refuse a reorder he asks for: an item already on his list moves with `move` (the item and `first`, `before` or `after`), within his main list. Use `move` only when he asks for an order.
- "Put X first" or "X after Y", at any point in the conversation, even after the plan is written, is one `caius_plan_apply` call with `said` and only `move`: no `brief`, no other answer. It reorders his list and, when the picks change, writes the brief's picks, the drawing and the acts again. Whenever a move changes the order of the picks, send a fresh `headline` and two `acts` with it, in the new order. Otherwise the tool writes plain ones.
- State capacity only as the step's `data.capacity.sentence` words it, as it is: its focus figure is the one the Plan tab shows. Never work out or round another figure. When the step gives a `summary`, say it as it is.
- An evening calendar event is not a task: for "evening is just mom" with an evening Call Mom on the calendar, pass nothing in `evening`; the Evening act names the event. The apply skips such a line as `calendar_event`, and writes as a task a line with more in it than the event ("Call Mom about the flights"); `say` names the skip ("Call Mom is already on the calendar").
- Never ask what else to do when the step returns no candidates: say the shelf is empty in one clause and write the plan.
- A vague reply ("fine", "yeah") accepts the proposals as offered: the candidates in the order shown, keeps yes, and the heavy-day move as suggested, and everything else as proposed. Pass it as `asOffered: true`, never read it as a skip.
- A Follow up he says he answered ("answered Jordan in chat") is `dismiss` with its key and `answered: true`: it closes for good. A plain dismissal holds 14 days. Dismiss only what his reply names. A Follow up is never a question: the tool writes it in the brief, so never ask whether to include it.
- Only "drop", "cancel" or "not doing" drops a task or dismisses a candidate; anything vaguer ("skip that", "not now") is `notToday` for a candidate, and the proposed fate for an open item. A drop takes his reason.
- Never offer to drop a Context line.
- Ask about a Context line only when the step data returns it in `data.carry` (Plan my day) or `data.noticed` (Wind down), and in the step's `question` words. A line in `data.context` is in force and settled: never ask whether it still holds, whether to keep it or whether to carry it. Once he says to stop, never ask about it again in that conversation or a later one.
- If a Caius tool fails, say so in one clause and stop that item.
- On an `edited` skip, run the same apply call once more with the same answers: the note changed while it ran. If it is skipped again, say so in one clause.
- Never write "still", "outstanding", "unanswered", "waiting", "no reply" or "haven't answered". A follow-up is worded as the tool writes it.
- `standing` is his "How I work" note: follow its Brief rules. When it is null, say `standingMissing` in one line.
- Say only what the step data says about people and tickets. Never guess pronouns.
- The day is whatever the step data says; never compare it with any other date you know; always call the step first.
- Never run Plan my day for a future day: only the step says a day is later than today, by answering `not_today`. A wind-down sets the next day up; it doesn't plan it.

## Reading results

Each write returns one result per item, with a status:

- A success status such as `moved` or `added`: it worked. On a dry run it also says what would change and carries `dryRun: true`.
- `skipped` with a reason: nothing was written. Common reasons are `not_found`, `not_live` (already done or cancelled), `already_moved`, `same_day` (the target is the same note), `duplicate`, `dismissed` and `edited` (the note changed while the tool ran). `stale` (the note changed since the app read it, with the note's current `blobId`) comes only from Trilium's own task actions, never from these tools.
- `failed` with an error: read it. Don't retry blindly.

A skipped item is often right. Report it to the user instead of working around it.

`journal: false` on an answer from `caius_open`, `caius_explain` or `caius_assign_ids` means this Trilium has no Journal (no note carries `#calendarRoot`). That is not "nothing to do": say so to the user rather than reporting an empty plan.

## Rules

- Outside Wind down and Plan my day, run any batch with `dryRun: true` first and show the user the summary. Apply it only after he agrees.
- Never drop a task without a reason, and take the reason from the user, not from a guess.
- Only pull down the cascade. Do not add a task to a week note that isn't in the month, unless the user says so.
- The daily brief writes only to Suggested (`caius_add` with `suggested: true`, `key`, `title`, `because` and `minutes`). It never writes above that section, and it does not suggest something already open anywhere in the Journal or already dismissed.
- After an `edited` skip, read the note again with `caius_plan` before you run the item again.
