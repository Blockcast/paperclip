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

   **Status 2026-10-30: 3b-ii's verification gate is SATISFIED and 3b-iii is this change.** Both
   were read as properties inside a live agent pod running the fleet image, never from a tag or a
   merge:

   | gate | required | measured 2026-10-30 |
   |---|---|---|
   | baked hook exists and is executable (3b-ii) | `/usr/local/libexec/paperclip/hooks/pre-push`, `X_OK` | present, `root:root 0755`, `X_OK` ✅ — the 2026-10-29 baseline recorded it **absent** |
   | runtime resolves the baked copy (3b-iii precondition) | installed `@paperclipai/adapter-utils` `hooksDirectory()` → `BAKED_HOOKS_DIR` | `BAKED_HOOKS_DIR` ✅ (`DEFAULT_HOOKS_DIR` occurs 0 times in the built module) |
   | no env override aims it back at the PVC | `PAPERCLIP_GIT_EGRESS_HOOKS_DIR` unset | unset in-pod, and set by nothing in this repo ✅ |
   | `kubectl` pin (#3081) survives unshadowing | `/usr/local/bin/kubectl` is `v1.35.3` | `v1.35.3` ✅ (`PATH` still resolves `kubectl` to the PVC copy, which is what this stage retires) |

   **The agent plane is ahead of the server plane here, which is the safe order.** Measured the
   same day: the agent image is at master tip, while a pod created at 05:25:48Z still carried all
   **seven** toolchain `subPath`s — so `paperclip-api` had not yet picked up #3104 (merged
   2026-10-29T13:13:08Z, ≥16 h earlier), and `paperclip_api_deploy_drift_stale` reads `0`
   throughout, so that exporter does not measure this. Read the server plane from the mounts a
   fresh pod actually has; do not read it from that metric.

   That ordering is what makes 3b-iii safe rather than merely green: the hazard §4 names is a
   server that has stopped mounting the PVC copy *in front of* images that still look there. The
   images stopped looking first, and they roll per-commit while the server rolls daily — so the
   window cannot open in the dangerous direction.

   **What is deliberately NOT in 3b-iii:** the Helm seed in
   `deploy/helm/paperclip/templates/statefulset.yaml` still writes the PVC copy. It is now
   unmounted rather than deleted, which keeps a revert path that does not need a chart release.
   Remove it in a separate change once this has soaked, per §3.6's posture of keeping a rollback
   ready for a fleet-wide push refusal.

   ⚠️ **Two planes roll independently — measured 5h45m apart — but they do NOT both bear on
   3b-ii.** An earlier revision of this section said they did; that was wrong, and which stage
   carries the skew hazard is the whole point of the 3b split, so it is corrected here rather than
   silently reworded.

   | plane | ships | rolls |
   |---|---|---|
   | `paperclip-api` — builds the Job manifest (`job-manifest.ts`, `ROOT_TOOLCHAIN_SUBPATHS`) | server | daily, 07:23 UTC |
   | agent image — baked hook file **and** the egress runtime that looks for it | agent image | per master commit, auto-bumped |

   Measured 2026-10-29 from a live pod: `paperclip-api` pods ~9 h old (started ~08:25Z, i.e. ~4h48m
   *before* #3104 merged at 13:13:08Z), while agent image `paperclip-agent:sha-1dd8e90` was built
   from a commit 5 min before it. The skew is real. The error was attributing it to the wrong stage.

   **3b-ii does not straddle the two planes.** Its repoint is `DEFAULT_HOOKS_DIR` /
   `hooksDirectory()` in `packages/adapter-utils`, and that code does not run in `paperclip-api` on
   the push path — the agent's `git` is a wrapper (`docker/github-wrappers/git`) that `exec`s
   `/opt/paperclip-bundled-adapters/node_modules/@paperclipai/adapter-utils/dist/github-git-egress-runtime.js`
   *inside the agent pod*. That bundle is compiled **from this working tree** during the image build
   (`Dockerfile`: vendor stage `npx tsc` → `npm pack` → `/vendor/adapter-utils.tgz` → `npm install
   --prefix /opt/paperclip-bundled-adapters`), and `Dockerfile.agent:27/:33` copy both it and
   `/usr/local/libexec/paperclip/hooks` `--from=server`. **So the repoint and the file it points at
   are the same artifact, built by the same Docker run.** A pod has both or neither; it cannot have
   the repoint without the file. Verified 2026-10-29 in a running pod: that `dist/` carries the
   current PVC constant `".local/share/paperclip-git-hooks"`, `root:root`.

   3b-ii's gate is therefore a **verification** gate, not a plane-skew one, and it is weaker and
   satisfiable the same day: prove the `COPY` actually produced an *executable* `pre-push` in a real
   agent image before anything relies on it. A silently-empty bake (wrong path, `.dockerignore`,
   `--exclude` semantics) would make §3.6's refusal fire on every push. Concretely: #3117 merged
   (`968a684`, 2026-10-29 19:00:10Z), **and** an agent image built from a commit containing it,
   **and** `/usr/local/libexec/paperclip/hooks/pre-push` present and `X_OK` in a **freshly created**
   pod. Baseline recorded 2026-10-29: that path is **absent**, while
   `/usr/local/libexec/paperclip/bin/` (the PEN-3840 wrapper precedent) exists `root:root 0755`,
   confirming the ownership model the `COPY` produces.

   **The skew hazard belongs to 3b-iii**, which removes the `ROOT_TOOLCHAIN_SUBPATHS` entry. That is
   the server-side half, and it is the one that can race: a `paperclip-api` that has stopped
   mounting the PVC hooks subPath, in front of agent images that still look there, strands pods with
   no hook at the resolved path and refuses every push. That is exactly PEN-4518 — consumer 3 quietly
   stopped making the file visible while consumer 2 kept looking for it (§ top of this file). So
   3b-iii, not 3b-ii, is the step gated on **both** planes verified by property in a running pod, and
   the PVC fallback 3b-ii installs is what spans the window between them.

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

     **Status 2026-10-31: the swap is WRITTEN and lands behind a default-off per-agent gate.**
     `resolveAgentWorkspaceClaimName` (gate + name in one function) sits between the operator
     `workspaceVolumeClaim` and the server's own PVC in `resolveDataClaimName`; `execute.ts`
     calls `ensureAgentWorkspacePvc` (#3168) from the same derivation before building the Job,
     and fails the run `k8s_agent_workspace_pvc_failed` rather than falling back to the shared
     claim. The four invariants 4a enumerated are all closed, which is what makes this a claim
     change and nothing else — as is the fifth, found while writing this swap; see below.

     **Why a gate rather than a flip, stated as the trade it is.** A per-agent claim is a FRESH,
     EMPTY volume. §5 already accepts the standing cost — a first-run cold `pnpm` install per
     agent, worktrees no longer shared within a company — but a fleet-wide flip pays a cost §5
     does not name: whatever **uncommitted work** sits in `wt/<companyId>` at the moment of the
     roll stops being visible to the agent that wrote it. Per-agent opt-in through
     `adapter_config` pays that once per agent, at a time someone chose, and gives a rollback
     that needs no code roll. The fleet-wide default is a later deliberate change.

     **AND IT COULD NOT BE ENABLED AT ALL UNTIL INVARIANT 5 CLOSED — found
     2026-10-31 while writing the swap, it meant enabling the gate broke EVERY
     run of the opted-in agent.** Both halves have since landed (Status, below),
     so this is now the record of a closed blocker rather than a live one; what
     it does NOT license is treating the gate as proven. Invariant 1 inventoried
     the trees the SERVER WRITES for the pod. The pod log is the same assumption
     in the other direction — the pod WRITES and the server READS — and nothing
     covered it.

     `buildPodLogPath` (`job-manifest.ts`) deliberately returns **two addresses
     for one file**, under a comment that states it: *"ONE log file, TWO
     absolute paths, because the server and the agent pod mount the same volume
     at different roots."* The container writes `containerLogPath`, rooted at
     `dataMountPath`; `execute.ts` **tails `podLogPath`**, rooted at
     `SELF_POD_DATA_MOUNT_PATH`, and that tail is how the run's ENTIRE stdout is
     collected. The two are byte-identical strings on the default mount and
     different VOLUMES the moment the claim is per-agent. `tailPodLogFile` then
     waits 30 s, throws *"Pod log file never appeared at …"*, `Promise.allSettled`
     turns that into `stdout = ""`, and the result parser has nothing to read.

     Three things that look like fallbacks and are not, each checked in source:

     - the belt-and-braces on-disk re-read immediately after the tail reads the
       **same** `podLogPath`;
     - `readPodContainerLogTail` is a 120-line **diagnostic** for error
       messages, not a stdout source;
     - the container's own stdout carried no NDJSON to read through the
       Kubernetes log API anyway — the pipeline ended
       `| tee <containerLogPath> | <failFastFilter> > /dev/null`. **That third
       one is now conditional** (PEN-5120, below): on a claim the server does
       not hold, the filter keeps its stdout and marks each line.

     **The obvious fix is refused for the same reason §2 refuses the tooling
     row.** Keeping `run-logs` as a `subPath` of the SERVER'S claim beside the
     per-agent one leaves one bind on the shared handle, and the ceph-csi lock
     keys on the handle — so it would pay the whole cost of the swap and buy
     zero blast-radius reduction. The candidate that does not do that is to stop
     making the log a *shared-volume* artifact: `tee` the redacted NDJSON to the
     container's stdout as well as to the file, and have the server consume it
     through `readNamespacedPodLog` (follow) instead of by tailing a path. That
     is its own change — it replaces the offset-tracking tail with a stream that
     has its own failure modes (the kubelet's 10 Mi rotation, API disconnects,
     the FAR-10 hang the adapter's own mocks were built for) — and it was the
     remaining blocker on enablement, not something to bolt onto the swap.

     **Status 2026-10-31 — BOTH HALVES HAVE LANDED. The code path is complete;
     no run has used it.** Tracked as PEN-5120. The fail-fast `awk` keeps its
     stdout and stamps each line with `POD_LOG_STREAM_MARKER`, and
     `collectPodLogStream` (`src/server/pod-log-stream.ts`) reads those frames
     back off the container log, emits them live, and persists them to the
     server's own `podLogPath` so the belt-and-braces re-read, the reaper's
     `unlink` and the orphan reader keep finding what they expect. The transport
     is chosen from `JobBuildResult.podLogStreamedToContainerStdout` — returned
     by the builder rather than re-derived, so the server cannot disagree with
     the command it shipped — and the file tail remains the implementation for
     every run on the server's own claim.

     ⚠ **That is not the same as invariant 5 being verified.** PEN-5120's first
     done-when asks for a real run on a foreign claim producing parseable
     stdout, and nothing has produced one. What changed is that the failure is
     no longer structural: before, enabling the gate emptied every opted-in
     run's stdout by construction. The `enablePerAgentWorkspaceVolume` toggle is
     surfaced in `config-schema.ts` for the first time alongside this, for
     exactly that reason — the acceptance is unreachable without a way to opt
     one agent in — and its hint says in as many words that nothing has proven
     it in production yet.

     Four points worth carrying forward, because each was a decision rather than
     a detail:

     - **Framing is forced, not chosen.** `readNamespacedPodLog` has no stream
       selector — it serves one interleaved view of fd 1 and fd 2 — so the
       agent's stderr and the launcher preflight arrive mixed into the NDJSON.
       Redirecting the other writers to stderr would not separate them. The
       marker is added DOWNSTREAM of `tee`, so the file keeps today's bytes and
       every existing parser of it is untouched.
     - **The redactor fails CLOSED on that path.** Its fail-open is right while
       the log's only home is a file on a volume the control plane owns; it is
       not right when degrading to `cat` would publish the transcript to the
       node's container log. The stderr line and the `.unredacted` sentinel are
       still written first.
     - **A stream end is not evidence the run ended.**
       `@kubernetes/client-node`'s own `Log.log` carries the comment *"the
       follow search param still has the stream close prematurely based on my
       testing"*, and FAR-10 is the opposite failure — the API holding a
       connection open indefinitely. So the follow is a loop that reconnects
       until `waitForJobCompletion` reports the Job terminal, and a watchdog
       ends the sink on that signal rather than waiting for the socket.
     - **The 10 Mi rotation bound is handled, not merely noted.** While the
       follow is CONNECTED, rotation is transparent — the kubelet's reader rolls
       over with the file. The only window in which bytes can be lost is between
       connections, so a reconnect resumes at `sinceTime` anchored to the last
       line's second and prints that resume point, which makes a gap
       attributable instead of silent. `sinceTime` is second-granular and
       inclusive, so the replay is a known SUPERSET of what is already held and
       the re-delivered lines are de-duplicated within that second. Note this is
       why the collector drives both reads through `getLogApi().log` and not
       `coreApi.readNamespacedPodLog`: the generated request type for the latter
       has `sinceSeconds` but **no `sinceTime`**, so a resume through it could
       only ever be approximate.

     **A SECOND pod→server read-direction consumer, found 2026-10-31. DECIDED
     2026-10-31 (PEN-5124): the residual is ACCEPTED and bounded; the premise it
     was filed on is corrected below.**
     `server/src/services/orphaned-run-terminal-result.ts` reads the pod-written
     `<run>.pod.ndjson` out of the server's `run-logs` tree to recover a vanished
     Job's own terminal verdict — the PEN-2421 fix that stops the reconciler
     recording successful runs as `job_missing`.

     **Correction of record: it is not `no_artifact`, and PEN-2421 is not
     wholesale reverted.** PEN-5124 did consider the collector and argued it
     could not help, on the ground that *the orphan path fires exactly when the
     process that would have written the copy is the thing that died*. That
     sentence is true, and the conclusion drawn from it — that the recovery is
     *structurally unavailable* and the reader reads `no_artifact` — is wider
     than it supports. It conflates "the copy stops growing" with "the copy does
     not exist".

     ⚠️ **Sequencing — CONDITION MET, retired 2026-10-31.** The correction
     above holds only once the COLLECTOR half is on `master`, and when it was
     written that was still open: the emit half (#3173) had merged and the
     collector (#3174) had not, so until it did, PEN-5124's `no_artifact`
     reading was the correct one and the regression was the full one. #3174
     merged 10:27:27Z, ahead of this text's own PR (#3175, 11:02:50Z) — so the
     condition was already satisfied when this landed, and **the paragraphs
     below describe `master` as it now stands.** The caveat is retired rather
     than deleted because the dependency it names is load-bearing: the
     distinction between a TRUNCATED server-side copy and an ABSENT one is the
     whole reason the residual is narrow, and it is only true while a collector
     exists to write that copy — specifically
     `collectPodLogFromContainerStdout`'s lazily-opened append handle on
     `podLogPath`, not the `collectPodLogStream` read it drives. Remove that
     write and PEN-5124's original reading becomes correct again. Note its
     `persistFailed` path reaches the same place by design: a failed persist is
     deliberately non-fatal to the run, so a run CAN still end with no
     server-side copy and read `no_artifact` here.

     The collector persists every accepted line to the
     server's OWN `podLogPath`, and that path is rooted at
     `SELF_POD_DATA_MOUNT_PATH` — this process's own claim — so for an opted-in
     agent the artifact IS created, at exactly the layout `locatePodLogArtifact`
     scans. Verified by construction, not inferred: `buildPodLogPath(…, root =
     SELF_POD_DATA_MOUNT_PATH)` yields
     `/paperclip/instances/default/data/run-logs/<co>/<agent>/<run>.pod.ndjson`,
     and `runLogBasePath()` yields `/paperclip/instances/default/data/run-logs`.
     That agreement is now pinned by
     `server/src/__tests__/orphan-artifact-path-agreement.test.ts`, because it is
     the single fact this whole decision rests on and nothing was asserting it —
     either root could have been changed without a failing test.

     **What the residual actually is.** The server's copy is *owner-written*,
     where the shared-claim file is *pod-written*. On the shared claim the pod
     keeps appending after the adapter owner dies, so the terminal `result`
     lands regardless. On a per-agent claim the copy stops at owner death. So
     the rescue fails in exactly one case: **the agent emits its terminal
     `result` after the last owner stopped collecting.** The reader then reports
     `no_result_event` (or `no_artifact`, if the owner died before the first
     accepted line — the append handle is opened lazily), and the run stays
     `job_missing`. Both reasons are recorded in the run event's payload, so the
     residual is attributable after the fact rather than silent.

     **Why that is narrow: BLO-27155 re-adoption covers the dominant cause.**
     Owner death is overwhelmingly a worker/server restart, and a restart does
     not leave the run to the orphan path — in-flight runs are re-executed from
     their persisted reservation, `jobAdoptionVerdict` adopts the run's own
     still-live Job on the 409, and execution falls through to the normal
     collection path. On a foreign claim that re-opens the container log from
     the beginning (no `sinceTime`) and re-persists the transcript in append
     mode. So the residual is the narrower conjunction: the owner died, the run
     was **not** re-executed, **and** the terminal result landed after
     collection stopped. (One cosmetic consequence of the replay: the re-adopted
     run appends lines the dead owner already wrote, so the file can carry a
     duplicated prefix. The reader scans backwards for the LAST `result` event,
     so this costs disk, not correctness.)

     **The alternatives, and why each is refused.**

     - *Keep `run-logs` as a `subPath` of the server's claim beside the
       per-agent one.* Refused for the same reason §2 refuses the tooling row
       and PEN-5120 refuses it explicitly: one bind on the shared CephFS handle,
       the ceph-csi lock keys on the handle, so it pays the whole cost of the
       swap and buys zero blast-radius reduction.
     - *Recover at sweep time from the Job or pod.* **Impossible by
       construction, and the original framing of this candidate was backwards.**
       The orphan path runs only when `!input.jobStatus` — the Job is already
       gone — and Job GC cascades to its pods, so the container log died with
       the pod. `ttlSecondsAfterFinished` does not make the Job outlive the pod;
       it is what deletes both.
     - *Query a cluster log aggregator.* Not available. Measured 2026-10-31: the
       `logging` namespace runs only `fluent-bit-audit`, a DaemonSet on the three
       control-plane nodes with no Service — Kubernetes API audit, not worker
       pod logs. There is nothing to query.
     - *Have the pod report its terminal verdict to the server directly.* This
       is the one remedy that is genuinely owner-independent, and it is
       deliberately NOT taken here. It converts the trusted signal from *an
       artifact the agent wrote* into *an HTTP claim the pod makes*, which is a
       new trust surface and needs its own BLO-18106-grade reasoning — the
       reader's own docstring is explicit that what it trusts is the agent
       process's structured self-report, not a proxy for progress. This is the
       recorded escalation if the residual is ever measured to bite; it is not
       something to bolt onto a volume change.

     **Accepted consequence, stated so it is not a surprise later.** For an
     opted-in agent, a run whose adapter owner dies, which is not re-executed,
     and whose terminal result lands after collection stopped, is recorded
     `job_missing` although it succeeded — run statistics count it as a failure
     and the work is re-queued. That is strictly narrower than the pre-PEN-2421
     behaviour and strictly narrower than this item was filed as, it is bounded
     to agents someone has explicitly opted in, and it is attributable through
     the run event's `reason`. It does not block enablement.

     *Latent, pre-existing, and out of scope here:* the adapter hardcodes
     `INSTANCE_ROOT_SUBPATH = "instances/default"` while `runLogBasePath()`
     resolves `PAPERCLIP_INSTANCE_ID`. These agree only while the instance id is
     `default`, which it is fleet-wide. The divergence affects the shared claim
     identically, so it is not a per-agent-claim defect — but it is a second way
     these two roots can silently drift, which is the other reason the agreement
     test above exists.

     Noted but NOT invariant 5, and **split out as PEN-5125** (2026-10-31, per
     PEN-5124's done-when 3 — own owner, because it is capacity rather than
     correctness and wants a different remedy): the isolation-workspace reaper
     (`server/src/services/isolation-workspace-reaper.ts`) walks
     `k8s-isolation/workspaces/*` through the SERVER's mount, so it goes blind
     to an opted-in agent's tree. That tree grew 0 → 406.7 GiB fleet-wide
     between July and 2026-09-02 with no reaper at all, so ≈10 GiB/agent/month
     against a 50 Gi claim already carrying ≈13.2 G of duplicated company trees
     is roughly a quarter's runway. Real, bounded, and not a correctness failure
     — unlike the log, which fails on run one. It does **not** gate done-when 1:
     `allowVolumeExpansion` is true, so the failure mode is an operator resizing
     a PVC rather than a run losing data. PEN-5125 carries the remedy options,
     including the ⛔ on keeping `k8s-isolation` on the server's claim beside the
     per-agent one, which is refused on exactly the ground PEN-5120 refuses it
     for `run-logs`.

     **PEN-5125 decided, 2026-10-31. Detection landed; reclamation deliberately
     did not.** Two things changed in the reading on a source pass:

     - The gap is **not** stage-4b-only. The reaper's reach is exactly
       `serverHoldsJobDataClaim`, and `resolveDataClaimName` has *two* slots
       above the server's own PVC: the operator `workspaceVolumeClaim` and the
       per-agent claim. The first has no `config-schema.ts` toggle but is read
       **today**, so the blind spot is reachable on the current deployment, not
       only after the gate flips. ⚠ And it has **two sources**: `execute.ts`
       merges a k8s-remote target's `K8sRemoteSpec` over the agent's config with
       the ENVIRONMENT winning, so an agent can be on a foreign volume with
       nothing in its own `adapter_config` to say so. Found in review of #3180;
       an agent-only probe returns a confident `0` there, which is the exact
       silence the gauge exists to remove.
     - The cost is sharper than "the reaper reports nothing": it reports
       **success**. The enumeration is directory-driven, so an unreachable
       workspace is never queried and lands in no outcome bucket; the documented
       `scanned` identity stays exactly true over a shrunken population and
       `stop_reason` reads `complete`. BLO-36814's `root_absent` cannot catch
       this — it fires on `ENOENT` of the root, and a per-agent claim leaves this
       root present and populated by every agent still on the shared claim.

     Landed: `paperclip_isolation_workspace_reaper_unreachable_agents`
     (`-1` = probe absent, faulted, **or** a k8s environment supplies a claim;
     alert on `!= 0`), probed before the root `readdir` so the root-absent path
     carries it too, and deliberately kept off the `entries_total` label set
     because it describes directories the sweep never enumerated. The probe has
     two arms: `agents` yields a COUNT, `environments` is a TRUST CHECK that
     degrades to the sentinel — the environment is chosen per run, so which
     agents it moves is not derivable server-side and no sound count exists. Also refused, with reasons, in the module header: a
     per-claim enumeration from the server (reintroduces the cross-mount coupling
     PEN-4932 exists to remove), and unlinking from the pod's own
     `seed-writable-dirs` init container — that container's design note turns on
     its operations being idempotent so "a re-run, a restarted pod and a second
     agent on the same volume all converge", and `rm -rf` is the one operation
     that does not converge against a concurrent sibling pod on a `ReadWriteMany`
     claim.

     ⚠️ **PEN-5125 done-when 2, decided 2026-10-31 — met through its SECOND
     clause, not its first.** The criterion offered two ways to close: sweep the
     tree, or bound the growth another way and write the accepted ceiling down.
     Nothing in this stage sweeps an unreachable tree, so what closes it is the
     ceiling stated next. The paragraphs after that are what became of the sweep.

     **The ceiling, stated so it can be checked rather than remembered.** An
     opted-in agent's isolation tree grows at ≈**10 GiB/agent/month** (the
     measured July → 2026-09-02 fleet rate) against a **50 Gi** claim already
     carrying ≈**13.2 G** of duplicated company trees. That is ≈36.8 GiB of
     headroom, so **one opted-in agent fills its own claim in ≈3.7 months** — a
     quarter — and does so without touching any other agent, which is the whole
     point of the per-agent claim. `allowVolumeExpansion` is `true` on
     `cephfs`, the StorageClass the per-agent claim is provisioned on
     (`DEFAULT_AGENT_WORKSPACE_STORAGE_CLASS`; `ssd-fast` is the pool beneath
     it, not the class), so the terminal state is an operator resizing a PVC,
     not a run losing data. **That is why this is accepted and not a blocker**,
     and it is also why it must not be accepted silently: the cost accrues for a
     month before anything shows it.

     **What enforces the ceiling is the probe that just landed, at N = 1.** Arm
     A counts exactly the opted-in population, and
     `PaperclipIsolationWorkspaceReaperCoverageGap` fires on `!= 0` — so the
     *first* opt-in raises it, within one daily sweep, and it stays raised. The
     alert is therefore **not informational while reclamation is open**: it is
     the standing record that an unreclaimed tree exists and has an owner. Do
     not silence it; opting an agent in is accepted only together with an owner
     for that claim's capacity.

     ⚠️ **On Blockcast that enforcement is not live yet.**
     `deploy/helm/paperclip/values.blockcast.yaml` sets `prometheusRule.enabled:
     false`, and the mirror that actually deploys this rule,
     Blockcast/onprem-k8s#7210, is still open. Until it lands, the ceiling is
     accepted against an alarm that cannot sound — so verify the rule is loaded
     at `/api/v1/rules` before treating the ceiling as enforced, and do not opt
     an agent in on the strength of this paragraph alone.

     **Operator remedy while it is open**: opt the agent back out, or expand the
     claim. `runbooks/isolation-workspace-reaper.md` § "What you can actually do
     about it today" carries both, with the cold-start cost of opting back out —
     neither needs a reclaimer.

     ⚠️ **Reclamation is still open, and the ≈3.7-month ceiling above still
     stands.** The *first* clause of PEN-5125's done-when 2 — an opted-in agent's
     tree swept by *something* — is NOT closed by the detection described above.
     What closed is the silence: the gap is now measurable and alertable
     before the opt-in count grows, which is the half whose absence was
     dangerous. The chosen shape for the reclaimer is a dedicated executor
     holding the agent's claim, off the run hot path, with the eligible set
     computed server-side from `lastUsedAt` so the DB-authoritative idleness
     predicate survives — an in-pod sweep has no database, and `mtime` on
     these roots is materialization time, which is the predicate BLO-31222
     exists to stop using.

     **Re-pointed to PEN-5151 (2026-10-31), which owns that executor.** Its
     server half has since landed, inert: `buildIsolationReclaimPlan`
     (`isolation-workspace-reaper.ts`) performs the inversion the shape asks for
     — rows → directories, so the eligible set for a claim this process cannot
     walk is still decided against `execution_workspaces`, by the same
     `classifyIsolationWorkspaceAge` the mounted sweep uses. That shared
     classifier is the point of the extraction: the two sweeps now run in
     different processes, and a second transcription of the age rule is the
     likeliest way the foreign-claim path ends up deleting on `mtime` alone.

     **The executor's two ends have since landed too**, in the same module and
     for the same reason the age rule is shared: `collectIsolationWorkspaceInventory`
     (readdir + stat, no judgement) and `executeIsolationReclaimPlan`, which
     re-asks `REAPABLE_LAYOUT` and `hasNestedCheckout` against the bytes
     immediately before each unlink. Those two are the SAME functions the mounted
     sweep runs, not a second implementation — the foreign path's characteristic
     failure is a weaker transcription of a rule that exists to keep files, and
     co-locating them is what makes that impossible rather than merely discouraged.

     ⚠️ **What is still missing is the TRANSPORT, so no foreign claim is reclaimed
     and the capacity clause on `resolveAgentWorkspaceClaimName` stays.** Nothing
     creates a Job, nothing carries an inventory back, nothing carries a plan out.
     What a foreign claim lacks now is a pod that mounts it, not a decision about
     what to do once mounted. Two consequences of the split were design
     constraints on those two ends, and are recorded as answered rather than open:

     - **`execution_workspaces` has no agent column**, so a plan cannot be scoped
       to one agent's claim from the rows alone. The intersection has to happen
       where the filesystem is, which is why the executor reports an inventory
       rather than being handed a fleet-wide idle list to match against.
     - **There is no pre-unlink re-read available across the boundary.** The
       mounted sweep re-reads `lastUsedAt` immediately before `fs.rm` because
       restoring a workspace changes neither the root's existence, nor its
       layout, nor its `mtime`. A plan crossing into another process cannot do
       that, so the executor has to bound its own staleness instead. **Chosen and
       enforced: `DEFAULT_MAX_PLAN_AGE_MS`, 10 minutes, re-checked PER ENTRY**,
       with the remainder handed back as `notAttempted` /
       `stopReason: "plan_stale"`. Per entry rather than once at start-up because
       the unlink loop is the slow part — `maxDeletes` removals against an MDS
       measured at 145 files/s can run for minutes, which is exactly the window
       the mounted sweep's per-entry re-read closes. A Job's
       `activeDeadlineSeconds` does **not** cover this and must not be read as if
       it did: it starts counting at pod start, leaving admission, scheduling and
       image pull — the unbounded part — outside the measurement. This remains
       strictly weaker than a re-read, and is recorded as such: it bounds the
       window in which a resurrection could go unseen, where the mounted sweep
       observes the resurrection itself.

     A **fourth** reclaimer shape was weighed while building these ends and is
     refused, recorded beside the three in PEN-5151: *hand the executor a
     fleet-wide list of every idle workspace id and let it intersect against its
     own `readdir`.* It collapses the round trip, and the per-tick bound survives
     if applied at the unlink site. It is refused on disclosure, not mechanism —
     that list is every idle workspace id in the fleet, across every company,
     handed to a pod that exists to hold ONE agent's volume, which widens blast
     radius in the direction this whole stage exists to narrow.

     ⚠️ **The gate does NOT make done-when 1 met.** The criterion is two agent pods on one node
     reporting distinct volume IDs, which needs invariant 5 closed, the server rolled onto this
     code, at least two agents opted in, and a `findmnt` read from inside two **co-located** live
     pods. Landing this is the precondition for that measurement, not the measurement.

     **The invariants 4a hands to 4b.** All of them are inert on the self claim and become live
     the moment the claim is per-agent, so none of them can be caught by the fleet exercise 4a
     relies on. Four were enumerated here; a **fifth** was found 2026-10-31 while writing the
     swap, and all five are now closed on `master` — the fifth by #3173 / #3174, recorded
     above and in §5's table, and closed is not verified. That the fifth was found this
     late is the point worth keeping: the four were derived from the `subPath` mount list and
     from what the server WRITES, and the fifth is a path the pod writes and the server READS,
     which that inventory had no way of surfacing. Anything else crossing the volume in the
     read direction belongs on this list too.

     1. **Populate the server-materialized trees, or relocate them.** One closed by 3b-iii,
        one newly found. `.local/share/paperclip-git-hooks` and `skills/<companyId>` were both
        written by the SERVER into the server's own volume, and on a per-agent claim the seeder
        creates them and they stay EMPTY. The hooks half is **closed**: 3b-iii emptied
        `ROOT_TOOLCHAIN_SUBPATHS`, so the Job does not mount that dir on any claim and there is
        nothing left to populate — §3.6's relocation finished it rather than deferring it here.

        `skills/<companyId>` remains: an empty skills tree dangles the prompt bundle's skill links
        **silently**, where the hooks dir failed closed and loudly. It is also harder than the
        hooks dir was — skills are per-company and agents create them at runtime, so "bake it into
        the image" is not available. Either the server's materializer has to reach the per-agent
        claim, or the seeding moves inside the pod the way `mkdir`/`chown` already did in 4a.

        **⚠️ And it is not alone. Corrected 2026-10-30: the PROMPT BUNDLE ITSELF is a third
        server-materialized tree, and it dominates both.** This invariant previously counted two
        trees and then one; the count was wrong each time because it was read off the `subPath`
        mount list, and the bundle is not a mount — it is a directory the server *writes into* one
        of the mounts.

        `execute.ts` prepares it with `prepareClaudePromptBundle`, under a comment that states the
        assumption exactly: *"One volume, TWO mount points: this process writes at
        `SELF_POD_DATA_MOUNT_PATH` and the K8s Job pod reaches the same bytes at
        `resolveDataMountPath(config)`."* That is true today and **false the moment the claim is
        per-agent** — same relative path, different volume. The server writes a complete bundle
        into its own volume; the pod gets the seeded, empty directory. `--add-dir` then names an
        empty tree and `--append-system-prompt-file` names a file that does not exist.

        So the failure is not a degraded skill set, it is **the agent losing its instructions** —
        and it is silent in the same way, since nothing on the write side errors. Measured on a
        live pod 2026-10-30: the bundle exists at
        `instances/default/data/k8s-isolation/<companyId>/<agentId>/<key>/prompt-cache/<bundleKey>`,
        owned `node:node`, carrying `agent-instructions.md` (3,491 bytes) and `.claude/skills/`.

        It also does not share the skills tree's REMEDY, which is why it changes the shape of 4b
        rather than lengthening its list. Skills can be fixed by getting the right bytes onto the
        claim. The bundle cannot: it is written per-run, at Job-creation time, to a path the server
        chooses, so there is no tree to pre-populate. **The write target has to move onto a channel
        that does not assume a shared volume** — the same kind of channel the prompt text already
        rides (`prompt-secret`, a per-run Secret the `write-prompt` init container copies into an
        emptyDir).

        **Sized and decided 2026-10-30 — see §4.2.** The channel is a Secret projection, and the
        two trees turn out to be one delivery problem rather than two: the bundle carries no skill
        bytes, only `agent-instructions.md` and a symlink farm pointing into the skills tree.

        ⛔ Do **not** reach for the other obvious option, a read-only mount of the server's claim
        beside the per-agent one. §2 already refuses it for the tooling row and the reasoning is
        unchanged here: a shared read-only claim is still one volume ID mounted by every agent pod
        on the node, taking the same ceph-csi lock through the same `NodeUnstageVolume` path.
        It would also defeat this issue's own acceptance criterion.

        **This, not the skills tree alone, was the open design question on 4b's critical
        path. §4.2 closes it.**

        **CLOSED 2026-10-30.** Delivered across #3153 / #3157 / #3158, the last merging at
        20:19:43Z (`3ac9c0b`, with `6840dfb` on top). The in-pod rebuild is **inert until the
        swap** — it has no call site yet, because the Secret it reads is not mounted on the Job
        until `dataClaimName` changes. That is deliberate: it means the delivery channel is on
        `master` and reviewed *before* the swap makes it load-bearing, rather than both landing
        together.
     2. **Close the symlinked-PARENT hole in the seeder.** **CLOSED 2026-10-30.** The seeder
        holds uid 0 + `DAC_OVERRIDE` + `CHOWN` over the volume root, and both `mkdir -p` and
        `chown` follow symlinks. 4a refused a target whose FINAL component is already a symlink
        and used `chown -h`, which removes the direct chown-redirect; a symlinked *parent*
        component was still followed, and that is the worse of the two — the leaf case is caught
        the moment `-L` looks at it, while the parent case has `mkdir -p` build the leaf
        *through* the link onto a real directory reached by an unintended route, after which
        `chown -h` hands uid 1000 a tree it was never scoped to, with nothing erroring.

        The guard is now a per-component walk back to the volume root
        (`d=${d%/*}`, no `dirname` subprocess and no leading-dash argument), with a `case` that
        re-asserts containment on every step — which also refuses a target resolving outside the
        root, and is what BOUNDS the loop. A guard that can spin is worse than no guard: it hangs
        the init container and the Job never starts, which reads as an infrastructure fault
        rather than a refusal.

        Tested by EXECUTION against a real tree, not by shape alone — fresh volume, pre-existing
        real dirs, symlinked leaf, symlinked parent, and an outside-the-root path under a
        timeout — and mutation-checked: reverting to the 4a leaf-only guard fails three of them,
        including the parent case, which exits 0 under the old guard. This was always
        unreachable on the self claim (`resolveScopedWritableMounts` drops nested targets, and a
        narrowed pod cannot reach another agent's subtree), which is why it is closed *ahead* of
        the swap rather than when it bites: a per-agent volume PERSISTS across runs whose target
        sets differ, so one run's writable tree can become an ancestor of a later run's target,
        and the fleet exercise 4a relied on cannot surface it.
     3. **Decide the directory MODE.** **Measured 2026-10-30; decision below; not yet
        implemented.**

        **This item's own premise was wrong, and the correction shrinks it.** It previously read
        "the seeder's dirs inherit its umask rather than the `2775` setgid the server-side path
        got from its parent". The server-side path does not produce `2775` on its children.
        `mkdir -p a/b/c` under an explicitly-`2775` setgid parent gives:

        ```
        2775  .
        2755  ./a
        2755  ./a/b
        2755  ./a/b/c
        ```

        Setgid propagates; **the group-write bit does not** — that comes from the creating
        process's umask. So the seeder/server gap is one bit (setgid), not the `0755`-vs-`2775`
        gap this item implied.

        **Nothing is choosing these modes today.** The live shared volume carries three different
        modes in one chain — `755 root:root` down through `…/k8s-isolation/workspaces/<wsId>`,
        `2755 node:node` on `…/<wsId>/session` (a seed target), `2775 node:node` on the checkout
        root, `2775 1000:1000` inside `.git`. `core.sharedRepository` is unset in that repo and a
        grep over `packages/*/src`, `vendor/*/src` and `server/src` finds no `chmod` or setgid
        call producing any of it. Each directory's mode is an artefact of **which process created
        it** (its umask) and **whether an ancestor carried setgid at that moment**. That is
        exactly the property that stops holding per-agent, because then the seeder creates all of
        them.

        **Who the bit is load-bearing for.** The publish-broker sidecar runs `runAsUser: 1001`,
        `runAsGroup: 1000`, `umask 0002` (`job-manifest.ts:2623`). Against a `1000:1000` directory
        at `0755` it matches neither owner nor a writable group bit, falls through to `other` =
        `r-x`, and cannot create entries. The live tree hides this because everything the broker
        touches sits inside a `.git` that is `2775` — a mode the **clone** produced, not the
        seeder. On a fresh per-agent volume the seeder creates those paths at `0755` (umask
        `0022`, no setgid on the subvolume root to inherit) and then `chown`s: both bits lost
        relative to what the live tree carries.

        **Decision: `mkdir -m 2775 -p`, not a separate `chmod`.** Set the mode *at creation*,
        on the targets the seeder itself creates.

        ⚠️ **An earlier revision of this paragraph decided "`chmod 2775` on the writable target
        set after `mkdir -p`". That is not executable by this seeder and would have failed the
        Job closed.** Raised by review on #3164, verified here. `chmod(2)`'s owner-match check is
        gated on `CAP_FOWNER` specifically — `CAP_DAC_OVERRIDE` does not cover it — and the
        seeder holds `drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE"]`
        (`job-manifest.ts:4376-4382`), with FOWNER's absence argued *deliberately* in the comment
        directly above it on the grounds that no syscall it makes needs one. A `chmod` is exactly
        such a syscall. On a **persistent** per-agent volume the targets already exist
        `1000`-owned from the previous run — which is this plan's own invariant-2/4 premise — so
        uid 0 is not the owner, `chmod` returns `EPERM`, and the script is under `set -e`
        (`job-manifest.ts:4279`): the init container fails and the Job never starts. Ordering the
        `chmod` *before* the `chown` does not save it, because on every run after the first the
        directory is already 1000-owned before the seeder runs at all.

        **`mkdir -m` avoids both horns, and the reason is a behaviour worth stating because the
        obvious local test gets it wrong.** Measured 2026-10-30:

        | probe | result |
        |---|---|
        | `mkdir -m 2775 -p a/b/c` on a fresh chain | leaf `2775`; **intermediates `755`** — `-m` applies to the final component only |
        | `mkdir -m 2775 -p x/y` where `x/y` exists at `0700` | **rc 0, mode left at `0700`** — no `chmod` issued |
        | `chmod` of an inode owned by another uid, as an ordinary subject | `EPERM` (no-op `chmod`, so it is the owner-match check firing, not the mode) |
        | `chown` a **directory** carrying `2775` | setgid **preserved** |
        | `chown` a **file** carrying `2775` | setgid **cleared** |

        The second row is the load-bearing one and it is *not* a coreutils convenience that
        busybox might not share — the image is `busybox:1.36`, so it was read from that source
        rather than assumed. `libbb/make_directory.c` tolerates `EEXIST` on the final component
        and then takes `goto ret0` under the comment *"Since the directory exists, don't attempt
        to change permissions if it was the full target. Note that this is not an error
        condition."* The `chmod(path, mode)` at the end of that function — the one whose failure
        the source explicitly calls an error — runs **only when `mkdir()` itself succeeded**, i.e.
        only on a directory the seeder just created and therefore owns. So `mkdir -m` never
        issues a `chmod` that can `EPERM`, on either implementation, and needs no `CAP_FOWNER`.
        The fourth row is what makes the mode survive the `chown` that follows, and it is a
        kernel guarantee rather than a filesystem accident: `chown_common()` puts the whole
        bit-stripping clause — `ATTR_KILL_SUID | ATTR_KILL_PRIV |
        setattr_should_drop_sgid(...)` — inside `if (!S_ISDIR(inode->i_mode))`
        (`fs/open.c:779`, v6.8, which is this cluster's kernel line). Directories keep setgid
        where files lose it, so the `mkdir -m`-then-`chown` order is safe in that direction.

        **What this buys and what it does not.** It makes the mode independent of umask and of
        ancestor setgid *for every target the seeder creates*. It does **not** deliver the
        "a fresh per-agent volume and the shared one converge" property the superseded paragraph
        claimed: a target that already exists keeps whatever mode it has, and nothing here
        changes it. That is acceptable **only because a per-agent volume is fresh by
        construction** — at cutover the seeder is the first creator of every target, so the mode
        it sets is the mode the path keeps. The residual gap is a target whose parent some
        uid-1000 agent process created first at `0755`; if that is ever observed to bite the
        broker, the remedy is `CAP_FOWNER` plus an explicit `chmod`, which is PSS-baseline-allowed
        and now a costed option rather than a surprise. Do not reach for it pre-emptively: it
        widens the seeder's privilege for a case not yet seen, and it adds a third act to
        invariant 4's window (below).

        ⚠️ **What is NOT measured, stated rather than glossed.** This seat has no `create` on
        `pvc`, `job` or `pod` in namespace `paperclip` (`kubectl auth can-i` → `no` for all
        three), so the model above is POSIX semantics in a scratch tree, **not** a CephFS fresh
        volume. The CephFS-specific question — whether a freshly provisioned subvolume root
        carries setgid, which would change what the seeder's children inherit — is **unmeasured**
        and must be checked when 4b is applied. Setting the mode explicitly at creation is
        chosen partly because its correctness does not depend on that answer — `mkdir -m` states
        the mode rather than inheriting one.

        One sub-question left to the implementation: `mkdir -p` also creates **intermediate
        parents** that are not in the target list, and `-m` does not reach them either (probe
        row 1 above), so they are neither chowned nor given a mode; on a fresh volume those land
        `root:root` at the seeder's umask. The live tree already shows that shape
        (`…/workspaces` is `755 root:root`). Whether it needs handling depends on whether any
        uid-1000 process creates siblings beneath them outside a seeder run.
     4. **The seeder guard is check-then-act, and concurrency makes that reachable at the swap.**
        **OPEN.** Raised by review on #3161, verified here, and narrowed twice since.

        Invariant 2 closed the hole for links that **already exist when the guard runs**. This is
        the hole for links that **appear after it runs** — between the guard and the
        `mkdir -p` / `chown` it protects. Per-agent claims introduce both halves of what makes it reachable:
        the **persistence** that lets a planted link survive a run, and the **concurrency** that
        makes planting it ordinary.

        **It is reachable because concurrent same-agent runs are the norm, not an edge case.**
        The in-code justification is *"init containers are sequential, so nothing else in the Pod
        is running"* — **Pod-scoped**, and Pod scope is precisely what a per-agent claim
        dissolves: the concurrent writer is a uid-1000 agent container in a *different Pod, on a
        different node*, sharing the claim. Read live 2026-10-30: two agents each held 2
        concurrent run pods, one spanning two nodes; a seat measured at `maxConcurrentRuns: 5`.
        PEN-4902's subject is that concurrency-1 is the *remnant* being retired. This is also why
        a per-agent claim must stay `ReadWriteMany` — which is what keeps the window reachable and
        rules out "just make it RWO".

        **⚠️ Correction, 2026-10-30 — the window is guard → `chown`, and the `chown` half is the
        worse one.** An earlier revision of this plan, and of the comment in `job-manifest.ts`,
        put the window at guard → `mkdir -p` on the grounds that `chown -h` "never traverses".
        **That is wrong.** `-h` maps to `lchown(2)`, which declines to follow only the **last**
        component; every intermediate component is resolved the ordinary way, symlinks included.
        Measured rather than read off the man page:

        | probe | result |
        |---|---|
        | `elsewhere/leaf` real, `link -> elsewhere`; `chown -h link/leaf` | exits 0, lands on `elsewhere/leaf` |
        | `chown -h link/nosuchthing` | exits 1 — so the 0 above really did locate the file *through* the link |
        | `deadlink -> /nonexistent`; `chown -h deadlink/leaf` | ENOENT — reachable only by having resolved the intermediate |

        So a uid-1000 writer that swaps a parent component inside the window gets, from uid 0,
        **both** `mkdir -p` creating root-owned directories at a route it chose **and** `chown`
        handing uid 1000 ownership of a directory it chose. The second is an **ownership
        transfer**, not a misplaced mkdir.

        **Two remedies are ruled out, and the reasons differ.**

        - *"Re-check between `mkdir` and `chown`"* — **ruled out.** The re-check is itself
          check-then-act, so it closes neither half; it only shortens the race.
        - *`fsGroup`* — **ruled out on cost, not availability**, and this is a refutation of a
          hypothesis this plan went looking for rather than a result. Owning the tree as 1000
          would let the seeder drop uid 0 entirely, making the race uid-1000-on-uid-1000 and *not
          a privilege boundary at all* — dissolving this invariant rather than mitigating it, and
          plausibly invariant 3 with it (kubelet sets setgid when applying fsGroup).
          `cephfs.csi.ceph.com` reports `fsGroupPolicy: File` on this cluster, so kubelet **would
          honour it**. What blocks it is `values.blockcast.yaml`, which clears the chart's
          `fsGroup: 1000` because cephfs does not reliably short-circuit
          `fsGroupChangePolicy: OnRootMismatch` — kubelet re-walks the volume on *every* mount,
          giving 30-45 min rollouts (onprem-k8s #225). A per-agent volume starts empty, but grows
          to that agent's own checkout, so the walk is re-paid **per pod start** and scales with
          the volume rather than being one-off. **Do not re-propose without re-measuring that
          short-circuit against a real per-agent claim** — if it does short-circuit on a small
          volume, this becomes the best answer again, so it is a live question rather than a
          settled one.

        **Three acts sit in the window, not two.** `mkdir -p` and `chown -h` as above, and —
        once invariant 3 lands — the `chmod()` that `mkdir -m` performs on a directory it just
        created. That third one is the narrowest of the three (it fires only on the
        just-created path, so a writer must `rmdir` and replace it inside a very tight race) but
        it is not absent, and `chmod` has **no** no-follow form: unlike `chown -h` it
        dereferences the final component too. A separate post-hoc `chmod`, had FOWNER made one
        possible, would have been the widest act of the three for exactly that reason — a second
        count against it.

        **Costed 2026-10-30, and the answer is neither of the two this plan last named.** The
        two it named were an fd-relative walk — `openat(…, O_NOFOLLOW|O_DIRECTORY)` per
        component, then `fchown`/`fchmod` on the final fd, which `sh` cannot express and so means
        moving the seeder to a different image and a different language, carrying path-resolution
        logic we would then own — and serialising same-agent runs on the claim, which costs
        exactly the concurrency PEN-4902 is retiring concurrency-1 to preserve. Both harden or
        avoid the race *across* the privilege boundary. There is a third option that **removes
        the boundary**, and it costs about two lines of manifest.

        **Recommendation: chown the volume ROOT once as uid 0, then do everything else as uid
        1000.** Split the seeder in two:

        | phase | uid | capabilities | does |
        |---|---|---|---|
        | A | 0 | `drop: ALL`, `add: [CHOWN]` | `chown 1000:1000 /mnt/paperclip-data-seed` — one inode, nothing else |
        | B | 1000 (`runAsNonRoot`) | `drop: ALL`, none added | the component guard + `mkdir -m 2775 -p`; **no `chown` at all** |

        **Phase A has no TOCTOU to speak of, and that is structural rather than lucky.** Its one
        argument is the mount point itself — kubelet's own mount of the volume root. There are no
        path components *inside* the volume between the process and the inode, so there is
        nothing for a concurrent writer to swap; and the mount root cannot be replaced from
        inside the volume (no pod can `rmdir` a mount root, and the parent directory is the
        container's own rootfs, which no other pod shares). `DAC_OVERRIDE` is not needed —
        phase A writes nothing — so the uid-0 surface shrinks from two capabilities over a whole
        skeleton to one capability over one inode.

        **Phase B dissolves the invariant rather than mitigating it.** Once the root is
        `1000:1000`, every directory the seeder creates it creates *as* 1000, so no `chown` is
        needed and `mkdir -m 2775` works because the creator is the owner (invariant 3 falls out
        for free). The concurrent writer this invariant is about is a uid-1000 agent container —
        now exactly as privileged as the seeder. A symlink planted inside the window redirects
        phase B into doing something the planter could already do directly, so it stops being a
        privilege boundary and therefore stops being a vulnerability. ⚠️ The component guard
        should be **kept and re-labelled**: it remains worth having against accidents and against
        a future re-privileged phase, but the comment must stop describing it as a security
        control, or the next reader will take the boundary to still exist.

        **Why this is available now and was not when the seeder was written.** The seeder needs
        uid 0 only to create directories the agent must *not* own — the read-only toolchain
        binds, of which the PEN-3156 pre-push hook dir was the sharp case. Stage 3b-iii emptied
        `ROOT_TOOLCHAIN_SUBPATHS` (`job-manifest.ts:718`, now `[]`) and moved the hooks into the
        image, and `readOnlySubPaths` derives to `[]` on **both** branches where the seeder can
        exist: with `narrowWritableSurface` true the sole `rootMounts` entry carries no `subPath`
        (`:3389-3398`), and with it false the seeder is `null` outright. So
        `seedSubPaths === writableSubPaths` — **every path the seeder touches is one that ends
        up 1000-owned anyway.** The uid-0 phase has nothing left to protect except the single
        `chown` that makes 1000-ownership possible in the first place. This is read from source,
        not executed; the nearest standing test asserts the hooks path's *absence* from the
        seeder script (`job-manifest.test.ts:5246-5257`) rather than pinning the set's emptiness,
        and an implementing PR should add that converse assertion.

        **Done in #3165, and as a build-time refusal rather than an assertion.** Pinning the set's
        emptiness would have pinned today's value; the thing actually worth enforcing is the
        *consequence* of it. `resolveSeedShape` throws when the split shape meets a non-empty
        `readOnlySubPaths`, because that container `mkdir -m 2775`s its targets as uid 1000 and
        would hand a read-only bind back group-writable to the containers it exists to be
        read-only for — silently, since the Job still starts and the mount is still present. It
        throws rather than falling back to the uid-0 shape: that fallback reads as safer and is
        not, for the rollback reason below. Re-adding a `ROOT_TOOLCHAIN_SUBPATHS` entry now fails
        the manifest build instead of quietly inverting a boundary.

        **It also ends strictly tighter than today.** Phase B is PSS-**restricted** compliant
        (non-root, all capabilities dropped); the current seeder is the one container in the Pod
        that is merely baseline, and `job-manifest.test.ts:5399-5402` pins it as the only uid-0
        container in the Job. After the split, the uid-0 container does one `chown` and nothing
        else.

        ⚠️ **WITHDRAWN 2026-10-30 — the paragraph this replaces was wrong, and it was wrong in
        the expensive direction: it coupled this change to the swap for a whole stage.** It read:
        *"This is 4b-only, and shipping it early would be a widening. Chowning the volume root to
        `1000:1000` is right for a per-agent volume and wrong for the shared one — there it would
        let any agent pod create and delete entries at the root of the volume every agent shares.
        Phase A must therefore be gated on the claim being per-agent, and that gate does not exist
        yet: it arrives with the `dataClaimName` swap. Sequence it with the swap, never ahead of
        it."* Recorded as a hard sequencing constraint, it was never checked against
        `rootMounts`. **One reason carries the withdrawal on its own. A second was recorded
        alongside it as equally sufficient, and that was itself an overstatement — it is narrower
        than the withdrawn paragraph needed, and is kept below, demoted, because getting it wrong
        the second time is part of the record.** (They are listed here in the opposite order to
        PR #3167's description *as originally written*, which presented the narrow one first and
        repeated the "either sufficient" claim; that description was corrected in the same review
        cycle, so the two now agree.)

        1. **The widening it feared is not reachable — and this reason carries the withdrawal by
           itself.** Under `narrowWritableSurface` — which is a *precondition of the seeder
           existing at all* — the agent containers mount the `root-overlay` `emptyDir` at
           `dataMountPath`, not the `data` volume (`job-manifest.ts:3389-3399`), and
           `write-prompt` reuses that same list (`:4215`). Every other mount of `data` is a
           `subPath` bind (`:3587`, `:3626`, `:4221`); the only container in the Pod that mounts
           `data` at its root is the seeder itself (`:4410`). Read back off a live Pod spec
           2026-10-30 (`ac-386c81e8-…-gdwld`, company `aaced805`, node `k8s-paperclip-3`):
           `claude` and `write-prompt` both take `root-overlay` at `/paperclip`, every one of
           their `data` entries carries a `subPath`, and `seed-writable-dirs` is the sole
           root-of-volume mount, at `/mnt/paperclip-data-seed`. So "any agent pod could create
           and delete entries at the shared root" describes a reachability the manifest does not
           grant: chowning that root widens nothing an agent container can address.
        2. **A gate exists — but a narrower one than the withdrawn paragraph asked for, so this
           reason does NOT stand alone.** `serverCanPreCreate` (`job-manifest.ts:3272`,
           `narrowWritableSurface && dataClaimName === selfPod.pvcClaimName`) tests whether a
           claim is *the server's own*. The withdrawn paragraph wanted a different test — whether
           a claim belongs to **one agent** — and the two come apart: a claim can be foreign and
           still be shared by several agents. Such a claim passes `!serverCanPreCreate`, is given
           the split shape, and has its root chowned. That is safe, but it is safe because of
           reason 1, not because of this gate. What this gate does settle is the narrower case
           the withdrawn paragraph was actually written about: today's one shared claim *is* the
           server's own, and the shape is selected *per claim*, so that claim is never chowned at
           all. Right about today's volume; not the general argument it was recorded as.

        **What this cost, and the lesson worth keeping.** Reason 1 was readable from the same
        function the recommendation was written against. Recording a *blocker* from reasoning
        about a mount layout, without reading the layout, held a self-contained change hostage to
        a much larger one. Where this plan says "must ship with", that claim needs a citation of
        the same kind it demands for a measurement — and §5's row 4 points here rather than
        restating it.

        **The lesson has a second half, learned the same way.** The withdrawal as first written
        offered reason 2 as independently sufficient. It is not, and nothing had checked that
        either: `serverCanPreCreate` was read for what it gates, not for what it *tests*, and a
        reader who took it as "this claim is one agent's" would have carried the same class of
        unverified premise forward under the banner of correcting one. A retraction is not exempt
        from the standard it imposes. Both halves are left standing above rather than tidied into
        a single clean reason, because the shape of the error is the useful part of the record.

        **What shipped instead:** #3165, on its own and ahead of the swap. Two shapes selected by
        `serverCanPreCreate`; every Job on the fleet today keeps the byte-identical single uid-0
        container, asserted by a negative-control test. The split shape is unreachable **unless an
        execution target sets `workspaceVolumeClaim` to a non-server claim**. Whether a per-agent
        claim exists is *not* what decides that, and the source says so where the recommendation
        could have read it: `job-manifest.ts:3273-3276` — *"Reachable TODAY, not only in stage
        4b … an operator can already point a Job at a foreign claim."*

        **So it was measured — this paragraph's own lesson applied to this paragraph.** Over
        Prometheus's full retention window, **22,949** distinct agent-Job pods in namespace
        `paperclip` declared a PVC-backed volume, and every one of them named the same claim:

        ```promql
        count by (persistentvolumeclaim) (
          max_over_time(kube_pod_spec_volumes_persistentvolumeclaims_info{namespace="paperclip", pod=~"ac-.*"}[7d])
        )
        → {persistentvolumeclaim="paperclip-data"}  22949      # one series, 2026-10-30
        ```

        The server's own pods — `paperclip-0`, `paperclip-1`, and both `paperclip-api-*` — name
        that same `paperclip-data`, so `dataClaimName === selfPod.pvcClaimName` holds for every
        one of those 22,949 Jobs and `serverCanPreCreate` is true fleet-wide. The split shape is
        inert **in fact**, measured, rather than inert by a construction that does not hold. That
        is still the point: the swap becomes a claim change rather than a claim change plus a
        privilege-model change.

        ⚠️ **Two limits on that measurement, stated rather than glossed** — the same two §4.1
        already attaches to the wedge baseline. First, Prometheus retains ~7 days, so this is
        "no foreign claim in the last week", not "never". Second, it observes *rendered
        manifests*, not the environment config rows that render them: that table is board-scoped
        and this seat is refused (`GET /api/companies/:id/environments` → 403). An environment
        could set `workspaceVolumeClaim` explicitly to `paperclip-data` — indistinguishable here,
        and harmless, since it resolves to the server's own claim either way. What the
        measurement does rule out is any target that currently renders a *different* one.

        ⚠️ **A real constraint does survive, in the opposite direction, and it is sticky.** The
        server's own claim must *keep* the uid-0 shape — not as caution but because that volume
        carries root-owned intermediate directories from every past uid-0 run (`mkdir -p a/b/c`
        chowns only `c`), and a uid-1000 `mkdir` of a new sibling inside one EACCESes under
        `set -e`, failing the init container fleet-wide on the first roll. The corollary is a
        **rollback hazard**: seeding a per-agent claim with the uid-0 shape even once leaves
        root-owned intermediates the split shape can never create inside afterwards. Reverting
        #3165 after the swap has begun is therefore not a clean revert.

        ⚠️ **That hazard is not rollback-only — it reaches the forward path too, and on master
        already.** The seeder's gate is `narrowWritableSurface`, **not** `serverCanPreCreate`
        (`job-manifest.ts:4270`). So the uid-0 seeder today runs against a *foreign* claim just as
        readily as against the server's own, and any claim ever seeded that way may already carry
        root-owned intermediates — inside which, per the paragraph above, a uid-1000 `mkdir` of a
        new sibling EACCESes under `set -e`. The measurement above says no such claim is in use
        on the fleet today, which is why this is recorded as a precondition to check before the
        swap rather than as a live defect. Stated as the rule it implies: **a claim that has ever
        been seeded under the uid-0 shape cannot be adopted as a per-agent claim without first
        reconciling its ownership** — in either direction of travel, and regardless of whether a
        gate selects the shape correctly.

        **Not measured.** Whether a freshly provisioned CephFS subvolume root accepts the chown
        from inside the pod mount (it should — the mount *is* the subvolume root, so this is an
        ordinary `setattr` — but it is the same unmeasured surface invariant 3 records, and this
        seat has no `create` on `pvc`/`job`/`pod` to settle it). If it does not, the fd-relative
        walk is still there as the fallback, and `fchmod` belongs beside `fchown` in it since it
        subsumes invariant 3's act too — no second path resolution.
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

### 4.2 The 4b delivery channel: sized, and decided

Closes the question invariant 1 left open. Every figure below was read on 2026-10-30 from a live
agent pod and from `origin/master`, not estimated.

#### Finding 1 — the two trees are ONE delivery problem, but the unit to ship is the run's entries

Invariant 1 treats `skills/<companyId>` and the prompt bundle as two problems with different
remedies. Measured, they are one. The bundle is **`agent-instructions.md` plus a symlink farm**:

```
prompt-cache/<bundleKey>/agent-instructions.md     3,491 bytes
prompt-cache/<bundleKey>/.claude/skills/           symlinks -> entry.source
```

`prepareClaudePromptBundle` writes exactly that — `fs.mkdir(skillsHome)` then one `symlink` per
entry, whose target is `entry.source` put through `toPodAddress` (`prompt-cache.ts:499-508`). The
bundle carries **no skill bytes of its own**, so it is not a third payload and one channel can
cover both trees. That much holds, and it is what retires invariant 1's "they do not share a
remedy" — which was read off the mount table and does not survive reading the writer.

> **Correction (Ally, 2026-10-30).** An earlier draft said `entry.source` is
> `resolveManagedSkillsRoot(companyId)/__versions__/…`, i.e. always inside the skills tree. That is
> the **missing-version** branch (`company-skills.ts:5477`), not the normal path. Normally
> `resolveRuntimeSkillSource` returns `resolveExistingSkillDirectory(normalizeSkillDirectory(skill))`
> (`:5487`), and `normalizeSkillDirectory` resolves **`skill.sourceLocator`** for both `catalog` and
> `local_path` (`:2238`). A `local_path` locator need not be under the managed root at all:
> `:2588-2600` branches on exactly that distinction — `localSkillDir.startsWith(managedRoot)` versus
> a project/workspace scan (`metadata.sourceKind === "project_scan"`). The live sample cannot settle
> it either way, because that pod's `.claude/skills/` was **empty** and so had no links whose targets
> could be inspected.

So: **catalog and managed `local_path` skills live in the tree; project-scan `local_path` skills do
not.** A Secret built from `skills/<companyId>` would carry the first set and silently omit the
second — producing exactly the dangling link this design exists to prevent, and indistinguishable
from the bug it is meant to fix.

**What this changes.** The unit to project is not the company tree but the **run's resolved
entries**: the `entry.source` directories `prepareClaudePromptBundle` is actually handed
(`company-skills.ts:5565-5572`). That covers every `sourceType` by construction, rather than by
enumerating the ones that happen to sit under the managed root, and it shrinks the payload to what
the run uses instead of everything the company owns. Adapter-bundled **image** paths are the one
exclusion, since those survive in the image — the same discriminator `prompt-cache.ts` already
applies when it decides whether to report `prompt_bundle_off_volume`.

#### Finding 2 — the skills tree is server-written and pod-READ-ONLY

This is what makes a projected channel admissible at all, and it was worth confirming rather than
assuming, because invariant 1 says *"agents create them at runtime"* — which is true, and
misleading about the data path.

`resolveManagedSkillsRoot` is defined in `server/src/services/company-skills.ts` and called only
there — 12 call sites, all in that one service. No other module resolves the tree: the adapter's
single mention of the name is a comment (`prompt-cache.ts:409`), and a vendored adapter cannot
import from `server/src` anyway. The Job mounts the tree `readOnly: true` (`companySkillsMount`,
`job-manifest.ts`). Agents create skills **through the server**, not by writing that mount. A delivery channel therefore needs no write-back path, and the tree can be
re-materialized per run from the server's own copy without losing anything the pod produced.

> **Scope gap, same as Finding 1's (Ally, 2026-10-30).** `readOnly: true` is verified on
> `companySkillsMount`, which is the **managed tree**. A project-scan `local_path` skill's bytes do
> not live there, so that mount establishes nothing about them. Projecting the run's entries
> (Finding 1) brings those sources into the channel, and the channel reads them — but
> "pod-read-only" must be re-established for the workspace tree rather than inherited from this
> mount, since the pod does mount workspace paths writably elsewhere.

#### Finding 3 — sizing, and the ceiling that is closer than it looks

One company is measurable from an agent seat (`GET /companies` → `403 Board access required`), so
the fleet distribution is **unmeasured**. Stated as a sample, not a bound:

| quantity | measured |
|---|---|
| skills tree, raw | **130,390 bytes over 22 files** (22 directories) |
| per-file Secret projection, base64 (what was originally measured) | ~176,397 bytes — 16.8 % of the cap, but **this is not the enforced quantity**; see the correction below |
| per-file Secret projection, **decoded** (what `ValidateSecret` budgets) | 130,390 bytes — **12.4 % of the 1 MiB Secret cap** |
| `tar.gz` + base64, stored | 60,164 bytes — 5.7 % of the cap |
| prompt bundle, real content | 3,491 bytes (1 file; 0 skill bytes) |

Correction: invariant 1 recorded "133 KB over 44 files". The byte figure was close; **the file
count was not** — 44 is files *plus directories*. There are 22 files.

> **Correction 2026-10-30 (implementation): the 16.8 % row measures the wrong quantity, and the
> error matters for the trigger rather than the guard.** The cap is enforced on **decoded** bytes,
> not base64. `ValidateSecret` computes `totalSize += len(value)` over `secret.Data`
> (`map[string][]byte`) against `MaxSecretSize = 1 * 1024 * 1024`, and
> `Convert_v1_Secret_To_core_Secret` merges `StringData` into `Data` as `[]byte(v)` **before**
> validation runs — so a UTF-8 byte length is what the API server checks, and **keys are not
> counted** (the loop validates each key but adds only the value's length). Read from the
> Kubernetes source on 2026-10-30, not from memory: `pkg/apis/core/validation/validation.go`,
> `pkg/apis/core/types.go`, `pkg/apis/core/v1/conversion.go`.
>
> 176,397 / 130,390 = 1.353 — base64 expansion (4/3 plus padding). So the sample is **12.4 %** of
> the budget actually enforced, not 16.8 %. That is the safe direction for the *budget*, which
> would merely refuse early. It is **not** safe for the **escalation trigger**: a 50 % threshold
> evaluated on base64 bytes fires at an effective 37.5 % of real capacity, moving the design to the
> init-container fetch a third of the way early. Both are now computed on the same decoded
> `totalValueBytes`, which is what the decision's "the guard and the escalation cannot disagree
> about what they are measuring" requires. The conclusion below is unchanged: a per-file hard stop
> equal to the whole budget bounds neither file count nor tree size, so 12.4 % is a sample of an
> unbounded quantity and not headroom.

**12.4 % is not headroom, and this is the part that decides the design.** The only size constant
anywhere in the skills path is `MAX_CATALOG_FILE_BYTES = 1024 * 1024`
(`company-skills.ts:467`) — and it is

- **per file**, not per tree, so one lawful file equals the entire Secret budget on its own; and
- a **hard stop, not a report**. `oversized_file` is pushed at severity `"error"`
  (`company-skills.ts:2459`); any `error` finding makes the audit verdict `"fail"` (`:2500`); and a
  `fail` verdict throws `unprocessable(…, { updateHoldReason: "audit_hard_stop" })` on update
  (`:4281`), on catalog update (`:4367`) and on catalog install (`:5318`). A file over 1 MiB is
  **refused**.

> **Correction (Ally, 2026-10-30).** An earlier draft called this "not admission control — it
> reports; it refuses nothing". That is wrong, and wrong in the direction that invites 4b's
> implementer to treat the audit as decorative. The *conclusion* is unchanged: a hard stop at 1 MiB
> **per file** is the whole Secret budget on its own, and it bounds neither the file count nor the
> tree size.

So a single lawful skill file can exhaust the whole channel, the file count is unbounded, and
nothing upstream keeps a company — or a run — below the cap. Today's 12.4 % is one sample of an
unbounded quantity.

#### Decision

> **Adopt the Secret projection, carrying the run's resolved skill entries. Reject the
> init-container API fetch as the first implementation, and keep it as the named escalation rather
> than a hypothesis.**

The precedent is exact and in-tree. **PEN-3329** is the same failure in a different tree: the
server materialized `docs/<name>.md` into the execution workspace, a run-isolated pod did not
mount that workspace, and *"every one of the 14 declared docs was reported absent, measured on a
live pod"*. Its resolution — `buildSharedDocSecretProjection`, positional keys, `items[].path`
restoring the layout, `optional: false` so a failed Secret is a pod that cannot start rather than
a run that silently reads nothing — is the machinery this needs, and its reasoning transfers
verbatim: *"Staging a Secret makes delivery depend on the Job alone rather than on the pod's mount
set."* Mount-shape independence is precisely the property 4b breaks and must restore.

Three things it buys over an API fetch: no new endpoint and no new authenticated surface reachable
from a pod; no network dependency inserted into pod start; and a failure that is a `Pending` pod
with an event, not a partially-populated tree.

Two properties the implementation must carry, both forced by Finding 3:

1. **An enforced budget at projection time, with a named error.** The channel must measure its own
   projected size and refuse over-budget with a verdict that names the company, the run, and the
   measured bytes — never truncate. A dropped skill is exactly the silent dangling-link failure this
   whole invariant exists to prevent, and it would be indistinguishable from the bug. The quantity
   measured is the **projected per-run Secret size** — the sum over the run's resolved entries, not
   the company tree — because that is what actually ships (Finding 1).
2. **Symlinks do not survive a Secret projection**, so the bundle's `.claude/skills/<runtimeName>`
   farm must be built **in-pod** from the projected tree. *(Landed 2026-10-30; see the end of this
   section.)* That is the concrete form of invariant
   1's *"the write target has to move"*, and it is a small init-container step, not a redesign:
   the link set is already derivable from the entries the server sends.

**The escalation, and its trigger.** The budget is reachable by lawful input, so the Secret channel
is a first implementation and not a final answer. The init-container fetch becomes the design once
any **run's projected Secret size** crosses **50 % of the cap** — chosen so the move is made against
a measurement rather than under an outage. Trigger and metric are defined on the same per-run
quantity property 1 enforces, so the guard and the escalation cannot disagree about what they are
measuring; an earlier draft defined the trigger per *company tree*, which is neither what ships nor
what the budget checks. That the projected size must be *emitted*, not merely checked, is why
property 1 is instrumentation as much as it is a guard.

**Landed 2026-10-30 — the channel's builder, measuring but not yet delivering.**
`vendor/paperclip-adapter-claude-k8s/src/server/prompt-bundle-projection.ts` implements property 1:
it walks the run's resolved entries, projects them to positional Secret keys with `items[].path`
restoring the bundle layout, and **refuses** — `PromptBundleOverBudgetError`, naming company, run
and measured bytes — rather than truncating.

Three properties of that walk were corrected in review (2026-10-30) and are worth recording,
because each was a way for the channel to under-deliver *silently* — the failure mode this whole
invariant exists to rule out:

* **Image-path exclusion is not a path-prefix test.** An earlier draft excluded any entry whose
  source was not under `SELF_POD_DATA_MOUNT_PATH`, and described that as "the same discriminator
  `prompt-cache.ts` already applies". It is not. `prompt-cache.ts:509-519` records that the prefix
  test is correct *for an image path only*: a catalog-backed source is a `PAPERCLIP_HOME` path, and
  `PAPERCLIP_HOME` (an env var defaulting to `~/.paperclip`) and the server mount (a hardcoded
  `/paperclip`) are two variables that coincide in today's deployment rather than one. Where they
  diverge, the prefix test calls **every catalog skill** an image path and drops it with no signal.
  The projection now keys on `catalogBackedSkillKeys` — what `prompt-cache.ts` actually uses —
  OR'd with the mount prefix, and only the remainder is an image path.
* **Files travel as bytes, not as decoded strings.** Reading every file as UTF-8 substitutes
  U+FFFD for each invalid byte, so a PNG, a font or a Latin-1 file in a skill tree would be
  delivered corrupted *and* measured at 3 bytes per invalid byte. Valid-UTF-8 files now travel in
  `stringData` and the rest base64 in `data`; both count their decoded length against
  `MaxSecretSize`, so the budget arithmetic above is unchanged and `binaryFileCount` reports how
  many took the second channel.
* **Skipped symlinks were counted — and are now RESOLVED-WITHIN-TREE OR REFUSED.** The first
  draft of the walk stepped over links so that one could not escape the tree, and counted the
  skips so the trade was visible rather than silent. That was sound only while the projection was
  measurement-only, and it carried the ⛔ constraint below. **Discharged 2026-10-30** — the walk no
  longer steps over a link at all.

  The reason it could not stay a number: `hashPathContents` (`prompt-cache.ts:190-205`) *resolves*
  a link with `realpath` and hashes the target, and the pod reads the bundle by traversing the real
  tree, so a link inside a skill delivers its target's bytes **today**. A projection that stepped
  over it would become, on the run that swaps `dataClaimName`, a file the pod used to get and
  silently stops getting — the precise dangling-skill failure this channel exists to prevent,
  reintroduced by the change meant to close it.

  Every link now takes exactly one of four outcomes, none of them silent:

  | link resolves to | outcome |
  |---|---|
  | a regular file inside the tree | projected under the **link's** path carrying the **target's** bytes, matching what the pod reads today; `resolvedSymlinkCount` |
  | a directory inside the tree | descended into, so its files project under the link's path as the pod sees them |
  | anything outside the tree | **refused** — `PromptBundleSymlinkEscapesTreeError` |
  | nothing (dangling) | counted as `danglingSymlinkCount`, **not** refused |

  Three details are load-bearing and were each a way to get this wrong:

  * **Containment is tested against the tree root's `realpath`, not against `entry.source`.** The
    managed skill root routinely sits under a symlinked mount component, so a genuinely within-tree
    link resolves to a path that does not share the unresolved prefix — testing against the raw
    source would refuse every run on such a deployment.
  * **The prefix test compares on a path boundary.** A bare `startsWith` accepts `<root>-evil` as
    inside `<root>`, i.e. the containment check failing open on exactly its adversarial input.
  * **The cycle test is a true ANCESTOR test, not a seen-directory test.** Two sibling links onto
    one real directory are not a cycle — the pod really does see that content under both names, and
    both are projected. Deduplicating on "already visited" would drop one of them, which is the same
    silent loss this change exists to remove. Only a link onto its own ancestor expands without
    bound, and that is refused (`PromptBundleSymlinkCycleError`) rather than truncated at a depth,
    because truncating silently picks which of the expanded paths the pod gets.

  **Why an out-of-tree target is refused rather than copied.** Two faults meet at one link.
  *Delivery*: the target is reachable only because the pod shares the server's volume, which is
  exactly what a per-agent claim takes away, so projecting the link without its target dangles on
  the swap. *Containment*: copying an arbitrary out-of-tree target into this run's Secret would
  carry whatever the link names — another company's tree, a host path — into a value this run's pod
  can read. There is no projection that is both faithful and contained, so the operator re-points
  the link or vendors the file into the tree.

  A dangling link is the one case counted rather than refused, and deliberately: it delivers
  nothing to the pod today either, so stepping over it cannot be a delivery regression, while
  refusing would abort runs that currently work — a regression in the other direction.

  ⚠️ **The symlink refusals are reported but NOT cached, and the obvious reasoning for caching
  them is wrong.** An earlier draft of this change put them in the deterministic set alongside
  over-budget and too-many-files, on the claim that "`hashPathContents` hashes a link's target".
  It does not hash what these checks read: `prompt-cache.ts:190-204` hashes `symlink:<relPath>`
  and then the target's **contents** under the link's own relPath, so the resolved **path** —
  the only input the escape and cycle tests use — never enters `bundleKey`. Two retargets the
  key cannot see:

  * **Escape.** `link -> ../outside/a.md` refuses. The operator does exactly what the error
    message says and re-points it at an in-tree `a.md` with identical bytes. The hash is
    unchanged, so a cached refusal would replay for the life of the process against a tree that
    is now correct — and the reverse retarget would keep a cached `sized`, so a real escape
    would never be reported.
  * **Cycle.** `hashPathContents` keeps one **global** `seenDirectories`, so a revisited
    directory hashes as `dir:<rel>` + `loop` for a genuine cycle (`x/self -> x`) and for a
    lawful sibling link (`x/self -> y`, `y` hashed first) alike.

  Folding every resolved target path into `promptBundleSizingKey` would also fix it, but these
  trees are rare and re-walking one is cheap, so not caching is the cheaper correct answer.
  Changing `hashPathContents` is **not** an option — it would move `bundleKey` fleet-wide.
  `PromptBundleTooManyDirsError` is uncacheable for the same reason: directory blow-up is a
  property of the link graph, which is precisely what the key cannot see.

  **A directory-visit cap bounds the walk.** `PROMPT_BUNDLE_MAX_FILES` counts FILES, and keeping
  both copies of a lawfully duplicated directory means a chain of link-only directories
  (`d0/{l1,l2} -> d1`, …) expands as 2^depth directory visits while adding no files, slipping
  under the file cap entirely. `hashPathContents` walks that in linear time only because its
  seen-set is global, which this walk cannot borrow without reintroducing the silent drop the
  ancestor test exists to avoid. So `PROMPT_BUNDLE_MAX_DIRS` bounds it explicitly and refuses.

  **The `realpath` catch is narrow.** Only `ENOENT`/`ENOTDIR`/`ELOOP` count as dangling; any
  other errno (`EACCES`, `EIO`, a transient CephFS fault) is rethrown. A dangling count rides
  into a `sized` outcome, which **is** cached, so a blanket catch would remember one blip for
  the life of the process — the exact thing the cache refuses to do with a transient fault.

One further caveat on reading the cap as the ceiling: the Secret is one object among the Job's, and
etcd's request limit (~1.5 MiB by default) applies to the whole serialized object — keys, base64
expansion and metadata included. The usable headroom therefore sits slightly under the validation
cap rather than at it, which is a further reason the trigger is set at half.

It is wired into `execute.ts` as **measurement only**, and that restraint is deliberate rather than
unfinished. Nothing reads the projection yet; the pod still gets the bundle off the shared volume
and will until `dataClaimName` is swapped. Enforcing the refusal now would abort a run over a
budget that buys that run nothing — a pure regression — so the call site logs
`claude_k8s.prompt_bundle_projection_sized` and steps over every outcome, including the refusals.
The refusal becomes load-bearing in the same change that makes the pod read from the Secret.

The sizing is cached on the bundle key `prepareClaudePromptBundle` already computes (plus the
source paths, server mount and catalog set the projection filter reads, which the bundle key does
not cover). Without that, every run would pay a second full content read of the skill farm on the
Job-creation critical path — on the very CephFS mount whose stalls are this issue's subject —
purely to produce a log line. Only the measurement is retained, never the projected bytes.

**The two log shapes, for whoever writes the first query against them.** Both events are new in
this change and nothing consumes them yet, so there is no migration to do — but they are
deliberately not one shape, and a query that assumes otherwise will miss exactly the rows that
matter:

| event | fields |
|---|---|
| `claude_k8s.prompt_bundle_projection_sized` | `totalValueBytes`, `fileCount`, `binaryFileCount`, `resolvedSymlinkCount`, `danglingSymlinkCount`, `skippedNonRegularCount`, `maxBytes`, `escalationThresholdCrossed`, `bytesBySkillKey`, `sizingCacheHit` |
| `claude_k8s.prompt_bundle_projection_failed`, **refusal** | `errorName`, `refusal` (`{kind: "over_budget", totalValueBytes, maxBytes, fileCount, bytesBySkillKey}`, `{kind: "too_many_files", skillKey, limit}`, `{kind: "symlink_escapes_tree", skillKey, linkPath, resolvedTarget, treeRoot}` or `{kind: "symlink_cycle", skillKey, linkPath, resolvedTarget}` or `{kind: "too_many_dirs", skillKey, limit}`), `sizingCacheHit` |
| `claude_k8s.prompt_bundle_projection_failed`, **transient fault** | `errorName`, `error` (message string), `sizingCacheHit: false` |

Both `failed` shapes carry `companyId` and `runId` for the run **emitting** the line. The refusal
carries structured fields rather than a message precisely because it is cached and replayed: the
error's own message names the run that first hit it, so emitting that on a later run would put one
run's id beside another's in the same line. A dashboard counting refusals should key on
`refusal.kind`, not on `error`.

The over-budget and too-many-files **refusals are cached under the same key** as a success. They
are deterministic for a given key (which covers the content hash, the sources, the mount and the
catalog set, against constant thresholds), and caching only successes would leave exactly the
largest bundles — the ones this measurement exists to find — re-reading the whole skill farm on
every run forever. A transient I/O fault is deliberately *not* cached: remembering one would
suppress the measurement for the life of the process on the strength of a blip.

What that buys ahead of the swap is the one thing Finding 3 could not get: this sizing is from a
single company because an agent seat cannot enumerate them, so **the fleet distribution against the
50 % trigger is unmeasured**. Emitting the projected per-run size on real traffic measures it,
which is what the decision means by choosing a trigger that fires "against a measurement rather
than under an outage".

**Landed 2026-10-30 — property 2, the in-pod rebuild.**
`vendor/paperclip-adapter-claude-k8s/src/server/prompt-bundle-materialization.ts`
(`buildPromptBundleMaterializationShell`) emits the step that turns the projected Secret back into
the bundle tree inside the pod: for each path the projection declared, drop any symlinked ancestor,
then `cp -L` it out of the Secret mount into the bundle root.

Like the projection before it, **nothing calls it yet** — the Job does not mount the prompt-bundle
Secret and the pod still reads the bundle off the shared volume, as it will until `dataClaimName`
is swapped. Staging a Secret per run that nothing reads is a cost that buys that run nothing, which
is the same restraint, for the same reason, that kept the projection measurement-only.

Three of its properties are the **opposite** of `buildSharedDocOverlayShell`, which solves the same
shape of problem and is the model for the Secret staging. Each inversion is forced by what the
failure costs, and each is pinned by a test that fails when the property is removed:

| | shared docs (PEN-3329) | this step |
|---|---|---|
| a declared file is not delivered | reported on stderr, step ends `true` | **exits non-zero** — the pod fails to start |
| a destination already exists | kept; the step fills absences only | **overwritten** |
| an ancestor is a symlink | stepped over | **removed** and reported |

The first inversion is the one that matters. A shared doc that does not arrive costs the run some
documentation; a skill file that does not arrive is invisible from inside the run — the agent simply
does not have the skill — which is this channel's whole failure mode. The decision above already
states the preference ("a `Pending` pod with an event, not a partially-populated tree"); this is
where it is spent. The second follows from the bundle root being content-addressed by `bundleKey`:
anything already at a destination is either byte-identical or the residue of a half-finished
attempt, so overwriting makes the tree a function of the Secret alone, which is the invariant the
swap needs. The third follows from ownership — the pod owns the bundle root, and a symlink at
`.claude/skills/<runtimeName>` is precisely the pre-swap farm entry the swap exists to retire, so
stepping over it would preserve the dangling link. `-L` is tested rather than `-e`, so a *dangling*
ancestor, the shape the swap actually produces, is caught as well as a live one.

`cp -L` rather than a plain copy, because a Secret volume is an atomic-writer layout: every
projected path is a symlink into `..data/<key>`, itself a link to a timestamped directory. A copy
preserving links would leave the bundle root correct only while that mount exists — the same class
of fault as the server-written farm. And the step copies exactly the declared paths, never walking
the mount root, so the Secret's own `..data` bookkeeping cannot reach the bundle.

Path safety is decided in TypeScript (`isSafeBundlePath`), not defended against in shell: every path
reaching the step comes from the projection's own `items[].path`, so an unsafe one is a bug in this
channel rather than hostile input, and the builder throws rather than emitting a step that silently
drops it. A shell guard would also have to be correct under every `sh` the image might ship.

**What is left before the swap** is now the swap itself: mount the Secret on the Job, point the
bundle root at the in-pod tree, stop the server writing the farm, and move `dataClaimName` to a
per-agent claim. Done-when 1 is unmet until that lands.

⛔ Unchanged and still refused: a shared read-only claim (§2). It is one volume ID on every agent
pod on the node, taking the same ceph-csi lock through the same `NodeUnstageVolume` path, and it
would defeat this issue's own acceptance criterion.


## 5. Decisions taken, and what is still genuinely open

**State of the five 4b invariants, updated 2026-10-31** (detail in §4). All five are now closed on
`master`; **none of it is observable on the fleet**, because all five stay inert until an agent is
opted in to the `dataClaimName` swap — which, as of 2026-10-31, is itself merged but default-off:

| invariant | state |
|---|---|
| 1 — populate/relocate the server-materialized trees (incl. the prompt bundle) | **closed** — #3153 / #3157 / #3158, last merged 20:19:43Z. Inert until the swap, by design. |
| 2 — symlinked-PARENT hole in the seeder | **closed** — #3161, merged 19:51:15Z |
| 3 — directory MODE | **closed** — #3165, merged. `mkdir -m 2775 -p`, as recommended; a separate `chmod` stays unexecutable (no `CAP_FOWNER`), and busybox's `make_directory.c` `goto ret0`s on `EEXIST` at the final component *before* its `chmod`, so an existing 1000-owned target is never chmodded. Subsumed by invariant 4's split exactly as predicted: as uid 1000 the seeder owns what it creates, so the mode needs no privilege. ⚠️ Still converges only targets the seeder creates, and the CephFS fresh-subvolume question remains **unmeasured** — no per-agent claim exists to measure against |
| 4 — guard is check-then-act under concurrent same-agent runs | **closed** — #3165, merged, the recommended split: uid 0 chowns the volume ROOT only (one inode, no in-volume path components, so no TOCTOU), everything else runs as uid 1000, which *removes* the privilege boundary rather than hardening the race across it. Available only because stage 3b-iii left `readOnlySubPaths` empty — now enforced as a build-time throw, not a comment. `fsGroup`, the post-`mkdir` re-check and run serialisation remain ruled out. ⚠️ **"Must ship WITH the swap, never before it" is WITHDRAWN** — the premise was unchecked and false; the reachability argument in §4 carries that on its own, and the second reason first recorded beside it does not (it tests "is this the server's claim", not "is this claim one agent's"). See §4. It shipped ahead of the swap, and is inert on the fleet by measurement (every agent Job over 7d names the server's own claim), not by construction. ⚠️ The root `chown` on a real CephFS subvolume is still **unexecuted**; fd-relative `openat` walk remains the fallback |
| 5 — the POD LOG crosses the volume in the read direction | **closed on `master`, UNVERIFIED on a real run** — #3173 (framing) merged 08:41:30Z, #3174 (collector) merged 10:27:27Z. The container wrote `containerLogPath` while `execute.ts` tailed `podLogPath`: one string on the default mount, two VOLUMES once the claim is per-agent, so `tailPodLogFile` threw and the run's stdout was empty. Found 2026-10-31 while writing the swap, which is why the swap landed gated rather than enabled. The obvious fix — keep `run-logs` as a `subPath` of the SERVER'S claim — was refused for §2's reason: one bind on the shared handle, the whole cost of the swap for zero blast-radius reduction. Taken instead: on a foreign claim the fail-fast `awk` keeps its stdout and stamps each line, and `collectPodLogStream` reads those frames back off the container log and persists them to the server's own `podLogPath`, so the belt-and-braces re-read and the reaper still find what they expect. The file tail remains the implementation on the server's own claim, held there by a negative control. ⚠️ **Closed is not verified** — PEN-5120's first done-when wants a real foreign-claim run producing parseable stdout, and none has happened; what changed is that the failure is no longer structural. Residuals recorded, not fixed: PEN-5124 (the orphan reader still resolves `run-logs` from the SERVER'S root) and PEN-5138 (three hardening items on the collector). See §4 stage 4b |

**PEN-4932's four done-when items, measured from inside a live agent pod 2026-10-30T21:4xZ**
(`findmnt`, this run's own pod on `k8s-paperclip-3`):

| done-when | state |
|---|---|
| 1 — two agent pods on one node report **distinct** volume IDs | **UNMET, and no longer blocked — the gate is now turnable-on and unproven, which is a different state from blocked.** The swap LANDED 2026-10-31 behind the default-off `enablePerAgentWorkspaceVolume` gate (§4 stage 4b), and invariant 5's collector landed the same day, so enabling it no longer empties the run's stdout by construction. Nothing has yet run on it, and the toggle's own hint says so. The last fleet read still shows one handle, `csi-vol-3bdd0e68-1704-4f81-b3d8-55920cabf82c`, which is the correct reading of a gate nothing has opted into. After invariant 5: the server rolled onto that commit, ≥2 agents opted in through `adapter_config`, and a `findmnt` read from inside two live pods **co-located on one node**. Do not record this as met off a merge. |
| 2 — the fleet-wide tooling row is a separate read-only claim **or** baked into the image, with the choice recorded | **MET on `master`, NOT YET OBSERVABLE in the fleet.** Choice: **baked into the image**, reasoned in §3.3-§3.6. |
| 3 — recurrence re-measured against the 3-wedges-in-30h baseline, caveats stated | not started, and **it cannot be done before 1** — the measurement is of the swap's effect, and a gate nobody has opted into produces no effect to measure. Note the two caveats §4.1 attaches to the baseline survive into the re-measure and must be stated rather than glossed: Prometheus retains ~7 days, not 30, and counter resets on the agent-heavy nodes hide history. |
| 4 — this §5 acceptance table updated to reflect 1 being met | blocked on 1, by construction. This row is the one that must NOT be ticked on the strength of the swap landing. |

**Done-when 2, measured rather than asserted.** Six of the issue's seven fleet-wide paths are now
**absent outright** — `/paperclip/bin`, `/tools`, `/jre`, `/paperclip/.local/bin`,
`/paperclip/.bun/bin`, `/paperclip/.cache/puppeteer-browsers` do not exist in the pod, and the
binaries behind the PATH entries resolve into the image (`/usr/local/libexec/paperclip/bin/git`,
`/usr/local/libexec/paperclip/bin/gh`, `/usr/local/bin/node`). `/paperclip` itself is no longer a
bind host for the PVC root at all: it is the `root-overlay` **emptyDir**.

⚠️ **The bind COUNT is per-pod, not a fleet figure** — it varies with the agent and the run, since
the set includes that agent's home, prompt-cache, run-logs and company skills. The count below is
**this pod** (agent `29033747`, `isolation-mode=workspace`, on `k8s-paperclip-3`): **12**, against
the ~18 this issue recorded on 2026-10-28. Review independently measured **8** in a different
agent's pod on the same deployed commit, with the same single handle and the same `ro` git-hooks
bind — so a future re-measure finding a different number is reading a different pod, not a
regression or a gain. The invariant to re-measure is the **set** (which paths are bound, off how
many handles), never the count.

⚠️ **The seventh is still there, and the reason is deploy skew, not a second code path.**
`/paperclip/.local/share/paperclip-git-hooks` is still mounted, `ro`, off the shared handle. That
is exactly the `ROOT_TOOLCHAIN_SUBPATHS` shape, and `master` has that list empty — because the
running server predates the change. The StatefulSet's `deployed-commit` annotation reads
`86bfe2a2` (2026-10-30 06:46:35Z); #3139 landed as `56710069` (08:50:27Z, merged 09:07:31Z), and
`git merge-base --is-ancestor` confirms the deployed commit is an ancestor. **So this bind drops
out on the next server roll, with no further code change** — 12 → 11 in *this* pod, and one fewer
in any pod. Do not read the live mount as evidence
that #3139 did not land, and do not re-open the item on the strength of it; equally, do not record
done-when 2 as delivered end-to-end until a post-roll pod is re-measured.

⚠️ **The acceptance criterion is UNMET and none of the above moves it.** Done-when 1 — *two agent
pods on one node reporting distinct volume IDs* — is the `dataClaimName` swap itself, which is
still downstream of invariants 3 and 4. Every agent pod continues to mount `paperclip-data`, so
ceph-csi lock exposure is unchanged from the day this issue opened. The work so far is
prerequisite removal, and should not be read as partial delivery of the criterion.

Both questions this document originally raised are **resolved**, and neither needed a preference
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

**The 4b delivery channel — resolved 2026-10-30 (§4.2).** A **Secret projection**, on PEN-3329's
precedent, carrying the **run's resolved skill entries** (not `skills/<companyId>`: project-scan
`local_path` sources sit outside the managed tree and a company-tree projection would omit them);
the prompt bundle's symlink farm is rebuilt in-pod from it rather than shipped. The init-container
API fetch is the named escalation, triggered at 50 % of the Secret cap measured on the projected
per-run size — today's single measurable company projects to 12.4 % (decoded bytes, the quantity
the API server enforces; an earlier 16.8 % measured base64), which is a sample of an
unbounded quantity and not headroom, since the only size constant in the skills path is a per-file
hard stop equal to the whole budget that bounds neither file count nor tree size.

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
