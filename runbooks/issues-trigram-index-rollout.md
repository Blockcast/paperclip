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
- **`lock_timeout` disabled (`0`)**: writers queue for the build duration —
  **but "latency, no errors" only holds while the build stays under the role's
  30s `statement_timeout`.** `statement_timeout` counts time spent waiting on a
  lock, so on a build at the long end of the 30-90s estimate a queued writer
  reaches it first and aborts with `57014`, *caused by this migration*. Under
  this reading 0268's "will stall issue writes" means **abort**, not merely
  wait. This bullet asserted the opposite until PEN-3596 corrected it.

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

**Run the deployed-commit read first — it is the only direct answer:**

```
kubectl -n paperclip get deploy paperclip-api \
  -o jsonpath='{.spec.template.metadata.annotations.paperclip\.blockcast\.net/deployed-commit}'
git merge-base --is-ancestor f3bacbe  <deployed-sha> && echo "relabelling live"
git merge-base --is-ancestor 4db591b3 <deployed-sha> && echo "query fix live"
```

(`paperclip_api_deploy_info{deployed_commit=…}` carries the same value, gated on
`paperclip_api_deploy_drift_stale == 0`.)

The request below is the **behavioural** check — it tells you whether the fix is
*working*, which the SHA cannot. Issue it **once**; on pre-fix code it costs
~26s and holds a pool connection on production for that whole time, so do not
loop it.

```
curl -w '\n%{time_total}s\n' '…/api/companies/{companyId}/issues?q=statement&limit=15'
```

⚠️ **Time it. The `code` field alone is not sufficient, and a 200 is not a pass.**

| Response | Latency | Reading |
|---|---|---|
| **200** | sub-second | Query fix **and** 0268's indexes are live and working (~100 ms on the 54k-row seed). |
| **200** | seconds to ~30s | ⚠️ **INDETERMINATE — not a pass.** Either pre-fix code, or the fix running *without* 0268's indexes. Fall back to the deployed-commit read. |
| **503** `code: "statement_timeout"` | ~30s | Post-PEN-3596 code, and the query is still over the bound — the shape change did not deliver at production row counts. Escalate on PEN-3596 rather than re-deploying. (During a 0268 build under `lock_timeout = 0`, see §1 — it may be lock wait, not query cost.) |
| **503** `code: "transient_db_conflict"` | ~30s | **Pre-PEN-3596 code.** Nothing about the fix has been tested yet. |

⛔ **Why a slow 200 is the trap.** #3084 measured `q=statement` on pre-fix code
at **25.7s / 28.9s** — *both under* the 30s `statement_timeout`. So pre-fix code
most often returns a slow **200**, not the 503 in the last row; the 503 only
appears when the run lands the wrong side of the bound. And the query fix
*without* the indexes is only ~1.6x (0268's own note), which is still a
multi-second 200. Latency, not status, is what separates those from a working
deploy — which is why the only unambiguous rows here are the two 503s, and why
the SHA read above comes first.

Term choice matters for the same reason: the cost is search-term dependent
(`q=timeout` measured 2.9s where `q=statement` measured 25.7s on the same
database), so a narrow term returns a fast 200 on pre-fix code and reads as a
pass. Use `q=statement`.

The `code` discriminator is `error-handler.ts` (`isStatementTimeout`), which
branches `57014` away from the contention wording. That branch (`f3bacbe`) is
the **direct parent** of the query fix (`4db591b3`) — adjacent commits from the
same PR (#3084), rebase-merged so `master` moved to `4db591b3` in one ref
update and no `master` tip ever pointed at `f3bacbe` alone. That adjacency is
what lets the two 503 rows read as a deploy detector; the `merge-base` pair
above re-checks it directly, and is the check to run if either commit is ever
back-ported or reverted separately.

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
   | `statement_timeout` | `57014` | Post-PEN-3596 code. Usually query cost, **but see the caveat below** — it can be this build. |
   | `transient_db_conflict` | `57014` | A statement timeout on a node still running **pre-PEN-3596 code** — the relabelling has not rolled here. Same caveat. |

   ⚠️ **`57014` does NOT rule out this migration.** It does so only when
   `lock_timeout` is in force *and* below `statement_timeout` — the 15s reading
   above, where a blocked writer aborts on `55P03` first. Under `lock_timeout =
   0` with a build at the long end of 30-90s, a writer queued behind the SHARE
   lock reaches the 30s `statement_timeout` while waiting and `57014` is
   *exactly* what this build produces. Resolve it by reading the live
   `lock_timeout` (`readInheritedTimeoutSettings`), not by the sqlstate.

   The third row is not hypothetical: it is what production returned on
   2026-10-29T17:12Z, hours after the fix merged to `master`. Do not read an
   absent `statement_timeout` code as "no statement timeouts happened".
2. Do not cancel the migration mid-build unless you have decided to take the
   opt-out — a cancelled transactional `CREATE INDEX` rolls back, and the next
   deploy preflight runs it again from zero.
3. It is self-limiting: the lock releases when the build commits. Expect
   recovery within the 30-90s window.
