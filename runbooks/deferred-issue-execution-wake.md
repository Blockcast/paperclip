# A wake deferred behind an issue execution lock is overdue for promotion

Source: `server/src/services/queued-run-age-metrics.ts`
(`refreshDeferredIssueExecutionWakeAgeMetrics`) and
`server/src/services/metrics.ts`
(`DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC`,
`DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC`).

Triggers:

- `PaperclipDeferredIssueExecutionWakeOverdue` — an agent's oldest pending
  `deferred_issue_execution` wake is older than
  `deferredIssueExecutionWakeAgeSeconds` (14,400 seconds / 4h by default), and
  the age snapshot refreshed successfully.
- `PaperclipDeferredIssueExecutionWakeAgeMetricsRefreshFailed` — the most
  recent collector refresh failed, so deferred-wake ages are stale and
  intentionally do not qualify the overdue alert.

Owner: Platform / SRE (PEN-3734)

## What the state is

A wake targeting an issue is parked at
`agent_wakeup_requests.status = 'deferred_issue_execution'` while another run
holds that issue's execution lock. Serializing agents on one issue is intended
behaviour and is **not** what this alert reports.

What it reports is the promotion latency. A deferred wake is promoted **only
when a run on that issue finalizes**, and **one per finalization**
(`server/src/services/heartbeat.ts`, the `while (true)` deferred-promotion loop
in the terminal-run finalizer). The lock is held globally across agents. So one
agent's comment-delivery latency on a row is bounded below by the **queue wait
of every other agent's run ahead of it on that same row** — a quantity none of
those agents can see or influence.

Measured 2026-10-02 on PEN-3164: a wake requested at `12:33:31.025Z` was
promoted at `23:26:27.131Z` — **10h53m**, of which **10h35m** was a single
foreign run (CTO seat) sitting `queued` from 12:37:14 to 23:12:51 before it ever
started. Three further comments coalesced into the same pending request while it
waited. Every run row on that issue — 12 of 12, across three agents, back to
2026-09-30 — was created 0.8–4.8 s after the previous one *finished*: strictly
single-file.

## Why nothing else sees it

This is the part that cost a day, and it is worth reading before you reach for a
familiar query.

- **`heartbeat_runs` is not the wake ledger.** A deferred wake deliberately
  creates **no run row at all**. That is the documented contract of the
  deferral, not an omission. So `PaperclipQueuedRunStranded` and
  `PaperclipOverdueScheduledRetry` — both of which read `heartbeat_runs` — are
  structurally blind to it at any age, and so is any seat-side search for "my
  wake". Searching run rows for the comment id returns nothing *by design*, and
  reads exactly like a lost wake.
- **The issue looks healthy.** `issues.lastActivityAt` is **advanced** by each
  undelivered comment, so every staleness sweep reads a starving row as freshly
  active.
- **A later wake that "lands" can be the earlier one finally draining.** Before
  calling a run your comment's wake, check the wake request's `requestedAt` —
  not the run's `createdAt`. On PEN-3164 a run appearing 3.68 min after a fresh
  comment was read as a positive control proving delivery; it was the 12:33
  request promoted 3.1 s after an unrelated run finished, with the fresh comment
  coalesced into it.

## First: read the log, not the dashboard

The gauge can only say *which agent* is waiting — `issue_id` is unbounded
cardinality and is deliberately not a label. The refresh writes the identity to
the log instead, from **30 minutes** of age — far below the alert threshold, so
the record already exists by the time anyone looks:

```sh
kubectl logs -n paperclip -l app=paperclip --tail=-1 \
  | grep 'deferred behind an issue execution lock'
```

Each entry carries `oldestAgeSeconds` plus, per wake, the `wakeId`, `agentId`,
`companyId`, `issueId`, `reason`, `coalescedCount`, `requestedAt` and
`ageSeconds`. It is capped at 20 rows and says so (`shown`, `capped`) rather
than truncating silently.

**Each entry is a snapshot, not an event, and it is throttled to one per 15
minutes** — the collector ticks every 15s, so without that the PEN-3164 case
would have emitted ~2,600 near-identical records and buried itself. So: read
the *latest* entry for current state rather than counting entries, and expect
gaps of up to 15 minutes. A wake that began deferring inside a gap appears in
the next entry with its true age; the throttle delays a row's first appearance,
it never drops one.

## Then: confirm against the issue

```sh
curl -s "$PAPERCLIP_API/api/issues/<issueId>/diagnostics/wakes" | jq .
```

Query the **issue**, never the recipient's seat — a deferred wake has no
seat-side row, which is exactly what makes "nothing arrived" unfalsifiable from
the recipient side. The route intermittently 503s with `transient_db_conflict`;
retry once.

Reading the result:

- **While still pending**, `status` reads `deferred_issue_execution`.
- **Once promoted**, it serves `status: "completed"` and `reason: "other"` —
  **neither field names the deferral**, and the request is indistinguishable
  from an ordinary completed wake on both. So `status` is useless in the
  forensic case, which is the only case you ever actually run.
- ⭐ **The fingerprint that survives promotion** is `coalescedCount >= 1`
  together with the `requestedAt` → `claimedAt` gap. Use that pair.
- `claimedAt` and the promoted run's `createdAt` can disagree by tens of
  minutes. Say which clock any latency figure came from.

## Triage

1. **Find the holder.** `issues.executionRunId` for the issue names the run
   holding the lock. Read its `status`.
2. **Holder is `queued`** — this is the measured pathology. The holder is not
   executing; it is waiting on its own agent's concurrency ceiling or on
   dispatch. Triage it as a stranded queued run
   ([`queued-run-stranded.md`](queued-run-stranded.md)); clearing that clears
   this. `PaperclipQueuedRunStranded` should also be firing for the *holder's*
   agent, which is the correlation to look for — two alerts, two different
   agents, one cause.
3. **Holder is `running` and making progress** — the deferral is working as
   designed and the wait is real work. Nothing to fix here; if this fires often
   in that state the threshold is mistuned, not the system (see below).
4. **Holder is terminal, or the issue is `done`/`cancelled`** — the wake is
   stranded: no run will finalize on that issue, so nothing will ever promote
   it. Cancel the row. This case is deliberately **not** filtered out of the
   gauge; a wake that nothing is coming for is a real strand and must stay
   visible.

## Known limit: the threshold is a backstop, not a percentile

Every sibling threshold in `values.yaml` was fitted to a measured lag
distribution. This one was not, and could not be: the state was unobservable
before this gauge existed, which is the defect itself. A deferral behind a
legitimately long-running holder is correct and can last hours — healthy
external-runtime runs in this fleet have been measured from ~93 min to ~9.0h —
so a tight threshold would page on ordinary work. 4h sits above the common
healthy band and well below the 10h53m that nothing noticed.

**Re-fit it** from
`max by (agent_id) (paperclip_deferred_issue_execution_wake_oldest_age_seconds)`
once this gauge has a week of history, and replace the note in `values.yaml`
with the percentiles.

## What this does NOT fix

The promotion mechanism is unchanged. Promotion is still solely edge-triggered
on a per-issue run finalization, one per finalization, so the unbounded latency
itself remains — PEN-3734's done-when offered observability *or* a promotion
sweep as alternatives and this is the observability half. A sweep that promotes
deferred wakes whose holder has been `queued` past a threshold is still open
work.

## Useful PromQL

```promql
# Oldest deferred wake per agent, only where the snapshot is fresh.
max by (agent_id) (
  paperclip_deferred_issue_execution_wake_oldest_age_seconds
  and on(instance) (paperclip_deferred_issue_execution_wake_age_metrics_refresh_success == 1)
)

# Is the holder's agent also showing a stranded queued run? (the step-2 correlation)
max by (agent_id) (paperclip_queued_run_oldest_age_seconds)
```

> The Helm rule in this repo is a mirror only: Blockcast production loads the
> corresponding rules from the lockstep `onprem-k8s` Prometheus ConfigMap/CRD
> pair, not from this chart (`prometheusRule.enabled` is false in
> `values.blockcast.yaml`). A new rule must be added there too, in both
> `monitoring/prometheus-rules-{1..5}-configmap.yaml` and
> `paperclip/paperclip-runtime-alerts-prometheusrule.yaml`, or it never fires.
