# Caius the guide

Written 2026-10-29, after a Wind down in the sidebar chat failed as a script. Shawn said ZAP-2388 was next for Thursday, and the chat could only write a Context line: `caius_add` was switched off in those conversations and the apply has no field for a new task. He asked about tomorrow's meetings, and it could see only "1 h 30 m booked", with no titles, and then guessed "almost certainly Pickup for HT". Earlier the same evening it refused to move tasks it hadn't offered and told him to search his notes himself.

## Purpose

Shawn's words, from the Caius note in Trilium:

> Caius keeps one promise: nothing falls off the radar silently. Everything you mean to do moves through the funnel or gets dropped on purpose, work and life alike.
> - A guide, not a script. He knows the method and holds each ritual's goal. He flexes to whatever you ask, and pushes back when an ask would undo the goal: "That won't fit tomorrow either. Split it, or send it up to the week to sort out when you plan?"
> - Nothing gets lost. Whatever you hand him lands somewhere Caius tracks.
> - Look, ask, never guess. If your question only makes sense once he has the answer, he goes and gets it. If it would only be nice to have, he asks. He never bluffs.
> - He writes only what you said, and tells you what he wrote.
> - Voice. Brief, a little dry, chill. Protective of you, your evenings as much as your tickets. He'll call you out for overloading a day, but never with an attitude; he means well and is there to help.
>
> Wind down closes today and sets up tomorrow. Every leftover gets one fate. "I'd like to do this Thursday" goes on Thursday's On deck section; "I need to do this Thursday" goes on Thursday's list proper.
>
> Plan my day decides what is actually on the list: On deck first, then the week and what's overdue, against capacity. He remembers how yesterday went.

The name is a nod to Caius Cosades, the laid-back spymaster in Morrowind who hands you the next job. Nothing quotes the game.

## Decisions

1. **Persona.** In Wind down and Plan my day, and wherever the `caius` skill is loaded, the agent speaks as Caius, in the first person and in the voice above. The skill sheet opens with a short "Who you are". The `say` text the tools write stays factual; the personality is in how the agent talks around it.
2. **Guide, not script.** The opener conversations get every `caius_*` tool and the note reads. The generic note tools that write stay off, so Journal tasks change only through Caius. The skill's "Wind down and Plan my day" section states each ritual's goal, gives the steps as the default path, and lists what must hold while he flexes: one fate per leftover, nothing lands untracked, write only what he said, dry-run a batch he didn't spell out, and push back when an ask undoes the goal. An ask off the path ("add ZAP-2388 for Thursday", "what are tomorrow's meetings", "move X") is answered in the same conversation with the right tool. The step and apply contracts stay; the apply tools are still the main write path for the ritual's answers.
3. **On deck.** A new section of a day note, just above Suggested. See the data model below.
4. **Pushback on overload.** Wind down's `next` step carries the next workday's load: its meetings, the committed list, On deck and what the proposed fates bring, against the focus target. When that goes over, the step flags it, and Caius says so and suggests splitting or sending something to the week. It is advice: if he insists, Caius does it.
5. **Remember yesterday.** Plan my day's `inputs` step carries a summary of the last workday's close: done, moved and dropped counts, whether it was wound down, and what landed on today's On deck.
6. **Look, ask, never guess.** Wind down's `next` step carries the next workday's meetings with titles and times. The skill tells Caius to fetch what an answer depends on, ask about what would only be nice to have, and never present a guess as fact.

## On deck

**Meaning.** Intended for that day, not committed. An On deck task is tracked: it is a live task in every Caius read, lane and duplicate check, so it is never lost. It doesn't count toward the day's committed capacity until Plan my day puts it on the list.

**In the note.** A heading named "On deck" (any level, compared like the other section names), placed just above Suggested. Caius creates it the first time it puts something there, at the level of the Suggested heading, or the level a new header would get when there is no Suggested. The template doesn't need it. Like Suggested, the section runs to the next heading. A heading Caius creates for a task goes above On deck, so On deck and Suggested stay together at the end.

**Reading it.** On deck items keep their checkboxes, so the scanner sees them as tasks with a horizon. `readPlan` takes them out of `sections`, `critical`, `top3` and the capacity totals and returns them as `onDeck`, with `capacity.onDeckMinutes`. Everything that builds the committed list from `sections` (the steps' `list`, the drawing, the picks, the Plan tab's capacity) leaves them out without further change. A task inside an Important block counts as critical, even under the On deck heading.

**Writing it.**
- `caius_add` takes `onDeck: true` (a day only) as a fourth target beside `section`, `critical` and `suggested`. An On deck task doesn't replace the template's `[…]` placeholder, because nothing is committed yet.
- `caius_forward` takes `onDeck`: `true` puts the copy in the target day's On deck, `false` in the list proper. Left out, the copy keeps the source's placement: an On deck task forwarded to a day stays On deck, and one forwarded to a week or month goes to its list (week and month notes have no On deck). Committed placement never lands in an On deck list.
- Taking an item from On deck onto the list moves the same `<li>` (same id, same text) out of the section into the main list, first, before or after an item of it, or into the Important block.

**The rituals.**
- **Wind down.** A leftover's proposed fate is the next workday's On deck, so leftovers no longer land on tomorrow's list unasked. An Important task still goes to the Important block, and an evening task (under Evening or Recharge) to the evening: the evening has its own time and isn't weighed against the work. A fate he names for a day goes On deck unless he passes `onDeck: false` ("I need to do this Thursday") or `critical: true`. A day's own On deck items that were never planned are leftovers like any open task.
- **Plan my day.** The `inputs` step offers the day's On deck items first, ahead of the candidates. Each gets a proposed fate: onto the list while the committed work stays within the focus target, back to the week once it doesn't. His answer changes any of them (`onDeck: [{ listItemId, first|before|after, critical, to, drop }]`); every item he doesn't name takes its proposed fate, which the apply writes, as Wind down does with its proposals. The question names each proposal, so nothing moves that he wasn't shown. So nothing stays on deck past planning.
- **Catch-up.** A missed day's On deck items are its leftovers too, and a day whose only live tasks are on deck is not closed. The catch-up's "Move all to today" in Plan my day puts them on today's list.

## Tool gating

`CAIUS_CONVERSATION_DISALLOWED` is gone: an opener conversation has every Caius tool. The generic note write tools (`set_note_content`, `edit_note_content`, `append_to_note`, `create_note` and the other mutating note, attribute, hierarchy and attachment tools) stay disallowed and out of the session's MCP server.

## Open limits

- The overload flag weighs the next workday only. For another day he names ("add a 2 h task for Thursday"), Caius reads Thursday with `caius_plan` and `caius_inputs` first.
- Wind down's candidates accepted for the next workday still go to the list proper, as before; they were offered as the next day's work.
- Pushing a task to its project note is still not built.
- The Plan tab shows On deck as its own group but has no action to put an item on the day's list; that happens in Plan my day. Its Close card does give On deck items a fate, like any open task.
- An On deck item without a list item id (typed by hand into a note Caius never wrote) can't be offered, so it gets no fate in Plan my day until `caius_assign_ids` runs. Wind down and the catch-up still count it.
- "Would like" or "need to" is mapped by the agent from his words; no `said` check backs it, as one does for drops and parks.
- The nudge bar's Move all to today keeps an On deck item on today's On deck, for Plan my day to place; Plan my day's own `move_all` puts every catch-up task on the list.
