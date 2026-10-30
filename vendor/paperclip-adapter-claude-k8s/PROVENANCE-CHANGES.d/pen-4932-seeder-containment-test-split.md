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
- **`terminates …`** — keeps the whole-script rewrite, with the comment now
  stating what it actually exercises: targets and `case` pattern both move, the
  sentinel does not, so the walk can never meet its sentinel and must be stopped
  by `case` failing on the final `/nowhere`.

**Mutation result, stated plainly rather than overclaimed.** The new test kills
no mutation the existing five miss, and it is not offered as one:

| mutation | `terminates` | new test |
|---|---|---|
| containment `case` replaced by a `[ -n "$d" ]` bound | fails | fails |
| containment checked on `$p` instead of `$d` (per-target, not per-component) | fails (hangs to the 15 s timeout) | passes |
| root constant in the `case` drifts from the one targets are joined with | — | — (caught by the two positive "passes" tests) |

They are **complementary**, not ordered. What the split buys is accuracy: the
suite no longer claims a property it does not exercise, and the escape shape now
has a test of its own. 1813/1813 in the adapter suite.

## 2. `job-manifest.ts` — the 4b residue recorded at the `chown -h`

Ally's second finding: the guard is still check-then-act once claims are
per-agent. Verified and upheld, with one correction to the proposed remedy, and
one direction closed off.

**The open window is guard → `mkdir -p`, not guard → `chown`.** `chown -h` is
symlink-safe by construction — it acts on the link and never traverses — so a
link planted after the guard changes nothing there. `mkdir -p` has no such
protection. Therefore *"re-check between `mkdir` and `chown`"* does **not** close
it: by then `mkdir -p` has already written through the link. It closes the
ownership half and leaves directory creation at an attacker-chosen route.

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
