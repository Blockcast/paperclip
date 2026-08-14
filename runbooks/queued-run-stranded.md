# Stranded queued runs (an issue looks active, but nothing is executing)

Source: `server/src/services/queued-run-age-metrics.ts`
(`refreshQueuedRunAgeMetrics`) and `server/src/services/metrics.ts`
(`QUEUED_RUN_OLDEST_AGE_METRIC`,
`QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC`).

Triggers:

- `PaperclipQueuedRunStranded` — an agent's oldest queued run is older than
  `queuedRunStrandedAgeSeconds` (1440 seconds by default), and the age
  snapshot refreshed successfully. The five-minute alert hold means it can
  fire before 30 minutes of real queue wait.
- `PaperclipQueuedRunAgeMetricsRefreshFailed` — the most recent `/metrics`
  database refresh failed, so queued-run ages are stale and intentionally do
  not qualify the stranded-run alert.

Owner: Platform / SRE (BLO-21116)

## The invariant

A `heartbeat_runs` row at `status='queued'` is a run Paperclip has already
decided to dispatch. It should be picked up by `startNextQueuedRunForAgent`
within one scheduler tick (default 30s) of a concurrency slot opening. A
`queued` row that sits for a long time is not a wake that failed to enqueue —
it is a run the dispatcher is failing to advance.

Age is measured from `coalesce(queued_at, created_at)`:

- A fresh queued row has no `queued_at`; `created_at` is its queue-entry time.
- A row promoted from `scheduled_retry`, or returned from a K8s isolation
  conflict, records `queued_at` at that transition.
- Migration `0215_heartbeat_runs_queued_at` backfills existing queued rows
  from `updated_at`. Migration `0217_heartbeat_runs_queued_age_idx` adds
  the queue-only expression index used by the scrape query.

## Why this needed its own alert

Before BLO-21116, a stranded `queued` run was invisible:

- The issue it targets still shows `status: in_progress`, an assignee, and an
  `activeRun` with `status: queued` — it looks like normal in-flight work, not
  a fault.
- No existing series covered it. The external-runtime reservation age tracks
  a different resource, and the terminal-failed wake age only covers wakes
  that have already become terminal.
- It actively generates noise: the productivity-review detector can read
  undispatched queue time as unattended active duration and file a false
  escalation against the assignee.

## Read the two gauges together

```promql
paperclip_queued_run_oldest_age_seconds
paperclip_queued_run_age_metrics_refresh_success
```

The freshness gauge is `1` only when the current scrape's database
aggregation succeeded and `0` when it failed. It is not a queue-health gauge:
`0` means the age is unknown, never that no queued work exists.

The stranded-run alert requires freshness to be `1`. A failed refresh retains
the last age snapshot in memory, but the freshness gate prevents stale data
from firing or suppressing the primary alert. Resolve the refresh-failure
alert first.

## What to do when paged

### Step 1 — find the rows for the paged agent

Use the same queue-entry expression as the metric. Do not query or sort by
`created_at` alone: that overstates a retry recently promoted from a long
scheduled backoff.

```sql
select id,
       agent_id,
       status,
       coalesce(queued_at, created_at) as queued_at,
       now() - coalesce(queued_at, created_at) as queue_age,
       context_snapshot ->> 'issueId' as issue_id,
       context_snapshot ->> 'wakeReason' as wake_reason
from heartbeat_runs
where status = 'queued'
  and agent_id = '<agent_id from the alert>'
order by coalesce(queued_at, created_at) asc
limit 10;
```

The first row is the one whose age drove the alert.

### Step 2 — tell starvation apart from a dropped dispatch

These need different fixes; do not assume one covers both.

- **Saturation (starvation).** The agent is at `maxConcurrentRuns` running
  pods, and other queued runs for the same agent are cycling through slots
  while this one is not. This is a dispatch fairness problem: inspect
  `dispatchRank` in `server/src/services/heartbeat.ts` and its BLO-16253
  comments. The normal aging lanes preserve ranks 0–1 for explicit
  critical-priority work, so a sustained stream of fresh critical work can
  keep routine work waiting until the absolute starvation ceiling is reached.
  Confirm with
  `kubectl get pods -n paperclip -l paperclip.io/agent-id=<id>`; if the pod
  count equals `maxConcurrentRuns` and none belongs to the stranded run, this
  is starvation rather than a lost dispatch.
- **Dropped dispatch.** The agent has a free slot and the row is still
  `queued`. Check whether `heartbeatSchedulerStopped` or
  `heartbeatStartupRecoveryPending` is stuck on the serving pod, whether the
  periodic dispatch tick is running, and whether `getSchedulingSuppression()`
  unexpectedly reports `suppressed: true`.
- **A promoted scheduled retry that then stalled.** If the row originated as
  `scheduled_retry`, confirm `promoteDueScheduledRetries` flipped it to
  `queued`, then apply the saturation/dropped-dispatch split. Promotion does
  not itself guarantee dispatch; its age must be based on `queued_at`.

### Step 3 — check whether the recovery path already knows

`GET /api/issues/{issueId}` → `activeRecoveryAction` and
`successfulRunHandoff`. A `successfulRunHandoff.hasLiveContinuation: true`
pointing at a `liveRunId` that matches the stranded run does not prove that it
is progressing. If the named `liveRunId` has no matching pod, that suppression
is stale and needs correction before a re-wake is dismissed.

## When the refresh-failure alert fires

1. Inspect serving Paperclip logs for `failed to refresh queued-run-age
   metrics before scrape` and the underlying database error.
2. Check database reachability, connection-pool saturation, and query latency.
   Do not interpret an exported age of `0` as current data while freshness is
   `0`.
3. Confirm a fresh `/metrics` scrape exposes
   `paperclip_queued_run_age_metrics_refresh_success 1`.
4. If queued rows are urgent while the metric is stale, run the SQL above
   manually and work from that result.

## Silencing

Both alerts are `severity: warning`. Silence on the alert name and
`agent_id` for a bounded window only when intentionally holding a known agent
at capacity. Do not raise the age threshold to conceal an incident, and never
silence the refresh-failure alert merely because the last visible age is zero.

## Verifying the signal is live

The age gauge is reset-then-set for every known agent on each successful
`/metrics` refresh, so a healthy idle agent renders `0`, not “No data”.
“No data” means the scrape or the refresh function is broken.

The chart rule in `deploy/helm/paperclip/templates/prometheusrule.yaml` is a
mirror on Blockcast: `prometheusRule.enabled` is false in
`values.blockcast.yaml`. The production rule must also be landed in the two
lockstep `Blockcast/onprem-k8s` alert files: the authoritative
`monitoring/prometheus-configmap.yaml` key
`paperclip-runtime-alerts.rules.yml` and the CRD documentation copy. Then
manually sync the `monitoring-rules` Argo application (BLO-19095). Merging
this repository alone does not make the alert live. Before treating the
signal as production observability, verify the rendered rule in Prometheus
at `/api/v1/rules` after deployment; the onprem-k8s change and Argo sync must
be confirmed separately.

## References

- `runbooks/README.md` — index
- BLO-21116 — JSON-parse recovery classification and queued-run observability
- `runbooks/agent-wakeup-terminal-failed.md` — the sibling alert
- BLO-19095 — the manual Argo sync gate between merge and deployment
