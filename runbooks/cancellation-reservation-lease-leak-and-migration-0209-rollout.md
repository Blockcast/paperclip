# Cancellation resource leak + migration 0209 crash-loop (2026-08-03)

Source: `server/src/services/heartbeat.ts` (`cancelRunInternal`,
`cancelActiveForAgentInternal`, `reconcileOrphanedEnvironmentLeases`,
`reconcileReleasePendingExternalRuntimeReservations`),
`packages/db/src/precreate-online-indexes.ts`, migration
`0209_heartbeat_runs_recovery_dispatch_index.sql`. Tracking issue:
[BLO-21460](/BLO/issues/BLO-21460). Owner: Platform/SRE.

Trigger: alert on
`paperclip_external_runtime_reservations_release_pending > 0` or
`paperclip_environment_leases_orphaned_active > 0` sustained more than a few
scheduler-interval cycles, or the worker scrape target reporting `up == 0`
while the scheduler is crash-looping on startup while applying database
migrations.

## What happened

On 2026-08-03 a batch of stale agent executions was cancelled. Cancellation
at the time only did two things durably: mark the run `cancelled`, and
best-effort delete the run's Kubernetes Job. Two other resources were left
to a later, conditional cleanup pass instead of being resolved by
cancellation itself:

- The external-runtime slot reservation for each run is flipped to
  `release_pending` by a database trigger the moment the run's status
  changes (migration 0128), but the row is only durably released
  (`released_at` set) once a **separate reconciliation pass** confirms the
  Job is actually gone or terminal. That reconciliation ran, but only as a
  side effect of the scheduler's periodic tick and of dispatching new work
  for the same agent — there was no path that ran it inline from
  cancellation itself.
- The ephemeral environment lease for each run had **no** reconciliation
  path at all outside of the run's own normal finalize `finally` block.
  Cancellation never called it, and nothing else did either.

Both gaps were latent — the periodic scheduler tick usually cleared the
backlog within one interval. They became load-bearing when the scheduler
itself stopped running: a deploy applied migration
`0209_heartbeat_runs_recovery_dispatch_index.sql`, whose partial concurrent
index had not been precreated online ahead of time. The migration's own
guard correctly refused to build the index inline on the populated
`heartbeat_runs` table (the same guard pattern as migrations 0205 and
0208), which meant every startup attempt failed the same way — a
straightforward crash-loop.

With the scheduler down, nothing was reconciling the reservations and leases
the earlier cancellation batch had left in `release_pending` /
still-`active`. Each held its agent's execution slot. As the crash-loop
continued, executor capacity was exhausted by rows that could never resolve
themselves, compounding a routine migration rollout gap into a capacity
incident.

## Recovery performed at the time (manual, non-durable)

1. Confirmed the stale executions were genuinely terminal and cancelled any
   still in a cancellable state.
2. Manually and guardedly released the orphaned reservations and leases
   whose runs were confirmed terminal (same eligibility check the automated
   reconciler now applies: Job confirmed gone/terminal before release, never
   a blind release).
3. Ran `CREATE INDEX CONCURRENTLY IF NOT EXISTS
   heartbeat_runs_recovery_dispatch_idx ...` online, matching the exact
   definition the migration's guard verifies.
4. Restarted the scheduler; migrations applied cleanly and dispatch resumed.

This runbook and the fixes below exist so that recovery never again depends
on a human reproducing steps 2–3 by hand under incident pressure.

## The permanent fixes (BLO-21460)

1. **Cancellation releases both resources itself, idempotently.**
   `cancelRunInternal` / `cancelActiveForAgentInternal` now call
   `releaseCancelledRunRuntimeResources`, which releases the run's
   environment lease unconditionally and, for external-lifecycle adapters,
   runs a run-scoped
   `reconcileReleasePendingExternalRuntimeReservations` pass right after the
   Job-deletion attempt — it no longer waits for the next scheduler tick or
   dispatch pass. Both underlying releases are no-ops on a resource that is
   already released, so **repeated cancel calls, and a cancel retried after
   a crash mid-cleanup, converge to the same released state** rather than
   erroring or double-releasing.
2. **A resource-only retry path for an already-terminal run.** If
   `cancelRunInternal` is called again for a run that is already terminal
   (any of `succeeded`/`interrupted`/`failed`/`cancelled`/`timed_out`), it no
   longer no-ops entirely — it retries the lease/reservation release for
   that run before returning. This is the direct fix for "cancellation
   crashed between marking the run cancelled and releasing its resources":
   the next call (manual retry, or the periodic sweep below) finishes the
   job instead of leaving it stuck until a human notices.
3. **A reconciliation pass independent of dispatch pressure.**
   `reapOrphanedRuns` — already on the main scheduler tick
   (`heartbeatSchedulerIntervalMs`, independent of whether any agent has
   queued work) — now also calls `reconcileOrphanedEnvironmentLeases`, the
   lease-side counterpart to the existing reservation reconciler. An agent
   with no more queued work, which previously meant nothing would ever
   trigger dispatch-piggybacked reconciliation, is no longer a gap.
4. **Observability that distinguishes "stuck" from "normal in-flight."**
   `paperclip_external_runtime_reservations_release_pending` and
   `paperclip_environment_leases_orphaned_active` (plus matching
   `_oldest_age_seconds` gauges) are measured **after** each reconciliation
   pass, so they read 0 whenever reconciliation is keeping up — a healthy
   fleet never shows a non-zero value here, unlike the pre-existing
   "active reservations" gauge, which is expected to be non-zero whenever
   anything is genuinely running. See `server/src/services/metrics.ts`
   (search `BLO-21460`) for the exact query and alerting posture. **These
   gauges are only emitted by the paperclip control plane; wiring the
   Prometheus alert rule for them is a separate step — see "Alerting" below.**
5. **Migration online-index prerequisites are now automatic.**
   `packages/db/src/precreate-online-indexes.ts` runs before
   `applyPendingMigrations` in `db:migrate` (also runnable standalone via
   `pnpm run db:precreate-online-indexes`). For every migration still
   pending that requires an online-precreated index (0205, 0208, 0209, 0217,
   0224, 0226, and 0230 today — see `ONLINE_INDEX_PREREQUISITES`), it:
   precreates the index with
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS` if absent; self-heals an
   `INVALID` leftover from a previously-interrupted `CONCURRENTLY` build by
   dropping and rebuilding it concurrently (the same recovery each
   migration's own error hint already told an operator to run by hand); and
   is a complete no-op once every prerequisite migration is applied, so a
   steady-state deploy never re-scans `heartbeat_runs`. It never overrides a
   migration's own verification — the migration's DO-block guard
   independently re-checks columns/predicate/access-method before trusting
   any index, precreated by this function or by hand.
   See `packages/db/src/precreate-online-indexes.test.ts` for proof that an
   upgrade from a pre-0209 (and combined pre-0208+pre-0209) state applies
   cleanly with no manual database repair.

## Alerting

`prometheusRule.enabled` is false on the Blockcast cluster (see the header
comment in `deploy/helm/paperclip/templates/prometheusrule.yaml` for why —
short version: the deploying ServiceAccount has no RBAC on
`prometheusrules.monitoring.coreos.com`, so turning the flag on 403s the
whole Helm release). The chart's copy of any rule here is a **mirror, not
the live alert** — the authoritative rules live in `Blockcast/onprem-k8s`
(`monitoring/prometheus-configmap.yaml`, key
`paperclip-runtime-alerts.rules.yml`), synced to the cluster's Prometheus
ConfigMap by a manual `monitoring-rules` Argo sync. A rule that only exists
in this repo does not protect anything until it also lands there and that
Argo app is synced — confirm both, the same way BLO-18859's runbook head
documents for its alert family, before trusting this alert as live. The
authoritative companion rule is currently **open and not live** in
[Blockcast/onprem-k8s#2119](https://github.com/Blockcast/onprem-k8s/pull/2119)
(head `ed177e5a8b7b`, checked 2026-08-27). It still requires merge followed by
the manual `monitoring-rules` Argo sync; the Paperclip chart copy is not itself
a deployment.

Suggested rule (mirror the exact PromQL into both
`deploy/helm/paperclip/templates/prometheusrule.yaml` and the two
`Blockcast/onprem-k8s` files above; keep those two lockstep per
`scripts/check-prometheus-rules-lockstep.sh` in that repo):

```yaml
- alert: PaperclipRuntimeResourceReconciliationStuck
  expr: >
    max(paperclip_external_runtime_reservations_release_pending) > 0
    or max(paperclip_environment_leases_orphaned_active) > 0
    or (max(up{job="paperclip-control-plane", service="paperclip-workers"}) == 0)
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Paperclip cancellation cleanup is not keeping up"
    description: >
      A confirmed-releasable external-runtime reservation or ephemeral
      environment lease has not been released for 10+ minutes. Reconciliation
      (reapOrphanedRuns on the main scheduler tick) is failing to keep up —
      check whether the scheduler is running at all (e.g. crash-looping on a
      migration, see BLO-21460) or whether the kube API is reachable. Left
      unaddressed this exhausts executor capacity.
```

## Manual recovery (only if the automated paths above are themselves down)

Do not run these unless the alert above is firing *and* the automated
reconciliation described in "The permanent fixes" is confirmed not running
(e.g. the scheduler process itself is down). If the scheduler is up, prefer
restarting it or waiting one scheduler interval over manual intervention —
the reconciler is safe to let run.

1. Confirm the scheduler/worker is actually not applying migrations —
   check its recent logs for the specific migration error message
   (`migration <N> requires online index precreation` /
   `found an invalid or incorrectly defined prerequisite index`).
2. Run `pnpm run db:precreate-online-indexes` against the target database
   (safe to run repeatedly; a no-op once satisfied) to satisfy any pending
   migration's index prerequisite, then `pnpm run db:migrate`.
3. Once the scheduler is running again, let `reapOrphanedRuns` clear the
   backlog on its own — it runs every scheduler interval and its
   reservation/lease release logic is idempotent. Manually releasing a
   reservation or lease ahead of that pass is only appropriate if executor
   capacity is *actively* exhausted and cannot wait one interval; if so,
   verify the run is genuinely terminal and its Kubernetes Job is confirmed
   gone before releasing — never release a reservation or lease for a run
   whose Job might still be running.

## Rollback

Every fix above is additive to existing, already-load-bearing code paths
(the reservation trigger from migration 0128, the existing
`releaseEnvironmentLeasesForRun` helper, the existing
`reconcileReleasePendingExternalRuntimeReservations` reconciler, and each
migration's own DO-block verification guard) — none of it changes their
behavior. There is no feature flag. If a change here needs to be backed out:

- The cancellation-path changes (`releaseCancelledRunRuntimeResources` and
  its call sites) can be reverted independently; cancellation returns to
  relying solely on the periodic sweep, reintroducing the "no queued work =
  no reconciliation trigger" gap but not regressing anything else.
- The `reapOrphanedRuns` lease sweep addition
  (`reconcileOrphanedEnvironmentLeases`) can be reverted independently of
  everything else in this list.
- `ensureOnlineIndexPrerequisites` can be removed from `migrate.ts` without
  affecting migration correctness — every migration's own guard still
  requires and verifies the index independently; removing the automated
  precreation only returns to requiring the manual step this ticket
  removed. `DROP INDEX CONCURRENTLY IF EXISTS <name>` is always safe against
  a precreated index if a rollback needs to undo the index itself (each
  migration's guard tolerates the index being absent on an otherwise-empty
  table, and requires it again on a populated one — the original guarded
  behavior).
