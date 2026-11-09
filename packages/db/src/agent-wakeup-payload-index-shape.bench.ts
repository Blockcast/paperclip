/**
 * PEN-6104 done-when 3: which index shape should serve the four-arm
 * `issueId`/`taskId` disjunction over `agent_wakeup_requests.payload`?
 *
 * `payload` carries no index of any kind, so this predicate --
 *
 *   payload ->> 'issueId' = $1  or  payload ->> 'taskId' = $1
 *   or payload -> '_paperclipWakeContext' ->> 'issueId' = $1
 *   or payload -> '_paperclipWakeContext' ->> 'taskId' = $1
 *
 * -- is a per-row recheck over whatever `agent_wakeup_requests_company_requested_idx`
 * returns. Five call sites read that MEMBERSHIP shape: `services/issues.ts`
 * (`wakeRequestTargetsIssue`), `services/heartbeat.ts`,
 * `services/recovery/service.ts`, and `services/task-watchdogs.ts` TWICE --
 * its subtree scan and its per-issue live-wake probe are separate sites.
 *
 *   ⛔ `services/successful-run-handoff-state.ts` IS NOT ONE OF THEM, and the
 *      first revision of this header said it was. That site, and `issues.ts`'s
 *      blocked-inbox and subtree reads, are `coalesce(...)` ATTRIBUTION --
 *      "which single issue does this wake belong to" -- which is a DIFFERENT
 *      question from MEMBERSHIP, "does this wake target issue X". They are not
 *      interchangeable and the divergence is measured, not asserted: a wake
 *      whose `_paperclipWakeContext.issueId` names a different issue from its
 *      top-level `issueId` is a MEMBER of both and ATTRIBUTED to only the
 *      first (`agent-wakeup-payload-target-semantics.test.ts`). Rewriting an
 *      attribution `coalesce` into this disjunction changes behaviour. The
 *      two expressions read alike at a glance, which is the whole reason this
 *      warning is here rather than left to the reader.
 *
 * ⚠️ WHAT THIS IS AND IS NOT -- identical in kind to
 * `issues-list-production-scale-plan-shape.bench.ts`, and for the same reason:
 * no engineering seat holds a production SQL path, so a production
 * `EXPLAIN (ANALYZE)` cannot be taken here. This is evidence about PLAN SHAPE
 * and about the RELATIVE cost of the candidate objects at a known row count.
 *
 *   ⛔ SEEDED STATISTICS AND BLOAT ARE NOT PRODUCTION'S. Do not quote the
 *      milliseconds below as production latency.
 *
 * ⚠️ THE SEED COUNT IS A STIPULATION, AND THE FIGURE PEN-6104 WAS OPENED WITH
 * IS NOT A MEASUREMENT. That row cites "~13.2M estimated rows" from
 * `table-size-estimates.ts`. That number is `52,791 local rows x a flat
 * TABLE_SIZE_ESTIMATE_FACTOR of 250`, and the factor is uncalibrated. Measured
 * against the four tables for which a production count is readable from
 * `pg_paperclip_table_mvcc_n_live_tup` (2026-11-08):
 *
 *   heartbeat_runs ..... 3,620 local -> 673,855 prod ... factor  186
 *   issues ............. 1,609 local ->  60,225 prod ... factor   37
 *   environment_leases . 3,492 local ->  10,076 prod ... factor  2.9
 *   issue_comments ..... 5,034 local ->  12,444 prod ... factor  2.5
 *
 * The real factor spans 2.5-186, so 250 is outside the observed range at both
 * ends and "13.2M" is not evidence of anything.
 *
 * ⭐ THE REAL COUNT HAS SINCE LANDED, AND THE 2,000,000 DEFAULT IS 14.3x TOO
 * LARGE. When this file was first written `agent_wakeup_requests` was not one
 * of the six tables `pg_paperclip_table_mvcc_n_live_tup` published, so its
 * production count was unreadable from any engineering seat and 2,000,000 was
 * stipulated as a defensible point inside the `large` bucket. PEN-6165 /
 * `onprem-k8s#8416` added the seventh relname on 2026-11-08T20:55Z and the
 * table measures 136,686 -> 139,789 live rows across four readings that
 * evening -- a local->production factor of 2.6x, at the BOTTOM of the
 * calibrated span, beside `issue_comments` (2.5) and `environment_leases`
 * (2.9). Quote that as a FLOOR, not a census: `n_live_tup` is re-based only at
 * VACUUM/ANALYZE, and the table's dead tuples peak at 1.20x live between
 * autovacuums (trigger = 50 + 0.2 x live, an 11.4 h sawtooth).
 *
 * Everything reported here is either a per-row cost or a ratio, so it carries
 * to another count -- except PLAN CHOICE, which is genuinely scale-sensitive.
 * That exception is the whole reason the re-run below exists: it is the one
 * claim the 2M table could not make about a 140k table, and it had to be
 * measured rather than argued.
 *
 * Run it (NOT a vitest file -- `.bench.ts` is outside the test glob, so CI does
 * not run it; ~10 minutes and several GB of disk):
 *
 *   cd packages/db && pnpm tsx src/agent-wakeup-payload-index-shape.bench.ts
 *
 * ── MEASURED 2026-11-08, by running THIS FILE at its defaults ─────────────
 * ⛔ SUPERSEDED IN PART. This table was taken BEFORE the write probe's
 * `VACUUM` (see `writeProbe` below) and at the 14.3x-oversized stipulation, so
 * each candidate's `EXPLAIN` ran over a different amount of dead-tuple bloat.
 * It is kept because it is the table every prior record quotes. The 2026-11-09
 * re-runs below re-take it: at constant scale every figure here survives to
 * within ~15%, which is this harness's noise floor -- the only large mover is
 * C4's dense, and that is plan INSTABILITY rather than a corrected figure
 * (finding 7). Read both; do not treat either as the more honest one.
 * Embedded Postgres 18.1 (production is 18.4), harness defaults, no parallel
 * workers. 2,000,000 rows / 20 companies / 20,000 issues / 90-day spread.
 * Target company's 14-day window (the route's `lookbackDays`): 158,657 rows.
 * Heap 627 MB. DENSE probe issue = 2,664 wakes; SPARSE probe issue = 6 wakes.
 *
 *   shape                                    new idx   SPARSE    DENSE   build
 *   ────────────────────────────────────────────────────────────────────────────
 *   shipped baseline (no payload index)           --  237.6ms    5.4ms      --
 *   C1  GIN jsonb_path_ops + `@>`             151 MB    0.4ms  226.2ms   28.0s
 *   C1b gin(company_id, payload …) btree_gin  155 MB    6.0ms   38.3ms   34.1s
 *   C2  4 partial btrees, query UNCHANGED     124 MB  253.8ms    5.5ms    6.1s
 *   C2b 4 partial btrees, query GUARDED       124 MB    0.2ms   13.2ms       "
 *   C3  generated scalar col + btree       74MB+42MB    0.1ms    0.3ms   86.7s
 *   C4  generated text[] col + GIN         14MB+168MB   3.1ms  107.9ms   79.3s
 *
 * ⚠️ THE WRITE PROBE IS NOT RELIABLE UNDER THE HARNESS DEFAULTS and its numbers
 * are deliberately omitted from the table above. The harness leaves `fsync` and
 * `full_page_writes` on, so a 100k-row insert is checkpoint-dominated and the
 * result is not monotonic in the amount of index maintenance: this run measured
 * C2 (four extra indexes) at 8,962 rows/s against a BASELINE of 7,309, which is
 * impossible and is the tell. `fsync` and `full_page_writes` are postmaster
 * settings, so this file cannot fix it from a session.
 *
 * The write ordering below is therefore from a SEPARATE run of the same SQL at
 * the same 2M scale on a cluster started with `fsync=off`,
 * `synchronous_commit=off`, `full_page_writes=off`, `autovacuum=off`,
 * `shared_buffers=128MB`. ⛔ These are RATIOS against their own baseline, not
 * throughput anyone should quote:
 *
 *   baseline 19,168 rows/s · C3 15,006 (-22%) · C1b 12,577 (-34%)
 *   C2/C2b 12,441 (-35%) · C4 11,799 (-38%) · C1 10,563 (-45%)
 *
 * ⭐ 1 · THE `LIMIT` REALLY DOES NOT BOUND THE BASELINE, and the gap is 42x
 * BETWEEN TWO ROWS OF THE SAME TABLE. The dense probe stops after 3,086
 * rejected rows (5.4 ms); the sparse probe is answered only after rejecting
 * 158,651 -- the ENTIRE company window -- for 6 result rows, at 237.6 ms. The sparse cost grows with the window; the dense cost
 * does not. Every row an operator is most likely investigating is sparse.
 *
 * ⛔ 2 · CANDIDATE 1 (GIN) IS DISQUALIFIED BY THE DENSE CASE, NOT BY ITS SIZE.
 * PEN-6104 flagged GIN as a sizing risk (151 MB here, ~24% of heap -- real but
 * survivable). The actual disqualifier is that it makes the COMMON path 42x
 * WORSE: 226.2 ms vs the baseline's 5.4 ms. A GIN index carries neither
 * `company_id` nor `requested_at`, so the BitmapOr matches across every company
 * and all 90 days (14,285 + 2,857 + … entries), and both cheap selective
 * predicates degrade to a post-heap Filter -- 14,478 rows removed, 17,142 heap
 * blocks. Worse, GIN cannot deliver `requested_at DESC`, so the `LIMIT` can no
 * longer stop early: every match is materialised and top-N sorted.
 *
 * ⚠️ C1b, the steel-man, fixes only the first half. Adding `company_id` via
 * `btree_gin` does move the company predicate into the index cond (rows removed
 * drops 14,478 -> 3,086) and the dense probe improves to 38.3 ms -- but that is
 * still 7x the baseline, because nothing can give a GIN index the
 * `requested_at DESC` ordering the `LIMIT` needs. It also costs the most disk
 * (155 MB) of any candidate. ⚠️ C1b's dense figure is the least stable number
 * in this file: a second run at the same scale measured 368.5 ms with the
 * company predicate NOT reaching the index. Treat "worse than baseline, by a
 * margin that depends on statistics" as the finding, not the specific ms.
 * The reachability half is the same mechanism
 * `issues-list-production-scale-plan-shape.bench.ts` measured for the un-scoped
 * trigram index (its A2): the lesson is not "BitmapAnd", it is "a predicate the
 * index does not carry cannot reach it".
 *
 * ⛔ 3 · CANDIDATE 2 AS PEN-6104 DESCRIBES IT DOES NOT WORK AT ALL. The four
 * partial indexes are built, are 124 MB, cost 35% of insert throughput -- and
 * the planner never uses them: 291.3 ms on the sparse probe, 158,651 rows
 * removed, i.e. the baseline plan unchanged. A partial index is only usable
 * when the planner can PROVE the query implies its predicate, and
 * `payload ->> 'issueId' = $1` does not imply `payload ? 'issueId'`.
 *
 * ⭐ C2b is the same four indexes with each arm rewritten to carry its own
 * guard:
 *
 *   (payload ? 'issueId' and payload ->> 'issueId' = $1) or …
 *
 * which is logically equivalent (a non-NULL `->>` implies the key exists) and
 * collapses the sparse probe to 0.2 ms -- 1,188x. ⚠️ It costs 2.4x on the dense
 * probe (5.4 -> 13.2 ms), because a BitmapOr over four indexes then sorts, where
 * the baseline walked one ordered index and stopped at 51. That trade is the
 * point: it removes a cost that scales with the window in exchange for a
 * constant factor on a path that is already fast.
 *
 * ⭐⭐ 4 · CANDIDATE 3's SILENT DROP IS REAL, AND IT IS MEASURED HERE, NOT
 * ASSERTED. One row whose `_paperclipWakeContext.issueId` names a DIFFERENT
 * issue than its top-level `issueId`, queried for the nested issue:
 *
 *   four-arm disjunction finds ....... 1
 *   coalesce(...) finds .............. 0   <- `services/issues.ts` blocked-inbox
 *   C3 generated scalar column finds . 0   <- same coalesce, now persisted
 *   C4 generated text[] column finds . 1
 *
 * `coalesce` returns the FIRST non-null key, so it models "which single issue
 * does this row belong to" (attribution). The disjunction models "does this row
 * target issue X" (membership). They are different questions and the in-tree
 * uses are each correct for their own question -- but a generated column
 * defined by `coalesce` cannot serve the membership query, which is what
 * PEN-6104's candidate 3 proposed to do.
 *
 * ⭐ C4 is the shape that models membership exactly without giving up the
 * single cheap object: the disjunction is a SET test, so the column is an
 * ARRAY, not a scalar. At 14 MB it is the SMALLEST index measured -- 11x
 * smaller than the GIN on `payload` -- because it indexes four short texts
 * instead of every root-to-leaf path in the document. ⚠️ But it inherits GIN's
 * ordering loss and costs 168 MB of heap for the stored array,
 * so it is only the right answer if the rewrite in 5 is acceptable AND the
 * dense path is not. ⛔ An earlier revision priced that ordering loss at
 * "dense 107.9 ms". Do not quote it, and do not quote Run A's 4.44 ms either:
 * finding 7 shows C4's dense case flips between the GIN plan and the baseline's
 * own `&&`-filter plan between runs at nominally identical state, so C4's dense
 * cost is UNSTABLE -- not high, and not low.
 *
 * ⛔ 5 · BOTH GENERATED-COLUMN SHAPES TAKE AN `ACCESS EXCLUSIVE` TABLE REWRITE,
 * AND IT IS OUTAGE-CLASS AS PEN-6104 PREDICTED: 74.9 s (C3) and 66.8 s (C4) at
 * 2M rows, scaling linearly -- so 7-8 minutes of total table lock at 13M, on the
 * table every heartbeat writes to. `CREATE INDEX CONCURRENTLY` does not help;
 * the lock is taken by `ADD COLUMN ... STORED`, before any index exists. C2b is
 * the only candidate that needs no rewrite at all.
 *
 * ⭐ 6 · RECOMMENDATION: C2b, and it is NOT shipped by this file. It is the only
 * shape that is simultaneously exact, decisive on the pathological case
 * (1,188x here; 1,167x on the clean 2M re-run and 43x at the real row count --
 * findings 7 and 9), and reachable with `CREATE INDEX CONCURRENTLY` alone. Its price is
 * 124 MB, a 35% insert-throughput cost on the fleet's hottest table, and a
 * predicate rewrite at all five call sites.
 *
 * ⛔ THAT PRICE WAS SIZED AGAINST 2M ROWS AND THE REAL COUNT HAS SINCE LANDED,
 * so re-read the price before quoting it. At the measured 140k the same four
 * indexes are 8.8 MB, not 124 MB -- but the RATIO is what the decision rested on
 * and the ratio is unchanged (19.7% of heap at 2M, 20.1% at 140k; finding 10).
 * BLO-52494 dropped 784 MB of `activity_log` indexes specifically for write
 * cost, so a 35% write regression is still a real price -- it is simply now a
 * priced one rather than an unbounded one. ⚠️ What has NOT been measured is the
 * live plan: PEN-6104's done-when 1 production `EXPLAIN (ANALYZE, BUFFERS)` is
 * still the arbiter, and no seeded bench substitutes for it.
 *
 * ── RE-MEASURED 2026-11-09, TWO RUNS, by running THIS FILE ────────────
 * Both with the `writeProbe` `VACUUM (ANALYZE)` in place, same harness, same
 * embedded Postgres 18.1. Run A re-takes the table above at ITS OWN defaults,
 * so the ONLY variable against it is the bloat fix. Run B then changes ONLY the
 * scale, to the production count PEN-6165 published. One variable each, which
 * is what makes the two differences attributable.
 *
 *                        RUN A · 2,000,000 rows     RUN B · 140,000 rows
 *                        window 158,657 / 627 MB    window 11,116 / 43.8 MB
 *   shape                new idx  SPARSE    DENSE   new idx   SPARSE   DENSE
 *   ────────────────────────────────────────────────────────────────
 *   shipped baseline          --  253.3ms   5.19ms       --  11.78ms  4.25ms
 *   C1  GIN + `@>`        151 MB    0.42ms 245.40ms  10.1 MB   1.14ms  3.66ms
 *   C1b btree_gin         155 MB    6.06ms  36.61ms  10.3 MB   2.26ms 12.83ms
 *   C2  partial UNGUARDED 124 MB  221.46ms   6.29ms   8.8 MB  14.22ms  4.21ms
 *   C2b partial GUARDED   124 MB    0.22ms  11.80ms   8.8 MB   0.27ms  1.01ms
 *   C3  scalar col+btree 74+42MB    0.13ms   0.31ms 5.2MB+3MB  0.13ms  0.30ms
 *   C4  text[] col+GIN  14+168MB    3.24ms   4.44ms 0.8MB+12MB 1.52ms  5.75ms
 *
 * ⭐ 7 · THE FIX IS CORRECT AND ITS MEASURED EFFECT IS BELOW THIS HARNESS'S
 * NOISE FLOOR. Run A against the 2026-11-08 table: baseline, C1, C1b, C2, C2b
 * and C3 all land within ~15%. ⚠️ And ~15% IS the noise floor here, which is
 * the honest reading rather than a hedge -- the BASELINE carries ZERO dead
 * tuples in BOTH runs, because its write probe runs FIRST (see `results.baseline`
 * below) before any `DELETE` has happened, and it still moved 237.6 -> 253.3 ms
 * sparse. Nothing the `VACUUM` could have done is larger than that. ✅ C2b's
 * dense regression survives at 2.27x against 2.4x, so PEN-6104's "the 2.4x is an
 * upper bound" annotation was directionally right and quantitatively inside the
 * noise. The fix belongs here on its own reasoning -- an uneven handicap between
 * the candidates being compared is a defect whether or not it moved a number --
 * and NOT because it corrected the record.
 *
 * ⛔ RETRACTED, and this is the part worth reading: an earlier revision of this
 * finding claimed the fix caused C4's dense plan flip (107.9 -> 4.44 ms). IT
 * CANNOT HAVE. C4's `ADD COLUMN ... STORED` rewrite copies only live tuples and
 * rebuilds every index, and `ANALYZE agent_wakeup_requests` runs immediately
 * after it in BOTH runs, so C4's heap, indexes and statistics are identical with
 * or without the `VACUUM`. The `writeProbe` comment below SAYS SO -- it records
 * C4's dead-tuple count as 0 -- three paragraphs from the claim it refutes. The
 * flip is run-to-run plan instability at nominally identical state.
 *
 *   ✅ The operational conclusion is unchanged and is the only thing to carry
 *      forward: C4's dense cost is UNSTABLE between runs, so do not quote it,
 *      in either direction. It is not a cost, it is a coin-flip between the GIN
 *      plan and the baseline's own `&&`-filter plan.
 *
 * ✅ CONFIRMED BY A THIRD RUN, since a structural argument is not a measurement.
 * Same defaults, same `VACUUM`, same machine, nothing changed between them:
 *
 *   C4 dense, run A ...  4.44 ms  Index Scan `..._company_requested_idx`
 *                                 + `&&` Filter, 3,086 rows removed
 *   C4 dense, run C ... 91.83 ms  Bitmap Heap Scan, BitmapAnd of
 *                                 `awr_target_issue_ids_gin` (17,142 entries)
 *                                 and `..._agent_requested_idx`, 0 removed
 *
 * 21x apart, two DIFFERENT PLANS, identical state. C4's dense case is settled as
 * unstable and unquotable.
 *
 * ⚠️ The same run shows C1's dense is unstable too -- 245.4 vs 39.8 ms, again
 * two plans (14,478 vs 3,086 rows removed) -- which matches what this header
 * already says about C1b ("the least stable number in this file", 38.3 vs
 * 368.5 ms at one scale). ⭐ Read that as a property of the FAMILY, not of three
 * unlucky numbers: a GIN arm's selectivity estimate is what the planner is
 * guessing at, and every candidate whose dense figure has moved is a GIN one.
 *
 * ✅ And the control that makes the above mean something: C2b is the MOST stable
 * number in the file. Across the two identical runs its dense moved 11.80 ->
 * 11.27 ms (-4.5%) and its sparse 0.217 -> 0.213 ms (-1.8%), against a BASELINE
 * that moved -12% on sparse. The recommended shape is the one whose figures you
 * can actually rely on, which is a point in its favour that no single run could
 * have made.
 *
 * ⭐⭐⭐ THE GENERATOR, since the error is more instructive than the number:
 * THE AUTHOR OF A CORRECTION IS THE WORST-PLACED PERSON TO ATTRIBUTE WHAT IT
 * CHANGED. I had the right mechanism -- bloat is uneven BETWEEN candidates --
 * and reached for it to explain the biggest figure that moved, which happened to
 * be the one candidate the mechanism provably cannot reach. Every small mover
 * was consistent with the story, so the story felt confirmed six times over
 * before it was tested once. ⚠️ And note the shape of the refutation: the
 * disproof was ALREADY WRITTEN, by me, in this same diff. A claim is not checked
 * by re-reading the paragraph that makes it. (Found by Ally in review of this
 * change; the attribution was mine.)
 *
 * ⭐ 8 · THE WRITE PROBE'S ORDERING IS NOW MONOTONE, AND THE FIX IS NOT WHY.
 * The 2026-11-08 run measured C2 -- four EXTRA indexes -- at 8,962 rows/s
 * against a BASELINE of 7,309, and this header called that "the tell". In Run A
 * the baseline is the fastest candidate, as it must be:
 *
 *   baseline 16,912 rows/s · C2/C2b 10,973 (-35%) · C1b 10,037 (-41%)
 *   C1 8,784 (-48%) · C4 3,459 (-80%) · C3 3,292 (-81%)
 *
 * ⛔ But the baseline's probe runs FIRST, before any `DELETE` or `VACUUM` has
 * executed, so the fix cannot touch it -- and the baseline moved 7,309 ->
 * 16,912, a 2.3x jump that is most of why the ordering is now monotone. That is
 * the checkpoint/`fsync` variance this header already describes above, not the
 * bloat. ⚠️ Which also means the two runs' write figures are NOT comparable to
 * each other at all: they were taken on different machines, and the one number
 * guaranteed to be bloat-free moved more than anything the bloat could explain.
 * (Ally's suggestion on this change.)
 *
 * ⚠️ The magnitudes remain unquotable for the reason given above -- `fsync` and
 * `full_page_writes` stay on and the run is checkpoint-dominated, and C3/C4
 * additionally pay for a heap their `ADD COLUMN` rewrite has just grown.
 * C2/C2b's -35% from the separate `fsync=off` run above is unchanged and is
 * still the figure to use; it agrees with Run A's -35% by coincidence, not by
 * corroboration.
 *
 * ⭐ 9 · AT THE REAL ROW COUNT C2b's PLAN SURVIVES AND ITS DENSE REGRESSION
 * INVERTS. This is the one claim the 2M table could not make, since plan choice
 * is its single scale-sensitive output, and it is now measured. Run B's C2b plan
 * is a `BitmapOr` across all four partial indexes with `company_id` AND the
 * `requested_at` bound inside every `Index Cond`, and `Rows Removed by Filter`
 * is 0 on both probes. Sparse 11.78 -> 0.27 ms (43x). Dense 4.25 -> 1.01 ms,
 * i.e. **4.2x BETTER, where the same shape at 2M is 2.27x WORSE.**
 *
 *   Mechanism, because the inversion is not luck: C2b NEVER gets the index
 *   ordering, at either scale -- its plan is a Bitmap Heap Scan plus a top-N
 *   sort both times. Its dense cost is therefore set by HOW MANY ROWS THE PROBE
 *   ISSUE HAS IN THE WINDOW (2,664 at 2M, 186 at 140k), not by the table size.
 *   At 186 the sort is free; at 2,664 the baseline's early-stopping ordered
 *   index scan wins instead.
 *
 * ⛔ WHICH IS WHY RUN B DOES NOT SETTLE THE DENSE CASE. The two axes this file
 * scales TOGETHER -- window size and per-issue density -- are INDEPENDENT in
 * production, and the sparse and dense verdicts hang off different ones.
 * Production's per-issue wake distribution is UNMEASURED: the 2,664/6 pair is
 * THIS SEED's and was never an observation, so do not cite it as production's.
 * Production's window is ~11k rows, which Run B matches; its hottest issue could
 * hold 186 wakes or 2,664, and the dense verdict flips between them.
 *
 *   ✅ What Run B DOES settle at the real size: the sparse win (43x), the
 *      plan's reachability, and the disk ratio below. The missing measurement is
 *      a per-issue wake-count histogram for the live table, and the
 *      `EXPLAIN (ANALYZE, BUFFERS)` probe on PR #3571 is the cheapest
 *      instrument that can take it.
 *
 * ⭐ 10 · THE ~20%-OF-HEAP PRICE HOLDS AT BOTH SCALES, which is the number the
 * capacity decision rested on. Four partial btrees: 61.1 + 13.2 + 24.8 + 24.8 =
 * 123.9 MB on a 627.3 MB heap = **19.7%** (Run A); 4.3 + 0.9 + 1.8 + 1.8 =
 * 8.8 MB on a 43.8 MB heap = **20.1%** (Run B). A ratio measured at a stipulated
 * scale was the thing that had to carry to the real one, and it does -- to
 * within 0.4 points across a 14.3x change in table size.
 *
 *
 */
import postgres from "postgres";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

const TARGET_COMPANY = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANIES = 19;

/**
 * Scale knobs. The defaults are what every header number EXCEPT Run B's column
 * was taken at. ⛔ A result taken at one scale is not comparable to a result
 * taken at another: plan CHOICE is scale-dependent even where per-row cost is
 * not -- which is exactly why Run B exists, and why it is reported as its own
 * column rather than folded into Run A's.
 *
 * ✅ Run B's invocation, so its column is reproducible from this file alone:
 *
 *   cd packages/db && PEN6104_ROWS=140000 \
 *     pnpm tsx src/agent-wakeup-payload-index-shape.bench.ts
 *
 * ✅ Two of the three knobs are CONFIRMED by the recorded figures rather than
 * merely asserted. The window falls 158,657 -> 11,116 (14.3x), which fixes
 * `PEN6104_ROWS` at 140,000; and the dense probe issue's wake count falls
 * 2,664 -> 186 by the SAME 14.3x, which it could not do had `PEN6104_ISSUES`
 * scaled too -- per-issue density is `ROWS/ISSUES`, so a proportional `ISSUES`
 * would have left it flat. `PEN6104_ISSUES` was therefore at its 20,000
 * default.
 *
 * ⚠️ `PEN6104_WRITE_ROWS` is NOT confirmed that way, and the distinction is
 * the point rather than a quibble: no figure recorded for Run B is a function
 * of it, because no Run B write-throughput number was kept (finding 8 quotes
 * none). That it sat at its 100,000 default rests on the run's own record of
 * changing only the scale -- an author's report, not a derivation. Treat it as
 * such.
 *
 * ⚠️ If it did sit at 100,000, that is ~5% of Run A's table and ~71% of Run
 * B's -- a real asymmetry between the two columns, corrected nowhere. It does
 * not reach the EXPLAIN figures, which are taken after the probe's
 * `VACUUM (ANALYZE)` (see `writeProbe`), but it would make any Run B write
 * figure incomparable to Run A's, which is the second reason none is quoted.
 */
const scale = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};
const TOTAL = scale("PEN6104_ROWS", 2_000_000);
const ISSUES = scale("PEN6104_ISSUES", 20_000);
const WRITE_ROWS = scale("PEN6104_WRITE_ROWS", 100_000);
/** `ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS` / `..._MAX_WAKE_REQUESTS + 1`. */
const WINDOW_DAYS = 14;
const LIMIT = 51;
const SPREAD_DAYS = 90;

const issueUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agentUuid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const mb = (b: unknown) => `${(Number(b) / 1048576).toFixed(1)} MB`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log(...a);

async function timed(sql: postgres.Sql, label: string, statement: string) {
  const started = Date.now();
  await sql.unsafe(statement);
  const ms = Date.now() - started;
  log(`    ${label}: ${sec(ms)}`);
  return ms;
}

async function indexBytes(sql: postgres.Sql, name: string) {
  const rows = await sql.unsafe(`SELECT pg_relation_size('${name}') AS b`);
  return Number((rows as unknown as { b: string }[])[0].b);
}

async function heapBytes(sql: postgres.Sql) {
  const rows = await sql.unsafe(`SELECT pg_relation_size('agent_wakeup_requests') AS b`);
  return Number((rows as unknown as { b: string }[])[0].b);
}

/**
 * ⚠️ The seed's payload-kind axis is `(g / 7) % 100` and its company axis is
 * `g % 100`. Keying both on `g % 100` makes the target company a strict SUBSET
 * of the agent-scoped rows, so it ends up holding no issue-bearing payload at
 * all and every probe below returns nothing -- which is how this seed was first
 * written and what the decorrelation exists to prevent.
 */
async function seed(sql: postgres.Sql) {
  log(`seeding ${TOTAL.toLocaleString()} rows …`);
  await sql.unsafe(`SET maintenance_work_mem = '512MB'`);
  await sql.unsafe(`SET session_replication_role = replica`);

  const started = Date.now();
  const BATCH = 250_000;
  for (let from = 1; from <= TOTAL; from += BATCH) {
    const to = Math.min(from + BATCH - 1, TOTAL);
    await sql.unsafe(`
      INSERT INTO agent_wakeup_requests
        (company_id, agent_id, source, trigger_detail, reason, payload, status, requested_at, created_at, updated_at)
      SELECT
        d.company_id,
        ('11111111-1111-4111-8111-' || lpad((g % 40)::text, 12, '0'))::uuid,
        CASE WHEN k < 55 THEN 'timer' ELSE 'issue' END,
        'system',
        CASE WHEN k < 55 THEN 'heartbeat_tick' ELSE 'issue_commented' END,
        CASE
          -- 55%: agent-scoped. No issueId / taskId / _paperclipWakeContext at
          -- all -- the timer and circuit-breaker families that routes/issues.ts
          -- documents as unreachable from this route.
          WHEN k < 55 THEN
            jsonb_build_object('source','timer','agentTick', g, 'scheduledFor', to_char(ts, 'YYYY-MM-DD'))
          -- 8%: legacy shape, top-level taskId and no issueId. This is what
          -- disjunction arm 2 exists for; without it that arm is dead and its
          -- index measures as empty.
          WHEN k < 63 THEN
            jsonb_build_object(
              'taskId', iss, 'wakeReason','issue_commented',
              'taskKey', 'issue:' || h, 'commentId', gen_random_uuid())
          -- 22%: top-level issueId only.
          WHEN k < 85 THEN
            jsonb_build_object(
              'issueId', iss, 'wakeReason','issue_commented',
              'taskKey', 'issue:' || h, 'commentId', gen_random_uuid())
          -- 15%: the deferred shape written by heartbeat.ts -- top-level
          -- issueId PLUS the nested _paperclipWakeContext snapshot.
          ELSE
            jsonb_build_object(
              'issueId', iss, 'wakeReason','issue_execution_deferred',
              '_paperclipWakeContext', jsonb_build_object(
                 'issueId', iss, 'taskId', iss, 'taskKey', 'issue:' || h,
                 'projectId', gen_random_uuid(), 'wakeReason','issue_execution_deferred',
                 'resumeFromRunId', gen_random_uuid(),
                 'retryOfRunId', NULL, 'scheduledRetryAttempt', NULL))
        END,
        CASE WHEN k >= 85 THEN 'deferred_issue_execution' ELSE 'completed' END,
        ts, ts, ts
      FROM generate_series(${from}, ${to}) AS g,
           LATERAL (SELECT
              ((g / 7) % 100) AS k,
              -- 1 row in 50 names the HOT issue (#1), so the seed carries the
              -- dense/sparse skew production has rather than a flat spread.
              (CASE WHEN g % 50 = 0 THEN 1 ELSE (g % ${ISSUES}) + 1 END) AS h,
              now() - (((g::bigint * ${SPREAD_DAYS} * 86400) / ${TOTAL}) || ' seconds')::interval AS ts
           ) AS p,
           LATERAL (SELECT
              ('00000000-0000-4000-8000-' || lpad(h::text, 12, '0')) AS iss,
              -- An issue belongs to exactly ONE company; agent-scoped rows split
              -- on g so the target company keeps its ~50% share of the table.
              (CASE WHEN k < 55
                    THEN (CASE WHEN g % 100 < 50 THEN '${TARGET_COMPANY}'
                               ELSE '33333333-3333-4333-8333-3333333' || lpad((g % ${OTHER_COMPANIES})::text, 5, '0') END)
                    ELSE (CASE WHEN h % 2 = 1 THEN '${TARGET_COMPANY}'
                               ELSE '33333333-3333-4333-8333-3333333' || lpad((h % ${OTHER_COMPANIES})::text, 5, '0') END)
               END)::uuid AS company_id
           ) AS d`);
    process.stdout.write(`  ${to.toLocaleString()} …\r`);
  }
  log(`\n  inserted in ${sec(Date.now() - started)}`);
  await timed(sql, "ANALYZE", "ANALYZE agent_wakeup_requests");
}

const DISJUNCTION = `
  company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days' AND (
      payload ->> 'issueId' = $2
   or payload ->> 'taskId' = $2
   or payload -> '_paperclipWakeContext' ->> 'issueId' = $2
   or payload -> '_paperclipWakeContext' ->> 'taskId' = $2)`;

/**
 * C2b. Logically identical to {@link DISJUNCTION} -- a non-NULL `->>` implies
 * the key exists -- but each arm now states the partial index's own predicate,
 * which is the only way the planner can prove the index applies.
 */
const GUARDED = `
  company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days' AND (
      (payload ? 'issueId' and payload ->> 'issueId' = $2)
   or (payload ? 'taskId'  and payload ->> 'taskId' = $2)
   or (payload -> '_paperclipWakeContext' ? 'issueId' and payload -> '_paperclipWakeContext' ->> 'issueId' = $2)
   or (payload -> '_paperclipWakeContext' ? 'taskId'  and payload -> '_paperclipWakeContext' ->> 'taskId' = $2))`;

const CONTAINMENT = `
  company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days' AND (
      payload @> jsonb_build_object('issueId', $2::text)
   or payload @> jsonb_build_object('taskId', $2::text)
   or payload @> jsonb_build_object('_paperclipWakeContext', jsonb_build_object('issueId', $2::text))
   or payload @> jsonb_build_object('_paperclipWakeContext', jsonb_build_object('taskId', $2::text)))`;

/** The shape `getIssueWakeDiagnostics` actually issues, modulo the predicate. */
const select = (predicate: string) => `
  SELECT agent_id, source, reason, status, coalesced_count, run_id, requested_at, claimed_at, finished_at, error
  FROM agent_wakeup_requests WHERE ${predicate}
  ORDER BY requested_at DESC, created_at DESC LIMIT ${LIMIT}`;

async function explain(sql: postgres.Sql, label: string, query: string, params: unknown[]) {
  // Three runs: the first pays cold-cache costs that say nothing about shape.
  let last = "";
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`, params as never[]);
    last = (rows as unknown as Record<string, string>[]).map((row) => row["QUERY PLAN"]).join("\n");
    best = Math.min(best, Number(/Execution Time: ([\d.]+) ms/.exec(last)?.[1] ?? Number.NaN));
  }
  const removed = [...last.matchAll(/Rows Removed by Filter: ([\d,]+)/g)]
    .reduce((total, m) => total + Number(m[1].replace(/,/g, "")), 0);
  log(`\n${"=".repeat(78)}\n### ${label}\n${"=".repeat(78)}`);
  log(`-- best-of-3 execution: ${best.toFixed(1)} ms | rows removed by filter: ${removed.toLocaleString()}`);
  log(last);
  return { label, ms: best, removed };
}

async function main() {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) {
    console.error(`embedded Postgres unsupported here: ${support.reason}`);
    process.exit(1);
  }

  const database = await startEmbeddedPostgresTestDatabase("pen-6104-wake-payload");
  // `max_lifetime: null` for the same reason the PEN-3596 bench sets it: a
  // connection recycle landing mid-`CREATE INDEX` restarts a multi-minute build.
  const sql = postgres(database.connectionString, {
    max: 1, max_lifetime: null, idle_timeout: 0, connect_timeout: 60,
  });

  try {
    await sql.unsafe(`SET max_parallel_workers_per_gather = 0`);
    if (process.env.PEN6104_SKIP_SEED !== "1") await seed(sql);

    const [dense] = (await sql.unsafe(`
      SELECT coalesce(payload ->> 'issueId', payload ->> 'taskId') AS id, count(*)::int AS n
      FROM agent_wakeup_requests
      WHERE company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days'
        AND (payload ? 'issueId' or payload ? 'taskId')
      GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [TARGET_COMPANY])) as unknown as { id: string; n: number }[];
    const [sparse] = (await sql.unsafe(`
      SELECT coalesce(payload ->> 'issueId', payload ->> 'taskId') AS id, count(*)::int AS n
      FROM agent_wakeup_requests
      WHERE company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days'
        AND (payload ? 'issueId' or payload ? 'taskId')
      GROUP BY 1 ORDER BY 2 ASC LIMIT 1`, [TARGET_COMPANY])) as unknown as { id: string; n: number }[];
    const [window] = (await sql.unsafe(`
      SELECT count(*)::int AS n FROM agent_wakeup_requests
      WHERE company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days'`,
      [TARGET_COMPANY])) as unknown as { n: number }[];

    log(`\nseed: target company ${WINDOW_DAYS}d window = ${window.n.toLocaleString()} rows, heap ${mb(await heapBytes(sql))}`);
    log(`  DENSE  ${dense.id}  ${dense.n} wakes`);
    log(`  SPARSE ${sparse.id}  ${sparse.n} wakes`);

    /**
     * Write amplification. Rows go through the ordinary insert path so what is
     * measured is INCREMENTAL index maintenance, not a bulk build -- the bulk
     * build is reported separately as each `CREATE INDEX` duration.
     */
    await sql.unsafe(`CREATE TEMP TABLE _probe_src AS
      SELECT company_id, agent_id, source, trigger_detail, reason, payload, status
      FROM agent_wakeup_requests ORDER BY id LIMIT ${WRITE_ROWS}`);
    const writeProbe = async (label: string) => {
      const started = Date.now();
      await sql.unsafe(`INSERT INTO agent_wakeup_requests
        (company_id, agent_id, source, trigger_detail, reason, payload, status, requested_at, created_at, updated_at)
        SELECT company_id, agent_id, source, trigger_detail, reason, payload, status, now(), now(), now()
        FROM _probe_src`);
      const ms = Date.now() - started;
      const rowsPerSec = Math.round(WRITE_ROWS / (ms / 1000));
      log(`    write probe [${label}]: ${WRITE_ROWS.toLocaleString()} rows in ${sec(ms)} (${rowsPerSec} rows/s)`);
      await sql.unsafe(`DELETE FROM agent_wakeup_requests WHERE requested_at > now() - interval '1 minute'`);
      /**
       * ⛔ THE `VACUUM` IS LOAD-BEARING AND ITS ABSENCE BIASED EVERY NUMBER IN
       * THE FIRST MEASURED TABLE. `DELETE` leaves the probe's tuples dead in
       * the heap, so each candidate's `EXPLAIN` ran over the accumulated dead
       * rows of every candidate before it -- 0 for the baseline (measured
       * first), 100k/200k for C1/C1b, 300k for C2/C2b, and 0 again for C3/C4
       * because their `ADD COLUMN ... STORED` rewrite compacts the heap. The
       * probe rows carry `requested_at = now()`, so under `requested_at DESC`
       * they are walked FIRST.
       *
       * ⭐ The handicap is UNEVEN BETWEEN THE CANDIDATES BEING COMPARED, which
       * is what makes it a defect rather than noise. The header's standing
       * "seeded statistics and bloat are not production's" warning bounds the
       * ABSOLUTE milliseconds and says nothing about the COMPARISON -- and the
       * comparison is the only thing this file is for.
       *
       * `ANALYZE` as well as `VACUUM`: these probes insert and delete
       * `PEN6104_WRITE_ROWS` rows against a `PEN6104_ROWS`-row table, and a
       * plan measured against stale statistics answers a question about a
       * table that is not there. ⚠️ That share is a KNOB, not the constant
       * this comment used to quote as "5% of the table": it is 5% at the
       * defaults, but the same 100,000-row default against Run B's 140,000
       * rows would be ~71%. The smaller the table, the larger the disturbance
       * this probe makes and the more the `ANALYZE` matters.
       */
      await sql.unsafe(`VACUUM (ANALYZE) agent_wakeup_requests`);
      return { label, rowsPerSec };
    };

    const results: Record<string, unknown> = {};
    results.baseline = [
      await explain(sql, "BASELINE · dense · four-arm disjunction", select(DISJUNCTION), [TARGET_COMPANY, dense.id]),
      await explain(sql, "BASELINE · sparse · four-arm disjunction", select(DISJUNCTION), [TARGET_COMPANY, sparse.id]),
      await writeProbe("baseline, 5 shipped indexes"),
    ];

    // ── C1 / C1b · GIN on payload ───────────────────────────────────────────
    log("\n--- C1: GIN jsonb_path_ops on payload ---");
    await timed(sql, "CREATE INDEX … USING gin (payload jsonb_path_ops)",
      `CREATE INDEX awr_payload_path_gin ON agent_wakeup_requests USING gin (payload jsonb_path_ops)`);
    log(`    size: ${mb(await indexBytes(sql, "awr_payload_path_gin"))}`);
    await sql.unsafe(`ANALYZE agent_wakeup_requests`);
    results.c1 = [
      await explain(sql, "C1 · dense · @> containment", select(CONTAINMENT), [TARGET_COMPANY, dense.id]),
      await explain(sql, "C1 · sparse · @> containment", select(CONTAINMENT), [TARGET_COMPANY, sparse.id]),
      await explain(sql, "C1 · sparse · UNCHANGED ->> disjunction (GIN unreachable)",
        select(DISJUNCTION), [TARGET_COMPANY, sparse.id]),
      await writeProbe("GIN jsonb_path_ops present"),
    ];
    await sql.unsafe(`DROP INDEX awr_payload_path_gin`);

    log("\n--- C1b: btree_gin composite so company_id can reach the index ---");
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS btree_gin`);
    await timed(sql, "CREATE INDEX … USING gin (company_id, payload jsonb_path_ops)",
      `CREATE INDEX awr_company_payload_gin ON agent_wakeup_requests USING gin (company_id, payload jsonb_path_ops)`);
    log(`    size: ${mb(await indexBytes(sql, "awr_company_payload_gin"))}`);
    await sql.unsafe(`ANALYZE agent_wakeup_requests`);
    results.c1b = [
      await explain(sql, "C1b · dense · @> containment", select(CONTAINMENT), [TARGET_COMPANY, dense.id]),
      await explain(sql, "C1b · sparse · @> containment", select(CONTAINMENT), [TARGET_COMPANY, sparse.id]),
      await writeProbe("btree_gin composite present"),
    ];
    await sql.unsafe(`DROP INDEX awr_company_payload_gin`);

    // ── C2 / C2b · four partial expression btrees ───────────────────────────
    log("\n--- C2: four partial expression btrees ---");
    const partials: [string, string, string][] = [
      ["awr_payload_issue_idx", `(payload ->> 'issueId')`, `payload ? 'issueId'`],
      ["awr_payload_task_idx", `(payload ->> 'taskId')`, `payload ? 'taskId'`],
      ["awr_ctx_issue_idx", `((payload -> '_paperclipWakeContext') ->> 'issueId')`,
        `payload -> '_paperclipWakeContext' ? 'issueId'`],
      ["awr_ctx_task_idx", `((payload -> '_paperclipWakeContext') ->> 'taskId')`,
        `payload -> '_paperclipWakeContext' ? 'taskId'`],
    ];
    let partialTotal = 0;
    for (const [name, expr, predicate] of partials) {
      await timed(sql, name,
        `CREATE INDEX ${name} ON agent_wakeup_requests (company_id, ${expr}, requested_at DESC) WHERE ${predicate}`);
      const bytes = await indexBytes(sql, name);
      partialTotal += bytes;
      log(`      size: ${mb(bytes)}`);
    }
    log(`    total: ${mb(partialTotal)}`);
    await sql.unsafe(`ANALYZE agent_wakeup_requests`);
    results.c2 = [
      await explain(sql, "C2 · dense · UNCHANGED ->> disjunction", select(DISJUNCTION), [TARGET_COMPANY, dense.id]),
      await explain(sql, "C2 · sparse · UNCHANGED ->> disjunction", select(DISJUNCTION), [TARGET_COMPANY, sparse.id]),
      await explain(sql, "C2b · dense · GUARDED predicate", select(GUARDED), [TARGET_COMPANY, dense.id]),
      await explain(sql, "C2b · sparse · GUARDED predicate", select(GUARDED), [TARGET_COMPANY, sparse.id]),
      await writeProbe("4 partial expression btrees present"),
    ];
    for (const [name] of partials) await sql.unsafe(`DROP INDEX ${name}`);

    // ── C3 · generated scalar column + btree ────────────────────────────────
    log("\n--- C3: stored generated column + btree ---");
    await timed(sql, "ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (coalesce(…)) STORED  [ACCESS EXCLUSIVE]",
      `ALTER TABLE agent_wakeup_requests ADD COLUMN target_issue_id text
         GENERATED ALWAYS AS (coalesce(
            payload ->> 'issueId', payload ->> 'taskId',
            payload -> '_paperclipWakeContext' ->> 'issueId',
            payload -> '_paperclipWakeContext' ->> 'taskId')) STORED`);
    await timed(sql, "CREATE INDEX … (company_id, target_issue_id, requested_at DESC)",
      `CREATE INDEX awr_target_issue_idx ON agent_wakeup_requests (company_id, target_issue_id, requested_at DESC)
         WHERE target_issue_id IS NOT NULL`);
    log(`    index ${mb(await indexBytes(sql, "awr_target_issue_idx"))} | heap now ${mb(await heapBytes(sql))}`);
    await sql.unsafe(`ANALYZE agent_wakeup_requests`);
    const C3 = `company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days' AND target_issue_id = $2`;
    results.c3 = [
      await explain(sql, "C3 · dense", select(C3), [TARGET_COMPANY, dense.id]),
      await explain(sql, "C3 · sparse", select(C3), [TARGET_COMPANY, sparse.id]),
      await writeProbe("generated scalar column + 1 btree present"),
    ];

    // ── C4 · generated text[] column + GIN ──────────────────────────────────
    // Not one of PEN-6104's three candidates. The disjunction is a SET
    // membership test, so the column that models it exactly is an ARRAY.
    log("\n--- C4: generated text[] + GIN (exact disjunction semantics) ---");
    await timed(sql, "ALTER TABLE … ADD COLUMN target_issue_ids text[] … STORED  [ACCESS EXCLUSIVE]",
      `ALTER TABLE agent_wakeup_requests ADD COLUMN target_issue_ids text[]
         GENERATED ALWAYS AS (ARRAY[
            payload ->> 'issueId', payload ->> 'taskId',
            payload -> '_paperclipWakeContext' ->> 'issueId',
            payload -> '_paperclipWakeContext' ->> 'taskId']) STORED`);
    await timed(sql, "CREATE INDEX … USING gin (company_id, target_issue_ids)",
      `CREATE INDEX awr_target_issue_ids_gin ON agent_wakeup_requests USING gin (company_id, target_issue_ids)`);
    log(`    index ${mb(await indexBytes(sql, "awr_target_issue_ids_gin"))} | heap now ${mb(await heapBytes(sql))}`);
    await sql.unsafe(`ANALYZE agent_wakeup_requests`);
    const C4 = `company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days'
                AND target_issue_ids && ARRAY[$2::text]`;
    results.c4 = [
      await explain(sql, "C4 · dense", select(C4), [TARGET_COMPANY, dense.id]),
      await explain(sql, "C4 · sparse", select(C4), [TARGET_COMPANY, sparse.id]),
      await writeProbe("generated text[] + GIN present"),
    ];

    // ── The coalesce-vs-disjunction divergence, demonstrated ────────────────
    log("\n--- coalesce vs disjunction: divergence probe ---");
    const top = issueUuid(999_001);
    const nested = issueUuid(999_002);
    await sql.unsafe(`INSERT INTO agent_wakeup_requests
        (company_id, agent_id, source, reason, payload, status, requested_at, created_at, updated_at)
      VALUES ($1, $2, 'issue', 'issue_execution_deferred',
        jsonb_build_object('issueId', $3::text, '_paperclipWakeContext',
          jsonb_build_object('issueId', $4::text, 'taskId', $4::text)),
        'deferred_issue_execution', now(), now(), now())`,
      [TARGET_COMPANY, agentUuid(1), top, nested]);
    const count = async (predicate: string) => Number(((await sql.unsafe(
      `SELECT count(*)::int AS n FROM agent_wakeup_requests WHERE ${predicate}`,
      [TARGET_COMPANY, nested] as never[])) as unknown as { n: number }[])[0].n);
    const divergence = {
      disjunction: await count(DISJUNCTION),
      coalesce: await count(`company_id = $1 AND requested_at >= now() - interval '${WINDOW_DAYS} days'
        AND coalesce(payload ->> 'issueId', payload ->> 'taskId',
                     payload -> '_paperclipWakeContext' ->> 'issueId',
                     payload -> '_paperclipWakeContext' ->> 'taskId') = $2`),
      generatedScalar: await count(C3),
      generatedArray: await count(C4),
    };
    log(`    row whose nested context names ${nested} while its top level names ${top}:`);
    for (const [k, v] of Object.entries(divergence)) log(`      ${k.padEnd(16)} finds ${v}`);
    results.divergence = divergence;

    log(`\n${"=".repeat(78)}\nSUMMARY\n${"=".repeat(78)}`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await sql.end();
    await database.cleanup();
  }
}

await main();
