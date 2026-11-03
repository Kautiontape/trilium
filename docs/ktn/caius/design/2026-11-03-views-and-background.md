# Views Caius can show, and a chat that keeps going in the background

Written 2026-11-03, after Shawn's first evening with the phone. Two asks:

- **Show, don't just say.** Caius said a day was "well above the target" and nothing on screen showed why, or let Shawn do anything about it. "I need a way to see why and how, and controls that both visualize what's happening on the day and let me toggle to move things." More widely: Caius should pick, from about a dozen ways to present, the one that fits what Shawn asked, and Shawn should be able to steer the day from it.
- **Keep going when hidden, and minimize.** A reply stops when the app is hidden: the server only streams it and the phone saves the transcript, so a paused WebView loses it. "Some way to make this work even when hidden or minimized is huge. Some way of minimizing it so I can see the updates and then jump back to talk to it."

## The ontology

What Shawn's planning is made of, as the code holds it on 2026-11-03. The views (decision 3) are drawn from this.

### The entities

| Entity | What it is | Where it lives |
|---|---|---|
| **Period** | A day, an ISO week or a month, by key. A day is a workday or not, planned (it has a brief) or not, wound down or not, and rolls over at the Rhythm's rollover (04:00). | A Journal note; a period with no note reads as empty. |
| **Block** | Morning, Afternoon, Evening: a window of the day from the Rhythm (standup, noon, end of work, bedtime). | A heading on the day note. |
| **Area** | Foundation, Growth, Recharge, each with a day target: 3–4 h, 1–2 h, at least one thing. | A marker on the task's line; none for Foundation. |
| **Task** | A line Shawn means to do. It has a state (open, doing, done, cancelled, moved), an estimate (30 min when it has none), an area, a block, a clock when pinned, Important or not, sub-items, and a place in its note: the list (its order is the priority, the first three are the Top 3), On deck, or Suggested. | A to-do item in a period note, with a `listItemId`. |
| **Trail** | A task's moves. Each forward leaves a moved copy and links it to the next ("from …", "scheduled …"). The moves off day notes are its slips; three or more offer a park in a month. | The links; only `staleItems` counts them. |
| **Origin** | Where a task's words came from: the note, the headings and the item it sat under. | `originOf`, from the first copy. |
| **Ticket** | A Jira issue: key, summary, status, days in a hand-off status, asks (comments that ask Shawn something), done. It isn't a task until taken; a task names it by its key. | Jira, read by `caius_inputs`. |
| **Meeting** | A calendar event: start, end, title, attendees, declined, overlapping. | The iCal feeds, copied as plain lines into the day's Meetings block. |
| **Capacity and load** | The work window less the meetings, the focus figure it leaves (the Rhythm's Foundation target, less when the meetings leave less), and each area's minutes against its target. | Worked out on each read: `dayCapacity`, `focusOf`, `loadOf`, `growthOf`, `plan.capacity`. |
| **Context line** | A fact in force for a while ("Sam is out", "ZAP-2590 is open"), with `from` and `until`. It can override Jira; in the areas design, a day off has no Foundation target. | A bullet under Context on a day or week note. |
| **Project** | An active note with a `#priorityGroup` (Growth or Recharge), ordered by `#priority`; its first open item is its next step. | Outside the Journal. |
| **Candidate** | Something offered for a day: a Jira hand-off or ask, a week item, or an hour of a project. It has a reason and a size; taken, it becomes a task. | Worked out by the steps. |
| **Disposition** | What Shawn said about a candidate's key: dismissed (14 days), finished (30), not today, done or dropped lately (14). | Labels on period notes. |
| **Follow-up** | A Jira ask written into the brief, not raised again for 7 days, closed when answered. | The brief and `#caiusRaised`. |
| **Brief** | A day's plan written down: headline, picks, groups, meeting names, Follow up and Heads-up, and the drawing with the weather. | A child of the day note. |
| **Group** | A run of related tasks on the day's list with a name of 10 characters or fewer: one hill on the drawing. | `#caiusGroups` on the brief. |
| **Rhythm** | The day's edges, the rollover, the targets and the coordinates; the Brief rules beside it bind the brief. | The standing note. |
| **Ritual** | Plan my day and Wind down: steps that read, one message, one apply that writes. The steps work out the proposed fates, held items, overlaps, the heavy-day move and the parks. | Server steps; only labels are kept. |
| **Lane** | A task's horizon across the Journal: overdue, today, week, orbit, planning ahead, someday, suggested. | Worked out by `caius_open`. |
| **Fate** | What happens to a task at a choice: done, a day (its list, On deck or Important), the week, a month, or drop with a reason. | The verbs of the write tools. |

Reminders are the phone's alone and never reach the server.

### How they relate

- A period holds tasks in three places (the list, On deck, Suggested), its Meetings block and its Context lines; a day also holds blocks and a brief.
- The cascade runs down, month to week to day. A week's own items stay on the week note until pulled to a day, so a week is its note plus its seven days, not the sum of them. Most future days have no note yet.
- A forward copies a task to another period and leaves the moved copy behind. The trail is the only thing that joins the copies.
- Area and block are independent: the area says what for, the block says when. Foundation counts against the focus figure, Growth against its own target, and Recharge only has to be there. A Growth or Recharge task pinned to a clock in work hours books its time like a meeting.
- Meetings and the Rhythm make the capacity. The brief's groups lay the list out around the meetings (`layoutGroups`); what doesn't fit before bedtime is `unplaced`.
- A ticket meets the Journal only through its key: a task that names it, a candidate that offers it, a follow-up that quotes its ask, a Context line that overrides its status, a disposition that holds it off.
- A project meets the day through a pick, an hour of its next step, which becomes a marked task when taken.
- A ritual reads all of this for one day, proposes a fate for each thing that needs one, and writes the answers in one call.

### The questions Shawn asks

From the asks quoted above, the areas design and the skill sheet's Ask section:

1. **Why is this day over, and what can go?** "This is well above the target. Uh, okay." The load by area, the items behind it, and the moves that bring it under.
2. **What does the day look like, and where does each thing sit?** "A printout of the day", "visualize what's happening on the day and let me toggle to move things." Meetings, blocks and tasks in time.
3. **Do I have time for myself?** "My work is not my whole life … I need time to schedule for myself." Growth and Recharge beside the work, for a day and across the week.
4. **What does the week look like, and which day has room?** A choice between days.
5. **What's going on with this one?** One task or ticket: where it is, where it has been, what Jira says.
6. **What slipped, and what keeps slipping?** The skill sheet's "what slipped this week?". Tasks with a long trail, and the overdue lane.
7. **These tickets, and nothing else.** "I'm talking about fucking tickets. I need it to stay focused on what I'm saying." Whatever Shawn is talking about is the whole answer.

The gist rule ("Trilium was bumped to a newer version") holds for every answer. A view carries the exact figures, so the line around it doesn't have to.

### Where the tools fall short

Recommendations only; decisions 5 and 6 take up the ones the views need.

1. **The figures that answer "why" exist only inside the steps.** The load, the focus figure, Growth's load, the proposed fates, the slip counts, the `unplaced` minutes and the candidates are worked out in `caius_planday`'s and `caius_winddown`'s steps. In an Ask, Caius has `caius_plan` and `caius_inputs` and is told never to work out a figure, so it can't say why a day is over. Recommend reads shaped around things: a **day read** (plan, meetings, capacity, load by area, layout, slips) and an **item read** (task, trail, origin, ticket), used by the steps, the views and Today alike.
2. **"Over" means two things.** Today's card and the Over capacity notification put the list's Foundation minutes against a fixed 3–4 h (`plan.capacity`, whose targets `plan-read.ts` hard-codes, reading neither the meetings nor the Rhythm's Capacity line). The chat puts the list plus On deck plus what the leftovers bring against a figure the meetings shrink (`loadOf`). A day can be over in the chat and fine on Today. Recommend one figure everywhere: the list's Foundation minutes against the focus figure, with On deck shown apart as what it would add.
3. **Nothing moves a task within its day.** `caius_forward` skips a move to the same note (`same_day`), and the applies' `move` only reorders within one list. So, outside Plan my day's apply, nothing moves a task from Morning to Afternoon or between the list and On deck. Nothing changes an estimate either, though a smaller estimate is the cheapest way out of "over". Recommend two writes: **place a task in its day** (a block, the list or On deck, before or after another) and **set an estimate**.
4. **Reads that don't exist.** An item's trail (only Wind down's park counts it). One ticket by key with its status and last comments (`readJira` reads Shawn's involved tickets and checks keys for done, nothing more). Several days at once (a week takes seven `caius_plan` and seven `caius_inputs` calls). Why a key isn't offered (nothing reads the dispositions back).
5. **Placing a task is spread over five tools**, each with its own rules: `caius_add` (five placement modes), `caius_accept`, `caius_forward`, and the applies' `move`, `accept` and `onDeck`. The views need one vocabulary, the fate menu, mapped onto them (decision 6).
6. **Smaller overlaps.** Meetings are read twice, as calendar events and as the Meetings block's plain lines (`PlanView.meetings`); a timeline reads the events. The drawing has three writers (`caius_header`, `caius_brief_write`, `caius_plan_apply`); `caius_header` draws what both brief writers already draw, fed only by the brief step's `header`, and could leave the tool list. The skill sheet's Daily planning and Daily shutdown sections are an older procedure beside the rituals, still weighing the list against 180 to 240 by hand. And four things answer "what next": the brief's picks (list tasks with a reason), the project picks (which are candidates), the Top 3 and the phone's Now. Recommend "pick" mean only the brief's, and a project's offer be a candidate like the others.

## Decisions

### Views

1. **A catalogue of views the phone knows how to draw.** Caius picks one with a tool and passes the data; it never writes markup. Each view is designed once, works the same every time, and is tested. Rejected: building blocks Caius arranges (inconsistent), generated UI (slow, unsafe to wire taps back).
2. **Taps gather, then send.** As on the step cards: a move in a view goes into the answers pill ("ballot → Monday, garage shelf → the week"), the view shows the result straight away (its meters update), and Send gives the answers to Caius, who applies them in one call. Undo is before Send. Rejected: writing on each tap (Caius doesn't see the choice), writing and posting a line (noisy).
3. **The first views: four, from Shawn's four.** Why it's over and the day board become one view, **Day**. Shawn's ask is one thing, "a printout of the day" that shows why and lets them move things, and the two showed the same tasks and meters with the same controls. Apart, Caius would have to guess which half was wanted, and a move on the board would change a meter shown on the other view. Ranges stays as **Days**, with a row for the week note and the Growth and Recharge figures, which answer "time for myself". One item up close stays as **Item**. **Slipping** is added: the doc's "leftovers triage", and the skill sheet's "what slipped this week?".

   | View | Question it answers | Controls |
   |---|---|---|
   | Day | Why is this day over, what does it look like, where can each thing go? | Fate menu, block, estimate, area |
   | Days | What does the week look like, which day has room, any time for me? | Fate menu with the shown days; a week item to a day |
   | Item | What's going on with this one? | Fate menu, estimate, area; for a ticket: take, finished |
   | Slipping | What slipped, and what keeps slipping? | Fate menu with Park |

   **Day.** Arguments: a date and, optionally, the area to open on.
   - On it:
     - The three area meters: Foundation against the focus figure, Growth against its target, Recharge as a dot per thing, empty when there is none.
     - The day's timeline: meetings as dots, Morning, Afternoon and Evening, the groups as hills, and what doesn't fit before bedtime.
     - The tasks as rows by block, then On deck.
     - A line for each Context line that bears on the day.
   - Controls: each row opens the fate menu: Done; Morning, Afternoon or Evening; On deck (or onto the list, for an On deck row); the next workday; a day; the week; Drop, with a reason. The menu also sets the estimate (15 min, 30 min, 1 h, 2 h) and the area. The meters and the timeline redraw after each tap. A block changes when a task happens, not how much the day holds: it moves a hill, not the Foundation meter. The moves that bring Foundation under are another day, On deck, the week, Drop and a smaller estimate.
   - Data: the day read (shortfall 1): `readPlan` for the day, the calendar and the Rhythm from `dayRead`, `layoutGroups` with the brief's groups (`drawnNamesOf`), the one "over" figure (shortfall 2), and the slip counts from the trail read.
   - Shown for "why is it over?", "what does Tuesday look like?", "show me today", "where would the ballot fit?". Caius opens it on the area that is over, when one is.

   **Days.** Arguments: a first day and how many (2 to 7).
   - On it:
     - The days as columns, each with its meeting hours and the three areas' minutes (▲ over, ○ no Recharge).
     - A Week row with the week note's items not yet on a day, and the week's Foundation total against 12–15 h.
     - Two days show their rows side by side. More show a grid, and a tap on a cell opens that day's rows in that area under it.
   - Controls: the fate menu on a row, with the days shown as its day choices. A week item can go to a day.
   - Data: the day read's figures for each day (one calendar read per day, through the 15-minute cache) and the week's `readPlan`, under one lock. A future day with no note has its meetings and nothing else.
   - Shown for "what does my week look like?", "Monday or Tuesday?", "when can I fit this in?", "do I get any time for myself this week?", and when Shawn asks where a move Caius proposed would land. It shows each day's areas; it doesn't weigh them against each other (the areas design leaves that for later).

   **Item.** Arguments: a task (its ids or a ref) or a ticket key.
   - On it:
     - The task row as it stands: where it is now, its area, estimate and state.
     - Its trail: each day it sat on and what happened there ("moved on from Monday, then Tuesday; on Wednesday now").
     - Its origin.
     - For a ticket, the ticket card: Jira status and how long it has been in it, the assignee, and the last comment or ask. It also shows the Context lines that name the key, and whether Shawn finished, dismissed or put the ticket off.
     - A ticket with no task gets the card alone.
   - Controls: the fate menu, estimate and area. For a ticket with no task: take it to today, a day or the week, or Finished.
   - Data: the task from `readPlan` or `caius_open`, the trail read and `originOf`, a ticket read by key with its comments, the Context in force, and the dispositions.
   - Shown for a question about one named task or ticket: "what's going on with ZAP-2640?", "why does the garage shelf keep moving?".

   **Slipping.** Arguments: none, or a period.
   - On it: the open tasks with two moves or more, the longest trail first, each a task row with its count, then the overdue lane's count by age.
   - Controls: the fate menu, with Park (the month), which only Wind down offers today.
   - Data: `caius_open`'s overdue lane and the trail read for every open task.
   - Shown for "what slipped?", "what keeps getting pushed?", and Friday's older backlog when Shawn asks about it.

   **Item types**, the cards for one thing that recur across views:
   - **Task row:** the words without marker or clock, an area dot, the estimate, the clock when pinned, the Important mark, the slip count from 2, and a status chip when it names a ticket. On Day, Days, Item and Slipping. The phone's `TaskRow` grows these.
   - **Area meter:** minutes against the target, ▲ over, and the pending moves' result as a ghost. Full size on Day, one per cell on Days.
   - **Meeting:** a dot on the timeline with its short name (Day); meeting hours per day (Days).
   - **Ticket card:** key, summary, status and days in it, the last comment or ask. On Item, and as a chip on a task row.
   - **Context line:** the text and its until. On Day (the lines bearing on the day) and Item (the lines naming the key).
   - **Fate menu:** the one control, the same on every row: the menu of the areas design (decision 16), with blocks, the estimate and the area added.

   Not in the first views: **Tickets** (what Jira has handed Shawn, as a list). Item covers one ticket and the ritual cards cover the hand-offs. A list earns its place once Shawn asks about tickets as a set outside a ritual. "Meetings vs open time" is Day's timeline, and the follow-ups are on the brief and on Item. Each new view is a new entry in the catalogue, not a new mechanism.
4. **A view answers a question about that thing, and nothing else.** Caius shows one when Shawn asks about a load, a day's shape, a choice between days, an item or the slips, and the answer would run to three items or more. A single fact is just said. "Show me" always gets one. At most one view per reply, with one line around it in gist: the figures are on the view. Caius never puts a view beside a ritual's rundown and never shows one unprompted. In a ritual, a view comes only when Shawn asks about the load or an item after the rundown. When Shawn moves on to something else, the next reply doesn't bring the view back. The skill sheet holds the guide: the table in decision 3.
5. **One tool: `caius_show`.** `{ view: "day" | "days" | "item" | "slipping", date?, from?, count?, item?, area? }`. It reads only. Its data comes from reads shaped around things (shortfall 1), which the steps and Today move onto too, so the figure on a view is the figure in Caius's sentence and on Today. The new reads are the day read, an item's trail, one ticket by key, and a reader for several days built on the day read. Every row carries its `noteId` and `listItemId`, and a ticket its key, so Caius can map the pill's sentences onto writes in an Ask, where no step has given refs.
6. **Answers are words Caius already understands; two writes are new.** A view's taps become sentences in the pill, like the cards' ("Garage shelf goes to the week.", "The ballot goes in the afternoon.", "ZAP-2611 is 30 minutes."), and Caius makes them with these tools:

   | Tap | Tool |
   |---|---|
   | Done | `caius_set_state` |
   | A day, the week, Park | `caius_forward`; a day takes it On deck unless Shawn picks the list |
   | Drop | `caius_set_state` cancelled, with the reason typed in the menu |
   | Area | `caius_set_area` |
   | Take a ticket | `caius_add` to that day, On deck unless Shawn picks the list |
   | Finished | `caius_finished` |
   | Morning, Afternoon, Evening; On deck or the list, on the same day | new: place a task in its day |
   | Estimate | new: set an estimate |

   This replaces "no new write path": the board's main tap, another block, has no tool today (shortfall 3), and cutting it would leave Day unable to do what Shawn asked. Both new writes take a list of items and refuse a note that changed under them, like `caius_set_area`. A view's answers go through these tools in a ritual too. A ref in the step data whose item a view moved comes back `stale` from the apply, and Caius asks about that item, as it does now.

### Background and minimize

7. **The server owns a turn.** A turn runs on the server to the end whether or not the phone is watching, and the server saves the transcript to the chat note as it goes (today the phone saves it). The phone streams while it is open; when it comes back, it reads the saved turn and reattaches to the live stream if the turn is still running. Closing or killing the app loses nothing.
8. **While a turn runs, an ongoing notification.** "Caius is thinking…" with the latest line, kept up to date. It is an Android foreground service, so the app stays alive to stream while hidden; the server-owned turn is the safety net when it doesn't.
9. **Reply from the notification.** When the turn finishes, the notification turns into "Caius replied: <first line>" with Android's inline reply and an Open action. A reply sent there starts the next turn on the server like a message from the app.
10. **An in-app mini bar.** The chat can be minimized (a swipe down, or a button by Close) into a slim bar above the bottom tabs, showing whether Caius is working and its latest line. Shawn uses Today and Plan as normal and sees updates land; a tap opens the chat again. Answers gathered in the pill are kept while minimized. Rejected for now: a floating bubble over other apps (needs the overlay permission; most work).

## Where the code goes

- **Views.** A `caius_show` tool in `apps/server/src/services/caius/tools.ts` with a reader per view in a new `views.ts`. The phone gets `screens/views/` with one component per view, picked by `stepOf`-style parsing of the tool result in `lib/chat.ts`, and answers in `lib/replies.ts` beside the cards'. `TaskRow` gains the area dot, the slip count and the ticket chip.
- **The day read.** `capacityOf`, `loadOf`, `growthOf` and `workBlocks` in `daily.ts` gather into one read of a day that the steps, `caius_show` and Today's data all call. The load arithmetic (`focusOf` and the sum) moves to `packages/caius/src/daily/`, so the phone redraws a meter after a tap with the server's own figure. Today's capacity card and `notify.ts`'s overcap read the one "over" figure.
- **The trail.** `timesForwarded` and `staleItems` in `daily.ts` become a read of one item's copies and of every open item's count.
- **One ticket.** A read of one key in `inputs/jira.ts`: the issue and its last comments.
- **The two writes.** Placing a task in its day in `packages/caius/src/trilium/plan-html.ts`, moving an item between a day's block lists and On deck and making the heading when missing, as `caius_add` does. Setting an estimate replaces the `~` token. Both go in `service.ts` with `caius_set_area`'s compare-and-swap, with schemas and tool words.
- **Skill sheet.** The table of decision 3, the rule of decision 4, and the tap-to-tool table of decision 6.
- **Server-owned turns.** `routes/api/caius_chat.ts` starts a turn as a job: the provider's chunks go to the client and, through `applyChunk`-equivalent assembly, to the chat note (`saveChatContent`), throttled. A `GET` returns a chat's saved turn and whether it is still running, and a reattach stream continues from an offset. The phone's `useChat` reads it on resume (`App` `resume` event).
- **Notification.** A Capacitor foreground-service plugin while a turn streams; `@capacitor/local-notifications` (already used) for the finished one with an input action; the reply posts to the chat route from the action handler.
- **Mini bar.** `app-state.ts` keeps the open chat when minimized; a `MiniChat` bar in `App.tsx` above the tabs.

## Order

1. Server-owned turns, then the mini bar and notifications on top (reliability first; the rest needs it).
2. The day read and the one "over" figure, with Today and the notification moved onto it. Then the two writes. Then `caius_show` with **Day**, then **Item** (with the trail and ticket reads), **Days** and **Slipping**.

## Testing

- Server: a turn that runs to the end with the client gone saves the whole transcript; reattach returns the rest.
- Server, views: each view's reader against the round-spec fixtures. Day's Foundation figure is the same as the steps' load sentence and Today's card for the same day. A task forwarded from Monday and Tuesday has a trail of two. One ticket's read has its last comment. Days over a week with an empty future day shows that day's meetings.
- Server, writes: placing a task moves it from Morning to Afternoon and between the list and On deck on one day, and refuses a note that changed. Setting an estimate replaces the token, and the load follows.
- Phone: each tap becomes the right sentence (`replies.spec`), and a meter redrawn after a tap matches the server's figure after the write; the transcript survives a simulated pause; the mini bar keeps pill answers.
- Live on the rig: hide the app mid-turn and come back; reply from the notification; "why is Monday over?" gets Day, opened on Foundation; "what's going on with ZAP-2640?" gets Item; in a talk about tickets, no view of the day comes up.

## Not now

- A floating bubble over other apps.
- Writing on each tap in a view.
- Views on the desktop client.
- A Tickets view, until Shawn asks about tickets as a set outside a ritual.
