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
(`job-manifest.ts:632`) — `bin`, `tools`, `jre`, `.local/bin`, `.local/share/paperclip-git-hooks`,
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
(Helm seed, egress runtime, Job manifest, preflight in both vendored adapters). Getting it wrong
either re-creates the 2h17m outage or, worse, leaves `core.hooksPath` pointing at a directory
holding no hook, which fails *open*: pushes succeed, unscanned. It belongs in stage 3 with its own
review, moving all four consumers together.

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

**3. `.cache/puppeteer-browsers` is already unreachable.** `PUPPETEER_CACHE_DIR` and
`PUPPETEER_CONFIG_DIR` are both `/opt/puppeteer` — an image path, not this mount — so nothing
resolves a browser through the PVC. The mount holds Chrome `linux-149.0.7827.54`: the same stale
149 §3.2 identifies as the PEN-4682 hazard. Dropping it removes a copy nothing reads.
⚠️ Noted in passing and explicitly **not** this issue's to fix: `/opt/puppeteer` does not exist in
the image either, so both variables point at nothing. That is pre-existing and orthogonal to the
mount; it is recorded here only so the next reader does not mistake it for stage-3 fallout.

**4. Only `bin` and the hooks dir are reachable at all.** Re-confirmed against the live `PATH`: of
the seven `ROOT_TOOLCHAIN_SUBPATHS` entries, only `/paperclip/bin` is on `PATH` (position 7, ahead
of `/usr/local/bin` at 9). `.local/bin` and `.bun/bin` are mounted but absent from `PATH`; `tools`
and `jre` are data directories; `.local/share/paperclip-git-hooks` is reached through
`core.hooksPath`, not `PATH`. So the entire behavioural surface of stage 3 is `bin` (unshadowing,
§3.3) plus the hook (relocation, §3.6).

> ⚠️ **This does not make a partial stage 3 worth doing.** Five of the seven subPaths are
> unreachable, which makes "remove just those five" look like a safe down-payment. It buys
> **nothing**: every subPath binds the *same* volume handle (`csi-vol-3bdd0e68-…`), and ceph-csi's
> `IDLocker` keys on the handle, not the bind. Blast radius falls only when the last bind to that
> handle goes — so a partial removal reduces mount count while leaving lock exposure exactly where
> it was. Stage 3 is whole or it is nothing.

## 4. Staging

1. **Bake the unambiguous gaps.** `yq`, `bun`/`bunx`. *Done.* Zero fleet risk: adding a
   binary to the image cannot break a pod while the PVC still shadows it.
2. **Resolve §3.3 `DECIDE` and `RELOCATE` rows.** *Done — §3.5 and §3.6.* Every entry in
   `ROOT_TOOLCHAIN_SUBPATHS` now has a disposition backed by a measurement rather than a
   preference. `wasm-pack` is baked here, which completes the BAKE set **except** the `pre-push`
   hook, deliberately deferred to stage 3 (§3.6) because it is a security control with a
   four-consumer join and a fail-*open* failure mode.
3. **Remove `ROOT_TOOLCHAIN_SUBPATHS` from the Job spec**, and move the `pre-push` hook into the
   image in the same change. Only after 1–2; this is the step that actually retires the
   cross-agent mount, and the first step that can break a running agent.

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

   ⚠️ That bump step has a known **silent** failure mode, and it is the last link in the chain so
   nothing downstream recovers it. BLO-33382 records a ~30 s `paperclip-api` restart returning 503
   and permanently dropping the bump for three consecutive commits: images built, smoke-tested and
   promoted to Harbor, cluster refs never advancing, `pending_image_bump` left null so nothing
   retried. **Verify the deployed ref; do not infer it from a green build.**
4. **Per-agent claim.** Swap `dataClaimName` (`job-manifest.ts:2666`) to a per-agent PVC, following
   the existing `opencode-db-<agentId>` precedent (`paperclip.io/pvc-type=agent-db`).
5. **Demonstrate and re-measure.** PEN-4932's acceptance criterion.

### 4.1 The blocker stage 4 has to clear

`dataClaimName = envWorkspaceClaim || selfPod.pvcClaimName || ""` — every agent Job inherits the
*server's own* claim. The `narrowWritableSurface` gate then requires
`dataClaimName === selfPod.pvcClaimName`, because the `subPath` targets are pre-created by the
server through its own mount. A per-agent claim is by definition a volume the server does not
hold, so it takes the `foreign_claim` branch and falls back to a broad rw mount.

That is not merely a gate to satisfy — note it **inverts**: the BLO-32734 narrowing exists because
one volume is shared by every company and agent, and the mount is the only thing that can scope it.
A per-agent volume is scoped by construction, so the ~14 `subPath` binds have nothing left to
narrow and collapse to a single mount. Stage 4 should delete that machinery for per-agent claims,
not satisfy it.

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
  change spans four consumers across two repositories and fails open if botched.

Still genuinely open, and the one item that does need an owner:

- **Company-scoped sharing.** `/work/<companyId>`, `/wt/<companyId>`, the pnpm store and
  `skills/<companyId>` are namespaced by path but *are* read by every agent of the same company.
  Per-agent volumes duplicate them. That is believed acceptable (and retires the BLO-19422 shared
  checkout hazard) but it is a behaviour change, not a pure re-plumbing, and should be acknowledged
  before stage 4.

## 6. Not in scope

Alerting on `rbd_wedge_csi_op_age_seconds{op="unmount"}` — PEN-4932 separates it deliberately; it
belongs in `deploy/observability/prometheusrule.yaml` in `penstock-llm-proxy-core`.
