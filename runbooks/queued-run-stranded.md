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

## Scheduled-retry park horizon is a different signal

`paperclip_scheduled_retry_park_horizon_seconds` measures the booked interval
from `heartbeat_runs.updated_at` to `scheduled_retry_at` for live
`status='scheduled_retry'` rows — i.e. how far out the most recent park decision
booked. `PaperclipScheduledRetryParkHorizonImplausible`
fires when that future-due horizon exceeds 5,400 seconds, based on the
observed seven-day population (n=5,253, p99=1,594.8s, maximum 3,567.5s).
`PaperclipScheduledRetryParkHorizonMetricsRefreshFailed` is the companion
alert for a failed gauge refresh; while it is firing, the horizon alert is
gated off and its last snapshot is not trustworthy.

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
Trigger: alert `PaperclipAgentStartLockWedged` —
`count(max by (agent_id) (paperclip_agent_start_lock_held_seconds) > 900) >= 3`
for 10m (retuned by BLO-36522; was `max by (agent_id) (...) > 300` for 5m)
Owner: Platform / SRE (PEN-3305)

### ⚠️ What this alert claims, and what it no longer claims (BLO-36522)

**The name says "wedged". Measured, that word is wrong, and it is retained only
because it keys this anchor, the promtool cases and the Slack baseline.** Two
claims this section used to make were falsified on 2026-09-25:

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
  stuck.

**There are two regimes, and the old 300s threshold could not tell them apart
because it sat inside the normal envelope.** Over 7 days, **21 of 21 agents**
crossed 300s, for **2,730 agent-minutes** (~390/day fleet-wide) — a continuous
condition, not a page. Magnitude cannot separate them either: the exceedance
curve is smooth and knee-free (2,730 agent-min >300s → 1,565 >900s → 963
>1800s → 492 >3600s), so no single-agent duration has a natural cut.

| | routine contention | common-mode stall |
|---|---|---|
| duration | seconds → ~10 min | hours |
| agents | one at a time | **≥3 simultaneously, in lockstep** |
| frequency | continuous, all 21 agents | ~1 episode/week |
| pages? | **no, by design** | yes |

**Simultaneity is the discriminator**, which is why the expression counts
agents rather than raising the duration bound. Backtested at 179 fleet-minutes
— one episode, the 2026-09-24T01:00Z event — over all the history Prometheus
retains.

**Severity stays `critical`, on a new basis.** The old justification was the
non-self-healing claim above, which is dead. It stays critical because it now
fires only on the fleet-scope episode, and because it must keep the
out-of-band Slack path precisely *because* the suspected fault is in
paperclip's own dispatcher — routing it `warning` would put the page behind
the component it is reporting on. **The action is diagnostic capture, not a
restart** (Step 4).

**What holds the locks for 2h14m is still UNKNOWN.** This retune makes the
alert describe reality; it does not explain the stall. Recorded lead, untested
and with no causal claim: 4 of the 5 agents with a firing
`PaperclipAgentZeroTokenRunStreak` were in the lock-contention set, which is
what a run that spends its life waiting on the start lock would look like.

### The invariant, and why it is a cause alert rather than a consequence one

`withAgentStartLock` serializes queued-run dispatch per agent. It has **no
timeout, no TTL and no owner-liveness check**, deliberately: the defect
BLO-20396 removed was a timeout that let a waiter run *alongside* the holder.
The lock is released if and only if `fn` settles, so a critical section that
never settles holds its agent's lock for the life of the process.

⚠️ **"Never settles" is the limiting case, and it is NOT what the observed
episodes are** (BLO-36522). The mechanism above is real and unchanged — there
is genuinely no timeout — but every episode measured since has settled on its
own, including the 2h14m fleet one. Read this paragraph as *"nothing external
will break the lock"*, not as *"the hold will last until you restart it."*
Those are different claims and only the first is supported.

That agent then dispatches nothing, while every status surface reads healthy —
`status: idle`, `errorReason: null`, `orgChainHealth: healthy`, work piling up
in `queued`. Measured 2026-09-15/16: five agents across two companies dark for
6–19 h, ~70 runs stuck, ended only by a pod replacement on an identical image
digest and StatefulSet revision.

`PaperclipQueuedRunStranded` above fires on the *consequence* of this and will
usually fire too, a while later. It cannot tell you the cause: a queued run
strands identically under slot starvation, a scheduler-tick gap or a dropped
dispatch. This alert names the mechanism directly, and fires sooner.

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
that is slow. `agent start lock held far past its budget; queued-run dispatch
for this agent has stopped` (error, first at 5m then every 5m) is driven by
`LOCK_HELD_ERROR_MS` (300s) in `agent-start-lock.ts`.

⚠️ **The log line and this alert deliberately no longer share a number.**
Before BLO-36522 they were pinned together at 300s so "the log line and the
page cannot disagree". That pinning was abandoned on purpose: 300s is the
right boundary for the *log* — it is where the code stops calling a hold slow
— but as an alert threshold it fires on 2,730 agent-minutes a week of routine
contention. So the log answers *"is this hold slow?"* and the alert answers
*"is the fleet stalled at once?"*. The cost is real and accepted: **an
operator grepping the 300s log line will find entries with no corresponding
page, and that is correct.** Expect roughly 390 agent-minutes of these per day
fleet-wide with nothing wrong.

#### Step 2 — do NOT clear the agent as healthy

`paperclipGetAgent` will report `status: idle`, `errorReason: null`,
`orgChainHealth: healthy` and a normal budget. `paperclipListParkedAgents`
will not list it. None of those refute the wedge — they are what the wedge
looks like from outside, and they are why the original incident ran 19 h. The
discriminator is a **dispatch**: `startedAt` moving on a run for that agent.
Queue depth falling is not one either; runs can be cancelled.

#### Step 3 — decide whether it is the lock or the pool, and mind the trap

The known-plausible wedge is a second pool connection taken while holding
`lockIssueOwnership`, against `POSTGRES_POOL_MAX = 10` with no acquire timeout
(`issue-recovery-actions.test.ts` still allowlists five such call sites under
BLO-34207). Check the pool gauges for the **worker** pod, which is the only
tier that dispatches:

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

#### Step 4 — recovery: capture, then wait. Do NOT restart the pod.

**This step used to read "the section must settle or the process must be
replaced" and prescribe `kubectl delete pod`. That prescription is withdrawn
(BLO-36522).** It rested on the non-self-healing claim falsified above: the
worst episode on record cleared itself with the same process still running,
and kept running 7.75 h afterwards. Replacing the worker pod is a
shared-infrastructure mutation affecting **every** agent in the fleet, and the
evidence says it buys nothing the wait would not have given you.

**So the page's action is evidence capture inside a window that closes by
itself.** While it is still firing:

```
max by (agent_id) (paperclip_agent_start_lock_held_seconds)      # who, and how long
resets(paperclip_agent_start_lock_held_seconds[6h])              # 0 = genuinely stuck; >0 = cycling
paperclip_db_pool_connections{pod="paperclip-0"}                 # idle/active/waiting split
kubectl logs -n paperclip paperclip-0 | grep "agent start lock held"
```

Record the agent ids, the `resets` value, and the pool split **on the issue**.
Those three together are what nobody has captured yet, and they are destroyed
both by the self-heal and by a restart — which is exactly why the old
restart-first instruction kept the cause unknown for as long as it did.

**The one case that still justifies replacing the pod** is a genuinely stuck
lock, and it has a distinct signature you can now check rather than assume:
`resets(...[6h]) == 0` for the affected agents **and** a permanently `active`
connection count with nothing queued — a stuck transaction — **and** zero
dispatches (`startedAt` not moving). Absent that, wait. If you do restart,
capture the block above first.

The real fix — making the critical section's awaits abortable so `fn` rejects
and releases the lock through the existing `finally` — is out of scope of the
observability change that added this alert, and is recorded in the module
header. Abandoning a still-pending `fn` on a timer is **not** that fix: it
reintroduces the BLO-20396 defect of two sections running at once.

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
The BLO-36522 retune landed in the two `Blockcast/onprem-k8s` copies — the
only ones that fire at Blockcast — and **deliberately not** in the chart copy
above, which still carries `max by (agent_id) (...) > 300` for 5m wired to
`prometheusRule.agentStartLockHeldSeconds` / `LOCK_HELD_ERROR_MS`. It renders
nothing here, so this costs Blockcast nothing today. It is a landmine for
anyone who enables that chart elsewhere: they would get the pre-retune
behaviour, i.e. a critical page on every single-agent hold past 300s, roughly
390 agent-minutes a day. **Before setting `prometheusRule.enabled: true` in
any installation, port this retune to the chart first.**

## References

- `runbooks/README.md` — index
- BLO-21116 — JSON-parse recovery classification and queued-run observability
- BLO-22094 — the `PaperclipOverdueScheduledRetry` alert above
- PEN-3305 — the `PaperclipAgentStartLockWedged` alert above
- [BLO-36522](https://paperclip.blockcast.net/BLO/issues/BLO-36522) — the retune of that alert to the common-mode signature, and the measurements that withdrew the "does not self-heal" / "replace the process" claims
- [BLO-35522](https://paperclip.blockcast.net/BLO/issues/BLO-35522) — the routine-contention page that triggered the retune
- `runbooks/agent-wakeup-terminal-failed.md` — the sibling alert
- BLO-19095 — the manual Argo sync gate between merge and deployment
