# Stranded queued heartbeat runs

Source: `server/src/services/queued-run-age-metrics.ts`,
`server/src/services/metrics.ts` (`paperclip_queued_run_oldest_age_seconds`)

Trigger: `PaperclipQueuedRunStranded` — an agent's oldest queued run is older
than 1,440 seconds for 5 minutes (no later than 29 minutes of queue wait).

Owner: Platform / SRE (BLO-21116)

## What this means

A `heartbeat_runs` row with `status = 'queued'` has already been accepted for
execution and is waiting to claim an agent slot. It is not a wake that failed
to enqueue. A long-lived row can leave an issue looking in progress while no
agent is actually advancing it.

The metric uses `coalesce(queued_at, created_at)` as its queue-entry time.
Fresh rows use `created_at`; scheduled retries and K8s-isolation deferrals set
`queued_at` when they re-enter the queue. This prevents an old retry backoff
from being reported as current dispatch wait.

## Find the row that fired

Use the queue-entry expression from the metric and alert annotation exactly:

```sql
select id,
       agent_id,
       status,
       coalesce(queued_at, created_at) as queued_since,
       now() - coalesce(queued_at, created_at) as queue_age,
       context_snapshot ->> 'issueId' as issue_id,
       context_snapshot ->> 'wakeReason' as wake_reason
from heartbeat_runs
where status = 'queued'
  and agent_id = '<agent_id from the alert>'
order by coalesce(queued_at, created_at) asc
limit 10;
```

The first row is the one whose age triggered the alert.

## Triage

1. Check whether the agent is saturated. Compare running Paperclip agent Jobs
   with the agent's `maxConcurrentRuns`. If all slots are occupied, determine
   whether work is still cycling; this is capacity or dispatch-fairness
   starvation rather than a dropped wake.
2. If a slot is free, investigate the heartbeat scheduler and dispatch path.
   Check the serving pod's scheduler logs, scheduling suppression decisions,
   and the selected run's wakeup request. Do not mark the issue complete merely
   because it still has an active run pointer.
3. If the queued run originated from `scheduled_retry`, confirm its promotion
   completed, then use the same saturated-versus-free-slot split. A successful
   promotion does not prove a subsequent dispatch happened.
4. Requeue or cancel only after recording why the original dispatch was lost;
   first capture the run, wakeup, and scheduler evidence needed to avoid a
   duplicate execution.

## Metric freshness

The server rebuilds this gauge on every `/metrics` scrape. If the database
query fails, it deliberately removes the queued-run samples instead of serving
old zeros or old high values. Therefore **no data is not healthy** for this
signal: inspect server logs for `failed to refresh queued-run-age metrics
before scrape` and restore database access before relying on the alert again.

After a successful refresh, every known agent has either its oldest queue age
or an explicit zero. Confirm with:

```promql
paperclip_queued_run_oldest_age_seconds
```

## Deployment note

The in-repository Helm rule is disabled by `values.blockcast.yaml`; Blockcast's
production monitoring rule is maintained and manually synced in
`Blockcast/onprem-k8s`. Keep the production rule's threshold, queue-entry SQL,
and runbook URL aligned with this chart before treating a Paperclip merge as a
production alert rollout.

## References

- BLO-21116
- `server/src/services/heartbeat.ts` (`promoteDueScheduledRetries` and K8s
  isolation deferral)
