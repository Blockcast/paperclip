# Migration 0268: issues trigram index build blocks issue writes

Source: `packages/db/src/migrations/0268_issues_company_scoped_trigram_search_indexes.sql`,
`packages/db/src/client.ts` (`readInheritedTimeoutSettings`), `lib/db-retry.ts`.
Tracking issue: [PEN-3596](/PEN/issues/PEN-3596). Owner: Platform/SRE.

Trigger: you are approving the deploy that applies migration 0268, **or** issue
writes started returning `503 transient_db_conflict` in a burst that lines up
with a migration window.

Read 0268's own `⚠️ DEPLOY NOTE` first — it carries the measurement (plain
`CREATE INDEX`, not `CONCURRENTLY`; SHARE lock on `issues`; ~30-90s expected
against production) and the hand-run `CONCURRENTLY` opt-out that makes the
migration a no-op. This runbook adds the two things that note does not say, and
that could not be added to it: 0268 is already on `master`, and its bytes are
frozen by `check-migration-immutability` because every migrated database
recorded the sha256 of the original content.

## 1. Callers see errors, not just latency

The deploy note says the build "will stall issue writes". That understates it on
the timeout settings we believe are in force.

Blocked writers are bounded by the role's `lock_timeout`, which the pool does
**not** override — `client.ts` sets only `idle_in_transaction_session_timeout`
in its startup packet, so `statement_timeout` and `lock_timeout` are inherited
as the role has them. That role value is hand-applied prose (`ALTER ROLE
paperclip SET lock_timeout = '15000'`, transcribed in `client.ts` from
`Blockcast/onprem-k8s`, unverified by any manifest — tracked by PEN-3598), so
both readings have to be stated:

- **`lock_timeout = 15s`** (what we believe is in force): a writer that waits
  15s aborts with `55P03`. That sqlstate is in `TRANSIENT_DB_SQLSTATES`, so
  `lib/db-retry.ts` retries it — 4 attempts by default, each of which blocks and
  aborts again while the build still holds the lock. Across a 30-90s build the
  retries are exhausted and callers get `503 transient_db_conflict` on **retried**
  issue writes for the remainder of the build. That outcome is specific to write
  paths wrapped in `withDbRetry`/`isTransientDbError`; a write path outside that
  wrapper still aborts on `55P03`, it just surfaces however its own caller
  handles the raw error.
- **`lock_timeout` disabled (`0`)**: writers simply queue for the build duration
  and then proceed — latency, no errors.

Read the live value with `readInheritedTimeoutSettings` (`client.ts`) before
approving if it matters; do not assume the 15s from this file. Either way the
`CONCURRENTLY` opt-out in 0268 avoids the question entirely, and on the 15s
reading it is the recommended path for a business-hours deploy.

Note this is a *different* bound from the one in
`migration-lock-contention.test.ts`: that covers the migration session's own
3s `lock_timeout` override, i.e. the migration waiting on someone else. This
section is about everyone else waiting on the migration.

## 2. "Nothing fails closed" is about the indexes, not about the file

0268 closes with: *"The query change is independently correct and ships either
way: without these indexes it is still ~1.6x, with them ~4.3x. Nothing fails
closed if they are absent."* That is a statement about the **indexes** being
absent — an operator who takes the opt-out and builds only some of them by hand
degrades performance and nothing else.

It is not a statement about the **file**. `CREATE EXTENSION IF NOT EXISTS
btree_gin` needs database-level `CREATE` on the migration role. `btree_gin` is a
trusted extension (PG13+), so this is the same privilege `pg_trgm` already
needed in migration 0051 and is expected to hold — but if it does not, that
statement RAISES and fails the rollout rather than degrading. The hand-run
opt-out has the same first line and the same requirement.

## If writes are already failing

1. Confirm the window matches a migration, not ordinary contention: a statement
   cancelled by `statement_timeout` is sqlstate `57014` and now surfaces as
   `503 statement_timeout`, *not* `transient_db_conflict` (PEN-3596). A burst of
   `transient_db_conflict` carrying `55P03` is lock contention and is consistent
   with this build.
2. Do not cancel the migration mid-build unless you have decided to take the
   opt-out — a cancelled transactional `CREATE INDEX` rolls back, and the next
   deploy preflight runs it again from zero.
3. It is self-limiting: the lock releases when the build commits. Expect
   recovery within the 30-90s window.
