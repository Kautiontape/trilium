# Sub-tasks, rewording and the day flip

Written 2026-11-16, after Shawn planned Monday at 03:00 on the phone. The chat ran 25 minutes and ended with Caius
writing a prompt for another AI to make the edits it couldn't make itself. What he asked for, in the chat and in the
Caius lines on that day's note:

- **Sub-tasks.** The ticket answers he gives in standup should sit under the standup, and three small Caius fixes under
  one 15-minute item. "You can do sub bullets right, with indentation?" Caius couldn't.
- **Rewording.** "Wait, yes you can, you can change a line's wording." Caius couldn't, so it offered to cancel ten
  tasks and add them again.
- **The day flip.** "Manually tell it to flip to tomorrow if it's after midnight … 3am and I want to plan Monday as if
  it were today."
- **Enter in the phone chat** adds a line; the Send button sends.
- **"Later this week"** put a task in the week that had just ended.

Examples below use invented names and tickets.

## Part 1: bugs (one PR, no design questions)

1. **Week refs anchored on the reviewed day.** `namedDays(date, first)` builds `w1` "later this week", `w2` "next
   week", the end of the day list and the months from `date`'s week. In a catch-up review of Tue 10 Nov run from
   Mon 16 Nov, `w1` was W46, already over, and a review two weeks back gets no day refs at all. When the review is a
   catch-up (the reviewed day's next workday is before the target day), anchor on the target day. Otherwise anchor on
   `date` as now, so a Friday wind-down's "later this week" is still that week.
   Spec: `namedDays("2026-11-10", "2026-11-16")` gives w1 `2026-W47`, w2 `2026-W48`;
   `namedDays("2026-11-13", "2026-11-16")` gives w1 `2026-W46` as today.
2. **A catch-up review wrote to the target day.** `caius_winddown_apply` on an older day ran the `next` step's writes
   against the target day as well. `shelve` put the ten tickets Shawn had just taken in Plan my day into Suggested, so
   Caius had to accept them again, the refs changed and a move was skipped. In a catch-up review the apply writes only
   the answers about the reviewed day: done, fates (a forward to the target day included), drops and holds. It skips
   the offers (accept, shelve, not today, dismiss), the focus record and the closing Context lines, and reports any
   that were passed as skipped `review_only`. Plan my day owns the target day.
3. **"Monday" said on a Monday.** Caius put two tasks on the 23rd. Skill line: today's own weekday name means today;
   another weekday name is the next one.
4. **Brought-in tasks land without a word.** `caius_forward` puts a copy under the same-named section, else in the
   first work list, so two errands and the Caius fixes landed in Morning. Code can't pick the block from the area:
   Shawn wanted the Growth Caius fixes in the morning and a Growth errand in the evening. Skill line: a task brought into a
   day with blocks gets a block (`caius_place`), and Caius says which.
5. **Moves beside a block item.** `caius_plan_apply`'s `move` refuses an anchor outside the main list
   (`not_in_main_list`), and Caius fell back to `caius_place`. A move after an item in a block puts it in that block,
   after that item, the way `caius_place` does.
6. **Enter in the phone chat.** `Chat.tsx` sends on Enter. Enter adds a newline and the Send button sends. Quick add
   keeps Enter to submit, since it is one line.
7. **Parents matched by text.** `plan-read.ts` finds a parent's sub-items by the parent's text, so two tasks both
   named "standup" collide. Match by row instead. Part 2 needs this; on its own it changes nothing visible.

## Part 2: sub-tasks

**What exists.** The parser reads nested to-do lists (`parent`, `parentListItemId`). A forward carries the open
sub-items, a drop cancels the live ones, `caius_place` moves a task with its sub-items, capacity counts the leaves, and
`caius_set_estimate` refuses a parent (`has_subitems`). **What's missing:** any way for Caius to make or undo a nesting,
and any screen that shows sub-items. The phone's Today, its Plan day view and the desktop Plan tab all filter on
`!t.parent`, so indenting by hand today makes the sub-items vanish from every list.

### Decisions (Shawn, 2026-11-16)

- **Time: the parent's estimate wins, else the sum.** A parent's own estimate covers everything under it ("Caius fixes
  ~15m"). With none, its live sub-items add up, unestimated ones at the 30-minute default. A parent pinned to a clock,
  like "09:00 standup", counts as itself (its estimate or the default), so answers under it add nothing.
- **Ticking: independent, and the last tick asks.** Ticking a parent leaves its open sub-items open, so an answer not
  given carries over and wind-down asks about it like any leftover. When the last open sub-item is ticked, Caius offers
  to tick the parent, never silently. Dropping a parent still drops its live sub-items.
- **Display: folded.** On the phone's Today, the phone's Plan day view and the desktop Plan tab, a parent is one row
  with a done/total count ("3/10") and a chevron. Opening it lists the sub-items, each with the usual row actions. Each
  device remembers which parents are open (localStorage). The Top 3, the brief's groups and the hills count parents
  only.
- **Nesting: Caius proposes, he picks.** In Plan my day Caius proposes groupings as a pick he takes or skips. In any
  other chat, Caius nests when he asks.

### Writes

- `caius_add` takes `under` (a list item id or ref): the new task becomes the last sub-item of that task, in its note.
- `caius_place` takes `under`. With an id, the task and its own sub-items become the last sub-item of that task. With
  `{ text, est?, area? }`, a new parent is made where the first item stood and the items go under it, in order. `out:
  true` lifts a sub-item to its parent's level, right after the parent.
- One level only: nesting under a sub-item is refused (`too_deep`). Both tasks must be in the same note, else
  `other_note`; Plan my day forwards an item into the day before nesting it.
- `caius_set_estimate` accepts a parent (`has_subitems` goes away). The parent's estimate then covers its sub-items.
- `caius_set_state` adds `parentComplete: { noteId, listItemId, text }` to its result when the tick closed a parent's
  last open sub-item, so Caius asks in chat. The phone shows a toast with "Mark *standup* done".
- `caius_plan_apply` takes `nest: [{ items: [refs], under: ref | { text, est? } }]`, written after accepts and moves.

### The Plan my day offer

The `inputs` step adds `nests`: each one has a ref (`n1`), a parent (a list item, or a new one's text), its items and
a `because`. The rule is one the server can check: an ask (a taken or listed `kind: "ask"` candidate) whose asker
shares a first name with an attendee of a meeting that day goes under that meeting's task, if the day has one. Example:
"Put 4 answers under standup? Ana, Ben and Cy are in it." The phone shows each nest as a pick card (Yes / Skip), and
Send folds the picks into the reply like the other step answers. Caius may propose any other grouping in its message
("the three Caius fixes under one 15-minute item?"). A yes to one of those is written with `nest` the same way. An
offer he doesn't take writes nothing.

### Done parent, open sub-items

A parent ticked with sub-items still open keeps showing on Today, with "2 open" in place of the count, until each one
has a fate. Wind-down lists those sub-items under the parent's name. Forwarding one on its own puts it at the top level
of the target day, with the usual "from …" link; `caius_explain`'s origin already names the item it sat under.

## Part 3: rewording

- **The tool.** `caius_reword({ items: [{ noteId, listItemId, text }] })` replaces a task's words. It keeps the task's
  id, state, area marker, `~est` token, the "from …" and "scheduled …" trail links, and a leading clock unless the new
  words start with a clock of their own.
- **Links inside the words.** A link whose text still appears in the new words stays on that text. The others are
  dropped and listed under `dropped` in the result, so Caius says so.
- **What can be reworded.** Open, doing and done tasks. A moved copy is history and is refused (`moved`). Rewording one
  copy leaves its other copies alone.
- **The phone.** The task sheet gets an Edit action: a text field holding only the words, Save, then Undo in the
  notice. It goes through `/etapi/caius/apply` as a `reword` action.
- **The skill.** One line: change words with `caius_reword`, never by cancelling and adding again.
- Writes go through the same compare-and-swap edit guard as every other Caius write.

## Part 4: the day flip

- Between midnight and the rollover (04:00), the phone's Today shows **Start Monday now** (that day's name). A tap
  writes `#caiusStarted` with the time on the new day's note, making the note if needed.
- **Effect.** While the label is on the note of the calendar day whose small hours it is, that night's rollover is
  00:00. `rolloverOf` becomes `effectiveRollover(rhythm, started, now)`, and every reader of the workday clock follows:
  `workdayNow` and the service, Plan my day and wind-down targets, nudges, `planFrom`, the drawing's start, and the
  phone through `/etapi/caius/status` (`rollover: "00:00"`, `started`).
- **It ends on its own.** Past the real rollover the label changes nothing. Until then, Today shows **Back to Sunday**,
  which removes the label.
- **Chat.** "It's Monday now" in a chat works the same way through `caius_start_day`, one call with nothing to answer.
- Sunday's leftovers reach Monday through the usual catch-up; nothing else changes.

## Testing

- **Spike first (sub-tasks).** On the local rig, nest items with the new write, open the note in the desktop editor,
  edit another line and save. Check that the nesting and every `data-list-item-id` survive: an unchecked editor save
  can revert a server write, as the 2026-10-27 TOC case did. Write nested lists in the shape CKEditor itself saves.
- **Unit.** `namedDays` anchors; review-only apply skips; parent matching by row; the three counting rules (parent
  estimate, sum, pinned parent); `under`, `out`, `too_deep`, `other_note`; `parentComplete`; reword keeps the marker,
  estimate, trail links and clock and reports dropped links; `effectiveRollover` before, at and after 04:00, with and
  without the label.
- **Integration.** `tools.integration.spec.ts` for the new fields. The skill sheet stays under the 48,000-character cap
  (43,908 on 2026-11-16, so every new line has to be short).
- **Phone.** A folded parent and its chevron, ticking the last sub-item and the toast, the Edit sheet, Start/Back only
  between midnight and the rollover, Enter adding a newline.
- **Live rig run.** Plan my day on a seeded day with asks from a meeting's attendees, accept the nest card, check the
  note's nesting and the desktop editor round trip, then reword one of the sub-items.

## Rollout

Three PRs against `ktn`, in order: Part 1 (small, ship first), Part 2, then Parts 3 and 4 together. Each deploys the
server before the phone APK is installed.
