# PEN-4932 — close the symlinked-PARENT hole in `seed-writable-dirs` (stage 4b invariant 2)

`src/server/job-manifest.ts`: the seeder's pre-`mkdir` symlink guard becomes a
per-component walk of every target, back to the volume root, instead of a test
of the target's final component only.

## What the old guard did not cover, and why that matters at 4b

`seed-writable-dirs` is the one process in the agent Pod holding uid 0 over the
volume root. Both `mkdir -p` and a bare `chown` follow symlinks, so a link on
the path to a target is a redirect primitive against root. Stage 4a installed a
guard for the case it could state cleanly — a target whose FINAL component is
already a symlink — and recorded in a comment that a symlinked PARENT was still
followed, deferring it here.

A symlinked parent is the worse of the two. The leaf case is caught the moment
`-L` looks at it; the parent case has `mkdir -p` build the leaf *through* the
link onto a real directory reached by an unintended route, after which
`chown -h` hands uid 1000 a tree it was never scoped to. Nothing errors.

Neither case is reachable on this head, which is exactly why it is being closed
now rather than when it bites: `resolveScopedWritableMounts` drops nested
targets, and a narrowed pod has no path to another agent's subtree, so planting
such a parent needs write access to ITS parent that no pod has. **4b is what
makes it reachable** — a per-agent volume PERSISTS across runs whose target sets
differ, so one run's writable tree can become an ancestor of a later run's
target, and the fleet exercise 4a relied on cannot surface it.

## The walk

```sh
for p in <targets>; do
  d="$p"
  while [ "$d" != '<root>' ]; do
    case "$d" in '<root>/'*) ;; *) echo "… is not under the volume root; refusing" >&2; exit 1 ;; esac
    if [ -L "$d" ]; then echo "… is a symlink; refusing" >&2; exit 1; fi
    d=${d%/*}
  done
done
```

Three choices that are load-bearing rather than stylistic:

**`${d%/*}`, not `dirname`.** No subprocess per component on a path the init
container walks for every target, and no argument for a leading-dash path to be
read as a flag — the shape of the finding Ally raised on #3158's `dirname` calls,
avoided here by not having the call.

**The `case` is not decoration.** It re-asserts containment on every step, so a
target that resolves outside the volume root is refused rather than walked past.
It is also what BOUNDS the loop: `d` strictly shortens each pass, so the walk
either reaches the root, meets a link, or leaves the root, and all three exit. A
guard that can spin is worse than no guard — it hangs the init container, and
the Job then never starts, which reads as an infrastructure fault rather than a
refusal.

**The guard still runs before `mkdir -p`,** and `chown -h` is unchanged.

## Evidence

The shape assertions are pinned as before, but shape is a string and the
property that matters is what `sh` does with it. Five tests therefore EXECUTE
the generated guard against a real directory tree, substituting the volume-root
constant for a temp dir uniformly across the whole script so the logic under
test is the shipped logic: fresh volume passes, pre-existing real directories
pass, a symlinked leaf refuses, a symlinked parent refuses, and a path outside
the root refuses under a timeout rather than spinning.

Mutation-checked rather than merely green: reverting the guard to the 4a
leaf-only form fails three of them, including the parent case, which exits 0
under the old guard. 1812/1812 in the adapter suite with the walk in place.

## What this does NOT do

It moves ceph-csi lock exposure by zero. Every agent pod still mounts
`paperclip-data`; the issue's acceptance criterion — two agent pods on one node
reporting distinct volume IDs — remains unmet and is the `dataClaimName` swap,
not this. This is one of the three invariants 4a hands to 4b, cleared ahead of
the swap so the swap does not carry it.
