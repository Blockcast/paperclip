# PEN-5151 — a quiet tick is not a skipped claim

`src/server/job-manifest.ts`, comment only. No statement, no signature, no behaviour.

Supersedes one clause of
[`pen-5151-ceiling-becomes-a-config-read.md`](./pen-5151-ceiling-becomes-a-config-read.md), which
landed the per-claim evidence rule in `resolveAgentWorkspaceClaimName`'s DO-NOT-ENABLE block: *a
`drive complete` line for this claim at `dryRun=false` means it was reclaimed.* That rule is right
in the positive direction and has a hole in the negative one, which is the direction an operator
reading the `PaperclipIsolationWorkspaceReaperCoverageGap` alert actually travels.

## The hole

`server/src/services/isolation-reclaim-driver.ts` returns early when the plan has nothing to do:

```ts
if (plan.eligibleIds.length === 0) {
  // The ordinary quiet tick. No Job: see the header.
  return { ...base, ok: true, nothingEligible: true };
}
```

That return precedes the module's **only** `drive complete` log site — `grep -c` over the module
returns `1`. `buildIsolationReclaimPlan` leaves `eligibleIds` empty whenever every entry is still
inside `maxAgeDays` (`fresh` by `mtime`, or `in_use` by `lastUsedAt`, per
`classifyIsolationWorkspaceAge`) and whenever the tree has no named entries at all.

So on an ordinary quiet tick a **covered** claim emits no per-claim line. The drive is nonetheless
`ok`, and `isolation-reclaim-sweep.ts` counts it into `claimsOk`, which `metrics.ts` publishes as
`paperclip_isolation_reclaim_claims_total{outcome="ok"}` — the claim is recorded as driven in the
aggregate and invisible per-claim. A reader applying the rule in reverse classes it as unreclaimed.

## Why this is a comment fix and not a code fix

It fails toward *unreclaimed*, which is the safe direction: the cost is an unnecessary opt-out, not
an unreclaimed tree believed reclaimed. Emitting a line on the quiet path would be the other
candidate fix, and it is rejected here for the reason the early return names itself — a quiet tick
launches no Job, so there is no execution to report, and logging one per claim per daily tick for
the fleet buys nothing the aggregate does not already carry.

What the header owed instead is the condition under which absence *is* evidence. That condition is a
**conjunction**, and the first draft of this change stated only half of it — caught by Ally in
review of this PR at head `f556f3e8`, and worth recording because the half-stated form moved the
failure to the *unsafe* direction while purporting to fix the safe one:

1. **The window holds at least one `isolation reclaim sweep complete` line at `dryRun=false`**, and
   every such line in it reads `claimsFailed: 0` and `claimsDeferred: 0`
   (`isolation-reclaim-sweep.ts`, one site, on the completion path). The line's existence at
   `dryRun=false` is the non-vacuity precondition: `recordIsolationReclaimSweep` labels the entire
   `paperclip_isolation_reclaim_*` family — counters and the `last_sweep` gauge alike — with the
   sweep's *own* `dry_run` (`metrics.ts`, `const dry_run = options.dryRun ? "true" : "false"`), so
   under the dry-run-only rollout the runbook calls *"the first state a correct rollout is in"*
   nothing exists at `dryRun=false` at all and every read there is zero vacuously — which is how
   the half-stated rule concluded *covered* for a deployment that had reclaimed nothing, while the
   sentence immediately above it concluded *unreclaimed* for the same state.
2. **The claim is one the sweep lists.** `listReclaimableClaims` selects agents with
   `enablePerAgentWorkspaceVolume` true or a `workspaceVolumeClaim` distinct from the server's own,
   so a claim left behind by **opting an agent back out** is not listed. The runbook names opting
   out as the cheapest remedy and tells the operator to *"write down the claim you left behind"* —
   so this is a case the page creates itself, and for it absence **is** the unreclaimed reading.

With both stated, the direction is preserved: the rule still fails toward *unreclaimed*.

## Why condition 1 is a log read and not a counter read

The *second* draft stated the conjunction correctly but hung condition 1 on a metric: a fresh
`{dry_run="false"}` timestamp plus **zero `increase()`** in `claims_total{outcome="failed"}` and
`{outcome="deferred"}`. Ally caught that at head `bd701333`, and it is the same unsafe direction
reached through the other half of the test — **`increase()` cannot see a counter series' first
value.**

`recordIsolationReclaimSweep` creates the `{dry_run, outcome}` children lazily, with
`inc(byOutcome[outcome])` on the first sweep of a process, and the scrape adds the pod's `instance`.
So a sweep that failed or deferred on a process's *first* tick lands as that series' first sample,
already carrying the count; `increase()` measures change between samples, and with no
created-timestamp ingestion on this Prometheus it reads that first value as **0**. Freshness does
not repair it — the window genuinely does contain a fresh `{dry_run="false"}` timestamp — so the
conjunction concluded *covered* for a claim that was deferred or failed.

It is the common case here rather than an edge one, and unlike the first draft this was measured
rather than argued:

```promql
count(count_over_time(process_start_time_seconds{job="paperclip-control-plane"}[7d]))  # → 55
```

≈55 process lifetimes a week against a **daily** sweep tick means most sweeps are the first — often
the only — sample of their series. The reclaim family has no series yet (the sweep is not enabled),
so the demonstration is on the **sibling** counter that already carries this idiom at
`runbooks/isolation-workspace-reaper.md`: **6 of 19** live
`paperclip_isolation_workspace_reaper_deleted_total` series read `increase(...[7d]) == 0` while
`max_over_time(...[7d])` over the same window is non-zero (5, 4, 3, 6, 2 and 1 deletions), and two
more read 7 against 16 and 21 against 26. Every one of those gaps is a deletion `increase()` did
not count.

The fix moves condition 1 onto the per-sweep `isolation reclaim sweep complete` line at
`dryRun=false`, which carries `claimsFound`, `claimsFailed` and `claimsDeferred` for each tick and
does not depend on series identity, so a pod's first sweep counts like any other. The counter
paragraph that the bad condition derived from — pre-existing, and wrong in the same way — is
corrected at its source in the same commit rather than left to be re-derived, since leaving the
premise standing under a corrected conclusion is the drift PEN-5151 exists to remove.

One consequence worth naming: the rule now requires **every** sweep line in the window to read zero,
not their sum. A tick that deferred claims is a tick this claim may have been the deferred one on,
and `claimsDeferred > 0` is ordinary rather than exceptional — deferral is the mechanism by which
the rotation covers a fleet larger than one tick (`metrics.ts` says so where it derives
`stop_reason`). The strictness is the point: it is the fails-toward-unreclaimed direction.

## Where the same clause went

Three surfaces carried the rule and all three now carry the correction — leaving one uncorrected
would recreate the drift PEN-5151 exists to remove. A fourth, pre-existing paragraph is corrected
alongside them for the same reason:

- `runbooks/isolation-workspace-reaper.md`, the per-claim evidence paragraph. Its negative clause
  also read *"stale, absent, or dry-run-only means unreclaimed"*, where "absent" could attach to
  the line rather than the timestamp; it is now scoped to the timestamp explicitly.
- `runbooks/isolation-workspace-reaper.md`, the `claims_total` paragraph — **not** one of the three
  carrying the rule, and pre-existing, but the source of the `increase()` read the second draft's
  condition 1 derived from. Corrected here with the measurement, because a corrected conclusion over
  a standing bad premise is the drift this row removes.
- `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`, the DO-NOT-ENABLE header (this
  entry's vendored change).
- `PROVENANCE-CHANGES.d/pen-5151-ceiling-becomes-a-config-read.md`, pointed here rather than
  rewritten, per this directory's append-only rule.

Origin: Ally's non-blocking suggestion on
[#3252](https://github.com/Blockcast/paperclip/pull/3252) at head `0dbcd4bfc`
(0 critical / 0 important / 1 suggestion). It was deliberately not pushed to that PR's head — a
clean head-pinned verdict is not re-burned for a comment — and was carried on PEN-5151 until a
change touched these files.
