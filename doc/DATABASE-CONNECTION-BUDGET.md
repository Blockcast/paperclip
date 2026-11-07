# Postgres connection budget

The server-side ceiling that `POSTGRES_POOL_MAX` (`packages/db/src/client.ts`)
must fit inside. This file exists because that constant was sized three times
by incident (the stranded-reconcile chain latch in `server/src/index.ts`,
`issueService`'s instance-settings read in `services/issues.ts`, BLO-35940)
and never once against the server it actually connects to — there was no
budget to check it against. BLO-37330.

## The ceiling

Read 2026-09-28 from the production instance, via the `pg_settings_*` metrics
the `heartbeat-run-queue-latency-exporter` postgres-exporter publishes to
Prometheus. No credential is needed to re-read this.

| setting | value |
|---|---|
| instance | `paperclip-pg-headless.paperclip.svc.cluster.local:5432` |
| image | `postgres:18-alpine` |
| `max_connections` | **125** |
| `superuser_reserved_connections` | **3** |
| `reserved_connections` | 0 |
| `max_prepared_transactions` | 0 |

**Available to the `paperclip` role: 125 − 3 = 122.**

`max_connections` was raised 100 → 125 by onprem-k8s#6741 (BLO-49065) when the
worker StatefulSet went to `replicas: 2` (BLO-45764) and peak application
processes rose from 4 to 5. At 100 the 5 × 18 = 90 committed pool connections
exceeded the 72 the budget allowed.

`max_wal_senders` is 10 but consumes none of this: walsender slots stopped
counting against `max_connections` in PostgreSQL 12, and `paperclip-pg` is a
single instance (`StatefulSet` replicas 1) with no streaming replica attached,
so the setting is inert here on both counts.

Re-read it with:

```promql
{__name__=~"pg_settings_max_connections|pg_settings_superuser_reserved_connections|pg_settings_reserved_connections"}
```

### There is no replica to divide across

`paperclip-pg` is one `StatefulSet` with `replicas: 1`. The whole 97 belongs to
the one instance; nothing is split.

## The consumers

Enumerated 2026-09-28 by scanning every `Deployment`, `StatefulSet`, `CronJob`
and `DaemonSet` **cluster-wide** for a reference to `paperclip-pg` or the
`paperclip-database-url` secret. Everything that connects is in the `paperclip`
namespace.

| consumer | processes | connections each | peak |
|---|---|---|---|
| `paperclip-api` (Deployment, `replicas: 2`, `maxSurge: 1`) | up to **3** mid-rollout | `POSTGRES_POOL_MAX` | 3 × N |
| `paperclip` (StatefulSet worker, `replicas: 2`, rolling-replaces in place) | **2** | `POSTGRES_POOL_MAX` | 2 × N |
| `heartbeat-run-queue-latency-exporter` | 1 | postgres-exporter | ~3 |
| CronJobs — `psql` / `pg_dump` one-shots, all `concurrencyPolicy: Forbid` | ≤3 overlapping | 1–2 | ~6 |
| `createUtilitySql` (`client.ts`, `max: 1`, transient at startup) | ≤4 | 1 | ~4 |
| operator / ad-hoc `psql` headroom | — | — | ~4 |

The tilde-prefixed `peak` column is a reading aid. **The arithmetic block below
is the authoritative copy of those four reserves** — it is what the budget test
parses, so a re-measurement carried into this table but not into the block
changes nothing and is not caught. Edit the block, then update this column to
match.

**Peak application process count is 5**: the API Deployment is
`maxSurge: 1` / `maxUnavailable: 0`, so a rollout runs 3 API pods at once, and
`terminationGracePeriodSeconds` is 120 so a draining pod holds its pool for up
to two minutes after the new one is ready. The worker StatefulSet replaces its
pods one at a time in place and never surges, so it contributes exactly its
`replicas`. `server/src/__tests__/postgres-pool-budget.test.ts` derives this
count from `deploy/helm/paperclip/values.blockcast.yaml` (api `replicas` +
`maxSurge` + worker `replicas`) and fails if the arithmetic line disagrees — a
replica change must come with a budget change (BLO-49067).

### There is no second application pool

**One split, no addition (BLO-47034).** On `PAPERCLIP_NODE_ROLE=api` the
process pool is divided: the main pool gets
`POSTGRES_POOL_MAX - POSTGRES_WEBHOOK_POOL_MAX` and the GitHub webhook router
gets `POSTGRES_WEBHOOK_POOL_MAX` (`packages/db/src/client.ts`). The two sum to
`POSTGRES_POOL_MAX`, so every figure below is unchanged. The worker keeps the
whole pool. The gauges carry a `pool` label (`main` / `webhook`), so sum over
it when reading a per-process total.

`server/src/index.ts` creates a second pool only in the
`config.databaseMigrationUrl` branch, and that resolves solely from
`DATABASE_MIGRATION_URL` (`databaseMigrationUrl` in `server/src/config.ts`).
That variable is **not
set on either workload** — verified on both `paperclip-api` and the `paperclip`
StatefulSet. So `pluginMigrationDb` aliases the main pool and the earlier
"may create a second 10-slot pool" note is, in this deployment, false.

The CronJobs are all one-shot `psql`/`pg_dump` containers
(`postgres:18-alpine`, `azure-cli`), not the application binary, so none of
them opens a `POSTGRES_POOL_MAX`-sized pool:
`fable5-straggler-guard` (*/15), `penstock-agent-environment-reconciler`
(*/15), `paperclip-blocked-rechecker` (17 */6), `gbrain-oauth-refresher`
(0 */12), `paperclip-pg-backup` (0 3 * * *), `paperclip-pg-retention`
(30 4 * * *), `agents-unpause-may7` (suspended).

## The arithmetic

```
122   available to the paperclip role (125 − 3 superuser-reserved)
−  3   postgres-exporter
−  6   overlapping cronjob one-shots
−  4   transient createUtilitySql pools
−  4   operator headroom
=105   for application pools
−  8   estimation margin
= 97   budgeted to application pools
÷  5   peak processes (3 API mid-rollout + 2 workers)
= 18   per pool
```

**`POSTGRES_POOL_MAX = 18`.**

At steady state (2 API + 2 workers) that is 72 + 17 = **89 of 125**. At peak
mid-rollout it is 90 + 17 = **107 of 125**, leaving 15 unclaimed beneath the
role's 122 and the 3 superuser-reserved connections untouched below that.

### Why the margin is a line in the arithmetic and not a rounding habit

Every number in the consumers table is *declared* configuration, not an
observed backend count — and the section below explains why observing them is
not currently possible at all. A budget with no slack is therefore one
un-modelled consumer away from `FATAL: sorry, too many clients already`: a
second operator `psql`, a fourth overlapping cronjob, a fifth transient
`createUtilitySql`. Sizing to the exact ceiling would spend the whole server
budget on the strength of estimates the document itself declines to vouch for.

The 8 is one full application pool's worth of headroom short of a rollout —
enough to absorb any single un-modelled consumer in the table above.

### What 18 does not do

It does **not** clear the ~19-concurrent-demand floor measured for a single
process on 2026-09-24 (PR-reviewer wakes 8, scheduler tick ~11, plugin jobs 10,
one `getDeleteBlastRadius` precheck 8 — overlapping subsystems sharing one
pool). Clearing that worst case, where every subsystem peaks simultaneously,
would need ≥19 per pool and would consume the entire margin above.

That residual is deliberate, because the two failures are not comparable. A
pool that is one short of its worst case makes the 19th caller *wait* —
`postgres.js` queues rather than throwing. A pool that is one over the server's
ceiling makes Postgres *refuse*, which takes the fleet down. 10 → 18 removes the
steady-state starvation this row was filed for; buying the last unit of the
worst case would cost the protection against the outage.

It also keeps `derivePrReviewerWakeMaxConcurrency`'s invariant
(`routes/github-webhook.ts`): `floor(18/2) − 1 = 8`, and `8 × 2 = 16 < 18`.

### Raising it further needs a server-side change first

18 fits 5 processes inside 122 with 7 to spare beyond the 8-connection margin;
19 is the largest that fits. Anything above 21 breaches the ceiling outright even
with no margin at all, and requires raising `max_connections` on `paperclip-pg` (or
putting a pooler in front of it) **in the same change** — otherwise the client
stops queueing and Postgres starts refusing connections, which is the worse
failure.

## Known gap: live backend counts are not measurable

The exporter connects as the non-superuser role `heartbeat_run_queue_exporter`,
which does not hold `pg_read_all_stats`. PostgreSQL therefore shows it only its
*own* backend in `pg_stat_activity`; every other session's fields come back
NULL. `sum(pg_stat_activity_count)` reads **1** against a database that
demonstrably has dozens of live connections.

**That 1 is a visibility artifact, not a measurement.** Do not read it as
utilization, and do not size anything from it. Verifying the arithmetic above
against reality needs either `GRANT pg_read_all_stats` to the exporter role or
a `psql` session with sufficient privilege — neither was in reach when this was
written, so every number in the consumers table is derived from declared
configuration rather than observed backends.
