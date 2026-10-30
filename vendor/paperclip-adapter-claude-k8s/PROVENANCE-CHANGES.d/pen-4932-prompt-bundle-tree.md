# PEN-4932 — the prompt bundle is a server-materialized tree, and the foreign-claim warning did not say so

Stage 4b of the per-agent-volume plan has to enumerate every tree the SERVER
materializes into the data volume, because a per-agent claim is by definition a
volume the server does not hold: anything on that list comes up EMPTY in the pod.
`claude_k8s.data_claim_foreign` is where that list is published, and it was
incomplete. It named the git-hooks dir and `skills/<companyId>` — both of them
`subPath` mounts — and missed the prompt bundle, which is not a mount but a
directory the server *writes into* one.

`execute.ts` states the assumption it rests on, exactly: *"One volume, TWO mount
points: this process writes at `SELF_POD_DATA_MOUNT_PATH` and the K8s Job pod
reaches the same bytes at `resolveDataMountPath(config)`."* True today; false the
moment the claim is per-agent. Same relative path, different volume — the server
writes a complete bundle into its own volume and the pod gets the seeded, empty
directory, so `--add-dir` names an empty tree and `--append-system-prompt-file`
names a file that does not exist. That is the agent's instructions going missing,
not a degraded skill set, and nothing on the write side errors.

## Files

- `src/server/job-manifest.ts`
  - `resolvePromptCacheRoot` **moved here from `execute.ts`** and exported. Not
    tidying: the warning has to name the directory a run will actually read, and
    a second copy of that precedence is free to drift from the first. The
    descriptor branch is exactly where a re-derivation goes wrong —
    `isolation.root` is `dirname(homeRoot)` there, which for a workspace
    descriptor is `…/k8s-isolation/workspaces/<wsId>`, while the bundle lands
    under `…/k8s-isolation/<companyId>/<agentId>/<key>`. Different trees. The
    first draft of this change derived the wrong one and the test caught it.
  - The warning emits the bundle root as a volume-relative `subPath`, and only
    when it is under `dataMountPath`. An operator-set `promptCacheRoot` can point
    off-volume, where no volume-relative address exists; slicing a prefix that
    does not match would put a confident wrong path into the one field stage 4b
    reads. Omission is the honest answer, and that case already has its own
    report (`claude_k8s.prompt_bundle_off_volume`).
  - Comment block rewritten to carry the remedy split: the skills tree can be
    fixed by getting the right bytes onto the claim; the bundle cannot, because
    it is written per-run to a path the server chooses, so the write *target* has
    to move onto a channel that does not assume a shared volume.
- `src/server/execute.ts` — local `resolvePromptCacheRoot`,
  `sanitizePathComponent` and `safePathComponent` deleted (the last two had no
  other caller); imports the moved function. No behaviour change:
  `sanitizePathComponent` and `sanitizeForK8sPath` were character-identical.
- `src/server/job-manifest.test.ts` — the exact-list assertion from stage 3b-iii
  is kept and extended to the two-entry list, so the git-hooks entry still cannot
  come back unnoticed. Adds a negative assertion against the
  `dirname(homeRoot)` derivation, and a test that an off-volume
  `promptCacheRoot` omits the bundle root while leaving the skills entry intact.

No runtime behaviour changes for any Job on the server's own claim: the warning
is unreachable there, and `resolvePromptCacheRoot` returns what it always did.
