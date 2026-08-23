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

## Overdue scheduled-retry (BLO-22094)

Source: `server/src/services/queued-run-age-metrics.ts`
(`refreshOverdueScheduledRetryAgeMetrics`), `server/src/services/metrics.ts`
(`OVERDUE_SCHEDULED_RETRY_OLDEST_AGE_METRIC`,
`setOverdueScheduledRetryAgeMetrics`,
`OVERDUE_SCHEDULED_RETRY_AGE_METRICS_REFRESH_SUCCESS_METRIC`)
Trigger: alert `PaperclipOverdueScheduledRetry` —
`max by (agent_id) (paperclip_overdue_scheduled_retry_oldest_age_seconds and on(instance) (paperclip_overdue_scheduled_retry_age_metrics_refresh_success == 1)) > 5400`
for 5m
Companion: alert `PaperclipOverdueScheduledRetryAgeMetricsRefreshFailed` —
`paperclip_overdue_scheduled_retry_age_metrics_refresh_success == 0` for 5m
Owner: Platform / SRE (BLO-22094)

### The invariant, and why it needed a second alert rather than reusing the one above

A `heartbeat_runs` row at `status='scheduled_retry'` is **parked**, not
dispatched — it has not yet reached the `queued` state `PaperclipQueuedRunStranded`
covers. `promoteDueScheduledRetries` (`server/src/services/heartbeat.ts`) sweeps
these on the same periodic tick as dispatch and should flip a row to `queued`
(`promoteScheduledRetryRun`) within one tick of its `scheduled_retry_at` due
time passing.

`PaperclipQueuedRunStranded`'s gauge deliberately excludes `scheduled_retry`
rows at any age — `refreshQueuedRunAgeMetrics` filters
`status = 'queued'` only, and `promoteScheduledRetryRun` resets `queuedAt` on
promotion, so a retry's backoff time never counts as queued-dispatch wait
(Ally review, onprem-k8s#2013 — without that exclusion a retry promoted after
hours of backoff would instantly report that whole backoff as a stranded
queue). That exclusion is correct and stays. Its side effect is that a retry
which parks and is **never promoted** was invisible to any gauge, forever —
the promotion sweep could wedge and nothing would page. This alert is that
missing detector: it ages `scheduled_retry` rows off their own `scheduled_retry_at`
due time, counting only rows already overdue (`scheduled_retry_at < now()`).
A row still backing off toward a future due time contributes exactly 0.

### What to do when paged

#### Step 1 — find the overdue rows for the paged agent

```sql
select id, agent_id, scheduled_retry_reason, scheduled_retry_attempt,
       scheduled_retry_at, now() - scheduled_retry_at as overdue_by,
       updated_at, now() - updated_at as since_last_touch,
       context_snapshot ->> 'issueId' as issue_id
from heartbeat_runs
where status = 'scheduled_retry'
  and scheduled_retry_at < now()
  and agent_id = '<agent_id from the alert>'
order by scheduled_retry_at asc
limit 10;
```

#### Step 2 — tell a wedged promotion sweep apart from a gate legitimately re-deferring

These look identical in the gauge (both are "a `scheduled_retry` row past its
due time"), but need different responses. Do not assume every page here is a
dead scheduler.

- **A gate legitimately re-deferring.** `issue_dependencies_blocked` is the
  concrete case (`heartbeat.ts`, the `DEP_BLOCKED_RETRY_REASON` branch of
  `promoteScheduledRetryRun`): at promotion time it re-checks dependency
  readiness, and if the blockers are still unresolved it rearms
  `scheduled_retry_at` further out with exponential backoff and stays at
  `status='scheduled_retry'` — logging `"dependencies still blocked at
  promotion; re-deferred with backoff"` as a run event and incrementing the
  `dep_blocked_redeferred` counter. This is designed backoff, not a strand.
  **Diagnostic:** re-run the query from Step 1 a few seconds apart. A row
  that is alive and re-deferring shows `updated_at`/`scheduled_retry_at`
  moving forward each pass (the sweep is touching it, just re-arming it
  faster than you're reading), and `scheduled_retry_attempt` climbing. Check
  `GET /api/issues/{issueId}` (from `context_snapshot ->> 'issueId'`) for the
  actual `blockedBy` set — if it is genuinely unresolved, this is the
  dependency graph's problem to fix (chase the named blocker), not the
  scheduler's.
- **The promotion sweep is wedged.** `updated_at` on the row is stale —
  unchanged since long before `scheduled_retry_at` passed, well past one
  scheduler tick (default 30s). Confirm fleet-wide, not just this row: check
  `heartbeat_run_events` for *any* recent `"Scheduled retry became due and was
  promoted to the queued run pool"` or `"re-deferred with backoff"` message
  across other agents/rows. If nothing has promoted or re-deferred fleet-wide
  in the alerting window, `promoteDueScheduledRetries` itself has stopped
  running — this shares its root cause with the "dropped dispatch" case in
  the section above (`heartbeatSchedulerStopped` / `heartbeatStartupRecoveryPending`
  stuck `true` silently no-ops the *entire* periodic chain, dispatch AND
  retry promotion together, on that pod), or `getSchedulingSuppression()`
  unexpectedly returning `suppressed: true`. If only this one agent's rows are
  affected while other agents keep promoting normally, look for a lock or
  exception specific to this row (e.g. a promotion attempt repeatedly
  throwing before it can `UPDATE`) rather than a fleet-wide scheduler fault.

### When the overdue refresh-failure alert fires

`PaperclipOverdueScheduledRetryAgeMetricsRefreshFailed` means the scrape-time
database refresh behind this gauge threw. It does **not** mean no row is
overdue — it means nobody knows.

Read it as a **detector outage, not an all-clear.** The refresh only
reset-then-sets on its success path, so a throw leaves the previous per-agent
values frozen in the registry while `/metrics` keeps returning `200` (the
rejection is swallowed into a `logger.warn` at `server/src/app.ts`). The frozen
value is almost always `0` — the *healthy* reading — so an ungated
`PaperclipOverdueScheduledRetry` would sit silently green on top of a dead
detector. That is why the alert above carries the
`and on(instance) (... == 1)` gate, and why this alert exists to page when the
gate closes.

Note this fires **independently of** `PaperclipQueuedRunAgeMetricsRefreshFailed`.
The two refreshes run different aggregates behind different indexes (`0217`
covers `status='queued'`; `0224` covers the overdue-parked predicate), so a
statement timeout or plan regression can hit one and not the other. A healthy
`paperclip_queued_run_age_metrics_refresh_success` does **not** vouch for this
one — check this series by name.

1. Check Paperclip server logs for `failed to refresh
   overdue-scheduled-retry-age metrics before scrape`; the `err` field carries
   the database error.
2. Check database connectivity and statement timeouts. If only this refresh is
   failing while the sibling is healthy, suspect the `0224` partial index —
   confirm `heartbeat_runs_overdue_scheduled_retry_idx` is `valid` in
   `pg_index`, since an invalid index left behind by a failed
   `CREATE INDEX CONCURRENTLY` makes the planner fall back to a sequential
   scan over ~219k rows.
3. Recovery is automatic on the next successful scrape — the gauge returns to
   `paperclip_overdue_scheduled_retry_age_metrics_refresh_success 1`.

Do not silence this to quiet the page: silencing it while the gate is closed
leaves the overdue detector dead *and* mute, which is the exact failure this
whole section exists to prevent.

### Silencing

`severity: warning`. As with `PaperclipQueuedRunStranded`, silence on the
alert name plus `agent_id` for a bounded window if you are deliberately
holding an agent's retries back; do not raise
`prometheusRule.overdueScheduledRetryAgeSeconds` to make a real strand quiet —
that threshold was derived from a 7-day park→promotion population (p50=21.5s,
p90=83.7s, p95=131.9s, p99=1594.8s, max=3567.5s over the 2026-07-31..2026-08-07
window; see the `values.yaml` comment for the full derivation and the reason
it margins off the worst single day's max rather than the aggregate p99).

### Verifying the signal is live

```
paperclip_overdue_scheduled_retry_oldest_age_seconds
paperclip_overdue_scheduled_retry_age_metrics_refresh_success
```

Zero-initialized per known agent on every `/metrics` scrape (reset-then-set,
see `setOverdueScheduledRetryAgeMetrics`), same contract as
`paperclip_queued_run_oldest_age_seconds` above — a healthy fleet renders **0**
per agent, not "No data".

Read the two together, exactly as with the queued pair above: the age series is
only meaningful while the refresh series reads `1`. A `0` age under a `0`
refresh is a stale snapshot, not an idle fleet.

Same onprem-k8s lockstep caveat as the section above applies here too: the
chart copy at `deploy/helm/paperclip/templates/prometheusrule.yaml` does not
deploy on Blockcast (`prometheusRule.enabled: false`) — verify this rule
against `/api/v1/rules` in the environment that actually pages before relying
on it, and confirm the `Blockcast/onprem-k8s` copy is in place if it isn't.

## References

- `runbooks/README.md` — index
- BLO-21116 — JSON-parse recovery classification and queued-run observability
- BLO-22094 — the `PaperclipOverdueScheduledRetry` alert above
- `runbooks/agent-wakeup-terminal-failed.md` — the sibling alert
- BLO-19095 — the manual Argo sync gate between merge and deployment
