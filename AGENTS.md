
## Kautiontape deployment fork

This is a deployment fork of TriliumNext/Trilium (`upstream`). The `ktn` branch
carries `ktn:`-prefixed patches + CI/deploy scaffolding on top of `.ktn-base`
(the tracked upstream tag). It builds `ghcr.io/kautiontape/trilium` and deploys
to the homelab (LXC 110) via the org `ktn` runner. **Design docs live in Obsidian
(`Servers/Yuffie/`), not in this public repo.** Keep secrets out of the tree.
