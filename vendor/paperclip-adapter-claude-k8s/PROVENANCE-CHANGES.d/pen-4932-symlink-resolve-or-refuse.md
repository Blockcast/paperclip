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
- `src/server/execute.ts` — the new refusals are **reported but NOT cached**, a third
  path beside "cached deterministic refusal" and "rethrown transient fault".
  ⚠️ The first draft of this change cached them, on the claim that `hashPathContents`
  hashes a link's target. **That claim is false and Ally's review caught it.**
  `prompt-cache.ts:190-204` hashes `symlink:<relPath>` plus the target's *contents*
  under the link's own relPath — the resolved *path*, which is the only input the escape
  and cycle tests read, never enters `bundleKey`. So re-pointing an escaping link at a
  byte-identical in-tree file (exactly what the error message instructs) leaves the key
  unchanged, and a cached refusal would replay against a tree that is now correct; the
  reverse retarget would keep a cached `sized` and never report a real escape. The cycle
  case collides the same way, because `hashPathContents` uses one *global*
  `seenDirectories`, so a genuine cycle and a lawful sibling link hash alike.
  `describeProjectionRefusal` gains `symlink_escapes_tree`, `symlink_cycle` and
  `too_many_dirs`. The `prompt_bundle_projection_sized` log line carries the two new
  counters in place of the old one.
- `PROMPT_BUNDLE_MAX_DIRS` / `PromptBundleTooManyDirsError` — new. `maxFiles` counts
  FILES, so a chain of link-only directories expands 2^depth directory visits while
  adding none, slipping the cap entirely. Bounded explicitly and refused, because Job
  creation is the critical path.
- The `realpath` catch is narrowed to `ENOENT`/`ENOTDIR`/`ELOOP`. A blanket
  `catch(() => null)` would call `EACCES`/`EIO`/a transient CephFS fault "dangling", and
  a dangling count rides into a `sized` outcome that **is** cached — remembering one
  blip for the life of the process.
- `fs.stat`/`fs.readFile` take the **resolved** path rather than the link, so the bytes
  read are the bytes whose location was containment-checked.
- `rememberProjectionSizingUnlessUncacheable` — the cache decision is keyed on the
  outcome's `detail.kind` and exported, rather than being a boolean threaded out of a
  `catch`. That is what makes it testable: a second review round noted the guard had no
  failing mutation, which is exactly the shape that let the false caching claim survive
  the first time. Three mutations now kill it, including an over-fire control so that
  "cache nothing" cannot pass as "cache the right things".
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
| blanket `realpath` catch (review fix reverted) | 1 |
| directory-visit cap removed (review fix reverted) | 1 |
| cache guard deleted (always cache) | 1 |
| escape kind removed from the uncacheable set | 1 |
| cache guard over-fires (cache nothing) | 1 |

The `stat`/`readFile`-the-resolved-path change is **not** separately covered, and
deliberately not claimed to be: absent an actual race the two paths are identical, so a
test would exercise the interposition rather than the code. It is TOCTOU hardening.

Full adapter suite 1807 passed / 28 files (1789 before; +18 is exactly this change's
additions). `tsc --noEmit` clean, verified non-vacuous by injecting a type error and
confirming it was reported.

## Still not delivered by this change

The pod does **not** yet read the projection — `dataClaimName` is still the server's own
claim and the call site remains measurement-only. The refusal paths added here become
load-bearing in the swap, which is the next change. The issue's acceptance criterion
(two agent pods on one node reporting distinct volume IDs) is unchanged and unmet.
