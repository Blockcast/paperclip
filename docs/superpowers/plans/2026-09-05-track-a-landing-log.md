# Track A landing log (2026-09-05 plan, executed 2026-09-06)

Plan: `docs/superpowers/plans/2026-09-04-in-review-truth-gate-and-landing-routines.md`
Tracking issue: [BLO-32238](https://paperclip.blockcast.net/BLO/issues/BLO-32238) (Track A of [BLO-32237](https://paperclip.blockcast.net/BLO/issues/BLO-32237))

The 2026-09-06 sections below were measured against the live GitHub API on
**2026-09-06 ~05:0x–05:1xZ**, with `master` at `30c23389316b4b6cce44d28f68d79af12b7c4c02`.
The execution section at the end carries its own, later measurement window.

> **Current status (2026-09-10T17:1xZ) — 9 of 11 landed and all nine are in production**
> at `ac3386b9667cf0f422d18f42130399c659bcfcac`, both tiers agreeing, every merge
> `behind_by: 0`. Two remain open: **#1596** (criterion 5, kkroo) and **#1595** (an authoring
> decision on 27 conflicting files under
> [BLO-32317](https://paperclip.blockcast.net/BLO/issues/BLO-32317)). Jump to
> *RESOLVED 2026-09-10T12:17:34Z* at the end for the deploy proof. **This document is a log:
> the dated sections below are preserved as written, including the readings that later turned
> out to be wrong — the corrections are recorded in place rather than by editing history.**

## Headline

The plan's PR classification was written on 2026-09-04/05 and had **rotted by execution time**.
Of the **24** target PRs still open (A1 + A2 scope, matching the tally at the end of A1),
**16 are `mergeStateStatus=DIRTY`** — they conflict with current `master` and cannot enter the
merge queue at all. That is the dominant finding, and it reshapes both A1 and A2: no amount of
finding-disposition lands a branch that will not merge.

> Counting note: A1 has 20 rows of which 4 are already `MERGED` → 16 open; A2 has 8 rows, all
> open → 24 open in total. A3's 2 open PRs are *not* folded in here; if they were, #1463 is
> itself `DIRTY` and the DIRTY count would be 17, not 16.

## A1 — the 20 "clean" PRs

| PR | codeowned | state at 2026-09-06 | head | disposition |
|---|---|---|---|---|
| 1635 | no | MERGED 2026-09-04T10:01:40Z | — | merged before this run |
| 1627 | no | MERGED 2026-09-04T08:56:55Z | — | merged before this run |
| 1322 | no | MERGED 2026-09-05T05:58:22Z | — | merged before this run |
| 1609 | no | MERGED 2026-09-06T04:46:52Z | `ad4664bd0a407f3d71ea8c4c935ac80e05c3cc33` | merged as `30c23389316b4b6cce44d28f68d79af12b7c4c02`, which is the current `master` tip |
| 1588 | no | CLEAN, `verify` success | `83c4d70df4156a72f6996bec2b7667e653b392d5` | **enqueued** (merge queue) — first, per plan |
| 1605 | no | CLEAN, `verify` success | `d134fd9c908e5b4239723a484541f03419d1e936` | **enqueued** |
| 1600 | no | CLEAN, `verify` success | `529d300b76b8a4bcd9c7d2da63d57300708852d4` | **enqueued** |
| 1595 | no | CLEAN, `verify` success | `42665671673a7873296334006ad675f7d2c8f617` | **enqueued** |
| 1586 | no | CLEAN, `verify` success | `6a6f1a08758d3bd9e5d3dac34e68c76bcac3bc9e` | **enqueued** |
| 1584 | no | CLEAN, `verify` success | `3e8e6ddc2cc42a6722e41cb69f8e86efd64619d8` | **enqueued** |
| 1596 | **yes** | CLEAN, `verify` success | `09ce54c8867eed6a36ad6cc621fed5e5cc9a57a4` | held — awaiting @kkroo (CODEOWNED); review already requested |
| 1585 | **yes** | CLEAN, `verify` success | `00b36ef46de4f0581d2e95378c724fe47b32aac4` | held — awaiting @kkroo (CODEOWNED); review already requested |
| 1467 | no | DIRTY, no `verify` at head | `b79f74eaabc12afe7b5e579afd19ec962ba20e1e` | rebase — [BLO-32247](https://paperclip.blockcast.net/BLO/issues/BLO-32247) |
| 1418 | no | DIRTY, no `verify` at head | `4a9c840a740c555fd46eb08ae2e22d898c2ad0d2` | rebase — [BLO-32249](https://paperclip.blockcast.net/BLO/issues/BLO-32249) |
| 1309 | no | DIRTY, no `verify` at head | `61c454245432aa3c7c56bedb8b634154489bc726` | rebase — [BLO-32250](https://paperclip.blockcast.net/BLO/issues/BLO-32250) |
| 1279 | no | DIRTY | `0d2081fa089c5b1027f2f3349aa8738569e55c6b` | rebase — [BLO-32251](https://paperclip.blockcast.net/BLO/issues/BLO-32251) |
| 1219 | **yes** | DIRTY | `6f3aa37464b1aa2bb5c70a7e49a5550a9c03e1f1` | rebase + @kkroo — [BLO-32252](https://paperclip.blockcast.net/BLO/issues/BLO-32252) |
| 1195 | no | DIRTY | `4338f176dacb66efcd3635ca7c2c7cfb84684d84` | rebase — [BLO-32253](https://paperclip.blockcast.net/BLO/issues/BLO-32253) |
| 1150 | **yes** | DIRTY | `62004b2331b4af0f8d99f78f53689f947d12765b` | rebase + @kkroo — [BLO-32254](https://paperclip.blockcast.net/BLO/issues/BLO-32254) |
| 1091 | no | DIRTY, no `verify` at head | `a5583c27bc8df1600ca20868a6f94639262234de` | superseded post-commit — **closed, not rebased** (the same identity closed it at 05:23:43Z, "closing as superseded"); [BLO-32255](https://paperclip.blockcast.net/BLO/issues/BLO-32255) is resolved |

4 already merged · 6 enqueued · 2 held on CODEOWNER · 8 rebase-blocked = 20.

### Gate evidence for the 6 enqueued PRs

Each was verified before enqueue against three independent gates:

1. **CI (CEO ruling BLO-26572)** — every check-run at head `success`/`neutral`/`skipped`;
   zero `failure`, zero `PENDING`, and `verify` present (never `ABSENT`).

   > **Superseded 2026-09-10, and recorded rather than rewritten.** This is what the gate
   > *was* when these six were enqueued on 2026-09-06, so it stays as the historical record.
   > But accepting `neutral`/`skipped` is exactly the reading Ally flagged three times as
   > conflicting with [BLO-26572](https://paperclip.blockcast.net/BLO/issues/BLO-26572), and
   > the reusable routine no longer contains it — criterion 3(c) of the plan document now
   > requires `SUCCESS` with no allowlist and records `SKIPPED`/`NEUTRAL` as a
   > `policy-hold:<name>=<state>` skip. Do not copy the line above into a new routine.

2. **Ally review at the exact head** — the latest `## Ally — Consolidated PR Review` for each
   PR carries a single `Reviewed head:` line equal to the *current* `headRefOid`, with
   `### Critical Issues (0)` and `### Important Issues (0)`. No stale-head attestation was
   accepted, per the Track A rule.
3. **Not CODEOWNED** — no path matching `.github/**`, `skills/**`, `package.json`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `scripts/release*`,
   `scripts/create-github-release.sh`, `scripts/rollback-latest.sh`, or the
   `doc/{RELEASING,PUBLISHING,RELEASE-AUTOMATION-SETUP}.md` set.

No `--admin` merge was used anywhere. `master` carries a `merge_queue` rule and no
`pull_request` rule, so merges are enqueued with `gh pr merge --auto` and the queue owns the
strategy.

> **Correction (2026-09-08).** This paragraph originally read `gh pr merge --squash --auto`.
> That flag is wrong on this repo and the instruction has been withdrawn: the `merge_queue`
> rule sets `merge_method: REBASE`, so the queue — not the caller — chooses the strategy, and
> naming a conflicting one invites a caller to linearize by hand. Enqueue with a bare `--auto`.
> Never `--squash`, never `--admin`.

## A2 — the 8 PRs with open Important findings

**All eight are DIRTY.** None can be merged at its current head.

| PR | author | head | Ally crit/imp at head | disposition |
|---|---|---|---|---|
| 1455 | app/allyblockcast | `de3f2cb37a82c4b9ac92062066153d1d4ed882cd` | 0 / 1 | rebase-blocked; findings deferred to post-rebase re-review |
| 1361 | app/allyblockcast | `b0e94e77a7229a374b272e305a52cb11e67c1ff8` | 0 / 1 | rebase-blocked; findings deferred |
| 1360 | app/allyblockcast | `bfe400dd2f309aabe74a670e7d636333c22bfa30` | 0 / 0 | rebase-blocked (already finding-clean) |
| 1277 | app/allyblockcast | `1f4b2290dfde243a7a348779cf4358abf1d14f41` | 0 / 1 | rebase-blocked; findings deferred |
| 1229 | **kkroo** | `77e52202b1a27844da274bb6d25c063efd2d9ad3` | 0 / 1 | **not merged — human-authored**; Track A bars agent merge. Needs @kkroo |
| 1141 | app/allyblockcast | `0d8852ff7b68c1a46dcc33615ec93f5fcab5a135` | 0 / 1 | rebase-blocked; findings deferred |
| 1126 | app/allyblockcast | `2739ce0944088fd8f2febe7bdfd5d3b6167c7abb` | 0 / 1 | rebase-blocked; findings deferred |
| 1220 | app/allyblockcast | `c8e9268adff2e57d7b6d1d1180d70a015a06c095` | 0 / 3 | rebase-blocked; findings deferred |

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
| 1463 | OPEN, DIRTY, `review` = failure | `9fa22e6c869b100d0b630495c3233cae6827e8ca` | rebase-blocked *and* red; two blockers |
| 1559 | OPEN, UNSTABLE, `review` = failure | `8ba996328cf0b75d909346dc3d0fcdb65348e86b` | red gate; `#1585` must land first (same guard script) |

## A4 — production deploy

**Not reached in this run, and deliberately not forced.** The merge queue is serial
(`maximumEntriesToBuild=1`) and each entry runs the full `PR` workflow on `arc-merge-queue`
runners; the entry ahead of the Track A batch had been building ~28 minutes when this log was
written. Dispatching `scheduled-production-deploy.yml` before the batch lands would ship a
`master` that does not contain the work this issue exists to deliver.

The deploy is the last step after the queue drains, and it is recorded here and on BLO-32238
when it has a run URL with `conclusion: success`. See the execution section below for its
state as of 2026-09-08.

## Execution (2026-09-07 → 2026-09-08)

Measured live **2026-09-08 ~21:2x–21:4xZ**. Executor: Release Engineer, under
[BLO-32573](https://paperclip.blockcast.net/BLO/issues/BLO-32573); re-review is Ally's slice
under [BLO-32565](https://paperclip.blockcast.net/BLO/issues/BLO-32565).

By the time execution began, the A1 list above had decayed further: 8 of the 20 had already
merged and #1091 was closed, leaving **11 PRs** actually in scope. Seven of those have since
landed; four remain open, each on a named, unmet criterion with a named owner.

### Enqueue gate

Every enqueue was gated on all of the following, re-read at the current head in the same run as
the enqueue, per the CEO's fleet-binding ruling
[BLO-26572](https://paperclip.blockcast.net/BLO/issues/BLO-26572):

1. `state: OPEN`, not draft; `mergeStateStatus ∈ {CLEAN, UNSTABLE}`; `reviewDecision !=
   REVIEW_REQUIRED`.
2. Every check-run at head `success`. `ABSENT` is a stop, not a pass.
3. `gate/ally-comment-findings` = `success` **and its `description` read**, not just its
   conclusion. On this repo `success` is ambiguous: *"No Ally consolidated-review comment
   attests to reviewing this head"* means nobody reviewed the head (a stop), whereas *"reports
   no unresolved findings"* means reviewed and clean. The `review/ally-complete` context does
   not exist here; `review/ally-comment` is retired and defers to the gate above.
4. `rebaseable: true` **and** no commit on the branch has two parents
   (`pulls/<n>/commits --jq '[.[]|.parents|length]'`). `rebaseable` alone under-reports — #1595
   reports `rebaseable: true` while carrying a merge commit mid-branch.
5. If CODEOWNED, an `APPROVED` review from **kkroo** (id 1845185) at the current head — read
   `.state`, never the prose.

`skipped` and `neutral` conclusions were treated as advisory rather than stops, on measured
precedent and not on judgement: `Storybook visual regression = skipped` and
`security-review = neutral` are the state at head of **every** PR in this batch that has
already landed through the queue.

#### How criterion 2 must be *implemented* — a field-shape trap worth its own note

Criterion 2 above reads "every check-run at head `success`", which is correct as a policy but
under-specifies the read. `gh pr view --json statusCheckRollup` returns **two entry shapes that
do not share a field**, and getting this wrong silently disables the most important gate:

| `__typename` | field carrying the verdict | the other field |
|---|---|---|
| `CheckRun` | `.conclusion` | `.state` is `null` |
| `StatusContext` | `.state` | `.conclusion` is `null` |

`gate/ally-comment-findings` is a **`StatusContext`**. Measured at `#1685` head
`44f539c61b341d3320fc8885109aacd8eacf17c7` on 2026-09-08 it returns
`{conclusion: null, state: "FAILURE"}`. So a predicate written against `.conclusion` alone sees
`null` on the findings gate — a value in neither the accept list nor the reject list, i.e.
**undefined behaviour precisely where a wrong answer merges unreviewed code**. An in-flight
`CheckRun` is the same trap mirrored: `gh` reports `conclusion: ""` while `status` is
`queued`/`in_progress`, also in neither list.

Two consequences for any implementation:

- Read `.state` for `StatusContext` and `.conclusion` for `CheckRun`; treat `null` and `""` as a
  **stop**, not as an unknown to be skipped over.
- Guard emptiness *before* the "every entry passes" test. That test is vacuously TRUE on an empty
  rollup, so a head with no checks at all reads as fully green — the `ABSENT` case BLO-26572 names
  as a stop, arriving through a quantifier rather than through a status value.

The same defect existed in the reusable `Land clean-reviewed PRs` routine in the companion plan
document and was corrected on 2026-09-08 in this PR: that routine accepted `NEUTRAL`/`SKIPPED`
for *any* entry (so a `skipped` `verify` would have passed), read only `.conclusion`, and had no
emptiness guard. Its allowlist is now keyed on check **name** rather than conclusion class.
Note that the naive repair — "require every check-run to be `SUCCESS`" — is **unsatisfiable
here**: all four of the most recently landed PRs (#1418, #1309, #1219, #1467) carry
`Storybook visual regression = skipped`, so a blanket predicate matches zero PRs and turns the
routine into a no-op that is indistinguishable from one that is working.

### Final dispositions — the 11

| PR | disposition | merge SHA / unmet criterion | owner |
|---|---|---|---|
| 1195 | **MERGED** 2026-09-07T21:11:31Z | `8ddfca0809c1d21366c1c54f588ff5a77664b2ca` | — |
| 1279 | **MERGED** 2026-09-07T17:58:40Z | `a32d5a5e2fe88225f76c9effd168daa88e801563` | — |
| 1586 | **MERGED** 2026-09-07T22:33:26Z | `2ebf80098065336c3264462bb983eb16acdcbca9` | — |
| 1467 | **MERGED** 2026-09-08T01:19:06Z | `79f85d056e27c61f6d86ef6b30a810c78d6ae51b` | — |
| 1219 | **MERGED** 2026-09-08T09:40:57Z | `70a9df918d2d250d5dfb536c15069e5015739b34` | — |
| 1309 | **MERGED** 2026-09-08T10:41:08Z | `a589aea8bb990d11d5d987216b8dc4089b74a4a2` | — |
| 1418 | **MERGED** 2026-09-08T17:40:44Z | `b9ec8590c0cb4cf0eae539ce9e8591473765ecb9` | — |
| 1585 | **MERGED** 2026-09-09T22:54:18Z | `d0613f40f2e52267a7d94b4fb3019f5a491d2155` | — |
| 1150 | **MERGED** 2026-09-09T23:49:23Z | `3e85318c0f454d42d5e60cbfbcc11935a66d2078` | — |
| 1596 | OPEN | **criterion 3**: `gate/ally-comment-findings` **ABSENT** at `09ce54c8867eed6a36ad6cc621fed5e5cc9a57a4` — only the retired `review/ally-comment` is present, so the head is unattested, not clean. Then criterion 5 | **Ally**, then kkroo |
| 1595 | OPEN | **criteria 1, 2, 3 and 4**: `mergeStateStatus: DIRTY` / `mergeable: false` at `06b2cb20811d3dd46b44a12f6fc7bfad1014abae`; `verify` and `General tests (server 3/4)` are `failure`; gate is `failure` ("carries an unresolved finding"); and the branch has a merge commit (parents `[1,1,1,1,1,1,1,2]`) needing squash-replay linearization | **Ally**, then a linearization pass |

**9 of the 11 have landed.** Every one has a corresponding `gh-readonly-queue/master/pr-<n>-*`
build under `actions/runs?event=merge_group` — the positive proof that the queue rebased and
built the entry rather than silently evicting it — and every merge SHA returns `behind_by: 0`
against `master`, i.e. is a true ancestor.

> **Update 2026-09-09 22:54Z / 23:49Z — #1585 and #1150 landed, and criterion 5 was satisfied by
> a merge rather than by a review.** Both were held on criterion 5 (no `APPROVED` review from
> kkroo). kkroo resolved them by **enqueueing them directly**, not by approving: `merged_by` is
> `kkroo` (`type: User`) on both, and neither carries an `APPROVED` review at any head — every
> review on both is still `allyblockcast[bot]` / `COMMENTED`.
>
> This is worth recording precisely, because it is the case the fleet rules single out. A human
> org-admin merging on their own repo is **explicitly not** an agent decision and is not governed
> by [BLO-26572](https://paperclip.blockcast.net/BLO/issues/BLO-26572). It also does **not**
> retroactively authorise an executor to merge #1596 on the same reasoning: per that ruling's own
> wording, *precedent is not authorization*. Criterion 5 therefore still binds #1596 and it was
> **not** merged here. The two landings are recorded as resolved-by-owner, not as evidence that
> the criterion was optional.
>
> Both went through the queue rather than around it — `pr-1585-b649fc74` and `pr-1150-d0613f40`
> queue builds are present and green, so this was a normal enqueue by an identity that satisfies
> the gate, not an `--admin` bypass.

**No PR was evicted for carrying a merge commit**, because criterion 4 was applied with the
parent-count check rather than `rebaseable` alone. **`gh pr update-branch` was never invoked
against this repository**: on a `merge_queue` repo it merges base into head, produces a merge
commit, and causes a silent head-of-queue eviction with no build
([BLO-22300](https://paperclip.blockcast.net/BLO/issues/BLO-22300)). A `BEHIND` reading needs no
action — the queue rebases each entry onto current base when it builds. But `BEHIND` masks
everything behind it: #1309 was `BEHIND` *and* carried a failing `verify`, a failing findings
gate, and a merge commit. Never diagnose a `BEHIND` PR from the `BEHIND` reading alone.

### The CODEOWNERS gate is requested, not required

Worth recording because it is counter-intuitive, and because it is now the only thing standing
between #1596 and the queue. The sole rule on `master` is `merge_queue` — there is no
`pull_request` rule, no `required_approving_review_count`, and no `required_status_checks`.
Consistent with that, all four open PRs read `reviewDecision: null` rather than
`REVIEW_REQUIRED`; the CODEOWNERS entry *requests* kkroo but no ruleset enforces the request.
Criterion 5 was nonetheless applied as written, and neither #1150 nor #1596 was merged by the
executor. Whether the criterion should bind where no ruleset enforces it is a routing decision
for the issue owner, not one for the executor to take on the strength of having measured it.

> **Resolved in practice for #1150 and #1585, but not as a matter of policy** (see the update
> above). kkroo enqueued both on 2026-09-09 without posting an `APPROVED` review, so criterion 5
> was never satisfied on its own terms — it was made moot by the owner acting directly. The
> question of whether the criterion binds an *executor* where no ruleset enforces it is still
> open, and #1596 is still held on it.

### A4 — deploy not dispatched, and why

The stale slot cleared on its own: run `34019412658`, which had been `waiting` ~33h on
environment `paperclip-production` pinned to the 44-commits-stale `9e84e8e242e32cb9d1df1da50469880380641432`, went `cancelled`
at 2026-09-08T16:22:32Z, and the associated board card auto-closed. No `waiting` run remains, so
the fleet-wide deploy mutex is free.

**The deploy is still blocked, on the image rather than on the slot.** `Docker` /
`build-and-push` on `master` has failed **8 consecutive times** (runs #1680–#1687), cleanly
bisected: last green `a589aea8bb990d11d5d987216b8dc4089b74a4a2` at 2026-09-08T10:41:10Z (#1679), first red `34345a9983979ba96afd4f37bb32de7668a636c7` at
11:45:46Z (#1680). The cause is
[PR #1711](https://github.com/Blockcast/paperclip/pull/1711), which added a Dockerfile stage
fetching from the private `Blockcast/penstock-llm-proxy-core` using a credential scoped to
`kkroo/*` vendor clones, so the fetch 404s. Diagnosis and remedy are tracked on
[BLO-32824](https://paperclip.blockcast.net/BLO/issues/BLO-32824); the fix is
[#1723](https://github.com/Blockcast/paperclip/pull/1723), still open.

Dispatching at the last-green `a589aea8bb990d11d5d987216b8dc4089b74a4a2` would ship a SHA pinned before six of the seven
merges, so it was not done. The deploy waits for a green master build.

**Merges did not stop when the image broke.** Seven further pushes landed on `master` after the
first red build — 12:36, 13:52, 14:43, 15:22, 16:09, 16:59 and 17:40Z — and every one produced
another red image (Docker #1681–#1687). The last of them *is* the #1418 merge, so a Track A PR
landed straight into an unbuildable `master`. Nothing in the pipeline gates a merge on the image
having built, so `master` accumulated mergeable-but-unshippable commits for six hours with no
signal to the lanes doing the merging. Recorded here at the CTO's request rather than filed
separately.

### Deployment state at time of writing

Production is at `66d67f18819175ecbeeef2e1918f1fca634ae49b`. Both tiers agree — `StatefulSet/paperclip`
and `Deployment/paperclip-api` carry the same `paperclip.blockcast.net/deployed-commit`
annotation (on the **pod template**, not object metadata), so there is no
[BLO-24821](https://paperclip.blockcast.net/BLO/issues/BLO-24821) divergence.

**None of the seven merges is deployed.** Every one compares `status: behind`, `ahead_by: 0`,
`behind_by` 65–106 against the deployed commit.

> **The ancestry predicate in the tracking issue's verifying signal is inverted, and this is
> the worked example.** That signal reads: `compare/<merge-sha>...<deployed-sha>` returns
> `behind` or `identical`, with "`ahead_by: 0` ⇒ ancestor". Every one of the seven returns
> exactly that — and every one is **undeployed**. `status: behind` on `A...B` means *B is behind
> A*, i.e. the deployed commit is an ancestor of the merge, which is the precise opposite of
> what the check is meant to certify. The correct predicate is `status ∈ {ahead, identical}`,
> equivalently `behind_by == 0`. Flagged rather than silently corrected, since the acceptance
> criteria belong to the issue owner.
>
> Separately, `/api/health` has **no `fullSha` field** — the body is
> `status`, `deploymentMode`, `deploymentExposure`, `bootstrapStatus`, `bootstrapInviteActive`,
> `auth`, `publicUrl` — so the "`/api/health` `fullSha` equals the deployed commit" signal
> cannot be evaluated as written. The pod-template annotation above is the usable substitute.


## Correction recorded against my own earlier reading

While diagnosing why nothing was progressing I first concluded the merge queue was **stalled** —
the queue branch `gh-readonly-queue/master/pr-1674-30c23389…` existed and a listing of the 10
most recent workflow runs showed no run for it. That conclusion was **wrong**. A branch-filtered
query found the `PR` workflow `in_progress` on that exact branch since `2026-09-06T04:46:54Z`;
the run was simply outside the recency window of the unfiltered listing. The queue is slow, not
stuck. Recording it because "I did not find a run" is not "no run exists", and the difference
would have turned a slow queue into a fabricated incident.

## Re-measurement 2026-09-10 ~07:5xZ — 9 of 11 landed, and my own deploy card's premise expired

Measured with `master` at `ac3386b9667cf0f422d18f42130399c659bcfcac`.

**#1585 and #1150 landed overnight** (see the update under *Final dispositions*), taking the row
to **9 of 11**. Both went through the merge queue with green `gh-readonly-queue` builds, and both
merge SHAs return `behind_by: 0` against `master`. Two remain open: **#1596** on criterion 5
(kkroo) and **#1595** on criteria 1–4 (`DIRTY`, two failing checks, failing findings gate, and a
mid-branch merge commit needing squash-replay under
[BLO-32317](https://paperclip.blockcast.net/BLO/issues/BLO-32317)).

### The pending deploy carries 7 of the 9 merges, not all of them

Board card `6ab6ee30-01fc-41f1-b765-e29e9125ffed` asks for one click on the
`paperclip-production` gate of Docker run **`34324444180`** (target
`52cfc6dfb0865e7b069076c15c303d47766404fe`, `waiting` since 2026-09-09T07:33:19Z, still the sole
`waiting` run and so still holding the fleet deploy mutex). Its `build-and-push` is `success`, so
the artifact exists and the run is parked purely on the human gate.

That card's load-bearing argument was *"it already contains every merge this row landed."* **That
is no longer true.** The run was dispatched at 07:33Z on 09-09; #1585 merged at 22:54Z and #1150
at 23:49Z, roughly 15h later. Measured against the target:

| merge | vs `52cfc6dfb…` | in the pending deploy? |
|---|---|---|
| #1195 #1279 #1586 #1467 #1219 #1309 #1418 | `status: ahead`, `behind_by: 0` | **yes** — ancestors |
| #1585 `d0613f40f…` | `status: behind`, `ahead_by: 0`, `behind_by: 44` | **no** |
| #1150 `3e85318c0…` | `status: behind`, `ahead_by: 0`, `behind_by: 45` | **no** |

**This is the [BLO-22455](https://paperclip.blockcast.net/BLO/issues/BLO-22455) rot pattern
happening to my own escalation.** The card was accurate when filed and decayed while correctly
not being polled — a "human-only gate" is a classification made at a moment in time, not a
durable property. The correction was posted as a comment on the still-pending card rather than by
withdrawing and re-filing, which would have burned the idempotency key for no gain.

**The recommendation is unchanged: approve `34324444180`.** Rejecting it to pick up two more
commits would destroy a built, green artifact and spend a second human click, and the two missing
PRs are `.github/**` (#1585) and `skills/**` (#1150) — neither is server runtime code. Approving
it satisfies this row's ancestry criterion for 7 of the 9; the remaining two will land in
production on the next deploy at a newer `master`. **Stated plainly so it is not overclaimed: that
leaves this row's A4 acceptance criterion — "every merge from this row as an ancestor" — only
partly met by this deploy, and closing it needs one further deploy that nobody needs to click
early.** No dispatch was attempted: standing-grant condition 3 forbids dispatching while any run
is `waiting`, and one is.

### Production is unchanged, and today's master image is red again

Production remains `66d67f18819175ecbeeef2e1918f1fca634ae49b` on **both** tiers —
`StatefulSet/paperclip` and `Deployment/paperclip-api` carry the same pod-template
`paperclip.blockcast.net/deployed-commit`, so there is still no
[BLO-24821](https://paperclip.blockcast.net/BLO/issues/BLO-24821) divergence. **None of the nine
merges is deployed.**

The [BLO-32824](https://paperclip.blockcast.net/BLO/issues/BLO-32824) image break was fixed by
[#1723](https://github.com/Blockcast/paperclip/pull/1723) (merged 2026-09-08T23:55:19Z), which is
why `34324444180` built green. But `Docker` on `master` is failing again: run **#1708**
(`c9a6ff973`, 2026-09-10T05:01:15Z) failed at `build-and-push`, with #1709 (`ac3386b96`) still
`in_progress` at time of writing. That is **not** a Track A blocker — the pending deploy has its
own green image — but it does mean a re-dispatch at current `master` could fail to build, which is
a second, independent reason not to reject the incumbent. Not diagnosed here and not this row's;
recorded so the next reader does not assume a re-dispatch is free.

## RESOLVED 2026-09-10T12:17:34Z — production is at `ac3386b96`, and all nine merges are deployed

**A4 is closed, and not the way I recommended.** Measured 2026-09-10T17:1xZ.

Sequence, from the run and deployment records:

| when (UTC) | what |
|---|---|
| 09-10T11:22:38Z | run `34324444180` **cancelled** — never approved, never rejected |
| 09-10T11:28:00Z | approval-gate reconciler ([BLO-29359](https://paperclip.blockcast.net/BLO/issues/BLO-29359)) closed card `6ab6ee30` as `cancelled`: *"the gate it pointed at died undecided"* |
| 09-10T11:23:14Z | `kkroo` dispatched `34471017388` at `ac3386b96` — `deploy` **failed** at the *Approve exact deploy plan at admission time* step (12:00:20Z) |
| 09-10T12:15:25Z | `kkroo` re-dispatched `34475702360` at the same SHA — all four jobs `success` |
| 09-10T12:17:34Z | deployment `6371413779` created; production moves to `ac3386b96` |

**kkroo took the *original* A4 plan — cancel the stale incumbent and re-dispatch at a newer SHA — over the revised recommendation I posted on the card, which argued for approving `34324444180` as-is.** Recorded plainly because the outcome is *strictly better than what I advised*: the deploy I recommended carried 7 of the 9 merges, and this one carries all 9. My argument rested on two premises that were each true when written and both decayed — that rejecting would "destroy a built green artifact" (the artifact was cancelled anyway, so there was nothing left to preserve) and that `Docker` on `master` was red so a rebuild might fail (it built green on the second attempt, and `master` is green again now at `7e7ae85de`, run `34503075423`). The first dispatch *did* fail — so the risk I named was real — but it was recoverable by retrying, which I had treated as a reason not to try at all.

### Ancestry proof — 9 of 9, `behind_by: 0`

`gh api repos/Blockcast/paperclip/compare/<merge-sha>...ac3386b9667cf0f422d18f42130399c659bcfcac`:

| PR | merge SHA | vs deployed | ancestor? |
|---|---|---|---|
| 1195 | `8ddfca0809c1d21366c1c54f588ff5a77664b2ca` | `ahead_by: 104`, `behind_by: 0` | **yes** |
| 1279 | `a32d5a5e2fe88225f76c9effd168daa88e801563` | `ahead_by: 107`, `behind_by: 0` | **yes** |
| 1586 | `2ebf80098065336c3264462bb983eb16acdcbca9` | `ahead_by: 103`, `behind_by: 0` | **yes** |
| 1467 | `79f85d056e27c61f6d86ef6b30a810c78d6ae51b` | `ahead_by: 102`, `behind_by: 0` | **yes** |
| 1219 | `70a9df918d2d250d5dfb536c15069e5015739b34` | `ahead_by: 92`, `behind_by: 0` | **yes** |
| 1309 | `a589aea8bb990d11d5d987216b8dc4089b74a4a2` | `ahead_by: 89`, `behind_by: 0` | **yes** |
| 1418 | `b9ec8590c0cb4cf0eae539ce9e8591473765ecb9` | `ahead_by: 66`, `behind_by: 0` | **yes** |
| 1585 | `d0613f40f2e52267a7d94b4fb3019f5a491d2155` | `ahead_by: 11`, `behind_by: 0` | **yes** |
| 1150 | `3e85318c0f454d42d5e60cbfbcc11935a66d2078` | `ahead_by: 10`, `behind_by: 0` | **yes** |

**Every row above is an ancestor of the deployed commit; none is undeployed.** The predicate used is `behind_by == 0` — *not* the `status`
`behind`/`ahead_by: 0` form written into the tracking issue's verifying signal, which is inverted
and passes for every undeployed merge. See the boxed correction above; it has now been reported
three times and is still unamended.

<sub>(Phrased without the literal audit token so that a `grep` for undeployed-ancestry markers over
this file returns zero hits rather than matching this sentence.)</sub>

### Two-tier check — no divergence

    kubectl -n paperclip get sts paperclip     -o jsonpath='{.spec.template.metadata.annotations.paperclip\.blockcast\.net/deployed-commit}'
    kubectl -n paperclip get deploy paperclip-api -o jsonpath='{.spec.template.metadata.annotations.paperclip\.blockcast\.net/deployed-commit}'

Both return `ac3386b9667cf0f422d18f42130399c659bcfcac`. `StatefulSet/paperclip` and
`Deployment/paperclip-api` agree, so there is no
[BLO-24821](https://paperclip.blockcast.net/BLO/issues/BLO-24821) divergence.

Production is `ahead_by: 0`, `behind_by: 10` against `master` `7e7ae85dee9dbba9914d232414263b3254507669` — ordinary drift from ten commits merged after the deploy, none of them Track A.

### `/api/health` still cannot serve this signal

Re-measured this run. The whole body is:

```json
{"status":"ok","deploymentMode":"authenticated","deploymentExposure":"private",
 "bootstrapStatus":"ready","bootstrapInviteActive":false,
 "auth":{"emailPasswordEnabled":false,"oidcProviders":["dex"]},
 "publicUrl":"https://paperclip.blockcast.net"}
```

There is **no `fullSha` field**, so the acceptance criterion's "`/api/health` `fullSha` equals the
deployed commit" clause is unusable as written — third measurement, unchanged. The pod-template
`deployed-commit` annotation above is the working substitute and is what this log cites.

### Deploy slot state

`gh api "repos/Blockcast/paperclip/actions/runs?status=waiting"` → `total_count: 0`. The slot is
**empty**: `34019412658` (the originally-named stale run) and `34324444180` are both terminal, so
the fleet deploy mutex is released. I dispatched nothing on this row in any run.

---

# Track C landing log — routines and the governance sweep

Appended by CTO for [BLO-32241](https://paperclip.blockcast.net/BLO/issues/BLO-32241) (Track C3–C4).
Track A's sections above are unmodified. The 2026-09-04 plan names this file as the shared landing
log for all five tracks, so C/B/D/E append their own sections here rather than opening parallel logs.

## C1 — landing classifier script

Owned by [BLO-32240](https://paperclip.blockcast.net/BLO/issues/BLO-32240) (Ally). Not filled here.

## C2 — landing routine that runs the classifier

Owned by [BLO-32511](https://paperclip.blockcast.net/BLO/issues/BLO-32511) (CTO), blocked by C1.

The *original* C2 — adding a `human_gate_aged` rule to the `Agent health & stalled-issue check`
routine — was **dropped** by engineering-review decision D2. The governance sweep already carries
the ratified priority-weighted human-gated ageing rule
([BLO-19130](https://paperclip.blockcast.net/BLO/issues/BLO-19130)), and its own spec says
*"Do **not** stand up a second routine."* Routine `a03b2236-a1f8-4014-806f-aeccf2374da8` was
therefore left untouched, verified this run: `human_gate_aged` occurs **0** times in its
description and it remains at **revision 50**. Nothing needed reverting.

### The replacement C2 — `Land clean-reviewed PRs` (created 2026-09-20 by Ally)

Re-scoped C2 is a *new* routine that runs the C1 classifier, not an edit to an existing one.
Created by Ally, because both remaining calls are self-service-only: `POST /companies/:id/routines`
rejects any `assigneeAgentId` that is not the caller
(`server/src/routes/routines.ts:100-106`, CTO measured `403`), and the fire path likewise refuses a
foreign agent id. No board card was filed — per the 2026-09-12 CEO ruling
([BLO-33624](https://paperclip.blockcast.net/BLO/issues/BLO-33624)) this is a capability question,
not an approval one. **Neither call hit a third guard**; both succeeded first attempt.

| field | value |
| --- | --- |
| routine id | `022cdf7f-e719-4992-b9c6-5bb36801995c` |
| title | `Land clean-reviewed PRs` |
| assignee | Ally `e0a5011d-5c94-4801-be52-64c14f98ac26` |
| status / priority | `active` / `high` |
| concurrencyPolicy | `skip_if_active` |
| catchUpPolicy | `skip_missed` (server default) |
| revision | 2 (rev 1 = create, rev 2 = "Created schedule trigger") |
| trigger id | `50cb6f35-fd8c-46ad-aa24-6b6a4bf13e36` |
| trigger | `schedule`, `45 */6 * * *`, `America/Los_Angeles`, `enabled: true` |
| first `nextRunAt` | `2026-09-20T13:45:00.000Z` |
| audit issue | [BLO-34818](https://paperclip.blockcast.net/BLO/issues/BLO-34818) `ad731b30-0579-4f2c-b5de-2190967bec50` |

**Description fidelity — verified mechanically, not by eye.** The live `description` was diffed
against the CTO's verbatim block extracted programmatically from comment `db9e6844-…` on
[BLO-32511](https://paperclip.blockcast.net/BLO/issues/BLO-32511) (`awk` between the code fences, no
retyping). Both sides are **2284 bytes** and `diff` is empty — byte-for-byte identical, em-dash and
7-space code indents included. Re-run the check any time with:

    curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      "$PAPERCLIP_API_URL/api/routines/022cdf7f-e719-4992-b9c6-5bb36801995c" | jq -r .description

#### Correction to the plan's step 4: `heartbeat/invoke` does not fire a routine

This is a fourth drift, on top of the CTO's three. The plan and the handoff both say to fire by hand
with `POST /api/agents/<ally>/heartbeat/invoke`. That call wakes the **agent**; it does not fire the
**routine**, so on its own it mints no execution issue and can produce no receipt. The manual-fire
path is a separate endpoint (`skills/paperclip/references/routines.md`, "Manual Run"):

    POST /api/routines/{routineId}/run
    { "source": "manual", "triggerId": "…", "idempotencyKey": "…" }

Fire 1 used it, with `idempotencyKey: blo-32511-fire-1` so a retry cannot double-fire.

#### Fire 1 — 2026-09-20T10:43:04.948Z (manual)

| field | value |
| --- | --- |
| routine run id | `28859a4f-06e5-407f-af86-a79dcd464f76` |
| source / trigger | `manual`, attributed to trigger `50cb6f35-…` |
| status | `issue_created` |
| execution issue | [BLO-34858](https://paperclip.blockcast.net/BLO/issues/BLO-34858) `dc3d926b-672a-4756-92aa-402613736356` |

**The fire-1 dispatch lag cleared on its own.** The fire minted the `routine_execution` issue
assigned to Ally, `todo`, `high`; that issue then sat **`todo` for ~18 minutes with
`activeRun: null`** while the creating run still held its own checkout, which is the most likely
reason the wake found nothing free to take. Run `230a8b6d-3736-4cfb-a661-2ab392371513` picked it up
at `13:01:18.951Z` and posted receipt 1 nine minutes later. No intervention was needed.

**The workspace-binding risk flagged above did not materialise.** Neither receipt contains an
`aborted:script-missing` row; both are full classifications, so the execution runs did find
`scripts/land-clean-prs.mjs`. The routine still carries no `projectId` or workspace binding, so the
risk remains live for future fires — it was simply not the thing that broke. What did break is
recorded under fire 3 below, and it is unrelated.

#### Receipt 1 — 2026-09-20T13:10:13.997Z, from fire 1

Comment [`e5b20c74`](https://paperclip.blockcast.net/BLO/issues/BLO-34818#comment-e5b20c74-7476-434b-b470-745fb2808ebe)
on BLO-34818, posted by run `230a8b6d`. First line is exactly `<!-- landing-routine-receipt -->`.

| tally | count |
| --- | --- |
| `already-enqueued` | 1 (#1954) |
| `codeowner-review-requested` | 13 |
| `skip` | 107 |
| `stale-enqueue` | 2 (#1444 at 753.8h, #1271 at 849.0h) |
| **`enqueue`** | **0** |
| rows total | 123 |

Confirmations section reads `first fire — no previous receipt`, which is the value step 3 of the
routine description specifies for a first fire.

#### Fire 2 — 2026-09-20T19:45:00Z (schedule) → receipt 2 at 20:50:12.506Z

| field | value |
| --- | --- |
| routine run id | `e7e5ce9e-9640-4d0c-b661-ab771e747df9` |
| source | `schedule`, trigger `50cb6f35-…` |
| status | `issue_created` |
| execution issue | [BLO-34946](https://paperclip.blockcast.net/BLO/issues/BLO-34946) `34cf59eb-3a43-44bd-b17b-13230fbe84eb` |
| receipt | [`31344cc1`](https://paperclip.blockcast.net/BLO/issues/BLO-34818#comment-31344cc1-387f-4059-8462-d44c32400443), run `fc878f8c` |

| tally | count |
| --- | --- |
| `already-enqueued` | 1 (#1954) |
| `codeowner-review-requested` | 20 |
| `skip` | 106 |
| `stale-enqueue` | 0 |
| **`enqueue`** | **0** |
| rows total | 127 |

Confirmations section reads `none` — the correct output when the previous receipt had no `enqueue`
rows. The two `stale-enqueue` rows from receipt 1 are absent from receipt 2 because fire 1 had
already posted on #1444 and #1271; the classifier does not re-report a stale enqueue it has
already flagged.

#### ACs 3 and 4 are satisfied vacuously, and that is worth stating plainly

The acceptance criteria expect receipt 1 to carry `enqueue` rows whose `autoMergeRequest` is set on
GitHub, and receipt 2 to resolve each of them to `confirmed-merged` or `still-queued`. **Neither
fire produced a single `enqueue` row**, so there was nothing to arm and nothing to confirm. Both
criteria hold, but neither was exercised. No `gh pr view <n> --json state,mergedAt` verification was
run, because there are zero `confirmed-merged` rows to verify.

The reason is not a routine defect — it is the state of the fleet's open PRs. Across 127 rows the
classifier found that essentially every candidate fails a real gate before landing is even
considered: `checks:FAILURE`/`QUEUED`/`IN_PROGRESS` dominates, `owner-approval-pending` accounts for
20, and the rest are `human-author`, `review:missing`, `review:blocking`, `review:stale-head` or
`mergestate:DIRTY`. The routine is correctly declining to merge PRs that are not clean. **The first
genuine end-to-end exercise of ACs 3 and 4 will be the first fire that meets a PR with green checks
and an owner approval at head**, and that has not happened yet in three fires.

#### Fires coalesce: two of the four slots minted no issue, by design

`concurrencyPolicy: skip_if_active` does not merely drop a fire — it records it as `skipped` with a
`coalescedIntoRunId` pointing at the run that was still live. Two of four fires took that path:

| triggered | run | status | outcome |
| --- | --- | --- | --- |
| 2026-09-20T10:43:04Z | `28859a4f` | `completed` | manual; minted BLO-34858 → receipt 1 |
| 2026-09-20T13:45:00Z | `af449f27` | `skipped` | coalesced into `28859a4f` (BLO-34858 still live) |
| 2026-09-20T19:45:00Z | `e7e5ce9e` | `issue_created` | minted BLO-34946 → receipt 2 |
| 2026-09-21T01:45:00Z | `73032a7a` | `skipped` | coalesced into `e7e5ce9e` (BLO-34946 still live) |

So **four fires produced two receipts, and that is correct behaviour, not two missing receipts.** A
coalesced fire is explicitly not a separate fire; the acceptance criterion "one receipt per fire"
must be read against runs that reached `issue_created`/`completed`, not against cron slots. Anyone
auditing this routine by counting cron slots against receipts will report a false defect.

#### Fire 3 — the 01:45Z slot's re-run failed on infrastructure, and is self-healing

BLO-34946 was re-woken for the coalesced 01:45Z slot, and that run
(`934e605e-5562-45a5-8f16-4f9ad2679b70`) failed at `03:10Z` with `adapter_failed` —
`Claude exited with code 1 [pod: reason=Error, container_log=penstock agent runtime: Caveman proxy
did not become ready]`. Infrastructure, not the script and not the routine.

**BLO-34946 therefore reads `blocked` with `blockedBy: []`, which looks exactly like the
zero-wake-path strand of [BLO-27553](https://paperclip.blockcast.net/BLO/issues/BLO-27553) and is
not one.** It carries `activeRecoveryAction.status: "active"`, attempt 1 of 5, `timeoutAt`
`2026-09-21T09:10:46Z`, `wakePolicy: wake_owner` → Ally. That is a live wake path. Per the
2026-09-13 amendment to that rule, **a `PATCH {status}` here would discharge the recovery action and
delete the working wake path** — the repair is strictly worse than the apparent defect. It was left
untouched deliberately. Re-check it with:

    curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      "$PAPERCLIP_API_URL/api/issues/34cf59eb-3a43-44bd-b17b-13230fbe84eb" \
      | jq '{status, blockedBy, ra: .activeRecoveryAction | {status, attemptCount, maxAttempts, timeoutAt}}'

## C3 — governance sweep un-paused (2026-09-07)

Routine `8b764d66-b598-4517-a249-e9a1dee82f06`
(*Weekly governance sweep — AC/verifying-signal + human-gated ageing*), located by title with
exactly one match among the company's 18 routines, moved `paused` → `active`.

It had not fired since **2026-08-17T09:00:12Z**, so it had missed two Mondays (08-24 and 08-31),
with a third (09-07) due at 09:00Z on the day of the write. That silence is cause (4) in the plan: nothing was ageing
the human-assigned `in_review` queue while 101 issues sat on one human for 22–87 days.

**Invariants asserted against the LIVE description before activating.** Counts are fixed-string
*occurrences*, not matching lines, so a repeated phrase on one line cannot inflate a count:

| Assertion | Required | Measured |
|---|---|---|
| `This routine is REPORT-ONLY. It cancels nothing, ever.` | = 1 | 1 |
| `It never calls cancel, and never modifies any issue` | = 1 | 1 |
| `resolveAcPolicyFilingTarget` | >= 1 | 2 |
| `Human-gated ageing escalation (BLO-19130)` | = 1 | 1 |
| `Do **not** stand up a second routine` | = 1 | 1 |

No count was zero, so activation proceeded. A supplementary audit for issue-mutating verbs
(`paperclipUpdateIssue`, `status: "cancelled"`, `cancelIssue`) returned **zero** matches, consistent
with the report-only contract. No cancel step was added, and none ever should be: CEO ruling
[BLO-19484](https://paperclip.blockcast.net/BLO/issues/BLO-19484) retired that step permanently
after 0 safe executions in 4 runs.

**The write, and why it could not corrupt the spec.** The PATCH body was exactly
`{"status":"active","baseRevisionId":"99d18d94-1bfa-4fdc-b95a-05157cadbc12"}` — the server
shallow-merges, so the 27,317-byte description never went on the wire and never passed through a
model context. Read back live after the write:

- `status`: **`active`**
- revision: 14 → 15 (`325734e5-c23c-4a3d-b082-c575ddeddf69`), a status-only revision
- description: **byte-identical** to the pre-PATCH capture (`cmp` clean), with all five invariants
  re-asserted at the same counts afterwards
- trigger `0606ff6f-5445-4f1e-b835-9da8dcf2fc58`: `0 9 * * 1` UTC, `enabled: true` — **unchanged**

**Why un-pausing with two missed fires is safe — and what actually fired.** Both policies were
confirmed *before* the write: `catchUpPolicy: skip_missed` (missed Mondays are not replayed) and
`concurrencyPolicy: skip_if_active` (no overlapping runs). The pre-write prediction was that exactly
one fire was due, at 2026-09-07T09:00:00Z, and that a replaying catch-up policy would instead have
queued three sweeps at once.

**Observed, from `GET /api/routines/8b764d66-…/runs` after the fact — recorded because the
mechanism was not the one predicted: activation itself fired the routine immediately.** Run
`b711b104-125d-4615-8246-9305eef620f4` was created at `2026-09-07T08:31:31.993Z`, 65 seconds
*before* the C4 capture below, with `source: schedule` and `triggeredAt: 2026-08-24T09:00:00.000Z`
(`__paperclipRoutineWindowClosesAt: 2026-09-07T09:00:00.000Z`) — a catch-up run stamped with the
08-24 slot, not a fire at the cron boundary. The 08-31 slot was not replayed. The 09:00:00Z boundary
fire (run `358312e5-7c6c-47eb-96fd-431f083e2d81`, created 09:00:05Z) was then `skipped` with
`coalescedIntoRunId: b711b104-…`, consistent with `skip_if_active` — `b711b104` was still running and
only completed at `18:45:53.410Z`. All 16 prior executions of this routine (2026-05-04 → 2026-08-17)
triggered between `09:00:04` and `09:00:34`; this is the only one that has ever fired off-boundary.

The safety *outcome* held — one execution, not three, and nothing was cancelled — but
`skip_missed` did not mean "no run until the next cron slot". The next agent to un-pause a routine
should plan for one immediate fire on activation, and should verify it against `/runs`, not against
the routine row (see the C4 note below).

## C4 — routine evidence

Captured to `/tmp/track-c-evidence.json` at 2026-09-07T08:32:37Z and reproduced verbatim:

```json
{
  "capturedAt": "2026-09-07T08:32:37Z",
  "capturedBy": "CTO 386c81e8-e454-41ba-8e1d-7bb692331185",
  "issue": "BLO-32241",
  "track": "C3-C4",
  "routines": [
    {
      "id": "8b764d66-b598-4517-a249-e9a1dee82f06",
      "title": "Weekly governance sweep — AC/verifying-signal + human-gated ageing",
      "status": "active",
      "role": "Track C3 target - un-paused this run",
      "latestRevisionId": "325734e5-c23c-4a3d-b082-c575ddeddf69",
      "latestRevisionNumber": 15,
      "catchUpPolicy": "skip_missed",
      "concurrencyPolicy": "skip_if_active",
      "activityGatePolicy": "always",
      "activityGateScope": "company",
      "assigneeAgentId": "386c81e8-e454-41ba-8e1d-7bb692331185",
      "parentIssueId": "7b54e724-63d2-45e6-a4fb-43fb94777e6c",
      "lastTriggeredAt": "2026-08-17T09:00:12.695Z",
      "lastEnqueuedAt": "2026-08-17T09:00:12.695Z",
      "triggers": [
        {
          "id": "0606ff6f-5445-4f1e-b835-9da8dcf2fc58",
          "kind": "schedule",
          "cronExpression": "0 9 * * 1",
          "timezone": "UTC",
          "enabled": true
        }
      ]
    },
    {
      "id": "a03b2236-a1f8-4014-806f-aeccf2374da8",
      "title": "Agent health & stalled-issue check",
      "status": "active",
      "role": "old C2 target - DROPPED per D2, deliberately untouched",
      "latestRevisionId": "ab2d8e3b-10b8-4d41-a4dc-2eb6e03298fe",
      "latestRevisionNumber": 50,
      "catchUpPolicy": "enqueue_missed_with_cap",
      "concurrencyPolicy": "always_enqueue",
      "updatedAt": "2026-09-07T06:07:45.403Z",
      "updatedByAgentId": "d2ade02d-112c-4da2-b61f-2301254a154c",
      "humanGateAgedOccurrences": 0,
      "triggers": [
        {
          "id": "fac2860d-304d-4346-ae1e-9500081a2724",
          "kind": "schedule",
          "cronExpression": "7 */6 * * *",
          "timezone": "UTC",
          "enabled": true
        }
      ]
    }
  ],
  "c3Invariants": {
    "This routine is REPORT-ONLY. It cancels nothing, ever.": 1,
    "It never calls cancel, and never modifies any issue": 1,
    "resolveAcPolicyFilingTarget": 2,
    "Human-gated ageing escalation (BLO-19130)": 1,
    "Do **not** stand up a second routine": 1
  },
  "descriptionUnchangedByPatch": true,
  "firstFireDueAt": "2026-09-07T09:00:00Z"
}
```

**Three fields in that block were already stale at `capturedAt`.** The capture at `08:32:37Z` is 65
seconds *after* run `b711b104` was created at `08:31:31.993Z`, yet `lastTriggeredAt` and
`lastEnqueuedAt` still read `2026-08-17T09:00:12.695Z`, and `firstFireDueAt` records the 09:00
prediction rather than the fire that had already happened. The JSON is left verbatim above; the
corrected values are: first fire at `2026-09-07T08:31:31.993Z` (run `b711b104-…`), and the routine
row's `lastTriggeredAt` = `lastEnqueuedAt` now read `2026-09-07T09:00:00.000Z` (live 2026-09-14) —
the boundary run's stamp. That is the cause worth one line: the routine row's `lastTriggeredAt` was
not advanced by the on-activation catch-up run at all, so a capture keyed off the routine row cannot
see that fire. Tracks B/D/E reusing this capture pattern should read `/api/routines/<id>/runs`
alongside the routine row.

### First fire after un-pausing

An earlier revision of this section stated the sweep had **not** fired as of 2026-09-07T08:38Z.
**That was wrong** — it had fired about 6.5 minutes before that observation. Run
`b711b104-125d-4615-8246-9305eef620f4` (created `2026-09-07T08:31:31.993Z`, `source: schedule`,
`triggeredAt: 2026-08-24T09:00:00.000Z`, `completed` at `18:45:53.410Z`) minted report issue
[BLO-32535](https://paperclip.blockcast.net/BLO/issues/BLO-32535) at `08:31:32.147Z`
(`originKind: routine_execution`, `originId: 8b764d66-…`, `originRunId: b711b104-…`). BLO-32535
started at `15:32:01.144Z` and is `done` (`completedAt: 2026-09-07T18:45:52.507Z`). The 09:00:00Z
boundary run `358312e5-7c6c-47eb-96fd-431f083e2d81` was `skipped` and coalesced into `b711b104`.
The human-gated ageing rows are BLO-32535's own output and are deliberately not transcribed here.
