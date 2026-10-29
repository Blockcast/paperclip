# PEN-4932 — Give agent pods per-agent volumes instead of one shared CephFS RWX PVC

Status: in progress. Stages 1 and 2 done (bake the live fleet-wide toolchain; resolve every
`DECIDE`/`RELOCATE` row by measurement). Stage 3 — removing the mount — is the next and first
fleet-affecting step. Implements direction (a) decided in PEN-3199 /
`docs/CEPHFS-SHARED-PVC-BLAST-RADIUS.md` (penstock-llm-proxy-core PR #2941).

## 1. Why this document exists

PEN-3199 chose per-agent volumes and rejected a `NodeUnstageVolume` timeout. It routed the
*implementation* here because `penstock-llm-proxy-core` carries no ceph-csi or `paperclip-data`
manifest. The decision is not re-litigated below; what follows is the measured state of the one
thing PEN-3199 could not specify — **what the shared volume is actually used for** — and the
staging that measurement forces.

## 2. The decision on the fleet-wide tooling row, and the option that is refused

PEN-4932's description offered two options for the cross-agent tooling row: a separate
**read-only claim**, or **baking into the agent image**. Those are not equivalent and only the
second works.

A shared read-only CephFS claim is still **one volume ID mounted by every agent pod on the
node**. It takes the same ceph-csi per-volume lock, and its teardown goes through the same
`NodeUnstageVolume` → kernel `umount` path that hangs in D-state. `readOnly: true` constrains
what *pods write*; it changes nothing about *the lock*. Adopting it would leave node-wide blast
radius intact for whatever depends on that claim while every other part of the change looked
done.

> **Decision: bake into the image. A shared read-only claim is refused.** Anything that leaves a
> single volume handle mounted node-wide keeps node-wide blast radius, regardless of mount flags.

This correction was raised on PEN-4932 by the issue author after Ally's review of PR #2941; the
authoritative statement is §3.1 of `docs/CEPHFS-SHARED-PVC-BLAST-RADIUS.md`.

### Accepted cost

The shared volume stages **once per node**. Per-agent volumes stage once per **(agent, node)**
pair — up to ~19× on `k8s-paperclip-3` at 2026-10-28 occupancy. That is accepted, and is the same
kind of cost that rejects per-*run* volumes only far smaller: it scales with the number of
*distinct agents* on a node and amortises over every run that agent performs, where per-run scales
with the *run rate* and amortises over nothing. More operations, each with blast radius one agent
instead of one node, **is the point of the change** — not a side effect to minimise.

## 3. Measured: what the shared mount actually carries

Read 2026-10-28 from a live agent pod (`ac-29033747-…-7gt5v`, node `k8s-paperclip-7`) and from the
`claude_k8s` Job spec. The Job declares **21 `subPath` mounts, all off one volume**
(`claimName: paperclip-data`, handle `csi-vol-3bdd0e68-…`); `/paperclip` itself is an `emptyDir`
overlay.

Fourteen of those mounts are already namespaced by company / project / agent / workspace path and
become per-agent claims mechanically. The remaining seven are `ROOT_TOOLCHAIN_SUBPATHS`
(`job-manifest.ts`, `const ROOT_TOOLCHAIN_SUBPATHS` — `:636` at `cfc80829`) — `bin`, `tools`, `jre`, `.local/bin`, `.local/share/paperclip-git-hooks`,
`.bun/bin`, `.cache/puppeteer-browsers` — mounted read-only into every agent pod. **That row is
the only genuinely cross-agent one, and it is what keeps the shared handle alive.**

### 3.1 The row is not "read-mostly tooling"

PEN-4932 characterised it that way. Inventoried, it is accreted mutable fleet state with mtimes
spanning **Nov 2024 → Oct 2026**, including unextracted tarballs (`go1.25.6.linux-amd64.tar.gz`,
`jre.tar.gz`, `tinygo0.39.0.linux-amd64.tar.gz`) and hand-dropped files (`tools/kexec.py`,
`tools/openapi-generator-cli.jar`). `.local/share/paperclip-git-hooks/pre-push` was modified the
same day it was read, so the row is not even read-*only* in practice — the server writes it
through its own mount while agents see it `readOnly: true`.

### 3.2 Three ways the row actively harms agents today

These are independent of blast radius and justify removal on their own merits.

| Symptom | Measured | Already tracked as |
|---|---|---|
| `bin/google-chrome` → `.cache/puppeteer-browsers/chrome/linux-149.…/chrome` | Stale Jun-2026 Chrome 149; hangs (rc 124, no PNG) under `--user-data-dir`. The image ships Chrome-for-Testing 151 at `/usr/local/bin/google-chrome`. | PEN-2077, PEN-4682 |
| `bin/make` → `bin/busybox`, which is a 554-byte shell script printing `make shim supports only target: route` | Shadows real GNU `make` at `/usr/bin/make` on a PATH that puts `/paperclip/bin` first | *new here* |
| `bin/swift`, `bin/swiftc` | 149-byte shims execing `/paperclip/.swift/swift-6.1.2/usr/bin/swift`, **which does not exist**. Dead since Jul 2026. | *new here* |

### 3.4 Every Python entry-point shim in `.local/bin` is already dead

`.local/bin` is mounted, but the `site-packages` tree those shims import from is **not** — only
`.local/lib/paperclip-k8s-runtimes/...` is a mount, so `/paperclip/.local/lib` inside an agent pod
contains that one directory and no `python3*` tree at all. Every shim therefore fails closed:

```
$ /paperclip/.local/bin/pytest --version     # rc=1
  File "/paperclip/.local/bin/pytest", line 5, in <module>
    from _pytest.config import _console_main
ModuleNotFoundError: No module named '_pytest'
```

Reproduced identically (`rc=1`, `ModuleNotFoundError`) for `yamllint`, `jsonschema`, `cmake`,
`scapy`, `pdfplumber`, `openapi-spec-validator`, `dotenv` and `pygmentize`. These have never worked
through this mount. They are `DROP`, not `DECIDE` — baking them would be installing new tools under
cover of a migration, which is a separate decision with a separate justification. `wasm-pack` is the
only `.local/bin` entry that does run (0.13.1).

PEN-4682 had to win the `google-chrome` name by PATH order precisely because *nothing inside a Job
can repair the PVC copy* — `bin` is mounted read-only. Removing the mount removes the need for that
workaround rather than adding another.

### 3.3 Per-entry triage

`IMAGE` = already in the image, so the PVC copy is pure shadowing and the mount can drop it.

| Entry | Disposition | Note |
|---|---|---|
| `go`, `gofmt`, `tinygo`, `java`, `helm`, `kubectl`, `make`, `google-chrome`, `chrome-headless-shell`, `node`, `pnpm`, `claude`, `codex`, `protoc-gen-go`, `protoc-gen-go-grpc` | **IMAGE — drop** | Verified present under `/usr/local/bin` or `/usr/bin` |
| `yq` (v4.44.3), `bun`/`bunx` (1.3.14) | **BAKE** | Done in this change |
| `swift`, `swiftc`, `busybox`/`make`-shim | **DROP** | Broken or harmful (§3.2); nothing to bake |
| `kyverno` (258 MB), `trivy` (168 MB), `promtool` (142 MB), `alertmanager` (37 MB), `amtool` (31 MB) | **DROP** | Resolved 2026-10-28 — see §3.5. Each has an existing, version-correct provisioning path that does not involve this mount; baking would freeze a version the fleet defines elsewhere |
| `cmake`/`ccmake`/`cpack`/`ctest`, `scapy`, `yamllint`, `pytest`/`py.test`, `pdfplumber`, `pdf2txt.py`, `dumppdf.py`, `pypdfium2`, `jsonschema`, `openapi-spec-validator`, `dotenv`, `idna`, `normalizer`, `pygmentize` | **DROP** | Structurally dead — see §3.4. Do not bake; if any is genuinely wanted it is a fresh install decision, not a migration |
| `wasm-pack` (0.13.1) | **BAKE** | Resolved 2026-10-28 — the only entry in the row that both runs and has no external version authority to drift from. 2.8 MB musl tarball; `cargo install` costs minutes per run. Done in this change |
| `.local/share/paperclip-git-hooks/pre-push` | **RELOCATE → bake** | Resolved 2026-10-28 — see §3.6. It is a 162-byte shim that `exec`s an image path; there is no server state in it. Correction: the earlier "server-written state" reading was inferred from its mtime, and the content refutes it |
| `tools/kexec.py`, `tools/openapi-generator-cli.jar`, the three tarballs | **DROP** | Ad hoc; no caller identified |

### 3.5 The ~640 MB observability/scanner set: measured, and dropped

Measured 2026-10-28 from a live agent pod, against what the fleet actually runs:

| Tool | PVC copy | mtime | What defines the correct version | Verdict |
|---|---|---|---|---|
| `kyverno` | 1.18.0 | 2026-09-04 | `onprem-k8s/.github/actions/install-kyverno-cli` pins v1.18.0 **with a checksum**, chosen to match the Kyverno bundled in helm chart `kyverno/kyverno` 3.8.0 — i.e. the version deployed on the cluster | **DROP** |
| `promtool` | 3.2.1 | 2026-08-20 | `lint-prometheus-rules.yaml` **derives** `PROM_VERSION` at run time from `monitoring/prometheus-statefulset.yaml`, then fetches that release. Deployed StatefulSet: `prom/prometheus:v3.2.1` | **DROP** |
| `amtool` | 0.28.0 | 2026-09-05 | Same derivation (`AM_VERSION`). Deployed: `prom/alertmanager:v0.28.0` | **DROP** |
| `alertmanager` (server) | **0.27.0** | 2026-10-03 | Deployed: **v0.28.0** | **DROP** |
| `trivy` | 0.72.0 | 2026-06-30 | No caller found in `onprem-k8s` CI | **DROP** |

Three things follow, and together they settle the question the issue left open.

**1. The fleet already solved tool-version fidelity, and the solution is not baking.** The
authoritative pattern is in `lint-prometheus-rules.yaml`: read the image tag off the deployed
StatefulSet, fetch the matching release, put it on `PATH`. Its own comment says why — a tool
"pinned to an older engine than the cluster runs" tests something other than what ships. Baking
these into the agent image would create a **third** copy of each version, updated on image-rebuild
cadence, drifting from both the cluster and CI. That reintroduces precisely the defect CI
engineered away.

**2. The hand-maintained copies have already drifted, so this is not hypothetical.**
`alertmanager` on the PVC is **0.27.0** while the cluster runs **0.28.0** — a full minor version
behind, and `amtool` beside it is correctly 0.28.0, so the two halves of the same project disagree
*on the same volume*. An agent validating Alertmanager behaviour through this mount today is
testing against an engine the fleet does not run. (The server binary is also redundant for the
agent use case: config validation is `amtool check-config`.)

**3. Dropping is not removing a capability — it is moving to the provisioning path that is
already correct.** Every one of these is reachable in an agent pod the same way CI reaches it:
agents have network and a writable workspace, so the kyverno install action's steps and the
promtool/amtool derivation both run unchanged. What they lose is a stale copy that nobody tests.

> **Decision: drop all five; bake none.** Saves ~640 MB on every agent image *and* is the more
> correct outcome. Rule of thumb this generalises to: **a tool whose correct version is defined by
> something else in the fleet is fetched at use time, not baked.** `wasm-pack` is baked precisely
> because it has no such external authority.

⚠️ This is the one row where "drop" is a behaviour change rather than removing something already
broken: unlike the Python shims (§3.4), these five binaries do run. The mitigation is stated above
and should be verified rather than assumed — specifically, that an agent can still run
`scripts/kyverno-test-strict.sh`, which invokes bare `kyverno` off `PATH`.
**Done: §3.7 item 1** measured the fetch from a live agent pod, checksum-matched against the
digest the CI action pins. This row is no longer an open risk.

### 3.6 The `pre-push` hook is not server state, and baking it retires an outage class

The earlier reading — "server-written state, not tooling, because it was modified the day it was
read" — was inferred from the mtime and is **wrong**. The file is 162 bytes:

```sh
#!/bin/sh
exec /usr/local/bin/node /opt/paperclip-bundled-adapters/node_modules/@paperclipai/adapter-utils/dist/github-git-egress-runtime.js --pre-push-hook "$@"
```

Every byte of the guard's logic is already image-resident (that target exists in the image and was
verified present). The PVC file is a pure launcher, written verbatim by the Helm seed in
`deploy/helm/paperclip/templates/statefulset.yaml` on each deploy — which is what the mtime
records. So it is a **BAKE**, and the cheapest one in the set.

It is also the one with the strongest independent reason. PEN-4518 / BLO-48361: on 2026-10-22,
BLO-32734 phase 2b overlaid an emptyDir on the PVC root and `.local/share/paperclip-git-hooks` was
not on the re-exposed allowlist, so **every agent in the fleet lost the ability to push for
2h17m** — while the seed's own success log stayed true the whole time, because it writes to the
PVC and the Job pod sees an overlay. `packages/adapter-utils/src/github-git-hooks-path.ts` exists
to hold that four-consumer join together.

Baking the hook deletes the join rather than documenting it: the file ships in the image or the
build fails, and there is no seed/visibility gap left for an overlay change to open.

⛔ **But not in this change, and not casually.** This is the PEN-3156 publish guard — a security
control — and the path is spelled by four consumers in three languages across two repositories
(Helm seed, egress runtime, Job manifest, preflight in both vendored adapters). It belongs in
stage 3 with its own review, moving all four consumers together.

⚠️ **Corrected 2026-10-29: botching this fails CLOSED, not open — there is one failure mode here,
not two.** This section previously said getting it wrong *"either re-creates the 2h17m outage or,
worse, leaves `core.hooksPath` pointing at a directory holding no hook, which fails open: pushes
succeed, unscanned"*, and ranked the second as the graver risk. The second outcome is unreachable
in this system, so the ranking inverted the real one.

Bare `git` *would* fail open — it treats a hooks directory with no `pre-push` in it as "no hook to
run" and the push proceeds. That is precisely why no agent push path is bare `git`.
`buildGitArgv` refuses **before** it injects `core.hooksPath`, because (in its own words) injecting
a hooks path with no hook in it is indistinguishable from the outside from a push that was
scanned:

```
packages/adapter-utils/src/github-git-egress-runtime.ts:469
  if (!hookPresent(options.hooksDir)) throw new GitEgressRuntimeError(
    "…refusing to publish — no executable pre-push hook at `<hooksDir>/pre-push`…")
```

`prePushHookPresent` is an `X_OK` access, so a present-but-not-executable hook refuses on the same
branch (that is the preflight's `NOT-EXECUTABLE` verdict, explicitly *"not a silent
unscanned-publish"*). Pinned by `github-git-egress-runtime.test.ts` — *"fails closed when the hook
is not installed"* — and consistent with the runtime's own note that *"the push path already fails
closed — that is how PEN-4518 was found"*.

**So the two outcomes are one outcome.** An absent or unreachable hook reproduces the BLO-48361
shape — every push in the fleet refused — which is what 2h17m of lost publishing *was*. That is the
safe direction, and it sets the posture for stages 3b-ii/3b-iii: prepare for a **fleet-wide push
outage**, i.e. keep a rollback ready and watch the preflight verdict across pods. Do **not** plan
for a silent unscanned-publish window; there isn't one, and auditing for it after the fact would be
looking for a hole the refusal closes. The one genuinely unscanned path is a publishing verb that
never consults the hook at all (`send-pack`), which PEN-3156 closes by refusal rather than by hook.

### 3.7 Stage-3 preconditions, measured 2026-10-29

Four things stage 3 rests on that were previously asserted rather than measured. Each was read
from a live agent pod on 2026-10-29, after #3079 and #3081 merged.

**1. The `kyverno` drop is safe — the fetch path works from an agent pod.** §3.5 flagged this as
the one row where "drop" is a behaviour change rather than removing something already broken, and
said it *"should be verified in stage 3 rather than assumed"*. Now verified: an agent pod fetched
`kyverno-cli_v1.18.0_linux_x86_64.tar.gz` (51,849,993 bytes) from the GitHub release and its
SHA256 matched `3aa7b7aa…718904` — byte-identical to the digest pinned in
`onprem-k8s/.github/actions/install-kyverno-cli`. Egress, version and checksum all hold, so
`scripts/kyverno-test-strict.sh` can provision exactly the binary CI provisions. The PVC copy is
also v1.18.0, so dropping changes the *provisioning path*, not the version.

**2. `jre` is reachable only as the target of `bin/java`, and the image's `java` is independent of
the PVC.** `/paperclip/bin/java` is a symlink to `/paperclip/jre/bin/java`, so those two subPaths
are one unit and must be removed **together** — dropping `bin` alone orphans `jre`, dropping `jre`
alone breaks the symlink. On unshadow, `java` resolves to `/usr/bin/java` →
`/etc/alternatives/java` → `/usr/lib/jvm/java-21-openjdk-amd64/bin/java`, **openjdk 21.0.12.1**,
entirely image-resident: `readlink -f` leaves `/paperclip` altogether. (The PVC `jre` is 21.0.11,
so this is the upgrade §3.3 predicted, now confirmed end-to-end rather than by version string.)

**3. `.cache/puppeteer-browsers` is not reached through `PUPPETEER_*` — only via the shadowed `bin/google-chrome` symlink (item 4).** `PUPPETEER_CACHE_DIR` and
`PUPPETEER_CONFIG_DIR` are both `/opt/puppeteer` — an image path, not this mount — so no
*browser-launcher* lookup reaches the PVC, and bare `google-chrome` resolves to the
`/usr/local/libexec/paperclip/bin` shim at `PATH` position 1 rather than here. The directory is
still a symlink *target* of `bin/google-chrome`, which is why item 4 groups it with `bin`. The mount holds Chrome `linux-149.0.7827.54`: the same stale
149 §3.2 identifies as the PEN-4682 hazard. Dropping it removes a copy nothing reads.
⚠️ Noted in passing and explicitly **not** this issue's to fix: `/opt/puppeteer` does not exist in
the image either, so both variables point at nothing. That is pre-existing and orthogonal to the
mount; it is recorded here only so the next reader does not mistake it for stage-3 fallout.

**4. Every subPath is reachable — `bin` is a hub of symlinks, not a flat directory.** Only
`/paperclip/bin` is on `PATH` directly (position 7, ahead of `/usr/local/bin` at 9), which makes it
tempting to call the other six inert. They are not: `bin` holds symlinks *out of itself* into three
of them, so they are reachable transitively, and item 2's “remove together” rule generalises to all
of them.

| `bin` entry | resolves to | couples |
|---|---|---|
| `go`, `gofmt` | `tools/go1.25.6/bin/…` | **`tools`** |
| `tinygo` | `tools/tinygo0.39.0/bin/tinygo` | **`tools`** |
| `java` | `jre/bin/java` | **`jre`** |
| `google-chrome` | `.cache/puppeteer-browsers/chrome/linux-149.0.7827.54/…` | **`.cache/puppeteer-browsers`** |

So the removal units are **`bin` + `tools` + `jre` + `.cache/puppeteer-browsers`** as one group, and
`.local/bin` + `.bun/bin` as another (`.local/bin/bunx` → `.bun/bin/bun`). The hooks dir is reached
through `core.hooksPath`, not `PATH`, and is handled in §3.6.

⚠️ **`.local/bin` reachability is deployment-dependent, and both readings are wrong as universals.**
Chart default puts `<base>/.local/bin` on `PATH` — `paperclip.toolingBinDirs`
(`deploy/helm/paperclip/templates/_helpers.tpl:309`) emits `<base>/.local/bin,<base>/bin`, and the
render guard *fails* if `env.path` omits it, because the PVC shell dotfiles then prepend
`$HOME/.local/bin` ahead of the root-owned wrappers (PEN-3840). Measured 2026-10-29 in a Penstock
`claude_k8s` agent pod, `/paperclip/.local/bin` is **absent** from `PATH` and `promtool`, `trivy`
and `cmake` are not found; measured the same day in a Blockcast pod, it is **present** and those
same binaries resolve to it. Both measurements are real. Stage 3 must therefore treat the
`.local/bin` drop set as live for at least some pods rather than relying on one pod's `PATH`.

**One version change this hides, and it is not `kubectl`.** On unshadow `tinygo` moves from the
PVC's **0.39.0** to the image's **0.41.1**. That belongs on stage 3's verification list beside
`kubectl`, along with whatever `.local/bin` stops shadowing wherever it is on `PATH`.

> ⚠️ **A partial stage 3 is still not worth doing — but the reason is not the lock key.** An
> earlier draft of this section argued that every subPath binds the same handle and ceph-csi's
> `IDLocker` keys on the handle. That reaches the right answer by the wrong route: subPaths are
> *kubelet* bind mounts beneath a single per-pod `NodePublishVolume`, so ceph-csi never sees how
> many subPaths a pod has at all. Exposure scales with **pods × volume**, not with binds.
>
> The sharper statement is stronger: **stage 3 reduces lock exposure by exactly zero.** By §3's own
> inventory the ~14 company-, project-, agent- and workspace-scoped subPaths still bind
> `paperclip-data` after a *whole* stage 3. Blast radius falls at **stage 4**, when `dataClaimName`
> is swapped for a per-agent claim — and nowhere else. Stage 3's entire value is being the
> precondition that makes stage 4 possible, so the test for a proposed partial stage 3 is not "does
> it reduce exposure" (nothing here does) but "does it satisfy stage 4's precondition". A partial
> one does not.

## 4. Staging

1. **Bake the unambiguous gaps.** `yq`, `bun`/`bunx`. *Done.* Zero fleet risk: adding a
   binary to the image cannot break a pod while the PVC still shadows it.
2. **Resolve §3.3 `DECIDE` and `RELOCATE` rows.** *Done — §3.5 and §3.6.* Every entry in
   `ROOT_TOOLCHAIN_SUBPATHS` now has a disposition backed by a measurement rather than a
   preference. `wasm-pack` is baked here, which completes the BAKE set **except** the `pre-push`
   hook, deliberately deferred to stage 3 (§3.6) because it is a security control with a
   four-consumer join whose failure mode is a fleet-wide push **refusal** (§3.6, corrected
   2026-10-29 — it fails closed, not open).
3. **Remove `ROOT_TOOLCHAIN_SUBPATHS` from the Job spec**, and move the `pre-push` hook into the
   image in the same change. Only after 1–2; this is the step that actually retires the
   cross-agent mount, and the first step that can break a running agent.

   ⚠️ **The gate is TWO-SIDED, and the two planes roll independently — measured 5h45m apart.**
   This matters for the 3b split below and was not stated when the split was made. The
   `ROOT_TOOLCHAIN_SUBPATHS` repoint is **server-side** (`paperclip-api` builds the Job manifest);
   the hook file is **image-side** (the agent image). Measured 2026-10-29 from a live pod:

   | plane | running version | vs #3104 (merged 13:13:08Z) |
   |---|---|---|
   | `paperclip-api` — builds the Job manifest | pods ~9 h old, started ~08:25Z | ~4h48m **before** it merged |
   | agent image `paperclip-agent:sha-1dd8e90` | commit 13:08:04Z | **5 min before** it merged |

   A server carrying the repoint can therefore roll while agent images still lag, and the result is
   the §3.6 refusal on every push in the fleet — PEN-4518's shape, arrived at from the safe
   direction, still an outage. So the gate is **both planes verified by property in a running pod**:
   never a merge, and never one plane. Concretely, before 3b-ii: #3117 merged, **and** an agent
   image built from a commit containing it, **and** `/usr/local/libexec/paperclip/hooks/pre-push`
   present in a **freshly created** pod. Baseline recorded 2026-10-29: that path is **absent**,
   while `/usr/local/libexec/paperclip/bin/` (the PEN-3840 wrapper precedent) exists `root:root
   0755`, confirming the ownership model the `COPY` produces.

   **`paperclip-api` ships once a day, at 07:23 UTC** — the hourly cron is sampling-only and cannot
   ship. A change merged after that slot is not fleet-visible until the next one, so a server-plane
   gate is routinely ~a day wide. Read it by **ancestry, not pod age**: compare the Deployment's
   `paperclip.blockcast.net/deployed-commit` annotation against the merge commit
   (`compare` → `behind_by`) — pod age is an inference that merely happens to agree.

   **Its precondition, and how to check it.** Stage 3 is safe only once agents actually *run* an
   image built from a commit at or after `992d21fc` (the `kubectl` pin, #3081). On an older image
   the mount removal is a silent four-minor `kubectl` downgrade — the regression #3081 exists to
   prevent (§3.3). The rollout is automatic, but it is **not** the image build: the final step of
   `.github/workflows/docker-agent.yml`, *Bump agent image refs in cluster*, PATCHes each agent's
   `adapter_config.image` to `sha-<short>-k8s-vendored` through `/admin/agents/bump-agent-image`.

   Check the **property**, never a tag. A toolchain tag hashes live registry digests resolved at
   build time, so it cannot be computed from the repo — two separate attempts to predict it were
   wrong, for two different reasons. Either read a fresh agent pod's `image:` and confirm its
   commit contains the pin, or run `/usr/local/bin/kubectl version --client` inside one and
   require `v1.35.3`.

   ⚠️ **Verify the deployed ref; do not infer it from a green build.** The original reason —
   BLO-33382, where a ~30 s `paperclip-api` restart returned 503 and permanently dropped the bump
   for three consecutive commits — has since been **fixed in the step itself**: it now retries
   connection failures and 5xx up to 5× with backoff and then `exit 1`s
   (`.github/workflows/docker-agent.yml`, the `post_bump()` helper — `:550` at `fbf3ca8d`). Do not cite it as a live
   defect. Two reasons to verify survive that fix, both still present today:

   - with no `PAPERCLIP_AGENT_BUMP_TOKEN` the step emits `::warning` and `exit 0` — a **green build
     that bumps nothing**;
   - `if: github.event_name != 'workflow_dispatch'` skips the bump entirely on a manual re-run.
4. **Per-agent claim.** Split in two once §4.1 was read properly — the swap is not the hard part,
   and doing it alone stops the fleet creating agent Jobs (§4.1).

   - **4a. Make a non-self claim narrowable.** *Done.* Re-base the `narrowWritableSurface` gate off
     "is this the server's own claim" and move `subPath` pre-creation into a root
     `seed-writable-dirs` init container. No per-agent claim yet, so lock exposure is unchanged;
     this is purely the step that makes 4b possible.
   - **4b. Swap `dataClaimName`** (`job-manifest.ts`, the `const dataClaimName =` binding) to a
     per-agent PVC, provisioned dynamically by the server following the existing
     `opencode-db-<agentId>` precedent (`paperclip.io/pvc-type=agent-db`). Note `paperclip-data`
     is an `existingClaim` managed out of onprem-k8s, so per-agent claims cannot be templated into
     the chart.

     **Three invariants 4a hands to 4b.** All three are inert on the self claim and become live
     the moment the claim is per-agent, so none of them can be caught by the fleet exercise 4a
     relies on:

     1. **Populate the server-materialized trees, or relocate them.**
        `.local/share/paperclip-git-hooks` and `skills/<companyId>` are written by the SERVER into
        the server's own volume. On a per-agent claim the seeder creates them and they stay
        EMPTY — an empty hooks dir fails every push closed (BLO-48361), an empty skills tree
        dangles the prompt bundle's skill links silently. 4a warns
        `claude_k8s.data_claim_foreign` naming both; 4b must either materialize them into the
        per-agent claim or finish the §3.6 relocation of the hooks dir into the image.
     2. **Close the symlinked-PARENT hole in the seeder.** The seeder holds uid 0 +
        `DAC_OVERRIDE` + `CHOWN` over the volume root, and both `mkdir -p` and `chown` follow
        symlinks. 4a refuses a target whose FINAL component is already a symlink and uses
        `chown -h`, which removes the direct chown-redirect; a symlinked *parent* component is
        still followed. Unreachable on the self claim and on 4a's head —
        `resolveScopedWritableMounts` drops nested targets, and a narrowed pod cannot reach
        another agent's subtree — but a per-agent volume PERSISTS across runs whose target sets
        differ, so one run's writable tree can become an ancestor of a later run's target. 4b
        needs a per-component walk, tested against a real fresh volume.
     3. **Decide the directory MODE.** The seeder `chown`s but sets no mode, so its dirs inherit
        its umask rather than the `2775` setgid the server-side path got from its parent. Moot
        while the dirs already exist (the `mkdir` no-ops); on a genuinely fresh volume 4a's dirs
        come up without setgid, which is a real question for group-write across the publish-broker
        sidecar. Answer it against a fresh volume rather than by assertion.
5. **Demonstrate and re-measure.** PEN-4932's acceptance criterion.

### 4.1 The blocker stage 4 has to clear

`dataClaimName = envWorkspaceClaim || selfPod.pvcClaimName || ""` — every agent Job inherits the
*server's own* claim. The `narrowWritableSurface` gate then required
`dataClaimName === selfPod.pvcClaimName`, because the `subPath` targets were pre-created by the
server through its own mount. A per-agent claim is by definition a volume the server does not
hold, so it took the `foreign_claim` branch and fell back to a broad rw mount.

**Corrected 2026-10-29.** This section previously concluded that the narrowing machinery should be
*deleted* for per-agent claims rather than satisfied — "a per-agent volume is scoped by
construction, so the ~14 `subPath` binds have nothing left to narrow". That is wrong, and acting on
it would have stopped the fleet creating agent Jobs. Three things fall out of the gate at once, and
only the first is about cross-agent scoping:

1. `rootMounts` collapses to a single broad rw mount — losing the **root overlay**, which is not
   about other agents at all. The PVC root is the server's `node` home: `.ssh`, `.kube`,
   `.secrets`, `.claude/.credentials.json`, mkcert's CA key. A per-agent volume does not make those
   safe to expose; it is a different volume, not an empty one.
2. `scopedWritableDirs` empties, and nothing pre-creates the tree — the server **structurally
   cannot**, since it does not mount a per-agent volume. A fresh CephFS volume's root is
   `root:root` and the init container runs as uid 1000.
3. `buildJobManifest` **throws** for every broker-enabled Job: *"refusing to build Job manifest —
   enableGitHubPublishBroker is set, but the data volume would be mounted broad read-write"*. That
   is the code failing closed as designed, and it is why the naive swap fails loudly rather than
   degrading quietly.

So stage 4 **satisfies** the gate. Stage 4a re-bases it onto the question that actually matters —
*can this Job's `subPath` targets be given correct ownership?* — and answers it with a root
`seed-writable-dirs` init container that does targeted `mkdir -p` + `chown` on the skeleton from
inside the pod, ahead of every container that mounts a target. `foreign_claim` becomes unreachable.

**`fsGroup` is the obvious alternative and is contraindicated by measurement already in this tree.**
`values.blockcast.yaml:520-530` (onprem-k8s #225) records that on cephfs
`fsGroupChangePolicy: OnRootMismatch` does **not** reliably short-circuit, so the kubelet runs a
recursive chown over the whole volume on every pod mount and each rollout grinds 30-45 min against
the ~2M-inode shared tree. Per-agent shrinks the tree, so the honest question is whether it shrinks
it *enough*. Measured 2026-10-29 on the Penstock company subtree — the trees a per-agent volume
duplicates:

| tree | inodes |
|---|---|
| `wt/` (12 worktrees, 4.9 G) | 115,450 |
| `k8s-isolation/pnpm/<co>` | 66,217 |
| `projects/<co>/<proj>/penstock-llm-proxy-core` | 50,225 |
| **total** | **231,892** |

That is **11.6%** of the ~2M behind the 30-45 min figure — so roughly **3.5-5 min of kubelet chown
on every pod start**, assuming linear scaling, for a Job expected to start in seconds. Two honest
limits, both pushing the same way: it is one company, and worktree count grows, so 231,892 is a
floor rather than a ceiling. The seeder is O(skeleton) instead, and is the pattern the chart itself
names as the reason `fsGroup` is unnecessary.

**One trap inside the fix.** The gate re-base must *not* be applied to `scopedWritableDirs`. Those
paths are joined onto `SELF_POD_DATA_MOUNT_PATH` — the server's own mount — so handing them out for
a foreign claim would `mkdir` the Job's tree inside the **server's** volume: junk the Job never
sees, while the targets that needed creating stayed uncreated. The old condition therefore survives
under its own name (`serverCanPreCreate`), governing that list alone.

## 5. Decisions taken, and what is still genuinely open

Both questions this document previously raised are **resolved**, and neither needed a preference
call in the end — each turned out to have a measurable answer:

- **The ~640 MB set** → **drop all five** (§3.5). The fleet already defines these versions
  elsewhere (a checksummed CI action for `kyverno`; derive-from-deployed-manifest for `promtool`
  and `amtool`), `trivy` has no caller, and `alertmanager` on the PVC has **already drifted** a
  minor version behind the cluster. Baking would add a third, slower-moving copy of each version.
- **`wasm-pack`** → **bake** (§3.3). It is the one entry with no external version authority to
  drift from, and the only one where fetching at use time costs minutes rather than seconds.
- **`pre-push`** → **bake, in stage 3** (§3.6). The "server-written state" reading was wrong; it is
  a 162-byte shim into the image. Deferred not because the decision is unclear but because the
  change spans four consumers across two repositories and, if botched, refuses every push in the
  fleet (§3.6 — fails *closed*; an earlier draft of this line said "fails open", which is true of
  bare `git` and false of this system).

**Company-scoped sharing — resolved 2026-10-29, and it is a constraint rather than a trade-off.**
`/work/<companyId>`, `/wt/<companyId>`, the pnpm store and `skills/<companyId>` are namespaced by
path but *are* read by every agent of the same company, so per-agent volumes duplicate them.
Measured on the Penstock subtree: project checkout 4.8 G, `wt/<co>` 4.9 G, pnpm store 3.0 G,
`work/<co>` 304 M, k8s-runtimes 240 M, skills 133 K — **≈13.2 G per company**. Penstock runs 9
pod-backed agents, so per-agent takes it to ≈119 G, **+106 G**, against a volume that is 3.0 T with
1.1 T free. Affordable, and worth saying *affordable* rather than *free*: it scales linearly with
agent count on a volume already two-thirds full.

The reason this is not a design choice: **stage 4 reduces blast radius only if the agent pod stops
mounting `paperclip-data` altogether.** The ceph-csi lock keys on the volume handle and exposure is
pods × volume, so *one* surviving `subPath` to the shared handle preserves the whole node-wide
wedge — and mounting it read-only does not help either, since `NodeUnstageVolume` is per handle
regardless of `ro`/`rw`. The compromise anyone reaches for first ("keep the company-scoped trees on
the shared PVC, put only agent/workspace data on the per-agent claim") therefore pays the full
provisioning cost and buys **exactly zero** blast-radius reduction. The duplication is the price of
the fix, not an option inside it.

It is not purely a cost: per-agent project checkouts structurally retire the BLO-19422 shared
checkout, and two agents can hold different branches of the same repo at once. Behaviour changes to
accept, named rather than glossed: a first-run cold `pnpm` install per agent, and worktrees created
by one agent no longer visible to another of the same company.

Caveats on the numbers: Blockcast's subtree is not mounted here, so the fleet figure is
extrapolation; `du` counts allocated blocks and pnpm's hardlink sharing does **not** survive a copy
to a separate volume, so the duplicated copies are genuinely additive; and worktree count grows
over time.

## 6. Not in scope

Alerting on `rbd_wedge_csi_op_age_seconds{op="unmount"}` — PEN-4932 separates it deliberately; it
belongs in `deploy/observability/prometheusrule.yaml` in `penstock-llm-proxy-core`.
