# ktn pacman repository

The `ktn desktop repo` workflow builds the Electron app from `ktn`, packages it for
Arch, signs it, and publishes a pacman repository as assets on the `ktn-repo` release.

Once set up, every machine tracks the fork with `pacman -Syu` like any other package.

```
push to ktn
 └─ ktn desktop repo
     ├─ electron-forge package        → app.asar
     ├─ makepkg (archlinux container) → triliumnext-ktn-bin-<ver>-x86_64.pkg.tar.zst
     ├─ gpg --detach-sign             → .sig for package and database
     ├─ repo-add                      → ktn.db / ktn.files
     └─ gh release upload --clobber   → tag `ktn-repo`
```

The package deliberately mirrors the AUR `triliumnext-bin` layout — system Electron,
`app.asar` under `/usr/lib/triliumnext`, launcher at `/usr/bin/triliumnext` — and
declares `conflicts=('triliumnext-bin' ...)`, so it swaps in cleanly and your existing
desktop entry, icon and data directory keep working.

---

## One-time: create the signing key

Do this **once**, on a machine you trust. The private key never needs to leave it
except as a GitHub secret.

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

Export the **public** key — this is what every client machine needs:

```bash
gpg --armor --export "$KEYID" > ktn-repo.pub
```

Keep `ktn-repo.pub` somewhere you can reach from your other machines (it is not
secret; committing it here or dropping it on the LAN is fine).

---

## Per machine: one script

On the laptop, or any new Arch machine:

```bash
curl -fsSL https://raw.githubusercontent.com/Kautiontape/trilium/ktn/packaging/arch/bootstrap-client.sh -o ktn-bootstrap.sh
less ktn-bootstrap.sh      # it installs a trust anchor — worth a read
sudo bash ktn-bootstrap.sh
```

It fetches the signing key, **verifies its fingerprint against a pinned value**, adds
it to the pacman keyring, appends the `[ktn]` repo to `/etc/pacman.conf` (backing the
file up first), syncs, and installs `triliumnext-ktn-bin` — replacing the AUR
`triliumnext-bin` if present. Every step is idempotent, so re-running is safe.

Deliberately *not* a `curl | sudo bash` one-liner: this establishes a package-signing
trust anchor, so it should be read before it runs.

From then on, `sudo pacman -Syu` picks up every new `ktn` build.

<details>
<summary>Equivalent manual steps</summary>

```bash
sudo pacman-key --add packaging/arch/ktn-repo.pub
sudo pacman-key --lsign-key C20F8574816A1B67C81E6F829DA4E0459723DB07
```

```ini
# /etc/pacman.conf
[ktn]
SigLevel = Required
Server = https://github.com/Kautiontape/trilium/releases/download/ktn-repo
```

```bash
sudo pacman -Syu
sudo pacman -S triliumnext-ktn-bin
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

**The repository is public.** The fork is a public repo, so the release assets are
world-readable. That is what lets the laptop update from anywhere without a VPN, but
it does mean anyone can download your build. Nothing secret ships inside the package
(your notes live in your data directory, not the asar), but be aware of it.

**Uploads are not atomic.** The database and the package are uploaded in the same
step but as separate assets. A `pacman -Syu` landing in that window can see a
database referencing a package file that is not there yet; re-running fixes it.

**Only `x86_64` is built.** Add a second matrix leg if you ever want aarch64.
