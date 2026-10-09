# PR-review queue wait saturation

The `PaperclipPrReviewQueueWaitSaturated` alert fires when more than 5% of
heartbeat runs whose task key begins with `pr_review:` waited longer than 3600s
between creation and start over a rolling 6h window. It reports the true mean
wait over that window, not a quantile. The histogram is observed at the guarded
queued-to-running transition, so each run is counted once and never-started
runs are intentionally excluded.

## Triage

```promql
# Breach fraction -- the firing condition (> 0.05). 3600 is a real bucket edge,
# so this is exact. `le` renders as "3600.0"; `le="3600"` matches nothing.
1 - (
  sum(rate(paperclip_pr_review_queue_wait_seconds_bucket{le="3600.0"}[6h]))
  /
  sum(rate(paperclip_pr_review_queue_wait_seconds_count[6h]))
)

# Mean wait -- the figure the alert reports.
sum(rate(paperclip_pr_review_queue_wait_seconds_sum[6h]))
/
sum(rate(paperclip_pr_review_queue_wait_seconds_count[6h]))
```

Do not use `histogram_quantile` on this histogram. Most observations land in
the (14400, 28800] bucket, so the interpolated p95 has roughly 4h resolution
there. On 2026-10-08 it held flat to within 0.4% across 24h while the true mean
moved 3.2x (BLO-41442). A breaching alert that reports a sub-SLO or 0s mean
points at the instrument, not the queue: check that `_bucket`, `_sum` and
`_count` are all still being reported.

Inspect queued review runs and compare active external-runtime slots with each
agent's configured concurrency. Also check provider-capacity deferrals and
recent scheduler errors. The metric has no repo, PR, agent, or delivery labels;
use the durable `heartbeat_runs.context_task_key` and logs for per-request detail.

Blockcast's authoritative alert is maintained in `Blockcast/onprem-k8s` and
requires its normal lockstep update and Argo sync before this signal is
production-live. The chart rule (`prometheusRule.enabled=true`) still evaluates
the old `histogram_quantile` expression and is no longer a mirror of it.
