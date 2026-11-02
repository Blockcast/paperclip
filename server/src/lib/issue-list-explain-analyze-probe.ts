import { sql, type SQL } from "drizzle-orm";

import { logger } from "../middleware/logger.js";
import {
  containsBoundValue,
  planTextFromRows,
  redactBoundValues,
  renderExplainStatement,
  type ExplainCapableDb,
  type ExplainableQuery,
} from "./issue-list-timeout-explain.js";

/**
 * Measure ACTUAL-vs-ESTIMATED rows for the issues-list search, by running
 * `EXPLAIN (ANALYZE, BUFFERS)` on a deliberately selected execution
 * (PEN-5296, artifact for PEN-3596).
 *
 * ## The question this answers, and why the sibling instruments cannot
 *
 * PEN-5223 settled *"does production pick a different plan than the 218ms
 * bench?"* — no. Both production captures are index-served, no `Seq Scan`,
 * estimated cost ~4,100-4,400, estimated output 21 and 60 rows, with the four
 * search arms estimated at 4+6+5+56 = ~71 candidate rows. The statement still
 * burns the full 30s `statement_timeout`.
 *
 * So the live question is *"where did the time go?"*, and the hypothesis is an
 * underestimate at the `Append` driving a `Nested Loop` over 2,842-byte-wide
 * pkey fetches plus a `Sort`. **Only `ANALYZE` carries actual row counts**, and
 * neither sibling instrument can produce them:
 *
 *   - `EXPLAIN` without `ANALYZE` (PEN-5223) reports estimates by definition.
 *   - `auto_explain` (PEN-5220) emits only from `explain_ExecutorEnd`, which
 *     `PortalCleanup` skips for a `PORTAL_FAILED` portal, so it never sees a
 *     statement cancelled by `statement_timeout` at all — and when it does see
 *     a completing one, it reports the same actuals this probe does, for two
 *     production DB rolls and a board slot instead of an env var.
 *
 * ## Why `ANALYZE` is admissible here when PEN-5223 forbids it
 *
 * PEN-5223's prohibition is scoped to its own path and stands there unchanged:
 * `ANALYZE` on the **automatic timeout** path would re-execute a statement that
 * had already burned 30s, doubling the cost of an incident in progress, on
 * every `57014`. This probe is a different act — it fires on an execution that
 * **completed**, under an explicit opt-in flag, on an explicitly named company,
 * above an explicit duration floor, with a hard per-process budget of
 * {@link ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY}.
 *
 * ⚠️ **It is honestly an EXTRA execution, not a free one.** The request's own
 * page query has already run; this runs the same statement a second time. The
 * tenant does not wait for it (the call site does not await), so the cost lands
 * on the database rather than on the response — one additional read-only query
 * of the same shape, at most twice per process. State it that way; do not
 * describe it as costing "1x".
 *
 * ## Safety properties, in the order they matter
 *
 *   - **`READ ONLY` transaction.** `ANALYZE` *executes*. The statement reaching
 *     here is always the issues-list `SELECT`, but that is an argument about the
 *     call site; `SET TRANSACTION READ ONLY` makes it a property the server
 *     enforces, so no future call site can turn this into a write.
 *   - **`TIMING OFF`.** Per-node timing calls `gettimeofday` per tuple, and the
 *     suspected defect is a row explosion — i.e. exactly the case where that
 *     overhead is largest and would distort the measurement it is taken to
 *     explain. Actual ROW counts are the discriminator and need no timer; total
 *     `Execution Time` survives `TIMING OFF`. This is the same posture PEN-5220
 *     adopted as `auto_explain.log_timing=off`.
 *   - **Bounded, raised `statement_timeout`.** Set `LOCAL`, so it reverts with
 *     this transaction and can never leak onto a pooled connection serving
 *     ordinary traffic.
 *   - **Never throws, never logs bound values.** Same guarantees as the PEN-5223
 *     capture, through the same redaction and the same fail-closed check.
 */

/**
 * Opt-in flag. Default **off**, and deliberately SEPARATE from
 * `PAPERCLIP_EXPLAIN_TIMED_OUT_ISSUE_LIST`: one flag for two instruments would
 * mean enabling the cheap plan-only capture also enabled a re-execution.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_FLAG = "PAPERCLIP_EXPLAIN_ANALYZE_ISSUE_LIST";

/**
 * Comma-separated company ids the probe may fire for. **Empty or unset means
 * every company**, which is the wrong default for a deliberate probe — set it.
 *
 * This is what makes the instrument reach the company whose statements actually
 * cross 30s without anyone holding a credential for it: the capture happens
 * inside the server, on that company's own organic request, and the redaction
 * guarantees no row data or search term leaves the process.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_COMPANIES_FLAG =
  "PAPERCLIP_EXPLAIN_ANALYZE_ISSUE_LIST_COMPANY_IDS";

/**
 * Duration floor, in milliseconds. Only an execution that ALREADY took at least
 * this long is re-run. Without it the budget is spent on the first two trivial
 * list requests the process happens to serve, which are not the shape in
 * question.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_MIN_ELAPSED_MS_FLAG =
  "PAPERCLIP_EXPLAIN_ANALYZE_ISSUE_LIST_MIN_MS";

/** Default duration floor: well above a healthy list, well below the 30s budget. */
export const ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS = 5_000;

/**
 * ⚠️ `ANALYZE` is present here ON PURPOSE and this constant is the ONLY place in
 * the server where that is true. It must never be copied onto the PEN-5223
 * timeout path, whose own `ISSUE_LIST_EXPLAIN_OPTIONS` is asserted to exclude it.
 *
 * `TIMING OFF` and the absence of `WAL`/`SERIALIZE` are deliberate — see the
 * module doc.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS =
  "ANALYZE, BUFFERS, TIMING OFF, FORMAT TEXT, VERBOSE, COSTS, SETTINGS";

/**
 * Bound on the probe's own execution.
 *
 * Deliberately ABOVE the role-level 30s `statement_timeout`, and that is the
 * single property no other instrument has: an execution cancelled at 30s
 * produces no plan from `auto_explain` (the portal is `PORTAL_FAILED`) and none
 * from `EXPLAIN ANALYZE` either, because a cancelled `EXPLAIN ANALYZE` returns
 * an error rather than a partial plan. Raising the bound for one deliberate
 * re-execution is the only way an execution that WOULD have timed out can be
 * made to report its actual row counts.
 *
 * `statement_timeout` is `USERSET`, so an ordinary role may raise it for its own
 * transaction; `SET LOCAL` confines the raise to this transaction.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS = 120_000;

/**
 * Hard cap PER COMPANY, per process. Lower than the PEN-5223 capture's 5,
 * because each of these is a full re-execution holding a pooled connection for
 * up to {@link ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS}, not a sub-second planner
 * pass. Deliberately not configurable, for the same reason it is not there.
 *
 * ⚠️ Per company rather than per process, and that is load-bearing for the
 * measurement rather than a generosity: the companies worth comparing have very
 * different request rates, so a single shared counter is spent by whichever
 * company is busiest and the quieter one — which may be the one that actually
 * times out — is never measured at all.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY = 2;

/**
 * Ceiling across all companies in one process, so an UNSET allowlist (which
 * admits every company) still cannot turn into an unbounded stream of
 * re-executions. Reached before the per-company cap only when several distinct
 * companies are running slow searches at once.
 */
export const ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_TOTAL = 6;

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSEY_FLAG_VALUES = new Set(["", "0", "false", "no", "off", "disabled"]);

const probesTakenByCompany = new Map<string, number>();
let probesTakenTotal = 0;

/** Reset the probe budgets. Exported for tests only. */
export function resetIssueListExplainAnalyzeProbeBudget(): void {
  probesTakenByCompany.clear();
  probesTakenTotal = 0;
}

/** Probes taken so far in this process, across every company. */
export function issueListExplainAnalyzeProbesTaken(): number {
  return probesTakenTotal;
}

/** Probes taken so far in this process for one company. */
export function issueListExplainAnalyzeProbesTakenForCompany(companyId: string): number {
  return probesTakenByCompany.get(companyId) ?? 0;
}

/**
 * Read the opt-in flag. An unrecognized value logs and leaves the probe **off**,
 * matching the PEN-5223 flag reader: failing toward the default is what
 * keeps a typo from silently enabling a re-execution in production.
 */
export function issueListExplainAnalyzeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]?.trim().toLowerCase();
  if (raw === undefined) return false;
  if (TRUTHY_FLAG_VALUES.has(raw)) return true;
  if (!FALSEY_FLAG_VALUES.has(raw)) {
    logger.warn(
      { value: raw },
      `${ISSUE_LIST_EXPLAIN_ANALYZE_FLAG} is set to an unrecognized value; the `
        + "deliberate issues-list EXPLAIN (ANALYZE) probe remains DISABLED. Use one of: "
        + [...TRUTHY_FLAG_VALUES].join(", "),
    );
  }
  return false;
}

/**
 * True when `companyId` is in the configured allowlist, or when no allowlist is
 * configured. Matching is case-insensitive because company ids are UUIDs that
 * get pasted in either case.
 */
export function issueListExplainAnalyzeCompanyAllowed(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env[ISSUE_LIST_EXPLAIN_ANALYZE_COMPANIES_FLAG]
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0) ?? [];
  if (configured.length === 0) return true;
  return configured.includes(companyId.trim().toLowerCase());
}

/**
 * Duration floor in milliseconds. A non-numeric or negative value logs and falls
 * back to the default rather than disabling the floor, because a floor of 0 is
 * the one setting that spends the budget on the wrong executions.
 */
export function issueListExplainAnalyzeMinElapsedMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ISSUE_LIST_EXPLAIN_ANALYZE_MIN_ELAPSED_MS_FLAG]?.trim();
  if (!raw) return ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      { value: raw },
      `${ISSUE_LIST_EXPLAIN_ANALYZE_MIN_ELAPSED_MS_FLAG} is not a non-negative number; `
        + `falling back to ${ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS}ms`,
    );
    return ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS;
  }
  return parsed;
}

/**
 * Build the `EXPLAIN (ANALYZE, BUFFERS)` statement for a drizzle query builder.
 *
 * Composes the builder's own `SQL` rather than reading its text, exactly as the
 * PEN-5223 capture does: drizzle renumbers the placeholders and carries the
 * parameters verbatim, so the statement measured is by construction the one that
 * was executed, not a transcription of it.
 */
export function buildIssueListExplainAnalyzeQuery(query: ExplainableQuery): SQL {
  return sql`EXPLAIN (${sql.raw(ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS)}) ${query.getSQL()}`;
}

/**
 * Re-run a just-completed issues-list statement under `EXPLAIN (ANALYZE, BUFFERS)`
 * and log the redacted plan with its measured row counts.
 *
 * **Never throws.** The caller's request has already succeeded; a diagnostic that
 * raises on top of it would convert a served list into a defect.
 *
 * **Never logs bound parameter values**, and the guarantee is not weakened by
 * `ANALYZE`: the added output is counts (`actual rows`, `loops`, `Buffers`,
 * `Rows Removed by Filter`) and `Execution Time`, none of which PostgreSQL
 * renders as a quoted literal, so the existing two-pass redaction and its
 * fail-closed check apply unchanged. `ANALYZE` also discards the result set, so
 * no row data reaches this process at all.
 */
export async function captureIssueListExplainAnalyzeProbe(options: {
  db: ExplainCapableDb;
  query: ExplainableQuery;
  companyId: string;
  hasSearch: boolean;
  searchTermLength: number;
  elapsedMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { db, query, companyId, hasSearch, searchTermLength, elapsedMs, env } = options;
  try {
    // Only the SEARCH variant is in question; a non-search list is a different
    // shape and would spend the budget without bearing on the hypothesis.
    if (!hasSearch) return;
    if (!issueListExplainAnalyzeEnabled(env)) return;
    if (!issueListExplainAnalyzeCompanyAllowed(companyId, env)) return;
    if (elapsedMs < issueListExplainAnalyzeMinElapsedMs(env)) return;
    if (probesTakenTotal >= ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_TOTAL) return;
    const takenForCompany = probesTakenByCompany.get(companyId) ?? 0;
    if (takenForCompany >= ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY) return;
    // Claim the slot BEFORE awaiting, so a burst of concurrent slow lists cannot
    // all pass the check and overshoot the cap by the width of the burst.
    probesTakenByCompany.set(companyId, takenForCompany + 1);
    probesTakenTotal += 1;
    const probe = takenForCompany + 1;

    const explain = buildIssueListExplainAnalyzeQuery(query);
    const startedAt = Date.now();
    const rows = await db.transaction(async (tx) => {
      // ANALYZE executes. Make "this can only read" a server-enforced property
      // rather than an argument about which query the call site passed.
      await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
      // LOCAL: reverts with this transaction. See the constant for why the bound
      // is deliberately above the role-level 30s timeout.
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = '${ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS}ms'`),
      );
      return tx.execute(explain);
    });
    const rawPlan = planTextFromRows(rows);
    if (!rawPlan) {
      logger.warn(
        { probe, companyId },
        "issue-list EXPLAIN (ANALYZE) probe returned no QUERY PLAN rows (PEN-5296)",
      );
      return;
    }
    const rendered = renderExplainStatement(explain);
    const params = rendered?.params ?? [];
    const plan = redactBoundValues(rawPlan, params);
    const statement = rendered ? redactBoundValues(rendered.sql, params) : null;
    // Fail closed: withhold rather than risk logging a user-entered search term.
    if (containsBoundValue(plan, params) || (statement && containsBoundValue(statement, params))) {
      logger.warn(
        { probe, companyId },
        "issue-list EXPLAIN (ANALYZE) probe withheld: bound values survived redaction (PEN-5296)",
      );
      return;
    }
    logger.warn(
      {
        probe,
        probeBudget: ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY,
        probesTakenTotal,
        companyId,
        hasSearch,
        searchTermLength,
        // The served request's own duration, which is what selected it.
        elapsedMs,
        // The re-execution's duration. Expected to be close to `elapsedMs`; a
        // large gap is a cache-warmth artifact and should be read as one.
        probeMs: Date.now() - startedAt,
        // Placeholders only — never the bound values. See `redactBoundValues`.
        statement,
        plan,
      },
      "issue-list EXPLAIN (ANALYZE, BUFFERS): measured actual-vs-estimated rows (PEN-5296)",
    );
  } catch (probeError) {
    // Swallow. The caller's request already succeeded and must stay unaffected.
    logger.warn(
      { err: probeError, companyId },
      "issue-list EXPLAIN (ANALYZE) probe failed; the served response is unaffected",
    );
  }
}
