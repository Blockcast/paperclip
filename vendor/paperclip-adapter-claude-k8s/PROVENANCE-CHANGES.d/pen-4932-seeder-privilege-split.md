# PEN-4932 — split the seeder so the only root container touches one inode (stage 4b, invariants 3 and 4)

`src/server/job-manifest.ts`. The seeder now has **two shapes**, chosen by
whether the Job's `data` claim is the server's own:

| claim | init containers | uid | what it does |
|---|---|---|---|
| the server's own (every Job today) | `seed-writable-dirs` | 0, `CHOWN`+`DAC_OVERRIDE` | **unchanged**: guard walk, `mkdir -p`, `chown -h 1000:1000` |
| a per-agent claim (stage 4b) | `own-volume-root`, then `seed-writable-dirs` | 0 `CHOWN` only, then **1000** `drop: ALL` | `chown` of the mount point; then guard walk + `mkdir -m 2775 -p`, **no chown** |

No per-agent claim exists yet, so the second shape is unreachable in production
and this change is inert on the fleet. It ships ahead of the `dataClaimName`
swap so that the swap is a claim change rather than a claim change plus a
privilege-model change.

## Invariant 4 — the guard → `mkdir` → `chown` window

The window is real and both halves are exposed: a writer that swaps a parent
component for a symlink between the guard and the act gets root `mkdir` at a
route it chose and a root `chown` handing uid 1000 a directory it chose. Nothing
can take it today, because init containers are sequential and on the server's own
claim no pod can reach another agent's subtree.

That argument is **pod-scoped**, and a per-agent claim dissolves pod scope: the
concurrent writer becomes a uid-1000 agent container in a different pod, possibly
on a different node, sharing the claim. Read live 2026-10-30 — two agents each
held 2 concurrent run pods and one pair spanned two nodes, which is also why a
per-agent claim has to stay ReadWriteMany.

**The remedy removes the boundary rather than hardening the race across it.** A
re-check between `mkdir` and `chown` is itself check-then-act: it shortens the
race without closing it. An fd-relative `openat(…, O_NOFOLLOW|O_DIRECTORY)` walk
would close it but cannot be expressed in `sh`, so it means moving the seeder out
of shell — kept as the fallback if the root `chown` does not land on CephFS.

After the split, the only uid 0 left is `own-volume-root`, whose single argument
is the **mount point**. There are no path components inside the volume to swap,
and a mount root cannot be replaced from inside the volume, so that operation has
no TOCTOU to lose. The container that walks paths runs as uid 1000 — the same uid
as the writers it races — so a symlink planted there buys the planter nothing it
could not do directly.

This is available only because stage 3b-iii emptied `ROOT_TOOLCHAIN_SUBPATHS`:
`readOnlySubPaths` derives to `[]`, so `seedSubPaths === writableSubPaths` and
nothing the seeder touches needs to stay root-owned. Re-adding a root-owned
read-only subPath would have to re-open this, not ride it.

`DAC_OVERRIDE` is dropped from `own-volume-root` because uid 0 chowning a
`root:root` fresh-volume root matches the owner. `seed-writable-dirs` reaches PSS
**restricted** on this shape.

## Invariant 3 — the directory mode, and why it is `mkdir -m` and not `chmod`

The seeder set no mode, so its dirs inherited its umask (0755) where the
server-side pre-creation path got `2775` from its parent. Moot while the targets
already exist; a real regression on a genuinely fresh volume, which is exactly
what a per-agent claim is. `2775` is load-bearing rather than cosmetic: the
`github-publish-broker` sidecar runs as a **different uid** with
`runAsGroup: 1000`, so it reaches these trees by group, and setgid is what keeps
gid 1000 on everything created inside them afterwards.

It must not be a `chmod`. `chmod(2)`'s owner-match check is gated on
**CAP_FOWNER**, which CAP_DAC_OVERRIDE does *not* cover and which nothing in this
Pod holds. On a **persistent** per-agent volume the targets already exist
1000-owned from a previous run, so a chmod issued by a uid-0 container would be a
non-owner chmod → `EPERM` → `set -e` → the Job never starts. Ordering it before
the chown does not help.

busybox `mkdir` does not have that problem, and this is the guarantee the change
rests on: `libbb/make_directory.c` `goto ret0`s on `EEXIST`/`EISDIR` at the
**final** component *before* reaching `chmod(path, mode)`, so the only chmod it
ever issues is on a directory it just created and therefore owns. Intermediates
are created under `umask & ~0300` and do **not** carry `-m` — 0755, 1000-owned,
traversable by the broker and writable by their creator.

⚠️ coreutils agrees on both points, so the execution test added here is
**corroboration, not proof**: the image is `busybox:1.36` and busybox's source is
what was read.

## Why the server's own claim keeps the old shape — a constraint, not caution

The shared volume carries **root-owned intermediate directories** from every past
uid-0 run. `mkdir -p a/b/c` creates `a` and `b` under the container's umask as
`root:root 0755` and the chown touches only the leaf `c`. A later run needing a
new sibling inside one of them — a fresh `run-logs/<c>/<a>/isolated/<key>` under
an existing agent log dir is the routine case — can only create it as root with
`DAC_OVERRIDE`. A uid-1000 `mkdir` there EACCESes under `set -e` and the Job never
starts.

A per-agent volume has no such residue: `own-volume-root` hands its root to uid
1000 and every component beneath it is then created by uid 1000, so the tree is
1000-owned by construction. The corollary is a rollback hazard worth naming —
seeding a per-agent claim with the old shape even once leaves root-owned
intermediates that the new shape cannot then create inside.

## Tests

`src/server/job-manifest.test.ts`, new describe *"a claim the server does not
hold (stage 4b)"*: container count and order; `own-volume-root`'s command pinned
byte-for-byte to one mount-point argument with no `-R`; `CHOWN` only, no
`DAC_OVERRIDE`, no `FOWNER`; the seeder at uid/gid 1000 with `drop: ALL`, no
added capabilities and **no `chown` substring at all**; `mkdir -m 2775 -p` present
and `chmod` absent; the containment walk still executed against a real tree with a
symlinked parent; a two-run execution test proving a deliberately wrong `0700`
mode **survives** the re-run, which is the observable form of "issues no chmod";
and a negative control asserting the server's own claim still produces one
uid-0 container with `chown -h` and no `-m`. `own-volume-root` is asserted to be
the only root container on a per-agent claim.

The existing *"narrows a claim that is NOT the server's own"* case is updated from
`runAsUser === 0` to the two-container shape.

Full adapter suite 29 files / 1839 tests green; `tsc --noEmit` clean.

## Not in this change

The swap itself — provisioning the per-agent PVC and pointing `dataClaimName` at
it — and making the pod read the prompt bundle from the projected Secret. The
issue's acceptance criterion (two agent pods on one node reporting distinct
volume IDs) is **not** met here.

The plan's §4 invariant list is **not** updated here: #3164 is in flight against
`docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` and rewrites exactly the
two invariants this change closes, so editing it from this branch would be a
guaranteed conflict for no benefit. This file is the record until that lands;
the §4 update follows on top of it.
