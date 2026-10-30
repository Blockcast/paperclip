# PEN-4932 stage 3b-iii — empty `ROOT_TOOLCHAIN_SUBPATHS`: the agent Job stops binding the PVC git-hooks dir

Tracking: [PEN-4932](https://paperclip.blockcast.net/PEN/issues/PEN-4932) · plan: `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` §3.6, §4 step 3

**Files:** `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`,
`src/server/job-manifest.git-hooks.test.ts`, `src/server/job-manifest.github-publish-broker.test.ts`,
`src/server/runtime-pin.ts`

`ROOT_TOOLCHAIN_SUBPATHS` is now `[]`. Stage 3 (#3079, #3081, #3104) dropped the six fleet-wide
toolchain dirs and left `.local/share/paperclip-git-hooks` as the last entry, deliberately, because
it carries the PEN-3156 pre-push publish guard and the relocation of that guard into the agent image
needed its own review. #3126 did the repoint (`hooksDirectory()` → `BAKED_HOOKS_DIR`); this removes
the mount the repoint made dead.

**Gated on a property read inside a live agent pod, not on a tag or a merge** — measured 2026-10-30
on the fleet image (master tip, bumped fleet-wide by `docker-agent.yml`):

| required | measured |
|---|---|
| installed `@paperclipai/adapter-utils` `hooksDirectory()` resolves the image copy | returns `BAKED_HOOKS_DIR`; `DEFAULT_HOOKS_DIR` occurs 0 times in the built module |
| the image actually carries an executable hook | `/usr/local/libexec/paperclip/hooks/pre-push` present, `root:root 0755`, `X_OK` |
| nothing aims it back at the PVC | `PAPERCLIP_GIT_EGRESS_HOOKS_DIR` unset in-pod, and set by nothing in this repo |
| the `kubectl` pin (#3081) survives unshadowing | `/usr/local/bin/kubectl` is `v1.35.3` |

**Why this ordering is the safe one.** §4's hazard is a `paperclip-api` that has stopped mounting the
PVC copy *in front of* agent images that still look there — that is PEN-4518's shape exactly. Here
the images stopped looking **first**: the agent image rolls per master commit while `paperclip-api`
rolls daily at 07:23 UTC, and on the day of this change a pod created at 05:25:48Z still carried all
seven toolchain `subPath`s, i.e. the server had not yet picked up #3104 (merged ≥16 h earlier). The
window therefore cannot open in the dangerous direction. (`paperclip_api_deploy_drift_stale` read
`0` throughout, so that exporter does not measure this; read the server plane off a fresh pod's
mounts.)

**The uid-1000 boundary is not dropped — it moves from mount to ownership.** The publish broker runs
the pre-push hook with the push credential in its environment, so the agent uid must not be able to
rewrite it. The read-only `subPath` bind gave that; `root:root 0755` inside the image gives it now,
and gives it in the broad-mount fallback too, where a read-only bind never existed. The broker's
fail-closed throw on a broad data mount **stays**, on its independent second leg (`workspaceRoot` is
`dataMountPath`, so that condition also decides whether a request's `cwd` is confined to this run's
workspace or to every agent's). The comment there says not to relax it because the hook argument
moved.

**Failure direction, and the rollback.** Per §3.6 as corrected: an absent or unreachable hook fails
**closed** — `buildGitArgv` refuses before injecting `core.hooksPath` when no executable `pre-push`
is at the resolved dir — so the risk is a fleet-wide push *refusal*, never a silent unscanned
publish. The Helm seed that writes the PVC copy is deliberately **left in place**: the dir is now
unmounted, not deleted, so reverting this commit restores the old behaviour without a chart release.
Removing the seed is a separate change once this has soaked.

**Second-order effect, and the reason this is on PEN-4932's critical path rather than tidy-up.** The
`claude_k8s.data_claim_foreign` warn used to name two server-materialized trees that come up empty on
a claim the server does not hold. It now names one. The hooks dir is not deferred to stage 4b, it is
*gone* — the Job does not mount it on any claim. `skills/<companyId>` is the only one left, and it is
the worse of the two (an empty skills tree dangles the prompt bundle's skill links **silently**,
where the hooks dir failed closed and loudly). The warn's `unpopulatedSubPaths` is pinned with
`toEqual`, not `toContain`, so the git-hooks entry returning fails the suite.

**Tests inverted rather than deleted**, in all four places that pinned the bind — including
`job-manifest.git-hooks.test.ts`, whose entire subject was BLO-48361 (the root overlay hid the
chart-seeded hook and the egress guard refused every push for 2h17m, while the seed's own success log
stayed true throughout, because the seed writes to the PVC and the Job pod sees an overlay). The
standing lesson is that this join is only ever visible from the **manifest**, so the manifest keeps a
test; it now asserts the hook is *not* reachable off the shared volume, pinned on the `subPath` as
well as through deepest-mount resolution so a bind re-added at a different `mountPath` still fails.

**Verification:** `tsc --noEmit` clean; vendored claude suite **1751/1751** on the pinned
`vitest ^4.1.4`. Positive control — restoring only the constant to `[GIT_HOOKS_SUBPATH]` turns
exactly **4** tests red, and they are the four inverted assertions.


## Review follow-up — the preflight verdicts had to be re-scoped, not just the mount removed

Raised by Ally on `69a0198` and taken here rather than deferred, because the defect is one this very
change introduces into operator-facing text. Comment and verdict strings only in
`src/server/runtime-pin.ts`; no behaviour change, no control weakened.

Emptying `ROOT_TOOLCHAIN_SUBPATHS` does not merely remove a mount — it **narrows which verdict
`buildPrePushHookPreflightShell` can reach**. The `OFF-MOUNT` arm is guarded on the SEEDED copy being
visible (`[ -e "$__pchookmnt/pre-push" ]`), and that visibility was exactly what the bind provided.
So:

- `OFF-MOUNT` now fires **only on the broad data mount**, the one place the seeded copy survives.
  Its text claimed, unconditionally, that a pre-bake image "reads the seeded copy, which is still
  mounted, and publishes normally". On a narrowed pod that is false, and the doc block generalised
  the same way ("emits OFF-MOUNT for a pod that publishes perfectly well"). Both are now scoped to
  the broad mount, and both say what happens instead on a narrowed pod.
- A pre-bake image on a narrowed pod lands in **`MASKED`**, which is the correct report: with
  neither copy reachable the pod genuinely refuses every push. But MASKED's doc block said the
  verdict means "both planes are broken at once", and that inference no longer holds — on a narrowed
  pod the seeded copy is unreachable **by design**, so one fault (a pre-bake image) is sufficient,
  and is now the likeliest cause. An absent bind is the intended state, not the defect.

The direction that matters is the one the original text got wrong: an operator reading the old doc
block would carry the "healthy pod, false alarm" reading across to a pod that is in fact refusing
every push. The runtime behaviour this describes is unchanged and was already pinned — the existing
"reports MASKED when the directory itself does not exist" case *is* the narrowed-pod case — so no
new test is added; the two phrases the OFF-MOUNT test asserts (`will refuse every push from this
pod`, `publishes normally`) both survive deliberately.

**Re-verified after this edit:** `tsc --noEmit` clean; vendored claude suite **1751/1751** on the
pinned `vitest ^4.1.4` (`runtime-pin.test.ts` 44/44); provenance log ok against `origin/master`.
