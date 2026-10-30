---
title: Recovering a stale graphify-reindex PR
summary: Why the staleness gate goes red on a graph PR, the measured decision against re-scoping or re-basing it, and the bounded recovery that does not wait for the weekly CronJob (PEN-5042)
---

# Recovering a stale graphify-reindex PR

`graphify staleness gate` (`.github/workflows/graphify-staleness.yml`) fails a PR
that would land a `graphify-out/graph.json` built before the base branch last
changed the tree it indexes. The verdict is a true statement about the artifact;
this runbook is about what to *do* about it, and about three remedies that look
obvious and do not work.

## TL;DR

A graphify PR cannot be brought up to date by any git operation. `built_at_commit`
is a field **inside `graph.json`**, not a git relationship, so neither a rebase nor
a merge moves it. Regenerate the branch instead:

```sh
git fetch origin master
git worktree add --detach /tmp/graphify origin/master   # leave the shared checkout alone
cd /tmp/graphify
graphify update server/src --force                      # ~5-7 min, no LLM key needed
git checkout --no-track -B graphify-regen origin/master # local name, deliberately NOT the PR branch
git commit -am "chore: refresh knowledge graphs @ $(git rev-parse --short origin/master)"

EXPECTED=$(git rev-parse origin/bot/graphify-reindex)   # the head you are replacing
git push --force-with-lease=refs/heads/bot/graphify-reindex:"$EXPECTED" \
         origin graphify-regen:bot/graphify-reindex
```

Two details in there are load-bearing, not style:

- **`--no-track`, and a local branch name that is not the PR branch.** `git checkout
  -B bot/graphify-reindex origin/master` sets the new branch's upstream to
  `origin/master`, so a later bare `git push` refuses with *"The upstream branch of
  your current branch does not match the name of your current branch"* and helpfully
  suggests `git push origin HEAD:master` — which would land the graph commit on
  `master`. Reusing the PR branch's own name also collides with the primary checkout
  (`fatal: 'bot/graphify-reindex' is already used by worktree at …`) whenever it is
  checked out there, which is the common case for whoever has the PR open.
- **A lease with an explicit sha.** A bare `--force-with-lease` takes its expectation
  from the remote-tracking ref, which any `fetch` in the same run can advance, so it
  protects nothing; the fleet's egress wrapper refuses it outright for that reason.

Measured cost: **5m04s** and **6m40s** on two runs (1350 files, 64 workers; the
second had a competing build on the same box). No LLM key and no CronJob are
involved, which is the whole point — the recovery does not wait for the weekly
refresh.

The rebuild rewrites three tracked files — `graph.json`, `GRAPH_REPORT.md` and
`.graphify_labels.json` — and leaves `graph.html`, `manifest.json`, `cache/` and
the dated directory untracked, all of which `graphify-out/.gitignore` already
excludes. So `git commit -am` stages exactly the right set.

> **One thing the manual path does not carry: curated community names.** The
> reindex CronJob runs `carry-graphify-labels.py` to re-key a community name a
> human wrote; that script lives in the job's tooling, not in this repo, so a
> manual regeneration lets graphify's own hub-derived names stand. Today that
> costs nothing — all 515 entries in `.graphify_labels.json` are already machine
> names, with no `Community N` placeholders and no human prose. If that ever
> stops being true, re-apply the names by hand or let the CronJob do the refresh.

## Why a merge or a rebase cannot work

`graphify` stamps `built_at_commit` with `HEAD` at build time. That single fact
produces all three failure shapes:

| what you do | `built_at_commit` becomes | gate says |
|---|---|---|
| nothing, master advances | the old base commit | `STALE graph — base changed 'server/src'` |
| `git rebase origin/master` | *unchanged* — it is file content | still `STALE` |
| `gh pr update-branch`, then rebuild in place | the **merge** commit | `built_at_commit … is not an ancestor of base` |
| reset onto the tip, then rebuild | the current base tip | `OK: … is fresh` |

The third row is the trap, and until PEN-5042 the gate's own error text walked you
into it: it said `Rebuild: graphify update <scope> --force`, which is the right
command run in the wrong place. Verified by running the workflow's `run:` block
against a worktree of #3005's head after doing exactly that:

```
::error file=server/src/graphify-out/graph.json::built_at_commit 474dd5ea45c4 is not
  an ancestor of base 86bfe2a2b332 (graph built off an unknown line)
```

and against a branch regenerated from the tip:

```
OK: server/src/graphify-out/graph.json is fresh (built_at 86bfe2a2b332)
```

Both shapes are now pinned by `scripts/__tests__/graphify-staleness-gate.test.mjs`.

> This is also why `AGENTS.md` §7's "bring a PR up to date by rebasing it, never
> with a merge commit" is necessary but **not sufficient** here. For a graphify PR
> the rebase is not merely the wrong tool, it is a no-op against this gate.

## What was measured (2026-10-30, PEN-5042)

Window: `7bd3bd8145df` (the commit `master`'s committed graph was built at,
2026-10-18 05:25 UTC) → `master` tip `16fbb8aef3f1` (2026-10-29 18:12 UTC), 11.5 days.

**Invalidation rate.** 598 first-parent commits landed on `master`; **269 (45.0%)
touched `server/src` outside `graphify-out/`**, so 269 of them invalidate a
committed graph under the gate's predicate — ≈23.4/day.

**Mergeable window.** For each of the 11 historical refreshes, the time from
`built_at_commit` to the first `master` commit that invalidates it:

```
0h23m  0h33m  1h47m  2h16m  3h38m  3h50m  6h44m  7h00m  8h22m  23h10m  28h33m
                                   median 3h50m
```

Against a **weekly** producer that is a window of 2.3% of the cycle.

**Is `server/src` too coarse a scope?** No — this was the hypothesis the issue
preferred, and the measurement refutes it. Of the 695 files those 269 commits
changed under `server/src`, **695 (100%) are `.ts`**: there is no non-code slack to
reclaim. 225 of the 269 (83.6%) touch non-test production code; excluding tests
from the scope would suppress only the other **44 (16.4%)**, widening the median
window by 1.20× — 3h50m to ~4h36m — while deleting 29.4% of the graph's nodes and
25.7% of its links, which are what test files contribute.

**Would comparing graph *content* instead of commits help?** Partly, and not
enough. Rebuilding the graph at consecutive invalidating commits (deterministic:
a repeat build of the same tree reproduces the fingerprint exactly) shows that
every such commit changes the graph *file*, because nodes carry `source_location`
and any line shift moves it. About half leave the structural content — node ids
plus `(source, target, relation)` edges — untouched. So the gate's commit-diff
proxy has no false positives against the artifact it is protecting, and even an
exact structural comparison would roughly halve 23.4/day, still two orders of
magnitude short of closing a 168h cycle.

## The gate is not what held #1550 for 49 days

Worth stating plainly, because PEN-5042 was filed on the opposite assumption.

`staleness` is **not a required check.** GraphQL `isRequired` reports it `false`
on every reindex PR sampled (#3005, #1550, #1384, #944, #789, #731, #647); the
contexts that came back `true` there were `verify` — the one `AGENTS.md` §7 names
— and `gate/ally-comment-findings`. That direction of the reading is the sound
one: the query enumerates only contexts that actually reported, so it can omit a
requirement but cannot invent one, and `staleness` did report on all seven.

It also runs on `pull_request` only, so **a recorded verdict does not decay.** It
is re-evaluated when the head moves, never because `master` moved — which is the
load-bearing correction to the issue's premise that "every subsequent minute makes
the PR less mergeable".

Across all 25 runs on `bot/graphify-reindex` from 2026-07-08 to 2026-10-29, split
by whether the run sat on the producer's own weekly slot (Sunday, 05:30-06:40 UTC):

| | runs | success | failure |
|---|---|---|---|
| on-cadence | 16 | 15 (+1 cancelled) | **0** |
| off-cadence | 9 | 5 | **4** |

Every failure — 2026-08-04 23:34, 2026-10-12 01:22, 2026-10-14 11:41, 2026-10-29
17:42 — was an off-cadence head update. The gate has never once fired on its
producer's cadence; it fires when something touches the head, which is exactly
what trying to unblock the PR does.

#1550 carried 11 heads over its 49 days. `staleness` was red on 2 of them, and on
both the `PR` workflow was red too, so it was never the only thing red. The other
heads failed on `General tests (workspaces-b)`, `Canary Dry Run`, `ally-verdict`,
and `policy` (PEN-5025's `ENOBUFS`) — four distinct causes. The one head that was
fully green, `a61c8b96`, merged **8h10m** later. #944 was not blocked either: its
final head had `staleness` green, and it was closed because a human superseded it
(`kkroo/graphify-refresh-current-master`, 2026-08-09).

> Evidence limit: three of #1550's heads were force-pushed away and the commit API
> returns `422` for them, so their verdicts are read from workflow-run conclusions
> rather than per-head statuses.

#3005 is the clean instance of the real mechanism: green when the bot opened it on
2026-10-25 06:30, red at 2026-10-29 17:42 — the timestamp of the `update-branch`
merge commit `474dd5ea` taken under PEN-5025.

## Decision (PEN-5042)

| option | verdict | basis |
|---|---|---|
| Scope the comparison tighter than `server/src` | **rejected** | 100% of changed files are `.ts`; tests are only 16.4% of invalidating commits and 29% of the graph. Buys 1.20×. |
| Compare against the PR's merge base, not the live tip | **rejected** | It is the regression this gate was built to fix — #1550 sat 98 commits behind with `staleness` green. Pinned by the workflow header and its test. |
| Raise the CronJob cadence | **rejected** | The gate has never failed on-cadence (0 failures in 16 runs). Cadence is not the failure axis. |
| Have the gate re-dispatch the builder | **narrowed and deferred** | The loop is worth closing, but not by giving an evaluating gate a write path — compare `review-gate-merge-group.yml`'s deliberate `permissions: {}`. Wants an operator-dispatched rebuild (`workflow_dispatch`) and owner sign-off on the push credential. |
| **Make the printed remedy correct, and document the recovery** | **adopted** | The measured defect is not the comparison point; it is that the remedy the gate prints does not work on the branch it prints it on, and that path had no test. |

What this does and does not close: the recovery is now bounded and self-service —
≈5 minutes, available to anyone with the repo, no dependency on the weekly
CronJob. It does **not** make an update-branch safe on a graphify PR, and it does
not automate regeneration. If the reindex PR starts needing manual regeneration
often, revisit the deferred option with that frequency as its justification.
