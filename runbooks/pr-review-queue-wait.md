# PR-review queue wait saturation

The `PaperclipPrReviewQueueWaitSaturated` alert measures the time between
creation and start of heartbeat runs whose task key begins with `pr_review:`.
The histogram is observed at the guarded queued-to-running transition, so each
run is counted once and never-started runs are intentionally excluded.

Once `Blockcast/onprem-k8s#5124` merges and Argo syncs it, the alert fires when
**more than 5% of runs in the rolling 6h window waited longer than 3600s**, and
it reports the **true mean** of that window as its value. **Until then the
deployed rule still evaluates the p95 below, and its reported value is that
p95**, pinned inside a 4h-wide bucket. Check which rule is live before reading
the value (see *Where the rule lives*).

## Triage

```promql
# 1. The firing condition once #5124 is live -- the exact fraction of runs that
#    breached the SLO.
1 - sum(rate(paperclip_pr_review_queue_wait_seconds_bucket{le="3600.0"}[6h]))
  / sum(rate(paperclip_pr_review_queue_wait_seconds_count[6h]))

# 2. The magnitude -- the true mean. The figure the alert reports once #5124 is live.
sum(rate(paperclip_pr_review_queue_wait_seconds_sum[6h]))
  / sum(rate(paperclip_pr_review_queue_wait_seconds_count[6h]))
```

**Read the two together before triaging the queue.** Every run that breached
waited more than 3600s, so with all three series intact the mean is always
above query 1 × 3600s. Once `onprem-k8s#5124` is live, that rule puts
`or vector(0)` on its bucket and `_sum` arms on purpose, so a drifted `le`
label or a missing `_sum` series pages instead of going dark. The two failures
carry opposite verdicts on the queue, so tell them apart before standing down:

- **Query 1 returns empty.** The `le="3600.0"` bucket is no longer reported
  (see the `.0` warning below). The rule's bucket arm fell to `vector(0)`, so
  its fraction read `1 - 0/N = 1.0` whatever the queue was doing: the firing
  decision itself is an artefact. This points at the instrument, not the queue.
- **Query 1 returns a number, but query 2 returns empty or the alert reports a
  0s mean.** `_sum` is no longer reported, so only the magnitude readout is
  broken. The firing decision is computed from `_bucket` and `_count` alone and
  never reads `_sum`, so **the breach is real: file the instrument bug and
  triage the queue below as well.** Do not stand down on the 0s.
- **Both return numbers, but the mean is at or below query 1 × 3600s.** One arm
  is reported by only some pods (the series carry a `pod` label). Find which
  before deciding: a short `_bucket` overstates the fraction, so the page may be
  an artefact; a short `_sum` only understates the mean, so the breach is real.

In every case, check that `_bucket`, `_sum` and `_count` are all still being
reported.

**(a) Compare Ally's running count against its configured concurrency cap.**
This is the comparison that identified the 2026-10-08 cause, and it is the
first thing to check:

```promql
pg_heartbeat_run_queue_backlog_by_agent_running_count{agent_name="Ally"}
```

Read it against the agent's configured cap, which lives at
`runtimeConfig.heartbeat.maxConcurrentRuns` on the agent (16 for Ally, read
2026-10-09). It is **not** in `adapterConfig`. That object has no
`maxConcurrentRuns` key, so an empty or absent value there does not mean no cap
is configured. A running count pinned at the cap, with work still queued, is
consumer starvation — the alert is correct and the answer is capacity, not a
bug.

> **Do not reach for park depth first.** Provider-capacity deferrals and
> `scheduled_retry` parks read **healthy** in this failure mode: the consumer
> is not parked, it is busy. A healthy park depth is not evidence the queue is
> fine, and reading it first is how this one was misdiagnosed.

**(b) Queue depth, and the PR-review share of it.** The metric in (a) is
agent-scoped, so an issue-board backlog raises it too (BLO-20526 measured 61%
of Ally's runs as duplicate issue-board wakes). Confirm the `pr_review` share
before concluding the review path specifically is at fault:

```sql
select count(*) from heartbeat_runs
 where status = 'queued' and context_task_key like 'pr_review:%';
```

**(c) Provider capacity and parks** — now that (a) and (b) are ruled out.
Check `ccrotate` capacity deferrals, `scheduled_retry` parks, and recent
scheduler errors, and rule out a provider-entitlement 403 stalling dispatch
fleet-wide (BLO-34726).

The metric has no repo, PR, agent, or delivery labels; use the durable
`heartbeat_runs.context_task_key` and logs for per-request detail.

## This alert stops reporting a percentile once onprem-k8s#5124 syncs (BLO-41442)

Until `Blockcast/onprem-k8s#5124` merges and Argo syncs it, the deployed rule
still evaluates the expression below. Before that change it always did:

```promql
histogram_quantile(0.95, sum by (le) (rate(paperclip_pr_review_queue_wait_seconds_bucket[6h]))) > 3600
```

and **the number that produced was not trustworthy**, though the firing
decision was. `paperclip_pr_review_queue_wait_seconds` carries buckets
`60, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, +Inf`. Measured
2026-10-08 over a 6h window of 207.29 observations, 110.16 of them (53%) sat
in the single `(14400, 28800]` bucket, so the p95 target rank landed inside
one bucket **4 hours wide** and the reported figure was just a linear
interpolation across it. It could not tell a 4.5h wait from a 7.5h one, and
past 8h it degenerates to `+Inf`.

The tell was that the p95 held **flat to within 0.4% across 24 hours** while
the true mean over the identical window moved **3.2×** (5169s → 16003s). A
quantile pinned inside one wide bucket only moves when the *ratio* between two
buckets moves, so it reads as a stable plateau. **An operator reading "7.6h,
steady for a day" concluded the queue was stable while it was not.**

Both replacement expressions are exact against the buckets that exist today:
3600 is itself a bucket edge, so the fraction needs no interpolation and has no
ceiling, and `_sum` is not bucketed, so the mean is exact and unbounded.
`> 0.05` is the literal restatement of the old `p95 > 3600s` SLO — a p95
exceeds X exactly when more than 5% of samples do — so firing behaviour is
preserved by construction rather than by re-tuning.

⚠️ **`le` renders as `"3600.0"`, not `"3600"`.** Verified against
`/api/v1/series`: every bucket edge carries a trailing `.0`. A selector written
`le="3600"` matches nothing and returns empty, so a rule or ad-hoc query built
that way reads as "no breaches" when the truth is "no data". If query 1 above
returns empty rather than a number, that is what has happened — check the label
before concluding the queue drained.

Adding finer buckets here in `Blockcast/paperclip` would restore a real
percentile and is the fuller fix, but it needs a deploy and leaves a backfill
gap; it is optional follow-up, not a prerequisite.

## Where the rule lives

The chart rule in `deploy/helm/paperclip/templates/prometheusrule.yaml` is a
mirror only when `prometheusRule.enabled=true`, and it still carries the
quantile form because its threshold is a values-schema contract
(`prReviewQueueWaitThresholdSeconds`, in seconds) that a fraction cannot be
substituted into without breaking chart consumers. It renders nothing at
Blockcast.

Blockcast's authoritative alert is maintained in `Blockcast/onprem-k8s`
(`paperclip/paperclip-runtime-alerts-prometheusrule.yaml`, mirrored into
`monitoring/prometheus-rules-2-configmap.yaml`) and requires its normal
lockstep update and Argo sync before any change to this signal is
production-live.
