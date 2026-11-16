# Plan: the stuck line

A moved original whose note was saved again stops reading as moved. The desktop editor saves Caius's mark
`<em>scheduled <a href="#root/ID">Tue 3 Nov</a></em>` as `<em>scheduled </em><a href="#root/ID"><em>Tue 3 Nov</em></a>`,
and a mark written as a reference link before 26 Oct as `<em>scheduled&nbsp;</em><a class="reference-link" href="#root/ID">03 - Tuesday</a>`.
The LLM note tools' Markdown round trip turns those into `<em>scheduled</em> <a …>` and `<em>scheduled</em>&nbsp;<a class="reference-link" …>`.
The server reads tasks as Markdown, and its matchers (`SCHEDULED`, `withoutMoveLinks`, `copyKey`, the inline copy at
`apply.ts:950`) know only the written form. So the trail splits, Plan my day counts a moved line as done, and a
wind-down's answer about the moved task doesn't reach its copy. The library's HTML readers (`origin-html`,
`reword-html`) and the phone's `displayText` miss the saved forms too.

One PR against `ktn` from `ktn-caius-stuck-line`. No note is rewritten: every fix is on the read side. Every task is
test-first: the failing test, a red run, the code, a green run. One commit per task (`caius: …`), by explicit path.
The reds written during the investigation are committed with the task they belong to.

Decided:
- A bare `<em>scheduled</em>` with no link is not a mark and does not count as moved (pinned in T2).
- The state wins (Q1): a line with a linked mark whose Rescheduled state a click cleared is open everywhere, and a
  copy never carries an old mark (T5).
- The LLM note tools drop every list item's id when they rewrite a note (Q3). Their fix is another worker's, and
  its red stays out of this PR; the skill sheet gets one line steering Journal edits to the Caius tools (T6).

Order: T1, T2, T3, T5 one after another. T4 (the phone) runs beside T1; T6 (the skill sheet) beside any of them.

## T1 · One definition of a saved mark, for the HTML readers

**Files.** `packages/caius/src/trilium/forward-html.ts` (a new exported helper), `origin-html.ts` (`itemText`),
`reword-html.ts` (`trailChildren`); `forward-html.spec.ts`; the reds already in `origin-html.spec.ts` and
`reword-html.spec.ts`.

**Change.** `scheduledMarksOf(span)` gives a task description's "scheduled" marks: each with its nodes, the note id
its link points at and the link's text. A mark is either
- an `em` whose text starts with `scheduled` or `rescheduled` and holds an `a[href^="#root/"]` (as written), or
- an `em` whose whole text is `scheduled` or `rescheduled` (any surrounding space or `&nbsp;`), with no link inside,
  followed by an `a` with `href="#root/<id>"`, with only whitespace or `&nbsp;` text between them (as saved).

Not a mark: a bare `em` with no link after it, one followed by other words before the link, and one followed by the
task's "from …" back link (`backLinkOf`). `itemText` drops each mark's nodes instead of using the `SCHEDULED` regex;
`trailChildren` keeps the back link and every node of each mark. `scheduledTo` and `hasCopy` are left alone.

**Tests first.** `forward-html.spec.ts`: each of the five shapes above gives one mark with the right note id and
text; the bare `em`, an `em` then words then a link, and an `em` then a "from …" link give none. The origin reds (four
shapes) and the reword red (four shapes) go green.

**Done.** The three library specs green; `cd packages/caius && pnpm exec vitest run src/trilium` green.

## T2 · The scan reads every saved mark as Caius wrote it

**Files.** `packages/caius/src/trilium/markdown.ts`, `markdown.spec.ts`; the reds already in
`apps/server/src/services/caius/daily.spec.ts` and `stuck-line.integration.spec.ts`; the two cases already in
`apps/client/src/services/caius_markup.spec.ts` that pin the bare mark; `docs/ktn/caius/internals.md`
("Plain internal links").

**Change.** Before turndown, `convert()` rewrites each saved mark in a task description (T1's helper) into the
written form `<em>scheduled <a href="#root/ID">label</a></em>`, by range edits with `apply` from `html-util.ts`; the
label is the link's text, whitespace collapsed, `&nbsp;` as a space, escaped. A written mark is left as it is. Only
the scan's input changes; nothing is written back. So the server's matchers read every saved form with no change to
`daily.ts`.

**Tests first.**
- `markdown.spec.ts`: each of the five shapes gives exactly `- [>] Ring the plumber _scheduled [Tue 3 Nov](#root/tue)_`
  (the reference ones with their own label), with a plain space and no `\u00a0`; the line keeps its list item id. A
  bare `<em>scheduled</em>` stays `_scheduled_`. The word "scheduled" in a task's own text and a `#root/` link elsewhere in the line
  are untouched.
- `daily.spec.ts`: the red block goes green; a new case pins the bare mark: `SCHEDULED` does not match it and
  `withoutMoveLinks` leaves `Ring the plumber _scheduled_`.
- `stuck-line.integration.spec.ts`: the 8 reds go green. A new case pins the bare mark on an open line: its trail
  copy is not moved on, and Plan my day's yesterday counts it open, not moved. The describe titles name the shapes
  ("as written", "saved with a plain link", "saved with a reference link").
- `caius_markup.spec.ts`: a new case runs the real editor's saved HTML through `htmlToMarkdown`, for a fresh forward
  and for an old reference-link mark, and finds `_scheduled [Tuesday 27](#root/tgtnote)_` and
  `_scheduled [26 - Monday](#root/tgtnote)_`. Red before the `markdown.ts` change.

**Done.** The four specs green; `cd apps/server && pnpm exec vitest run src/services/caius` green apart from the
known `routes/api/caius.spec.ts` failure; the `internals.md` paragraph says how the editor saves the mark and that
the scan reads every saved form as written.

## T3 · One moved-on rule on the server

**Files.** `apps/server/src/services/caius/daily.ts` (a `movedOn(task)` next to `SCHEDULED`; `yesterdayOf`),
`trail.ts`, `apply.ts` (`refTable`); `daily.spec.ts`.

**Change.** `movedOn(task)` is `task.state === "tombstone" || SCHEDULED.test(task.text)`. `yesterdayOf`'s moved and
done counts, `trailsOf`'s `movedOn` and `refTable`'s `moved` call it; the regex copy at `apply.ts:950` goes. No
behaviour change; Q1's answer is then a change to this one function.

**Tests first.** `daily.spec.ts`: `movedOn` is true for a tombstone, for a done line with a mark and for an open line
with a mark (today's rule; T5 changes it), false for an open line and for an open line with a bare mark. Red: the
function doesn't exist.

**Done.** `daily.spec.ts`, `stuck-line`, `trail`, `round4` and `winddown-forward` integration specs green.

## T4 · The phone shows where a saved task went

**Files.** `apps/caius-app/src/components/TaskRow.tsx` (`displayText`); the red already in `QuickAdd.spec.ts`.

**Change.** `displayText` reads the saved markers as well as the written one: `_scheduled_ [_Thu 5 Nov_](#root/…)`
and `_scheduled_` plus a space or `\u00a0` and `[05 - Thursday](#root/…)`. `forwardedTo` is the label without its
italic marks. The server sends the written form after T2, but an offline snapshot taken before it holds the others.

**Tests first.** The red in `QuickAdd.spec.ts` goes green. A new assertion pins the bare marker: `displayText("Pair on
the seed data _scheduled_")` has `forwardedTo: null`.

**Done.** `cd apps/caius-app && pnpm exec vitest run` green.

## T5 · The state wins over the mark

**Files.** `apps/server/src/services/caius/daily.ts` (`movedOn`), `packages/caius/src/trilium/forward-html.ts`
(`buildCopy`, `hasCopy`); `daily.spec.ts`, `forward-html.spec.ts`, `stuck-line.integration.spec.ts`.

**Change.**
- `movedOn(task)` is true for a tombstone, and for a done line with a mark: a moved line whose Rescheduled state the
  symbols don't list reads as a checked box. An open or doing line with a mark is open, as plan-read and the
  leftovers already read it.
- `buildCopy` drops every mark (T1's helper) and the space before it from the copy, so a copy never says where an
  earlier copy went. `hasCopy` compares the source's words without its marks, so forwarding a reopened line to the
  note that holds its first copy writes no second one.

**Tests first.**
- `daily.spec.ts`: T3's cases change: an open line with a mark and a doing line with a mark are not moved on; a done
  line with a mark and a tombstone are.
- `stuck-line.integration.spec.ts`: a moved line whose state a click cleared (no state, box unchecked, saved mark
  kept) is open everywhere: its trail copy is not moved on, Plan my day's yesterday counts it open, and a wind-down's
  "done" ticks that line.
- `forward-html.spec.ts`: forwarding a reopened line gives a copy without "scheduled"; forwarding it to the note that
  holds its first copy writes no second copy.

**Done.** The three specs and `cd packages/caius && pnpm exec vitest run src/trilium` green; the server's
`src/services/caius` suite green apart from the known `routes/api/caius.spec.ts` failure.

## T6 · The skill sheet steers Journal edits to the Caius tools

**Files.** `apps/server/src/assets/llm/caius/skill.md`, `apps/server/src/services/caius/register.spec.ts`.

**Change.** One short line among the sheet's opening principles: change day, week and month notes only with the
`caius_*` tools, never by `get_note_content` and `set_note_content`, which rewrite the whole note through Markdown and
lose every task's id. The sheet stays under its 48,000-character cap (45,181 now).

**Tests first.** `register.spec.ts` expects the sheet to hold that rule. Red: it doesn't.

**Done.** `cd apps/server && pnpm exec vitest run src/services/caius/register.spec.ts` green.

## At the end

`pnpm typecheck` once, from the root. Push, open the PR against `ktn` with `--repo Kautiontape/trilium`. Then the
read-only repair lister, outside the repo, tested against a local rig only. Report to the manager with its usage.
