---
package: triliumnext-ktn-bin
summary: Trilium Notes desktop with journal navigation — a drop-in for the AUR `triliumnext-bin`
upstream: https://github.com/TriliumNext/Trilium
retire_when: Upstream ships equivalent journal navigation and calendar fixes; until then this tracks every upstream release
---
## What it is

The [TriliumNext](https://github.com/TriliumNext/Trilium) desktop app, built from Kautiontape's
fork. The same fork also runs the self-hosted Trilium server. The package mirrors the AUR
`triliumnext-bin` layout: system Electron, `app.asar` under `/usr/lib/triliumnext`, and the
launcher at `/usr/bin/triliumnext`. Your desktop entry, icon and data directory keep working when
it replaces that package.

## Why it exists

It's for daily journaling in Trilium. You can step between day, week, month, quarter and year
notes from the note you're on. It also carries a few calendar and mobile fixes that upstream hasn't
taken yet.

## How it differs from upstream

- A **journal navigation bar** under the note title moves to the previous or next day, week, month,
  quarter or year. It works with every week-numbering setting.
- Next and previous day-note **keyboard actions**, unbound by default, so you can assign your own
  shortcuts.
- Date-note routes are scoped to a validated calendar root, and archived calendar notes are found
  instead of being duplicated.
- "Notes edited on this day" starts collapsed, with a count in its title.
- Mobile editor: list controls are pinned to the front of the toolbar, and content-hint popups are
  gone.
- It tracks upstream **releases** (never `main`) via fork-sync in merge mode. "Upstream base" above
  is the release it currently sits on.
