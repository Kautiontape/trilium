# Plan: the Jira site and projects come from config, not the code

`packages/caius/src/trilium/keys.ts` hard-codes a Jira site (`JIRA_BASE`) and the projects whose bare keys count in
task text (`JIRA_PROJECTS`), and the tests, fixtures, skill sheet and docs repeat them. This plan moves both into
configuration and then replaces every remaining occurrence with invented ones. No history rewrite.

One PR against `ktn` from `ktn-caius-jira-config`. Every task is test-first: the failing test, a red run, the code, a
green run. Each task is one commit by explicit path. Order: T1, T2, T3 and T4, one after another; T4 is the scrub and
lands last, as its own commit.

## The design

**Where the values come from.**
- **The site.** The server's `JIRA_BASE_URL`, which the Jira input already reads. The browse base is that value with
  trailing slashes dropped, plus `/browse/`.
- **The projects.** A line in the standing note's Rhythm section, in the style of its other one-line settings:
  `- Jira: ABC, XYZ`. Its projects are the capitalised words after `Jira:` (`Jira projects:` reads too; a bold
  `**Jira:**` too). With no such line, no bare key counts. A key inside a `/browse/KEY` link still counts, whatever
  its project, and so does a `source` key.

**How the library gets them.** `keys.ts` holds a small `KeyConfig` (`projects`, `browseBase`), empty by default and
replaced with `setKeyConfig()`. `taskKeys(text, hrefs, projects)` and `parseSource(source, browseBase)` take an
optional last argument that wins over the config, so their own specs pass it explicitly.

This is a module-level setting rather than a parameter threaded through every caller, for two reasons:
- The server derives keys at about 30 call sites (`apply.ts`, `daily.ts`, `views.ts`, `writes.ts`, `service.ts`),
  most inside helpers with no `deps` to carry a list, and in the files other open branches are editing.
- Every derivation in one call must agree. A dismissal stores `taskKeys(...)[0]`, and the duplicate checks compare
  keys from other sites. One site that missed the list would bring dismissed items back with no error.

The server sets the config at one place every call passes: the lock. Inside `createCaiusService`, a local
`withCaiusLock` wraps `store.ts`'s and, once it holds the lock, reads the standing note's Jira line and
`JIRA_BASE_URL` into `setKeyConfig()`. Every service entry point, including `caius_show` and `caius_inputs` (through
`locked`), takes the lock through it. The standing note's markdown is reused while its `utcDateModified` is
unchanged.

**A bare-key `source` with no `JIRA_BASE_URL`** keeps its key and label and gets no link (`url: null`). The task
reads "Review ABC-12" with the key as plain text, and `keys` is `["ABC-12"]`. This is the gentler of the two choices:
refusing would block `caius_add` on a server with no Jira configured. The cost: once written, that task is
recognised again by its key only if its project is on the Jira line; otherwise later reads hash its text.

## T1 · The key config in the library

**Files.** `packages/caius/src/trilium/keys.ts`, `plan.ts` (`describe`, the `JIRA_BASE` import and re-export),
`daily/standing.ts` (`readJiraProjects`), `src/index.ts` and `src/trilium/index.ts` (exports: drop `JIRA_BASE`, add
`setKeyConfig`, `keyConfig`, `readJiraProjects`, the `KeyConfig` type); specs `trilium/plan.spec.ts` (the `taskKeys`
and `parseSource` block), `daily/standing.spec.ts`, and every package spec that relied on the hard-coded projects or
site.

**Change.**
- `KeyConfig { projects: string[]; browseBase: string | null }`, default `{ projects: [], browseBase: null }`.
  `setKeyConfig(next)` replaces it; `keyConfig()` returns it.
- The bare-key pattern is built from the projects in use. An empty list matches nothing (a pattern built from `[]`
  would be `\b(?:)-\d+\b` and match `-8` in `UTF-8`).
- `parseSource` with a key and a base gives the link as today. With a key and no base it gives
  `{ keys: [key], url: null, label: key, jira: key }`. A URL source is unchanged.
- `describe` in `plan.ts`: with `url: null`, a key already in the text stays as text; otherwise the key follows the
  text as plain text.
- `readJiraProjects(markdown)`: the capitalised words after `Jira:` on a line of the Rhythm section, with a list
  marker (`-`, `*   `, as Trilium's markdown export writes it) and bold allowed, deduplicated, in order; `[]` when
  there is no such line.

**Tests first.**
- `taskKeys('Fix ABC-1 and UTF-8', [], ['ABC'])` is `['ABC-1']`; with `[]` it is the text hash; with `['ABC']` a
  `/browse/QRS-9` link still gives `QRS-9`; `UTF-8` is never a key, list or no list.
- `parseSource('ABC-1', 'https://example.atlassian.net/browse/')` links to that URL;
  `parseSource('ABC-1', null)` is `{ keys: ['ABC-1'], url: null, label: 'ABC-1', jira: 'ABC-1' }`; the config is the
  default when no argument is passed.
- `addTasks` with a `source` key and no base writes the key as text, no `<a>`.
- `readJiraProjects`: `- Jira: ABC, XYZ` and `*   **Jira:** ABC, XYZ.` read `['ABC', 'XYZ']`; a Brief rules bullet
  "Jira: name tickets by key" reads `[]`; no line reads `[]`.

**Done.** The new specs went red, then green. The whole package suite is green, with the specs that relied on the
hard-coded values setting the config in a `beforeEach` (the invented `https://example.atlassian.net/browse/` as the
base; the projects their keys use).

## T2 · The server sets the config under the lock

**Files.** `apps/server/src/services/caius/service.ts` (a local `withCaiusLock` in `createCaiusService` and its
`syncKeys` helper), `apps/server/vite.config.mts` (`JIRA_BASE_URL: "https://example.atlassian.net"` in the test
`env`, beside `TRILIUM_PUBLIC_SERVER`); a new spec beside the other integration specs; the standing-note fixtures of
the server specs that relied on bare keys.

**Change.** As in the design. `syncKeys()` reads the standing note (reusing its markdown while `utcDateModified` is
unchanged), `readJiraProjects` of it, and `process.env.JIRA_BASE_URL`, and calls `setKeyConfig`. No call site in
`apply.ts`, `daily.ts`, `views.ts` or `writes.ts` changes.

**Tests first** (a new `jira-config.integration.spec.ts`, invented keys only).
- With `- Jira: ABC` in the standing note's Rhythm, a `caius_add` of "Review ABC-12" when "Check ABC-12" is open in
  the Journal is skipped `duplicate`; without the line it is added.
- Editing the standing note to add the line takes effect on the next call.
- `caius_add` with `source: "ABC-12"` writes a link to `https://example.atlassian.net/browse/ABC-12`; with
  `JIRA_BASE_URL` stubbed empty it writes "ABC-12" as text, and a second add of the same source is still a
  `duplicate`.

**Done.** The new spec went red, then green. `pnpm exec vitest run src/services/caius src/routes/api/caius.spec.ts`
is green except the known "reports Caius as enabled" failure. Fixture edits only add the Jira line (or a standing note
holding it) and touch no assertion.

## T3 · The docs

**Files.** `docs/ktn/caius/method.md` (the bare-keys rule), `docs/ktn/caius/README.md` (the standing note's lines,
beside the rollover and location lines), `docs/ktn/caius/internals.md` (the `JIRA_BASE_URL` row: it also gives task
links; and the key config under the library's notes).

**Change.** Describe the Jira line, its format and what no line means; that `JIRA_BASE_URL` gives `source` keys
their links and what happens without it; and that the line must be on the standing note for bare keys to count. No
skill-sheet line: Caius passes keys as `source` and never needs to know which projects count.

**Done.** `docs/ktn` names no project list or site from the code.

## T4 · Scrub the hard-coded site and projects

**Files.** Every text file holding the hard-coded site, the company name or a key with one of the hard-coded
projects: specs, fixtures, the skill sheet, `schemas.ts` and other comments, the phone app, the client and
`docs/ktn`.

**Script.** Outside the repo, at `~/documents/apps/caius-runs/open-items-2026-11-16/jira-scrub.sh`, re-runnable and
idempotent, so it can run again after other branches merge. It maps the hard-coded site to `example.atlassian.net`,
the company name to an invented one, and the four projects to `ABC`, `XYZ`, `DEF` and `QRS`, keeping the numbers. It
maps keys, the projects as bare words ("… bugs" group names, a regex such as `KEY.*`, the Jira line in fixtures) and
lower-case keys, but not list-item ids that only look like keys. It reads text files only (`git grep -I`), stays out
of `node_modules` and `pnpm-lock.yaml`, and fails before writing when a mapped key would equal a key the same file
already holds.

**Done.**
- A case-insensitive grep of the tree (outside `node_modules` and `pnpm-lock.yaml`) for the site, the company name and
  the four projects as keys or words finds nothing.
- The suites pass: packages/caius, server caius + routes, caius-app, client plan + services.
- `pnpm typecheck` is clean.
- A second run of the script changes nothing.
