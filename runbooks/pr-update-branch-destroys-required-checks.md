# A PR head with zero checks after `update-branch` — do not sync, enqueue

Source: [BLO-22647](/BLO/issues/BLO-22647) (release of
[#1111](https://github.com/Blockcast/paperclip/pull/1111) deadlocked for three
days). Trigger: `enqueuePullRequest` / `gh pr merge` refuses an approved,
up-to-date PR with

```
Required status check "verify" is expected.
```

while `gh pr checks` shows nothing at all at the head. Owner: Platform/SRE
(gstack).

## Do this first — the one-line rule

**On a repository with a merge queue, never call
`PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`, and never merge the base
branch into a PR branch by hand.** A PR being `BEHIND` is not a reason to sync
it. The queue rebases each entry onto the current base and runs the required
checks itself in the `merge_group` context — syncing beforehand buys nothing
and, on this repository, deterministically breaks the PR.

`master` on `Blockcast/paperclip` is governed by the `Merge Queue Capacity
Guard` ruleset:

| parameter | value |
|---|---|
| `merge_method` | `REBASE` |
| `max_entries_to_build` | 1 |
| `grouping_strategy` | `ALLGREEN` |
| `check_response_timeout_minutes` | 360 |

## Why it deadlocks, and why it is deterministic rather than a race

`update-branch` creates a **merge commit** on the PR head (author = the calling
App, committer = `web-flow`). Two independent things then go wrong, and either
one alone is fatal:

1. **The new head gets no `pull_request` workflow run**, so no
   `github-actions` check suite is ever created for it. The required `verify`
   context is enforced on the *PR head* at enqueue time, so it can never
   report, and the PR can never be enqueued. This is not a slow check — it is
   a check that will never exist.
2. **The merge commit makes the branch non-rebaseable.** `mergeable` /
   `mergeable_state` describe a *merge*; the queue performs a *rebase*. A
   branch carrying merge commits reads `mergeable_state: clean` while
   `rebaseable: false`, and GitHub fails the rebase at head-of-queue and
   dequeues it **before creating any `merge_group` build**. See
   [BLO-27143](/BLO/issues/BLO-27143).

Failure (1) hides failure (2): you cannot even reach the queue to discover the
branch would have been ejected from it.

### Measured on #1111

| head | how it was created | workflow runs at that SHA |
|---|---|---|
| `9f87c108` | `update-branch` API | **0** — no `github-actions` check suite at all |
| `65f4c718` | an ordinary `git push` | `PR` (`pull_request`) **success**, plus `Storybook Visual`, `commitperclip PR Review` |

Reproduce either row with:

```bash
gh run list --repo Blockcast/paperclip --commit <sha> \
  --json databaseId,name,event,status,conclusion
```

## What does *not* rescue a head that has already lost its checks

All of these were tested on #1111 and none of them created a workflow run.
Do not spend a second run re-testing them:

| attempt | result |
|---|---|
| close + reopen the PR | **no run created**, on any workflow — even though `reopened` is in `pr.yml`'s default `pull_request` activity set |
| draft → ready | not in the default activity set; no run |
| re-run / re-request the Actions check suite | impossible — there is no `github-actions` suite at that head to re-request |
| re-merge the base again | the PR is already `ahead=N behind=0`, so this is a no-op commit |

Only a **real push that changes the tree** emits `synchronize` and attaches the
checks. That is what unstuck #1111, and it is why this runbook is about
prevention: once `update-branch` has run, every remaining option is either a
no-op commit, a force push, or a branch-protection bypass.

> This is an empirical result, not a mechanism. The `pull_request` run at
> `65f4c718` was itself triggered by an App-authored push, and 48 of the last
> 100 `pull_request` runs on this repo are App-triggered — so this is **not**
> blanket suppression of App events. Only the `update-branch` ref update, and
> the non-push PR transitions attempted at that head, failed to produce a run.

## The supported path

For a PR that is behind its base:

```bash
# 1. Confirm the required checks are green at the CURRENT head. Do not sync.
gh pr view <n> --repo Blockcast/paperclip \
  --json mergeable,mergeStateStatus,reviewDecision,autoMergeRequest

# 2. Enqueue. The queue rebases onto master and runs merge_group checks.
gh pr merge <n> --repo Blockcast/paperclip --rebase
```

`gh pr merge` on a queue-protected branch prints

```
! The merge strategy for master is set by the merge queue
```

That is a **warning, not a failure** — the PR has been enqueued. Confirm by
reading the queue entry back; do not trust the exit code, and do not read
`state` / `mergedAt`, which stay `OPEN` / `null` for as long as it sits in the
queue:

```bash
gh api graphql -f query='{ repository(owner:"Blockcast", name:"paperclip") {
  mergeQueue(branch: "master") {
    entries(first: 20) { totalCount nodes { position state
      pullRequest { number } } } } }'
```

If the PR genuinely has a merge conflict with the base (`mergeable_state:
dirty`), that is the one case that does need branch work — resolve it by
squash-linearizing onto the base, never by merging the base in, or you
re-create failure (2) above:

```bash
git fetch origin master
git switch -c <branch>-linear origin/master
git merge --squash <pr-head> && git commit
# prove content is preserved before force-pushing:
git rev-parse HEAD:<file>            # compare to:
git rev-parse <pr-head>:<file>
```

## Related

- [`merge-queue-stalled-head.md`](merge-queue-stalled-head.md) — the *other*
  merge-queue failure: an entry that did reach the queue but whose
  `merge_group` check never terminates.
- [BLO-27143](/BLO/issues/BLO-27143) — the `rebaseable: false` ejection, i.e.
  failure (2) above, observed on its own.

## Verifying signal

- `gh run list --repo Blockcast/paperclip --commit <head>` returns a `PR` run
  for every open PR head, and `gh pr merge` is never answered with
  `Required status check "verify" is expected.` on an approved PR.
- No commit on `master` has `web-flow` as committer with the
  `Merge branch 'master' into ...` subject shape:

  ```bash
  git log origin/master --format='%H %cn %s' | grep "Merge branch 'master' into"
  ```
