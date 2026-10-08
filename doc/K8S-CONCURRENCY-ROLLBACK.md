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
| Holds `agents:configure` (board users, company `admin`/`owner` roles, root agents) | Write applies immediately |
| Holds only `agents:suggest-changes` | **`deny_missing_consent`** — the change is *not* applied; it needs accepted change consent first |
| Neither | `deny_missing_grant` |

Source: `server/src/services/authorization.ts:1765-1810`, action
`agent_config:update`. **Most agent seats hold only `agents:suggest-changes`**,
so an agent attempting this mid-incident gets a denial, not a rollback. Route
it to a board user. Do not read a non-200 as "the flag is already off".

### Bounds the route enforces

- `concurrencyEnabled` is a plain boolean, **default false**
  (`packages/shared/src/validators/agent.ts:80`). Absent counts as false.
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
`external_runtime_reservations`; active means `released_at is null`.

```
paperclip_external_runtime_reservations_active{agent_id="<agentId>"}
```

should settle at ≤ 1. If it sits above 1 with no corresponding Job, you have
**leaked reservations**, not concurrency — rollback will not clear those, and
they will keep blocking dispatch. Cross-check
`paperclip_external_runtime_reservation_oldest_age_seconds`: a reservation
older than the longest plausible run is leaked.

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

**Leaked active reservations.** `paperclip_external_runtime_reservations_active`
persistently above the configured ceiling, or
`paperclip_external_runtime_reservation_oldest_age_seconds` beyond the longest
plausible run. This is the failure where rollback alone is insufficient: pin the
ceiling to 1 *and* raise the leak separately, because stale reservations keep
occupying slots after the flag is off.

**`process_lost` classification buckets.** `paperclip_process_lost_total` is
labelled `adapter`, `error_bucket` and `classification` (`metrics.ts:3114`):

| classification | reads as |
|---|---|
| `started_job_absent` | the Job vanished under a started run — **the isolation-relevant bucket** |
| `pre_adapter_job_unstamped` / `pre_adapter_job_stamped` / `pre_adapter_kube_unknown` | died before the adapter ran — launch-path, usually not concurrency |
| `local` | not an external-lifecycle loss at all |

A rise concentrated in `started_job_absent` on one agent after a ceiling change
is a rollback trigger. A rise spread evenly across the `pre_adapter_*` buckets
is a launch-path or cluster problem and rolling back will not fix it.

> ☠️ **A low `process_lost` count is only trustworthy when
> `paperclip_process_lost_liveness_null_total` is 0.** That gauge is the
> denominator-reliability signal (`metrics.ts:1450-1462`): non-zero means
> liveness could not be determined, so a concurrent low `process_lost` count is
> **unreliable, not healthy**. Read it before concluding an agent is clean.

The coarser error-string buckets on the same path are `pre_adapter`,
`child_pid`, `process_group`, `server_restart` (`metrics.ts:3101`); anything
unmatched collapses to `other`.

## Rolling forward again

Set `concurrencyEnabled: true` and raise `maxConcurrentRuns` in a separate,
later write. Confirm the `job_missing` share and the `started_job_absent` bucket
are back at baseline *for that agent* before raising the ceiling — the flag and
the ceiling are independent decisions and bundling them makes the resulting
telemetry unattributable.

## History

- [BLO-12207](https://paperclip.blockcast.net/BLO/issues/BLO-12207) — isolation contract
- [BLO-12214](https://paperclip.blockcast.net/BLO/issues/BLO-12214) — rollout
- [BLO-17738](https://paperclip.blockcast.net/BLO/issues/BLO-17738) — rollback exercised in production (Ally ceiling-2 canary, confirmed `process_lost`)
- [BLO-17291](https://paperclip.blockcast.net/BLO/issues/BLO-17291) — `job_missing` baseline
- [BLO-20742](https://paperclip.blockcast.net/BLO/issues/BLO-20742), [BLO-22698](https://paperclip.blockcast.net/BLO/issues/BLO-22698) — raising and right-sizing the cap
