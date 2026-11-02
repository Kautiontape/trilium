# The brief's drawing as hills

Written 2026-11-02, from that Monday's Morning Brief. The header drew one bar per task on the list: 18 grey bars packed from 13:00 to 21:30, the first in clay, their labels crushed into one line, over a line with no bumps at all. Shawn's verdict: way too cluttered; the bars are thick and don't say why one is clay; and the terrain, the point of the drawing, was flat.

Why it was flat: the line rose only for meetings, and the one meeting, standup, had moved to 09:00 with the clock change while the Rhythm still starts the day at 10:00. `drawnEvents` drops a meeting that ends by the start, so the drawing had nothing to raise.

Mockup: the "Brief drawing: hills" canvas (claude.ai/artifact/SmC6c8FMskpvXZtdnBsXeD), with today's header as drawn and the same day as hills.

## Decisions

1. **Caius groups the list; each group is a hill.** No bars. Width is the group's time, laid out as the bars are now (from standup, or from now on today, around meetings).
2. **Height is how many tasks the group holds,** capped at 6. One long task is a low, wide hill; six tickets are a tall one. Switching between things is the tiring part.
3. **Meetings stay dots on the line** and add their own bump, as now. A tall hill of tasks never reads as a meeting.
4. **Names are at most 10 characters,** groups and meetings alike ("Board", "Sec. fixes", "Standup"). Caius names them; the server refuses a longer one. This is what keeps the labels from colliding.
5. **Clay marks a hill that holds an Important task** (the day note's Important block, `critical`). Everything else is ink. Rejected: clay for "now" (the brief's drawing is a fixed image, redrawn only when an answer changes the list, so "now" would go stale on the first group, the same unclear clay bar), and clay for work vs personal time.
6. **The whole day, to bedtime.** No dashed work-end line and no "evening" act: time after work is Shawn's own and gets the same hills. `workEnd` still decides where evening tasks are scheduled; it is no longer drawn.
7. **The row under the drawing is the groups:** one cell per hill, its time and its name. It replaces the three acts.
8. **A meeting before the Rhythm's start stretches the start back** to its hour, as a late item already stretches the end.
9. **A task added after grouping joins the group of the task just above it** on the list (the first group when it is first). A finished or removed task leaves its group; a group left empty is gone.

## The groups

Plan my day writes the brief through `caius_plan_apply` (`briefOf` in `apply.ts`); `caius_brief_write` writes it outside that flow. Both take, in place of `acts`:

```ts
groups?: { name: string; items: string[] }[]   // up to 6, name 1-10 characters
meetings?: { title: string; name: string }[]   // a calendar title and its name on the drawing, 1-10 characters
```

- An item names a task as the steps do: its `l…` ref (the brief and inputs steps give one per task), id, ticket key or words; in `caius_plan_apply`, a `c…` ref names a candidate taken in the same call. Items are matched after the call's writes, against his list as it then stands, so a task just taken can be grouped. A task is claimed by the first group that names it.
- A name over 10 characters, or more than 6 groups, fails validation before anything is written. An item that names no task comes back in `ungrouped`; it is not an error, since the writes have happened.
- `groups` left out or empty keeps the groups the brief already has; with none, each heading is a group (named without its emoji, cut to 10 characters). `meetings` likewise.
- `acts` is still accepted and ignored, so an older conversation doesn't fail. `groups` at the top of `caius_plan_apply` goes with a move-only call; on any other call it is reported as skipped.
- The groups (by listItemId) and meeting names are kept on the brief as one label, `#caiusGroups`, holding JSON. Every redraw reads it (`redraw` in `apply.ts`, `redrawHeader` in `brief.ts`), and `caius_plan` returns it for a day as `drawn`, which the phone draws with.
- A meeting with no name given is drawn with its title cut at a word ("Release call" reads "Release").

Group order on the timeline is the order of each group's first task on the list; tasks inside a group keep their list order. So when Caius groups related work that isn't next to each other on the list, the drawing lays it out together, while the picks still follow the list.

## Where the code goes

- `packages/caius/src/daily/groups.ts` (new): `groupTasks` (decision 9 and the heading fallback), `meetingName`, `shortName` and `NAME_LENGTH`. Shared by the server and the phone.
- `packages/caius/src/daily/blocks.ts`: `layoutGroups` lays out group after group and answers each group's span and count; `layoutWork` loses the focus block.
- `packages/caius/src/draw/terrain.ts`: `TerrainInput.work` and `workEnd` became `groups`. Each group adds `h * sin(π·u)^0.8` to the line, `h` from the count (capped at 6), so neighbours dip to the ground where they meet; meetings keep their bumps and dots. Group names over their tops and meeting names over their dots rise a row when they'd hit the line or another label. Bars, labels under them, leaders, the focus bar and the work-end line are gone.
- `apps/server/src/services/caius/daily.ts`: `workBlocks` answers groups; `groupsFrom` matches an answer's items; `drawnStart` and `drawnEvents` stretch the drawing back for an early meeting (work is still laid out from standup); `groupCells` makes the row; the brief step gives refs, `meetingTitles` and `groups`/`meetings` in its shape.
- `brief.ts`: `GROUPS_LABEL`, `DrawnNames`, `drawnNamesOf`; `writeBrief` and `redrawHeader` keep the names they're given.
- `apply.ts`: `briefOf`, the move-only `reorder` and `redraw` use groups; `drawnActs`, `withEveningAct` and `fromNow` are gone.
- `schemas.ts`, `tools.ts`, `assets/llm/caius/skill.md`: the inputs and the words that tell Caius to send groups.
- Phone, `Today.tsx` `TerrainView`: `groupTasks` with `plan.drawn`, then `layoutGroups`.

## Testing

- `terrain.spec.ts`: hill heights follow the count and cap at 6; neighbouring groups dip to the ground; an Important group is clay; no label overlaps another or the line on the two mockup days.
- `groups.spec.ts`: a new task joins the group above it; a removed task leaves; an empty group goes; the heading fallback.
- Integration: a brief written with groups, then a task moved in by Plan my day's apply, redraws with the task in the group above it and the row matching the hills; a name over 10 characters is refused.

## Not in this change

- The standing note's Rhythm, which said standup was at 10:00. Shawn moved it to 09:00 on 2026-11-02; decision 8 draws an early meeting either way.
- Redrawing the brief through the day, so the drawing could show "now".
