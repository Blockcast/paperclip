/**
 * PEN-6670 done-when 2: a production-SCALE seeded plan-shape measurement for
 * `runsForIssue`, the query behind `GET /api/issues/:id/runs`.
 *
 * ⚠️ WHAT THIS IS AND IS NOT. The row's done-when 2 asks for an
 * `EXPLAIN (ANALYZE, BUFFERS)` "at production row counts, before and after",
 * and names it the missing measurement. No engineering seat holds a production
 * SQL path — the same constraint PEN-3596 hit, recorded in
 * `issues-list-production-scale-plan-shape.bench.ts`, where the CTO chose this
 * substitution explicitly rather than stand up a production DB credential. The
 * row suggested "whoever has one at the PEN-2956 window can take it cheaply";
 * on the evidence of that file there is no such seat, so this is the
 * substitution rather than a placeholder waiting for a better one.
 *
 *   ⛔ SEEDED STATISTICS AND BLOAT ARE NOT PRODUCTION'S. This is evidence
 *      about PLAN SHAPE — which access path the planner picks, and how many
 *      rows each one reads and throws away — NOT about production latency. Do
 *      not quote its milliseconds as production numbers. Every buffer below is
 *      a `shared hit`: the seed is fully cached and production is not.
 *
 * ── SEED ───────────────────────────────────────────────────────────────────
 *
 * `heartbeat_runs` is the population that matters, because the defect's cost
 * scales with it. 905,000 is `table-size-estimates.ts` (3,620 local rows x the
 * 250 factor, collected 2026-07-06) — an ESTIMATE, not a live count, and four
 * months stale in the direction of being too small.
 *
 *   heartbeat_runs ... 905,300 seeded; 481 of them name the target issue.
 *   activity_log ..... 1,810,625 seeded, i.e. 2 rows per run. The same
 *                      estimate puts production at ~5.7M. UNDER-SEEDED, and
 *                      stated rather than buried: arm 2 is an index range scan
 *                      bounded by the ISSUE's rows, so total table size reaches
 *                      it only through index depth. It does not change which
 *                      access path either shape gets.
 *   one company ...... The defect is company-scoped and a single company is its
 *                      WORST case, so this is the right seed here — unlike the
 *                      PEN-3596 corpus, where a single company could not
 *                      measure a company-scoping change at all.
 *
 *   Seed cost: ~9 min. Both shapes return the SAME 506 rows (asserted below
 *   before anything is timed — a faster query that returns different rows is
 *   a bug, not a fix).
 *
 * ── RESULT, measured 2026-11-14 at the defaults below ──────────────────────
 *
 *   BEFORE  1,369.8 ms   48,522 buffers (576 hit + 47,946 read)
 *   AFTER      16.3 ms    2,603 buffers (all hit)
 *                         ~84x faster, ~19x fewer buffers
 *
 * BEFORE (`or(context match, exists(correlated))`, no LIMIT):
 *
 *   Index Scan using heartbeat_runs_company_created_at_desc_idx
 *     Index Cond: (company_id = ...)                     <- the WHOLE company
 *     Filter: ((context_snapshot ->> 'issueId') = ... OR (ANY (id = (hashed SubPlan 2).col1)))
 *     Rows Removed by Filter: 904,794                    <- of 905,300, to return 506
 *
 * AFTER (union arms + LIMIT 500):
 *
 *   HashAggregate  (506 rows, 578 buffers)
 *     ->  Append
 *           ->  Index Scan using heartbeat_runs_company_issueid_idx    (481 rows, 198 buf)
 *           ->  Index Scan using activity_log_entity_type_id_idx       (987 rows, 380 buf)
 *     ->  Index Scan using heartbeat_runs_pkey  (506 loops, 2,024 buf)
 *
 * ⚠️ Note the AFTER row count: 500, not 506. The seed gave the target issue
 * more runs than `DEFAULT_ISSUE_RUNS_LIMIT`, so the cap is visibly doing its
 * job here. That is the second, independent bound, not the fix.
 *
 * ⭐ THE MECHANISM IS NOT THE ONE THE SHAPE SUGGESTS, and the plan says so.
 * PostgreSQL PULLS THE CORRELATED `exists(...)` UP into an uncorrelated
 * `hashed SubPlan` — it runs ONCE, in ~4 ms, not once per outer row. So
 * "de-correlate the EXISTS" is not the fix and would buy nothing; this is the
 * same lead PEN-3596 refuted on its own query. What the semi-join actually
 * costs is REACHABILITY: it cannot take part in a `BitmapOr`, so the whole
 * disjunction can only be applied as a per-row FILTER, and the only access
 * path left for the outer scan is `company_id` alone. The partial expression
 * index built for arm 1 (`heartbeat_runs_company_issueid_idx`, migration 0077)
 * is never chosen. Removing the semi-join FROM THE DISJUNCTION is what makes
 * the other arm indexable — that is the whole fix.
 *
 * ⚠️ THIS DOES NOT REPRODUCE THE 30 s PRODUCTION TIMEOUT, and the gap is not
 * explained here. 1.4 s seeded against a 30 s `statement_timeout` leaves a
 * ~22x constant factor in bloat, cache occupancy, concurrency, the real
 * `activity_log` size, and the full 27-column TOAST-heavy projection (this
 * bench selects a 5-key subset of the `usage_json` reconciliation, so its
 * milliseconds are a LOWER bound on the real statement's). The fix ships
 * because it removes the DEPENDENCE on the company's run count, which grows
 * monotonically — not because this file reproduced the timeout.
 *
 * ── THE CONTROL ARM, AND IT REFUTED THE OBVIOUS SECOND FIX ─────────────────
 *
 * `backfillMissingRunLivenessForIssue` in the same file carries the SAME
 * `or(context match, exists(correlated))` shape and is fired by `runsForIssue`
 * on every call, so it reads like a second instance of the defect. It is not,
 * and this arm is why it was left alone:
 *
 *   BACKFILL as shipped ...... total cost 18.68, 3 buffers, 0.077 ms
 *   BACKFILL rewritten ....... total cost 9,545.42 for the same 3 buffers and
 *                              the same answer — WORSE, by 500x on cost
 *
 * The predicate above it is different: `heartbeat_runs_company_liveness_idx`
 * (migration 0058) drives the query off `liveness_state IS NULL`, so the OR
 * never has to be the access path, the EXISTS degrades to a cheap point probe
 * on `activity_log_run_id_idx` per candidate row, and `limit(20)` is a real
 * bound. Rewriting it to the union arms makes the planner build the issue's
 * whole id set to answer what one index probe already answers.
 *
 * ⭐ The transferable half: an OR-over-a-correlated-EXISTS is not by itself the
 * defect. It is only a defect when it is the ACCESS PATH — when no other
 * predicate in the WHERE can drive the scan. Check what else is in the WHERE
 * before pattern-matching on the OR.
 */
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Scale knobs. The defaults ARE the production shape and are what the numbers
 * above were taken at; the overrides exist so the SQL can be smoke-tested in
 * seconds before committing to a ~10-minute seed. ⛔ A result taken at an
 * override is not a production-shape result.
 */
const scale = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};
const COMPANY_RUNS = scale("PEN6670_COMPANY_RUNS", 905_000);
const TARGET_ISSUE_RUNS = scale("PEN6670_TARGET_ISSUE_RUNS", 300);
const OTHER_ISSUES = scale("PEN6670_OTHER_ISSUES", 5_000);

/** The defective shape, as it stood at master before PEN-6670. */
const BEFORE_WHERE = `
  hr.company_id = $1
  and ( hr.context_snapshot ->> 'issueId' = $2
        or exists ( select 1 from activity_log al
                     where al.company_id = $1
                       and al.entity_type = 'issue'
                       and al.entity_id = $2
                       and al.run_id = hr.id ) )`;

/** The shipped shape. Mirrors `issueRunIdsSubquery()` in server/src/services/activity.ts. */
const AFTER_WHERE = `
  hr.company_id = $1
  and hr.id in (
        select heartbeat_runs.id from heartbeat_runs
         where heartbeat_runs.company_id = $1
           and heartbeat_runs.context_snapshot ->> 'issueId' = $2
        union
        select activity_log.run_id from activity_log
         where activity_log.company_id = $1
           and activity_log.entity_type = 'issue'
           and activity_log.entity_id = $2
           and activity_log.run_id is not null
      )`;

/**
 * A subset of the service's projection. The real one reconciles ~20
 * camelCase/snake_case pairs out of `usage_json` and `result_json`; this keeps
 * the TOAST access without 5.7 KB of SQL, which is why the absolute
 * milliseconds here are a LOWER bound on the real statement's.
 */
const PROJECTION = `
  hr.id, hr.status, hr.agent_id, a.adapter_type, hr.started_at, hr.finished_at,
  hr.created_at, hr.invocation_source, hr.error_code, hr.log_bytes,
  case when hr.usage_json is null then null else jsonb_strip_nulls(jsonb_build_object(
    'inputTokens', coalesce(hr.usage_json -> 'inputTokens', hr.usage_json -> 'input_tokens'),
    'input_tokens', coalesce(hr.usage_json -> 'input_tokens', hr.usage_json -> 'inputTokens'),
    'outputTokens', coalesce(hr.usage_json -> 'outputTokens', hr.usage_json -> 'output_tokens'),
    'output_tokens', coalesce(hr.usage_json -> 'output_tokens', hr.usage_json -> 'outputTokens'),
    'costUsd', coalesce(hr.usage_json -> 'costUsd', hr.usage_json -> 'cost_usd')
  )) end as usage_summary`;

const statement = (where: string, limit: string) => `select ${PROJECTION}
    from heartbeat_runs hr
    inner join agents a on (a.id = hr.agent_id and a.company_id = hr.company_id)
    where ${where}
    order by hr.created_at desc${limit}`;

async function main() {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) {
    console.error(`embedded Postgres unavailable here: ${support.reason ?? "unsupported environment"}`);
    process.exit(1);
  }

  console.log("starting embedded postgres (applies all migrations)…");
  const bootStart = Date.now();
  const database = await startEmbeddedPostgresTestDatabase("pen6670-plan-shape-");
  console.log(`  up + migrated in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  const sql = postgres(database.connectionString, { max: 1, max_lifetime: 24 * 3600, idle_timeout: 0 });

  try {
    // Above the 30s production role bound on purpose: the BEFORE arm has to be
    // allowed to COMPLETE so its plan can be read.
    await sql`set statement_timeout = '300s'`;

    console.log(`seeding ${COMPANY_RUNS.toLocaleString()} runs…`);
    const seedStart = Date.now();
    const [{ id: companyId }] = await sql<{ id: string }[]>`
      insert into companies (name) values ('PEN-6670 plan shape') returning id`;
    const [{ id: agentId }] = await sql<{ id: string }[]>`
      insert into agents (company_id, name, role, adapter_type)
      values (${companyId}, 'Engineer', 'engineer', 'claude_k8s') returning id`;

    await sql`
      insert into issues (company_id, title, status, issue_number, identifier)
      select ${companyId}, 'issue ' || g, 'done', g, 'PEN6670LAB-' || g
      from generate_series(1, ${OTHER_ISSUES + 1}) g`;
    const [{ id: targetIssueId }] = await sql<{ id: string }[]>`
      select id from issues where company_id = ${companyId} and issue_number = 1`;

    // The company's whole run history, spread over its issues. The issue ids are
    // resolved ONCE into a CTE: a correlated per-row lookup makes the seed
    // quadratic and takes it from ~90s to "still going after ten minutes".
    await sql`
      with ids as (
        select id, (row_number() over (order by issue_number) - 1) as rn
        from issues where company_id = ${companyId}
      )
      insert into heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot, usage_json, liveness_state)
      select ${companyId}, ${agentId}, 'completed',
             now() - (g || ' minutes')::interval,
             jsonb_build_object('issueId', ids.id::text, 'agentName', 'engineer'),
             jsonb_build_object('inputTokens', g, 'outputTokens', g * 2, 'costUsd', 0.01),
             'advanced'
      from generate_series(1, ${COMPANY_RUNS}) g
      join ids on ids.rn = (g % ${OTHER_ISSUES})`;

    await sql`
      insert into heartbeat_runs (company_id, agent_id, status, created_at, context_snapshot, usage_json, liveness_state)
      select ${companyId}, ${agentId}, 'completed',
             now() - (g || ' minutes')::interval,
             jsonb_build_object('issueId', ${targetIssueId}::text, 'agentName', 'engineer'),
             jsonb_build_object('inputTokens', g, 'outputTokens', g * 2, 'costUsd', 0.01),
             'advanced'
      from generate_series(1, ${TARGET_ISSUE_RUNS}) g`;

    // Two activity rows per run, against the issue that run worked — what the
    // real writers do.
    for (const action of ["issue.updated", "issue.comment_added"]) {
      await sql`
        insert into activity_log (company_id, actor_id, action, entity_type, entity_id, run_id, created_at)
        select ${companyId}, ${agentId}::text, ${action}, 'issue',
               hr.context_snapshot ->> 'issueId', hr.id, hr.created_at
        from heartbeat_runs hr where hr.company_id = ${companyId}`;
    }

    // The target issue additionally gets activity rows pointing at runs that do
    // NOT name it in their context snapshot. This is the whole reason arm 2
    // exists, and without it the bench would not test the union at all.
    await sql`
      insert into activity_log (company_id, actor_id, action, entity_type, entity_id, run_id, created_at)
      select ${companyId}, ${agentId}::text, 'issue.comment_added', 'issue', ${targetIssueId}::text,
             hr.id, now() - (row_number() over () || ' minutes')::interval
      from heartbeat_runs hr
      where hr.company_id = ${companyId}
        and hr.context_snapshot ->> 'issueId' <> ${targetIssueId}::text
      limit 25`;

    console.log(`  seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)}s; analyzing…`);
    await sql`analyze`;

    const [counts] = await sql<{ runs: number; activity: number; target_runs: number; target_activity: number }[]>`
      select (select count(*) from heartbeat_runs)::int as runs,
             (select count(*) from activity_log)::int as activity,
             (select count(*) from heartbeat_runs
               where context_snapshot ->> 'issueId' = ${targetIssueId}::text)::int as target_runs,
             (select count(distinct run_id) from activity_log
               where entity_type = 'issue' and entity_id = ${targetIssueId}::text)::int as target_activity`;
    console.log("corpus:", JSON.stringify(counts));

    // ── correctness first: a faster query that returns different rows is a bug ──
    const beforeIds = await sql.unsafe(
      `select hr.id from heartbeat_runs hr where ${BEFORE_WHERE} order by hr.id`,
      [companyId, targetIssueId],
    );
    const afterIds = await sql.unsafe(
      `select hr.id from heartbeat_runs hr where ${AFTER_WHERE} order by hr.id`,
      [companyId, targetIssueId],
    );
    const identical =
      beforeIds.length === afterIds.length &&
      beforeIds.every(
        (row, i) =>
          (row as unknown as { id: string }).id === (afterIds[i] as unknown as { id: string }).id,
      );
    console.log(`\nCORRECTNESS: before=${beforeIds.length} rows, after=${afterIds.length} rows, identical=${identical}`);
    if (!identical) throw new Error("the rewrite changes which rows come back — do not ship");

    const results: { label: string; execution: string; buffers: string }[] = [];
    async function explain(label: string, stmt: string) {
      await sql.unsafe(`explain (analyze, buffers) ${stmt}`, [companyId, targetIssueId]); // warm
      let printed = "";
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const out = await sql.unsafe(`explain (analyze, buffers) ${stmt}`, [companyId, targetIssueId]);
        const text = out.map((row) => (row as Record<string, string>)["QUERY PLAN"]).join("\n");
        if (i === 0) printed = text;
        const match = /Execution Time: ([\d.]+) ms/.exec(text);
        if (match) times.push(Number(match[1]));
      }
      console.log(`\n${"─".repeat(78)}\n${label}\n${"─".repeat(78)}`);
      console.log(printed);
      const median = times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? Number.NaN;
      // The whole line: a plan that READS is the interesting case, and
      // matching `shared hit=` alone silently drops `read=` from the total.
      const topBuffers = /Buffers: ([^\n]+)/.exec(printed)?.[1] ?? "?";
      console.log(`execution: ${times.map((t) => `${t.toFixed(1)}ms`).join(", ")}`);
      results.push({ label, execution: `${median.toFixed(1)} ms`, buffers: topBuffers });
    }

    await explain("BEFORE — or + correlated exists, no LIMIT", statement(BEFORE_WHERE, ""));
    await explain("AFTER — union arms + LIMIT 500", statement(AFTER_WHERE, " limit 500"));

    // The control arm. See the header: this is why the backfill was left alone.
    const backfillSelect = "select hr.id, hr.status, hr.context_snapshot from heartbeat_runs hr";
    const backfillFilter = "hr.liveness_state is null and hr.status not in ('queued','running')";
    await explain(
      "CONTROL — backfillMissingRunLivenessForIssue AS SHIPPED (or + exists, limit 20)",
      `${backfillSelect} where ${BEFORE_WHERE} and ${backfillFilter} limit 20`,
    );
    await explain(
      "CONTROL — the same rewritten to union arms (NOT shipped; worse)",
      `${backfillSelect} where ${AFTER_WHERE} and ${backfillFilter} limit 20`,
    );

    console.log(`\n${"=".repeat(78)}\nSUMMARY — median of 3, after a warm-up run\n${"=".repeat(78)}`);
    for (const r of results) {
      console.log(`  ${r.label}\n      ${r.execution.padStart(10)}   Buffers: ${r.buffers}`);
    }
    console.log("\nSeed counts:", JSON.stringify(counts));
  } finally {
    await sql.end();
    await database.cleanup();
  }
}

await main();
