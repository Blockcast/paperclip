# Terminal-run / live-Job admission race — invariant and rollback

Source: `server/src/services/heartbeat.ts` (`executeRun`, guard tagged
`BLO-16537`). Trigger: any `k8s_concurrent_run_blocked` admission decision
should read `reason: "live_job_for_active_run"` in the structured
`k8s_guard_decision` log line, or increment
`claude_k8s_concurrent_run_blocked_total{reason="live_job_for_active_run"}`.
Owner: Platform/SRE (staffed by CTO timebox — see
[BLO-518](/BLO/issues/BLO-518#document-plan)).

## The invariant

**A heartbeat run whose run-scoped Kubernetes Job is confirmed alive can
never be written to a terminal status.** Terminalization, Job ownership, and
external-runtime reservation release are one idempotent outcome: none of
them happen unless all of them are correct together.

## What broke (BLO-16537 / Ally canary NO-GO, BLO-15961)

`executeRun` can be invoked more than once for the same run — most commonly
a post-restart reattach (`resumeRunningExternalRuntimeRuns`, on the periodic
heartbeat tick) racing the still-live original launch of the same run's Job.
The k8s adapter correctly refuses to launch a second Job for a run identity
that already has one alive, and reports that refusal as
`errorCode: "k8s_concurrent_run_blocked"`. Before this fix, the *reattach*
invocation accepted that refusal as **its own** terminal outcome: it wrote
the run `failed`, which released the reservation and (via
`startNextQueuedRunForAgent`) freed the agent's concurrency slot — all while
the run's real Job kept executing and emitting output. Four Ally canary runs
hit exactly this during the concurrency=2 soak; each showed a terminal
`failed`/`k8s_concurrent_run_blocked` row next to a Kubernetes Job still in
`Running` phase.

## The fix

Before accepting `k8s_concurrent_run_blocked` as this invocation's terminal
outcome, re-verify the run's *own* reservation directly against the cluster
(`readAgentJobRunStatusByName`, not a cached/stale read). If the reservation
is `launched` with a `jobName`/`jobUid` and the live Job matches that exact
identity and is still `active`:

- The invocation is abandoned with **no** mutation to the run row, the
  reservation, or the environment lease's terminal disposition — it is
  simply a lost race against itself, not a failure.
- A `k8s_guard_decision` log line and a
  `claude_k8s_concurrent_run_blocked_total{reason="live_job_for_active_run"}`
  increment record the suppressed transition for observability.
- The next periodic reattach tick (or the reaper, once the Job genuinely
  finishes) is free to try again or finalize normally — this is a no-op,
  not a terminal state, so it costs at most one wasted reattach attempt per
  heartbeat tick until the real Job's outcome resolves.

An **unconfirmed** read (kube API unreachable, or a Job identity mismatch)
is not treated as alive — a genuine capacity block still finalizes exactly
as before this fix. This preserves the existing bounded-retry path for
queued (never-dispatched) runs, which is unaffected: that path never holds
a `launched` reservation for the blocked run in the first place.

## Verifying the fix is live

The suppressed transition is not written to `heartbeat_run_events` (the run
row is deliberately left untouched) — check the structured application log
for the `k8s_guard_decision` event with `"decision":"blocked"` and
`"reason":"live_job_for_active_run"`, or scrape
`claude_k8s_concurrent_run_blocked_total{reason="live_job_for_active_run"}`
from `/metrics`. Expect this to be rare but nonzero once concurrency > 1 is
enabled for an agent. A run should **never** show a terminal
`k8s_concurrent_run_blocked` row while `kubectl get job -n paperclip <run's
job name>` reports the Job `Active`. If you observe that combination
post-fix, this is a regression — escalate immediately rather than reusing
the old rollback threshold as "acceptable."

## Rollback

This change only tightens an existing decision (it never converts a
previously-terminal outcome into a non-terminal one for a genuinely dead
Job). There is no feature flag to disable it independently. If it needs to
be backed out, revert the commit tagged `BLO-16537` in `heartbeat.ts` and
redeploy; the pre-existing behavior (accept the adapter's refusal as
authoritative) returns immediately. Independently, the existing containment
lever remains: set `runtimeConfig.heartbeat.concurrencyEnabled=false` /
`maxConcurrentRuns=1` for the affected agent (see the
[Ally canary runbook](/BLO/issues/BLO-15961#document-canary-runbook)) to
serialize it back to one run at a time, which removes the only known trigger
for this race (a live reattach racing a live original launch under
concurrency ≥ 2).
