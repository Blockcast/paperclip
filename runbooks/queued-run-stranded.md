# Stranded queued runs (an issue looks active, but nothing is executing)

Source: `server/src/services/queued-run-age-metrics.ts` (`refreshQueuedRunAgeMetrics`), `server/src/services/metrics.ts` (`QUEUED_RUN_OLDEST_AGE_METRIC`, `setQueuedRunOldestAgeMetrics`)
Trigger: alert `PaperclipQueuedRunStranded` — `max(paperclip_queued_run_oldest_age_seconds) by (agent_id) > 1440` for 5m
Owner: Platform / SRE (BLO-21116)

## The invariant

A `heartbeat_runs` row at `status='queued'` is a run Paperclip has already
decided to dispatch. It should be picked up by `startNextQueuedRunForAgent`
within one scheduler tick (default 30s) of a concurrency slot opening. A
`queued` row that sits for a long time is not a wake that failed to enqueue —
it is a run the dispatcher is failing to advance.

## Why this needed its own alert

Before BLO-21116, a stranded `queued` run was invisible:

- The issue it targets still shows `status: in_progress`, an assignee, and an
  `activeRun` with `status: queued` — it looks like normal in-flight work, not
  a fault.
- No existing series covered it.
  `paperclip_external_runtime_reservation_oldest_age_seconds` tracks
  external-runtime **slot reservations**, a different resource.
  `paperclip_agent_wakeup_terminal_failed_oldest_age_seconds` only covers wakes
  that reached the **terminal** `failed` state — a `queued` run is by
  definition not terminal.
- It actively generates noise: the productivity-review detector reads
  undispatched queue time as "unattended active duration" and files a false
  escalation against the assignee, consuming a reviewer heartbeat to
  adjudicate a non-problem. See BLO-21116's description for a worked example
  (BLO-18991 / BLO-21114) and the issue's own thread for at least three more
  (BLO-20807, BLO-20171, BLO-20725 / BLO-21082 / BLO-21701).

## What to do when paged

### Step 1 — find the rows for the paged agent

```sql
select id, agent_id, status, created_at, queued_at,
       now() - coalesce(queued_at, created_at) as age,
       context_snapshot ->> 'issueId' as issue_id,
       context_snapshot ->> 'wakeReason' as wake_reason
from heartbeat_runs
where status = 'queued'
  and agent_id = '<agent_id from the alert>'
order by coalesce(queued_at, created_at) asc
limit 10;
```

`queued_at` is null for a run that entered `queued` fresh (where `created_at`
already is the queue-entry time); it is stamped only when an *existing* row
is requeued (a promoted `scheduled_retry`, or a `running` deferred back to
`queued`). Use `coalesce(queued_at, created_at)` for age and ordering, the
same expression the gauge itself uses — a bare `created_at` can show a
retried row as hours older than the `$value` that actually fired.

### Step 2 — tell starvation apart from a dropped dispatch

These need different fixes; do not assume one covers both.

- **Saturation (starvation).** The agent is at `maxConcurrentRuns` running
  pods, and OTHER queued runs for the same agent are cycling through slots
  while this one is not. This is a **fairness** problem in the dispatch-rank
  aging: `dispatchRank` in `server/src/services/heartbeat.ts` preserves ranks
  0-1 for explicit critical-priority work "no matter how long" a non-critical
  run has waited (see the BLO-16253 comment block), so a non-critical run can
  in principle wait indefinitely under sustained critical-priority pressure on
  one agent. Confirm via `mcp__k8s-ro__pods_list_in_namespace` /
  `kubectl get pods -n paperclip -l paperclip.io/agent-id=<id>` — if the pod
  count equals `maxConcurrentRuns` and none of them belong to the stranded
  run's `id`, this is starvation, not a lost dispatch.
- **Dropped dispatch.** The agent has a free slot (fewer running pods than
  `maxConcurrentRuns`) and the row is still `queued`. This points at the
  scheduler tick itself: check whether `heartbeatSchedulerStopped` /
  `heartbeatStartupRecoveryPending` is stuck true on the serving pod (would
  silently no-op the *entire* periodic chain — dispatch AND scheduled-retry
  promotion — on that pod only), or whether `getSchedulingSuppression()` is
  unexpectedly returning `suppressed: true`.
- **A promoted scheduled retry that then stalled.** If the row's
  `contextSnapshot` shows it originated from a `scheduled_retry` (a 429
  provider-capacity or dependency-blocked deferral), confirm
  `promoteDueScheduledRetries` actually flipped it to `queued` (it will have,
  if `status` reads `queued` rather than `scheduled_retry`) and then apply the
  saturation/dropped-dispatch split above — promotion succeeding does not by
  itself guarantee dispatch.

### Step 3 — check whether the recovery path already knows

`GET /api/issues/{issueId}` → `activeRecoveryAction` and `successfulRunHandoff`.
A `successfulRunHandoff.hasLiveContinuation: true` pointing at a `liveRunId`
that matches the stranded run does NOT mean the run is progressing — it means
the control plane believes a live continuation exists, which can suppress a
corrective re-wake (`decideSuccessfulRunHandoff`, skip reason "issue already
has an active execution path"). If the named `liveRunId` has no matching pod,
that suppression is stale.

## Silencing

`severity: warning`. Silence on the alert name plus `agent_id` for a bounded
window if you are deliberately holding an agent at saturation (e.g. an
intentional capacity-limited rollout); do not raise the threshold — the AC
this alert backs (BLO-21116) is explicit about firing before 30m.

## Verifying the signal is live

```
paperclip_queued_run_oldest_age_seconds
```

Zero-initialized per known agent on every `/metrics` scrape (reset-then-set,
see `setQueuedRunOldestAgeMetrics`), so a healthy fleet renders **0** per
agent, not "No data" — a "No data" reading means the scrape or the refresh
function is broken, which is a different and worse problem than the alert
firing.

### Where the rule actually runs

Same caveat as `runbooks/agent-wakeup-terminal-failed.md`: the chart copy at
`deploy/helm/paperclip/templates/prometheusrule.yaml` **does not deploy on
Blockcast** (`prometheusRule.enabled: false`). The rule that fires in
production must be landed in `Blockcast/onprem-k8s`, in both lockstep-enforced
files (`monitoring/prometheus-configmap.yaml` key
`paperclip-runtime-alerts.rules.yml`, authoritative, plus the CRD
documentation copy) and then manually synced through the `monitoring-rules`
Argo app (BLO-19095 — that gate once stranded 15 merged alerts for 8 days).
**As of this writing that onprem-k8s change has not yet been confirmed live —
verify against `/api/v1/rules` before treating this alert as production
observability, the same way BLO-20255's alert had to be verified.**

## References

- `runbooks/README.md` — index
- BLO-21116 (this alert and the underlying strand investigation)
- `runbooks/agent-wakeup-terminal-failed.md` — the sibling alert and the
  onprem-k8s lockstep mechanics this one reuses
- BLO-19095 — the manual Argo sync gate that stands between merge and deploy
