# Track A landing log (2026-09-05 plan, executed 2026-09-06)

Plan: `docs/superpowers/plans/2026-09-04-in-review-truth-gate-and-landing-routines.md`
Tracking issue: [BLO-32238](https://paperclip.blockcast.net/BLO/issues/BLO-32238) (Track A of [BLO-32237](https://paperclip.blockcast.net/BLO/issues/BLO-32237))

The 2026-09-06 sections below were measured against the live GitHub API on
**2026-09-06 ~05:0x–05:1xZ**, with `master` at `30c23389316b4b6cce44d28f68d79af12b7c4c02`.
The execution section at the end carries its own, later measurement window.

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
| 1609 | no | MERGED 2026-09-06T04:46:52Z | `ad4664bd` | merged as `30c23389`, which is the current `master` tip |
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
| 1091 | no | DIRTY, no `verify` at head | `a5583c27` | superseded post-commit — **closed, not rebased** (the same identity closed it at 05:23:43Z, "closing as superseded"); [BLO-32255](https://paperclip.blockcast.net/BLO/issues/BLO-32255) is resolved |

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
| 1150 | OPEN — passes 1–4 at `31a2c99f15ab4344271c5080b167969e2bdb707c` | **criterion 5**: no `APPROVED` from kkroo; every review on it is `allyblockcast[bot]` / `COMMENTED` | **kkroo** |
| 1596 | OPEN | **criterion 3**: `gate/ally-comment-findings` **ABSENT** at `09ce54c8867eed6a36ad6cc621fed5e5cc9a57a4` — only the retired `review/ally-comment` is present, so the head is unattested, not clean. Then criterion 5 | **Ally**, then kkroo |
| 1585 | OPEN | **criterion 3**: same shape at `00b36ef46de4f0581d2e95378c724fe47b32aac4`. Then criterion 5 | **Ally**, then kkroo |
| 1595 | OPEN | **criteria 2, 3 and 4**: `verify` and `General tests (server 3/4)` are `failure`; gate is `failure` ("carries an unresolved finding"); and the branch has a merge commit (parents `[1,1,1,1,1,1,1,2]`) needing squash-replay linearization | **Ally**, then a linearization pass |

Each of the seven landed PRs has a corresponding `gh-readonly-queue/master/pr-<n>-*` build under
`actions/runs?event=merge_group` — the positive proof that the queue rebased and built the entry
rather than silently evicting it. All seven are present.

**No PR was evicted for carrying a merge commit**, because criterion 4 was applied with the
parent-count check rather than `rebaseable` alone. **`gh pr update-branch` was never invoked
against this repository**: on a `merge_queue` repo it merges base into head, produces a merge
commit, and causes a silent head-of-queue eviction with no build
([BLO-22300](https://paperclip.blockcast.net/BLO/issues/BLO-22300)). A `BEHIND` reading needs no
action — the queue rebases each entry onto current base when it builds. But `BEHIND` masks
everything behind it: #1309 was `BEHIND` *and* carried a failing `verify`, a failing findings
gate, and a merge commit. Never diagnose a `BEHIND` PR from the `BEHIND` reading alone.

### The CODEOWNERS gate is requested, not required

Worth recording because it is counter-intuitive and it is the only thing holding #1150. The sole
rule on `master` is `merge_queue` — there is no `pull_request` rule, no
`required_approving_review_count`, and no `required_status_checks`. Consistent with that, all
four open PRs read `reviewDecision: null` rather than `REVIEW_REQUIRED`; the CODEOWNERS entry
*requests* kkroo but no ruleset enforces the request. Criterion 5 was nonetheless applied as
written, and #1150 was **not** merged. Whether the criterion should bind where no ruleset
enforces it is a routing decision for the issue owner, not one for the executor to take on the
strength of having measured it.

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

## C3 — governance sweep un-paused (2026-09-07)

Routine `8b764d66-b598-4517-a249-e9a1dee82f06`
(*Weekly governance sweep — AC/verifying-signal + human-gated ageing*), located by title with
exactly one match among the company's 18 routines, moved `paused` → `active`.

It had not fired since **2026-08-17T09:00:12Z**, so it missed three Mondays (08-24, 08-31, and
09-07 pending at the time of writing). That silence is cause (4) in the plan: nothing was ageing
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

**Why un-pausing with three missed fires is safe.** Both policies were confirmed *before* the
write: `catchUpPolicy: skip_missed` (missed Mondays are not replayed) and
`concurrencyPolicy: skip_if_active` (no overlapping runs). Exactly one fire was therefore due, at
2026-09-07T09:00:00Z. Had catch-up been a replaying policy, un-pausing would have queued three
sweeps at once.

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

### First fire after un-pausing

The sweep had **not fired yet as of 2026-09-07T08:38Z**; its first post-un-pause fire was due
the same day at 09:00:00Z UTC. The observed rows are appended below when that fire lands.
