# Stranded queued runs (an issue looks active, but nothing is executing)

Source: `server/src/services/queued-run-age-metrics.ts`
(`refreshQueuedRunAgeMetrics`) and `server/src/services/metrics.ts`
(`QUEUED_RUN_OLDEST_AGE_METRIC`,
`QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC`).

Triggers:

- `PaperclipQueuedRunStranded` — an agent's oldest queued run is older than
  `queuedRunStrandedAgeSeconds` (1440 seconds by default), and the age
  snapshot refreshed successfully. The five-minute alert hold means it can
  fire before 30 minutes of real queue wait. This is the per-agent form this
  chart renders. Blockcast's live `onprem-k8s` rules replaced it with the
  fleet-scoped `PaperclipQueuedRunStrandedFleet` (≥5 agents past 1800s, for
  15m; BLO-29665), which also links here.
- `PaperclipQueuedRunAgeMetricsRefreshFailed` — the most recent
  database refresh failed, so queued-run ages are stale and intentionally do
  not qualify the stranded-run alert.

Both freshness properties below describe the live `onprem-k8s` rules as well
as this chart's. They did not, between 2026-08-24 and 2026-10-03: the
BLO-29665 rewrite that introduced `PaperclipQueuedRunStrandedFleet` dropped
the `and on(instance) (… == 1)` gate and shipped no refresh-failure alert, so
the live fleet rule ran ungated on a gauge that freezes on a failed refresh.
Restored by BLO-26656. If you are reading this against an older rule set,
check for the gate in the expression before trusting the paragraphs below.

Owner: Platform / SRE (BLO-21116)

## Scheduled-retry park horizon is a different signal

`paperclip_scheduled_retry_park_horizon_seconds` measures the booked interval
from `heartbeat_runs.updated_at` to `scheduled_retry_at` for live
`status='scheduled_retry'` rows — i.e. how far out the most recent park decision
booked. `PaperclipScheduledRetryParkHorizonImplausible` fires when that future-due
horizon exceeds 5,400 seconds. That bound was set from an earlier seven-day
population (n=5,253, p99=1,594.8s, maximum 3,567.5s) which is now
**superseded**: in the seven days to 2026-09-28 there were 1,016 breaching
samples across 12 agents, every one inside [5,590.1s, 8,977.8s], i.e. below the
`transient_failure` ladder's designed 9,000s ceiling. That ladder's final hop is
7,200s with +/-25% jitter, i.e. [5,400s, 9,000s], so a `transient_failure` page
anywhere in that band is designed backoff, not an implausible booking -- check
the `reason` label before treating a page as a fault.
`PaperclipScheduledRetryParkHorizonMetricsRefreshFailed` is the companion
alert for a failed gauge refresh; while it is firing, the horizon alert is
gated off and its last snapshot is not trustworthy.

> **Read the `reason` label** ([BLO-31174](/BLO/issues/BLO-31174), second
> defect). The gauge is keyed by `agent_id` **and** `reason` (the row's
> `scheduled_retry_reason`, coerced to the bounded allow-list, anything else
> reads `other`). Legitimate ceilings differ by class and span at least 289x
> (300s to 86,700s, and a `provider_quota` floor has none), so for a class
> listed below, judge a value against its own ceiling, not the flat 5,400s rule:
>
> | `reason` | designed ceiling | source |
> |---|---:|---|
> | `max_turns_continuation` | 300s | `MAX_TURN_CONTINUATION_MAX_DELAY_MS` |
> | `ccrotate_capacity` | 1,080s | `CCROTATE_CAPACITY_MAX_PARK_MS` (15min) x (1 + `CCROTATE_CAPACITY_PARK_JITTER_RATIO` 0.2), jitter added after the clamp |
> | `dependency_blocked` | 3,600s | `DEP_BLOCKED_MAX_DELAY_MS` |
> | `transient_failure`, backoff ladder | 9,000s | final 2h hop of `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS` x (1 + 0.25 jitter) |
> | `transient_failure`, upstream `retryNotBefore` floor | 86,700s | `MAX_TRANSIENT_RETRY_HORIZON_MS` (24h) + `TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS` (5min forward jitter on a floor at or just under the clamp, which is therefore not clamped) |
> | `transient_failure`, `provider_quota` floor | none | adopted verbatim, never clamped (`clampTransientHorizon` in `scheduleBoundedRetryForRun`) |
>
> `transient_failure` is one label over three mechanisms, and the gauge cannot
> tell them apart: a value in (9,000s, 86,700s] is a floored park, not a fault,
> and one above 86,700s is either a `provider_quota` floor or a fault. Before
> calling it either, read the run's error family (`readHeartbeatRunErrorFamily`:
> `result_json.errorFamily`, else derived from `error_code`, where
> `provider_quota` and `provider_quota_exhausted` both map to `provider_quota`);
> only a non-`provider_quota` family above 86,700s is a writer bug. A per-reason
> alert on `transient_failure` therefore cannot bound it at 9,000s.
>
> The table is the subset of classes whose designed ceiling is known, not the
> whole allow-list (`KNOWN_RETRY_SCHEDULE_REASONS` in
> `server/src/services/metrics.ts`). `capacity_blocked` is a separate class from
> `ccrotate_capacity` and is not covered by its 1,080s row. For a reason that is
> not in the table, no per-class constant is documented yet, so the flat 5,400s
> rule is still the only bound in force for it: treat the page as a candidate
> fault, and read that reason's delay at its writer (grep the reason string under
> `server/src/services/`) before calling it designed backoff. `other` can never
> have a row: it is the catch-all that NULL and every unrecognised
> `scheduled_retry_reason` coerce to, so it mixes classes. On an `other` page,
> read the raw `heartbeat_runs.scheduled_retry_reason` of the agent's
> `status='scheduled_retry'` rows first, then judge it as that class.
>
> Every known agent also carries a `reason="none"` series pinned at 0. It is a
> per-agent zero floor emitted for **every** agent, including ones with live
> parks, so `count(...{reason="none"})` is fleet size, not the number of drained
> agents. It is not a park class and never carries a bound; `max by (agent_id)`
> aggregates it away, which is why the flat rule reads exactly as before.

> **Do not measure this from `created_at`** ([BLO-31174](/BLO/issues/BLO-31174)).
> A park is re-decided in place: each re-check UPDATEs the same row with a new
> `scheduled_retry_at` and `updated_at`, while `created_at` stays pinned at the
> first park. Measured from `created_at` the value reports how long the row has
> been *re-parking*, climbs by one backoff interval per re-check without bound,
> and crosses the threshold after ~2 re-checks however sane each booking was. On
> 2026-09-03 that had 9 agents firing simultaneously, every one of them booking a
> correct ~1h `dependency_blocked` backoff.

The Helm rule is a mirror only: Blockcast production loads the corresponding
rules from the lockstep `onprem-k8s` Prometheus ConfigMap/CRD pair, not this
chart's disabled-by-default `PrometheusRule`. A merged chart rule is therefore
not proof that the production alert is live; verify the authoritative rules and
the `monitoring-rules` Argo sync before closing an incident.

> **Inside `onprem-k8s`, the ConfigMap is the authoritative half of that pair —
> not the CRD.** Prometheus loads the `*.rules.yml` keys out of
> `monitoring/prometheus-rules-*-configmap.yaml`; the `PrometheusRule` CRD
> (`paperclip/*-prometheusrule.yaml`) is a copy kept in lockstep beside it. So
> editing only the CRD changes nothing a responder will ever see, even after the
> PR merges and Argo syncs. Edit **both**, and let
> `scripts/check-prometheus-rules-lockstep.sh` confirm it — that script names the
> ConfigMap as authoritative in its own failure text.
>
> Two CI gates catch this, and both name the CRD, which is why the failure reads
> as two unrelated problems instead of one missed file: `CRD vs CM lockstep`
> diffs the pair, and `promtool check config (parse gate)` extracts its rules
> **from the ConfigMap shards**, so a unit-test expectation updated alongside the
> CRD is asserted against the stale ConfigMap text. Fixing the ConfigMap clears
> both at once. This is not hypothetical: it is exactly how
> [BLO-31174](/BLO/issues/BLO-31174)'s own mirror PR
> ([onprem-k8s#3047](https://github.com/Blockcast/onprem-k8s/pull/3047)) went red.

This is not the [BLO-22094](/BLO/issues/BLO-22094) overdue detector:

- **Park horizon implausible:** the due time was booked too far out; investigate
  the retry/capacity decision immediately, even while the due time is future.
- **Overdue against due time:** `scheduled_retry_at` has passed and promotion
  has not happened; investigate the scheduler/promotion path.

For the horizon alert, query the parked rows directly:

```sql
select id, agent_id, created_at, updated_at, scheduled_retry_at,
       scheduled_retry_attempt,
       extract(epoch from scheduled_retry_at - updated_at) as park_horizon_seconds,
       extract(epoch from scheduled_retry_at - created_at) as cumulative_reparking_seconds,
       scheduled_retry_reason
from heartbeat_runs
where status = 'scheduled_retry'
  and agent_id = '<agent_id from the alert>'
order by park_horizon_seconds desc;
```

A row where `park_horizon_seconds` is sane but `cumulative_reparking_seconds` is
large is **not** a bad booking — it is a row that has been re-parking for a long
time, which is a dependency/capacity question, not a scheduler one. Read
`scheduled_retry_reason` and `scheduled_retry_attempt` to tell which.

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

1. Inspect serving Paperclip logs for `scrape-metrics collector refresh failed`
   with `refresh: "queued-run-age"` and the underlying database error. (Before
   BLO-33243 this refresh ran inline on the scrape and logged `failed to
   refresh queued-run-age metrics before scrape`; it now runs on a 15 s
   background interval.)
2. Check database reachability, connection-pool saturation, and query latency.
   `paperclip_db_pool_waiting_queries` above 0 with
   `paperclip_db_pool_connections{state="idle"}` at 0 is pool exhaustion on
   that pod (BLO-33243). Do not interpret an exported age of `0` as current
   data while freshness is `0`.
3. Confirm a fresh `/metrics` scrape exposes
   `paperclip_queued_run_age_metrics_refresh_success 1`.
4. If queued rows are urgent while the metric is stale, run the SQL above
   manually and work from that result.

Freshness now also drops to `0` when the collector *stops ticking altogether*,
not only when a refresh rejects — a wedged collector would otherwise leave the
gauge reading last-good over a frozen age, which is the same invisible failure
the gauge exists to prevent.

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
`monitoring/prometheus-rules-2-configmap.yaml` key
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

1. Check Paperclip server logs for `scrape-metrics collector refresh failed`
   with `refresh: "overdue-scheduled-retry-age"`; the `err` field carries the
   database error. (Pre-BLO-33243 this logged `failed to refresh
   overdue-scheduled-retry-age metrics before scrape`.)
2. Check database connectivity and statement timeouts. If only this refresh is
   failing while the sibling is healthy, suspect the `0224` partial index —
   confirm `heartbeat_runs_overdue_scheduled_retry_idx` is `valid` in
   `pg_index`, since an invalid index left behind by a failed
   `CREATE INDEX CONCURRENTLY` makes the planner fall back to a sequential
   scan over ~219k rows.
3. Recovery is automatic on the next successful collector tick (15 s) — the
   gauge returns to
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

## Agent start lock wedged (PEN-3305)

Source: `server/src/services/agent-start-lock.ts` (`withAgentStartLock`,
`describeHeldAgentStartLocks`), `server/src/services/metrics.ts`
(`AGENT_START_LOCK_HELD_SECONDS_METRIC`, `setAgentStartLockHeldMetrics`),
`server/src/services/scrape-metrics-collector.ts`
(`refreshAgentStartLockMetrics`)
Trigger: **two alerts** at Blockcast, plus a third expression in the chart copy.

Blockcast's live rules, since `Blockcast/onprem-k8s#4036` landed the BLO-36522
retune as a split rather than a single retuned rule (`#3985`, the single-rule
form this section was originally written against, was closed superseded):

| alert | expression | `for` | regime |
|---|---|---|---|
| `PaperclipAgentStartLockWedged` | `max by (agent_id) (paperclip_agent_start_lock_held_seconds) > 14400` | 5m | one agent, **>4h** -- no hold past 4h has been observed to settle |
| `PaperclipAgentStartLockFleetStall` | `count(max by (agent_id) (paperclip_agent_start_lock_held_seconds) > 900) >= 3` | 10m | **>=3 agents** in lockstep -- measured to self-clear |

Both are live: verified loaded at `/api/v1/rules` on 2026-09-30, and the
`>300`-for-5m rule this section used to describe is gone.

The chart copy in this repo renders only the per-agent arm,
`max by (agent_id) (paperclip_agent_start_lock_held_seconds) > 14400` for 5m,
wired to `deploy/helm/paperclip/values.yaml`
`prometheusRule.agentStartLockHeldSeconds` -- which is the source of record for
it, pinned by the chart test to `LOCK_ABORT_MS` in `agent-start-lock.ts` and
**not** to the `LOCK_HELD_ERROR_MS` log budget (PEN-3328). Its threshold now
matches the live wedge arm; it still has **no fleet-stall arm**.

All of these are quoted here for readability only and the live ones live in a
different repo -- the source of record is the lockstep pair
`paperclip/paperclip-runtime-alerts-prometheusrule.yaml` and
`monitoring/prometheus-rules-2-configmap.yaml` in `Blockcast/onprem-k8s`.
Read the numbers there before acting on any of them.
Owner: Platform / SRE (PEN-3305, re-fitted in PEN-3328)

> ⚠️ **This section's Step 4 restart gate is the ONE-AGENT arm.** If several
> agents are held at once, the fleet arm governs — see
> [Fleet stall: many agents in lockstep](#fleet-stall-many-agents-in-lockstep-blo-36922)
> for what that regime is and what to capture. One query tells them apart:
>
> ```
> count(max by (agent_id) (paperclip_agent_start_lock_held_seconds) > 900)
> ```
>
> | result | arm | remedy |
> |---|---|---|
> | `>= 3` | [fleet stall](#fleet-stall-many-agents-in-lockstep-blo-36922): many agents together, ~25 min–2h14m observed, **self-clears** | do **not** replace the process |
> | below 3, or no data | fewer than three agents; the solo hold measured **cycled** (175 resets/6h), and `Wedged` pages at 4 h only if the abort fails to land | this section, which ends with the Step 4 restart gate |
>
> **The fleet arm takes precedence.** A fleet stall pages
> `PaperclipAgentStartLockFleetStall` (that count, `>= 3` for 10m), once per
> episode. `PaperclipAgentStartLockWedged` is not the page for that shape: it
> needs a 4 h hold (`> 14400`), longer than any measured fleet stall, and past
> 4 h PEN-3328 aborts each held section anyway — a landed abort deletes the
> gauge series inside a scrape, so Wedged's `for: 5m` never completes and the
> per-agent signal is `PaperclipAgentStartLockAborted` (`warning`), once per
> agent. Wedged pages only on an abort that fails to land. While the
> count reads `>= 3`, do not apply this section's remedy to any agent,
> whichever name paged; Step 4's per-arm list governs when both fire. Once the
> count drops below 3, an agent that is still held is back in this arm.
>
> Deleting the worker pod on a fleet stall destroys the only evidence of the
> cause and buys nothing: the episode was going to end on its own.
>
> ⚠️ The step-0 count is the robust check because it does not depend on either
> name. FleetStall is live in `Blockcast/onprem-k8s` (#4036, BLO-35571) and is
> **not** in this chart copy — see KNOWN DIVERGENCE below, and verify at
> `/api/v1/rules` before relying on either name.

### ⚠️ What these alerts claim, and what they no longer claim (BLO-36522)

**The name says "wedged". For the regime the old 300s rule actually fired on,
that word was wrong.** The split in `#4036` fixed this by moving the name:
`Wedged` now keys only the >4h regime, where nothing has ever been observed to
clear, and the routine/fleet regime pages as `FleetStall` instead.

⚠️ **Everything in this subsection falsifies claims about the ≤2h14m regime —
i.e. about the `FleetStall` regime and the now-unpaged 15m–4h solo band, not
about `Wedged`.** Do not carry the "it self-heals" wording onto a
`PaperclipAgentStartLockWedged` page: no hold past 4h has ever
been observed to settle, and the one time that regime occurred it ended only
by pod replacement. They are different regimes and the evidence below does not
reach the second one.

Two claims this section used to make were falsified on 2026-09-25:

- *"It does not self-heal."* The 7-day maximum hold — 8043s (2h14m), three
  agents in lockstep — released on its own at 2026-09-24T03:15Z while the
  **same** `paperclip-0` process, up since 09-21T16:33Z, kept running for a
  further **7.75 h**. No restart. The routine case behaves the same way: the
  episode that produced [BLO-35522](https://paperclip.blockcast.net/BLO/issues/BLO-35522)
  peaked at 658.97s and fell to 98.58s inside
  70 minutes, within 29 h of unbroken uptime and zero restarts.
- *"The lock is stuck."* `resets(paperclip_agent_start_lock_held_seconds[6h])`
  = **175** on the observed agent — it is acquired and released roughly every
  two minutes. A genuinely wedged lock has **zero** resets. It is slow, not
  stuck. (The converse does not hold — zero resets does *not* establish a
  wedge, because the series is absent between holds. See Step 4.)

**There are two regimes, and the old 300s threshold could not tell them apart
because it sat inside the normal envelope.** Over 7 days, **21 of 23 agents**
crossed 300s, for **2,730 agent-minutes** (~390/day fleet-wide) — a continuous
condition, not a page. ⚠️ That agent count is a **sliding 7d window and it
moves**: re-measured 2026-09-26 it was **22 of 23**, because one of the two
agents that had been under threshold (peaks of 30.2s and 116.1s on 09-25) rose
to 572.0s. Cite it with its date, and do not restate it as "all agents" — the
argument rests on the proportion being overwhelming, not on it being universal.
Magnitude cannot separate the regimes either: the exceedance
curve is smooth and knee-free (2,730 agent-min >300s → 1,565 >900s → 963
>1800s → 492 >3600s), so no single-agent duration has a natural cut.

| | routine contention | common-mode stall |
|---|---|---|
| duration | seconds → ~10 min | hours |
| agents | one at a time | **≥3 simultaneously, in lockstep** |
| frequency | continuous, nearly every agent | ~1 episode/week |
| pages? | **no, by design** | yes |

**Simultaneity is the discriminator**, which is why the expression counts
agents rather than raising the duration bound. Backtested at 179 fleet-minutes
— one episode, the 2026-09-24T01:00Z event — over all the history Prometheus
retains.

**Both arms stay `critical`, on a new basis.** The old justification was the
non-self-healing claim above, which is dead for the routine regime. They stay
critical because each now fires only on a regime that is genuinely a page —
one agent past 4h, or the fleet-scope episode — and because they must keep the
out-of-band Slack path precisely *because* the suspected fault is in
paperclip's own dispatcher — routing them `warning` would put the page behind
the component it is reporting on. **On `FleetStall` the action is diagnostic
capture, not a restart** (Step 4).

⚠️ **The coverage the retune GIVES UP, in Blockcast's live rules: a solo hold
between ~15m and 4h now pages on nothing.** Stated here because it is the one
cost of the change that is not self-evident from the expressions. In that band
none of the alerts that could catch a single agent does so in Blockcast's live
`onprem-k8s` rules: `FleetStall` needs **≥3** agents, `Wedged` needs **>4h**,
`PaperclipQueuedRunStrandedFleet` needs **≥5**, and the per-agent
`PaperclipQueuedRunStranded` it superseded is already gone from them
(BLO-29665). The ≥5 is read from the lockstep pair cited under Trigger above,
which is also where the ≥3 lives; neither fleet-count form exists in this repo.
So "the fleet alert already covers user-visible impact" is true only in the
fleet regime.

That is a deliberate trade, not an oversight, and the evidence supports it:
the solo hold measured **cycled** (175 resets/6h — acquired and released
about every 2 minutes), and the founding 2026-09-15/16 incident was five
agents, so `FleetStall` would have caught it. A solo hold that really does run
away is still covered — `Wedged` pages at 4h, above the 2h14m self-clearing
maximum in the 7d window measured 2026-09-25 (same sliding window as the agent
count above — it moves; re-measure before citing it). The residual is only the
15m–4h band. **On Blockcast's live `onprem-k8s` rules, if you are triaging a
single stuck agent inside that band, no page will have brought you here**;
reach for
`max by (agent_id) (paperclip_agent_start_lock_held_seconds)` directly, and
read the `resets()` caveat in Step 4 before concluding it is stuck.

**This chart copy keeps that coverage.** It still renders the per-agent
`PaperclipQueuedRunStranded` (`deploy/helm/paperclip/templates/prometheusrule.yaml`,
`queuedRunStrandedAgeSeconds`, 1440s by default), and its own start-lock rule
is the unretuned single-agent `> 300` (see KNOWN DIVERGENCE below). An
installation that enabled the chart still pages on a solo hold, and on its
stranded consequence.

**What holds the locks for 2h14m is still UNKNOWN.** This retune makes the
alert describe reality; it does not explain the stall. Recorded lead, untested
and with no causal claim: 4 of the 5 agents with a firing
`PaperclipAgentZeroTokenRunStreak` were in the lock-contention set, which is
what a run that spends its life waiting on the start lock would look like.

### The invariant, and why it is a cause alert rather than a consequence one

`withAgentStartLock` serializes queued-run dispatch per agent. It has **no TTL
and no owner-liveness check**, deliberately: the defect BLO-20396 removed was a
timeout that let a waiter run *alongside* the holder, so mutual exclusion is
never downgraded by a clock. PEN-3328 added the only bound that is safe under
that constraint — the section is **cancellable**. At `LOCK_ABORT_MS` (4h) its
abort signal fires, `fn` rejects, and the lock releases through the `finally`
that was always there. One section at a time, always.

That bound is not a cure, which is why this alert still exists. Cancellation
only reaches awaits that observe the signal, so a section wedged on something
that ignores it (a socket with no timeout, a promise that never settles) holds its

⚠️ **"Never settles" is the limiting case, and it is NOT what the observed
episodes are** (BLO-36522). The mechanism above is real and unchanged — there
is genuinely no timeout — but every episode measured **since 2026-09-16** has
settled on its own, including the 2h14m fleet one. Read this paragraph as
*"nothing external will break the lock"*, not as *"the hold will last until
you restart it."* Those are different claims and only the first is supported.

⚠️ **The date bound is load-bearing, and the exception is the paragraph
directly below.** The 2026-09-15/16 episode predates it and is the *only*
documented fleet-scope episode that ended with a pod replacement. It is not the
only fleet-scope episode: the 2h14m 2026-09-24 one above was also three agents
in lockstep, and released on its own. The 09-15/16 episode is **not** a
counter-example to the self-heal claim, and it is **not** evidence for it
either: the pod was replaced before the hold was ever observed long enough to
settle, so that episode tells us nothing about what it would have done. Do not
read it as precedent in either direction — and in particular, do not read it
as authorising a restart when the signature in Step 4 is absent.

That agent then dispatches nothing, while every status surface reads healthy —
`status: idle`, `errorReason: null`, `orgChainHealth: healthy`, work piling up
in `queued`. Measured 2026-09-15/16: five agents across two companies dark for
6–19 h, ~70 runs stuck, ended only by a pod replacement on an identical image
digest and StatefulSet revision — **a restart performed under the withdrawn
instruction, not an observation that the hold required one** (see the
qualification above).

In this chart copy, `PaperclipQueuedRunStranded` above fires on the
*consequence* of this, and since PEN-3328 moved this alert onto the 4h abort
boundary the consequence now surfaces **sooner** than the cause pages:
`warning` at ~29m (1440s + `for: 5m`, and gated on
`paperclip_queued_run_age_metrics_refresh_success == 1`) against this alert's
`critical` at 4h05m. That ordering is deliberate — the consequence is worth
surfacing early and cheaply, the cause is worth *paging* on only once the abort
has been given its chance to land. Note what it means in practice: for the first
four hours a genuine wedge is a warning nobody is woken for. That is the
accepted cost of not paging on the settling tail, which cost twenty false
critical pages at the old 300s threshold. In Blockcast's live `onprem-k8s` rules
that per-agent form is gone (BLO-29665), and its successor
`PaperclipQueuedRunStrandedFleet` fires on the consequence only once ≥5 agents
strand at once (see the coverage note above) — this chart copy still renders the
per-agent `PaperclipQueuedRunStranded`. Neither can tell you the cause: a queued
run strands identically under slot starvation, a scheduler-tick gap or a dropped
dispatch. This alert names the mechanism directly, and it is the one that means
a human must act.

### What to do when paged

#### Step 1 — confirm the hold, and read its age from two independent places

```
max by (agent_id) (paperclip_agent_start_lock_held_seconds)
```

An **absent** series means no lock is held — the gauge is emitted only for
locks held at scrape time (reset-then-set, no zero-fill), so unlike the two
age gauges above a healthy agent renders *nothing*, not `0`. "No data" here is
the healthy reading.

Cross-check against the log, which carries the same `agentId` and `heldMs`:

```
kubectl logs -n paperclip paperclip-0 | grep "agent start lock held"
```

`agent start lock held longer than expected` (warn, every 30s) is a section
that is slow. `agent start lock held far past its warn budget; queued-run
dispatch for this agent is still running but overdue` (error, first at 5m then
every 5m) means the section has passed the point where an operator should look
— **it is not what this alert fires on, and it is usually a section that will
settle by itself.** The line this alert fires on is `agent start lock held past
its abort budget and the abort has not landed` (error, from 4h), whose `aborted`
field reads `true`.

⚠️ **The log line and these alerts deliberately no longer share a number.**
Before BLO-36522 the alert was pinned to `LOCK_HELD_ERROR_MS` at 300s so "the
log line and the page cannot disagree". That pinning was abandoned on purpose,
in both the live rules and the chart copy: 300s is the right boundary for the
*log* -- it is where the code stops calling a hold slow -- but as an alert
threshold it fires on 2,730 agent-minutes a week of routine contention. So the
log answers *"is this hold slow?"*, the live fleet arm answers *"is the fleet
stalled at once?"*, and the per-agent arm (live and in the chart) answers *"has
this agent passed the 4h abort boundary?"*.

The chart's threshold is `prometheusRule.agentStartLockHeldSeconds`, pinned to
`LOCK_ABORT_MS` (4h). The two were the same number until PEN-3328 and
deliberately are not any more: over the 14 days to 2026-09-25, 21 agents held
past 300s (peak 8073s / 2h14m) and the old 300s alert reached `firing` for 20
of them, every one of which resolved with no pod recreation and no container
restart. Escalating a log line early costs a log line; paging early routes a
responder to Step 4 pod replacement for a section that was going to finish.

The cost is real and accepted: **an operator grepping the 300s log line will
find entries with no corresponding page, and that is correct.** Expect roughly
390 agent-minutes of these per day fleet-wide with nothing wrong.

#### Step 2 — do NOT clear the agent as healthy

`paperclipGetAgent` will report `status: idle`, `errorReason: null`,
`orgChainHealth: healthy` and a normal budget. `paperclipListParkedAgents`
will not list it. None of those refute the wedge — they are what the wedge
looks like from outside, and they are why the original incident ran 19 h. The
discriminator is a **dispatch**: `startedAt` moving on a run for that agent.
Queue depth falling is not one either; runs can be cancelled.

#### Step 3 — decide whether it is the lock or the pool, and mind the trap

The known-plausible wedge is a second pool connection taken while holding
`lockIssueOwnership`, against `POSTGRES_POOL_MAX` with no acquire timeout
(`issue-recovery-actions.test.ts` still allowlists five such call sites under
BLO-34207). Read the current pool size off `packages/db/src/client.ts` rather
than assuming 10 — BLO-37330 re-derived it against the server-side budget in
`doc/DATABASE-CONNECTION-BUDGET.md`. Check the pool gauges for the **worker**
pod, which is the only tier that dispatches:

```
paperclip_db_pool_connections{pod="paperclip-0"}
```

⚠️ **Two inferences that look sound and are not.**

- *"Saturation explains it."* In the 2026-09-15/16 incident the pod was
  already `idle=0 / active=10 / waiting=385` **4.5 h before the first onset**,
  and the pod serving the fleet healthily afterwards was saturated harder.
  Saturation is not the discriminator. For the last five hours of that outage
  the pod read `idle=6–8 / active=2–4 / waiting=0` and still dispatched
  nothing: the database was not the constraint and the process was not asking.
- *"A pod restart cleared it, so it is not Postgres."* `lockIssueOwnership` is
  `pg_advisory_xact_lock` — transaction-scoped, so it dies with the connection
  and hence with the process, exactly as an in-memory lock does.
  Restart-clears-it does not discriminate between the two.

The signature that *did* discriminate was a permanently `active` connection
count with nothing queued — a stuck transaction — alongside zero dispatches.

#### Step 4 — recovery: capture, then wait. Restart only on the gate below.

**Which arm paged decides what the wait is for** (BLO-36522 split):

- **`PaperclipAgentStartLockFleetStall` alone: capture, then wait.** This is
  the regime the self-heal evidence above covers (every measured hold up to
  2h14m released on its own), and the rationale in the next paragraph is
  about it and nothing else.
- **`PaperclipAgentStartLockWedged`: capture, then re-check the restart gate
  below as the hold ages. The gate is the decision point, not the wait.** No
  hold past 4h has been observed to settle, so the self-heal rationale does
  not license waiting this one out. But the gate cannot return its top row
  until the hold is about 6h old (see the gate), and `Wedged` pages at
  `14400`s + `for: 5m`, about **4h05m**. So on this arm the gate reads
  *inconclusive* for roughly the first **1h55m after the page by
  construction**, not because the lock is healthy. Capture now, put the agent
  id on the issue, and re-run the gate queries once the hold passes 6h; from
  then on, a top-row reading plus the other three signals is the restart
  case below.
- **Both firing: `Wedged` governs** for every agent past 4h, and `FleetStall`'s
  capture-and-wait covers only the agents below it. The two arms are not
  mutually exclusive: the founding 2026-09-15/16 incident (five agents at
  6-19 h) trips both, because each of those agents is past `14400`s. Do not
  let the `FleetStall` self-clear evidence overrule it -- that evidence stops
  at 2h14m.

**Since PEN-3328 the usual case self-heals, and you should confirm that before
reaching for a restart.** The dispatch critical section is cancellable: at
`LOCK_ABORT_MS` (4h) the section's abort signal fires, its in-flight database
work is cancelled for real, `fn` rejects, and the lock is released through the
`finally` that was already there. The agent resumes dispatching and its queued
runs are not lost. When that happens you will see
`PaperclipAgentStartLockAborted` rather than this alert — see the section
below, and prefer chasing *why* a section blocked for four hours over treating
the recovery as the end of it.

**This step used to read "the section must settle or the process must be
replaced" and prescribe `kubectl delete pod`. That prescription is withdrawn
(BLO-36522).** It rested on the non-self-healing claim falsified above: the
worst episode on record cleared itself with the same process still running,
and kept running 7.75 h afterwards. Replacing the worker pod is a
shared-infrastructure mutation affecting **every** agent in the fleet, and the
evidence says it buys nothing the wait would not have given you -- in the
regime that evidence covers, i.e. `FleetStall`; see the per-arm list above.

**So the page's action is evidence capture, on either arm** -- inside a window
that, on `FleetStall`, has closed by itself every time it was measured, and
on `Wedged` feeds the gate below. While it is still firing:

```
max by (agent_id) (paperclip_agent_start_lock_held_seconds)      # who, and how long
resets(paperclip_agent_start_lock_held_seconds[6h])              # see the caveat below before reading this
count_over_time(paperclip_agent_start_lock_held_seconds[6h])     # MANDATORY companion to resets()
paperclip_db_pool_connections{pod="paperclip-0"}                 # idle/active/waiting split
kubectl logs -n paperclip paperclip-0 | grep "agent start lock held"
```

⚠️ **`resets() == 0` does NOT mean "stuck" on its own, and reading it that way
fails toward the restart this step exists to withdraw.** The server publishes
`paperclip_agent_start_lock_held_seconds` **only for locks held at scrape
time** (`deploy/helm/paperclip/values.yaml`), so between holds the series is
*absent*, not zero. `resets()` counts decreases between samples that exist, so
it returns `0` both for a genuinely monotonic hold **and** for an agent with
barely any samples in the window — including a hold that simply began part-way
into the range with no earlier cycling to decrease from. That second shape is
exactly what the 2h14m episode looks like, i.e. the episode used above as the
argument *against* restarting.

**So always read the two together, and judge on sample count first:**

| `count_over_time[6h]` | `resets[6h]` | reading |
|---|---|---|
| high (series present throughout) | `0` | monotonic hold — **genuinely stuck**, the real signature |
| high | `>0` | cycling — routine contention, not stuck |
| low / sparse | `0` | **inconclusive, NOT stuck** — too few samples to decrease from. Do not restart on this. |
| low / sparse | `>0` | cycling — **not stuck**. A decrease was observed, so the lock released at least once however few the samples. |

A `6h` range is also wider than most holds; scoping the range nearer the hold's
own age makes the comparison sharper for diagnosis. The restart gate below
deliberately keeps the `[6h]` range.

Record the agent ids, **both** the `resets` and `count_over_time` values, and
the pool split **on the issue**. Those together are what nobody has captured
yet, and they are destroyed both by the self-heal and by a restart — which is
exactly why the old restart-first instruction kept the cause unknown for as
long as it did.

**The one case that still justifies replacing the pod** is a genuinely stuck
lock, and it has a distinct signature you can now check rather than assume:
the **top row** of the table above — `count_over_time(...[6h])` showing the
series present and climbing throughout **and** `resets(...[6h]) == 0` — for
the affected agents, **and** a permanently `active` connection count with
nothing queued (a stuck transaction), **and** zero dispatches (`startedAt` not
moving). All four, not `resets == 0` alone. Absent that, wait. If you do
restart, capture the block above first.

That gate cannot be met until the hold is roughly six hours old. The series
does not exist before acquisition, so a younger hold cannot be present
throughout a `[6h]` window and lands in the inconclusive third row. This is
deliberate: in practice the gate means "wait about 6h", and the one long hold
observed end to end (2h14m) released on its own well inside that. On a
`Wedged` page, which fires at about 4h05m, that floor lands roughly 1h55m
after the page (per-arm list at the top of this step).

⚠️ Note the gate deliberately sits about two hours beyond the page. This alert
fires at 4h05m; the `[6h]` window above cannot be satisfied until the hold is
roughly six hours old. That gap is intentional — it is the difference between
"wake someone" and "authorise a shared-infrastructure mutation".

Because this alert's threshold **is** that abort boundary, it firing means
something narrower and more serious than it did before PEN-3328: the abort was
requested and did **not** land. Cancellation can only reach awaits that observe
the signal — today, database work — so a section wedged on anything else (an
unbounded socket, an in-process promise that never settles) still holds its
lock. The agent row's `dispatchHealth` distinguishes the two directly, reading
`stalled` for a requested-but-unlanded abort versus `aborted` for one that
landed; read it **on the worker pod**, since the api tier never holds a lock
and so always reports `null` there.

⚠️ **A hold shorter than 4h is not this alert and is not grounds for a
restart.** Holds of minutes to hours are the normal case, not the pathological
one: over the 14 days to 2026-09-25, 21 agents held past 300s with a peak of
8073s (2h14m), and every one released on its own with no pod recreation and no
container restart. Before PEN-3328 this page sat at 300s and fired on 20 of
them. If you are reading a `held far past its warn budget` log line with
`aborted: false`, the abort has not been requested yet — the section is
overdue, not wedged, and the remedy below is the wrong one.

For the genuine residue there is still no in-process remedy: the abort has
already been tried and did not take, so the section must settle or the process
must be replaced. Deleting the worker pod clears it (`kubectl delete pod -n
paperclip paperclip-0`) and the queued runs then dispatch normally. Capture the
pool gauges and the `agent start lock held` lines **before** restarting; the
restart destroys the only evidence of which section was stuck.

Abandoning a still-pending `fn` on a timer is **not** an acceptable extension of
this: it reintroduces the BLO-20396 defect of two sections running at once.
Cancellation makes `fn` finish; it must never make the lock stop waiting for it.

### Verifying the signal is live

```
paperclip_agent_start_lock_held_seconds
```

Unlike the two age gauges above there is **no** companion
`..._refresh_success` series and no freshness gate on the alert expression.
That is deliberate, not an omission: this gauge is a synchronous in-memory map
walk performed on the `/metrics` request path itself (see
`refreshAgentStartLockMetrics`), so a value being present already means the
scrape succeeded — there is no separate refresh that can fail and leave a
stale value behind. Publishing on the scrape path is itself load-bearing: the
section being reported is typically wedged on a database await, which is
exactly when a DB-backed background collector would be stuck behind the thing
it is meant to report. Do not "restore" an `and on(instance) (... == 1)` join
here; it would reference a series that does not exist and make the alert
permanently unevaluable.

To prove the signal end-to-end, hold a lock deliberately in a scratch process:
`withAgentStartLock(agentId, () => new Promise(() => {}), opts)` — the series
appears on the next scrape and its value climbs.

Same onprem-k8s lockstep caveat as the two sections above: the chart copy at
`deploy/helm/paperclip/templates/prometheusrule.yaml` does not deploy on
Blockcast (`prometheusRule.enabled: false`), so merging this repository alone
does **not** make the page live. The rule must also land in the two lockstep
`Blockcast/onprem-k8s` alert files and the `monitoring-rules` Argo application
must be synced (BLO-19095). Verify at `/api/v1/rules` before relying on it.

⚠️ **KNOWN DIVERGENCE, accepted and recorded rather than fixed (BLO-36522).**
Three numbers are now in play and they are not interchangeable: the 300s log
budget (`LOCK_HELD_ERROR_MS`, unchanged), the 14400s per-agent page
(`LOCK_ABORT_MS`), and the live fleet-stall expression. Both the live rules and
the chart have abandoned the old "pin the page to the log budget" policy.

The BLO-36522 retune shipped to the two `Blockcast/onprem-k8s` copies (the only
ones that fire at Blockcast) in `Blockcast/onprem-k8s#4036`, merged 2026-09-28
and verified loaded at `/api/v1/rules` on 2026-09-30. PEN-3328 then re-pinned
the chart copy above to the abort boundary, so the chart no longer carries the
pre-retune `> 300` and no longer pages on every single-agent hold past 300s.

The chart renders nothing at Blockcast (`prometheusRule.enabled: false`), so
this costs Blockcast nothing today. For anyone enabling that chart elsewhere
the landmine is no longer "you get a 300s page" -- PEN-3328 removed that -- it
is that **the chart is only half of the live policy**: it renders the per-agent
wedge arm at the same 14400 the live rule uses, and has no fleet-stall arm at
all. Port that arm from #4036 before setting `prometheusRule.enabled: true`.
Do not instead port `> 900` into the existing arm expecting it to mean what
14400 means here: a fleet-count expression and a per-agent abort boundary
answer different questions.

The divergence is not only the number. The *rationale prose* beside it —
`deploy/helm/paperclip/values.yaml` (`agentStartLockHeldSeconds`) and
`deploy/helm/paperclip/tests/prometheus-rule.test.mjs` — carries a `BLO-36522`
cross-reference pointing here so that neither reads as live Blockcast policy,
and the chart test's threshold assertion deliberately still stands, because it
guards the number this chart actually renders.

## Fleet stall: many agents in lockstep (BLO-36922)

Trigger: **the shape, not an alert name.** The step-0 count at the top of the
[one-agent section](#agent-start-lock-wedged-pen-3305) reads `>= 3`:
`count(max by (agent_id) (paperclip_agent_start_lock_held_seconds) > 900) >= 3`.
That shape pages as `PaperclipAgentStartLockFleetStall` (same expr, `for: 10m`),
one page per episode. It landed in `Blockcast/onprem-k8s` #4036 (BLO-35571) and
is absent from this chart. The onprem-k8s `PaperclipAgentStartLockWedged`
(`> 14400`, 4 h) cannot fire on this shape as measured: the 7-day maximum
hold was 8043s (2h14m). Even past 4 h it would mostly not page — PEN-3328
aborts each held section at that boundary and a landed abort deletes the gauge
series within a scrape, so what surfaces per agent is
`PaperclipAgentStartLockAborted` (`warning`). Verify at `/api/v1/rules` before
expecting any of them to page.

**Do NOT replace the process.** Every measured episode self-cleared with
`process_start_time_seconds` on `paperclip-0` constant across it. A restart
would have been credited with a recovery that was already happening, and would
have destroyed the evidence. Four episodes in the 7d to 2026-09-27 (8, 5, 13
and 14 agents); the leading cause is the un-coalesced fleet-wide orphan reap —
see [below](#leading-cause-and-what-to-check-first-now-blo-36922) — and the row
is BLO-36922.

The stall is real, not a gauge artifact — during the 2026-09-26 22:10–22:52Z
episode `sum(rate(paperclip_k8s_isolated_run_started_total[10m]))*600` fell to
**1.05 run-starts/10min against a ~50 control median**, recovering to 60
immediately on release.

### What has already been falsified: do not re-run these

Measured over 2026-09-26 22:10–22:52Z against an 18:00–21:00Z control:

| hypothesis | verdict | evidence |
|---|---|---|
| Event-loop block / GC pause | **falsified** | `nodejs_eventloop_lag_max_seconds` ≤0.5s throughout; scrapes landed every 60s to ms precision, which a multi-minute stop-the-world pause cannot do. The one 12.85s spike sits 16 min after onset and 26 min before release — neither end of the episode. |
| DB pool exhaustion | **falsified, and anti-correlated** | During the stall `paperclip-0` ran `active=0–2 / idle=8–10 / waiting=0`. In the healthy control the same pool is repeatedly **pegged at `active=10 / idle=0`**. Saturation is what health looks like here; it rises only *after* release. |
| Postgres contention | **falsified for ≥11 of 13 sections** | A `pg_advisory_xact_lock` waiter pins a pool connection. Only 0–2 connections were active, so at most 2 sections could have been in a DB wait — it cannot be the state of 13. *Not* fully closed server-side: there is no postgres exporter, so `pg_locks` / `pg_stat_activity` are unavailable post-hoc. |
| Kubernetes API stall | **falsified** | apiserver p99 for `jobs\|pods` `LIST/POST/DELETE` was at its **lowest** during the stall (LIST 0.099–0.22s vs 0.157–0.558s control; POST 0.23–0.39s vs 1.4–5.6s control). |

The pattern across all four: **every dependency gets quieter during the
stall.** The sections are not queued behind a busy resource — they are making
no I/O at all.

### Two corrections to the intuitive reading

- **Lockstep does not imply a shared blocker.** Dispatch passes start in
  synchronized waves: at 2026-09-27T01:04:12–01:04:29Z **13 agents crossed the
  30s warn threshold within 17 seconds of each other** during an ordinary hour.
  A synchronized *start* plus a common slowdown reproduces the lockstep shape
  with no shared blocker at all, so the shape alone is not evidence of one.
- **The critical section is chronically far over budget, not binary.** In a
  quiet hour (01:03–02:10Z) there were 203 overrun lines, median hold **30s**,
  max **180s**, against a designed expectation of sub-second. The episodes look
  like that same chronic overrun spiking, not a clean wedge/healthy switch.

### What to capture when paged

The cause is unidentified because **no surface retains enough to name it after
the fact**: container logs on `paperclip-0` rotate in ~1 h (all four episodes
had aged out), `paperclip` emits no traces to Tempo, and there is no postgres
exporter. So capture live, while it is firing:

```
kubectl logs -n paperclip paperclip-0 | grep "agent start lock held" > /tmp/held.log
```

`heldMs` in those lines does **not** tell the two arms apart. Each arm is one
continuous hold per agent, so `heldMs` grows line over line in both, and past
`LOCK_HELD_ERROR_MS` both log the same `logger.error` line every 5m. A reset to
~30000 only means one section released and another started. The agent count in
step 0 is what separates the arms; capture these lines for the timeline.

Note the log line names the agent and the hold age but **not what the section
is awaiting** — which is precisely why four episodes went uncaused.

### Leading cause, and what to check first now (BLO-36922)

`startNextQueuedRunForAgent` calls `reapOrphanedRuns` from **inside**
`withAgentStartLock`, and that reap is **fleet-wide, not agent-scoped**: every
`running` row joined to `agents`, a namespace-wide `listManagedAgentJobs`,
`cleanupManagedJobsWithoutRun`, then per-run reservation reads and per-Job
deletes. It was the only unbounded await in the section — `hasActiveJobForAgent`
is fenced at 2s and the adapter's own guard at 15s. So N agents waking together
ran N concurrent whole-fleet sweeps through the single in-pod Kubernetes client.

That resolves the "every dependency gets quieter" pattern above: the work was
queued **client-side** and never reached the apiserver, which is also why 8
`k8s_concurrency_guard_unreachable` trips came from in-pod calls in the same
window while `kubectl` from outside answered in 1.6s.

It also corrects the episode shape recorded above. The starts are **staggered,
the release is simultaneous** — `count(paperclip_agent_start_lock_held_seconds
> 300)` over 2026-09-26 22:15→22:55Z reads `3 → 3 → 6 → 8 → 7 → 11 → 11 → 14 →
0`. Ramp-in/cliff-out is contention that each new waking agent adds to, not one
shared promise everyone is awaiting.

Coalescing (single-flight + a 5s freshness TTL) and a phase breadcrumb merged in
[paperclip#2064](https://github.com/Blockcast/paperclip/pull/2064) on
2026-10-02. **Merged is not deployed**: query the phase gauge before trusting
it, because an absent series here reads exactly like a healthy one.

```
count(count_over_time(paperclip_agent_start_lock_phase_seconds[12h]))
```

Empty means the running pod predates #2064 — as it did on 2026-10-06, when the
same query over `paperclip_agent_start_lock_held_seconds` returned 23 series as
a positive control. Once it answers, **read the phase before anything else**:
it names the await directly and does not depend on the log surviving rotation.
A `phase` of `reap` with `phaseMs` close to `heldMs` confirms this cause. Any
other phase means it is something else — most likely recall latency on the
critical path (BLO-35878), which is **not** excluded.

## Agent start lock aborted (PEN-3328)

`PaperclipAgentStartLockAborted` — `warning`, not a page.

### What it means

A queued-run dispatch section held its agent's start lock past `LOCK_ABORT_MS`
(4h), was cancelled, and the lock was released. **Dispatch has already resumed
and no queued runs were lost.** Nobody needs waking; this is a post-mortem.

### Why it is a separate alert, and not redundant with the wedge alert

The two fire on opposite outcomes of the same fault, and the wedge alert
structurally cannot cover this one. `paperclip_agent_start_lock_held_seconds`
is emitted **only for locks held at scrape time** (`reset()` then set). Both
rules sit on the same 4h boundary, and the wedge alert's `for: 5m` is what
separates them: a landed abort deletes the series within a scrape, so that
window never completes and only an *unlanded* abort pages. A successful
cancellation is therefore invisible to the wedge alert — the incident
disappears precisely because it was handled.
`paperclip_agent_start_lock_aborted_total` is a counter, so it survives the
release and keeps the event answerable afterwards.

### What to do

**Do not close this on the strength of the recovery.** The cancellation bounded
the damage; it did not fix whatever blocked the section. Holds of minutes to a
couple of hours do settle on their own — the worst measured over the 14 days
to 2026-09-25 was 8073s (2h14m)
— so a section that reached 4h outran that tail by ~1.8× and is not the
slow-but-healthy case.

1. Read `dispatchHealth` on the agent row **on the worker pod** — `aborted`
   carries the post-mortem (`heldMs`, `abortedAt`). Via the API it will read
   `null`: the api tier never holds a lock, so it cannot answer.
2. Correlate with the `agent start lock held past its abort budget` error log
   for the same `agentId`.
3. Apply Step 3 of the wedged section above — the pool-versus-lock split and
   its trap — since the candidate causes are identical.

**A repeat for one `agent_id` is the thing to escalate.** Recurring aborts mean
cancellation is masking a persistent condition rather than clearing a transient
one; the likely candidates are pool exhaustion (`max: 10`, no acquire timeout)
and a circular advisory-lock wait in `lockIssueOwnership`.

### Verifying the signal is live

```
paperclip_agent_start_lock_aborted_total
```

Counter, labelled by `agent_id`, so it is absent until the first abort — an
empty result is the expected healthy reading and does **not** indicate a broken
scrape. To prove it end-to-end, hold a lock on an *abortable* await in a
scratch process and advance past 300s; the wedge gauge climbs, then vanishes as
the counter increments by one.

Same onprem-k8s lockstep caveat as every section above: the chart copy does not
deploy on Blockcast (`prometheusRule.enabled: false`), so merging this
repository alone does **not** make this alert live. It must also land in the two
lockstep `Blockcast/onprem-k8s` alert files — tracked as **PEN-3338** alongside
`PaperclipAgentStartLockWedged`. Verify at `/api/v1/rules` before relying on it.

## References

- `runbooks/README.md` — index
- BLO-21116 — JSON-parse recovery classification and queued-run observability
- BLO-22094 — the `PaperclipOverdueScheduledRetry` alert above
- PEN-3305 — the `PaperclipAgentStartLockWedged` alert above
- [BLO-36522](https://paperclip.blockcast.net/BLO/issues/BLO-36522) — the retune of that alert to the common-mode signature, and the measurements that withdrew the "does not self-heal" / "replace the process" claims
- [BLO-35522](https://paperclip.blockcast.net/BLO/issues/BLO-35522) — the routine-contention page that triggered the retune
- `runbooks/agent-wakeup-terminal-failed.md` — the sibling alert
- BLO-19095 — the manual Argo sync gate between merge and deployment
