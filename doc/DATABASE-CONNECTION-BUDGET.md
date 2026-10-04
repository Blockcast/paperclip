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
| `max_connections` | **100** |
| `superuser_reserved_connections` | **3** |
| `reserved_connections` | 0 |
| `max_prepared_transactions` | 0 |

**Available to the `paperclip` role: 100 − 3 = 97.**

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
| `paperclip` (StatefulSet worker, `replicas: 1`, rolling-replaces in place) | **1** | `POSTGRES_POOL_MAX` | 1 × N |
| `heartbeat-run-queue-latency-exporter` | 1 | postgres-exporter | ~3 |
| CronJobs — `psql` / `pg_dump` one-shots, all `concurrencyPolicy: Forbid` | ≤3 overlapping | 1–2 | ~6 |
| `createUtilitySql` (`client.ts`, `max: 1`, transient at startup) | ≤4 | 1 | ~4 |
| operator / ad-hoc `psql` headroom | — | — | ~4 |

The tilde-prefixed `peak` column is a reading aid. **The arithmetic block below
is the authoritative copy of those four reserves** — it is what the budget test
parses, so a re-measurement carried into this table but not into the block
changes nothing and is not caught. Edit the block, then update this column to
match.

**Peak application process count is 4**, not 3: the API Deployment is
`maxSurge: 1` / `maxUnavailable: 0`, so a rollout runs 3 API pods at once, and
`terminationGracePeriodSeconds` is 120 so a draining pod holds its pool for up
to two minutes after the new one is ready. The worker StatefulSet replaces its
single pod in place and never doubles.

### There is no second application pool

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
  97   available to the paperclip role (100 − 3 superuser-reserved)
−  3   postgres-exporter
−  6   overlapping cronjob one-shots
−  4   transient createUtilitySql pools
−  4   operator headroom
= 80   for application pools
−  8   estimation margin
= 72   budgeted to application pools
÷  4   peak processes (3 API mid-rollout + 1 worker)
= 18   per pool
```

**`POSTGRES_POOL_MAX = 18`.**

At steady state (2 API + 1 worker) that is 54 + 17 = **71 of 100**. At peak
mid-rollout it is 72 + 17 = **89 of 100**, leaving 8 unclaimed beneath the
role's 97 and the 3 superuser-reserved connections untouched below that.

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

18 is the largest value that fits 4 processes inside 97 while carrying the
8-connection margin. Anything above ~21 breaches the ceiling outright even with
no margin at all, and requires raising `max_connections` on `paperclip-pg` (or
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
