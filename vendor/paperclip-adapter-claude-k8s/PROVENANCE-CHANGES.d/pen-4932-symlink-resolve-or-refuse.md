# PEN-4932 — the prompt-bundle projection resolves symlinks within the tree, or refuses

Stage 4b landed the projection walk stepping *over* symlinks: counting them, so the
trade was visible rather than silent, and carrying a ⛔ constraint that the swap PR
must resolve-within-tree or refuse before the Secret becomes the delivery path. This
discharges that constraint. It is a prerequisite for the `dataClaimName` swap, not a
cleanup — the swap is unsafe to write until it lands.

## Why stepping over a link could not stay a counted number

`hashPathContents` (`src/server/prompt-cache.ts:190-205`) **resolves** a symlink with
`realpath` and hashes the target, and the pod reads the bundle by traversing the real
tree — so a link inside a skill delivers its target's bytes **today**. A projection
that steps over it therefore becomes, on the run that swaps `dataClaimName`, a file the
pod used to get and silently stops getting. That is the precise dangling-skill failure
this channel exists to prevent, reintroduced by the change meant to close it.

Counting it was the right call while the projection was measurement-only and nothing
read it. It stops being the right call in the same change that makes the Secret the
delivery path, which is why the constraint was recorded against the swap rather than
fixed in place.

## Files

- `src/server/prompt-bundle-projection.ts`
  - `collectSkillFiles` no longer steps over links. Each one takes exactly one of four
    outcomes, none silent: a regular file inside the tree is **projected under the
    link's path carrying the target's bytes** (matching what the pod reads today); a
    directory inside the tree is **descended into**; anything outside the tree is
    **refused**; a dangling link is **counted**.
  - Dangling is the one case counted rather than refused, deliberately: it delivers
    nothing to the pod today either, so stepping over it cannot be a delivery
    regression, while refusing would abort runs that currently work — a regression in
    the other direction.
  - `PromptBundleSymlinkEscapesTreeError` — new. An out-of-tree target is refused
    rather than copied because two faults meet at one link. *Delivery*: the target is
    reachable only because the pod shares the server's volume, which is exactly what a
    per-agent claim takes away. *Containment*: copying an arbitrary out-of-tree target
    into this run's Secret would carry whatever the link names — another company's
    tree, a host path — into a value this run's pod can read. No projection is both
    faithful and contained, so the operator re-points the link or vendors the file in.
  - `PromptBundleSymlinkCycleError` — new, and the cycle test is a true **ancestor**
    test rather than a seen-directory test. Two sibling links onto one real directory
    are not a cycle: the pod really does see that content under both names, and both
    are projected. Deduplicating on "already visited" would drop one of them, which is
    the same silent loss this change exists to remove. Only a link onto its own
    ancestor expands without bound, and that is refused rather than truncated at a
    depth, because truncating silently picks which expanded path the pod gets.
  - Containment is tested against the tree root's **`realpath`**, not against
    `entry.source`. The managed skill root routinely sits under a symlinked mount
    component, so a genuinely within-tree link resolves to a path that does not share
    the unresolved prefix — testing against the raw source would refuse every run on
    such a deployment. `isWithinTree` compares on a **path boundary**, because a bare
    `startsWith` accepts `<root>-evil` as inside `<root>`: the containment check
    failing open on exactly its adversarial input. Both have their own tests.
  - `skippedSymlinkCount` is replaced by `resolvedSymlinkCount` + `danglingSymlinkCount`.
    Not a rename: after this change a link is never merely skipped, so the old field
    would read zero forever and mean nothing. A non-zero `resolvedSymlinkCount` is now
    a normal fully-delivered outcome rather than the blocker it was.
- `src/server/execute.ts` — the two new refusals join the **cached deterministic**
  refusal set and `describeProjectionRefusal` gains their structured shapes
  (`symlink_escapes_tree`, `symlink_cycle`). Deterministic in the same sense as the
  existing two: the sizing key covers the tree contents and the sources, and
  `hashPathContents` hashes a link's target, so a tree that refuses under one key
  cannot resolve cleanly under the same one. The `prompt_bundle_projection_sized` log
  line carries the two new counters in place of the old one.
- `src/server/prompt-bundle-projection.test.ts` — the two step-over tests are replaced
  by eleven covering each of the four outcomes plus the three ways to get the
  containment and cycle tests wrong. Every one was mutation-verified to fail against
  the pre-change behaviour (see below).
- `src/server/execute.test.ts` — one test per new refusal branch. The branch chain is
  keyed on `name`, and getting one wrong does not throw: it reports the wrong `kind`
  with undefined fields, so each gets its own assertion.

## Verification

Five mutations applied to the walk, each caught by exactly the tests that claim to
cover it, and none passing silently:

| mutation | tests failed |
|---|---|
| escape skipped instead of refused | 3 |
| containment tested against the unresolved source | 1 |
| `startsWith` without a path boundary | 1 |
| seen-directory dedupe instead of the ancestor cycle test | 1 |
| links stepped over entirely (the pre-change behaviour) | 10 |

Full adapter suite 1800 passed / 28 files (1789 before; +11 is exactly this change's
additions). `tsc --noEmit` clean, verified non-vacuous by injecting a type error and
confirming it was reported.

## Still not delivered by this change

The pod does **not** yet read the projection — `dataClaimName` is still the server's own
claim and the call site remains measurement-only. The refusal paths added here become
load-bearing in the swap, which is the next change. The issue's acceptance criterion
(two agent pods on one node reporting distinct volume IDs) is unchanged and unmet.
