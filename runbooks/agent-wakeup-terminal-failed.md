# Terminal-failed agent wakeups (a PR review that will never run)

Source: `server/src/services/heartbeat.ts` (`publishAgentWakeupTerminalFailedGauge`), `server/src/services/metrics.ts` (`AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC`, `AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC`)
Trigger: alert `PaperclipPrReviewWakeTerminalFailed` — `max(paperclip_agent_wakeup_terminal_failed_oldest_age_seconds{scope="pr_review"}) > 1800` for 5m
Owner: Platform / SRE (gstack)

Two series back this alert, and it matters which one you read:

- `paperclip_agent_wakeup_terminal_failed_oldest_age_seconds{scope}` — **what the
  alert thresholds.** Age in seconds of the oldest unresolved terminal-`failed`
  row in that scope; 0 when there are none. The ageing lives here rather than in
  a Prometheus `for:` clause because `for:` measures how long the *expression*
  has been continuously true, not how long any one row has been failed — two
  short failures overlapping by a single scrape would keep a summed count true
  across the window and page for a row seconds old.
- `paperclip_agent_wakeup_terminal_failed_unresolved{error_code,scope}` — the
  **count**, broken down by `error_code`. This is what you triage with; it does
  not decide whether the alert fires.

## The invariant

Every PR-review wake either runs, gets retried, or pages somebody. A wake that
is terminal and unretried must be visible.

## What this alert means

An `agent_wakeup_requests` row is sitting at `status='failed'`, it is scoped to
a PR review, and no successor wake for the same `taskKey` has appeared in 30
minutes.

`status='failed'` is **terminal**. `reconcileFailedWakeDispatches` only ever
selects `dispatch_failed`, so nothing re-drives a `failed` row. This is a
different state from the one `PaperclipGithubReviewRequestDeadLettered` covers:

| state | meaning | who retries it |
|---|---|---|
| `dispatch_failed` | dispatch attempt failed, budget remains | `reconcileFailedWakeDispatches` |
| `dispatch_failed_exhausted` | dispatch chain burned its budget | nobody — `PaperclipGithubReviewRequestDeadLettered` |
| `failed` | wake dispatched, the **run** died | nobody — **this alert** |

BLO-18030 / [PR #900](https://github.com/Blockcast/paperclip/pull/900) added a
bounded retry for the one slice that is provably safe to re-run: a stale-killed
`pr_review` run whose GitHub probe proved no review landed. Three cases stay
terminal on purpose, so we never double-post a review:

- the probe found an existing review (`reviewEvidenceFound: true`),
- the probe threw, or there was no PR context (flag absent),
- the run was not a `pr_review` context at all.

Those are correct decisions. This alert exists because they were also silent.

**A retried row does not reach this alert.** The gauge drops any row with a
successor wake for the same `taskKey`, and a scheduled retry writes both of its
successor rows inside the *scheduling* transaction — an `agent_wakeup_requests`
row at `status='queued'` and a `heartbeat_runs` row at
`status='scheduled_retry'` — rather than when the retry fires. So a row that is
going to be retried leaves the gauge the moment the retry is scheduled, at every
step of `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS` (`[2m, 10m, 30m, 2h]`),
including the two steps longer than this alert's 30m `for`.

A successor that *itself* ended terminal `failed` is deliberately **not** counted
as coverage: that is a second failure, not a re-drive. A review chain failing
repeatedly on one `taskKey` therefore shows a count above 1 rather than
suppressing itself to 0 — that shape is the most page-worthy one here.

## What to do when paged

### Step 1 — find the rows

```sql
select w.id,
       w.agent_id,
       w.reason,
       w.error,
       w.payload ->> 'taskKey' as task_key,
       w.finished_at,
       r.error_code
from agent_wakeup_requests w
left join heartbeat_runs r on r.id = w.run_id
where w.status = 'failed'
  and w.finished_at > now() - interval '24 hours'
order by w.finished_at desc;
```

`task_key` has the shape `pr_review:<owner>/<repo>:<prNumber>` — that is the PR
to look at.

Note the `error_code` comes from `heartbeat_runs`, not from the wake row: the
wake table has no `error_code` column, only free-text `error`.

### Step 2 — read `error_code` and decide

| `error_code` | what happened | usual action |
|---|---|---|
| `external_lifecycle_stale_killed` | the reviewer Job went silent past the 45m hard-stale window and was force-terminated | check the PR for an existing review; if none, re-request (Step 3) |
| `job_failed` | the Job exited non-zero | read the run log first — a re-request will hit the same failure if the cause is deterministic |
| `job_missing` | the Job vanished before completing | re-request |
| `adapter_failed` / `process_lost` | infrastructure fault below the agent | re-request once infra is healthy |
| `agent_not_found` | the wake targeted an agent that no longer resolves | do **not** re-request; fix the routing |
| `none` | no run row, or no code recorded (e.g. the "deferred wake could not be promoted" path) | inspect `w.error` prose |
| `other` | a code missing from `KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES` | triage it into that list in `server/src/services/metrics.ts` |

### Step 3 — re-review, or accept

**Always check the PR for an existing review first.** The whole reason these
rows stay terminal is that a stale-killed run may already have posted one, and
a duplicate review is worse than a late one.

```bash
gh api repos/<owner>/<repo>/pulls/<n>/reviews \
  --jq '.[]|"\(.submitted_at) \(.state) on \(.commit_id[0:8])"'
```

- **A review exists at the current head** → accept. Nothing to do; the row is
  correctly terminal and will age out of the 24h window on its own.
- **No review, or the review is against a stale head** → re-request, by posting
  a PR comment whose **literal first byte** is the marker:

  ```
  <!-- paperclip:review-request -->
  @ally re-review at head <sha> — previous reviewer run was lost to <error_code>
  ```

  A bare `@ally` from an agent does **not** route (the webhook drops
  bot-authored markerless mentions). Ally takes roughly 50 minutes; do not
  re-poll at 5.

### Step 4 — if it keeps firing

Repeated `external_lifecycle_stale_killed` on the same repo is a capacity
signal, not a per-PR one: reviewer Jobs are going silent under load. Check
agent-pod scheduling (`PaperclipAgentPodUnschedulable`) and the ccrotate
capacity gate before re-requesting review by hand each time.

## Silencing

The alert is `severity: warning` and is scoped to `scope="pr_review"`. If you
are deliberately accepting a batch of terminal rows (e.g. after a known
infra incident where every PR was re-reviewed by hand), silence on the alert
name for a bounded window rather than editing the threshold — the rows age out
of the gauge's 24h recency window by themselves.

## Verifying the signal is live

```
paperclip_agent_wakeup_terminal_failed_oldest_age_seconds{scope="pr_review"}
sum(paperclip_agent_wakeup_terminal_failed_unresolved{scope="pr_review"})
```

Both series are zero-initialized at process start — the count across the full
`(error_code, scope)` grid, the age across both scopes — so a healthy fleet
renders **0**, not "No data". If you see "No data", the scrape is broken or the
reconcile pass is not running — that is a different and worse problem than the
alert firing.

The age series is also explicitly rewritten to 0 for a scope with no unresolved
rows on every reconcile pass. That is what lets the alert resolve: a gauge left
untouched when the last failure clears would freeze above the threshold and page
forever.

### Where the rule actually runs

The chart copy at `deploy/helm/paperclip/templates/prometheusrule.yaml` **does
not deploy on Blockcast** (`prometheusRule.enabled: false` in
`values.blockcast.yaml` — `paperclip-ci-deploy` has no RBAC on
`prometheusrules.monitoring.coreos.com`). The rule that fires in production
lives in `Blockcast/onprem-k8s`, in both lockstep-enforced files:
`monitoring/prometheus-configmap.yaml` (key `paperclip-runtime-alerts.rules.yml`,
authoritative) and `paperclip/paperclip-runtime-alerts-prometheusrule.yaml`
(CRD documentation copy). Added by Blockcast/onprem-k8s#1946.

Merging that is **not** deploying it: the `monitoring-rules` Argo app syncs
manually, a gate that once stranded 15 merged alerts for 8 days (BLO-19095).
Confirm the rule is in the live ConfigMap and in Prometheus `/api/v1/rules`
before treating this alert as production observability.

## References

- `runbooks/README.md` — index
- BLO-20255 (this alert), BLO-18030 / PR #900 (the bounded retry), BLO-18859
  (the sibling dead-letter alert and the zero-initialization lesson)
- Blockcast/onprem-k8s#1946 — the production rule
- BLO-19095 — the manual Argo sync gate that stands between merge and deploy
