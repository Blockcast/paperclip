# `docker/github-hooks/` — the PEN-3156 pre-push publish guard, as a file

One file, `pre-push`: the launcher git runs via `core.hooksPath` before a publish.
It is a one-line `exec` into `github-git-egress-runtime.js`, exactly the shape of
the wrappers in `../github-wrappers/`, and it is installed the same way — root-owned,
mode 0755, under `/usr/local/libexec/paperclip/`.

## Why this directory exists (PEN-4932 stage 3b)

Until now this file had no home in the repo. It was written at deploy time by a
heredoc in `deploy/helm/paperclip/templates/statefulset.yaml`, onto the shared
`paperclip-data` PVC, and every agent pod reached it through a `subPath` mount
(`ROOT_TOOLCHAIN_SUBPATHS`). That arrangement has two costs this directory retires.

**It is the last cross-agent mount.** PEN-4932 is removing the shared RWX volume so
that one hung `NodeUnstageVolume` can no longer brick a whole node's agents. Every
other toolchain entry is already baked or dead; `.local/share/paperclip-git-hooks` is
the only one left, so it is the only thing still holding the shared handle open for
that purpose.

**On the PVC it is agent-writable, and cannot be otherwise.** The chart's seed says so
itself: it runs `runAsUser: 1000` against an `fsGroup: 1000` volume, so "the chart has
no root to make it otherwise". The guard's launcher being rewritable by the very uid it
constrains is a gap the wrappers already closed for themselves in PEN-3715/PEN-3840 —
baking the file closes it here by the same mechanism, because `COPY` with no `--chown`
lands root-owned and uid 1000 cannot replace it.

It also deletes a drift class rather than documenting one. PEN-4518 cost the fleet
2h17m of publishing because the seed wrote the hook to the PVC while the Job pod saw an
overlay — the seed's success log stayed true the whole time. A file that ships in the
image either builds or does not; there is no seed-versus-visibility gap left for a mount
change to open.

## The contract

- **The body is joined by test, not by convention.** `agent-egress-path.test.mjs`
  compares this file byte-for-byte against the chart seed's heredoc. The two must agree
  for as long as both exist, which is how the staged rollout stays safe.
- **`*.md` is excluded from the `COPY`.** Everything installed from here lands 0755, so
  a doc file added later would ship executable. Same rule as `../github-wrappers/`.
- **Do not add a second hook here casually.** `core.hooksPath` is injected for `push`
  only, and a hooks directory holding only `pre-push` makes every *other* hook a
  repository defines silently stop running. Adding `pre-commit` here would change that
  blast radius.

## Rollout, and why the runtime does not point here yet

This directory is stage 3b-**i**: the file ships in the image and nothing reads it. The
runtime still resolves `DEFAULT_HOOKS_DIR` on the PVC, so behaviour is unchanged and an
agent on an older image is unaffected.

Repointing is deliberately a later, separate step, because the failure mode is
asymmetric. `runGitEgressRuntime` refuses a publish when it finds no executable
`pre-push` where it looks — so a repoint that lands before the images carry the file
does not publish unscanned, it **refuses every push in the fleet**. That is the safe
direction, and it is still a fleet-wide outage. The order is therefore: ship the file,
measure that agent pods run an image containing it, then repoint with a PVC fallback,
then drop the seed and the `subPath`.

⛔ **The presence check is what makes that safe. Do not remove it.** Git itself treats a
`core.hooksPath` holding no `pre-push` as success and publishes unscanned — silently.
`prePushHookPresent` is the only thing converting that into a refusal, and the
temptation once this file is image-resident is to read the check as redundant. It is
not: it is the control that keeps the failure loud.
