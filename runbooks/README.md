# Runbooks

Operator-facing procedures for recovering from production incidents that the
platform cannot resolve automatically. Each runbook should be:

- **Specific.** Names the precise symptom, error code, or alert that triggers
  it. If you cannot match a runbook to your incident, do not improvise — page
  the owning lane.
- **Reversible.** Steps that destroy state must include a snapshot step
  before the destructive action.
- **Sourced.** Cross-references to the engineering issue(s) that motivated
  the runbook so the why-does-this-exist context is one click away.

## Index

- [`agent-wakeup-terminal-failed.md`](agent-wakeup-terminal-failed.md) — a
  PR-review wake left terminal at `agent_wakeup_requests.status='failed'`,
  which nothing re-drives: decide re-review vs accept without double-posting a
  review. Trigger: alert `PaperclipPrReviewWakeTerminalFailed`, or
  `paperclip_agent_wakeup_terminal_failed_unresolved{scope="pr_review"} > 0`.
- [`clear-polluted-ssh-workspace.md`](clear-polluted-ssh-workspace.md) —
  recover a stranded SSH-driven run whose workspace import is failing on a
  sibling task's leftover scratch state. Trigger: blocked issue auto-comment
  cites `workspace_import_conflict` or tar `Cannot open: File exists`.
- [`k8s-live-job-block-guard.md`](k8s-live-job-block-guard.md) — the
  terminal-run/live-Job admission race invariant: a run can never go
  terminal `k8s_concurrent_run_blocked` while its own run-scoped Job is
  confirmed alive. Trigger: `k8s_guard_decision` log line with
  `reason: "live_job_for_active_run"`, or
  `claude_k8s_concurrent_run_blocked_total{reason="live_job_for_active_run"}`.
- [`merge-queue-stalled-head.md`](merge-queue-stalled-head.md) — when to
  manually dequeue a head-of-queue PR whose `merge_group` check is stuck
  (not failing) and is silently freezing the `master` merge queue. Trigger:
  `master` hasn't advanced in >90 min with the queue non-empty, or the
  position-1 entry's `merge_group` run shows no state change for that long.
- [`pr-update-branch-destroys-required-checks.md`](pr-update-branch-destroys-required-checks.md)
  — an approved PR cannot be enqueued because its head has no checks at all,
  after `update-branch` (or a hand-merged base) replaced the head with a merge
  commit that Actions never ran. Trigger: `gh pr merge` answers
  `Required status check "verify" is expected.` while `gh pr checks` shows
  nothing at the head.
- [`queued-run-stranded.md`](queued-run-stranded.md) — a `heartbeat_runs` row
  sitting at `status='queued'` for a long time: the issue it targets looks
  actively in-progress but nothing is executing, and it manufactures false
  productivity-review escalations. Also covers the case where the row's age
  snapshot cannot be refreshed safely. Trigger: alert
  `PaperclipQueuedRunStranded`, `PaperclipQueuedRunAgeMetricsRefreshFailed`,
  or `max(paperclip_queued_run_oldest_age_seconds) by (agent_id) > 1800`.
- [`queued-run-stranded.md#overdue-scheduled-retry-blo-22094`](queued-run-stranded.md#overdue-scheduled-retry-blo-22094) —
  a `heartbeat_runs` row parked at `status='scheduled_retry'` past its own due
  time, never promoted: the retry-promotion sweep either wedged or is
  systematically failing this row, and (unlike the alert above) the row never
  even reached `queued`. Also covers the case where that row's age snapshot
  cannot be refreshed safely — read a stale snapshot as a detector outage, not
  an all-clear. Trigger: alert `PaperclipOverdueScheduledRetry`,
  `PaperclipOverdueScheduledRetryAgeMetricsRefreshFailed`, or
  `max(paperclip_overdue_scheduled_retry_oldest_age_seconds) by (agent_id) > 5400`.
- [`productivity-review-monitor-rearm.md`](productivity-review-monitor-rearm.md)
  — you are adjudicating an open productivity review and the reviewed issue's
  monitor has lapsed (`status: "triggered"`, `nextCheckAt: null`, no active
  run): the supported one-call repair path, and why the `PATCH {status:
  "todo"}` bounce is superseded. Trigger: review evidence reads `monitor
  lapsed at …, never re-armed`.
