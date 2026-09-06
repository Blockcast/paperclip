# Track A landing log (2026-09-05 plan, executed 2026-09-06)

Plan: `docs/superpowers/plans/2026-09-04-in-review-truth-gate-and-landing-routines.md`
Tracking issue: [BLO-32238](https://paperclip.blockcast.net/BLO/issues/BLO-32238) (Track A of [BLO-32237](https://paperclip.blockcast.net/BLO/issues/BLO-32237))

All state below was measured against the live GitHub API on **2026-09-06 ~05:0x–05:3xZ**,
with `master` at `30c23389316b4b6cce44d28f68d79af12b7c4c02`.

## Headline

The plan's PR classification was written on 2026-09-04/05 and had **rotted by execution time**.
Of the 26 target PRs still open, **16 are `mergeStateStatus=DIRTY`** — they conflict with
current `master` and cannot enter the merge queue at all. That is the dominant finding, and it
reshapes both A1 and A2: no amount of finding-disposition lands a branch that will not merge.

## A1 — the 20 "clean" PRs

| PR | codeowned | state at 2026-09-06 | head | disposition |
|---|---|---|---|---|
| 1635 | no | MERGED 2026-09-04T10:01:40Z | — | merged before this run |
| 1627 | no | MERGED 2026-09-04T08:56:55Z | — | merged before this run |
| 1322 | no | MERGED 2026-09-05T05:58:22Z | — | merged before this run |
| 1609 | no | MERGED 2026-09-06T04:46:52Z | `30c23389` | merged before this run; is current `master` tip |
| 1588 | no | CLEAN, `verify` success | `83c4d70d` | **enqueued** (merge queue) — first, per plan |
| 1605 | no | CLEAN, `verify` success | `d134fd9c` | **enqueued** |
| 1600 | no | CLEAN, `verify` success | `529d300b` | **enqueued** |
| 1595 | no | CLEAN, `verify` success | `42665671` | **enqueued** |
| 1586 | no | CLEAN, `verify` success | `6a6f1a08` | **enqueued** |
| 1584 | no | CLEAN, `verify` success | `3e8e6ddc` | **enqueued** |
| 1596 | **yes** | CLEAN, `verify` success | `09ce54c8` | held — awaiting @kkroo (CODEOWNED); review already requested |
| 1585 | **yes** | CLEAN, `verify` success | `00b36ef4` | held — awaiting @kkroo (CODEOWNED); review already requested |
| 1467 | no | DIRTY, no `verify` at head | `b79f74ea` | rebase — [BLO-32247](https://paperclip.blockcast.net/BLO/issues/BLO-32247) |
| 1418 | no | DIRTY, no `verify` at head | `4a9c840a` | rebase — [BLO-32249](https://paperclip.blockcast.net/BLO/issues/BLO-32249) |
| 1309 | no | DIRTY, no `verify` at head | `61c45424` | rebase — [BLO-32250](https://paperclip.blockcast.net/BLO/issues/BLO-32250) |
| 1279 | no | DIRTY | `0d2081fa` | rebase — [BLO-32251](https://paperclip.blockcast.net/BLO/issues/BLO-32251) |
| 1219 | **yes** | DIRTY | `6f3aa374` | rebase + @kkroo — [BLO-32252](https://paperclip.blockcast.net/BLO/issues/BLO-32252) |
| 1195 | no | DIRTY | `4338f176` | rebase — [BLO-32253](https://paperclip.blockcast.net/BLO/issues/BLO-32253) |
| 1150 | **yes** | DIRTY | `62004b23` | rebase + @kkroo — [BLO-32254](https://paperclip.blockcast.net/BLO/issues/BLO-32254) |
| 1091 | no | DIRTY, no `verify` at head | `a5583c27` | rebase — [BLO-32255](https://paperclip.blockcast.net/BLO/issues/BLO-32255) |

4 already merged · 6 enqueued · 2 held on CODEOWNER · 8 rebase-blocked = 20.

### Gate evidence for the 6 enqueued PRs

Each was verified before enqueue against three independent gates:

1. **CI (CEO ruling BLO-26572)** — every check-run at head `success`/`neutral`/`skipped`;
   zero `failure`, zero `PENDING`, and `verify` present (never `ABSENT`).
2. **Ally review at the exact head** — the latest `## Ally — Consolidated PR Review` for each
   PR carries a single `Reviewed head:` line equal to the *current* `headRefOid`, with
   `### Critical Issues (0)` and `### Important Issues (0)`. No stale-head attestation was
   accepted, per the Track A rule.
3. **Not CODEOWNED** — no path matching `.github/**`, `skills/**`, `package.json`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `scripts/release*`,
   `scripts/create-github-release.sh`, `scripts/rollback-latest.sh`, or the
   `doc/{RELEASING,PUBLISHING,RELEASE-AUTOMATION-SETUP}.md` set.

No `--admin` merge was used anywhere. `master` carries a `merge_queue` rule and no
`pull_request` rule, so merges are enqueued with `gh pr merge --squash --auto` and the queue
owns the strategy.

## A2 — the 8 PRs with open Important findings

**All eight are DIRTY.** None can be merged at its current head.

| PR | author | head | Ally crit/imp at head | disposition |
|---|---|---|---|---|
| 1455 | app/allyblockcast | `de3f2cb3` | 0 / 1 | rebase-blocked; findings deferred to post-rebase re-review |
| 1361 | app/allyblockcast | `b0e94e77` | 0 / 1 | rebase-blocked; findings deferred |
| 1360 | app/allyblockcast | `bfe400dd` | 0 / 0 | rebase-blocked (already finding-clean) |
| 1277 | app/allyblockcast | `1f4b2290` | 0 / 1 | rebase-blocked; findings deferred |
| 1229 | **kkroo** | `77e52202` | 0 / 1 | **not merged — human-authored**; Track A bars agent merge. Needs @kkroo |
| 1141 | app/allyblockcast | `0d8852ff` | 0 / 1 | rebase-blocked; findings deferred |
| 1126 | app/allyblockcast | `2739ce09` | 0 / 1 | rebase-blocked; findings deferred |
| 1220 | app/allyblockcast | `c8e9268a` | 0 / 3 | rebase-blocked; findings deferred |

### Why the findings were deliberately *not* dispositioned at these heads

A2 asked for a `fixed | no-longer-applicable | still-present` ledger. Writing one now would be
discarded work: a rebase changes the head SHA, which retires the current `Reviewed head:`
attestation, and `dispositioned_finding_ids()` resolves `prior:` references against reviews
observable on the PR. The ledger has to be authored in the re-review that follows the rebase —
that is the only ordering that can actually land. Each PR carries a comment saying so.

## Conflict clusters (for whoever executes the rebases)

The 16 DIRTY PRs touch 14 distinct areas, so there is no single shared conflict and no one-shot
fix. Two clusters will re-conflict with each other and must be sequenced, not parallelised:

- **`server/src/services/heartbeat.ts`** — #1279, #1219, #1195, #1455, #1229
- **`packages/plugins/paperclip-plugin-alertmanager/src/constants.ts`** — #1360, #1277

## A3 — the 4 CI-failing gate PRs

| PR | state | head | disposition |
|---|---|---|---|
| 1471 | MERGED 2026-09-05T16:42:05Z | — | landed before this run |
| 1613 | MERGED 2026-09-05T13:01:05Z | — | landed before this run (kkroo-authored) |
| 1463 | OPEN, DIRTY, `review` = failure | `9fa22e6c` | rebase-blocked *and* red; two blockers |
| 1559 | OPEN, UNSTABLE, `review` = failure | `8ba99632` | red gate; `#1585` must land first (same guard script) |

## A4 — production deploy

**Not reached in this run, and deliberately not forced.** The merge queue is serial
(`maximumEntriesToBuild=1`) and each entry runs the full `PR` workflow on `arc-merge-queue`
runners; the entry ahead of the Track A batch had been building ~28 minutes when this log was
written. Dispatching `scheduled-production-deploy.yml` before the batch lands would ship a
`master` that does not contain the work this issue exists to deliver.

The deploy is the last step after the queue drains, and it is recorded here and on BLO-32238
when it has a run URL with `conclusion: success`.

## Correction recorded against my own earlier reading

While diagnosing why nothing was progressing I first concluded the merge queue was **stalled** —
the queue branch `gh-readonly-queue/master/pr-1674-30c23389…` existed and a listing of the 10
most recent workflow runs showed no run for it. That conclusion was **wrong**. A branch-filtered
query found the `PR` workflow `in_progress` on that exact branch since `2026-09-06T04:46:54Z`;
the run was simply outside the recency window of the unfiltered listing. The queue is slow, not
stuck. Recording it because "I did not find a run" is not "no run exists", and the difference
would have turned a slow queue into a fabricated incident.
