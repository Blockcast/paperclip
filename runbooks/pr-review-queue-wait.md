# PR-review queue wait saturation

The `PaperclipPrReviewQueueWaitSaturated` alert measures the p95 time between
creation and start of heartbeat runs whose task key begins with `pr_review:`.
The histogram is observed at the guarded queued-to-running transition, so each
run is counted once and never-started runs are intentionally excluded.

## Triage

```promql
histogram_quantile(0.95, sum by (le) (rate(paperclip_pr_review_queue_wait_seconds_bucket[6h])))
```

Inspect queued review runs and compare active external-runtime slots with each
agent's configured concurrency. Also check provider-capacity deferrals and
recent scheduler errors. The metric has no repo, PR, agent, or delivery labels;
use the durable `heartbeat_runs.context_task_key` and logs for per-request detail.

The chart rule is a mirror only when `prometheusRule.enabled=true`. Blockcast's
authoritative alert is maintained in `Blockcast/onprem-k8s` and requires its
normal lockstep update and Argo sync before this signal is production-live.
