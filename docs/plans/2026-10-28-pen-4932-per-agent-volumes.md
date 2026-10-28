# PEN-4932 — Give agent pods per-agent volumes instead of one shared CephFS RWX PVC

Status: in progress. Stage 1 (bake the fleet-wide toolchain into the image) started by this
change. Implements direction (a) decided in PEN-3199 /
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
| `kyverno` (258 MB), `trivy` (168 MB), `promtool` (142 MB), `alertmanager` (37 MB), `amtool` (31 MB) | **DECIDE** | ~640 MB on every agent image. Needs an explicit size/usage call — see §5 |
| `cmake`/`ccmake`/`cpack`/`ctest`, `wasm-pack`, `scapy`, `yamllint`, `pytest`/`py.test`, `pdfplumber`, `pdf2txt.py`, `dumppdf.py`, `pypdfium2`, `jsonschema`, `openapi-spec-validator`, `dotenv`, `idna`, `normalizer`, `pygmentize` | **DECIDE** | Mostly Python entry-point shims whose `site-packages` tree is *not* itself in `ROOT_TOOLCHAIN_SUBPATHS`; several are likely already broken in the same way `swift` is. Verify before baking — do not bake a shim whose target was never reachable |
| `.local/share/paperclip-git-hooks/pre-push` | **RELOCATE** | Server-written state, not tooling. Needs a non-PVC delivery (ConfigMap or image + `core.hooksPath`), not a bake |
| `tools/kexec.py`, `tools/openapi-generator-cli.jar`, the three tarballs | **DROP** | Ad hoc; no caller identified |

## 4. Staging

1. **Bake the unambiguous gaps.** `yq`, `bun`/`bunx`. *This change.* Zero fleet risk: adding a
   binary to the image cannot break a pod while the PVC still shadows it.
2. **Resolve §3.3 `DECIDE` and `RELOCATE` rows.** The size call on the ~640 MB observability/scanner
   set, and a non-PVC home for `pre-push`.
3. **Remove `ROOT_TOOLCHAIN_SUBPATHS` from the Job spec.** Only after 1–2; this is the step that
   actually retires the cross-agent mount.
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

## 5. Open questions for the issue owner

- **The ~640 MB set** (`kyverno`, `trivy`, `promtool`, `alertmanager`, `amtool`). Bake all, bake
  some, or move to on-demand install? Every agent image pays for whatever is baked.
- **Python-shim rows.** Confirm whether any currently resolve; those that do not should be dropped
  like `swift` rather than reconstructed.
- **Company-scoped sharing.** `/work/<companyId>`, `/wt/<companyId>`, the pnpm store and
  `skills/<companyId>` are namespaced by path but *are* read by every agent of the same company.
  Per-agent volumes duplicate them. That is believed acceptable (and retires the BLO-19422 shared
  checkout hazard) but it is a behaviour change, not a pure re-plumbing, and should be acknowledged
  before stage 4.

## 6. Not in scope

Alerting on `rbd_wedge_csi_op_age_seconds{op="unmount"}` — PEN-4932 separates it deliberately; it
belongs in `deploy/observability/prometheusrule.yaml` in `penstock-llm-proxy-core`.
