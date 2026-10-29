#!/usr/bin/env bash
#
# Onboards an Arch machine onto the [ktn] pacman repository (Kautiontape/ktn-repo,
# listed at kautiontape.com/arch): trusts its signing key, adds the repo, and installs
# the desktop app. Also repoints machines set up when this fork served its own repo.
#
# Usage (deliberately not `curl | sudo bash` — this installs a trust anchor, so read
# it first):
#
#   curl -fsSL https://raw.githubusercontent.com/Kautiontape/trilium/ktn/packaging/arch/bootstrap-client.sh -o ktn-bootstrap.sh
#   less ktn-bootstrap.sh
#   sudo bash ktn-bootstrap.sh
#
# Safe to re-run: every step is idempotent.
set -euo pipefail

REPO_NAME="ktn"
PKG_NAME="triliumnext-ktn-bin"
SERVER="https://github.com/Kautiontape/ktn-repo/releases/download/repo"
KEY_URL="https://kautiontape.com/arch/ktn-repo.pub"
# Where [ktn] pointed before ktn-repo took over; its index stopped updating in July.
OLD_SERVER="https://github.com/Kautiontape/trilium/releases/download/ktn-repo"

# Pinned so a tampered or substituted key download is caught rather than trusted.
EXPECTED_FPR="36EF1180D7CBA87C0C0F8CBCE480A935E543D3C8"

PACMAN_CONF="/etc/pacman.conf"

die() { echo "error: $*" >&2; exit 1; }
note() { echo -e "\033[1;34m==>\033[0m $*"; }

command -v pacman >/dev/null || die "pacman not found — this script is for Arch systems."
[[ $EUID -eq 0 ]] || die "must run as root: sudo bash $0"

# --- 1. Fetch and validate the signing key -----------------------------------------
note "Fetching signing key"
TMPKEY=$(mktemp)
trap 'rm -f "$TMPKEY"' EXIT
curl -fsSL "$KEY_URL" -o "$TMPKEY" || die "could not download the key from $KEY_URL"

ACTUAL_FPR=$(gpg --show-keys --with-colons "$TMPKEY" | awk -F: '/^fpr/{print $10; exit}')
[[ -n "$ACTUAL_FPR" ]] || die "downloaded file is not a valid PGP key"

if [[ "$ACTUAL_FPR" != "$EXPECTED_FPR" ]]; then
    die "key fingerprint mismatch — refusing to trust it.
  expected: $EXPECTED_FPR
  got:      $ACTUAL_FPR"
fi
note "Fingerprint matches: $ACTUAL_FPR"

# --- 2. Trust it in pacman's keyring ------------------------------------------------
if pacman-key --list-keys "$EXPECTED_FPR" >/dev/null 2>&1; then
    note "Key already present in the pacman keyring"
else
    note "Adding key to the pacman keyring"
    pacman-key --add "$TMPKEY"
fi

note "Locally signing the key (marks it trusted for this machine)"
pacman-key --lsign-key "$EXPECTED_FPR"

# --- 3. Register the repository -----------------------------------------------------
# Server lines inside the [ktn] section only.
section_servers() {
    awk -v s="[${REPO_NAME}]" '$0 == s {in_s=1; next} /^\[/ {in_s=0} in_s && /^Server *=/' "$PACMAN_CONF"
}

if grep -q "^\[${REPO_NAME}\]" "$PACMAN_CONF"; then
    if section_servers | grep -qF "$OLD_SERVER"; then
        note "Repointing [${REPO_NAME}] from the retired fork repo to ${SERVER}"
        cp -a "$PACMAN_CONF" "${PACMAN_CONF}.bak.$(date +%Y%m%d%H%M%S)"
        sed -i "/^\[${REPO_NAME}\]/,/^\[/ s|^Server *= *${OLD_SERVER}\$|Server = ${SERVER}|" "$PACMAN_CONF"
        section_servers | grep -qF "$SERVER" || die "could not rewrite the [${REPO_NAME}] Server line; fix ${PACMAN_CONF} by hand"
    else
        note "[${REPO_NAME}] already present in ${PACMAN_CONF} — leaving it alone"
    fi
else
    note "Adding [${REPO_NAME}] to ${PACMAN_CONF}"
    cp -a "$PACMAN_CONF" "${PACMAN_CONF}.bak.$(date +%Y%m%d%H%M%S)"
    cat >> "$PACMAN_CONF" <<EOF

[${REPO_NAME}]
SigLevel = Required
Server = ${SERVER}
EOF
fi

# --- 4. Sync and install ------------------------------------------------------------
# One transaction: a bare -Sy followed by -S would leave the system partly upgraded.
# Replaces the AUR triliumnext-bin if present; pacman will ask to confirm the swap.
note "Syncing, upgrading and installing ${PKG_NAME}"
pacman -Syu --needed "$PKG_NAME"

note "Done. Launch it with 'triliumnext', or from your application menu."
