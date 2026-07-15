# Process-Loss Recovery: Checkpoint/Resume Is a Non-Goal

Status: Accepted
Owner: Agent Runtime / Recovery
Date: 2026-07-14
Primary issue: `BLO-16185` (parent `BLO-12292`)

## Summary

When the heartbeat reaper mints `process_lost` for an external-lifecycle agent run
(`claude_k8s` / `opencode_k8s`), **the correct recovery is idempotent re-dispatch
plus Job reattach — not checkpoint/resume of the run.** This note records why, so a
future change does not add per-run checkpointing on the mistaken assumption that
`process_lost` discards in-flight work.

## Context

`process_lost` is the `heartbeat_runs.error_code` (on `status='failed'`) the reaper
stamps when a run's backing k8s Job died or vanished (`reapOrphanedRuns` in
`server/src/services/heartbeat.ts`). BLO-12292 scoped the fleet-wide instability;
BLO-16181 added a durable `resultJson.processLoss.classification` on each mint;
BLO-16184 monitors it with a denominator.

The tempting-but-wrong reaction to "runs keep getting lost" is to checkpoint agent
progress so a reaped run can resume mid-flight. That is the wrong mechanism for
this class, for the reasons below.

## Decision

**Do not build checkpoint/resume for `process_lost`.** The mitigations are:

1. **Idempotent re-dispatch** — the run is re-queued and the agent re-derives its
   state from the durable issue (comments, documents, git). Landed as **BLO-16182**
   (reclassify `process_lost` → `transient_infra` with a unified attempt cap).
2. **Job reattach** — for the rare run whose Job was actually created before it
   vanished, re-adopt the existing Job instead of re-running. Tracked as
   **BLO-12564** (blocked on BLO-16181's classification, now landed).

## Evidence (measured 2026-07-14, 14-day window)

| Class | Count | Empty `result_json` after stripping metadata |
|---|---|---|
| Pre-adapter (`external_run_id IS NULL`) | 299 (~98.4%) | 287 / 299 |
| Stamped (`external_run_id` set) | 5 (~1.6%) | 5 / 5 |

- **~98% of `process_lost` are pre-adapter**: the mint precedes `adapter.invoke` by
  construction (`externalLifecyclePreAdapter = externalLifecycleRun &&
  !externalLifecycleStarted`), so the agent never ran — **there is no work product
  to lose.** `result_json` carries only reaper/stop metadata, not agent output.
- Even the **1.6% stamped/started tail** (the `started_job_absent` classification
  from BLO-16181, where a run that *had* reached `adapter.invoke` lost its Job and
  went silent) shows **empty `result_json`**: any durable work an agent produced
  lives in git commits and issue comments — persisted *outside* the run row — so
  checkpoint/resume of `result_json` would preserve nothing useful there either.
  Reattach (BLO-12564), not checkpointing, is the right tool for that tail.

The separate mid-run over-reap class — killing a *live* `2/2 Running` pre-adapter
pod, the one case where in-flight work could genuinely be lost — was closed by
`9c1bde19` ("keep live k8s runs out of orphan reaper", 0 occurrences in the 30d
since) and is now guarded by the reaper regression test from **BLO-16183**. This
note is scoped to the *reaped* `process_lost` class, not that closed one.

## Consequences

- Recovery stays cheap and stateless: re-dispatch + reattach, no checkpoint store,
  no resume protocol, no partial-state reconciliation.
- The `process_lost` numerator is a *health* signal (BLO-16184), not a *data-loss*
  signal — a spike means "runs are failing to start / hold a Job", not "work is
  being destroyed". Alert language reflects that.

## Re-evaluation trigger

This non-goal rests on "the reaped run had not produced work". Revisit it if that
stops holding — specifically if **`adapter.invoke` moves earlier** in the run
lifecycle (so runs become `externalLifecycleStarted` before doing meaningful work,
and a larger share of `process_lost` carries a real `result_json` work product).

That shift is **observable, not silent**: BLO-16184 splits `paperclip_process_lost_total`
by `classification`, so a rising `started_job_absent` share (vs the `pre_adapter_*`
buckets) is the live tripwire. The classifier's pre-adapter↔`pre_adapter_*` mapping
is pinned by a unit invariant in `process-loss-classification.test.ts` so the
taxonomy that tripwire depends on cannot silently drift.

## Alternatives considered

- **A hard runtime assertion that `process_lost` is only minted when
  `!externalLifecycleStarted`** (the original BLO-16185 sketch). Rejected: it is
  now *false* — the legitimate `started_job_absent` path (1.6% of mints) reaps a
  started run whose Job vanished. A hard assert would fail-closed on healthy
  traffic. The invariant that *is* true and useful — the classifier faithfully
  maps the pre/post-adapter boundary to its bucket family — is pinned as a test
  instead, and the metric split is the behavioral tripwire.
- **Per-run checkpoint/resume.** Rejected per the evidence above: nothing to
  checkpoint for ~98% of mints, and the durable work for the rest lives outside
  the run row.
