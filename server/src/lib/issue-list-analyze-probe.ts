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
 * Measure **actual** per-node row counts for the issues-list SEARCH statement
 * with a deliberately issued `EXPLAIN (ANALYZE, BUFFERS)` (PEN-5296, artifact
 * for PEN-3596).
 *
 * ## Why a second instrument, when PEN-5223 already captures a plan
 *
 * `captureTimedOutIssueListPlan` answers *"does production pick a different
 * plan than the 218 ms bench?"* — and it answered **no**: every search arm is
 * index-served, no `Seq Scan`, estimated cost ~4,100-4,400, estimated output 21
 * and 60 rows. It cannot answer *"where did the 30 s go?"*, because `EXPLAIN`
 * without `ANALYZE` reports the planner's **estimates** and never what the
 * executor actually did.
 *
 * The live hypothesis needs the other half: an `Append` estimated at ~70 rows
 * driving a `Nested Loop` over 2,842-byte-wide pkey fetches, plus a `Sort`,
 * with `SubPlan 3` re-scanning the comment-body arm. An underestimate there
 * turns into N wide random fetches, and **actual-vs-estimated rows is the only
 * discriminator**. Only `ANALYZE` carries it.
 *
 * ## ⛔ Why this does NOT reopen PEN-5223's `ANALYZE` prohibition
 *
 * That prohibition is specific and it stands: `ANALYZE` must never run on the
 * **automatic timeout path**, because it would re-execute a statement that has
 * already burned the full 30 s `statement_timeout` — doubling the cost of an
 * incident in progress, on a request that has already failed.
 *
 * This probe is the opposite case in all three respects, and the separation is
 * structural rather than a matter of caller discipline:
 *
 *   - **It runs only on the SUCCESS path.** The call site sits after the
 *     statement has already returned rows. A statement that hit `57014` never
 *     reaches it, so "`ANALYZE` on a timed-out statement" is unreachable by
 *     construction rather than forbidden by convention.
 *   - **It is a separate flag** ({@link ISSUE_LIST_ANALYZE_PROBE_FLAG}), with
 *     its own budget and its own bound. Enabling the PEN-5223 capture does not
 *     enable this, and vice versa.
 *   - **It fires only on one operator-chosen search term.** The flag's *value*
 *     is that term (see below), so this cannot fire on arbitrary tenant
 *     traffic — which is exactly what makes the automatic path's prohibition
 *     necessary there and unnecessary here.
 *
 * ## What it costs
 *
 * One extra execution of a read-only `SELECT`, bounded by
 * {@link ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES}. ⚠️ State it honestly: the
 * matching request pays **2x** — its own execution plus the probe's — not 1x.
 * The probe is not awaited, so the tenant's response is not delayed by it, but
 * the database does the work either way and a pooled connection is held for the
 * duration.
 */

/**
 * Opt-in flag — and the flag's **value is the search term to probe**, not a
 * boolean.
 *
 * A boolean would fire this on *every* issues-list search until the budget ran
 * out, which is both more load than the question needs and a worse measurement:
 * the captures would be of whatever terms happened to arrive, when the whole
 * point is to measure a **chosen** term whose cost is already characterised
 * (`q=the` at 24.2 s on Penstock, `q=zzqx9v7knotathing` at 0.34 s).
 *
 * Carrying the term in the value makes "deliberately issued, on a chosen term,
 * at a chosen moment" a property of the flag rather than of an operator's
 * timing. Unset, empty, or whitespace-only leaves the probe **off**; there is
 * no truthy-string parsing here precisely because every non-empty value is
 * meaningful.
 *
 * ⚠️ A tenant searching the same term also trips the probe. That is bounded by
 * the capture budget and is a legitimate measurement of the same shape — but it
 * means the budget can be spent by traffic other than the operator's own
 * request, so read the logged `capture` ordinal rather than assuming the first
 * capture is yours.
 */
export const ISSUE_LIST_ANALYZE_PROBE_FLAG = "PAPERCLIP_EXPLAIN_ANALYZE_ISSUE_LIST_TERM";

/**
 * `EXPLAIN` options for the probe.
 *
 * `ANALYZE` is the entire point — it is what carries `actual rows`, `loops` and
 * `Rows Removed by Filter`. `BUFFERS` only reports anything *with* `ANALYZE`,
 * and separates "this node is CPU" from "this node is I/O", which is the next
 * question after the row counts. `SETTINGS` is kept for parity with the
 * PEN-5223 capture so the two artifacts can be read side by side.
 *
 * `TIMING` is left at its default (on). It inflates per-node cost on some
 * plans, so the probe's wall time is an upper bound on the statement's own —
 * that is the right direction for an instrument whose job is to find where time
 * goes, and `ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS` is sized for it.
 */
export const ISSUE_LIST_ANALYZE_PROBE_OPTIONS =
  "ANALYZE, BUFFERS, FORMAT TEXT, VERBOSE, COSTS, SETTINGS";

/**
 * Bound on the probe, as `SET LOCAL` inside its own transaction.
 *
 * ⚠️ **Deliberately ABOVE the 30 s role `statement_timeout`, which is the
 * opposite of the PEN-5223 capture's 2 s bound, and the reason is the
 * difference between planning and executing.** That capture only plans, so 2 s
 * is generous. This one executes the statement under study — a statement whose
 * whole significance is that it approaches and sometimes exceeds 30 s — and
 * `ANALYZE`'s per-node instrumentation adds to that. A probe bounded at 30 s
 * would therefore be cancelled **exactly in the case of interest**, and a
 * cancelled `ANALYZE` returns no plan at all: not a partial reading, nothing.
 * The one measurement the row exists for would be the one it could never take.
 *
 * 60 s is the smallest bound that comfortably clears the observed 24-25 s plus
 * instrumentation overhead. `SET LOCAL` reverts with the transaction, so the
 * widened bound can never leak onto a pooled connection serving ordinary
 * traffic.
 */
export const ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS = 60_000;

/**
 * Hard per-process cap on probes.
 *
 * Lower than the PEN-5223 capture's 5, because each of these *executes* a
 * statement that costs ~25 s of database time rather than planning one that
 * costs ~0.4 s. The question needs one good reading; three allows for a
 * capture landing on a cold cache or racing a deploy. Deliberately not
 * configurable — a flag plus an operator's intention is not a bound.
 *
 * Process-local: each API replica carries its own budget, so a two-replica
 * deployment admits up to 2 x this. That is the correct behaviour for a
 * diagnostic that must survive a roll to capture anything, and it is why the
 * budget is small.
 */
export const ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES = 3;

let probesTaken = 0;

/** Reset the per-process probe budget. Exported for tests only. */
export function resetIssueListAnalyzeProbeBudget(): void {
  probesTaken = 0;
}

/** Probes taken so far in this process. Exported for tests and for logging. */
export function issueListAnalyzeProbeCapturesTaken(): number {
  return probesTaken;
}

/**
 * The operator-chosen search term, or `null` when the probe is off.
 *
 * Trimmed and lower-cased so the comparison matches the route's own handling
 * (`list()` trims `filters.q`, and the search itself is `ILIKE`). An operator
 * who sets `" The "` means `the`.
 */
export function issueListAnalyzeProbeTerm(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[ISSUE_LIST_ANALYZE_PROBE_FLAG]?.trim().toLowerCase();
  return raw ? raw : null;
}

/**
 * Does this request's search term match the operator-chosen probe term?
 *
 * Exported so the decision is testable on its own: it is the whole of what
 * keeps this off arbitrary tenant traffic.
 */
export function shouldProbeIssueListSearch(
  searchTerm: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const probeTerm = issueListAnalyzeProbeTerm(env);
  return probeTerm !== null && searchTerm.trim().toLowerCase() === probeTerm;
}

/** Build the `EXPLAIN (ANALYZE, BUFFERS) ...` statement for a drizzle builder. */
export function buildIssueListAnalyzeProbeQuery(query: ExplainableQuery): SQL {
  return sql`EXPLAIN (${sql.raw(ISSUE_LIST_ANALYZE_PROBE_OPTIONS)}) ${query.getSQL()}`;
}

/**
 * Run and log one `EXPLAIN (ANALYZE, BUFFERS)` of an issues-list statement that
 * has just **succeeded**.
 *
 * **Never throws.** The caller has a successful response in hand; a diagnostic
 * that raises on top of it would convert a working list into a defect. Every
 * failure path is swallowed and reported at most as a `warn`.
 *
 * **Never logs bound parameter values.** The same two-pass redaction and the
 * same independent fail-closed check as the PEN-5223 capture, imported rather
 * than re-implemented — a second copy of that logic is a second place for the
 * fragmentation leak it was written to close. `searchTermLength` is recorded
 * instead of the term.
 *
 * ⚠️ Caller contract: pass the statement that **already returned rows**. This
 * must never be reachable from a `catch` on the issues-list query; see the
 * module doc for why that separation is the whole argument for this instrument
 * existing alongside PEN-5223's.
 */
export async function captureIssueListAnalyzeProbe(options: {
  db: ExplainCapableDb;
  query: ExplainableQuery;
  companyId: string;
  searchTerm: string;
  rowsReturned: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { db, query, companyId, searchTerm, rowsReturned, env } = options;
  try {
    if (!shouldProbeIssueListSearch(searchTerm, env ?? process.env)) return;
    if (probesTaken >= ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES) return;
    // Claim the slot BEFORE awaiting, for the same reason the PEN-5223 capture
    // does: concurrent requests carrying the probe term would otherwise all
    // pass the check and overshoot the cap by the width of the burst — and here
    // an overshoot costs ~25s of database time each, not ~0.4s.
    probesTaken += 1;
    const probe = probesTaken;

    const explain = buildIssueListAnalyzeProbeQuery(query);
    const startedAt = Date.now();
    const rows = await db.transaction(async (tx) => {
      // SET LOCAL, not SET: reverts with this transaction. See
      // ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS for why this one widens the bound
      // rather than tightening it.
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = '${ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS}ms'`),
      );
      return tx.execute(explain);
    });
    const rawPlan = planTextFromRows(rows);
    if (!rawPlan) {
      logger.warn({ probe, companyId }, "issue-list ANALYZE probe returned no QUERY PLAN rows");
      return;
    }
    const { params } = new PgDialect().sqlToQuery(explain);
    const plan = redactBoundValues(rawPlan, params);
    // Fail closed: withhold rather than risk logging a user-entered search term.
    if (containsBoundValue(plan, params)) {
      logger.warn(
        { probe, companyId },
        "issue-list ANALYZE probe withheld: bound values survived redaction (PEN-5296)",
      );
      return;
    }
    logger.warn(
      {
        probe,
        probeBudget: ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES,
        companyId,
        // The LENGTH, never the term — see `redactBoundValues`. The operator
        // knows which term they set; this only confirms the probe matched it.
        searchTermLength: searchTerm.length,
        rowsReturned,
        probeMs: Date.now() - startedAt,
        plan,
      },
      "issue-list deliberate EXPLAIN (ANALYZE, BUFFERS) probe (PEN-5296)",
    );
  } catch (probeError) {
    logger.warn(
      { err: probeError, companyId },
      "issue-list ANALYZE probe failed; the request it followed is unaffected",
    );
  }
}
