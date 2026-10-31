# PEN-4932 — make the prompt-bundle Secret the delivery path on a foreign claim

`src/server/job-manifest.ts`, `src/server/execute.ts`,
`src/server/prompt-bundle-materialization.ts`, `src/server/prompt-cache.ts`, and a new
`src/server/job-manifest.prompt-bundle-secret.test.ts`.

The projection built by #3153/#3157/#3158 had no consumer: `execute.ts` built it inside a
`try`/`catch` that stepped over every outcome, purely to measure the fleet size distribution.
This change gives it one. On a Job whose data claim is **not** the server's own, the adapter
stages a per-run `PromptBundleSecret`, declares the volume `optional: false` with the
projection's `items[]`, mounts it read-only, and splices
`buildPromptBundleMaterializationShell`'s copy step into the agent command under `|| exit $?`.
The measurement path is unchanged; it is now the `else`.

## Why it has to travel as bytes

`prepareClaudePromptBundle` writes the bundle through `SELF_POD_DATA_MOUNT_PATH` and the Job pod
reads the same relative path, under a comment stating the assumption outright: *"One volume, TWO
mount points"*. That is true today and **false the moment the agent claim is per-agent** — same
relative path, different volume. The server would write a complete bundle into its own volume and
the pod would get the seeded, empty directory: `--add-dir` naming an empty tree and
`--append-system-prompt-file` naming a file that does not exist, with nothing on the write side
erroring. This is invariant 1 of stage 4b, and the `dataClaimName` swap cannot land until it is
closed — which is the whole reason this lands separately and ahead of it.

## The gate is claim identity, not the narrowing

New exported `serverHoldsJobDataClaim` / `resolveDataClaimName`. `serverCanPreCreate` is
re-expressed through the same predicate — same value — so the two consumers of that fact cannot
drift.

Confusing the two is the live hazard: they are equal whenever `narrowWritableSurface` holds, and
part only on a non-isolated run against the server's own PVC. Gating on the narrowing would switch
this channel on for a slice of *today's* fleet, where the Secret buys nothing and can only fail a
run over a budget that was never load-bearing. The mutation that swaps the gate **initially passed**
— every fixture was isolated, where the two are equal, so the suite could not tell them apart. The
non-isolated fixture exists for exactly that case.

## Image-path skills are the complement, not an exclusion

`skillSourceNeedsProjection` leaves image-path skills out of the projection because the pod already
has their bytes. But the agent reaches a skill through its `.claude/skills/<runtimeName>` farm link,
which `prepareClaudePromptBundle` writes into the **server's** volume — so on a foreign claim every
adapter-bundled skill would have vanished from `--add-dir` with nothing reporting it.
`buildPromptBundleSkillLinkShell` rebuilds those links in-pod, built as the exact complement of the
projection off the same predicate, so a skill cannot fall between the two. `isSafeSkillRuntimeName`
bounds what may be interpolated into that shell, and the `rm -rf` before `ln -s` is load-bearing on
a persistent claim where a link may already exist. The relink is deliberately **not** gated on the
projection being non-empty: an all-image-path run has an empty projection and still needs its links.

## Refusals fail the run here — the opposite of the measurement path, deliberately

`buildPromptBundleSecretProjection` refuses rather than truncates (over budget, too many
files/dirs, symlink escaping the tree, symlink cycle). On the delivery path those refusals
propagate: no sizing cache, no `catch`. Each one is precisely the "agent came up missing half its
instructions" outcome, so stepping over it while the Secret **is** the delivery path would ship the
silent failure this channel exists to prevent. The escalation threshold was chosen against a
one-company sample; the first per-agent runs are where the fleet distribution actually gets
measured.

`createOrAdoptRunSecret` gains an optional `base64Data` half so the projection's non-UTF-8 files
reach the pod intact — a PNG or a font in a skill tree would otherwise be delivered corrupted.

## One live behaviour change, and it is not the per-agent path

`dataClaimName === ""` — a server with no PVC of its own, whose pod gets an `emptyDir` — is also
not the server's volume, so it now gets the Secret. That is a **fix** (such a pod cannot see the
server's bundle today), but it is the only branch here reachable without the swap and should be
read as a change rather than covered by the inertness argument below.

The `data_claim_foreign` warning was reporting the prompt bundle as absent and blaming company
skills, which actually arrive. Its message and `unpopulatedSubPaths` are now conditional on whether
a Secret is staged, plus a `promptBundleDelivery` field; left unconditional it would have fired on
every per-agent run forever.

## Inert on today's fleet

Every agent Job resolves `dataClaimName` to the server's own PVC, so `serverHoldsJobDataClaim` is
true, no Secret is staged, and the agent command is byte-identical. Same posture as #3153/#3157/#3158
for the projection and #3164/#3165 for the seeder split: on `master` and reviewed before it is
load-bearing.

## Tests

`job-manifest.prompt-bundle-secret.test.ts` (new, 14 tests; 20 across the change) — inertness on
both self-claim shapes (isolated **and** non-isolated), staging and splice on a foreign claim,
key-set agreement between the Secret and the volume's `items[]`, both projection halves, the
`|| exit $?` guard compared against the shell builder's real output rather than a substring, the
refusal on a non-bundle-relative path, and both directions of the reworded warning. Nine mutations,
each reverting one decision in the diff, were verified caught. Full adapter suite 30 files /
1862 tests green, typecheck clean.

## Not in this change

The `dataClaimName` swap itself (blocked on #3168, which provisions the claim), and the plan doc's
§5 invariant table — #3167 is rewriting rows 3 and 4 of it, so editing row 1 here would conflict
with a PR that is ready to land. Both ride with the swap. The issue's acceptance criterion — two
agent pods on one node reporting distinct volume IDs — is **not** met here.
