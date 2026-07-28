#!/usr/bin/env bash
#
# ktn-sync-upstream.sh — merge an upstream release tag into the `ktn` deploy branch.
#
# Merges a TriliumNext/Trilium *release tag* (never `upstream/main`, which carries
# unreleased commits) into `ktn` on a scratch branch, verifies it locally, and pushes
# only once every gate is green. `ktn` is never modified until then.
#
# Nothing in the ktn CI pipeline runs tests — `checks.yml` no-ops on the fork, and
# dev/playwright/codeql are filtered to upstream branches — so the verification here
# is the only thing standing between a bad merge and a live deploy.
#
# Pushing `ktn` triggers: GHCR publish -> SSH deploy to LXC 110 -> signed pacman repo
# rebuild. Treat a successful run as a production release.
#
# Usage:
#   scripts/ktn-sync-upstream.sh                  # pick a tag interactively
#   scripts/ktn-sync-upstream.sh --tag v0.104.2   # non-interactive
#   scripts/ktn-sync-upstream.sh --dry-run        # print mutating commands, run none
#   scripts/ktn-sync-upstream.sh --no-push        # stop after verification

# -E (errtrace) matters: without it the ERR trap below is not inherited by shell
# functions, so any failure inside run()/verify() would lose its stage label.
set -Eeuo pipefail

UPSTREAM_REMOTE="upstream"
ORIGIN_REMOTE="origin"
DEPLOY_BRANCH="ktn"
RELEASE_TAG="ktn-repo"

TAG=""
DRY_RUN=0
NO_PUSH=0
SKIP_PKGVER_GATE=0
STAGE="startup"

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; reset=$'\033[0m'

trap 'printf "\n%sFailed during: %s%s\n" "$red$bold" "$STAGE" "$reset" >&2' ERR

die() { printf '%serror:%s %s\n' "$red$bold" "$reset" "$*" >&2; exit 1; }
info() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
warn() { printf '%swarn:%s %s\n' "$yellow$bold" "$reset" "$*" >&2; }

# Mutating commands go through run() so --dry-run is honoured in one place.
run() {
    if (( DRY_RUN )); then
        printf '   %s[dry-run]%s %s\n' "$yellow" "$reset" "$*"
    else
        "$@"
    fi
}

usage() { sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while (( $# )); do
    case "$1" in
        --tag) TAG="${2:-}"; [[ -n "$TAG" ]] || die "--tag needs a value"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --no-push) NO_PUSH=1; shift ;;
        --skip-pkgver-gate) SKIP_PKGVER_GATE=1; shift ;;
        -h|--help) usage ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

# ---------------------------------------------------------------- preflight ---
STAGE="preflight"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
cd "$REPO_ROOT"

[[ -f packaging/arch/PKGBUILD.in ]] || die "this does not look like the ktn fork (packaging/arch/PKGBUILD.in missing)"
git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 || die "no '$UPSTREAM_REMOTE' remote configured"

# Untracked files are fine; staged or modified tracked files are not, because the
# merge and the .ktn-base commit would sweep them up.
if ! git diff --quiet || ! git diff --cached --quiet; then
    die "working tree has uncommitted changes to tracked files — commit or stash first"
fi

info "Fetching $UPSTREAM_REMOTE tags"
run git fetch "$UPSTREAM_REMOTE" --tags --prune --quiet
run git fetch "$ORIGIN_REMOTE" --prune --quiet

# ------------------------------------------------------------- pick a tag ---
STAGE="tag selection"

mapfile -t TAGS < <(git tag -l 'v*' --sort=-v:refname | head -15)
(( ${#TAGS[@]} )) || die "no v* tags found — is the $UPSTREAM_REMOTE remote fetched?"

if [[ -z "$TAG" ]]; then
    labels=()
    for t in "${TAGS[@]}"; do
        when=$(git log -1 --format=%cs "$t")
        if git merge-base --is-ancestor "$t" "$DEPLOY_BRANCH" 2>/dev/null; then
            labels+=("$t  ($when)  — already merged")
        else
            labels+=("$t  ($when)")
        fi
    done

    if command -v gum >/dev/null 2>&1; then
        chosen=$(printf '%s\n' "${labels[@]}" \
            | gum choose --height 12 --header "Merge which upstream release into $DEPLOY_BRANCH?")
    else
        PS3="Merge which upstream release into $DEPLOY_BRANCH? "
        select chosen in "${labels[@]}"; do [[ -n "$chosen" ]] && break; done
    fi
    [[ -n "${chosen:-}" ]] || die "no tag selected"
    TAG=${chosen%% *}
fi

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag '$TAG' does not exist"
if git merge-base --is-ancestor "$TAG" "$DEPLOY_BRANCH" 2>/dev/null; then
    die "$TAG is already merged into $DEPLOY_BRANCH — nothing to do"
fi

SCRATCH="ktn-sync-$TAG"
if git show-ref --verify --quiet "refs/heads/$SCRATCH"; then
    die "branch $SCRATCH already exists (left by an earlier run). Inspect it, then: git branch -D $SCRATCH"
fi

# ------------------------------------------------------------------ merge ---
STAGE="merge"
info "Merging $TAG into a scratch branch ($SCRATCH)"

run git switch -c "$SCRATCH" "$DEPLOY_BRANCH" --quiet
if (( ! DRY_RUN )); then
    if ! git merge --no-ff "$TAG" -m "ktn: merge upstream $TAG" --quiet; then
        printf '\n%sConflicts:%s\n' "$red$bold" "$reset" >&2
        git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
        printf '\nResolve them here on %s, then finish by hand:\n' "$SCRATCH" >&2
        printf '  git commit && git switch %s && git merge --ff-only %s\n' "$DEPLOY_BRANCH" "$SCRATCH" >&2
        exit 1
    fi
else
    printf '   %s[dry-run]%s git merge --no-ff %s\n' "$yellow" "$reset" "$TAG"
fi

# .ktn-base has had no machine consumers since ktn-upstream-sync.yml was deleted, but
# it is the human-readable record of which release ktn sits on. Keep it honest.
STAGE="stamping .ktn-base"
if (( ! DRY_RUN )); then
    if [[ "$(cat .ktn-base 2>/dev/null || true)" != "$TAG" ]]; then
        echo "$TAG" > .ktn-base
        git commit -am "ktn: track $TAG" --quiet
    fi
else
    printf '   %s[dry-run]%s echo %s > .ktn-base && git commit\n' "$yellow" "$reset" "$TAG"
fi

# ------------------------------------------------------------------ verify ---
STAGE="verification"
info "Verifying (this is the only gate — CI runs no tests)"

verify() {
    local label=$1; shift
    printf '  %s->%s %s\n' "$bold" "$reset" "$label"
    if (( DRY_RUN )); then
        printf '     %s[dry-run]%s %s\n' "$yellow" "$reset" "$*"
        return 0
    fi
    # Capture rather than re-run on failure; server:build alone is minutes.
    local log; log=$(mktemp)
    if ! "$@" >"$log" 2>&1; then
        printf '\n%s--- %s output (last 40 lines) ---%s\n' "$red" "$label" "$reset" >&2
        tail -40 "$log" >&2
        rm -f "$log"
        return 1
    fi
    rm -f "$log"
}

verify "install"    pnpm install --frozen-lockfile
verify "typecheck"  pnpm typecheck
verify "client tests" pnpm --filter client test \
    src/services/journal_navigation.spec.ts \
    src/widgets/layout/JournalNavigation.spec.tsx \
    src/services/date_notes.spec.ts
verify "core tests" pnpm --filter server test special_notes
verify "server build" pnpm run server:build

# The two translation JSONs are the only files both sides routinely edit. A bad
# resolution there yields invalid JSON or silently dropped keys, and nothing on ktn
# would catch it.
verify "translation JSON is parseable" node -e '
    for (const f of [
        "apps/client/src/translations/en/translation.json",
        "apps/server/src/assets/translations/en/server.json",
    ]) JSON.parse(require("fs").readFileSync(f, "utf8"));
'

# ------------------------------------------------------------ pkgver gate ---
# ktn-desktop-repo.yml builds pkgver as <version>.r<commit count>.g<sha>. pacman only
# offers an upgrade when that increases, and PKGBUILD.in carries no epoch= to recover
# with, so a regression wedges every installed client. Fail closed.
STAGE="pkgver monotonicity gate"

LOCAL_COUNT=$(git rev-list --count HEAD)
PUBLISHED_COUNT=$(gh release view "$RELEASE_TAG" --json assets --jq '.assets[].name' 2>/dev/null \
    | grep -oE '\.r[0-9]+\.g[0-9a-f]+' | head -1 | grep -oE '[0-9]+' | head -1 || true)

if (( DRY_RUN )); then
    # No merge happened, so LOCAL_COUNT is still the deploy branch's own count and
    # would compare equal. Report the inputs rather than failing on a phantom.
    info "pkgver gate: would compare local r$LOCAL_COUNT against published ${PUBLISHED_COUNT:+r}${PUBLISHED_COUNT:-<unreadable>}"
elif [[ -z "$PUBLISHED_COUNT" ]]; then
    if (( SKIP_PKGVER_GATE )); then
        warn "could not read the published pkgver; continuing because --skip-pkgver-gate was given"
    else
        die "could not read the published pkgver from the '$RELEASE_TAG' release.
       Refusing to push blind — a lower r-number would make pacman refuse the upgrade.
       Override with --skip-pkgver-gate once you have checked by hand."
    fi
elif (( LOCAL_COUNT <= PUBLISHED_COUNT )); then
    die "pkgver would regress: local r$LOCAL_COUNT <= published r$PUBLISHED_COUNT.
       pacman would refuse the upgrade and PKGBUILD.in has no epoch= to recover with.
       This usually means history was rewritten. Investigate before pushing."
else
    info "pkgver gate ok: r$PUBLISHED_COUNT -> r$LOCAL_COUNT"
fi

# -------------------------------------------------------------------- push ---
if (( NO_PUSH )); then
    printf '\n%sVerified.%s Stopping before push as requested. Finish with:\n' "$green$bold" "$reset"
    printf '  git switch %s && git merge --ff-only %s && git push %s %s\n' \
        "$DEPLOY_BRANCH" "$SCRATCH" "$ORIGIN_REMOTE" "$DEPLOY_BRANCH"
    exit 0
fi

STAGE="push"
info "All gates green — pushing $DEPLOY_BRANCH (this deploys)"

run git switch "$DEPLOY_BRANCH" --quiet
run git merge --ff-only "$SCRATCH" --quiet
run git push "$ORIGIN_REMOTE" "$DEPLOY_BRANCH"
run git branch -D "$SCRATCH" --quiet

printf '\n%sSynced %s -> %s.%s Now running: build & publish, desktop repo, then deploy.\n' \
    "$green$bold" "$TAG" "$DEPLOY_BRANCH" "$reset"
printf '  gh run list --repo Kautiontape/trilium --limit 3\n'
