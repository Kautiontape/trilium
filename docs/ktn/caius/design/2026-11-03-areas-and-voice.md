# Foundation, Growth, Recharge, and how Caius talks

Written 2026-11-03, after Shawn's first evening and morning with the phone app. Two things were wrong at the root, and four smaller ones on the screen.

The root: Caius treats work as the whole day. Its one capacity figure is a work target (180 to 240 minutes), and every task on the list counts against it except those under an Evening or Recharge heading. On Tuesday 3 Nov the ballot drop-off and the Vincent relink counted as work, so the day read as overbooked, and the next move Caius knew was to pick Jira tickets. Shawn's words: their work is not their whole life; there will always be tickets, email and other people's "urgent" asks, and they need time they schedule for themselves. The time after work is theirs and gets planned and credited like the rest.

The second: Caius's messages are a slog. The wind-down opened "Here's what's left from today and what slipped. Which are done?", listed every item (which the card under it lists again), then rambled about the next day's calendar, the evening and Context before asking two more things. Impersonal, and the person in it is gone.

## Decisions

### The three areas

1. **The day has three areas, Shawn's own: Foundation, Growth, Recharge.** They are the `priorityGroup` values Shawn's Dashboard already uses for projects, and the area headings the method already names.
   - **Foundation** is the day job, ZeroedIn work, and nothing else.
   - **Growth** is Shawn's own projects and the life admin that isn't the job (the ballot, Vincent, Caius).
   - **Recharge** is fun and rest (3D printing, arcade, TTRPGs).
2. **The day note is laid out by time; the area is a marker on the line.** Shawn works from home and the day bleeds: the ballot can go in the afternoon, a ticket can wait for the evening. So the headings say *when*, and a small marker says *what for*:

   ```
   ## ☑️ Tasks
   ### Morning
   - [ ] ZAP-2620 prod bug ~1h
   - [ ] Review Sasha's sign-offs ~30m
   ### Afternoon
   - [ ] 🌱 Drop off the ballot ~30m
   - [ ] ZAP-2611 ~1h
   ### Evening
   - [ ] 🌱 ~1h on Caius: the fate menu
   - [ ] 🔋 TTRPG prep ~1h
   ### On deck
   ### Suggested
   ```

   - **Markers:** 🌱 Growth, 🔋 Recharge, after the checkbox and before any clock. An unmarked line is Foundation; most of the list is work, so work lines stay clean. (Compared with Foundation / Growth / Recharge as headings, 2026-11-03: headings showed the balance on the page but made moving a task in time mean typing a clock. Shawn chose time.)
   - **Moving a task in time is moving the line** into another block. A clock at the start of a line (`15:00 Drop off the ballot ~30m`, as on Meetings lines) pins it exactly and still works.
   - **Tagging is one click.** The Task menu, in both right-click paths, gets **Area ▸ Foundation / Growth / Recharge**, which writes or removes the marker (`apps/client/src/menus/task_actions.ts`). Moving a line by hand or editing the marker works too.
   - **Who writes the headings.** The day-note template gets the three blocks. An older note is never rewritten: Caius creates a block heading the first time it files a task into that block, and a task in no block is laid out by its area (work from standup, Growth and Recharge from work end).
   - **Both shapes are read.** Caius already reads whatever headings a day has. A note with Foundation / Growth / Recharge headings still gives each task its area from the heading, and an old `Evening` heading still reads as a time block. Caius writes the time-block shape.
3. **Caius files and marks new tasks by their source.** Jira tickets, work email and the work calendar are Foundation (no marker); a task from a project takes that project's `priorityGroup`; Caius marks every non-work task it writes. An unmarked line it didn't write and that doesn't look like work (no Jira key, no work source) is flagged in Plan my day with a proposed marker ("the ballot: 🌱?"), so a chore typed by hand gets caught before the day is weighed. Work goes in Morning, then Afternoon, in list order as it fits around the meetings; Growth and Recharge go in Evening unless Caius suggests otherwise (decision 4).
4. **Each block has a window, each area a target**, read from the standing note's Rhythm:

   | Block | Window |
   |---|---|
   | Morning | standup (09:00) to 12:00 |
   | Afternoon | 12:00 to work end (18:00) |
   | Evening | work end to bedtime |

   | Area | Target |
   |---|---|
   | Foundation | 3 to 4 h, less when meetings leave less (today's focus rule) |
   | Growth | 1 to 2 h |
   | Recharge | no figure; at least one thing |

   On a day with no work (a weekend, a day off in Context) there is no Foundation target and the blocks are all Shawn's.

   **Areas aren't tied to blocks.** Caius may suggest a Growth or Recharge task in Morning or Afternoon when it fits better there ("I'd consider the ballot in the afternoon": an errand with a deadline, a quiet stretch between meetings). What it never does is suggest work in the Evening; Shawn can put work there himself, and it counts toward Foundation. A Growth or Recharge task in Morning or Afternoon is booked time for Foundation's focus figure, as a meeting is, so the 3 to 4 h shrinks to fit around it.
5. **Each area has its own meter, and "over" is per area.** Nothing but Foundation counts toward Foundation, so a chore can never make the workday overbooked. Foundation over its target offers to move work to the next workday or the week, never into Evening. Growth over offers the same within Growth. The "Over capacity" notification reads Foundation only.
6. **Offers come for all three, side by side.** Plan my day and Wind down show three short lists of picks with equal weight and the same Take / Not today / Dismiss / Finished chips:
   - Foundation: Jira handoffs and the week's Foundation items, as now.
   - Growth: active projects with `priorityGroup=Growth` (`#status=active`) and the week's Growth items.
   - Recharge: active Recharge projects and the Areas → Recharge book.
   A Growth or Recharge pick is a timeboxed session, not the project: an hour of it, naming the project's first open task when it has one ("Caius: the fate menu", ~1h). Taking it adds that line, marked and estimated (`🌱 Caius: the fate menu ~1h`), in Evening, or where Caius suggested.
   This replaces the one "Evening / Nothing tonight" row.
7. **The drawing reads straight off the note.** Each block's tasks are laid in its window, a clocked task at its clock, the rest around the meetings. A group never spans two blocks or two areas. Clay still marks the Important block. The hills' rule that a new task joins the group of the task above it (2026-11-02, decision 9) now holds within a block and an area: a task whose neighbour above is in another area joins the first group of its own area in its block, or starts one (Shawn's call, 2026-11-03).
8. **The standing note's Brief rule now reads** "Open time between 09:00 and 18:00 is work time unless a Growth or Recharge task fits better there, such as an errand with a deadline. Never write "free", "yours" or "the afternoon is yours". After 18:00 the time belongs to Growth and Recharge; never suggest work there." Written 2026-11-03 on Shawn's yes. Its Rhythm's Capacity line ("45–60 minutes in the evening") changes to the three targets when this is built; show Shawn the wording first.

### How Caius talks

9. **One message per ritual, a rundown, then into the cards.** In order:
   - how the day went, naming two or three real things Shawn finished;
   - what didn't happen and where Caius put it, as a phrase, not a list;
   - the next day by area, as its shape ("a couple of meetings in the afternoon"), then Growth and Recharge;
   - a last line that leads into the cards ("The rest is below; change anything before I close the day.").
10. **The cards hold the lists.** The text never repeats a card's items.
11. **No scripted questions.** The tools stop telling Caius to ask `question` word for word; `question` becomes a card title ("Today's leftovers", "New since yesterday", "For Wednesday"), shown on the card. Caius writes its own last line.
12. **Plan my day has the same shape** in the morning: yesterday in a sentence, today's shape by area, then the cards.
13. **Voice:** "you" and "I", plain words, the way a person would say it out loud; the standing note's Brief rules still bind.
14. **The gist, not the data.** Shawn's words: the specifics make their eyes glaze over. Nobody says "Trilium's on 0.106.1" or "Corporate Team at 12:30, Chris at 13:00". Caius says what it amounts to: "Trilium was bumped to a newer version", "a couple of meetings in the afternoon". A clock time, a number or a name goes in only when Shawn has to act on it (a deadline, a meeting to prepare for); the exact times, keys and versions are in the cards and the drawing.

    The skill sheet carries the shape and one worked example, Monday 2 Nov's wind-down rewritten:

    > Good Monday: the hills shipped and Trilium was bumped to a newer version. A couple of work things didn't happen; they're on Tuesday's deck.
    >
    > Tuesday's light in the morning, with a couple of meetings in the afternoon. The ballot's due by 8 pm, so I'd put it first in your evening, or in the afternoon if there's a gap.
    >
    > The rest is below; change anything before I close the day.

### The smaller fixes

15. **"All done" reads "Mark all done".** It marks every wind-down item done; on its own it read as "I'm finished here".
16. **A fate is picked from a menu, not cycled.** Tapping an item's fate chip opens a short menu of its fates (Proposed, Done, On deck, On the list, The week, Drop) instead of stepping through them one tap at a time.
17. **An empty card isn't shown.** The wind-down's context card ("Anything to add for Tuesday") lists only the Context lines to keep or end; with none it was a card with nothing in it. A card with nothing to answer is left out, and the ask lives in Caius's message.
18. **The Evening row goes** (decision 6).

## Where the code goes

- **Areas and blocks.** `plan-read.ts` gives each task its `area` (its marker; else the nearest Foundation / Growth / Recharge heading on a note shaped that way; else Foundation) and its `block` (the nearest Morning / Afternoon / Evening heading, which `sections.ts` already kinds as `slot`, else its area's default), and a `flagged` bit for an unmarked line that doesn't look like work. `Capacity` gains `areas: Record<Area, { minutes, target }>`; `totalMinutes` and `target` stay as Foundation's so older callers read the work figure. `isEveningName` and the evening rules in `blocks.ts`, `apply.ts` and `daily.ts` give way to `area !== "foundation"`.
- **Markers.** One small module (`packages/caius/src/daily/areas.ts`) owns the markers: read, write and strip `🌱` / `🔋`, so `displayText` and the drawing never show them as words.
- **Filing.** `caius_add` and the plan/wind-down applies take an area and a block, write the marker and put the line under the block, creating the block heading above On deck when missing (`plan-html.ts`, where evening headings are created now). Plan my day's inputs step lists flagged tasks with a proposed area.
- **Tagging.** `apps/client/src/menus/task_actions.ts` gets Area ▸ Foundation / Growth / Recharge, through a new server write (`caius_set_area`) with the same compare-and-swap as the other Task-menu writes.
- **Rhythm.** `packages/caius/src/daily/standing.ts` reads the block edges and the per-area targets, defaulting to the tables above.
- **Capacity and load.** `dayCapacity` stays the Foundation figure, and counts a Growth or Recharge task in Morning or Afternoon as booked. `daily.ts`'s load (`over`) and the inputs step's heavy-day move count Foundation only; Growth gets its own load line.
- **Offers.** A new reader for active projects by `priorityGroup` (`#status=active`) and the Recharge book feeds Growth and Recharge candidates into the inputs and `next` steps, each candidate carrying its `area`.
- **Clocks.** `plan-read.ts` reads a leading clock on a task line as its `at`; `placeTasks` lays a clocked task at its clock before the rest and flows the others around it.
- **Drawing.** `layoutGroups` (`packages/caius/src/daily/blocks.ts`) lays each block's tasks in its window; `groupTasks` never puts tasks of two blocks or two areas in one group.
- **Phone.** `Today.tsx`'s capacity card becomes three meters; `Chat.tsx`'s `Candidates` shows three lists; `Evening` goes; `FateList` gets a menu; `StepCard` shows `question` as a title and skips a body with nothing to answer; "All done" becomes "Mark all done". `notify.ts`'s overcap reads Foundation.
- **Voice.** `assets/llm/caius/skill.md` gets the message shape and the example; `tools.ts` drops "ask question word for word" from `caius_planday` and `caius_winddown`.

## Testing

- `plan-read` specs: a task's area from its marker, and from an area heading on an old-shape note; its block from its heading; per-area minutes; a 🌱 chore adds nothing to Foundation; an unmarked "Laundry" is flagged, an unmarked ZAP ticket is not.
- Server specs: Tuesday 3 Nov laid out as in decision 2 is not over; a Foundation-over day offers the next workday or the week, never Evening; Growth and Recharge candidates come from active projects as timeboxed sessions; Area ▸ writes and removes the marker and refuses an edited note.
- Drawing: Morning's tasks sit before 12:00, Evening's after work end; a clocked task at its clock; no group spans two blocks.
- Phone: the fate menu, the hidden empty card, three meters, markers shown as dots, not emoji text.
- Client: the Area ▸ submenu in both right-click paths.
- Live run on the rig: a wind-down and a Plan my day, read for the message shape (rundown, no repeated list, a last line into the cards).

## Not now

- Weekly targets per area (the week's 12 to 15 hours stays a Foundation figure).
- Weighing the areas against each other over a week ("no Recharge since Thursday").
- Changing the Dashboard.
