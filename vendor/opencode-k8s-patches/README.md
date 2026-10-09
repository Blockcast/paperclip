# opencode_k8s patches awaiting an upstream merge

`opencode_k8s` is built in the Dockerfile's `vendor` stage by cloning
`kkroo/paperclip-adapter-opencode-k8s` at `ARG OPENCODE_K8S_REF` and building it
unmodified. There is no patch-application step, and this directory does **not**
add one — a `.patch` here changes nothing about the image.

What it is: a change that belongs upstream, already written and verified against
the pinned ref, parked where the next person to touch the pin will find it.
Nothing here is applied, enforced, or shipped by being present.

## Why a patch rather than a pull request

No agent seat can push to the adapter repo or to its fork. Measured
2026-10-09 with `git push --dry-run`, which writes nothing:

| target | result |
|---|---|
| `kkroo/paperclip-adapter-opencode-k8s` | `403` — `Permission to … denied to allyblockcast[bot]` |
| `allyblockcast/paperclip-adapter-opencode-k8s` (the existing fork) | `403` — same |
| `POST /repos/…/forks` (new fork under `Blockcast`) | `403 Resource not accessible by integration` |

So the handoff needs a human with push rights to that repo. 64 of its 65 pull
requests are authored by `kkroo` from branches in the repo itself; the one
exception, #51, came from the `allyblockcast` fork and was merged — so the
fork route does work, it is just not reachable from here.

### The better durable route is to stop needing the fork

`claude_k8s` had this exact dependency and shed it: BLO-17980 (2026-08-06)
vendored its source in-tree at `vendor/paperclip-adapter-claude-k8s/` and
retired `ARG CLAUDE_K8S_REF`. `doc/ADAPTER-REPO-OWNERSHIP.md` records that as
done and names `paperclip-adapter-opencode-k8s` as the one remaining case.

That matters here beyond convenience. The reason this patch cannot simply be
written is that the code rendering every `opencode_k8s` Job — including its
GitHub-egress `PATH` — ships through one personal account with no review path
an agent can reach. Vendoring removes the external merge press entirely and
puts the adapter under this repo's own review, which is where a change to a
security control belongs. Mirroring the prepend upstream fixes one line in a
dependency we still cannot review.

Vendoring is a larger change than this patch and is not in PEN-3732's scope —
it needs its own issue, its own review, and the provenance machinery
`vendor/paperclip-adapter-claude-k8s/PROVENANCE.md` describes. It is recorded
here as the recommended route, not as a blocker for the patch below.

## `pen-3732-github-wrapper-path.patch`

Mirrors the `claude_k8s` adapter's GitHub-egress `PATH` prepend
(PEN-3713/PEN-3732) into the opencode adapter's `buildEnvVars()`.

Without it, an `opencode_k8s` Job resolves `git` and `gh` through the mode-755
copies on the shared PVC that every agent can rewrite, rather than the
root-owned wrappers in the image — and the chart's render guard reports healthy
regardless, because it renders onto the StatefulSet and the api Deployment and
never onto a Job.

**Latent, not live.** Measured 2026-10-02: 0 pods and 0 Jobs carry
`paperclip.io/adapter-type=opencode_k8s`, against positive controls of 27 pods
and 30 Jobs for `claude_k8s`. The adapter is nonetheless maintained and
selectable — it is one of exactly two entries in `ELIGIBLE_ADAPTER_TYPES`, and
the pin was bumped on 2026-10-07 — so it is not a vestige to retire.

Generated with `--unified=1` rather than the default three lines of context.
That is not a style choice: at `-U3` the context above the hunk pulls in an
upstream line of the form `__poroot='/data/.local/lib/...'`, which this repo's
egress push guard classifies as a high-entropy assignment and refuses to
publish. One line of context keeps the patch appliable and the blob clean.

Verified at pin `133f4c1a`, the SHA the Dockerfile currently carries:

- `git apply --check` clean against a pristine checkout of that pin
- `npm run typecheck` clean
- `npm test` 672 passed, from a 667-passing baseline — the 5 added are the new
  `PATH`-ordering cases
- mutation-checked rather than assumed: with the prepend removed 4 of the 5
  fail; with the guard and the de-dup filter removed, the idempotence and
  present-but-late cases fail. No test in the block is inert.

### To land it

1. Apply to a branch of the adapter repo and open a PR there:
   `git apply vendor/opencode-k8s-patches/pen-3732-github-wrapper-path.patch`
2. Once merged, bump `ARG OPENCODE_K8S_REF` to the merge commit.
3. Delete this patch and drop the SHA from `WRAPPER_PATH_GAP_ACCEPTED_PINS` in
   `scripts/check-opencode-k8s-pin-reachable.mjs`. That guard then verifies the
   property directly from the pinned tree and this file stops being needed.

### Keeping it honest

A committed patch is a frozen assertion that nothing re-evaluates, so this one
is not left to rot. `scripts/check-opencode-k8s-pin-reachable.mjs` reads the
property — not the patch — out of the pinned tree on every PR, and the pin's
acceptance is keyed to the exact SHA the gap was measured on. A bump that
carries the gap to a new SHA fails there and has to say so.
