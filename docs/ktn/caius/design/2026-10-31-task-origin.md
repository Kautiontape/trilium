# Where a task came from

Written 2026-10-31, from the first day of the phone alpha. A task copied out of a meeting note read like "Confirm the counts across the clients", and on the phone that was all Shawn could see: the row cut it off before its "from 2026-08-11 Meeting on …" link, and nothing said what the counts were for. The meeting note knows: the item sat under "Open items", next to the other follow-ups of that call.

Shawn asked about nested tasks. The problem he meant is lost context: a task that reads fine where it was written and is cryptic once it moves. Real sub-tasks ("Prepare 4.4.0.0" with "Add a release type?") get the same answer for free, through the parent.

## Decisions

1. **Peek on tap, not on the row.** Rows stay one line of the task's own words. The context shows when the task is opened: the phone's task tray and the desktop's "Why is this here?". Rejected: a source line on every row (costs a line per task), and rewriting the task on copy (reads well, but the words stop being his).
2. **Computed when asked, from what the Journal already holds.** Nothing is written on copy and no id is stored, so tasks copied before this change get their context too.
3. **It lives on `caius_explain`.** The tool already answers "why is this here"; it gains an `origin`. The phone and the desktop already call it, and the agent can too.
4. **The phone's rows drop the "from …" link.** On a narrow row it only cut the task off; the tray carries it now.
5. **Rituals stay as they are,** plus one line in the skill: when a candidate's text doesn't stand on its own, call `caius_explain` and name the source in the question ("the counts item from the pilot call").

## `origin`

```ts
interface TaskOrigin {
    noteId: string;
    title: string;            // "2026-08-11 Pilot call"
    date: string | null;      // a Journal note's period label ("Fri 30 Oct"), else the note's dateCreated as YYYY-MM-DD
    headings: string[];       // outermost first: [ "Open items" ]
    parent: string | null;    // the parent item's text when the task was nested
    neighbours: string[];     // up to 3 sibling items' text, nearest first
    lead: string | null;      // the paragraph just before the list, about 200 characters
    matched: boolean;         // false: the source note was found but not the line
}
```

`caius_explain` returns `origin: TaskOrigin | null` next to its rule and summary.

**Finding the source.**
- A task with a "from …" back link (`backLinkTarget` in `forward-html.ts`) points at its source note. A forward keeps the link to where the task started, so a chain of moves still leads to the origin in one step.
- In that note, the original line is the item whose text matches the task's, compared without links, the scheduled marker and estimates (the same stripping `hasCopy` and `withoutBackLink` use). Prefer an item marked rescheduled, then the first match.
- No match (the copy was reworded): title and date only, `matched: false`. Source note gone or protected: `origin: null`.
- A task without a back link was written where it is: `origin` describes its own note (headings, parent, neighbours), so a sub-task shows "part of: Prepare 4.4.0.0".

**Where the code goes.**
- `packages/caius/src/trilium/origin-html.ts`: a pure function from the source note's HTML and the task's text (or id) to the HTML-derived fields. Reuses `findItem`, `descriptionOf` and the link stripping from `forward-html.ts`. Unit-tested on fixtures.
- `apps/server/src/services/caius/service.ts` `explain`: reads the task's note, follows the back link, reads the source note (title, period or dateCreated, content) and calls the function. One extra note read, no cache: notes change under it.

## What shows

Both clients show the origin only when it adds something: the task came from another note, or it sits under another item. A task written where it is, under no other item, gets no block; its heading and neighbours are on screen already.

- **Phone task tray** (`TaskSheet`, the Plan lane tray): on open it calls `explain` and shows a **From** block under the title once the answer is in, fading in: the source's name, "under Open items" or "part of: …", the neighbours small and grey, the lead faded. The tray is anchored to the bottom, so the block grows it upward and the actions stay where the thumb is. Tapping the block opens the source note in Trilium. For a nested task in its own note the block is only "part of: …". No origin (none found, or a server from before this change), no block.
- **The source's name:** a Journal note by its period ("Fri 30 Oct"); any other note by its title, with the day it was made unless the title already holds a date.
- **Phone rows:** `displayText` drops the "from …" back link (a `#root/` link whose text starts with "from").
- **Desktop:** "Why is this here?" is a toast (the Plan tab and the right-click Task menu), so it gets one sentence in front of the lane's: "From 2026-08-11 Pilot call, under Open items." or "Part of: Prepare 4.4.0.0." No neighbours or lead.
- **Skill** (`apps/server/src/assets/llm/caius/skill.md`): the one line in decision 5. The `caius_explain` description names the origin too, since the agent picks tools by it.

## Limits and failures

- At most 3 neighbours and about 200 characters of lead. The parent and the headings are always included.
- A recurring task's "from" link points at the first day's note; its origin is that day, "Fri 30 Oct, under ☑️ Tasks". Honest, if not much help.
- `explain` never fails over the origin: anything that goes wrong reading it gives `origin: null` and the rest of the answer as before.

## Tests

- `origin-html.spec.ts`: a meeting copy (headings, neighbours, lead), a nested item (parent), a reworded copy (`matched: false`), two items with the same text (the rescheduled one wins), a task with no back link.
- Phone: `displayText` drops a "from …" link and keeps other links; `originView` decides what the block shows.
- Desktop: `originSentence` and the toast.
- Server: `explain` gives a copy's origin, its own note's for a task without a link, and `origin: null` when the source note is missing.
- Local test Journal: seed a meeting note with Open items, pull an item to today, open its tray on the phone and its "Why is this here?" on the desktop.
