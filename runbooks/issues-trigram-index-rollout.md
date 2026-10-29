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

## 3. Verify the rollout actually landed

⚠️ **A green deploy run is not evidence the fix is live.** On 2026-10-29 a
dispatch fired at 07:27Z, master took the query fix at 07:35Z, and the pods
rolled at ~07:40Z — *after* the merge — carrying an image built from the
pre-merge commit. Every signal short of the running code said "deployed".

One request settles it, with no pg-log access and no psql seat. Issue the call
this fix is about and read the **`code`** field of the response:

```
GET /api/companies/{companyId}/issues?q=statement&limit=15
```

| Response | Meaning |
|---|---|
| **200**, promptly | Query fix is live and working. |
| **503** `code: "statement_timeout"` (`57014`) | Relabelling is live, so the code **is** post-PEN-3596 — but the query is still over the bound. This is the informative failure: the shape change did not deliver at production row counts. Escalate on PEN-3596 rather than re-deploying. |
| **503** `code: "transient_db_conflict"` (`57014`) | **Not deployed.** The node is running pre-PEN-3596 code. Nothing about the fix has been tested yet. |

The discriminator is `error-handler.ts` (`isStatementTimeout`), which branches
`57014` away from the contention wording. That branch (`f3bacbe`) is the
**direct parent** of the query fix (`4db591b3`) — adjacent commits from the same
PR (#3084), so they enter `master` as one unit and no deployable head carries
one without the other. That adjacency is what lets the `code` field double as a
deploy detector; re-check it with `git merge-base --is-ancestor` if either is
ever back-ported or reverted separately.

Pick a search term with broad matches; the cost is term-dependent, so repeated
sampling with one narrow term reads green either way (`q=timeout` measured 2.9s
where `q=statement` measured 25.7s on the same database).

**Expect timeouts to continue regardless.** 45 of 69 production statement
timeouts measured over 19h are *not* this query shape — they are
[PEN-5019](/PEN/issues/PEN-5019), and they will not collapse when this rolls. A
`canceling statement due to statement timeout` grep is the wrong instrument for
judging this fix; the call above is the right one.

## If writes are already failing

1. Confirm the window matches a migration, not ordinary contention. **Read the
   `code` field, then the `sqlstate`, and mind which build you are on** — the
   relabelling and this migration ship in the *same* deploy, so during the
   rollout window the pair is genuinely ambiguous unless you check both:

   | `code` | `sqlstate` | Reading |
   |---|---|---|
   | `transient_db_conflict` | `55P03` | Lock contention — **consistent with this build.** |
   | `statement_timeout` | `57014` | Query cost, not a lock. Not this build. |
   | `transient_db_conflict` | `57014` | A statement timeout on a node still running **pre-PEN-3596 code** — the relabelling has not rolled here. Not this build either; see §3. |

   The last row is not hypothetical: it is what production returned on
   2026-10-29T17:12Z, hours after the fix merged to `master`. Do not read an
   absent `statement_timeout` code as "no statement timeouts happened".
2. Do not cancel the migration mid-build unless you have decided to take the
   opt-out — a cancelled transactional `CREATE INDEX` rolls back, and the next
   deploy preflight runs it again from zero.
3. It is self-limiting: the lock releases when the build commits. Expect
   recovery within the 30-90s window.
