# ktn pacman package

The `ktn desktop repo` workflow builds the Electron app from `ktn`, packages it for
Arch, signs it, and uploads it to this fork's `ktn-repo` release. That release is only
a staging area. Clients install from the shared `[ktn]` repository,
[Kautiontape/ktn-repo](https://github.com/Kautiontape/ktn-repo), listed at
[kautiontape.com/arch](https://kautiontape.com/arch/). Its nightly publish downloads
the `*.pkg.tar.zst` from here, re-signs it with its own key and adds it to `ktn.db`.

Once set up, every machine tracks the fork with `pacman -Syu` like any other package.

```
push to ktn
 └─ ktn desktop repo
     ├─ electron-forge package        → app.asar
     ├─ makepkg (archlinux container) → triliumnext-ktn-bin-<ver>-x86_64.pkg.tar.zst
     ├─ gpg --detach-sign, repo-add   → .sig and ktn-trilium.db (unused downstream)
     └─ gh release upload --clobber   → tag `ktn-repo` on this fork
daily cron, or `gh workflow run publish --repo Kautiontape/ktn-repo`
 └─ ktn-repo publish                  → re-signed into [ktn], tag `repo` on ktn-repo
```

The package deliberately mirrors the AUR `triliumnext-bin` layout — system Electron,
`app.asar` under `/usr/lib/triliumnext`, launcher at `/usr/bin/triliumnext` — and
declares `conflicts=('triliumnext-bin' ...)`, so it swaps in cleanly and your existing
desktop entry, icon and data directory keep working.

---

## One-time: create the staging signing key

The workflow refuses to run without `ARCH_REPO_GPG_KEY`. ktn-repo discards this
signature and signs with its own key, so no client trusts this one. Do this **once**,
on a machine you trust. The private key never needs to leave it except as a GitHub
secret.

```bash
gpg --quick-generate-key "Shawn Squire (ktn repo) <shawn@shawnsquire.me>" rsa4096 sign never

# Note the long key id (the hex after `sec   rsa4096/`):
gpg --list-secret-keys --keyid-format=long
```

Export it into the repository secrets the workflow reads:

```bash
KEYID=<your-long-key-id>

gpg --armor --export-secret-keys "$KEYID" \
  | gh secret set ARCH_REPO_GPG_KEY --repo Kautiontape/trilium

gh secret set ARCH_REPO_GPG_PASSPHRASE --repo Kautiontape/trilium
# (paste the passphrase; leave empty only if you generated the key without one)
```

Clients trust ktn-repo's key instead (`36EF1180D7CBA87C0C0F8CBCE480A935E543D3C8`,
served at `https://kautiontape.com/arch/ktn-repo.pub`).

---

## Per machine: one script

On the laptop, or any new Arch machine:

```bash
curl -fsSL https://raw.githubusercontent.com/Kautiontape/trilium/ktn/packaging/arch/bootstrap-client.sh -o ktn-bootstrap.sh
less ktn-bootstrap.sh      # it installs a trust anchor — worth a read
sudo bash ktn-bootstrap.sh
```

It fetches ktn-repo's signing key, **verifies its fingerprint against a pinned value**,
adds it to the pacman keyring, appends the `[ktn]` repo to `/etc/pacman.conf` (backing
the file up first), then upgrades and installs `triliumnext-ktn-bin` in one
`pacman -Syu`, replacing the AUR `triliumnext-bin` if present. Every step is
idempotent, so re-running is safe.

A machine set up before ktn-repo existed has `[ktn]` pointing at this fork's release,
whose `ktn.db` stopped updating in July 2026. The script repoints that `Server` line
(after a backup) instead of leaving it alone. Re-run it on any such machine.

Deliberately *not* a `curl | sudo bash` one-liner: this establishes a package-signing
trust anchor, so it should be read before it runs.

From then on, `sudo pacman -Syu` picks up every new `ktn` build.

<details>
<summary>Equivalent manual steps</summary>

```bash
curl -fsSLO https://kautiontape.com/arch/ktn-repo.pub
sudo pacman-key --add ktn-repo.pub
sudo pacman-key --lsign-key 36EF1180D7CBA87C0C0F8CBCE480A935E543D3C8
```

```ini
# /etc/pacman.conf
[ktn]
SigLevel = Required
Server = https://github.com/Kautiontape/ktn-repo/releases/download/repo
```

```bash
sudo pacman -Syu triliumnext-ktn-bin
```

</details>

---

## Versioning

`pkgver` is `<upstream>.r<commits>.g<sha>` — e.g. `0.104.0.r4213.gb63733f`. It is
monotonic across commits, contains no dashes (which pacman forbids), and still
orders correctly after a merge from upstream bumps the base version.

## Things that will bite

**The Electron dependency is derived, not pinned by hand.** The workflow reads
`apps/desktop/package.json` and depends on `electron<major>`. If the fork bumps
Electron to a major that Arch has not packaged yet, the build will produce a package
whose dependency cannot be satisfied. That is the correct failure — better than a
package that installs and then refuses to launch.

**The repository is public.** The fork and ktn-repo are public repos, so the release
assets are world-readable. That is what lets the laptop update from anywhere without a VPN, but
it does mean anyone can download your build. Nothing secret ships inside the package
(your notes live in your data directory, not the asar), but be aware of it.

**Builds can reach clients up to a day late.** A push here only updates the staging
release. Clients see the build after ktn-repo's next daily publish (cron 06:17 UTC,
which GitHub often starts hours late), or right away with
`gh workflow run publish --repo Kautiontape/ktn-repo`.

**Only `x86_64` is built.** Add a second matrix leg if you ever want aarch64.
