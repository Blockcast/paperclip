/**
 * PEN-3596 done-when 1, substitution (b): a production-SCALE seeded plan-shape
 * measurement for the issues-list query.
 *
 * ⚠️ WHAT THIS IS AND IS NOT. The row's done-when 1 asks for an
 * `EXPLAIN (ANALYZE, BUFFERS)` "at the production row counts". Nobody on the
 * engineering seats holds a production SQL path — `kubectl auth can-i create
 * pods/exec -n paperclip` is `no` for both the Engineer and the CTO seats, and
 * the two remediator jobs that do reach the cluster go through Prometheus and
 * `kubectl` only, with no `DATABASE_URL`. The CTO chose this substitution
 * explicitly on 2026-10-30 rather than stand up a new production DB credential
 * path, six days after the org declined a weaker privilege widening
 * (BLO-47427). The weakness is stated rather than buried:
 *
 *   ⛔ SEEDED STATISTICS AND BLOAT ARE NOT PRODUCTION'S. This is evidence
 *      about PLAN SHAPE — which access path the planner picks at these row
 *      counts — and NOT about production latency. Do not quote its
 *      milliseconds as production numbers.
 *
 * ⚠️ TWO OF THE THREE SEED COUNTS ARE UNVERIFIED. `issues` is the one solid
 * figure: 54,596 live tuples, read from
 * `pg_paperclip_table_mvcc_n_live_tup{relname="issues"}` on 2026-10-30T13:32Z,
 * so the 54,600 below is within 0.01%. The exporter login holds SELECT on only
 * a handful of tables and was deliberately denied `pg_read_all_stats` under
 * BLO-47427, so NO metric exists for the other two:
 *
 *   issue_comments ... 1,260,000 seeded. Production figure ~1.26M comes from a
 *                      "table-size-estimates" artifact cited by migration 0269
 *                      that nobody has since been able to locate. UNVERIFIED.
 *   activity_log ..... 1,000,000 seeded. NO production figure exists at all —
 *                      this count is a STIPULATION, chosen as ~18 rows/issue.
 *                      Treat every activity_log result here as scale-sensitive
 *                      and re-run if a real count ever lands.
 *
 * ⭐ WHY activity_log IS SEEDED AT ALL — this is the gap that motivated the
 * rebuild rather than re-running the existing harness. Every prior PEN-3596
 * seed (`issues-list-search-cost-shape.test.ts`, and the seeds behind both
 * 0268's and 0269's headers) inserted ZERO activity_log rows. The ORDER BY
 * those queries ran therefore evaluated its third `GREATEST(...)` arm against
 * an EMPTY TABLE. That arm is the one migration 0098 exists for, it is named
 * in this row's opening evidence, and it is the arm that the class-C
 * (no-search) timeouts — 19 of the 69 classified on PEN-5019, and all three
 * post-deploy timeouts on 2026-10-30 — have to pay. It had never once been
 * measured with rows in it.
 *
 * Run it (NOT a vitest file — `.bench.ts` is outside the test glob, so CI does
 * not run it; it takes ~10-20 minutes and several GB of disk):
 *
 *   cd packages/db && pnpm tsx src/issues-list-production-scale-plan-shape.bench.ts
 *
 * Shapes measured, all four lifted from the SHIPPED query on master (the
 * post-0268 union restructure), not from the pre-0268 text quoted on the row:
 *
 *   A. comment arm alone, composite present vs. pre-0269 un-scoped index.
 *      This is the narrow question the CTO asked: does the planner pick
 *      `issue_comments_company_body_search_idx`, or a BitmapAnd of the
 *      un-scoped trigram index with `issue_comments_company_idx`?
 *   B. full issues-list SEARCH variant (`?q=`), the shape done-when 1 is
 *      being re-scoped to name.
 *   C. full issues-list NO-SEARCH variant — the shape actually timing out in
 *      production post-deploy, and the one 0269 is structurally incapable of
 *      touching (no `body` predicate ⇒ no trigram index is reachable).
 *   D. shape C with the ORDER BY served from `issues.last_activity_at`
 *      instead of the `GREATEST(...)`. ⭐ UPDATED 2026-11-01 (PEN-5213): the
 *      CTO picked this option and it is now the SHIPPED default ordering. The
 *      "D is not semantically equal to C" caveat recorded below was true when
 *      D was measured and is now closed: migration 0270 adds the missing
 *      `activity_log` maintenance arm and repairs the accumulated drift, and
 *      `issues-last-activity-at-activity-log-maintenance.test.ts` asserts the
 *      column equals the (now deleted) expression on every maintenance path.
 *   E. the `sortField=updated` ordering, before (E1) and after (E2) the same
 *      repoint. This is the ONLY no-search ordering that
 *      `issues_company_last_activity_idx` can serve: the default ordering
 *      leads with the priority CASE, which that index does not carry.
 *
 * ── MEASURED 2026-10-30, at the seed counts this file's defaults produce ───
 *
 * Actual counts (what the run printed, not the targets above): 54,600 issues
 * / 4,900 in the searched company; 1,255,800 comments, of which the term
 * matches 125,580 globally and 11,270 inside the searched company — a
 * cross-company amplification of 11.1x, nearly double the 6.0x the seed
 * behind migration 0269's header could produce; 982,800 activity_log rows.
 * Embedded Postgres 18.1, shared_buffers 128MB, work_mem 4MB.
 *
 * ⭐ A · THE COMPOSITE IS CHOSEN, AND THE INDEX IT REPLACED IS WORSE THAN
 * 0269's HEADER PREDICTED.
 *
 *   A1, shipped (0269 composite) ...... 218 ms
 *   A2, pre-0269 (un-scoped index) ... 8263 ms      ← 37.9x
 *
 * A1 answers the question directly: the planner picks
 * `issue_comments_company_body_search_idx` and puts BOTH halves in the index
 * cond —
 *
 *   Bitmap Index Scan on issue_comments_company_body_search_idx
 *     Index Cond: ((company_id = '…') AND (body ~~* '%statement%'))
 *
 * — one index search, 506 index buffers, 11,270 heap blocks, all cache hits
 * and zero reads.
 *
 * ⚠️ A2 does NOT reproduce the mechanism 0269's header states. That header
 * predicted a `BitmapAnd` against `issue_comments_company_idx`, inferred from
 * a 6.0x seed. At 11.1x and 1.26M rows the planner does not BitmapAnd at all
 * — it scans the body-only index and applies company_id as a post-heap
 * FILTER, which is strictly worse:
 *
 *   Bitmap Heap Scan   Filter: (company_id = '…')   Rows Removed by Filter: 114,310
 *     Rows Removed by Index Recheck: 199,497
 *     Heap Blocks: exact=59,081 lossy=66,499        ← the bitmap went LOSSY
 *     Buffers: shared hit=715 read=126,330          ← vs 0 reads in A1
 *   ->  Bitmap Index Scan on issue_comments_body_search_idx
 *         Index Cond: (body ~~* '%statement%')      ← company_id absent
 *
 * The 125,580-row bitmap exceeds work_mem, so two thirds of the heap blocks
 * degrade to lossy and every tuple on those pages is re-checked. That is a
 * cliff, not a slope: it gets worse as the corpus grows, which is the shape
 * of the original production incident. The conclusion 0269 reached is right
 * and the evidence here is stronger than the evidence it shipped with — but
 * the stated mechanism should be read as "the company predicate cannot reach
 * the index", not specifically as "a BitmapAnd".
 *
 * ⚠️ BOTH regimes mis-estimate the comment arm by ~1000x: `rows=11` estimated
 * against 11,270 actual in A1, and `rows=126` against 125,580 in A2. The
 * composite makes the arm fast; it does NOT make it well-estimated. Anything
 * that joins this arm's output is planning against a three-order-of-magnitude
 * underestimate, so treat a future join-order surprise on this query as
 * expected rather than mysterious.
 *
 * ⭐ B · THE 0268 UNION RESTRUCTURE HOLDS AT PRODUCTION SCALE: 833 ms. All
 * four branches appear as independent `Bitmap Index Scan`s under one
 * `Append`, each on its own company-scoped composite, with company_id and the
 * ILIKE both in the index cond. Nothing degrades to a filter on a full scan,
 * which is the failure the restructure exists to remove. The comment arm is
 * 217 ms of the Append's 237 ms, so it dominates the search path even after
 * 0269 — which is the quantitative case for having company-scoped it.
 *
 * ⛔⛔ C · THE NO-SEARCH SHAPE DOES NOT REPRODUCE HERE, AND THAT IS THE MOST
 * IMPORTANT RESULT IN THIS FILE. 544 ms — nowhere near the 30 s role
 * `statement_timeout`, against a production shape where this variant HAS been
 * timing out (PEN-5019 class C: 19 of 69 classified timeouts, and all three
 * post-deploy timeouts on 2026-10-30).
 *
 * So the `GREATEST(...)` ORDER BY is NOT, by itself, the cause of the
 * class-C timeouts, and this is the first measurement that could have said
 * so — every prior seed ran that ORDER BY against an EMPTY activity_log.
 * With 982,800 rows in it, the plan is healthy:
 *
 *   SubPlan 2 (comments)     Index Only Scan Backward using
 *                            issue_comments_company_issue_created_at_idx
 *                            loops=4900, Heap Fetches 4900, 19,600 buffers
 *   SubPlan 3 (activity_log) Index Only Scan using
 *                            idx_activity_log_issue_company_entity_action_created
 *                            loops=4900, Heap Fetches 0, 20,053 buffers
 *
 * ⚠️ NOTE WHICH INDEX SERVES THE LOG ARM. It is
 * `idx_activity_log_issue_company_entity_action_created` — the partial index
 * on `(company_id, entity_id, action, created_at DESC, id DESC) WHERE
 * entity_type = 'issue'`, which carries the `action` column the NOT IN needs
 * and is therefore fully index-only (0 heap fetches). It is NOT migration
 * 0098's `idx_activity_log_entity_id_created`. The "0098 no longer holds"
 * reading in this row's opening evidence, and refuted-lead 1 in
 * `issues-list-search-cost-shape.test.ts`, both name 0098's index; at this
 * shape the planner does not use it. Do not re-chase 0098.
 *
 * ⛔ What this does NOT license. "Does not reproduce at 54,600 / 1.26M /
 * 982,800 with a cold-ish cache and no concurrency" is not "cannot happen".
 * The untested axes are exactly the ones a seed cannot carry: table bloat,
 * production cache occupancy, concurrent load, a company much larger than
 * 4,900 issues, and an activity_log whose real size NOBODY HAS MEASURED (the
 * 982,800 here is a stipulation — see the header above). The honest reading
 * is that the class-C timeouts want one of those explanations, not this one.
 *
 * ⚠️ D · THE MATERIALIZED-COLUMN ORDER BY IS WORTH ~18%, NOT AN ORDER OF
 * MAGNITUDE: 444 ms vs C's 544 ms. The buffer count collapses 193x
 * (39,859 -> 206) because both correlated subqueries disappear, and the wall
 * clock barely moves — because ~440 ms of both is the SAME work: the
 * `Bitmap Heap Scan` materialising 4,900 rows and running
 * `substring(description, 1, 1200)` over ~6KB of text each. Heap Blocks is
 * `exact=203` in both, so that cost is CPU (detoast + substring), not I/O.
 *
 * ⛔ Read this as a CEILING on the PEN-3596 2026-10-30T14:04Z proposal to
 * serve the ORDER BY from `issues.last_activity_at`, and note that D is the
 * OPTIMISTIC bound: it is measured WITHOUT the `activity_log` AFTER INSERT
 * trigger that option (b) would have to add to keep the ordering correct, and
 * that trigger costs one `UPDATE issues` per activity row on a hot insert
 * path. A change that buys 18% on the read side while adding write
 * amplification on the write side needs a better argument than this number
 * supplies. ⛔ Nothing here has been shipped; the decision is still open.
 */
import postgres from "postgres";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

/** The searched company, sized to the live PEN company (~4.9k of 54.6k issues). */
const COMPANY = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANIES = 19;
/**
 * Scale knobs. The defaults ARE the production shape and are what any quoted
 * result must have been taken at; the env overrides exist so the SQL can be
 * smoke-tested in seconds before committing to a ~15-minute seed. ⛔ A result
 * taken at an override is not a production-shape result — plan choice is
 * genuinely scale-dependent for this query (see the PEN-3596 cost-shape test
 * header: the planner picks the description trigram index at 54k rows and does
 * not at 400/1500/4000).
 */
const scale = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};
const TOTAL_ISSUES = scale("PEN3596_ISSUES", 54_600);
const SEARCHED_COMPANY_ISSUES = scale("PEN3596_SEARCHED_COMPANY_ISSUES", 4_900);
const TOTAL_COMMENTS = scale("PEN3596_COMMENTS", 1_260_000);
const TOTAL_ACTIVITY_LOG = scale("PEN3596_ACTIVITY_LOG", 1_000_000);
/** A COMMON term. The row's own evidence is that cost is term-dependent. */
const TERM = "statement";
const PATTERN = `%${TERM}%`;
const LIMIT = 15;

function companyUuid(index: number): string {
  return `33333333-3333-4333-8333-3333333${index.toString().padStart(5, "0")}`;
}

async function explain(sql: postgres.Sql, label: string, query: string, params: unknown[]) {
  // Three runs: the first pays cold-cache costs that say nothing about plan shape.
  let last = "";
  const timings: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const started = Date.now();
    const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`, params as never[]);
    timings.push(Date.now() - started);
    last = rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n");
  }
  const execution = /Execution Time: ([\d.]+) ms/.exec(last)?.[1] ?? "?";
  const planning = /Planning Time: ([\d.]+) ms/.exec(last)?.[1] ?? "?";
  console.log(`\n${"=".repeat(78)}\n### ${label}\n${"=".repeat(78)}`);
  console.log(`-- wall clock over 3 EXPLAIN ANALYZE runs: ${timings.join("ms, ")}ms`);
  console.log(`-- planning ${planning} ms / execution ${execution} ms (last run)\n`);
  console.log(last);
  return { label, execution, planning, plan: last };
}

/**
 * Drop the GIN trigram indexes for the duration of the bulk load and rebuild
 * them afterwards from their own catalog definitions.
 *
 * ⚠️ WHY THIS IS SOUND, and what would make it unsound. Maintaining six GIN
 * indexes incrementally across 1.3M inserts of multi-KB text is the dominant
 * cost of this seed — measured, the issues insert alone had not finished after
 * 12 minutes with them in place. A bulk build afterwards produces the SAME
 * index: the definitions are read back out of `pg_indexes` and replayed
 * verbatim, so nothing here can silently substitute a different opclass or
 * drop a column (which is exactly the failure mode migration 0269's own
 * validation block exists to catch). The rebuilt index is denser than an
 * incrementally-maintained one, which if anything flatters the index-using
 * plans — stated because it bears on the numbers, not on the plan shape this
 * script is for.
 *
 * ⛔ Do NOT extend this to the btree indexes. Only the GIN ones are dropped;
 * a plan that depends on a btree index is unaffected by this optimisation.
 */
async function withoutTrigramIndexes<T>(sql: postgres.Sql, body: () => Promise<T>): Promise<T> {
  const defs = await sql.unsafe(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ('issues', 'issue_comments')
      AND indexdef LIKE '%USING gin%'
    ORDER BY indexname
  `);
  console.log(`  dropping ${defs.length} GIN indexes for the bulk load (rebuilt verbatim after):`);
  for (const row of defs as any[]) console.log(`    - ${row.indexname}`);
  for (const row of defs as any[]) await sql.unsafe(`DROP INDEX ${row.indexname}`);
  try {
    return await body();
  } finally {
    console.log(`  rebuilding ${defs.length} GIN indexes …`);
    for (const row of defs as any[]) {
      const started = Date.now();
      await sql.unsafe(row.indexdef);
      console.log(`    + ${row.indexname} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
  }
}

async function seed(sql: postgres.Sql) {
  console.log("seeding — this takes several minutes …");
  await sql.unsafe(`SET maintenance_work_mem = '1GB';`);
  await sql.unsafe(`SET session_replication_role = replica;`);

  const companies = [COMPANY, ...Array.from({ length: OTHER_COMPANIES }, (_, i) => companyUuid(i))];
  for (const [index, company] of companies.entries()) {
    await sql.unsafe(
      `INSERT INTO companies (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [company, `pen-3596-${index}`],
    );
  }

  await withoutTrigramIndexes(sql, async () => {
  // Issues. The searched company gets SEARCHED_COMPANY_ISSUES; the rest spread
  // over the other 19, so cross-company fan-out exists and company-scoping is
  // measurable (the lesson 0269's header records about single-company seeds).
  // ~6KB descriptions, matching production shape.
  console.log(`  issues: ${TOTAL_ISSUES.toLocaleString()} over ${companies.length} companies …`);
  await sql.unsafe(`
    INSERT INTO issues (id, company_id, issue_number, title, description, status, priority, created_at, updated_at, last_activity_at)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      CASE WHEN g <= ${SEARCHED_COMPANY_ISSUES}
           THEN '${COMPANY}'::uuid
           ELSE ('33333333-3333-4333-8333-3333333' || lpad(((g - ${SEARCHED_COMPANY_ISSUES}) % ${OTHER_COMPANIES})::text, 5, '0'))::uuid
      END,
      g,
      'seeded issue ' || g,
      repeat('lorem ipsum dolor sit amet consectetur adipiscing elit ', 110)
        || CASE WHEN g % 20 = 0 THEN ' mentions ${TERM} timeout ' ELSE '' END || ' tail ' || g,
      'in_progress', 'medium',
      now() - (g || ' seconds')::interval,
      now() - (g || ' seconds')::interval,
      now() - (g || ' seconds')::interval
    FROM generate_series(1, ${TOTAL_ISSUES}) AS g;
  `);

  // Comments. ~2KB bodies, production size. 1 in 10 carries the term, so the
  // term matches across EVERY company — which is the amplification the
  // composite index exists to remove.
  console.log(`  issue_comments: ${TOTAL_COMMENTS.toLocaleString()} (~2KB bodies) …`);
  const commentsPerIssue = Math.round(TOTAL_COMMENTS / TOTAL_ISSUES);
  const batches = 12;
  const perBatch = Math.ceil(commentsPerIssue / batches);
  for (let batch = 0; batch < batches; batch += 1) {
    const from = batch * perBatch + 1;
    const to = Math.min((batch + 1) * perBatch, commentsPerIssue);
    if (from > to) break;
    await sql.unsafe(`
      INSERT INTO issue_comments (company_id, issue_id, body, created_at, updated_at)
      SELECT
        i.company_id,
        i.id,
        CASE WHEN (i.issue_number + c) % 10 = 0
             THEN 'canceling ${TERM} due to ${TERM} timeout, '
             ELSE 'ordinary chatter ' END
          || repeat('discussion body text that is representative of a real comment ', 30)
          || ' comment ' || i.issue_number || '/' || c,
        i.created_at + (c || ' seconds')::interval,
        i.created_at + (c || ' seconds')::interval
      FROM issues AS i, generate_series(${from}, ${to}) AS c;
    `);
    console.log(`    … comment batch ${batch + 1}/${batches}`);
  }

  // activity_log — NEVER seeded by any prior PEN-3596 harness. Mixed actions,
  // including the four ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS the ORDER BY
  // subquery excludes, so the NOT IN is doing real work rather than matching
  // everything.
  console.log(`  activity_log: ${TOTAL_ACTIVITY_LOG.toLocaleString()} …`);
  const logPerIssue = Math.round(TOTAL_ACTIVITY_LOG / TOTAL_ISSUES);
  await sql.unsafe(`
    INSERT INTO activity_log (company_id, actor_type, actor_id, entity_type, entity_id, action, created_at)
    SELECT
      i.company_id,
      'agent',
      'seed-actor',
      'issue',
      i.id::text,
      (ARRAY['issue.updated','issue.commented','issue.status_changed','issue.read_marked',
             'issue.inbox_archived','issue.approval_linked'])[1 + ((i.issue_number + a) % 6)],
      i.created_at + (a || ' seconds')::interval
    FROM issues AS i, generate_series(1, ${logPerIssue}) AS a;
  `);
  });

  await sql.unsafe(`SET session_replication_role = origin;`);
  console.log("  ANALYZE …");
  await sql.unsafe(`ANALYZE issues; ANALYZE issue_comments; ANALYZE activity_log;`);

  const counts = await sql.unsafe(`
    SELECT
      (SELECT count(*) FROM issues) AS issues,
      (SELECT count(*) FROM issues WHERE company_id = '${COMPANY}') AS issues_searched_company,
      (SELECT count(*) FROM issue_comments) AS issue_comments,
      (SELECT count(*) FROM issue_comments WHERE body ILIKE '${PATTERN}') AS comments_matching_global,
      (SELECT count(*) FROM issue_comments WHERE company_id = '${COMPANY}' AND body ILIKE '${PATTERN}') AS comments_matching_company,
      (SELECT count(*) FROM activity_log) AS activity_log
  `);
  console.log("\nSEEDED COUNTS (state these with any result):");
  console.table(counts);
  return counts[0];
}

/** The shipped post-0268 union, from `issueSearchMatchCondition` in server/src/services/issues.ts. */
const SHIPPED_SEARCH_UNION = `
  issues.id IN (
    SELECT issues.id FROM issues WHERE issues.company_id = $1 AND issues.title ILIKE $2 ESCAPE '\\'
    UNION
    SELECT issues.id FROM issues WHERE issues.company_id = $1 AND issues.identifier ILIKE $2 ESCAPE '\\'
    UNION
    SELECT issues.id FROM issues WHERE issues.company_id = $1 AND issues.description ILIKE $2 ESCAPE '\\'
    UNION
    SELECT issue_comments.issue_id FROM issue_comments
    WHERE issue_comments.company_id = $1 AND issue_comments.deleted_at IS NULL
      AND issue_comments.body ILIKE $2 ESCAPE '\\'
  )`;

/** `issueCanonicalLastActivityAtExpr` — the GREATEST(...) with all three arms. */
const CANONICAL_LAST_ACTIVITY = `
  GREATEST(
    issues.updated_at,
    COALESCE((SELECT MAX(issue_comments.created_at) FROM issue_comments
              WHERE issue_comments.issue_id = issues.id AND issue_comments.company_id = $1), to_timestamp(0)),
    COALESCE((SELECT MAX(activity_log.created_at) FROM activity_log
              WHERE activity_log.company_id = $1 AND activity_log.entity_type = 'issue'
                AND activity_log.entity_id = issues.id::text
                AND activity_log.action NOT IN ('issue.read_marked','issue.read_unmarked',
                                                'issue.inbox_archived','issue.inbox_unarchived')), to_timestamp(0))
  )`;

const PRIORITY_ORDER = `CASE issues.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

async function main() {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) {
    console.error(`embedded Postgres unsupported here: ${support.reason}`);
    process.exit(1);
  }

  const database = await startEmbeddedPostgresTestDatabase("pen-3596-prod-scale");
  // ⚠️ `max_lifetime: null` is load-bearing, not tidiness. postgres.js defaults
  // it to `60 * (30 + Math.random() * 30)` seconds — a connection is recycled
  // somewhere between 30 and 60 minutes. A full run of this file exceeds that,
  // and several of its statements are multi-minute DDL: the GIN build on
  // 1.26M multi-KB bodies takes ~3.5 minutes and happens three times (seed
  // rebuild, the A2 swap, the restore). A recycle landing mid-`CREATE INDEX`
  // terminates the build and the client re-issues it from the start, which
  // presents as a `CREATE INDEX` that has been "running" far longer than its
  // own `pg_stat_activity.query_start` says — the symptom observed while
  // developing this file. `idle_timeout: null` is belt-and-braces for the same
  // reason (0 disables it). Neither affects what is measured.
  const sql = postgres(database.connectionString, {
    max: 1,
    max_lifetime: 24 * 60 * 60,
    idle_timeout: 0,
    onnotice: () => {},
  });
  try {
    // Planner-relevant settings. These are embedded-Postgres defaults, NOT
    // production's, and they move cost estimates — another reason to read plan
    // SHAPE here rather than milliseconds.
    const settings = await sql.unsafe(`
      SELECT name, setting, unit FROM pg_settings
      WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size',
                     'random_page_cost','seq_page_cost','max_parallel_workers_per_gather',
                     'jit','statement_timeout','server_version')
      ORDER BY name`);
    console.log("PLANNER SETTINGS (embedded defaults, not production's):");
    console.table(settings);

    const counts = await seed(sql);

    const indexes = await sql.unsafe(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'issue_comments' AND indexname LIKE '%body%' ORDER BY indexname
    `);
    console.log("\ntrigram indexes on issue_comments.body after migrations:", indexes.map((r: any) => r.indexname));

    const results = [];

    // ── A. the comment arm alone, both index regimes ──────────────────────
    const commentArm = `
      SELECT issue_comments.issue_id FROM issue_comments
      WHERE issue_comments.company_id = $1 AND issue_comments.deleted_at IS NULL
        AND issue_comments.body ILIKE $2 ESCAPE '\\'`;

    results.push(await explain(sql, "A1 · comment arm · SHIPPED (0269 composite present)", commentArm, [COMPANY, PATTERN]));

    console.log("\n-- reverting to the pre-0269 index regime (drop composite, create un-scoped) …");
    await sql.unsafe(`DROP INDEX IF EXISTS issue_comments_company_body_search_idx;`);
    await sql.unsafe(`CREATE INDEX issue_comments_body_search_idx ON issue_comments USING gin (body gin_trgm_ops);`);
    await sql.unsafe(`ANALYZE issue_comments;`);
    results.push(await explain(sql, "A2 · comment arm · PRE-0269 (un-scoped index only)", commentArm, [COMPANY, PATTERN]));

    console.log("\n-- restoring the shipped 0269 regime …");
    await sql.unsafe(`CREATE INDEX issue_comments_company_body_search_idx ON issue_comments USING gin (company_id, body gin_trgm_ops);`);
    await sql.unsafe(`DROP INDEX IF EXISTS issue_comments_body_search_idx;`);
    await sql.unsafe(`ANALYZE issue_comments;`);

    // ── B. the full SEARCH variant ────────────────────────────────────────
    const searchList = `
      SELECT issues.id, substring(issues.description, 1, 1200), issues.title, issues.status, issues.priority,
             issues.updated_at, issues.last_activity_at
      FROM issues
      WHERE issues.company_id = $1
        AND issues.hidden_at IS NULL AND issues.harness_kind IS NULL
        AND NOT (issues.origin_kind LIKE 'plugin:%:operation'
                 OR issues.origin_kind LIKE 'plugin:%:operation:%')
        AND ${SHIPPED_SEARCH_UNION}
      ORDER BY ${PRIORITY_ORDER} ASC, ${CANONICAL_LAST_ACTIVITY} DESC, issues.updated_at DESC, issues.id DESC
      LIMIT ${LIMIT}`;
    results.push(await explain(sql, "B · full issues-list SEARCH variant (?q=) · shipped shape", searchList, [COMPANY, PATTERN]));

    // ── C. the NO-SEARCH variant — what is actually timing out ────────────
    const noSearchList = `
      SELECT issues.id, substring(issues.description, 1, 1200), issues.title, issues.status, issues.priority,
             issues.updated_at, issues.last_activity_at
      FROM issues
      WHERE issues.company_id = $1
        AND issues.hidden_at IS NULL AND issues.harness_kind IS NULL
        AND NOT (issues.origin_kind LIKE 'plugin:%:operation'
                 OR issues.origin_kind LIKE 'plugin:%:operation:%')
      ORDER BY ${PRIORITY_ORDER} ASC, ${CANONICAL_LAST_ACTIVITY} DESC, issues.updated_at DESC, issues.id DESC
      LIMIT ${LIMIT}`;
    results.push(await explain(sql, "C · full issues-list NO-SEARCH variant · shipped GREATEST(...) ORDER BY", noSearchList, [COMPANY]));

    // ── D. shape C ordered from the materialized column ───────────────────
    const noSearchMaterialized = `
      SELECT issues.id, substring(issues.description, 1, 1200), issues.title, issues.status, issues.priority,
             issues.updated_at, issues.last_activity_at
      FROM issues
      WHERE issues.company_id = $1
        AND issues.hidden_at IS NULL AND issues.harness_kind IS NULL
        AND NOT (issues.origin_kind LIKE 'plugin:%:operation'
                 OR issues.origin_kind LIKE 'plugin:%:operation:%')
      ORDER BY ${PRIORITY_ORDER} ASC, issues.last_activity_at DESC, issues.updated_at DESC, issues.id DESC
      LIMIT ${LIMIT}`;
    results.push(await explain(sql, "D · NO-SEARCH ordered by issues.last_activity_at (SHIPPED by PEN-5213)", noSearchMaterialized, [COMPANY]));

    // ── E. the `sortField=updated` path, where last_activity_at LEADS ─────
    // This is the only no-search ordering `issues_company_last_activity_idx`
    // can serve, because the default ordering leads with priority and the
    // index does not carry it. E1/E2 are the before/after of the same repoint
    // on that path; if the index is ever extended, this is the pair that moves.
    const sortedByActivity = (order: string) => `
      SELECT issues.id, substring(issues.description, 1, 1200), issues.title, issues.status, issues.priority,
             issues.updated_at, issues.last_activity_at
      FROM issues
      WHERE issues.company_id = $1
        AND issues.hidden_at IS NULL AND issues.harness_kind IS NULL
        AND NOT (issues.origin_kind LIKE 'plugin:%:operation'
                 OR issues.origin_kind LIKE 'plugin:%:operation:%')
      ORDER BY ${order} DESC, issues.updated_at DESC, issues.id DESC
      LIMIT ${LIMIT}`;
    results.push(await explain(
      sql,
      "E1 · NO-SEARCH sortField=updated · pre-PEN-5213 GREATEST(...) ORDER BY",
      sortedByActivity(CANONICAL_LAST_ACTIVITY),
      [COMPANY],
    ));
    results.push(await explain(
      sql,
      "E2 · NO-SEARCH sortField=updated · PEN-5213 issues.last_activity_at ORDER BY",
      sortedByActivity("issues.last_activity_at"),
      [COMPANY],
    ));

    console.log(`\n${"=".repeat(78)}\nSUMMARY — execution ms (last of 3 runs)\n${"=".repeat(78)}`);
    for (const r of results) console.log(`  ${r.label.padEnd(72)} ${r.execution} ms`);
    console.log("\nSeed counts:", JSON.stringify(counts));
  } finally {
    await sql.end();
    await database.cleanup();
  }
}

await main();
