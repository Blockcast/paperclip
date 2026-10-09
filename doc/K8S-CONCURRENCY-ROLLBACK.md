# Rolling back isolated K8s concurrency

Incident runbook. How to put one `claude_k8s` / `opencode_k8s` agent — or the
whole fleet, one agent at a time — back to **one run at a time**, and how to
confirm it took.

Rollback is **per agent**. There is no fleet-wide switch, and you do not want
one: a single misbehaving agent is serialized without touching the other 16.

Scope: this is the concurrency *ceiling*. Serialization of runs that share a
workspace/session is a separate invariant (the unique active-isolation-writer
index on `external_runtime_reservations`) and is enforced either way — see
[EXECUTION-WORKSPACE-RUN-SCOPE.md](./EXECUTION-WORKSPACE-RUN-SCOPE.md).

## The write

```http
PATCH /api/agents/{agentId}
Content-Type: application/json

{ "runtimeConfig": { "heartbeat": { "concurrencyEnabled": false } } }
```

`runtimeConfig` is replaced, not merged — send the agent's **current**
`runtimeConfig` from `GET /api/agents/{agentId}` with only
`heartbeat.concurrencyEnabled` flipped. Dropping `intervalSec`, `cooldownSec`
or `enabled` on the way through silently re-defaults the agent's scheduling.

Setting `concurrencyEnabled: false` is the whole rollback. You do **not** also
need to lower `maxConcurrentRuns`: when the flag is false the effective ceiling
is hard-pinned to 1 regardless of what `maxConcurrentRuns` says
(`server/src/services/agent-concurrency.ts:95`). Leave `maxConcurrentRuns`
alone so the pre-incident value is still on the record when you roll forward.

### Why it takes effect immediately

The ceiling is computed fresh from policy on **every dispatch**
(`agent-concurrency.ts:74-94`) and is never persisted as derived state. There
is no migration, no cache to bust, and no data repair on the way back. The next
dispatch pass after the write already honours it.

In-flight runs are **not** killed. Rollback stops new runs being admitted; runs
already launched finish or time out normally. If you need them gone now, that
is a separate deliberate act (delete the Jobs — see below).

### Who can perform it

| Principal | Result |
|---|---|
| Agent, targeting itself | `allow_self` — write applies |
| Holds `agents:configure` (board users, company `admin`/`owner` roles, root agents) | Write applies immediately |
| Holds only `agents:suggest-changes` | **`deny_missing_consent`** — the change is *not* applied; it needs accepted change consent first |
| Neither | `deny_no_grant` |

Rows are evaluated top to bottom; the first match wins.

Source: `server/src/services/authorization.ts:1765-1820` (grants) and
`:2504-2515` (self), action `agent_config:update`. A `runtimeConfig`-only PATCH
on the caller's own agent reaches `allow_self` via `assertCanUpdateAgent`
(`server/src/routes/agents.ts:3902-3903`, `:1050-1061`) and needs no grant or
consent, so an agent can always roll **itself** back. For **cross-agent**
rollback, **most agent seats hold only `agents:suggest-changes`**, so an agent
attempting it mid-incident gets a denial, not a rollback — route a cross-agent
rollback to a board user. Do not read a non-200 as "the flag is already off".

### Bounds the route enforces

- `concurrencyEnabled` is an optional boolean
  (`packages/shared/src/validators/agent.ts:80`); absent is read as **false**
  (`agent-concurrency.ts:70`).
- A heartbeat **preset** (`economic`/`balanced`/`aggressive`) deliberately does
  *not* set it (`agent-concurrency.ts:67-70`). Changing preset neither enables
  nor disables concurrency.
- `maxConcurrentRuns` is 1–50 at schema level, but for external-lifecycle
  adapters the route rejects anything above
  `EXTERNAL_LIFECYCLE_MAX_CONCURRENT_RUNS = 16` with 422
  (`server/src/routes/agents.ts:1330`). The enforced ceiling is
  `min(maxConcurrentRuns, 16)`.
- Only `claude_k8s` and `opencode_k8s` are gated by this flag
  (`validators/agent.ts:28`). On any other adapter type, setting it changes
  nothing.

## Confirming it took effect

**1. The config echo.** Re-read `GET /api/agents/{agentId}` and check
`runtimeConfig.heartbeat.concurrencyEnabled` is `false`. A 200 on the PATCH is
not evidence — read the field back.

**2. No surviving Jobs/Pods beyond one.** Agent Jobs are labelled
`paperclip.io/agent-id` (`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts:1905`):

```bash
kubectl -n paperclip get jobs,pods -l paperclip.io/agent-id=<agentId>
```

Once in-flight work drains, this should never show more than one active Job for
that agent. A second Job appearing *after* the config echo is confirmed is a
real finding, not drain lag.

**3. No more than one active reservation.** The slot ledger is
`external_runtime_reservations`; active means `released_at is null`, and every
row carries its agent (`packages/db/src/schema/external_runtime_reservations.ts:12`,
`:25`). The per-agent count is a query against that table:

```sql
select count(*) from external_runtime_reservations
 where agent_id = '<agentId>' and released_at is null;
```

Once in-flight work drains it should settle at ≤ 1. If it sits above 1 with no
corresponding Job from step 2, read
`paperclip_external_runtime_reservation_stranded_oldest_age_seconds{agent_id="<agentId>"}`
(`server/src/services/metrics.ts:948-949`, labelled `agent_id` at `:4112`). It
counts only a reservation whose run is already terminal or has gone silent, so
it reads 0 for a healthy long run and a sustained non-zero value is a plain
finding: you have **stranded reservations**, not concurrency — rollback will
not clear those, and they will keep blocking dispatch. Trust its 0 only while
`paperclip_external_runtime_reservation_strand_metrics_refresh_success` is 1
(`metrics.ts:4115`); 0 there means the strand gauge is stale.

Do not confirm this step from the fleet gauges.
`paperclip_external_runtime_reservations_active` and
`paperclip_external_runtime_reservation_oldest_age_seconds` have no labels
(`metrics.ts:3897-3906`): each is one series summed across every agent. An
`{agent_id=...}` selector on them matches nothing and returns empty, which reads
as zero, and without one the count includes every other agent's runs. The age
gauge also cannot separate a stranded row from a legitimately long run
(`metrics.ts:940-947`), so an age threshold over it calls healthy long runs
leaked. They can corroborate a fleet-wide trend; they cannot confirm a single
agent.

**4. Starts stop, blocks start.** After rollback,
`paperclip_k8s_isolated_run_started_total` for that agent flattens and
`claude_k8s_concurrent_run_blocked_total` rises — that counter is the
slot-ceiling refusal, so it going *up* is rollback working as designed, not a
new fault. Note the name has **no `paperclip_` prefix**
(`server/src/services/metrics.ts:45`).

Expect queue latency to rise too
(`paperclip_queued_run_oldest_age_seconds{agent_id}`). That is the cost you
accepted; it is not a reason to roll forward mid-incident.

## Signals that should trigger the rollback decision

Rollback when isolation is failing, not merely when the agent is busy. The four
signals below are the ones the rollout was gated on.

**`job_missing` rate.** `paperclip_heartbeat_run_failed_total{error_code="job_missing"}`
as a share of that agent's run starts. The baseline recorded on
[BLO-17291](https://paperclip.blockcast.net/BLO/issues/BLO-17291) is **~0.27%**.
That figure is a *recorded* baseline, not one re-measured here — re-derive the
current share for the agent before acting on it, because `job_failed` and its
siblings are catch-alls whose volume moves. A sustained multiple of the base
rate concentrated on one agent after a ceiling raise is the primary rollback
trigger.

**`claude_k8s_concurrent_run_blocked_total` climbing while
`paperclip_k8s_isolated_run_started_total` is flat.** Runs are being refused
without isolated starts replacing them — the agent is paying concurrency's
complexity and getting none of its throughput. Read the ratio of the two, never
either alone.

**Stranded active reservations.**
`paperclip_external_runtime_reservation_stranded_oldest_age_seconds{agent_id="<agentId>"}`
sustained above 0 (with its refresh-success gauge at 1), or the step-3 per-agent
count persistently above the configured ceiling. This is the failure where
rollback alone is insufficient: pin the ceiling to 1 *and* raise the stranding
separately, because stranded reservations keep occupying slots after the flag is
off. The unlabelled `paperclip_external_runtime_reservations_active` above one
agent's ceiling is not this signal — it sums every agent.

**`process_lost` classification buckets.** `paperclip_process_lost_total` is
labelled `adapter`, `error_bucket` and `classification` only
(`metrics.ts:4132`). It has **no `agent_id`**, so it is a fleet-level signal.
Its classifications (`metrics.ts:3114`):

| classification | reads as |
|---|---|
| `started_job_absent` | the Job vanished under a started run — **the isolation-relevant bucket** |
| `pre_adapter_job_unstamped` / `pre_adapter_job_stamped` / `pre_adapter_kube_unknown` | died before the adapter ran — launch-path, usually not concurrency |
| `local` | not an external-lifecycle loss at all |

A fleet-level rise concentrated in `started_job_absent` after a ceiling change
is a rollback trigger once you have tied it to an agent, and the metric cannot
do that. Attribute it with the agent's `job_missing` share above
(`paperclip_heartbeat_run_failed_total` does carry `agent_id`), or read the
durable classification off that agent's runs, which the metric's
`classification` label is copied from
(`server/src/services/process-loss-classification.ts:11`):

```sql
select result_json->'processLoss'->>'classification' as classification, count(*)
  from heartbeat_runs
 where agent_id = '<agentId>' and error_code = 'process_lost'
   and result_json->>'pipelineStageExitCancellationRequestedAt' is null
   and finished_at > now() - interval '24 hours'
 group by 1;
```

The `pipelineStageExitCancellationRequestedAt` clause is what keeps this query
aligned with the metric. On the process-loss reap path the row write
`setRunStatusIfRunning(run.id, "failed", { errorCode: "process_lost" })` is
unconditional (`server/src/services/heartbeat.ts:28192`), while the
`recordProcessLost(...)` that feeds the metric is gated on the run not being a
pipeline-stage exit (`:28234-28240`) — so a stage-exit run lands in the table as
`error_code = 'process_lost'` but was never counted. Without the clause the
query returns a superset of the metric and over-reports the agent. It mirrors
one of the two arms of `isPersistedPipelineStageExitRun` (`:12989-12995`); the
other arm keys on `error_code = PIPELINE_STAGE_EXIT_ERROR_CODE`, which is
mutually exclusive with the `error_code = 'process_lost'` already in this
`WHERE`, so mirroring it too would be a dead predicate.

A rise spread evenly across the `pre_adapter_*` buckets is likewise fleet-level:
a launch-path or cluster problem, not any one agent's, and rolling an agent back
will not fix it. Run the same query before blaming a specific agent for it.

> ☠️ **A low `process_lost` count is only trustworthy when
> `rate(paperclip_process_lost_liveness_null_total[5m]) == 0`** (or
> `increase(...)` over the window you are judging). That counter is the
> denominator-reliability signal (`metrics.ts:1454-1462`, `:4169`). It is
> cumulative, so its raw value stays non-zero after any past blind reap cycle;
> a non-zero rate means liveness could not be determined, so a concurrent low
> `process_lost` count is **unreliable, not healthy**. Read it before
> concluding an agent is clean.

The coarser error-string buckets on the same path are `pre_adapter`,
`child_pid`, `process_group`, `server_restart` (`metrics.ts:3101`); anything
unmatched collapses to `other`.

## Rolling forward again

Set `concurrencyEnabled: true` and raise `maxConcurrentRuns` in a separate,
later write. Confirm the agent's `job_missing` share and its `started_job_absent`
count (from the per-agent query above, not the fleet-level metric) are back at
baseline *for that agent* before raising the ceiling — the flag and
the ceiling are independent decisions and bundling them makes the resulting
telemetry unattributable.

## History

- [BLO-12207](https://paperclip.blockcast.net/BLO/issues/BLO-12207) — isolation contract
- [BLO-12214](https://paperclip.blockcast.net/BLO/issues/BLO-12214) — rollout
- [BLO-17738](https://paperclip.blockcast.net/BLO/issues/BLO-17738) — rollback exercised in production (Ally ceiling-2 canary, confirmed `process_lost`)
- [BLO-17291](https://paperclip.blockcast.net/BLO/issues/BLO-17291) — `job_missing` baseline
- [BLO-20742](https://paperclip.blockcast.net/BLO/issues/BLO-20742), [BLO-22698](https://paperclip.blockcast.net/BLO/issues/BLO-22698) — raising and right-sizing the cap
