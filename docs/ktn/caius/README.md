# Caius

Caius is the planner for the Journal in Trilium. It reads the day, week and month notes, works out which tasks belong in which lane (overdue, today, week, month and so on), and changes tasks for you: mark one done, forward it, drop it, accept a suggestion. It lives inside this fork, so it works from a right-click, from the Plan tab, from a phone, and from any AI agent connected to Trilium's MCP server.

The routes, the Plan tab and the task actions shipped in PR #12. The method behind it is in [method.md](method.md). How it works is in [internals.md](internals.md). The original design and spike reports are in [design/](design/).

## The Journal layout Caius expects

- Day, week and month notes found by label: `#dateNote=2026-10-27`, `#weekNote=2026-W44` (ISO weeks) and `#monthNote=2026-10`, under the note labelled `#calendarRoot`. Trilium's own calendar creates them.
- Tasks are to-do list items in those notes. A note counts as part of the Journal when it, or its direct parent, carries one of those labels.
- Top to bottom in a note: an optional **Important** block (the critical tasks), tasks in priority order under headings of your choosing, and a **Suggested** section last. Items under Suggested are not tasks until you accept them.
- Day and week notes can also have a **Meetings** and a **Context** section (a heading of any level named exactly that). Both hold plain bullets, and nothing under either is a task, even a to-do item: it never counts toward capacity, shows in a lane, forwards or triggers anything that counts live tasks. A section runs to the next heading of the same or a higher level, so a lower heading stays inside it; Meetings and Context also end at each other, and an empty heading is ignored. Adding or accepting a task under any heading inside them is skipped as `prose_section`, and the Plan tab's Accept list leaves those headings out. The Important block is the one exception, because it can sit below Context.
  - Meetings are clock lines, such as `- 10:00 Standup (Sasha, James)`. Planning rewrites only this block.
  - Context is what is known about the state of things, such as `- ZAP-2590 is open (until Fri 6 Nov)`. A line in a day note without an `until` holds on that day only; a week note's line holds all week. Two lines that differ only in case, spacing or trailing punctuation are the same line. A trailing `(until Fri 6 Nov)`, `(until 6 Nov)` or `(until 2026-11-06)` ends the line after that day, and `(from Thu 5 Nov until Fri 6 Nov)` or `(from Thu 5 Nov)` also holds it back until its first day; a weekday range written for a day ("Sam is out Thu–Fri") goes to the week note with both ends, looking forward (said on a Wednesday, "Mon–Tue" is next week's), and in Plan my day "tomorrow" is the next workday, named in the line and starting on it; and is that day's Heads-up when it starts; a date without a year is the next one on or after the note's date, or the previous one when that is over 300 days ahead (`(until 30 Dec)` in a 2 Jan note means last December). Any other suffix stays in the text.
- Estimates are `~30m` style tokens in the task text. A task without one counts as 30 minutes.
- Protected notes and notes labelled `#morningBrief` are skipped.

## The Task menu

Right-click a to-do item in a Journal note (browser or Electron). The menu gains a **Task** submenu. It shows only what applies to that item:

| Action | What it does |
|---|---|
| Doing | Sets the Doing state. Hidden if the task is already Doing. |
| Done | Checks the task off. |
| Forward ▸ Tomorrow / Next week / Next month / Pick a date… | Marks the task Rescheduled with a link to the target, and puts an open copy under the same heading in the target note. A Doing task stays Doing in the copy. Open sub-items come along. "Pick a date…" takes a day (`2026-10-29`), an ISO week (`2026-W45`) or a month (`2026-11`). |
| Drop… | Asks for a reason, then sets the task to Cancelled with the reason after it. |
| Accept ▸ (a heading, or Critical) and Dismiss | Only on items under Suggested. Accept moves the item up. Dismiss removes it and stops it being suggested again on that note. |
| Why is this here? | A toast with the task's lane and the rule behind it. |

Done, cancelled and rescheduled tasks only get "Why is this here?".

**The browser's own menu.** In a browser, Trilium normally shows its own right-click menu only on selected text. On a Journal task line it now always opens, so you lose the browser menu there, including spelling suggestions. Hold **Shift** while right-clicking to get the browser's menu back. Electron already replaces the menu everywhere, so nothing changes there.

**The brief read-only moment.** An action first makes every editor showing the note read-only, saves it, lets the server make the change, waits for the editor to reload the note, and then unlocks. It takes a fraction of a second. Keys pressed in that gap are dropped. If the editor has not loaded the change after a few seconds you get a toast to reload the note before typing, because saving the old text would undo the change.

## The mobile Task button

On a phone, in the server's mobile layout, a **Task** button is pinned to the front of the editor toolbar while the caret is in a to-do item of a Journal note. It is not there for bulleted items or for other notes. Tap it and the same actions open as a bottom sheet, with Forward and Accept as drill-in lists. Drop… and Pick a date… open a prompt at the bottom of the screen.

The button disappears for a moment during a write (the editor is read-only) and comes back. It is not available in the Capacitor app or the standalone build, which have no Caius routes.

## The Plan tab

On desktop, the right pane has a **Plan** tab. It follows the active note: a day, week or month note shows its period, and any other note shows the current period. The Day / Week / Month switch and the ‹ › buttons move between periods, and Today jumps back. It reloads when Journal notes change, with one `/api/caius/open` call per refresh, and reads nothing while the tab is hidden: it reads once when you show it. Each card collapses.

When the viewed period is a day, two buttons sit under the period bar: **Plan my day** and **Wind down**. Each opens the sidebar chat, starts a new conversation with note tools on, and sends the opener for that day by itself: `Plan my day 2026-11-04` or `Wind down 2026-11-04`. The chat that was open is left as it is, in the chat history. With AI features off there is no chat, and a toast says so; with no AI provider set up, the chat shows its "No AI provider configured" prompt and nothing is sent.

- **Capacity.** Time planned against the target, in hours and minutes ("3 h 40 m planned of 3–4 h"): 3–4 h for a day, 12–15 h for a week, none for a month. "N unestimated, counted at 30 m" opens a list of those tasks; click one to jump to it and add an estimate. An empty to-do item is not a task and is not counted. The `caius_plan` tool still returns capacity as numbers of minutes.
- **Context.** For a day only: the Context lines in force on it, as `caius_context` gathers them (`GET /api/caius/context?date=YYYY-MM-DD`), newest first. A line with an end reads "until Fri 13 Nov", and one that lapses before the next workday is marked "ends soon".
- **Suggested.** The Suggested items of the period, each with Accept (pick a heading, or Critical) and Dismiss. An item written as "Get X done: because Y (~30m)" shows "Get X done (~30m)" with "because Y" on a softer line under it.
- **Pull in.** Three lanes: Overdue, This week and This month, 20 rows each. A row's text opens the task in its note. Each row has an **Actions** menu. **Pull in** forwards the task into the period you are viewing; an editor open on that note is locked and reloaded along with the task's own note. **Done** marks the task done. **Drop…** asks why, then cancels the task with that reason. A finished row leaves the card when it reloads. Tasks already in this note are left out. A past period has no Pull in card, since nothing should be pulled into a closed note.
- **Close.** Offered for a past period, today from 15:00, and the current week or month. Every open task gets one fate. A past period offers Today first (This week or This month when closing a week or month), then Tomorrow, Next week, Next month and Drop (with a reason). Fates count from now, not from the period being closed, and the picker names the target note, such as "Today → 2026-10-27". The card counts "N of M decided". **Apply** writes them all in one go, and lists any task that was skipped. Apply is one request (`POST /api/caius/apply`): the forwards, then the drops. A task with open sub-items carries them along, so the sub-items are not listed on their own; a sub-item is told from its parent by the parent's list item id, so two tasks with the same text are not confused. Pushing a task to its project note is not offered yet.

## The nudge bar

Today's day note (today by the Caius clock) shows a slim bar under its journal navigation, on desktop in the new layout. It holds one state at a time:

| State | When | Bar | Actions |
|---|---|---|---|
| Catch-up | A workday since the last closed one still has live tasks, and today's catch-up has not been skipped | "Tuesday has 4 open tasks.", or "Tuesday and Wednesday have 5 open tasks." | **Move all to today**, **Review**, **Skip** |
| Not planned | No catch-up is due, and today has no Morning Brief, or its brief was planned on an earlier day | "No plan yet." | **Plan my day** |
| Planned | Today has a Morning Brief planned today | "Planned 08:40." ("Planned Fri 17:20." for a plan made on another day) | **Refresh** |

- **Move all to today** forwards those tasks to today in one request, with no chat, the way the Plan tab's Close does: today's note is locked and reloaded if it is open. A task without a list item id is counted but not moved; run the id backfill.
- **Review** starts `Wind down <oldest of those days>` in the sidebar chat.
- **Which days:** walking back from the last workday, at most five workdays, every day with live tasks until the first closed one. A day with no note or no tasks at all is passed over; a day is closed when it had tasks and has none live, or, with nothing live, was wound down (`caius_winddown_apply` labels it `#caiusWoundDown`), skipped from, or planned (it has a brief). A skip recorded on a day covered the days before it, so the walk stops after that day.
- **Skip** sets `#caiusSkipCatchup=<today>` on today's note, as `caius_skip_catchup` does, so the bar and Plan my day stop offering the catch-up.
- **Plan my day** and **Refresh** start `Plan my day <today>`.

The rules are those of Plan my day's `catchup` step and of `caius_brief_write`'s brief lookup, read through `GET /api/caius/nudge?date=YYYY-MM-DD`. The bar reads its state when the note opens, and again after a change to the last workday's note, a skip, or a brief written under today's note, including a Caius write from the chat. Typing in today's note doesn't make it read again, and a hidden bar reads nothing.

The **×** hides the bar on that note for the rest of the day. It doesn't skip the catch-up. The dismissal is kept in this browser's local storage, so another browser or device still shows the bar.

No bar shows on other notes, on past or future day notes, on a protected note, or while Caius is off.

## The dev clock

In a development server, set `TRILIUM_ENV=dev` and `CAIUS_NOW` to a local time such as `2026-11-06T17:30`, and Caius treats that as now: lanes, horizons, the Close card's "from 15:00" rule and the Plan tab's "today" all follow it. Anywhere else, including a production server that has `CAIUS_NOW` set, it uses the real time. A value that is not a local ISO time is ignored.

## Shortcuts

Six commands have **no default keys**; bind them in Options → Shortcuts (they are also in the command palette). Four act on the Journal task at the caret:

- Mark Task as Doing
- Mark Task as Done
- Forward Task to Tomorrow
- Drop Task (asks for a reason)

With the caret outside a Journal task you get "Put the caret in a task in a Journal note first".

Two start a planning conversation for today by the Caius clock, from anywhere, as the Plan tab's buttons do:

- Caius: Plan my day
- Caius: Wind down

## MCP and the AI assistant

Caius registers twenty-two tools on Trilium's `/mcp` endpoint (which needs an ETAPI token) and in the built-in AI assistant. Most writes take an `items` list and a `dryRun` flag; `caius_meetings`, `caius_context_add` and `caius_brief_write` take one change and `dryRun`; `caius_skip_catchup`, `caius_finished`, `caius_context_keep` and the two apply tools have no dry run, since the answer they carry is the yes.

| Tool | Does |
|---|---|
| `caius_plan` | Reads one day, week or month: sections, tasks, estimates, capacity, and its `meetings`, `context` and `expiredContext`. |
| `caius_open` | Lists open tasks across the Journal by lane, with `noteId`, `listItemId` and days late. |
| `caius_explain` | Says why a task is in its lane. |
| `caius_context` | Reads the Context in force for a day (`{ date }`): that day's note, the last three workday notes (their lines with an `until` only), the current week note and, on a Monday, last week's. Expired lines are dropped; the same text in two notes is returned once, from the newer. |
| `caius_inputs` | Reads the day's outside inputs: Jira hand-offs, asks and done checks, the calendar's events, and the capacity the meetings leave. Read-only; see below. |
| `caius_add` | Adds a task to a period under a heading, in the Important block, or under Suggested. |
| `caius_accept` | Moves a Suggested item up under a heading or into the Important block. |
| `caius_dismiss` | Removes a Suggested item and remembers it was dismissed. |
| `caius_set_state` | Marks tasks `done`, `doing` or `cancelled` (needs a reason). |
| `caius_forward` | Forwards tasks to a day, week or month. |
| `caius_assign_ids` | Gives every Journal list item an id; see below. |
| `caius_meetings` | Writes a day note's Meetings block: the lines given, or the day's calendar as clock lines. See below. |
| `caius_context_add` | Adds one Context line to a day or week note, with an optional `until`. See below. |
| `caius_brief_write` | Writes the day's Morning Brief and its header, and includes the header at the top of the day note. See below. |
| `caius_context_keep` | Writes the Context lines you kept or carried to the week note of the day planned or wound down to. |
| `caius_finished` | Records that a ticket you call finished stays off the candidates for 30 days. |
| `caius_skip_catchup` | Lets Plan my day leave the last workday's open tasks where they are, for one day. |
| `caius_winddown` | One step of the Wind down conversation. Read-only; see below. |
| `caius_planday` | One step of the Plan my day conversation. Read-only; see below. |
| `caius_plan_apply` | Every write of a Plan my day conversation, in one call, from your answers. See below. |
| `caius_winddown_apply` | Every write of a Wind down conversation, in one call, from your answers. See below. |
| `caius_header` | Draws the day as terrain and attaches it to a note as `terrain.svg`; see below. |

The **`caius` skill sheet** (`load_skill` with `caius`) teaches an agent the method, the tools, and how to run daily planning and shutdown. Only agents that can load it see it, and only while Caius is on.

On a dry run a write changes nothing and reports what it would do. Add `html: true` to get each note's full before and after HTML instead of a summary of the change. The skill tells agents to dry-run every batch and show you the summary first.

### `caius_inputs`

`{ date, context?, keys?, workStart?, workEnd?, refresh? }` returns `{ date, jira, calendar, capacity, errors }`. A ticket you closed lately (done or cancelled in a Journal note, dismissed, or called finished with `caius_finished`) or one Jira calls done is left out of `jira.handoff` and `jira.asks`, here and in every step's data, so asking what is in review never brings back finished work, and an ask on a Done ticket is never a follow-up. `context` is the day's Context lines. `keys` names more tickets to check for Done; the steps pass the keys in the week note's items and the Context lines. The work window defaults to 10:00–18:00. It reads no notes and writes nothing. A source that fails adds `{ source, error }` to `errors`, and the other still returns. Some entries are warnings and the source still answers: `asks_truncated` and `search_truncated` (a cap bit), `asks_partial` and `handoff_partial` (some tickets' comments or changelog failed), `involved_narrowed` (Jira rejected `comment ~ currentUser()`, so tickets you only commented on are not scanned for asks), and `feed_<n>_unknown_tz` (an event names a time zone its feed doesn't define, so it was read as local time).

- **`jira.handoff`:** your tickets in Code Review, Dev Verify, Ready For QA, QA Testing or Pending Feedback, with `daysInStatus`.
- **`jira.asks`:** comments from the last 7 days that mention you or end in a question and came after your own last comment on that ticket.
- **`jira.done`:** of the tickets in `handoff`, `asks` and `keys`, those whose resolution is set or whose status category is Done. `keys` are checked in one `key in (…)` search of at most 100 keys. Jira rejects the whole search when one key is unknown, so a rejected search is run again ten keys at a time, then key by key for a rejected ten, in at most 30 searches; a key rejected alone, or left unsearched, is dropped and `errors` says `done_partial`. A Context line that names a ticket and says it is open (for example "ZAP-2590 is open"; "not open", "isn't open" and "no longer open" don't count) marks it `overridden: true` and takes it out of `done`.
- **`calendar`:** the day's events with `start`, `end`, `title`, `attendees`, `allDay`, `declined`, `source` and, where two meetings overlap, `overlap`. `attendees` leaves you out (the `JIRA_EMAIL` and `CAIUS_USER_EMAILS` addresses). The same title and start in two feeds is one event.
- **`capacity`:** `{ windowMinutes, bookedMinutes, openMinutes, targetMinutes, bookedRatio }`. The target is 65% of the open time, at most 240 minutes.

The settings are in [internals.md](internals.md#caius_inputs).

## Wind down and Plan my day

Two conversations in the sidebar chat, run by the AI assistant with the Caius tools and the `caius` skill sheet. A conversation whose first message is an opener (`Plan my day 2026-11-04`, `Wind down 2026-11-04`) runs without the generic note tools that write (`set_note_content`, `edit_note_content`, `append_to_note`, `create_note` and the other mutating note, attribute, hierarchy and attachment tools), so every Journal write goes through Caius; the Claude agent provider passes them as `disallowedTools` when the session starts. Each starts from a short opener that names a day: `Wind down 2026-11-06` closes that day, and `Plan my day 2026-11-09` plans it. Caius holds the steps and the exact questions, so the wording is the same every time; the skill sheet tells the assistant how to run the conversation.

Each step is one call, `caius_winddown` or `caius_planday` with `{ date, step }`, and answers:

- `data`: the facts for that step.
- `question`: the exact text to ask, or `null` when there is nothing to ask; the step's writes are still made, dry run first.
- `next`: the step to call after it, or `null` at the end.
- `standing`: the note labelled `#assistantContext` (the standing note, "How I work") as markdown, or `null` with `standingMissing`, a one-line reason.

A refresh keeps the morning: the picks come from his list, a Follow up raised that day stays, and an overlap or the heavy day's move asked that day is not asked again (`#caiusAsked` holds its id too), so a Plan my day on a planned day asks only about what is new, or nothing, and redraws. A keep or carry line is asked about once: an apply tool records `#caiusAsked=<lineId>` on the day's note for every such line the step showed, whatever the answer, and the steps leave out a line asked that day or on the last workday. A week item put off with `notToday` comes back two workdays later.

Every field in a step's answer that holds a day or an ISO week has a display string beside it, named after it with `Label`: `targetDay: "2026-11-09"` comes with `targetDayLabel: "Mon 9 Nov"`, and `fate.forward: "2026-W47"` with `fate.forwardLabel: "the week of Mon 16 Nov"`. The skill sheet tells the agent to use these strings as given and never work out a weekday. Each candidate has a `candidateId` (its ticket key, or a hash of a week item's text), each keep or carry line a `lineId` (a hash of its text, so two copies of one line share it), and each open item its `listItemId`: the ids the apply tools take.

Nothing is kept between calls except what the notes hold, so calling a step again reads them again and a conversation that stopped can pick up where it was. The steps only read. Each conversation is one question set, then one apply call that makes every write from your answers; nothing goes into your main list except what you took, the catch-up you moved and the evening tasks you named.

**Wind down** closes `date` and works against the next workday after it (Friday → Monday), or against today when that day has already passed, as when the catch-up's Review winds down the oldest of several missed days:

1. **`open`.** One list of every live task in the day's note, the overdue ones and those in the day's week note. Each item has a proposed fate: the next workday for the day's and the overdue tasks. A week task stays in its week, or moves to the next week's note when the next workday is in another week (Friday → Monday). A sub-item goes with its parent. The older overdue tasks are counted (`olderCount`, from `oldestDate`) only on a Friday, or when the call passes `older: true` because you asked about them.
2. **`next`.** Candidates for the next workday's Suggested, each as "Get X done" with a `because`, `minutes` and `source`:
   - **Sources:** Jira hand-offs that aren't done ("sitting in Dev Verify for 3 days"), the latest ask on each ticket ("Sam asked on Wednesday"), and the next workday's week note items. A ticket a Context line says is open counts as not done.
   - **Left out:** anything whose key is already a live task anywhere in the Journal, already in that day's Suggested, or dismissed there, and anything he put off for that day (`#caiusNotToday=<candidateId>` on its note, from an apply tool's `notToday`), which comes back on the next workday. Only an explicit dismissal keeps a key off every list for 14 days. An ask a brief's Follow up raised stays on offer; only the Follow up leaves it out for 7 days.

   It also gives that day's planned work minutes against the capacity target (the evening's minutes apart, in `eveningMinutes`), the meetings that overlap, and whether the evening has a task (one under an Evening or Recharge heading). It asks only when the day is over capacity, a meeting overlaps another or the evening is empty, joining those questions into one. Otherwise `data.summary` says the day fits ("Monday holds 3 h 20 m of work against about 3 h 30 m of focus time. Fits."). When the calendar couldn't be read, the target is that of a day with no meetings, so the step neither asks about capacity nor says the day fits; `data.summary` says the capacity couldn't be judged.
3. **`context`.** The Context in force for the next workday. When a Context line in force today lapses before then and says a ticket is open, the step notices it, whatever Jira says, and asks "Keep '…'?". It also lists, as `carry`, every line in force today from a note the next workday won't read (the closing week's note after a Friday, last week's note after a Monday, a day note more than three workdays back) whose `until` is absent or on or after the next workday, unless that day already reads the same text. They are asked about in one question and, on a yes, written to the next workday's week note (`data.targetWeek`). "Anything to know for Monday?" comes last.

**Plan my day** plans `date`:

1. **`catchup`.** When the workdays since the last closed one still have live tasks, as the nudge bar counts them: "Friday has 2 open tasks. Move all to today, review them, or skip?", or "Tuesday and Wednesday have 5 open tasks…". `data.days` lists them, oldest first, and `data.oldestDay` is the one Review winds down. After `caius_skip_catchup` for the day, it no longer asks.
2. **`inputs`.**
   - **Candidates:** as in Wind down, but only what is new since the day's brief was last planned (`#caiusPlannedAt`).
   - **Meetings:** the Meetings block to write from the calendar, beside the current one.
   - **Questions:** one for each overlap. On a day over 60% booked, `forwardSuggestion` names the last task of the main list, with "The day is 69% booked. Move '…' to Thursday?".
   - **Carry:** the wind-down's carry check, run every morning whatever the catch-up answer was: lines in force on the last workday that today won't read, unless today already reads the same text, are in `data.carry` with "Keep '…' going?", for writing to this week's note (`data.targetWeek`).
3. **`brief`.**
   - **The day:** its span, from the standing note's Rhythm: standup (default 10:00) to bedtime (default 23:00), with work ending at 18:00 by default. A bedtime or end of work written without am or pm that would fall before standup, such as "Bedtime: 11:30", is read as the evening.
   - **The drawing:** the main list laid out in order in the gaps between meetings, 30 minutes for a task without an estimate, and the first task as the focus block. A task split around a meeting is labelled on its first part only. Calendar events in the evening (Call Mom, Climbing gym) are drawn as meeting dots, like any other.
   - **The rules:** the standing note's Brief rules section, word for word.
   - **The brief:** the input `caius_brief_write` takes, to fill in, with its Follow up section already written from `followUps`.
   - **Follow-ups:** each ask in `followUps` carries a `sentence`, written by Caius: `Jordan asked on Sunday: "The rollout note is now in the runbook…" (ZAP-105). If you already answered in Chat, dismiss this.` The excerpt is cut at a word after 100 characters.

`caius_inputs` is read once for a day and reused for 15 minutes, so a Plan my day right after a Wind down doesn't fetch again. An answer in which a source failed is not reused; one with only warnings (`*_partial`, `*_truncated`, `*_narrowed`, `*_unknown_tz`) is. `caius_inputs` itself goes through the same cache. `refresh: true` on `caius_inputs`, on a step or on `caius_meetings` fetches again. The work window passed to it is the Rhythm's standup and end of work.

### The apply tools

Each conversation ends in one apply call. The agent maps your reply to the ids in the step data (`candidateId`, `lineId`, `listItemId`), and a day you name to one of `data.days` (the workdays to the end of next week) or `data.weeks` (this week and next), and passes them; an id the step didn't show answers `not_offered` (or `unchanged` when the task is already closed, as on a re-run), and a day or week not listed answers `not_a_listed_day`; the tool makes every write, with no dry run, since you have answered. It answers `{ written, skipped }`: each entry names its `kind`, the id, and `status: "written"` or `"unchanged"`, and each skip a `reason` (`not_offered`, `not_found`, `review`, `calendar_unavailable`, `edited`…). Running it again with the same input changes no note.

- **`caius_plan_apply`** `{ date, catchup?, accept, keep, finished, notToday, dismiss, evening, context, forward?, brief: { headline, acts, sections } }`, in this order:
  - **The catch-up:** `move_all` forwards every task of the catch-up's days to `date`; `skip` labels the day as `caius_skip_catchup` does; `review` writes nothing (the oldest day's wind-down goes through them).
  - **Accepts,** in your order, each to the end of your list: a ticket through Suggested (added there first when it isn't), a week item by forwarding it to the day.
  - **Keeps:** each line to this week's note. Every keep or carry line, overlap and heavy-day question the step showed is recorded under `#caiusAsked`, whatever you answered.
  - **Finished** tickets, as `caius_finished` records them, on the day's note.
  - **Not today:** `#caiusNotToday=<candidateId>` on the day's note, and off its Suggested without a dismissal; it comes back on the next workday (a week item two workdays later).
  - **Dismiss,** only on your word: the candidate is dismissed from the day's Suggested, so the key is off every list for 14 days and its asks leave the Follow up.
  - **Every other offered ticket** goes to the day's Suggested.
  - **Evening** tasks under a `### Evening` heading, created after your tasks and above Suggested when missing; words already a live task of the day count as written.
  - **Context** lines, placed by `caius_context_add`'s rules. **Forwards** by `listItemId`. The **Meetings block** from the calendar.
  - **The brief:** the agent's headline, acts and extra sections; the picks are your list in its order (evening tasks apart, at most 5), with a candidate's reason where there is one; Follow up from the step's sentences and Heads-up from `headsUp`, in place of anything the agent wrote under those titles; the Evening act names the evening's events and tasks ("Call Mom, then Laundry."), the agent's words staying only for an empty evening; the drawing; the weather from the standing note. The answer carries `briefNoteId`, `link`, `headline` and `topPick`.
- **`caius_winddown_apply`** `{ date, done, fates, accept, keep, carry, finished, notToday, dismiss, evening, context }` closes `date` against the next workday:
  - **Done** items are marked done. **Fates** you named are a forward (`to`: a day, week or month) or a drop (`drop`: your reason, only when you said drop, cancel or not doing). **Every open item you didn't name** keeps the fate the `open` step proposed. A task sent to a week is put off there, so its week item comes back two workdays later.
  - **Accepts, keeps, carries,** finished, not today, dismiss, the other candidates to Suggested, evening tasks and Context lines all land on the next workday (keeps and carries in its week note).
  - The closed day is labelled `#caiusWoundDown`, so a later catch-up looks no further back.

### The write tools

- **`caius_meetings`** `{ date, items?, dryRun, refresh? }` replaces only the Meetings block.
  - **Default lines:** without `items`, they come from the day's calendar: `10:00 Standup (Sam, Riley)`, with up to four first names. Declined and all-day events are left out, a repeated line is written once, and a meeting that overlaps another ends in `(overlaps)`.
  - **A failed calendar:** when the calendar could not be read, it writes nothing and answers `calendar_unavailable`, so a failing feed never empties the block.
  - **A missing note:** it is created, except on a dry run.
- **`caius_context_add`** `{ date | week, text, until?, dryRun }` adds one plain bullet under `### Context`.
  - **The heading:** when the note has none, it is added below the Meetings block, else at the top below the header's include-note.
  - **A missing note:** it is created, except on a dry run.
  - **Expiry:** `until` is written as ` (until Fri 6 Nov)`, with the year only when it is needed to read the date right. An `until` before the note's date is refused.
  - **Duplicates:** text already in force is skipped as `duplicate`. For a day, that is anything `caius_context` returns for it, the week note's lines included.
  - **Keeping a line:** when the copy in force ends sooner than the `until` asked for, or the request has no `until`, the copy's `(until …)` is rewritten where it stands and the answer is `updated`, when that copy is in the note asked for. A copy in any other note, which can stop being read before the new date (an older day note, last week's note), is left alone and the line is written to the note asked for.
- **`caius_brief_write`** `{ date, headline, acts, picks, sections, header, latitude?, longitude?, dryRun }` writes the brief.
  - **The weather:** the coordinates come from the standing note's Rhythm (a location line such as `Location: 39.95, -75.17`), whatever the call passes; `latitude` and `longitude` count only when the note has none.
  - **The brief note:** a `🌅 Morning Brief` child of the day note, labelled `#morningBrief=<date>`, `#caiusPlannedAt=<local time>` and `#cssClass=briefdemo`.
  - **The header note:** the brief's `Header` child, with the same `#cssClass`. It holds the date line, the headline, the drawing (as `caius_header` draws it) and the three acts as a 3-column table.
  - **The brief's body:** the header's include-note, then "Get done today" with the picks as `Get X done: because Y (~30m)` lines, then each section rendered from markdown, with any image taken out, since section text can come from email or Jira.
  - **The day note:** gets one include-note of the header at the very top, only when it has none; nothing else in it changes. When the Header is new because the old brief or Header was deleted, the include-note of the old one at the top is replaced, not kept above the new one.
  - **Re-runs:** update the same notes and replace the planned time.
  - **Dry run:** creates nothing and returns the HTML it would write.
- **`caius_skip_catchup`** `{ date }` labels the day note `#caiusSkipCatchup=<date>`.

## The one-off id backfill

Actions find a task by its list item id. Newer items have one; about 87 older Journal items and plain bullets do not. Without an id, an item cannot be targeted, and the menu answers "Caius could not find this task".

`caius_assign_ids` adds the ids. It is a **dry run unless you pass `dryRun: false`**: the dry run lists, per note, how many items would get an id and their text. Run the dry run, look at it, then run it for real. It writes to the live Journal, so run it once, when you are ready. Caius also gives an id to any item without one in every note it writes, so only the notes it has never touched need the backfill.

### The day's drawing

`caius_header` draws the day as one line, from standup to bedtime: meetings raise it, planned work sits in labelled bars under it, the focus block is clay, and a faint divider marks where work ends (`workEnd`, default `18:00`). Give `latitude` and `longitude` and the day's weather from Open-Meteo shows as a small icon in the top-right corner; without them, or if the lookup fails, there is none. The drawing is saved as an image attachment named `terrain.svg` on the note you pass as `noteId`. A second call updates that attachment instead of adding another. The tool answers with the attachment id and the snippet to put in the note, `<img src="api/attachments/<id>/image/terrain.svg">`; it never changes the note's text.

## When Caius is off

If the Caius code fails to load, Trilium logs `Caius disabled: <reason>` in the server log and carries on. `/mcp` keeps its other tools. You will see:

- No Task submenu, and the browser's own menu on task lines.
- No Plan tab, no nudge bar and no mobile Task button.
- The six commands toast "Caius is off, so task actions are unavailable."
- `/api/caius/*` answers `503 caius_unavailable`, and `/api/caius/status` answers `{ "enabled": false, "detail": … }`.

The failure is remembered until the server restarts. Find the reason in the server log, fix it and restart.

A document with no `#calendarRoot` (no Journal) is not "off": Caius is running, and the Plan tab shows empty lanes instead of errors. The tools mark such answers `journal: false`, so an agent can say there is no Journal instead of reporting that you have no tasks.

## Troubleshooting

- **"The note changed while Caius was writing to it. Try again."** (`stale`) The note was saved between the client reading its version and the server writing. Caius retries once by itself; if you still see this, act again.
- **`edited` ("…so nothing was written")** Something else changed the note while the tool ran. Nothing was written. Read the note again and repeat the action.
- **"Caius could not find this task in the saved note. Save the note and try again."** The task has no id, or the note was not saved. Wait a second and retry. If it keeps happening, the task is an older one: run the id backfill.
- **"Caius didn't answer in time. The change may still arrive; wait a moment before typing in this note."** The save or the request took over 10 seconds. The write might still land and reload the note, so give it a moment.
- **"Caius changed the note, but the editor did not load the change. Reload the note before typing in it."** Reload the note.
- **"This task is already open elsewhere in the Journal"** (`duplicate`) or **"…dismissed from this note before"** (`dismissed`). Expected from `caius_add`; nothing was written.
- **A Task menu that does not appear.** The item must be a to-do item in a Journal note, in an editable editor. Check the Caius-off list above.
