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

`release_pending` is written by the database, not by `server/src`: the
`heartbeat_runs_release_external_runtime_reservation` trigger (migration
`0128`) moves a `launching` or `launched` lease there when its run goes
terminal, and a `reserved` lease (no Job yet) straight to `released`. Server
code only reads the state, to finish the release once the Job is gone.
`external-runtime-reservations.test.ts` asserts the cancelled-run case. So the
release-pending gauges below are live signals, not structurally zero.

Two partial-unique indexes do the actual containment:

- **`external_runtime_reservations_active_slot_idx` on `(agent_id, slot_id)`**, `WHERE released_at IS
  NULL` — the per-agent ceiling. Slots are dense from 0.
- **`external_runtime_reservations_active_isolation_writer_idx` on `isolation_key`**, `WHERE released_at
  IS NULL AND isolation_key IS NOT NULL` — one writer per shared mutable
  resource. That second clause is why an unbound row does not contend.

### Two keys, and the column stores the second one

`resolveK8sRunIsolationIdentity` returns **two** keys that are deliberately
allowed to diverge (BLO-31443):

- `isolationKey` — the run's *private* filesystem identity. Derives `tmpRoot`,
  is stamped into `sessionScope`, and gates saved-session resume.
- `reservationKey` — the *shared mutable resource* this run will write. Binds
  the writer index and nothing else.

**The `isolation_key` column stores `reservationKey`** (`heartbeat.ts`:
`isolationKey: k8sIsolationIdentity.reservationKey`). When querying lease rows,
match the last column below, not the third.

`isolation_mode` is one of `legacy | pending | shared | run | workspace`:

Rows are in branch order and the first match wins — in particular the
persisted-workspace rows are evaluated **before** either ceiling row, so they
outrank them whatever the ceiling is.

| selected when | mode | `isolationKey` | what lands in `isolation_key` |
|---|---|---|---|
| stateless PR review | `run` | `run:<runId>` | same |
| persisted workspace, *explicitly* reused — and either isolated or ceiling `> 1` | `workspace` | `workspace:<id>` | same — it already names the tree |
| persisted workspace, isolated | `workspace` | `workspace:<id>` | `workspace-tree:<treeKey>` if a tree key resolves, else same |
| ceiling `> 1`, no persisted workspace that qualifies above | `run` | `run:<runId>` | `workspace-tree:<treeKey>` if a tree key resolves, else same |
| ceiling `= 1` (default) | `shared` | `agent-shared:<agentId>` | `workspace-tree:<treeKey>` if a tree key resolves, else same |

Only the first two rows are genuinely `same` — both are `runUniqueIdentity` call
sites. `resolveWorkspaceWriterTreeKey` takes no ceiling or concurrency input, so
on the last three rows whether a tree key resolves turns on
`runResolvesToOwnTree`, and each branch carries its own condition:

- **resolves to its own tree** — keys on `<pwid>:<issueId>` when the runScope is
  the default `per_issue` and the run has an issue id (the ordinary case),
  substituting `no-project-workspace` for a null `<pwid>`;
- **does not** — keys on `project-primary:<pwid>` for *any* run with a project
  workspace, regardless of runScope or issue id, and **null** when there is no
  project workspace.

So `per_issue` plus an issue id is not on its own sufficient: outside the
own-tree branch it buys nothing, and `agent_default` mode — where
`resolveWorkspaceForRun` runs with `useProjectWorkspace: false` and lands in the
agent home — reaches exactly that null. Those are three `workspace-tree:` shapes,
not three shapes of the column: wherever the tree key is null the column keeps
the `run:` / `agent-shared:` / `workspace:` form from the table.
**Grep the `workspace-tree:` prefix, not the `<pwid>:<issueId>` form**, or the
primary-checkout rows are missed.

`withTreeScopedReservationKey` does not narrow the key — it **replaces** it.
Whenever a per-issue tree key resolves, `isolation_key` is
`workspace-tree:<treeKey>` and none of `run:` / `agent-shared:` / `workspace:`
appears, so **grepping `isolation_key` for `agent-shared:` finds nothing on the
default path.** The two keys are equal only when the tree key is null.

What the writer index guarantees **by construction** is one writer per shared
mutable resource — the tree, or the agent home when no tree key resolves — and
that holds across agents. It is *not* the per-agent ceiling, which is enforced
at dispatch by `availableSlots` and therefore by `concurrencyEnabled`. Two
shared-mode runs on different trees hold different reservation keys and do not
serialize against each other; BLO-19422 gave that up deliberately. The
documented hole is BLO-12990 — a silent `running` row is excluded from
`countRunsOccupyingSlots`, so `availableSlots = 1 - 0 = 1` admits a second run
even at effective concurrency 1.

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
| `paperclip_external_runtime_reservations_release_pending` / `paperclip_external_runtime_reservation_release_pending_oldest_age_seconds` (note: singular `reservation`) | teardown that started and did not finish |

Direct reconciliation query — live Jobs with `active>0` should equal
unreleased reservations minus `reserved` and `launching` (no Job yet on the
normal path) minus
`release_pending` (Job already reaped). A persistent mismatch is the signal that
matters — and note that a stuck `reserved` row is a leaked slot, not a missing
Job:

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
Other reasons seen at non-test call sites include `succeeded`, `completed`,
`cancelled`, `job_missing`, `adapter_failed`, `launch_failed`,
`terminal_prelaunch_orphan`, `legacy_drained`,
`external_runtime_isolation_conflict`, and `run_cancelled:<errorCode>`. This
list **cannot** be complete: `releaseExternalRuntimeReservation` takes
`reason: string`, and the dominant call site passes the run's own
`errorCode ?? outcome`, so the value set is open by construction and sourced
from the adapter. Treat an unfamiliar value as a prompt to grep rather than as
an anomaly. (`launch_failed` and `legacy_drained` are credible but unconfirmed
— neither appears as a literal at any call site read for this document.)

Two traps. There is **no `timeout` reason** — the run *status* is `timed_out`.
And an adapter error code such as `k8s_job_deleted_externally` reaches this
column **both ways**: bare on the terminal-finalization path (the run's
`errorCode` is passed straight through), and prefixed as
`run_cancelled:k8s_job_deleted_externally` on the cancellation path. Match
both — a prefix-only query misses every terminally-finalized row. `job_missing`
above is exactly such a bare errorCode, stamped by the vanished-Job
reconciler.

Workspace-side cleanup is separate and has its own metrics —
`paperclip_isolation_workspace_reaper_*` for ephemeral run roots and
`paperclip_execution_workspace_collector_*` / `paperclip_execution_workspace_teardown_*` for worktrees.
A leaked *workspace* does not hold a slot; a leaked *reservation* does.

**First-line remedy: make the run terminal, not the lease.** `cancelRun`
deletes the Job by its recorded name and lets the reaper release the
reservation — the same path the code automates. For the `name_mismatch` /
adapter-type strand, BLO-28865 self-heals that way and
[`runbooks/external-runtime-reservation-stranded.md`](../runbooks/external-runtime-reservation-stranded.md)
is the procedure, including what not to clear (`job_name` / `job_uid` are the
only handle on an orphaned Job). Start there.

The raw `UPDATE` below is the **fallback** for a lease whose run is already
terminal, so there is no run left to cancel, and that still holds a slot. Use it
only when **no live Job owns the lease**. Read the row first — you
need a Job name to check against and `state` to know which case you are in:

```sql
SELECT state, expected_job_name, job_name, job_uid
FROM external_runtime_reservations
WHERE run_id = '<run-uuid>' AND released_at IS NULL;
```

Then `kubectl get job <expected_job_name|job_name> -o jsonpath='{.metadata.uid}'`.
Release only if one of these holds:

- **no Job exists under that name**, or
- **a Job exists and its uid differs from a non-null `job_uid`** — positive
  proof the lease's own Job is gone. This is the safe case.

**A null `job_uid` does not mean no Job exists.** `createNamespacedJob` can
succeed after the reservation gating it was released, so a `reserved` /
`launching` row with a null `job_uid` may have a live unstamped Job. That case
needs *more* care, not less: identify the Job by name and run/agent labels
before releasing anything.

If you reached this fallback from a `name_mismatch` row, the run was already
terminal; otherwise go back to `cancelRun` above. The row is raised only from
`launched` — but `launched` does **not** imply a non-null `job_uid`
(`recordExternalRuntimeJobIdentity` coalesces a null uid in), so it is not
automatically the safe present-and-different case. Read `job_uid` from the
`SELECT` above and apply the same two rules.

```sql
UPDATE external_runtime_reservations
SET released_at = now(), release_reason = 'operator_manual', state = 'released'
WHERE run_id = '<run-uuid>' AND released_at IS NULL;
```

This raw `UPDATE` bypasses `recordExternalRuntimeReservationEvent("released")`,
so `paperclip_external_runtime_reservation_events_total{…released}` will not
move and the active/oldest gauges only correct on their next refresh. Confirm
the release by re-reading the row, not by watching those metrics.

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
FROM agents WHERE adapter_type = 'claude_k8s'
ORDER BY (runtime_config->'heartbeat'->>'maxConcurrentRuns')::int DESC NULLS LAST;
```
