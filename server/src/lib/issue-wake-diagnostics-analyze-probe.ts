import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { logger } from "../middleware/logger.js";
import {
  containsBoundValue,
  planTextFromRows,
  redactBoundValues,
  type ExplainCapableDb,
  type ExplainableQuery,
} from "./issue-list-timeout-explain.js";

/**
 * Measure the production plan — and the **actual** per-node row counts — of the
 * wake-membership statement behind `GET /issues/:id/diagnostics/wakes`
 * (PEN-6104 done-when 1).
 *
 * ## The one number this exists to get, and why nothing already has it
 *
 * PEN-6104's finding is that `agent_wakeup_requests.payload` carries no index,
 * so the four-arm `issueId`/`taskId` membership disjunction can only be a
 * per-row recheck over `agent_wakeup_requests_company_requested_idx`. The
 * `LIMIT` bounds that **only while matches are dense near the top of the
 * `requested_at DESC` range**; on a sparse row the whole window is walked and
 * rejected. The bench reproduced exactly that shape and measured a 44x spread
 * between two rows of the same table — a 2,664-wake issue answering in 5.4 ms
 * after rejecting 3,086 rows, a 6-wake issue taking 237.6 ms to reject 158,651.
 *
 * ⛔ **That is a BENCH number, at a seeded size larger than the whole
 * production table** (136,686 live rows, measured 2026-11-08). Production hand
 * probes of the endpoint ran 0.9-3.4 s — far worse than any scan of 136 k rows
 * explains. So two readings are open and the row says plainly that **neither
 * has been measured**:
 *
 *   - **(a)** the scan dominates, and migration 0276's indexes remove most of
 *     the latency; or
 *   - **(b)** the floor is set by pool contention and other handler work, and
 *     the indexes move the endpoint very little.
 *
 * They have **opposite follow-ups** — (a) is finished when 0276 deploys, (b)
 * belongs on the pool and the handler and no further index helps it — and
 * nothing already captured can tell them apart. The endpoint's end-to-end
 * latency cannot: it is the sum of both terms. `EXPLAIN` without `ANALYZE`
 * cannot: it reports the planner's estimates, and the whole question is
 * actual-vs-estimated work. The discriminator is the statement's **own**
 * execution time and its `Rows Removed by Filter`, read in production, beside
 * the wall time of the same await. That is what this logs.
 *
 * ## Reading the plan: the four `Filter` arms are redacted and ordered
 *
 * The JSON key literals in the membership disjunction (`'issueId'`, `'taskId'`,
 * `'_paperclipWakeContext'`) are INLINE in the SQL, not bound parameters, so
 * redaction pass 2 strips them to `'?'` along with everything else that is not
 * a placeholder. The logged `Filter` line therefore shows four arms that look
 * identical. They are not: Postgres preserves the written order of an `OR`
 * chain in the plan text, so they map positionally onto
 * `wakeRequestTargetsIssue` in `server/src/services/issues.ts` — top-level
 * `issueId`, top-level `taskId`, nested `issueId`, nested `taskId`, in that
 * order. `Rows Removed by Filter` is reported for the disjunction as a whole,
 * never per arm, so no per-arm attribution is available or implied.
 *
 * ## Why it keys on ISSUE IDS, and why on a SET of them
 *
 * The cost here is a function of **which row is asked for** — that is the
 * finding, not an aside. A boolean flag would capture whatever rows happened to
 * be requested during the window, which is the single variable that determines
 * the answer. So the flag's *value* is the set of issue ids to probe, and an
 * operator picks a known-dense row and a known-sparse one deliberately.
 *
 * It is a SET rather than one id — the only shape difference from the
 * issues-list probe this is modelled on — because PEN-6104's done-when 4 asks
 * for a re-measurement on **>=2 rows**, and the dense/sparse contrast IS the
 * finding. Requiring a redeploy between the two halves of one comparison would
 * put a deploy, and whatever else changed with it, in the middle of the
 * measurement.
 *
 * ## What it costs
 *
 * One extra read-only execution of a statement whose production range is
 * 0.9-3.4 s end-to-end, bounded by {@link WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES}.
 * The matching request pays **2x** the statement, not 1x. The probe is not
 * awaited, so the response is not delayed by it, but the database does the work
 * either way and a pooled connection is held for the duration.
 *
 * ## ⛔ Why this does not reopen PEN-5223's `ANALYZE` prohibition
 *
 * That prohibition is specific and it stands: never `ANALYZE` on the automatic
 * timeout path, because it re-executes a statement that has already burned the
 * full 30 s `statement_timeout`. This probe sits on the **success path only** —
 * the call site is after the await has returned rows — so "`ANALYZE` on a
 * timed-out statement" is unreachable here by construction rather than
 * forbidden by convention, exactly as in `issue-list-analyze-probe.ts`.
 */

/**
 * Opt-in flag — the value is a **comma-separated list of issue ids to probe**,
 * not a boolean.
 *
 * Unset, empty, or whitespace-only leaves the probe off. Entries are trimmed
 * and lower-cased; blanks are dropped, so a trailing comma is harmless.
 *
 * ⚠️ A tenant opening the diagnostics page for a listed issue also trips the
 * probe. That is bounded by the capture budget and is a legitimate measurement
 * of the same statement — but it means the budget can be spent by traffic other
 * than the operator's own request, so read the logged `probe` ordinal rather
 * than assuming the first capture is yours.
 *
 * ⚠️ And the probed request is a slightly PESSIMISTIC sample of itself. The
 * probe is fire-and-forget, so it starts while the handler is still working
 * and competes with that same request for a pool connection — on a pool
 * measured at 69/72 waiting, that is not free. If a second request for the
 * same issue is in flight it can also inflate that request's `statementMs`.
 * Read the captured plan's own `Execution Time` as the clean number and treat
 * the end-to-end latency of a probed request as an upper bound. This is
 * deliberate: not awaiting it keeps the response undelayed, which matters more
 * than the sample being pristine.
 */
export const WAKE_DIAGNOSTICS_PROBE_FLAG = "PAPERCLIP_EXPLAIN_ANALYZE_WAKE_DIAGNOSTICS_ISSUE_IDS";

/**
 * `EXPLAIN` options for the probe.
 *
 * `ANALYZE` is the entire point — it is what carries `actual rows`, `loops` and
 * the `Rows Removed by Filter` count done-when 1 names explicitly. `BUFFERS`
 * reports anything only *with* `ANALYZE`, and separates "this node is CPU" from
 * "this node is I/O" — which matters here, because a cold-cache detoast of the
 * `jsonb` payload and a hot in-memory recheck of it are the same plan node with
 * very different costs. `SETTINGS` is kept for parity with the PEN-5223 and
 * PEN-5296 artifacts so all three can be read side by side.
 */
export const WAKE_DIAGNOSTICS_PROBE_OPTIONS =
  "ANALYZE, BUFFERS, FORMAT TEXT, VERBOSE, COSTS, SETTINGS";

/**
 * Bound on the probe, as `SET LOCAL` inside its own transaction.
 *
 * ⚠️ **Deliberately well BELOW the 30 s role `statement_timeout`, which is the
 * opposite of what the issues-list `ANALYZE` probe does** — that one widens its
 * bound to 60 s. The difference is not style, it is the statement under study.
 * There the statement's whole significance is that it approaches and sometimes
 * exceeds 30 s, so a 30 s bound would cancel the probe exactly in the case of
 * interest and a cancelled `ANALYZE` returns no plan at all. Here the statement
 * runs 0.9-3.4 s end-to-end in production and the bench puts its scan at tens of
 * milliseconds, so that argument does not apply and a tight bound is strictly
 * better: 10 s is ~3x the slowest reading anyone has taken, and a probe that
 * somehow ran longer than that would be reporting on something other than the
 * statement this row is about.
 *
 * `SET LOCAL` reverts with the transaction, so the bound can never leak onto a
 * pooled connection serving ordinary traffic.
 */
export const WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Hard per-process cap on probes.
 *
 * Sized for the measurement the row actually asks for: two rows (one dense, one
 * sparse) with room for a capture landing on a cold cache or racing a deploy.
 * Each costs one extra execution of a sub-second-to-3.4 s statement, so this is
 * a far smaller draw than the issues-list `ANALYZE` probe's 3 x ~25 s, which is
 * why the count is higher and the total load still lower.
 *
 * Deliberately not configurable — a flag plus an operator's intention is not a
 * bound. Process-local, so a two-replica deployment admits up to 2x this; that
 * is correct for a diagnostic that must survive a roll to capture anything, and
 * it is why the budget is small.
 */
export const WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES = 5;

let probesTaken = 0;

/** Reset the per-process probe budget. Exported for tests only. */
export function resetWakeDiagnosticsProbeBudget(): void {
  probesTaken = 0;
}

/** Probes taken so far in this process. Exported for tests and for logging. */
export function wakeDiagnosticsProbeCapturesTaken(): number {
  return probesTaken;
}

/** The operator-chosen issue ids, lower-cased. Empty when the probe is off. */
export function wakeDiagnosticsProbeIssueIds(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = env[WAKE_DIAGNOSTICS_PROBE_FLAG];
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Is this request's issue one the operator named?
 *
 * Exported so the decision is testable on its own: it is the whole of what
 * keeps this off arbitrary tenant traffic.
 */
export function shouldProbeWakeDiagnostics(
  issueId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const wanted = wakeDiagnosticsProbeIssueIds(env);
  if (wanted.length === 0) return false;
  return wanted.includes(issueId.trim().toLowerCase());
}

/** Build the `EXPLAIN (ANALYZE, BUFFERS) ...` statement for a drizzle builder. */
export function buildWakeDiagnosticsProbeQuery(query: ExplainableQuery): SQL {
  return sql`EXPLAIN (${sql.raw(WAKE_DIAGNOSTICS_PROBE_OPTIONS)}) ${query.getSQL()}`;
}

/**
 * Run and log one `EXPLAIN (ANALYZE, BUFFERS)` of a wake-diagnostics statement
 * that has just **succeeded**.
 *
 * **Never throws.** The caller has a successful response in hand; a diagnostic
 * that raised on top of it would convert a working endpoint into a defect.
 * Every failure path is swallowed and reported at most as a `warn`.
 *
 * **Never logs bound parameter values.** The same two-pass redaction and the
 * same independent fail-closed check as the PEN-5223 capture, imported rather
 * than re-implemented — a second copy of that logic is a second place for the
 * fragmentation leak it was written to close. The issue id is a bound parameter
 * on all four arms, so it is redacted out of the plan text; the operator knows
 * which ids they set, and `issueId` is logged as its own field for correlation.
 *
 * `statementMs` is the caller's wall time around the **original** wake-section
 * read — not the probe's.
 *
 * ⛔ It is NOT "how long the scan took", and nothing here should be read as
 * saying so. It is measured around the whole bounded section, so it carries
 * pool acquisition, `BEGIN`, `SET LOCAL statement_timeout`, `COMMIT` and the
 * client round trips as well as the statement. That is exactly why it is the
 * discriminator: `statementMs` MINUS the plan's own `Execution Time` is
 * approximately pool wait + setup round trips + planning, so a large remainder
 * is evidence for reading (b) and a small one for (a). A reader who takes
 * `statementMs ≈ 3 s` to mean "the scan is 3 s" has thrown away the only
 * subtraction this instrument exists to support. Pass it; a probe without it
 * answers only half the question.
 *
 * ⚠️ Caller contract: pass the statement that **already returned rows**. This
 * must never be reachable from a `catch`; see the module doc for why that
 * separation is the whole argument for this instrument existing at all.
 */
export async function captureWakeDiagnosticsAnalyzeProbe(options: {
  db: ExplainCapableDb;
  query: ExplainableQuery;
  companyId: string;
  issueId: string;
  rowsReturned: number;
  statementMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { db, query, companyId, issueId, rowsReturned, statementMs, env } = options;
  // Hoisted above the `try` so the failure path can report them. A `57014`
  // cancel of the probe is the single most informative result this can
  // produce — it is the only outcome that says the scan cost more than
  // WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS — and it is worthless without the
  // original statement's wall time to read it against.
  let probe = 0;
  let startedAt = 0;
  try {
    if (!shouldProbeWakeDiagnostics(issueId, env ?? process.env)) return;
    if (probesTaken >= WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES) return;
    // Claim the slot BEFORE awaiting, for the same reason the PEN-5223 capture
    // does: concurrent requests for a probed issue would otherwise all pass the
    // check and overshoot the cap by the width of the burst.
    probesTaken += 1;
    probe = probesTaken;

    const explain = buildWakeDiagnosticsProbeQuery(query);
    startedAt = Date.now();
    const rows = await db.transaction(async (tx) => {
      // SET LOCAL, not SET: reverts with this transaction. See
      // WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS for why this one tightens the bound
      // where the issues-list probe widens it.
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = '${WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS}ms'`),
      );
      return tx.execute(explain);
    });
    const rawPlan = planTextFromRows(rows);
    if (!rawPlan) {
      logger.warn({ probe, companyId, issueId }, "wake-diagnostics ANALYZE probe returned no QUERY PLAN rows");
      return;
    }
    const { params } = new PgDialect().sqlToQuery(explain);
    const plan = redactBoundValues(rawPlan, params);
    // Fail closed: withhold rather than risk logging a bound value.
    if (containsBoundValue(plan, params)) {
      logger.warn(
        { probe, companyId, issueId },
        "wake-diagnostics ANALYZE probe withheld: bound values survived redaction (PEN-6104)",
      );
      return;
    }
    logger.warn(
      {
        probe,
        probeBudget: WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES,
        companyId,
        issueId,
        rowsReturned,
        // `statementMs` is the original read's wall time; `probeMs` is this
        // probe's. ⛔ `probeMs` is NOT an upper bound on `statementMs` and an
        // earlier revision of this comment said it was. The two are measured
        // around different work: `probeMs` carries its own pool wait and its
        // own BEGIN/SET/COMMIT round trips on top of an `ANALYZE`-instrumented
        // execution, and `statementMs` carries a different pool wait under
        // different contention. Neither bounds the other. Compare each against
        // the plan's own `Execution Time` instead — that is the only term all
        // three share.
        statementMs,
        probeMs: Date.now() - startedAt,
        plan,
      },
      "wake-diagnostics deliberate EXPLAIN (ANALYZE, BUFFERS) probe (PEN-6104)",
    );
  } catch (probeError) {
    logger.warn(
      {
        err: probeError,
        probe,
        companyId,
        issueId,
        rowsReturned,
        statementMs,
        // 0 when the probe never started (flag off, or budget spent); those
        // paths `return` before `startedAt` is set and cannot reach here.
        probeMs: startedAt === 0 ? 0 : Date.now() - startedAt,
      },
      "wake-diagnostics ANALYZE probe failed; the request it followed is unaffected",
    );
  }
}
