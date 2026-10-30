# PEN-4932 — split the seeder guard's conflated containment test, and record the 4b residue

Follow-up to `pen-4932-seeder-component-walk.md` (#3161), taking the two
non-blocking review findings Ally raised on it. No behaviour change: one test
file and one comment block.

## 1. The "outside the volume root" property was asserted but never exercised

#3161's termination test rewrote the guard with

```js
guard.replaceAll("'/mnt/paperclip-data-seed/", "'/nowhere/")
```

and asserted `stderr` contained `is not under the volume root; refusing`. That
assertion reads as *"a target outside the volume root is refused"*. It does not
establish it.

The volume root appears **three** times in the generated guard — in the
`for p in …` target list, in the containment `case` pattern, and in the `while`
sentinel. The rewrite moves the first two together (both carry a trailing
slash) and leaves the third (it does not). So under that rewrite **no target is
ever outside the root the guard is checking against**: the targets are at
`/nowhere/…` and the `case` is checking for `/nowhere/…` too. The walk descends
the whole path and is stopped only when it reaches `/nowhere`, which fails its
own `'/nowhere/'*` pattern — the LOOP BOUND, not containment of an escaping
target. The message matched because the loop bound and the escape share one
`exit`.

Now split in two, each rewriting exactly the span its property needs:

- **`refuses a target that resolves outside the volume root, on the first step`** —
  rewrites only the `for p in …` list, anchored at `'; do d="$p";'`, so the root
  the guard was BUILT with stays put and only the targets escape. This is the
  shape a mis-joined `subPath` would take, and it must refuse on the first pass,
  before the walk shortens `$d` at all. Two assertions pin the asymmetry
  (`movedTargets` carries no root; `rest` still carries it) so the conflation
  cannot silently return when the guard's shape next changes.

  The escaped targets are pointed **through a planted symlink** (`<tmp>/link/…`
  with `link -> .`) rather than at a path that merely does not exist. That plant
  is Ally's review suggestion on this PR, and it is what makes the test
  discriminating — see the mutation table below. The correct guard never touches
  the filesystem here (it refuses lexically on step 1), so the plant is invisible
  to it; it exists only to give a *wrong* guard somewhere else to go.
- **`terminates …`** — keeps the whole-script rewrite, with the comment now
  stating what it actually exercises: targets and `case` pattern both move, the
  sentinel does not, so the walk can never meet its sentinel and must be stopped
  by `case` failing on the final `/nowhere`.

**Mutation result — and this revision reverses the one the PR opened with.**

As first pushed, the new test used a plain `/nowhere/…` target and I recorded,
accurately for that version, that it *"kills no mutation the existing five miss
and is not offered as one"*. Ally's review then named the mutant that exposed
why: weaken containment to `case "$d" in /*)` — "is absolute", root no longer
checked at all — and the walk still shortens to `""` and still exits with
`is not under the volume root`. **The old test passed that mutant**, which is
precisely the false clear the split was supposed to remove.

With the planted symlink the same mutant instead walks down to the link and dies
with `is a symlink`, so the test now separates them. Measured in the harness,
mutant applied to the generated guard:

| mutation | 5 pre-existing guard tests | new test (as first pushed) | new test (with the plant) |
|---|---|---|---|
| containment `case` → `/*)` — absolute-only, root unchecked | **all 5 pass** | **passes** — false clear | **fails** |
| containment `case` → `[ -n "$d" ]` bound | `terminates` fails | fails | fails |
| containment checked on `$p`, not `$d` | `terminates` fails (hangs to the 15 s timeout) | passes | passes |
| root constant drifts from the one targets are joined with | caught by the two positive "passes" tests | — | — |

The first row is the point: **nothing in the suite caught that mutant before**,
and the new test is now the only thing that does. The kill is behavioural, not
just structural — with the two shape-pinning assertions removed the test still
fails on that mutant, on `stderr` reading `is a symlink` where it must read
`is not under the volume root`. Hence the added
`expect(r.stderr).not.toContain("is a symlink")`: the right message for the
wrong reason is not a pass.

So the split buys accuracy *and*, with Ally's plant, one mutant of real defect
detection. 1813/1813 in the adapter suite, `tsc --noEmit` clean.

## 2. `job-manifest.ts` — the 4b residue recorded at the `chown -h`

Ally's second finding: the guard is still check-then-act once claims are
per-agent. Verified and upheld, with one correction to the proposed remedy, and
one direction closed off.

**The open window is guard → `chown`, with the `mkdir -p` in the middle, and
both halves are exposed.** An earlier revision of this note — and of the comment
it describes — said the `chown` step was already safe because `-h` "never
traverses". **That is wrong, and Ally caught it.** `-h` maps to `lchown(2)`,
which declines to follow only the **last** component; every intermediate
component is resolved the ordinary way, symlinks included.

Measured on a runner rather than argued from the man page:

| probe | result |
|---|---|
| `elsewhere/leaf` real, `link -> elsewhere`; `chown -h link/leaf` | exits 0, lands on `elsewhere/leaf` |
| `chown -h link/nosuchthing` | exits 1 — so the 0 above really did locate the file *through* the link |
| `deadlink -> /nonexistent`; `chown -h deadlink/leaf` | ENOENT — reachable only by having resolved the intermediate |

So a uid-1000 writer that swaps a parent component for a symlink inside the
window gets, from uid 0, **both** `mkdir -p` creating root-owned directories at
a route it chose **and** `chown` handing uid 1000 ownership of a directory it
chose. The second is the worse half: an ownership transfer, not a misplaced
mkdir.

*"Re-check between `mkdir` and `chown`"* still does not close it, but for a more
basic reason than the one previously recorded here: the re-check is itself
check-then-act, so it closes neither half — it only shortens the race. Real
closure needs either an fd-relative walk (`openat(…, O_NOFOLLOW|O_DIRECTORY)`
per component, then `fchown` on the final fd), which `sh` cannot express and so
means moving the seeder out of shell, or removing the privilege boundary
altogether — see `fsGroup` below, which is cost-blocked rather than unavailable.

`-h` is still worth keeping: it stops a target whose **final** component is a
symlink being chowned through. That is all it buys, and the comment now says so.

**Why it is reachable at 4b and not today.** The in-code justification is
*"init containers are sequential, so nothing else in the **Pod** is running"* —
POD-scoped, and pod scope is what a per-agent claim dissolves: the concurrent
writer is a uid-1000 agent container in a different pod on a different node,
sharing the claim. Read live 2026-10-30: two agents each held 2 concurrent run
pods, one spanning two nodes. That is also why a per-agent claim has to stay
`ReadWriteMany`.

**`fsGroup` is closed off, and the reason is cost, not availability.** Owning the
tree as 1000 would let the seeder drop uid 0 entirely, making the race
uid-1000-on-uid-1000 and no longer a privilege boundary. `cephfs.csi.ceph.com`
reports `fsGroupPolicy: File` on this cluster, so kubelet would honour it. But
`deploy/helm/paperclip/values.blockcast.yaml` clears the chart's `fsGroup: 1000`
because cephfs does not reliably short-circuit
`fsGroupChangePolicy: OnRootMismatch` — kubelet re-walks the volume on every
mount, giving 30-45 min rollouts (onprem-k8s #225). A per-agent volume starts
empty but grows to that agent's own checkout, so the walk is re-paid per pod
start and scales with the volume. Recorded as "do not re-propose without
re-measuring that short-circuit against a real per-agent claim" rather than
left for someone to rediscover.

## What this does NOT do

Zero movement on ceph-csi lock exposure: every agent pod still mounts
`paperclip-data`. PEN-4932's acceptance criterion — two agent pods on one node
reporting distinct volume IDs — remains unmet and is the `dataClaimName` swap.
