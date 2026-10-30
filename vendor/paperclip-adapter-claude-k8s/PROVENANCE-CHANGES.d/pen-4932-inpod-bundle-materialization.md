# PEN-4932 — the prompt bundle's skill farm is rebuilt inside the pod

Property 2 of the stage-4b delivery channel (plan §4.2). The projection landed first and
measures only; this adds the step that turns a projected Secret back into the bundle tree
**inside the pod**. It is a prerequisite for the `dataClaimName` swap, not a cleanup.

## Why the write target has to move

`prepareClaudePromptBundle` writes the bundle as `agent-instructions.md` plus a farm of
symlinks at `.claude/skills/<runtimeName>` pointing at `entry.source`
(`src/server/prompt-cache.ts:499-508`). Both the links and their targets live on the
volume the server holds, and the pod can follow them **only because it mounts that same
volume**. A per-agent claim is by definition a volume the server does not hold, so on the
swap every one of those links dangles — and dangles *silently*: the agent simply does not
have the skill, and nothing in the run says so.

Symlinks also do not survive a Secret projection, so the farm cannot travel as links even
once the bytes do. Hence the farm is rebuilt in-pod from the projected tree.

## Files

- `src/server/prompt-bundle-materialization.ts` — new.
  - `buildPromptBundleMaterializationShell` emits the in-pod step: for each path the
    projection declared, drop any symlinked ancestor, then `cp -L` it out of the Secret
    mount into the bundle root.
  - `isSafeBundlePath` decides path safety in TypeScript rather than defending against it
    in shell. Every path reaching the step comes from the projection's own
    `items[].path`, so an unsafe one is a bug in this channel and not hostile input; the
    builder throws rather than emitting a step that would silently drop it. A shell guard
    would also have to be correct under every `sh` the image might ship, where a
    rejection here is correct once. Rejected: absolute paths, any `.`/`..`/empty segment,
    and any control character — a newline would split the emitted `for` list and turn one
    declared path into two.

## Three choices that are the OPPOSITE of `buildSharedDocOverlayShell`

The shared-doc overlay solves the same shape of problem (PEN-3329) and is the model for
the Secret staging, but three of its properties invert here, and the difference is what
each failure costs:

- **Fails the pod rather than under-delivering.** A shared doc that does not arrive costs
  the run some documentation and is reported on stderr; the step ends `true` on purpose.
  A skill file that does not arrive is the dangling-skill failure this whole channel
  exists to prevent, and it is invisible from inside the run. §4.2's decision states the
  preference — "a failure that is a `Pending` pod with an event, not a partially-populated
  tree" — so any copy failure, and any declared path absent from the mount, exits
  non-zero. A run that cannot get its skills must not look like one that chose not to use
  them.
- **Overwrites rather than filling absences.** The shared-doc step never overwrites,
  because a tracked file in the clone is the authority. Here the bundle root is
  content-addressed by `bundleKey`, so anything already at a destination is either
  byte-identical or the residue of a half-finished earlier attempt. Keeping it would make
  the tree a function of history; overwriting makes it a function of the Secret alone,
  which is the invariant the swap needs. The payload is capped at
  `PROMPT_BUNDLE_SECRET_MAX_BYTES`, so re-copying is cheap.
- **Removes a symlinked ancestor instead of stepping over it.** The shared-doc step steps
  over one because it does not own the destination tree and a write could land in a shared
  directory. The pod does own the bundle root, and a symlink at
  `.claude/skills/<runtimeName>` is precisely the farm entry the pre-swap server wrote.
  Stepping over it would preserve the dangling link the swap exists to retire; writing
  through it would land outside the run. So it is removed and reported. `-L` is tested
  rather than `-e`, so a *dangling* ancestor — the shape the swap actually produces — is
  caught as well as a live one.
- **The ancestor walk goes SHALLOWEST FIRST, and that direction is the correctness
  argument rather than a style choice.** Bottom-up, the deepest ancestor is tested while
  the farm link above it is still live, so `-L` and `rm -f` resolve *through* it: with a
  farm entry `.claude/skills/x -> shared/x` and a symlinked subdirectory `shared/x/refs`
  inside the source — the within-tree shape #3157 resolves rather than skips — the step
  deletes `shared/x/refs` in the SHARED source, outside the bundle root and for every
  agent sharing it. That is the exact outcome this step exists to prevent, arrived at by
  the step itself. Top-down removes each link before anything beneath it is tested.
  (Found by Ally on the rebased head and reproduced under `sh` before the fix.)
- **The walk splits segments rather than calling `dirname`.** No subprocess per component,
  and no argument for a dash-led FIRST segment — which `isSafeBundlePath` admits — to be
  read as an option. With `dirname` and no `--` such a path makes `dirname` error and
  return empty, so the walk is skipped entirely: a guard that silently stops guarding.
  Only the first segment can do it; under `.claude/...` the argument always starts with
  `.`. The accumulated prefix also carries the parent path out of the loop, which replaces
  the second `dirname` the `mkdir` used.

## Two further details

- **`cp -L`, not a plain copy.** A Secret volume is an atomic-writer layout: every
  projected path is a symlink into `..data/<key>`, itself a link to a timestamped
  directory. A copy preserving links would leave the bundle root correct only while that
  mount exists — the same class of fault as the server-written farm. `-L` dereferences, so
  the bundle root holds real bytes.
- **…copied to a sibling and `mv`d into place, not written onto the destination.** `cp`
  truncates in place, so a reader during the copy sees a half-written file and two runs
  sharing a `bundleKey` root interleave. `mv` within one directory is atomic. The test
  also asserts no `.pcpb-part` residue survives: one left in the bundle would be read by
  `--add-dir` as content.
- **The `..data` layout is never walked.** The step copies exactly the paths the
  projection declared, so the Secret's own bookkeeping entries cannot reach the bundle
  root, which a `cp -R` of the mount root would deliver.

## Not in this change

Nothing calls the builder yet. The Job does not mount the prompt-bundle Secret and the pod
still reads the bundle off the shared volume, as it will until `dataClaimName` is swapped.
Wiring it now would stage a Secret per run that nothing reads — the same restraint the
projection took when it landed as measurement-only, and for the same reason: a cost that
buys the run nothing is a regression.

## Tests

`src/server/prompt-bundle-materialization.test.ts` executes the emitted script with `sh`
against a real temporary tree, as the shared-doc tests do, rather than asserting on the
string. Each of the inverted properties above has a test that fails when the property is
removed — verified by mutation: deleting the ancestor `rm -f` fails 2 tests, `cp -L` →
`cp -P` fails the dereference test, and turning the undelivered-path `exit 1` into a
`continue` fails the pod-fails test.

Reverting the walk to the bottom-up `dirname` form fails exactly two more — the
reach-through case and the dash-led-first-segment case — and both were written as
reproductions that failed before the fix rather than after it. The reach-through fixture
is the one the earlier tests could not catch: they put the link at the leaf skill
directory with nothing linked beneath it, so there was nothing for the walk to reach
through.
