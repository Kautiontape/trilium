# Caius

Caius is the planner for the Journal in Trilium. It reads the day, week and month notes, works out which tasks belong in which lane (overdue, today, week, month and so on), and changes tasks for you: mark one done, forward it, drop it, accept a suggestion. It lives inside this fork, so it works from a right-click, from the Plan tab, from a phone, and from any AI agent connected to Trilium's MCP server.

The routes, the Plan tab and the task actions shipped in PR #12. The method behind it is in [method.md](method.md). How it works is in [internals.md](internals.md). The original design and spike reports are in [design/](design/).

## The Journal layout Caius expects

- Day, week and month notes found by label: `#dateNote=2026-10-27`, `#weekNote=2026-W44` (ISO weeks) and `#monthNote=2026-10`, under the note labelled `#calendarRoot`. Trilium's own calendar creates them.
- Tasks are to-do list items in those notes. A note counts as part of the Journal when it, or its direct parent, carries one of those labels.
- Top to bottom in a note: an optional **Important** block (the critical tasks), tasks in priority order under headings of your choosing, and a **Suggested** section last. Items under Suggested are not tasks until you accept them.
- Day and week notes can also have a **Meetings** and a **Context** section (a heading of any level named exactly that). Both hold plain bullets, and nothing under either is a task, even a to-do item: it never counts toward capacity, shows in a lane, forwards or triggers anything that counts live tasks. A section runs to the next heading of the same or a higher level, so a lower heading stays inside it; Meetings and Context also end at each other, and an empty heading is ignored. Adding or accepting a task under any heading inside them is skipped as `prose_section`, and the Plan tab's Accept list leaves those headings out. The Important block is the one exception, because it can sit below Context.
  - Meetings are clock lines, such as `- 10:00 Standup (Sasha, James)`. Planning rewrites only this block.
  - Context is what is known about the state of things, such as `- ZAP-2590 is open (until Fri 6 Nov)`. A trailing `(until Fri 6 Nov)`, `(until 6 Nov)` or `(until 2026-11-06)` ends the line after that day; a date without a year is the next one on or after the note's date, or the previous one when that is over 300 days ahead (`(until 30 Dec)` in a 2 Jan note means last December). Any other suffix stays in the text.
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

- **Capacity.** Minutes planned against the target: 180–240 for a day, 720–900 for a week, none for a month. "N unestimated, counted at 30 min" opens a list of those tasks; click one to jump to it and add an estimate.
- **Suggested.** The Suggested items of the period, each with Accept (pick a heading, or Critical) and Dismiss.
- **Pull in.** Three lanes: Overdue, This week and This month, 20 rows each. A row's text opens the task in its note. The **→** button forwards the task into the period you are viewing; an editor open on that note is locked and reloaded along with the task's own note. Tasks already in this note are left out. A past period has no Pull in card, since nothing should be pulled into a closed note.
- **Close.** Offered for a past period, today from 15:00, and the current week or month. Every open task gets one fate. A past period offers Today first (This week or This month when closing a week or month), then Tomorrow, Next week, Next month and Drop (with a reason). Fates count from now, not from the period being closed, and the picker names the target note, such as "Today → 2026-10-27". The card counts "N of M decided". **Apply** writes them all in one go, and lists any task that was skipped. Apply is one request (`POST /api/caius/apply`): the forwards, then the drops. A task with open sub-items carries them along, so the sub-items are not listed on their own; a sub-item is told from its parent by the parent's list item id, so two tasks with the same text are not confused. Pushing a task to its project note is not offered yet.

## The dev clock

In a development server, set `TRILIUM_ENV=dev` and `CAIUS_NOW` to a local time such as `2026-11-06T17:30`, and Caius treats that as now: lanes, horizons, the Close card's "from 15:00" rule and the Plan tab's "today" all follow it. Anywhere else, including a production server that has `CAIUS_NOW` set, it uses the real time. A value that is not a local ISO time is ignored.

## Shortcuts

Four commands act on the Journal task at the caret. They have **no default keys**; bind them in Options → Shortcuts (they are also in the command palette):

- Mark Task as Doing
- Mark Task as Done
- Forward Task to Tomorrow
- Drop Task (asks for a reason)

With the caret outside a Journal task you get "Put the caret in a task in a Journal note first".

## MCP and the AI assistant

Caius registers eleven tools on Trilium's `/mcp` endpoint (which needs an ETAPI token) and in the built-in AI assistant. Writes take an `items` list and a `dryRun` flag.

| Tool | Does |
|---|---|
| `caius_plan` | Reads one day, week or month: sections, tasks, estimates, capacity, and its `meetings`, `context` and `expiredContext`. |
| `caius_open` | Lists open tasks across the Journal by lane, with `noteId`, `listItemId` and days late. |
| `caius_explain` | Says why a task is in its lane. |
| `caius_context` | Reads the Context in force for a day (`{ date }`): that day's note, the last three workday notes, the current week note and, on a Monday, last week's. Expired lines are dropped; the same text in two notes is returned once, from the newer. |
| `caius_inputs` | Reads the day's outside inputs live: Jira hand-offs, asks and done checks, the calendar's events, and the capacity the meetings leave. Read-only; see below. |
| `caius_add` | Adds a task to a period under a heading, in the Important block, or under Suggested. |
| `caius_accept` | Moves a Suggested item up under a heading or into the Important block. |
| `caius_dismiss` | Removes a Suggested item and remembers it was dismissed. |
| `caius_set_state` | Marks tasks `done`, `doing` or `cancelled` (needs a reason). |
| `caius_forward` | Forwards tasks to a day, week or month. |
| `caius_assign_ids` | Gives every Journal list item an id; see below. |

The **`caius` skill sheet** (`load_skill` with `caius`) teaches an agent the method, the tools, and how to run daily planning and shutdown. Only agents that can load it see it, and only while Caius is on.

On a dry run a write changes nothing and reports what it would do. Add `html: true` to get each note's full before and after HTML instead of a summary of the change. The skill tells agents to dry-run every batch and show you the summary first.

### `caius_inputs`

`{ date, context?, workStart?, workEnd? }` returns `{ date, jira, calendar, capacity, errors }`. `context` is the day's Context lines. The work window defaults to 10:00–18:00. It reads no notes and writes nothing. A source that fails adds `{ source, error }` to `errors`, and the other still returns. Some entries are warnings and the source still answers: `asks_truncated` and `search_truncated` (a cap bit), `asks_partial` and `handoff_partial` (some tickets' comments or changelog failed), and `feed_<n>_unknown_tz` (an event names a time zone its feed doesn't define, so it was read as local time).

- **`jira.handoff`:** your tickets in Code Review, Dev Verify, Ready For QA, QA Testing or Pending Feedback, with `daysInStatus`.
- **`jira.asks`:** comments from the last 7 days that mention you or end in a question and came after your own last comment on that ticket.
- **`jira.done`:** of the tickets in `handoff` and `asks`, those whose resolution is set or whose status category is Done. A Context line that names a ticket and says it is open (for example "ZAP-2590 is open"; "not open", "isn't open" and "no longer open" don't count) marks it `overridden: true` and takes it out of `done`.
- **`calendar`:** the day's events with `start`, `end`, `title`, `attendees`, `allDay`, `declined`, `source` and, where two meetings overlap, `overlap`. The same title and start in two feeds is one event.
- **`capacity`:** `{ windowMinutes, bookedMinutes, openMinutes, targetMinutes, bookedRatio }`. The target is 65% of the open time, at most 240 minutes.

The settings are in [internals.md](internals.md#caius_inputs).

## The one-off id backfill

Actions find a task by its list item id. Newer items have one; about 87 older Journal items and plain bullets do not. Without an id, an item cannot be targeted, and the menu answers "Caius could not find this task".

`caius_assign_ids` adds the ids. It is a **dry run unless you pass `dryRun: false`**: the dry run lists, per note, how many items would get an id and their text. Run the dry run, look at it, then run it for real. It writes to the live Journal, so run it once, when you are ready. Caius also gives an id to any item without one in every note it writes, so only the notes it has never touched need the backfill.

## When Caius is off

If the Caius code fails to load, Trilium logs `Caius disabled: <reason>` in the server log and carries on. `/mcp` keeps its other tools. You will see:

- No Task submenu, and the browser's own menu on task lines.
- No Plan tab and no mobile Task button.
- The four commands toast "Caius is off, so task actions are unavailable."
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
