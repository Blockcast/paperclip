# Execution workspace run scope (`per_issue` / `per_run`)

Status: shipped behind opt-in configuration. Tracking issue: BLO-19063.

## The defect this addresses

Execution worktrees are keyed by **branch name**, and the branch name is derived
from the *issue*:

```
branchName   = render(branchTemplate)          // default "{{issue.identifier}}-{{slug}}"
worktreePath = join(worktreeParentDir, branchName)
```

Two consequences followed, and both were observed in production:

1. **Two concurrent runs of the same issue resolve to the same `cwd`.** Switching
   an agent to `isolated_workspace` did not help, because the isolation is
   per-issue, not per-run.
2. **Under the fleet default (`shared_workspace` + `project_primary`) every run of
   every issue in a project shares one tree** — the project's primary checkout.

The failure mode is silent. On 2026-08-03 the shared `paperclip` checkout was found
holding staged reverts of four merged PRs (#949, #964, #935, and the BLO-19722
liveness-probe tuning) plus 61 lines of uncommitted work belonging to a different
issue that existed on no branch anywhere. Any bare `git commit` from any run in
that tree would have committed the reverts; the intuitive cleanup (`git checkout .`)
would have destroyed the unrelated work. See BLO-21427.

A second, quieter signal: `git worktree list` on the shared `paperclip` checkout
returned 56 worktrees on 2026-08-03 and **93** on 2026-08-07. Agents fleet-wide were
already hand-rolling per-issue isolation (`blo-*-wt`, `cto/blo-*`), unmanaged,
nested inside the shared checkout, with no lifecycle or cleanup.

## The mechanism

`runScope` is a field on the `git_worktree` execution-workspace strategy:

| value | behaviour |
|---|---|
| `per_issue` | **Default.** Historical behaviour: the tree is keyed by the rendered branch name. |
| `per_run` | A short run token is appended to the branch name, so each run gets its own branch and therefore its own tree. |

Making the *branch* run-unique is what makes the *path* run-unique, and it is not
merely a convenience: git refuses to check the same branch out in two worktrees, so
a per-run tree genuinely requires a per-run branch. A path-only scheme would fail.

The issue identifier is preserved verbatim — the token is appended, never
substituted — so the BLO-9117 guarantee that a merged PR ref-links at merge time
still holds. `BLO-19063-per-run-workspaces` becomes
`BLO-19063-per-run-workspaces-r1a2b3c4d`.

If no run id is available (a non-heartbeat realize path), the branch degrades to the
issue-scoped name rather than inventing a token. This matters: an earlier revision
derived the token via `sanitizeBranchName`, whose empty-input fallback is the literal
string `paperclip-work` — so *every* run without a run id got the identical token
`papercli` and silently collapsed back onto one shared tree while still appearing
per-run. Degrading loudly beats colliding quietly.

## Enabling it

Per issue:

```jsonc
{
  "executionWorkspaceSettings": {
    "mode": "isolated_workspace",
    "workspaceStrategy": { "type": "git_worktree", "runScope": "per_run" }
  }
}
```

Per project, via the project execution-workspace policy's `workspaceStrategy`.
Both validators are `strict()`; an unrecognized scope is rejected rather than
silently persisted.

## Measured cost

Measured 2026-08-07 on `Blockcast/paperclip` (4,606 tracked files) on the
production `paperclip` node, CephFS-backed storage:

| step | wall clock | disk |
|---|---|---|
| `git worktree add` off `origin/master` | **5 s** | **91 MB** (code only) |
| `pnpm install --frozen-lockfile`, cold store | **85 s** | — |
| `pnpm install --frozen-lockfile`, warm store | **61 s** | — |
| **total per run** | **~90 s** | **~2.8 GB** |

The pnpm store is **not** global — it resolves under the execution workspace's own
home (`…/workspaces/<id>/home/.local/share/pnpm/store/v3`), so a new execution
workspace pays the cold-store number. Trees under one execution workspace share the
store and pay the warm number.

At 2.8 GB per run this is not free, which is why it is opt-in rather than the
default. `per_run` brings ownership stamping to that spend, so a tree can be
attributed to the run that made it — but **ownership is not collection, and there
is currently no automatic collector.** Enabling `per_run` therefore converts a
per-*issue* leak into a per-*run* leak. Do not enable it on a busy agent until a
collector exists.

The distinction, because it is easy to get wrong:

- `pruneOwnStaleGitWorktree` (`git-worktree-ownership.ts:384`) reclaims **git
  registry entries, not disk**. It returns `removed: false` whenever the
  directory still exists, by design — removing a materialized tree could discard
  uncommitted work. Its only call site is the workspace *restore* path
  (`workspace-runtime.ts:4149`), which runs when a tree has gone missing. It is
  not a GC and never frees a byte.
- The only code that actually removes a worktree from disk is
  `cleanupExecutionWorkspaceArtifacts` (`workspace-runtime.ts:4261`, removal at
  `:4339`). It has two callers: a `catch` rollback in `heartbeat.ts:20960` that
  fires only when *persisting* the workspace row throws, and the manual
  `PATCH /execution-workspaces/:id` route. **Neither runs at end of a normal
  run.**
- `cleanupEligibleAt` is written and read as a field but is not a query predicate
  anywhere in `server/src`; no sweep consumes it.

Measured on the live host 2026-08-07, which is what this claim rests on rather
than code reading alone: five runtime-managed worktrees under
`.paperclip/worktrees/` created between 2026-07-30 and 2026-08-05, none
collected; 38 hand-rolled `blo-*-wt` directories created 2026-08-01 → 2026-08-07,
monotonically increasing, none collected; 95 registered worktrees in total; 2.0 GB
apparent size for a single runtime-managed tree.

## What this does not do

- It does not change any existing default. `per_issue` remains the default and
  `shared_workspace` remains available and default-safe for agents at
  `maxConcurrentRuns: 1`. This is not a forced fleet-wide migration.
- It does not retire the 93 pre-existing hand-rolled worktrees. That cleanup is
  separate operational work.
- It does not by itself decide *which* agents should run `per_run`. Enabling it is
  gated on a collector existing, per the cost section above.
