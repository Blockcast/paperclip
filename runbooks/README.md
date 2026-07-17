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
