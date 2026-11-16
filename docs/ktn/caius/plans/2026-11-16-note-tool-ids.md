# Plan: the LLM note tools keep list-item ids

One PR against `ktn` from `ktn-caius-note-tool-ids`. Every task is test-first: the failing test, a red run, the code,
a green run. Each task is one commit (`fix(llm): …`), by explicit path.

## The problem

`get_note_content` hands a text note to the model as Markdown, and `edit_note_content` refuses text notes, so an agent
edit of a day or meeting note is `get_note_content` then `set_note_content` of the whole note. The Markdown carries no
`data-list-item-id`, so `markdownImport.renderToHtml` writes every `<li>` without one. The next editor save or Caius
write gives each line a fresh id, and the phone and the desktop Plan tab, which still hold the old ids, get
`not_found` on those lines until they reload.

## Design

A new module `packages/trilium-core/src/services/llm/tools/list_item_ids.ts` exports
`carryListItemIds(previousHtml, html, newId?)`. It gives each list item of `html` (an `<li>` whose parent is a `<ul>`
or `<ol>`) the id of its counterpart in `previousHtml`, or a fresh one. It touches only the `<li` opening tags and
leaves the rest of `html` byte for byte.

- **Own text.** Items are compared by their own text: node-html-parser's decoded `.text` of the item's child nodes
  other than nested `<ul>`/`<ol>`, with whitespace collapsed and case folded. The round trip changes entities,
  `&nbsp;` and attributes (`title="Rescheduled"`), so raw HTML is never compared. Task states are attributes, so
  ticking an item off is an unchanged item.
- **Pass 1, exact text.** In document order, each new item takes the first unused old item with the same text. A
  sub-item prefers an old item under the old counterpart of its own parent, so two sub-items both called "Draft"
  under different parents keep their own ids when the parents swap.
- **Pass 2, edited in place.** For each item still unmatched, in document order, the candidates are the unmatched old
  items between the old counterparts of its nearest matched neighbours: the latest matched item before it and the next
  pass-1 match after it. The most similar candidate wins if its similarity is at least 0.5 (Sørensen–Dice over
  character bigrams). Position is relative to matched neighbours, not an absolute index, so a line added above
  does not stop a reworded line below from matching.
- **Fresh ids.** An item with no counterpart, or whose counterpart had no id, gets `e` plus 32 hex digits from
  `getCrypto().randomBytes(16)`: the format CKEditor's `uid()` writes, which CKEditor would give the item on its
  next save anyway. Every item then has a stable id at rest, so the Caius readers (which report `null` for an
  id-less item) can address a new line right away.
- **Uniqueness.** One set of used ids. An old id already taken (duplicate ids in corrupt old HTML) is not reused; the
  item gets a fresh id.
- **Writing.** The id is spliced in first on the `<li` tag, as CKEditor writes it; any id the new HTML already holds
  is replaced.

Wiring:
- `set_note_content`: the previous HTML is read before the type changes, and only when the note was text. The ids
  are carried onto the rendered HTML in `setNoteContentFromLlm` (new optional `previousHtml` parameter, one caller)
  before `scanWrittenContent`. A note that becomes text from another type gets fresh ids (`previousHtml` is `""`).
  A note that is not text after the write is stored exactly as before.
- `append_to_note`: the existing content is kept verbatim (already true), and the appended HTML goes through
  `carryListItemIds("", …)`, so appended items get fresh ids. Appended items are never matched against the existing
  ones: an appended copy of an existing line would otherwise share its id.
- The Markdown the model reads is unchanged: no ids in it.

Out of scope: `create_note` (no previous ids), `edit_note_content` (still refuses text notes), the converter
(`markdown.ts`, owned by another worker), Caius code and the skill sheet. No `.changelog` entry: no ktn change has
added one, and for upstream users the editor regenerates missing ids, so the change is internal.

## T1 · `carryListItemIds`

**Files.** New `packages/trilium-core/src/services/llm/tools/list_item_ids.ts` and `list_item_ids.spec.ts`.

**Tests first** (with an injected `newId` counter so fresh ids are predictable):
- Unchanged items keep their ids, in a `<ul>`, an `<ol>` and a `ul.todo-list`; markup outside the `<li` tags is byte
  for byte the new HTML.
- An item reworded in place keeps its id ("Pick a contract shape" → "Pick the contract shape").
- The same slot with unrelated text gets a fresh id ("Count the seats" → "Book the venue").
- A line inserted above plus a reword below: the reworded item keeps its id, the inserted one is fresh.
- A reordered list keeps each item's id.
- Duplicate text: old `[A#1, B#2]` → new `[A, A, B]` gives `#1, fresh, #2`; old `[A#1, A#2]` → new `[A, A]` gives
  `#1, #2`.
- Nested sub-items in an inner `ul.todo-list` keep theirs, and same-text sub-items under swapped parents follow
  their parents.
- Old HTML with one id on two items: the output ids are unique.
- An old item without an id gives its counterpart a fresh id; an id already on a new item is replaced.
- With `previousHtml` empty, every item gets a fresh id; the default generator writes `e` plus 32 hex digits.

**Done.** The spec is green under the server and standalone runners.

## T2 · Wire it into `set_note_content` and `append_to_note`

**Files.** `packages/trilium-core/src/services/llm/tools/helpers.ts` (`setNoteContentFromLlm`), `note_tools.ts`
(`set_note_content`, `append_to_note`), `note_tools.spec.ts` (holds the stuck-line worker's red, already applied).

**Tests first:**
- The stuck-line red: a meeting note read with `get_note_content` and written back with `set_note_content` keeps
  `eone`/`etwo`, the `_rescheduled` state and the scheduled mark.
- A model edit (one line ticked, one reworded, one added, nested sub-items) keeps the ids it should; the Markdown
  `get_note_content` returns contains no `list-item-id`.
- A `text/html` code note whose content holds `<ul><li>` is stored exactly as given; text → code stores the code as
  given; code → text gives fresh ids.
- `append_to_note` on a text note keeps the existing bytes (a characterization test, green from the start) and gives
  the appended items fresh ids (red).

**Done.** `note_tools.spec.ts` and `list_item_ids.spec.ts` green under both runners; `pnpm typecheck` clean.

## Outcome

The two tasks shipped as planned, but review rounds replaced the matching rules above. Two flaws drove the changes: a
sub-item of a reworded parent could take a deleted line's id, and duplicate text under different headings could trade
ids. The final rules are in the body of `fix(llm): match list items under their headings`:

- Headings are id-less parent nodes, and identity is (parent, text).
- Pass 1 defers a node whose parent has no counterpart yet.
- Pass 2 matches only within a sibling window.
- A node under a new parent takes an old id only when the text is unique on both sides.
- Attributes are spliced by token.

When a match is ambiguous, the item gets a fresh id.
