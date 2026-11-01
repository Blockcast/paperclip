import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { logger } from "../middleware/logger.js";
import { findPgError, STATEMENT_TIMEOUT_SQLSTATE } from "./db-retry.js";

/**
 * Capture the production query plan of an issues-list statement that was
 * cancelled by `statement_timeout` (PEN-5223, artifact for PEN-3596 box 1).
 *
 * ## Why this exists, when `auto_explain` is the obvious instrument
 *
 * `auto_explain` **structurally cannot see this statement.** Its only emit site
 * is `explain_ExecutorEnd` (`contrib/auto_explain/auto_explain.c:371`), reached
 * only through `ExecutorEnd` — and `PortalCleanup`
 * (`src/backend/commands/portalcmds.c:299`) guards that with
 * `if (portal->status != PORTAL_FAILED)`, "we skip this during error abort". A
 * `statement_timeout` cancellation leaves the portal `PORTAL_FAILED`, so no plan
 * is ever emitted for it. PG18 also ships no `pg_log_query_plan()`, so no
 * server-side instrument can reach a cancelled statement's plan at all.
 * `auto_explain` therefore degrades to "plans of executions that COMPLETED",
 * which is a proxy for the >30s statement, not the statement.
 *
 * `EXPLAIN` **without** `ANALYZE` does not execute. It asks the planner for the
 * plan of the exact statement that just timed out, against production
 * statistics — which is the one artifact neither the seeded bench nor
 * `auto_explain` can produce.
 *
 * ## Why the captured plan is the plan production chose, not a proxy for it
 *
 * A replayed `EXPLAIN` normally carries a real fidelity caveat: PostgreSQL
 * plans a **named prepared statement** with a *generic* plan once
 * `plan_cache_mode = auto` flips it after five executions, while a fresh
 * `EXPLAIN` is planned *custom* against the supplied values. A generic/custom
 * divergence is one of the commonest reasons production picks a plan a bench
 * never sees, so an instrument blind to it would be a fourth proxy.
 *
 * That caveat does not apply on this stack, and the reason is structural rather
 * than incidental:
 *
 *   - drizzle's postgres-js session routes **every** execution through
 *     `client.unsafe(query, params)` (`drizzle-orm/postgres-js/session.cjs`
 *     `:58`, `:68`, `:90`, `:128`, `:131` — all two-argument, none passing
 *     options), and
 *   - postgres-js `unsafe()` **hardcodes `prepare: false`**
 *     (`postgres@3.4.9/src/index.js:131-138`), which no drizzle call site can
 *     override because none passes an options object.
 *
 * So the issues-list statement is never a named prepared statement, PostgreSQL
 * always plans it custom against the actual bound values, and an `EXPLAIN`
 * carrying those same values reproduces the identical planning conditions. The
 * residual gap is only that statistics may move in the milliseconds between the
 * cancellation and this call. `EXPLAIN (GENERIC_PLAN)` is deliberately NOT used
 * here: it would describe a plan this driver can never cause.
 *
 * ## What this does NOT settle
 *
 * The planner's **chosen plan and its estimates**, never measured execution. It
 * answers "does production pick a different plan than the 218ms bench?" and not
 * "where did the 30s actually go?". If the shape comes back matching the bench,
 * the cause moves to data volume, bloat, cache occupancy or concurrency, and
 * `auto_explain` (PEN-5220) becomes the right next instrument. Record that
 * outcome — it is a finding, not a null.
 */

/**
 * Opt-in flag. Default **off**: this is a diagnostic for one open investigation,
 * not a permanent production behaviour. PEN-5223 box 5 requires an explicit
 * decision to turn it back off or to leave it on.
 */
export const ISSUE_LIST_EXPLAIN_FLAG = "PAPERCLIP_EXPLAIN_TIMED_OUT_ISSUE_LIST";

/**
 * `EXPLAIN` options, as a module constant so "never ANALYZE" is a property of
 * the code rather than of a caller's discipline.
 *
 * ⛔ **`ANALYZE` must never appear here.** `ANALYZE` *executes* the statement,
 * which would re-run a query that already burned the full 30s `statement_timeout`
 * — doubling the cost of the very incident this is diagnosing, on a request that
 * has already failed. `BUFFERS` is likewise absent: without `ANALYZE` it reports
 * nothing. `issue-list-timeout-explain.test.ts` asserts this string.
 */
export const ISSUE_LIST_EXPLAIN_OPTIONS = "FORMAT TEXT, VERBOSE, COSTS, SETTINGS";

/**
 * Bound on the `EXPLAIN` itself, well under the role-level 30s
 * `statement_timeout` the original statement just exhausted.
 *
 * Planning is normally sub-millisecond, but a planner pass over a pathological
 * statement must not become a *second* stall on an error path the tenant is
 * already waiting on. Applied as `SET LOCAL` inside the diagnostic's own
 * transaction, so it reverts with that transaction and can never leak onto a
 * pooled connection serving ordinary traffic.
 *
 * ⚠️ It bounds the EXPLAIN, NOT the connection checkout that precedes it — and
 * a `57014` burst is precisely when the pool is most contended, so that wait
 * can be long. The caller does not await this capture for exactly that reason,
 * so the delay lands on the diagnostic rather than on the tenant's response.
 */
export const ISSUE_LIST_EXPLAIN_TIMEOUT_MS = 2_000;

/**
 * Hard per-process cap on captures.
 *
 * The flag alone is not a bound — a flag left on through an incident would fire
 * this on every `57014` indefinitely, adding load to a database already shedding
 * it. The question needs one representative plan, not a stream, so the cap is
 * low and deliberately *not* configurable. Process-local by design: a restart
 * resetting it is the correct behaviour for a diagnostic that must survive a
 * roll to capture anything at all.
 */
export const ISSUE_LIST_EXPLAIN_MAX_CAPTURES = 5;

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSEY_FLAG_VALUES = new Set(["", "0", "false", "no", "off", "disabled"]);

let capturesTaken = 0;

/** Reset the per-process capture budget. Exported for tests only. */
export function resetIssueListExplainCaptureBudget(): void {
  capturesTaken = 0;
}

/** Captures taken so far in this process. Exported for tests and for logging. */
export function issueListExplainCapturesTaken(): number {
  return capturesTaken;
}

/**
 * Read the opt-in flag.
 *
 * An unrecognized value logs and leaves the diagnostic **off**, matching the
 * `PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD` idiom: failing toward the
 * default is what keeps a typo from silently enabling extra database work.
 */
export function issueListExplainEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ISSUE_LIST_EXPLAIN_FLAG]?.trim().toLowerCase();
  if (raw === undefined) return false;
  if (TRUTHY_FLAG_VALUES.has(raw)) return true;
  if (!FALSEY_FLAG_VALUES.has(raw)) {
    logger.warn(
      { value: raw },
      `${ISSUE_LIST_EXPLAIN_FLAG} is set to an unrecognized value; the timed-out `
        + "issues-list EXPLAIN capture remains DISABLED. Use one of: "
        + [...TRUTHY_FLAG_VALUES].join(", "),
    );
  }
  return false;
}

/** True when `error` is a PostgreSQL `57014` (`query_canceled`). */
export function isStatementTimeoutError(error: unknown): boolean {
  return findPgError(error)?.code === STATEMENT_TIMEOUT_SQLSTATE;
}

/**
 * Minimal surface this needs from a drizzle database handle, declared
 * structurally so the test suite can drive it without a live PostgreSQL.
 */
export type ExplainCapableDb = {
  transaction: <T>(fn: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<T>) => Promise<T>;
};

/** A drizzle query builder — anything that can render itself to SQL. */
export type ExplainableQuery = { getSQL: () => SQL };

/**
 * Build the `EXPLAIN` statement for a drizzle query builder.
 *
 * Composes the builder's own `SQL` into the template rather than reading its
 * text: drizzle renumbers the placeholders and carries the parameters verbatim,
 * so there is no string surgery, no `sql.unsafe`, and no parameter re-binding.
 * The statement explained is by construction the one that was executed — not a
 * transcription of it, which is the flaw in reading the shape off the
 * `packages/db` bench instead.
 */
export function buildIssueListExplainQuery(query: ExplainableQuery): SQL {
  return sql`EXPLAIN (${sql.raw(ISSUE_LIST_EXPLAIN_OPTIONS)}) ${query.getSQL()}`;
}

/**
 * Render an `SQL` to its statement text and bound parameters.
 *
 * The text carries `$1`-style placeholders and is what identifies the captured
 * plan as the issues-list SEARCH variant (the class-A discriminator PEN-3596
 * keys on). The parameters are read ONLY to redact them back out of the plan
 * (see {@link redactBoundValues}) — they are never logged.
 */
function renderExplain(query: SQL): { sql: string; params: unknown[] } | null {
  try {
    const { sql: text, params } = new PgDialect().sqlToQuery(query);
    return { sql: text, params };
  } catch {
    return null;
  }
}

/**
 * Strip user data out of `EXPLAIN` output, in two passes.
 *
 * ⚠️ **PostgreSQL inlines the bound values into the plan text.** Because this
 * statement is always planned *custom* (see the module doc), `Index Cond` and
 * `Filter` lines carry the literal values:
 *
 * ```
 * Filter: ((issues.title ~~* '%a-user-search-term%'::text) OR ...)
 * ```
 *
 * So rendering the statement with placeholders is NOT sufficient to honour the
 * "never log bound parameter values" constraint — the plan leaks them on its
 * own, with nothing at the call site hinting that it does. Caught against a
 * real server; a mocked database returns a canned plan string and cannot see it.
 *
 * ## Pass 1 — map known parameters to their placeholders, LONGEST FIRST
 *
 * Order is load-bearing, and index order is wrong. A short parameter that is a
 * substring of a longer one fragments it: `?status=blocked&q=blocked prod
 * deploy` binds `'blocked'` BEFORE `'%blocked prod deploy%'` (status is pushed
 * into `conditions` ahead of `issueSearchMatchCondition` in `list()`), so
 * substituting in index order yields
 *
 * ```
 * Filter: (issues.title ~~* '%$1 prod deploy%'::text)
 * ```
 *
 * — the rest of the user's search term, in clear. Worse, the whole pattern no
 * longer appears, so a fail-closed check that looks for the WHOLE parameter is
 * satisfied and the plan is logged. Longest-first removes the containing value
 * before anything can fragment it.
 *
 * ## Pass 2 — blank every literal that is not exactly a placeholder
 *
 * Pass 1 alone would still be an argument about substring order, and the leak
 * above is what that argument costs when it is wrong. This pass does not depend
 * on knowing the parameters at all: any single-quoted literal whose content is
 * not exactly `$n` is replaced with `'?'`, so a fragment left by ANY mechanism —
 * a future change to pass 1, a constant the planner inlined from somewhere else
 * — is removed regardless.
 *
 * The plan SHAPE survives: PostgreSQL double-quotes identifiers, so table,
 * column, index and function names are untouched, and costs, row estimates,
 * widths, node types and operators are never quoted.
 *
 * The `Settings:` line is the ONE exception, and it is excluded by name.
 * `ISSUE_LIST_EXPLAIN_OPTIONS` asks for `SETTINGS` precisely because a non-default
 * planning GUC is often WHY the planner chose what it chose — and PostgreSQL
 * prints that line with quoted values:
 *
 * ```
 * Settings: work_mem = '64MB', random_page_cost = '1.1'
 * ```
 *
 * so a blanket pass 2 would reduce the one option asked for to a list of names
 * and silently make it useless. Those values are server configuration and can
 * carry no user data, so skipping them widens nothing — and `containsBoundValue`
 * still scans the whole text including this line, so the fail-closed guarantee is
 * unchanged even there.
 */
export function redactBoundValues(text: string, params: readonly unknown[]): string {
  const stringParams = params
    .map((param, index) => ({ param, placeholder: `$${index + 1}` }))
    .filter((entry): entry is { param: string; placeholder: string } =>
      typeof entry.param === "string" && entry.param.length > 0)
    // Longest first. See pass 1 above — index order fragments.
    .sort((a, b) => b.param.length - a.param.length);

  let redacted = text;
  for (const { param, placeholder } of stringParams) {
    // Matched both raw and PG-quoted (`'` doubled), which is how the server
    // renders a literal containing a quote.
    for (const form of [param.replaceAll("'", "''"), param]) {
      redacted = redacted.split(form).join(placeholder);
    }
  }
  return stripNonPlaceholderLiterals(redacted);
}

/**
 * Replace every single-quoted literal whose content is not exactly a `$n`
 * placeholder with `'?'`. Pass 2 of {@link redactBoundValues}.
 *
 * `(?:[^']|'')*` consumes PG's doubled-quote escape, so a literal containing a
 * quote is matched whole rather than ending early and leaving its tail behind.
 */
function stripNonPlaceholderLiterals(text: string): string {
  return text
    .split("\n")
    // `Settings:` carries server GUCs, never bound values — see pass 2 above.
    .map((line) => (SETTINGS_LINE_PATTERN.test(line) ? line : stripLiteralsInLine(line)))
    .join("\n");
}

/**
 * The `EXPLAIN (SETTINGS)` line. In `FORMAT TEXT` it is a single line listing
 * every planning GUC that differs from its built-in default. Verified against a
 * real server: `Settings: work_mem = '64MB', random_page_cost = '1.1'`.
 */
const SETTINGS_LINE_PATTERN = /^\s*Settings:\s/;

function stripLiteralsInLine(line: string): string {
  return line.replace(/'((?:[^']|'')*)'/g, (literal, inner: string) =>
    /^\$\d+$/.test(inner) ? literal : "'?'");
}

/**
 * Fail-closed check that redaction actually worked.
 *
 * Deliberately a DIFFERENT mechanism from the redaction above — it looks for a
 * surviving parameter anywhere in the text, including outside a quoted literal,
 * where neither pass would have reached it. A check that merely inverted the
 * redaction could only ever agree with it, which is how the fragmentation leak
 * above went unnoticed: the plan was logged with a satisfied guard.
 *
 * If any string parameter still appears, the plan is withheld entirely. Losing
 * a diagnostic is recoverable; logging a user's search term is not.
 */
export function containsBoundValue(text: string, params: readonly unknown[]): boolean {
  return params.some((param) => typeof param === "string" && param.length > 0 && text.includes(param));
}

function planTextFromRows(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const lines = rows
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>)["QUERY PLAN"] : null))
    .filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Capture and log the plan of an issues-list statement that just hit `57014`.
 *
 * **Never throws.** The tenant already has a failing request in flight; a
 * diagnostic that raises on top of it converts a slow list into a different,
 * worse defect. Every failure path — flag read, budget, transaction, planner
 * error, malformed result — is swallowed and reported at most as a `warn`.
 *
 * **Never logs bound parameter values.** They are user-entered search terms.
 * The rendered SQL carries `$1`-style placeholders only, which is what the
 * class-A discriminator needs (issues-list column set with
 * `substring("description"`, and the `ILIKE ... ESCAPE` arms); the values add
 * nothing to a plan shape. `searchTermLength` is recorded instead of the term,
 * because selectivity is a function of length and the length is not the input.
 */
export async function captureTimedOutIssueListPlan(options: {
  db: ExplainCapableDb;
  query: ExplainableQuery;
  error: unknown;
  companyId: string;
  hasSearch: boolean;
  searchTermLength: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { db, query, error, companyId, hasSearch, searchTermLength, env } = options;
  try {
    if (!isStatementTimeoutError(error)) return;
    if (!issueListExplainEnabled(env)) return;
    if (capturesTaken >= ISSUE_LIST_EXPLAIN_MAX_CAPTURES) return;
    // Claim the slot BEFORE awaiting. Concurrent list requests can time out
    // together — incrementing after the await would let every one of them pass
    // the check and overshoot the cap by the width of the burst.
    capturesTaken += 1;
    const capture = capturesTaken;

    const explain = buildIssueListExplainQuery(query);
    const startedAt = Date.now();
    const rows = await db.transaction(async (tx) => {
      // SET LOCAL, not SET: reverts with this transaction, so the tightened
      // bound can never leak onto a pooled connection serving ordinary traffic.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${ISSUE_LIST_EXPLAIN_TIMEOUT_MS}ms'`));
      return tx.execute(explain);
    });
    const rawPlan = planTextFromRows(rows);
    if (!rawPlan) {
      logger.warn(
        { capture, companyId },
        "issue-list statement_timeout EXPLAIN returned no QUERY PLAN rows",
      );
      return;
    }
    const rendered = renderExplain(explain);
    const params = rendered?.params ?? [];
    const plan = redactBoundValues(rawPlan, params);
    const statement = rendered ? redactBoundValues(rendered.sql, params) : null;
    // Fail closed: withhold rather than risk logging a user-entered search term.
    if (containsBoundValue(plan, params) || (statement && containsBoundValue(statement, params))) {
      logger.warn(
        { capture, companyId },
        "issue-list statement_timeout EXPLAIN withheld: bound values survived redaction (PEN-5223)",
      );
      return;
    }
    logger.warn(
      {
        capture,
        captureBudget: ISSUE_LIST_EXPLAIN_MAX_CAPTURES,
        companyId,
        hasSearch,
        searchTermLength,
        explainMs: Date.now() - startedAt,
        // Placeholders only — never the bound values. See `redactBoundValues`.
        statement,
        plan,
      },
      "issue-list statement_timeout: captured production query plan (PEN-5223)",
    );
  } catch (captureError) {
    // Swallow. The caller is already rethrowing the original 57014.
    logger.warn(
      { err: captureError, companyId },
      "issue-list statement_timeout EXPLAIN capture failed; original error is unaffected",
    );
  }
}
