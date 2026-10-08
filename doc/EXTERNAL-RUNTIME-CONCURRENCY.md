# External-runtime concurrency (k8s agents)

Operator reference for running more than one concurrent `claude_k8s` run per
agent: capacity, the reservation lease, observability, cleanup, and rollback.

BLO-15962. Companion to [`EXECUTION-WORKSPACE-RUN-SCOPE.md`](./EXECUTION-WORKSPACE-RUN-SCOPE.md),
which covers the worktree the run lands in; this document covers the slot it
occupies.

## Capacity

Concurrency is a **per-agent, default-off** opt-in. Two independent values in
`agents.runtimeConfig.heartbeat`:

```jsonc
{ "heartbeat": { "concurrencyEnabled": true, "maxConcurrentRuns": 4 } }
```

| value | meaning | source |
|---|---|---|
| `concurrencyEnabled` | the eligibility gate. Absent or `false` ⇒ ceiling is a hard **1**, whatever `maxConcurrentRuns` says | `agent-concurrency.ts` `resolveAgentConcurrencyPolicy` |
| `maxConcurrentRuns` | the requested ceiling, clamped to 1–50 | `HEARTBEAT_POLICY_MAX_CONCURRENT_{MIN,MAX}` |
| effective ceiling | `concurrencyEnabled ? min(maxConcurrentRuns, 16) : 1` | `resolveExternalLifecycleConcurrency` |

`EXTERNAL_LIFECYCLE_MAX_CONCURRENT_RUNS = 16` (`packages/shared/src/validators/agent.ts`)
bounds what any single agent can hold regardless of configuration, so a
mis-set `maxConcurrentRuns` cannot alone exceed cluster provisioning.

`concurrencyEnabled` is **deliberately not settable by heartbeat preset**
(BLO-15959): a preset tunes interval/cooldown/ceiling, but opting an agent into
real concurrency stays an explicit per-agent decision. That is what makes the
rollout an allowlist.

The ceiling is enforced at dispatch as
`availableSlots = effectiveMaxConcurrentRuns - runningCount`. A `running` row
stops counting once silent for `RUN_STALE_SILENCE_MS` (15 min) so a dead Job
cannot starve new work — see `isRunOccupyingSlot`.

### Sizing

Each admitted slot is one Kubernetes Job + Pod with the agent's full image and
its own ephemeral workspace, so N slots cost roughly N× an agent's steady-state
footprint. Raise ceilings in graded cohorts and watch the cleanup metrics below
before widening further; there is no cluster-wide admission control beyond the
per-agent ceiling and the slot index.

## Leases

`external_runtime_reservations` is the lease table. One row per run
(`external_runtime_reservations_run_idx` is UNIQUE on `run_id`, so a run can
never hold two identities).

States: `reserved → launching → launched → release_pending → released`.

Two partial-unique indexes do the actual containment, both scoped to
`released_at IS NULL`:

- **`..._active_slot_idx` on `(agent_id, slot_id)`** — the per-agent ceiling.
  Slots are dense from 0.
- **`..._active_isolation_writer_idx` on `isolation_key`** — one writer per
  shared mutable resource. This is what keeps shared workspaces serialized.

`isolation_mode` is one of `legacy | pending | shared | run | workspace`, and
the key follows from the effective ceiling (`resolveK8sRunIsolationIdentity`):

| effective ceiling | mode | key | effect |
|---|---|---|---|
| `> 1` | `run` | `run:<runId>` | siblings hold independent leases and independent ephemeral workspaces |
| `= 1` (default) | `shared` | `agent-shared:<agentId>` | the agent's warm persistent workspace, serialized |
| explicit reused workspace | `workspace` | `workspace:<id>` | names the tree; several issues may share it, so it serializes across them |

Keys are additionally **tree-scoped** (`withTreeScopedReservationKey`,
BLO-31443/BLO-19422) so two runs resolving to the same worktree collide even
when their run ids differ. **Shared and unknown modes therefore stay at
concurrency 1 by construction, independent of the `concurrencyEnabled` flag.**

A contended lease raises `ExternalRuntimeIsolationConflictError`
(`external_runtime_isolation_conflict`) and the run defers rather than
proceeding — fail-closed.

## Observability

Exposed on `/metrics` (`server/src/services/metrics.ts`):

| metric | read it for |
|---|---|
| `claude_k8s_concurrent_run_blocked_total{agent_id,reason,isolation_mode}` | slot-ceiling refusals. Labels are allow-listed, so cardinality is bounded by roster size |
| `paperclip_k8s_isolated_run_started_total` | the paired positive control — isolated starts that were *not* blocked. Read the two together; a blocked counter that merely stopped is ambiguous alone |
| `paperclip_agent_dispatch_declined_total` | every other reason dispatch declined a queued run (PEN-3607) |
| `paperclip_external_runtime_reservation_events_total` | lease transitions: `reserved`, `contended`, `launching`, `launched`, `released`, `name_mismatch` |
| `paperclip_external_runtime_reservations_active` | live leases |
| `paperclip_external_runtime_reservation_oldest_age_seconds` | oldest live lease — a lease that never releases shows up here first |
| `paperclip_external_runtime_reservation_stranded_oldest_age_seconds` | stranded leases specifically (labelled; prefer this for alerting over the unlabelled gauge above) |
| `paperclip_external_runtime_reservations_release_pending` / `..._release_pending_oldest_age_seconds` | teardown that started and did not finish |

Direct reconciliation query — live Jobs with `active>0` should equal
unreleased reservations minus `launching` (no Job yet) minus `release_pending`
(Job already reaped). A persistent mismatch is the signal that matters:

```sql
SELECT state, count(*) FROM external_runtime_reservations
WHERE released_at IS NULL GROUP BY state;
```

### Failure signatures

- `name_mismatch` (`external_runtime_job_name_mismatch`) — the reservation is
  intact and the *caller* changed identity, typically an adapter-type change
  re-prefixing the Job name. **Retrying never clears it**; the unreleased row
  keeps holding the slot until an operator releases it.
- A sibling acquiring `release_reason = 'job_missing'` while its run was still
  live is the cross-run-damage signature. Base rate measured 2026-10-07 was
  0.27% of released-with-`job_uid` rows; treat a cluster of them in one instant
  as an upstream event (worker restart / kube API) rather than per-agent
  collateral, and discriminate by checking whether *other* agents' runs died in
  the same window — an agent-scoped reaper cannot reach them.

## Cleanup

Three windows kill a run whose Job stopped reporting
(`server/src/services/heartbeat.ts`, `k8s-job-liveness.ts`):

| constant | value | applies to |
|---|---|---|
| `EXTERNAL_LIFECYCLE_PRE_ADAPTER_STALE_MS` | 5 min | silence before the adapter ever stamped the run |
| `EXTERNAL_LIFECYCLE_STALE_MS` | 15 min | normal in-run silence (= `RUN_STALE_SILENCE_MS`) |
| `EXTERNAL_LIFECYCLE_HARD_STALE_MS` | 45 min | hard ceiling (`AGENT_POD_HARD_STALE_MS`) |

A stale kill releases the lease with `release_reason =
'external_lifecycle_stale_killed'` and sets the run's `errorCode` to match.
Other release reasons seen in normal operation: `succeeded`, `cancelled`,
`timeout`, `job_missing`, `k8s_job_deleted_externally`.

Workspace-side cleanup is separate and has its own metrics —
`paperclip_isolation_workspace_reaper_*` for ephemeral run roots and
`paperclip_execution_workspace_collector_*` / `..._teardown_*` for worktrees.
A leaked *workspace* does not hold a slot; a leaked *reservation* does.

Manual release, when a lease is wedged with no live Job (confirm with
`kubectl get job <name> -o jsonpath='{.metadata.uid}'` first — the lease's
`job_uid` must be absent, not merely different):

```sql
UPDATE external_runtime_reservations
SET released_at = now(), release_reason = 'operator_manual', state = 'released'
WHERE run_id = '<run-uuid>' AND released_at IS NULL;
```

## Rollback

**Set `concurrencyEnabled: false` on the affected agent.** That is the whole
rollback. The ceiling is recomputed from policy on every dispatch and is never
persisted, so the agent returns to one concurrent run immediately with no
migration, no backfill, and no repair of in-flight rows — already-admitted
siblings finish and release normally, and no new sibling is admitted.

Scope it to the agent that misbehaved before considering anything wider; the
flag is per-agent precisely so a rollback does not have to be fleet-wide.

Covered by `heartbeat-external-lifecycle-concurrency-flag.test.ts` (the gate)
and `shared-checkout-writer-exclusivity.test.ts` (serialization survives it).
Keep both green — **the default-off gate is the rollback posture and is not
scheduled for removal.** What BLO-15962 retired was the *unconditional*
external-lifecycle cap, which this gate replaced; the gate itself staying is
the point.

## Rollout state

As of 2026-10-08, 15 of 15 active `claude_k8s` agents run with
`concurrencyEnabled: true`, at graded ceilings — 16 (Ally), 12, 8, 3 (×5),
2 (×7). Every agent still at the default is paused or a non-k8s adapter.
Re-read the live values rather than trusting this paragraph:

```sql
SELECT name,
       runtime_config->'heartbeat'->>'concurrencyEnabled' AS enabled,
       runtime_config->'heartbeat'->>'maxConcurrentRuns'  AS ceiling
FROM agents WHERE adapter_type = 'claude_k8s' ORDER BY 3 DESC NULLS LAST;
```
