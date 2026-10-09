# A routine has stopped completing fires (silently disabled, or its fires die)

Source: `server/src/services/routine-fire-gap-metrics.ts`
(`refreshRoutineFireGapMetrics`) and `server/src/services/metrics.ts`
(`ROUTINE_LAST_DONE_FIRE_AGE_METRIC`, `ROUTINE_FIRE_INTERVAL_METRIC`,
`ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC`).

Triggers:

- `PaperclipRoutineFireGap` — an active, schedule-triggered routine has not
  completed a fire in more than `routineFireGapIntervalMultiplier` (2) times
  the cadence its own cron implies, and the snapshot refreshed successfully.
- `PaperclipRoutineFireGapMetricsRefreshFailed` — the most recent database
  refresh failed, so fire ages are stale and intentionally do not qualify the
  gap alert.

Owner: Platform / SRE (BLO-32638)

## Why this alert exists

A routine's receipt that it took a measurement is a `done` issue row in the
database. Prometheus cannot see that, so before this gauge a routine that had
been silently disabled for intervals was **indistinguishable, on every metrics
surface, from a routine that was healthy and quiet**.

Measured on the alert-delivery bridge watchdog ([BLO-31881]): 11 gaps over
12h, largest 47.5h. During one 30.7h window a real bridge outage destroyed 22
of 42 alerts undetected, and throughout it the cadence was correct, run-status
tallies read healthy, and no dispatch counter moved abnormally. Every existing
signal read green. That is the failure this pages on.

[BLO-31881]: https://paperclip.blockcast.net/BLO/issues/BLO-31881

## `paperclip_routine_dispatch_total` does not cover this, at any value

Every label on that counter requires a fire to have **attempted dispatch**.
None of them move when a routine simply stops producing completed fires, and
none are emitted at all for the failure mode where a fire dispatches fine and
its run then dies quietly. Do not reach for it to falsify this alert — reach
for it to split the two causes below.

## Triage

### 1. Is the routine supposed to be firing?

```sql
select r.id, r.title, r.status, t.kind, t.enabled, t.cron_expression, t.timezone,
       t.next_run_at, t.last_fired_at, t.last_result
  from routines r
  join routine_triggers t on t.routine_id = r.id
 where r.id = '<routine_id>';
```

The alert only covers `routines.status = 'active'` with an **enabled
`schedule`** trigger, so if you find a paused routine or a disabled trigger
here, the gauge is lying and that is a bug — file it. A routine deliberately
paused emits no interval series and cannot page: with no right-hand side the
alert's vector match drops it.

### 2. Split the two causes — they are different faults

```sql
select status, count(*), max(triggered_at) as last_triggered, max(completed_at) as last_completed
  from routine_runs
 where routine_id = '<routine_id>'
   and created_at > now() - interval '7 days'
 group by status order by 2 desc;
```

| what you see | cause | next step |
|---|---|---|
| no rows at all in the window | **not dispatching.** The scheduler never created a fire. | Check `paperclip_routine_dispatch_total` for this routine's gating outcome, and `routine_triggers.next_run_at` — a `next_run_at` in the past that never advances is a claimed-and-dropped tick. |
| rows, but all `skipped` / `coalesced` | **dispatching and gating off.** Each fire found a live execution issue and stood down. | Find the issue that is holding the lock. A fire whose predecessor never reached a terminal state suppresses every successor — that is [BLO-31996], and it costs two intervals per occurrence. |
| rows `failed`, or `received` with no terminal status | **dispatching and dying.** The fire created an execution issue whose run died before the issue reached `done`. | Read `routine_runs.failure_reason`, then the execution issue's own run history. |
| rows `completed`, recently | the gauge disagrees with the table — **check the freshness gauge first**, then file a bug against the refresh. | |

[BLO-31996]: https://paperclip.blockcast.net/BLO/issues/BLO-31996

### 3. A large age on a young routine means it never worked

A routine that has **never** completed a fire ages from `routines.created_at`
rather than going absent. That is deliberate: an absent series and "nothing is
wrong" render identically on a dashboard, and a routine that was broken from
the day it was created is exactly the case worth catching. So a 40h age on a
routine created 40h ago is not "it stopped" — it is "it has never once
worked". Check `routine_runs` for any `completed` row before assuming a
regression.

## Freshness properties

**A failed refresh does not publish zeros.** The refresh leaves the previous
snapshot in place and sets `paperclip_routine_fire_gap_metrics_refresh_success`
to 0. This is load-bearing: a synthetic 0 age reads as *"fired just now"* —
the healthy state — and would hide exactly the silently-disabled routine this
family exists to catch. While that gauge is 0 the retained ages are **not
current**; do not triage off them.

**The gate is inside each aggregate, per replica.** Every control-plane
replica exports its own copy of both gauges. The gate sits within the
`max by`/`min by` so one healthy replica cannot bless another's stale
snapshot, and the pre-aggregation collapses the join to 1:1 — a bare
`on(routine_id)` join would be many-to-many and fail at **runtime** with HTTP
422 "found duplicate series for the match group" rather than firing
([BLO-23413]).

[BLO-23413]: https://paperclip.blockcast.net/BLO/issues/BLO-23413

## Why the threshold is relative

The fleet's scheduled routines span minutes to days. Any single seconds
threshold either never fires for a 5-minute watchdog or pages constantly on a
daily one, and a hand-maintained per-routine threshold list rots silently the
next time someone edits a cron. The right-hand side is derived from the
trigger's own cron by `deriveRoutineFireIntervalMs` — the **same** function
routine dispatch bounds its lock with (`deriveRoutineFireAgeHorizonMs` is a
jitter-shaved wrapper of it), so the alert and the dispatch bound cannot drift
apart.

`2` is the smallest multiplier that cannot fire on one missed fire's worth of
ordinary lateness, because a fire's own dispatch horizon is already
interval-minus-jitter.

## Verifying a change to the rule

The rule is replayed against the measured incident, with a negative control,
in `deploy/helm/paperclip/tests/routine-fire-gap.promtool.yaml`:

```bash
cd deploy/helm/paperclip
helm template paperclip . --set prometheusRule.enabled=true \
  --show-only templates/prometheusrule.yaml \
  | yq '{"groups": .spec.groups}' > tests/rendered-rules.yaml
promtool test rules tests/routine-fire-gap.promtool.yaml
```

Eight scenarios: the 30.7h window fires, the smallest measured 12h gap fires,
the healthy 1h sawtooth never does, a single 1.5x-late fire never does, a
*daily* routine at the same 30.7h age never does, an age with no interval
series cannot fire, a stale snapshot gates the alert off and pages its own,
and three replicas produce exactly one alert.

Every one of those was mutation-tested: each guard reverted alone turns the
suite red. If you change the rule and the suite stays green, check that it
still would have failed — a regression fixture that passes on broken code is
documentation.
