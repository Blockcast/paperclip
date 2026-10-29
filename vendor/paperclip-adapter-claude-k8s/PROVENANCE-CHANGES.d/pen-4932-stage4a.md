# PEN-4932 — seed `subPath` targets from inside the pod (stage 4a)

`src/server/job-manifest.ts`: the BLO-32734 narrowing gate loses its
"…and the Job's claim is the SERVER'S OWN PVC" conjunct, and the Job gains a
`seed-writable-dirs` init container that creates and chowns the `subPath`
targets itself.

## Why the conjunct was there, and why it can go

The nested rw `subPath` mounts need their target directories to exist, owned by
uid 1000, *before* any container mounts them: without `fsGroup` the kubelet
creates a missing `subPath` dir as `root:root 0755` at the moment the container
that mounts it starts, and uid 1000 then EACCESes. The only thing that could
create them was the server, through its own `/paperclip` mount
(`scopedWritableDirs`) — which lands in the Job's volume **only when both name
the same claim**. So any other backing had to keep the broad rw mount.

`seed-writable-dirs` removes the dependency rather than working around it. It
runs as uid 0, first in `initContainers`, mounts the data volume at its **root**
with no `subPath` of its own, and does `mkdir -p` + `chown 1000:1000`. Creation
no longer needs a second process holding the same volume, so the gate no longer
has to ask whose volume it is.

**This is the precondition for stage 4b, and on its own it moves ceph-csi lock
exposure by zero.** Exposure scales with pods × volume and every agent pod still
mounts `paperclip-data` after this change. The issue's acceptance criterion —
two agent pods on one node reporting distinct volume IDs — is **not** met here
and cannot be until the per-agent claims exist.

## Three details that are load-bearing rather than stylistic

**Ordering.** The seeder is `initContainers[0]`. Init containers run in
declaration order, and `write-prompt` mounts every one of these targets as a
`subPath` — so a seeder running after it would find them already created
`root:root` and would be pointless. Pinned by a test that asserts the index, not
merely the presence.

**The seeder mounts the volume root, with no `subPath`.** Mounting a `subPath`
is exactly what triggers the root-owned creation this container exists to
prevent, so a seeder that used one would cause the problem it solves. It gets
its own mount path (`/mnt/paperclip-data-seed`) rather than `dataMountPath`, so
it cannot collide with an operator-chosen `workspaceMountPath` or shadow an
inherited secret mount.

**`scopedWritableDirs` keeps the old gate, under its own name
(`serverCanPreCreate`).** This is the one place the two conditions must *not* be
merged. Those paths are joined onto `SELF_POD_DATA_MOUNT_PATH`, so handing them
out for a claim the server does not hold would `mkdir` a foreign Job's tree
inside the **server's own** volume — junk the Job never sees, while the targets
that actually needed creating stayed uncreated. It is now empty for a foreign
claim, and the seeder covers that case. The server-side loop survives only as
the cheaper path for the server's own PVC, where creating through the 2775
setgid mount inherits ownership.

## `fsGroup` was rejected with measurement, not instinct

The textbook answer to "fresh volume, wrong ownership" is `fsGroup` +
`fsGroupChangePolicy: OnRootMismatch`. `deploy/helm/paperclip/values.blockcast.yaml:520-530`
(onprem-k8s #225) already rejected it: on cephfs the short-circuit **does not
reliably fire**, so the kubelet runs a recursive chown over the whole volume on
every pod mount and each rollout grinds 30-45 min against the ~2M-inode shared
tree. Per-agent volumes shrink that tree but not enough — measured 2026-10-29,
one company's subtree is 231,892 inodes (`wt/` 115,450, pnpm 66,217, project
checkout 50,225), i.e. ~11.6% of the figure behind the 30-45 min grind, so
roughly 3.5-5 min of chown on every pod start for a Job expected to start in
seconds. Both caveats push the same way: it is one company, and worktree count
grows, so that is a floor. The seeder is O(skeleton) — a fixed handful of
`mkdir`s whatever the volume holds — and is the pattern the chart itself names
as the reason `fsGroup` is unnecessary ("the seed initContainer already does
targeted chowns of the paths it writes").

## A foreign claim is narrowed now, and warned about

`config.workspaceVolumeClaim` already lets an operator point a Job at a claim
that is not the server's. Before this stage such a Job fell back to the broad rw
mount; it is now narrowed and seeded like any other. The seeder creates every
`subPath` target, so the Job starts — but two of those targets are materialized
by the SERVER, and only ever into the server's own volume, so on a foreign claim
they come up EMPTY: `.local/share/paperclip-git-hooks` (every push then fails
closed, BLO-48361) and `skills/<companyId>` (the prompt bundle's skill links
dangle). Both fail in the safe direction and both fail a long way from the
cause, so `buildJobManifest` now logs `claude_k8s.data_claim_foreign` naming the
unpopulated subPaths. Stage 4b must either materialize them into the per-agent
claim or move them into the image (§3.6 already proposes the latter for the
hooks dir).

## `foreign_claim` is now unreachable

`broadDataMountReason` drops to `isolation_disabled | no_claim`. Left asserted
as an absence rather than silently deleted: if it ever came back, **every**
per-agent Job would log `claude_k8s.data_mount_broad_rw` and carry a Job
annotation saying the BLO-32734 narrowing was skipped — permanently, on the very
change that makes the narrowing work.

## Privilege

The seeder is the only root container in the Pod and takes the narrowest root
the job allows: `drop: ["ALL"]`, `add: ["CHOWN", "DAC_OVERRIDE"]`,
`readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`. It is
strictly less privileged than the `dind` sidecar this Pod already admits
(`privileged: true`), so it needs no new PSA allowance.

`DAC_OVERRIDE` is required, not defensive. uid 0 with `CAP_DAC_OVERRIDE`
dropped is an ordinary DAC subject: under a parent owned by uid 1000 it matches
neither owner nor group and falls to the `other` bits, which are `r-x` for both
modes in play (kubelet-created `0755`, server-created `2775`). `mkdir` of a
not-yet-existing child under such a parent would `EACCES`, and `set -e` would
fail the init container, so the Job would never start. That is reachable on an
existing config path — `config.workspaceVolumeClaim` already lets an operator
point a Job at a foreign claim, which this stage newly narrows — and it is the
normal case in 4b, where a per-agent volume accumulates 1000-owned trees and
any later target nested under one hits it. It is NOT reachable on the self
claim, where the server pre-created every target and `mkdir -p` no-ops on
`EEXIST`, so the fleet exercise above cannot surface it; a test pins the
capability instead. `DAC_OVERRIDE` is inside the PSS *baseline* allowed set, so
the baseline-clean claim is unchanged.

The seeder also refuses a target whose final component is already a symlink, and uses
`chown -h`. Both `mkdir -p` and a bare `chown` follow symlinks, and this is the one
process in the Pod holding uid 0 over the volume root — so a link planted at a target
path by a uid 1000 writer would redirect a root `chown` onto its referent, the sharpest
case being a link aimed at the git-hooks dir, which would hand uid 1000 the PEN-3156
pre-push guard the explicit no-chown below exists to protect. Not reachable on this head
(`resolveScopedWritableMounts` drops nested targets, and a narrowed pod has no path to
another agent's subtree) and not reachable on the self claim; it becomes reachable in 4b,
where a per-agent volume persists across runs whose target sets differ. A symlinked
**parent** component is NOT covered — closing that needs a per-component walk, recorded as
a 4b invariant in `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` §4 rather than
guessed at here.

`FOWNER` was dropped in the same change. It bypasses the owner-match check on
`chmod`/`utimes`, and neither syscall this container makes needs it: `chown` is
covered by `CAP_CHOWN`, and `mkdir -p` chmods only a directory it just created
itself, and only when given `-m`, which it is not. `podSecurityContext`
stays `runAsNonRoot`, and a test asserts no other container runs as uid 0. The
read-only git-hooks bind is `mkdir`ed but deliberately **not** chowned: uid 1000
being unable to rewrite the PEN-3156 pre-push hook is the boundary the publish
broker depends on.

## Tests

`src/server/job-manifest.test.ts` — a new `seed-writable-dirs (PEN-4932)` block
(ordering, root-mount-with-no-subPath, mkdir/chown split, security context,
omission when not narrowed), plus two rewritten cases that previously pinned the
*old* behaviour: "keeps the broad rw mount when the Job's claim is not the
server's own PVC" now asserts it narrows and seeds, and the `foreign_claim`
reason-code case now asserts the reason is unreachable.

Verified in both directions — each of five deliberate breakages fails exactly
its own guard and nothing else: seeder moved after `write-prompt`; the old
self-claim gate restored; `chown` widened to cover the read-only hook bind;
`scopedWritableDirs` re-gated on `narrowWritableSurface`; and the seeder given a
`subPath` of its own. Full adapter suite 26 files / 1710 tests green.

Test-only churn worth naming: `initContainers[0]` meant `write-prompt` in 28
places across two test files and now resolves to the seeder on narrowed runs, so
those sites address the container by name. Mechanical, and it removes a
positional assumption that was never guaranteed.

## Not in this change

Stage 4b: provisioning a per-agent RWX claim (`createPvc` in `k8s-client.ts` is
the in-tree precedent, via `opencode-db-<agentId>`) and pointing `dataClaimName`
at it, with the claim lifecycle, sizing, and the cold-start cost of a first-run
`pnpm` install and project checkout per agent. Also unchanged: `paperclip-data`
is an `existingClaim` managed out of onprem-k8s, so per-agent claims have to be
created dynamically by the server rather than templated into the chart.
