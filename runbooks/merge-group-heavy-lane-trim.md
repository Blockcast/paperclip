# Merge-group heavy-lane trim: reading it and turning it off

`pr.yml` no longer re-runs every heavy lane in `merge_group`. The `policy`
job's **Decide merge-group heavy-lane trim** step
(`scripts/merge-group-trim.mjs`) skips a heavy lane when the queued PR's own
head already passed that lane in `pull_request` CI and the queue applies
exactly the change set that CI tested. This runbook covers how to read a
decision, when to restore the full suite, and how.

Owner directives: 2026-10-07 ("reduce and isolate CPU waste from CI ... jobs
running without new signal") and 2026-10-09 ("do it now").

## What is trimmed and what always runs

| lane | in `merge_group` |
|---|---|
| General tests (server 1/6 … 6/6) | trimmed when the PR head passed every shard |
| e2e, Canary Dry Run | trimmed when the PR head passed them (job-level skip; neither is in `verify`'s needs nor a required check) |
| Worktree install, OpenCode Responses replay, k8s-ro seed transport cold start | trimmed when the PR head passed them |
| policy, Helm chart, Typecheck + Release Registry, Build, General tests (workspaces-a/-b), Vendored claude_k8s adapter, verify | **always run on the merged tree** |

A trimmed `verify` lane still runs and reports `success` in seconds: its steps
are skipped, so `verify`'s lane list and its "skipped is failure" rule are
unchanged. A trimmed lane shows a notice titled `… trimmed in merge group`.

A lane is trimmed only if **all** of these hold (otherwise it runs):

1. The event is `merge_group` and the kill switch below is not set.
2. The merge group targets the default branch, and its ref
   `gh-readonly-queue/master/pr-<N>-<parent>` has `<parent>` equal to
   `merge_group.base_sha`, so `base..head` is this PR's change set alone.
3. PR `<N>` is open against that branch and its head SHA is readable.
4. The change set touches no CI-control path (`.github/workflows/pr.yml`,
   `.github/actions/**`, `scripts/merge-group-trim.mjs`).
5. `git patch-id --verbatim` of `base..head` equals that of the PR head's
   diff against its merge-base with the queue parent, **and** the merge-group
   tree equals `git merge-tree --write-tree` of the parent and the PR head.
6. In the PR head's `pull_request` runs of `pr.yml`, the newest completed job
   of every leg of the lane concluded `success`, actually ran the lane's proof
   steps (a path-selector skip does not count), covers the whole shard matrix,
   and finished at most 72 h before the merge group.

Any error, missing permission or unreadable fact fails **open**: the lane runs.

The decision is made by the **merge group base's** copy of
`scripts/merge-group-trim.mjs` (`git show <base_sha>:scripts/merge-group-trim.mjs`,
run from `RUNNER_TEMP`), never the queued PR's copy, so a PR that edits the
script cannot decide its own trim. No copy at the base (the script's first
landing) means no trim. A PR can still edit the `pr.yml` step itself, since
`merge_group` reads the workflow from the group head; that exposure is the same
as any PR editing `pr.yml`, and rule 4 makes the base copy refuse to trim it.

## Reading a decision

Open the merge-group run, then the `policy` job, then the step **Decide
merge-group heavy-lane trim**. Its job summary has one row per heavy lane:
`skipped (PR head passed)` with links to the PR-head jobs, or `runs` with the
reason. A `merge-group trim fell back to the full suite` warning means a fact
could not be read (API error, fetch failure). That only costs CPU.

## After a merge: where the trimmed suites run

- **Server suites.** `master-health.yml` counts a merge-group build as proof
  only when its server shards ran their suites. A trimmed landing therefore
  runs the server suites post-merge on the landed `master` head. Push runs are
  **not** cancelled in flight: GitHub keeps one pending run and replaces it
  with each newer push, so every run that starts finishes and reports, and the
  next one tests the newest head (which contains every superseded landing).
  Proof is per group: workspaces-a/-b re-run only when the merge-group build
  did not run them (they are never trimmed). The daily 00:37 UTC schedule runs
  everything regardless.
- **Worktree install, the OpenCode lanes.** The next PR's `pull_request` CI
  runs them against `master` merged with that PR.
- **e2e and Canary Dry Run have no post-merge backstop.** Nothing runs them on
  `master`: `e2e.yml` is `workflow_dispatch` only, and `master-health.yml` has
  no e2e or canary leg. A trimmed landing's merged tree is never tested by
  them, before or after the merge, until a later PR's own `pull_request` e2e
  (not a required check) happens to cover it. In the 2026-10-03..10-09 replay
  e2e would have been skipped in 216 of 280 final-head merge groups (77.1%).
  To test a suspect `master` head, dispatch `e2e.yml` on it.

## Residual risk

A semantic conflict between a PR and work that landed after its PR CI ran
(including an earlier entry of the same queue batch) that only a trimmed lane
would catch now lands, and is caught after the merge. Build, typecheck and the
workspaces unit tests still run on the merged tree first. `master-health.yml`
catches server-suite breaks; worktree install and the OpenCode lanes surface as
red `pull_request` CI on unrelated PRs; e2e and Canary Dry Run breaks surface
only in a later PR's own `pull_request` e2e, which is not required (see above). While `master` is red that way, a queued PR whose own CI
passed before the bad landing can still be trimmed and land, until its PR-head
result passes the 72 h limit.

## When to turn the trim off

Set the kill switch when any of these is true:

- `master` went red (master-health or unrelated PRs failing the same test) on
  a failure that a trimmed lane would have caught. Keep it on until `master`
  is green again.
- A decision summary trimmed a lane that should have run.
- You are bisecting a queue problem and want every lane on every entry.

## How to turn it off, and back on

This is a repository variable, so it needs repository admin. Merge-group runs
created after the change run the full suite. The decision step and every
trimmed lane each read the variable, so a stale decision cannot keep a lane
trimmed once a lane sees `true`. Whether a run already in flight picks up the
new value is not verified: check that run's decision summary and lane notices.

```sh
# Full suite in merge_group (kill switch on)
gh variable set PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE --repo Blockcast/paperclip --body true

# Confirm: the next merge-group run's decision summary says
#   "kill switch PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE=true: full suite"
gh variable list --repo Blockcast/paperclip | grep PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE

# Trim again (kill switch off)
gh variable delete PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE --repo Blockcast/paperclip
```

Any value other than `true` (case-insensitive) leaves the trim on.

## Related

- `scripts/__tests__/merge-group-trim.test.mjs`: contract tests for both
  modes, the fail-open rules, the `pr.yml` wiring and the master-health gate.
- `scripts/vitest-flake-ledger.mjs` reads `merge_group` runs by default.
  Trimmed runs upload no server-shard reports, so use
  `--event pull_request` for server-suite flake data.
- [`merge-queue-stalled-head.md`](merge-queue-stalled-head.md) for a stuck,
  not failing, queue head.
