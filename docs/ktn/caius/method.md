# Planning in Trilium: the day note, Caius and the daily brief

How a day's tasks are laid out in Trilium, what Caius does with them, and where the daily brief fits. Written 2026-10-26 from Shawn's decisions that day and from three Trilium notes that hold the method: **Caius** (`2eVBmualsBrS`, the cascade and its rules), **Time Management** (`PPRBKVBR8xnd`, the four rules) and the August planning chat **Review Tasks and Balance Workload** (`htK2RqJTO1kj`, headers and capacity). The specs under [design/](design/) are historical; where they disagree with this note, this note wins.

Moved from the caius repo's `docs/trilium-planning.md` on 2026-10-27. The method is unchanged. The commands that used to be `caius` CLI subcommands are now the `caius_*` tools and the Task menu, described in [README.md](README.md); how they work is in [internals.md](internals.md).

## Purpose

Shawn's words, from the Caius note:

> Caius keeps one promise: nothing falls off the radar silently. Everything you mean to do moves through the funnel or gets dropped on purpose, work and life alike.
> - A guide, not a script. He knows the method and holds each ritual's goal. He flexes to whatever you ask, and pushes back when an ask would undo the goal: "That won't fit tomorrow either. Split it, or send it up to the week to sort out when you plan?"
> - Nothing gets lost. Whatever you hand him lands somewhere Caius tracks.
> - Look, ask, never guess. If your question only makes sense once he has the answer, he goes and gets it. If it would only be nice to have, he asks. He never bluffs.
> - He writes only what you said, and tells you what he wrote.
> - Voice. Brief, a little dry, chill. Protective of you, your evenings as much as your tickets. He'll call you out for overloading a day, but never with an attitude; he means well and is there to help.

It is a lifestyle list, not a work list: the evening is planned like the day, and there is no point at which planning is done. The name is a nod to Caius Cosades, the laid-back Blades spymaster in Morrowind who hands you the next job. Design: [design/2026-10-29-caius-the-guide.md](design/2026-10-29-caius-the-guide.md).

## The method, as Shawn wrote it in Trilium

- **The cascade.** Someday → Planning ahead (future month notes) → Orbit (this month's note, the committed set) → Week (pulled from the month) → Today (pulled from the week). Pull down only: if it isn't in the month, it doesn't get a week slot.
- **One fate on close.** When a period ends, every unchecked item gets exactly one fate: pulled into the next period, pushed to its project note, parked in a future month, or dropped as `[-]` with a reason. Nothing stays in a closed note. "Oops, couldn't do it" is fine; silently never doing it is not. (This replaces the Phase 0 spec's "incomplete tasks stay put".)
- **Work in order.** The active slate is small and real; everything else waits its turn.
- **Actions are tasks** (Time Management, rule 1). Anything to do goes to a gathering point that's processed daily, then becomes a task.
- **Every task has an estimate** (rule 2), padded for context switching and wind-down. A best guess beats none.
- **Capacity** (August chat). About 4 to 5 hours of real task time on a workday once meetings are out, 180 to 240 minutes of planned work a day, 12 to 15 hours a week, and personal evenings of 45 to 60 minutes. Recharge (the Areas → Recharge book: 3D printing, arcade, TTRPGs) never reached the plan in August; the suggestion was one Recharge item a week and one small delight a day.

The Caius note still has an open task to "capture where Caius comes from". This file covers the parts the Caius code needs; the method itself stays in Trilium.

## The day note

Top to bottom:

1. **Critical, if anything is.** An Important block (Trilium's admonition, stored as `<aside class="admonition important">`) holding the one or two tasks that must happen today. Most days have none.
2. **Tasks in priority order, under headers.** The order is the priority. The Top 3 are simply the first three live tasks after the critical block. Headers group them, and the vocabulary changes from day to day. Seen so far: Morning / Afternoon / Evening (when in the day), Foundation / Growth / Recharge (work, growth and fun), Important / Foundation / Growth in the August month note, and Work / Home / Chores in Week 31. Caius doesn't require any set; it reads whatever headers a day has.
3. **On deck**, just above Suggested. Tasks he would like to do that day but hasn't committed to: "I'd like to do this Thursday". They are tracked like any task, but they don't count toward the day's capacity until Plan my day puts them on the list. Caius creates the section when it first needs it.
4. **Suggested**, the last section. Things the daily brief (or anything else) thinks might be tasks. They aren't tasks until Shawn accepts them.

## How Caius reads it

- **Section.** Each task carries the nearest heading above it as its `section`. Known names get a kind: Morning / Afternoon / Evening are a `slot`; Foundation / Growth / Recharge are an `area` (this is the area axis decision D3 deferred). Any other heading is just a group label. This is a new axis next to horizon and project.
- **Critical.** A task inside an Important block counts as critical: importance tier 3, as if it carried `!!!`. Only the derived markdown Caius parses gets the token; nothing is written to the note.
- **Order.** Within a day: critical first, then document order. That gives "Top 3" without a field for it.
- **On deck is tracked, not committed.** Items under the On deck heading are live tasks in every lane and duplicate check, but `caius_plan` lists them as `onDeck`, apart from the sections, the Top 3 and the capacity total (`capacity.onDeckMinutes` holds their minutes).
- **Suggested isn't the funnel.** Items under the Suggested heading are left out of every horizon and of capacity, and listed as a separate `suggested` lane for the day.
- **Estimates.** `~30m` tokens in the text, as in the grammar. A task without one counts as 30 minutes and is flagged, so the plan can ask for a guess.

## Writes (all HTML-level, with a compare-and-swap)

| Tool (menu item) | Does |
|---|---|
| `caius_forward` (Forward ▸) | Moves a task to another day, week or month under the same header; the old copy becomes Rescheduled with a link |
| `caius_add` | Adds a task to a day, week or month: under a named header, into the critical block, or under Suggested. Creates the note from the template if needed and replaces the template's `[…]` placeholder on an untouched day |
| `caius_accept` (Accept ▸) | Moves a Suggested item up under a header (or into the critical block), at a position in the order |
| `caius_dismiss` (Dismiss) | Removes a Suggested item ("that's a notice, not a task"). Nothing is marked; it's simply gone, and the brief won't suggest the same source again |
| `caius_set_state` (Doing, Done, Drop…) | Sets a task's state (Done, Doing, Cancelled with a reason) |

Every write is saved only if the note still holds what Caius read; a note that changed meanwhile is skipped as `edited`, and nothing is written. Unlike the ETAPI version, the check and the write are one step, so that race is closed. See [internals.md](internals.md).

## The rituals

- **Plan my day** (morning) decides what is actually on the list. On deck first, then the week and what's overdue, against capacity. Every On deck item gets a fate: onto the list at a place, back up to the week, parked or dropped, so nothing sits on deck past planning. Accept or dismiss suggestions, set the order and the critical block. It remembers how yesterday went: what got done, moved and dropped, and whether the day was wound down.
- **Wind down** (evening, or first thing the next morning) closes today and sets up tomorrow. Every open task in today's note gets one fate, the day's unplanned On deck items included: forward to a day, back up to the week or month, or drop with a reason. "I'd like to do this Thursday" goes on Thursday's On deck; "I need to do this Thursday" goes on Thursday's list proper, or its Important block when it is critical. A leftover he doesn't name goes on the next workday's On deck; an Important one keeps to the Important block, and an evening one to the evening. When what he asks for would push tomorrow past capacity, Caius says so and suggests splitting it or sending it to the week; if he insists, it is done. Wind down covers the evening as well as the work.
- **Weekly and monthly** close the same way at their grain.

These happen in conversation (Claude or Duet through Trilium's MCP server and the `caius` skill sheet) or in Trilium: the Plan tab's Close card and the Task menu. In conversation Caius is a guide, not a script: the steps are the default path, and anything else he asks for in the middle (add a task to Thursday, read tomorrow's meetings, move a task) is done in the same conversation. **Automatic** is a switch, off by default: when on, a scheduled run applies the obvious fates by itself, for example forwarding leftovers to tomorrow. That runs against "drops are explicit", which is why it is off.

## The daily brief's part

The brief reports; Caius owns the list.

- **Notices** stay in the brief: meetings, free time, a reply owed, what turned out to be done, what to read.
- **Suggested tasks** go to the day note's Suggested section through `caius_add` with `suggested: true`, each with its source link (the email, the Jira key). The brief never writes above that section.
- **No duplicates.** The brief doesn't suggest something already open anywhere in the Journal with the same link or Jira key, or something Shawn dismissed before.
- **The plan comes from Caius.** The brief reads the day's list (`caius_plan`) in order ("your first three are…"), the capacity, and the overdue count, instead of building its own plan table or Top 3.

## Decisions (2026-10-26)

These settled the questions this note first left open.

- **Critical is the block only.** The old "Important" **heading** is an ordinary group. Only the Important block (`<aside class="admonition important">`) marks a task critical.
- **Week and month notes follow the day pattern**: critical block at the top, tasks in priority order under headers, Suggested last. Where the day rules don't carry over:
  - `caius_plan` with `period: week` or `month` returns the same shape as for a day. `top3` is simply the first three live tasks after the critical block; read it as "the head of the list" for a longer period.
  - Capacity targets are per period: 180 to 240 minutes for a day, 720 to 900 (12 to 15 hours) for a week, none for a month (the result gives `target: null`; the month is a committed set, not a schedule).
  - Slot headers (Morning / Afternoon / Evening) make little sense above a day, but nothing forbids them; headers are whatever the note has.
  - Recharge gets no enforced slot. The week is where "one Recharge item a week" lives, but Caius only reads and writes the header; it does not require it.
  - `caius_add` to a week or month creates the note through the calendar service if it is missing, like a day.
- **Dismissals are a label on the note.** `dismiss` adds a repeated label `#caiusDismissed=<key>` to the day (or week or month) note it dismissed from. The key is the Jira key if there is one, else the source URL (fragment and trailing slash dropped), else a 12-character hash of the normalised text. `add` refuses a suggestion whose key is dismissed on that note. The memory is per note: tomorrow's note has no label, so a caller that must not re-suggest across days reads `dismissed` from recent days (`caius_plan` returns it) or relies on the Journal-wide duplicate check for anything still open.

### Calls the design left to the build

- A task with live sub-items counts toward capacity through its sub-items, not twice. Unestimated live tasks count 30 minutes each.
- The `[…]` placeholder is replaced by the first real task added to a day, whichever section it lands in. Filling only Suggested leaves the placeholder alone, since the day is still untouched for planning.
- New headers are created above On deck, else above Suggested, one level under the template's lone `Tasks` title, else at the level already in use. Suggested is created last if missing; Caius never reorders a Suggested section that someone has put elsewhere.
- Duplicate checks compare against live tasks across the Journal, plus open Suggested items on the same note. Suggested items on other notes don't count, so a stale suggestion cannot block a source forever.
- Bare Jira keys in task text are recognised only for the projects ZAP, ZIS, SUR and CM (`JIRA_PROJECTS` in `packages/caius/src/trilium/keys.ts`), so `UTF-8` is not a key. A `source` key of any project is accepted, and any `/browse/KEY` link counts.
- `drop` cancels the task's still-live sub-items with it; `done` touches only the item.

### Not built yet

- The fourth fate on close, pushing a task to its project note, needs rules for finding a project's note. The Close card offers Tomorrow, Next week, Next month and Drop.
- The "Automatic" switch for scheduled fates.
