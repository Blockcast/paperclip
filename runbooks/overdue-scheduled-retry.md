# Overdue scheduled retries

Source: `server/src/services/overdue-scheduled-retry-metrics.ts`
(`refreshOverdueScheduledRetryAgeMetrics`) and
`server/src/services/metrics.ts`
(`OVERDUE_SCHEDULED_RETRY_OLDEST_AGE_METRIC`)

Trigger: `PaperclipOverdueScheduledRetry` —
`max(paperclip_overdue_scheduled_retry_oldest_age_seconds) by (agent_id) > 5400`
for 5m

Owner: Platform / SRE (BLO-22094)

## The invariant

A `heartbeat_runs` row at `status='scheduled_retry'` is parked until its
`scheduled_retry_at` due time. The heartbeat scheduler must then either promote
it for dispatch or deliberately re-defer it with a later due time. A row that
is still parked after its due time is evidence that the promotion path did not
make progress.

The gauge ages from `scheduled_retry_at`, not `created_at`. A retry whose due
time is still in the future is ordinary backoff and must contribute zero. The
gauge is rewritten for every known agent on each `/metrics` scrape, so zero is
healthy and missing data means the scrape or refresh path is broken.

## What to do when paged

### Step 1 — find the exact parked rows

```sql
select id,
       agent_id,
       scheduled_retry_reason,
       scheduled_retry_attempt,
       scheduled_retry_at,
       now() - scheduled_retry_at as overdue_by,
       updated_at,
       now() - updated_at as since_last_touch,
       context_snapshot ->> 'issueId' as issue_id
from heartbeat_runs
where status = 'scheduled_retry'
  and scheduled_retry_at < now()
  and agent_id = '<agent_id from the alert>'
order by scheduled_retry_at asc
limit 10;
```

The first row is the one whose overdue age drove the alert.

### Step 2 — distinguish a legitimate re-deferral from a wedged promotion

Some retries are intentionally re-deferred. For example, a
`scheduled_retry_reason = 'issue_dependencies_blocked'` row can be checked at
its due time, find unresolved dependencies, and receive a new later
`scheduled_retry_at`. This is expected backoff, not a stranded retry.

Run the query above twice a few seconds apart:

- If `updated_at`, `scheduled_retry_at`, or `scheduled_retry_attempt` moves
  forward, the sweep is touching the row. Inspect the named issue/dependencies
  rather than restarting the scheduler.
- If these fields remain stale well past a scheduler tick, inspect the
  heartbeat scheduler and its logs for a promotion exception or a global
  scheduling suppression. Check other agents too: a fleet-wide absence of
  promotions/re-deferrals points to the sweep; a single affected agent points
  to row-specific locking or validation.

### Step 3 — recover safely

Do not edit a parked run directly as the first response. Restore the scheduler
or clear the blocking condition, then confirm the row is promoted or rearmed
through the normal transition. Re-query the row and confirm the per-agent gauge
returns to `0` after the last overdue retry clears.

## Where the rule runs

The Helm chart copy in `deploy/helm/paperclip/templates/prometheusrule.yaml`
does not deploy on Blockcast while `prometheusRule.enabled` is false. The live
monitoring-rule copy and its Argo sync are a separate onprem-k8s change; verify
Prometheus `/api/v1/rules` before treating this chart-only rule as live paging.

## References

- BLO-22094
- `server/src/services/heartbeat.ts` — scheduled retry promotion and re-deferral
- `runbooks/README.md` — runbook index
