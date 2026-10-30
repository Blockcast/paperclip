/**
 * PEN-3596: where the issues-list search query spends its time, and the shape
 * change that fixed it — pinned so the next person does not re-chase the leads
 * that have already been refuted.
 *
 * The row reported `GET /api/companies/:id/issues` blowing the 30s role
 * `statement_timeout` and 503ing callers with `57014`, and attributed it to
 * migration 0098's activity_log index no longer holding. Measured against the
 * live PEN company (~4.9k issues) on 2026-10-29, `limit=15`:
 *
 *   q=statement, default sort ................. 25.7s / 28.9s
 *   q=statement, sortField=id (no sort keys) .. 14.1s
 *   q=timeout,   default sort .................. 2.9s
 *   no search,   default sort .................. 1.0s
 *
 * So it is the SEARCH path, it is search-term dependent (which is why repeated
 * sampling with one term reads green), and the no-search row bounds the
 * `GREATEST(...)` ORDER BY subqueries at ~1s over ALL 4.9k issues — they are
 * not the cliff.
 *
 * ── THE CAUSE ──────────────────────────────────────────────────────────────
 *
 * The search WHERE ORed four predicates: `title`/`identifier`/`description`
 * ILIKE '%term%' on `issues`, plus an EXISTS over `issue_comments`. A
 * semi-join cannot take part in a BitmapOr, so the EXISTS forced the WHOLE
 * disjunction to be evaluated as a per-row FILTER on a scan of every issue in
 * the company — and `description ILIKE '%term%'` then ran against all ~6KB of
 * every description, in the WHERE and again in the `searchOrder` sort key.
 * The gin_trgm indexes on those columns (migration 0051) existed the whole
 * time and were simply unreachable.
 *
 * ── THE FIX, AND WHY IT IS BOTH HALVES ─────────────────────────────────────
 *
 * Query side (server/src/services/issues.ts): resolve each search branch into
 * its own id set and UNION them, so every branch is a standalone indexable
 * predicate. Index side (migration 0268): company-scoped `(company_id, col
 * gin_trgm_ops)` twins of the three single-column trigram indexes, because the
 * un-scoped ones make the scan pay for every OTHER company's matches on the
 * heap (2,700 index hits to keep 245 rows on the seed below: 245ms → 21ms).
 *
 * Measured on a production-shaped embedded-Postgres seed — 54,000 issues /
 * 216,000 comments / 6.4KB descriptions, matching the live 54,209-row table
 * with ~4.9k of them in the searched company:
 *
 *   BEFORE: four predicates under one OR ................... 426-453ms
 *   AFTER:  shipped union shape + migration 0268 ............  98-114ms
 *
 * and, isolating which half does the work:
 *
 *   composite indexes alone, query unchanged ................ 471-508ms  ← nothing
 *   union restructure alone, single-column indexes .......... 307-339ms
 *
 * NEITHER HALF WORKS ALONE. The indexes are worth literally nothing without
 * the restructure (the OR keeps them unreachable), and the restructure alone
 * is only ~1.6x; together they are ~4.3x.
 *
 * ── THE COMMENT ARM, AND A SEED THAT COULD NOT SEE IT ───────────────────
 *
 * ⚠️ 0268 shipped composites for the three `issues` columns and DECLINED one
 * for `issue_comments.body`, on an attribution that measured it at −11ms and
 * priced it at an 18MB index on the largest table in the schema. Migration
 * 0269 REVERSES that, and the reason is a lesson about this seed rather than
 * about the index: every measurement behind the −11ms was taken on a corpus
 * with ONE company in it (`populate()` below still is — a single COMPANY
 * constant). Company-scoping an index cannot be worth anything when there is
 * one company: the scoped and un-scoped bitmaps are the same rows by
 * construction. The number was right; what it was read to mean was not.
 *
 * Production disagreed as soon as 0268 deployed. With the search path fixed
 * (a no-match term fell from ~25s to 0.251s), a COMMON term still cost
 * 16-22s against the 30s bound, while the no-`q` query — which makes the
 * planner handle the whole company — cost 3.254s, bounding every PEN-scoped
 * operation well below the residual. Re-measured on a seed that spreads
 * 236,800 comments of production size over 20 companies (term matching
 * 23,680 rows globally, 3,920 in the searched company — 6.0x amplification):
 *
 *   comment arm of the WHERE union, alone .... 571-629ms  ->   82-109ms  (~6x)
 *   full list query, production shape ....... 1006-1045ms ->  243-295ms  (~3.8x)
 *
 * The speedup tracks the amplification, which is the mechanism: the un-scoped
 * `issue_comments_body_search_idx` BitmapAnd'ed with
 * `issue_comments_company_idx` built the term's bitmap across every company
 * before intersecting. 0269 company-scopes it and DROPS the un-scoped index
 * — all five body ILIKE/regex queries in the repo are company-scoped, so the
 * GIN-index count on `body` stays at one and the write amplification 0268
 * declined to pay is still not paid. See the 0269 header for the per-consumer
 * table (every one same-or-faster; the `~*` regex form becomes indexable).
 *
 * ⭐ THE DURABLE LESSON: a single-company seed cannot measure a
 * company-scoping change. `populateMultiCompany()` below exists so the next
 * such question is asked against a corpus that can answer it.
 *
 * ⚠️ WHAT THIS SUITE DOES AND DOES NOT PROVE. `SHIPPED_SEARCH_WHERE` below is
 * a hand-written copy of the predicate `issueSearchMatchCondition()` builds,
 * not the predicate itself — this package cannot import the server service.
 * So these tests prove the POSTGRES behaviour of the two shapes, and would
 * stay green if `list()` reverted to `or(...)` tomorrow. The guard against
 * that revert is in the server package:
 * `server/src/__tests__/issues-service.test.ts`, "issues-list search predicate
 * shape (PEN-3596)", which renders the real fragment and fails if the UNION
 * collapses back to an OR over an EXISTS. Keep the two in step.
 *
 * ── THREE REFUTED LEADS. Each was proposed on the row; none is the cause ────
 *
 *  1. "0098's activity_log index stopped being chosen."
 *     `idx_activity_log_entity_id_created` is present and the ORDER BY
 *     subqueries cost ~1s total (see the no-search row above).
 *  2. "The issue_comments correlated subquery needs a covering index."
 *     `issue_comments_company_issue_created_at_idx` on
 *     `(company_id, issue_id, created_at)` already exists.
 *  3. "`commentContainsMatch` is a correlated EXISTS, so it re-executes per
 *     row; de-correlate it to `id IN (SELECT ...)`."
 *     ⛔ PostgreSQL ALREADY DOES THIS. It pulls the correlated EXISTS up into
 *     an uncorrelated `hashed SubPlan` — the first test below asserts that
 *     directly. Rewriting that ONE predicate by hand was measured at no
 *     improvement (147-152ms before, 140-163ms after, i.e. noise) and was
 *     reverted. The fix is not de-correlation; it is removing the semi-join
 *     from the disjunction so the OTHER three branches become indexable.
 *
 * Note the per-row cost is CPU, not I/O, and that was measured rather than
 * assumed: a 6KB description of repetitive prose is pglz-compressed to well
 * under the 2KB out-of-line threshold, so it is stored INLINE and the TOAST
 * relation is never touched (an earlier version of this test asserted TOAST
 * block reads and measured exactly zero). "Move it out of TOAST" is not the
 * fix either.
 *
 * ⚠️ THESE TESTS ASSERT STRUCTURE, NOT PLAN CHOICE OR WALL-CLOCK. The timings
 * above are evidence recorded in prose, deliberately not assertions. BLO-31354
 * recorded that pinning plan *choice* here sits inside PostgreSQL's 1% cost
 * fuzz and ejected unrelated PRs from the merge queue. Plan choice is also
 * genuinely scale-dependent for this query: measured, the planner picks
 * `issues_company_description_search_idx` at the 54k-row production shape and
 * does NOT at 400/1500/4000 rows, where a seq scan of a small table really is
 * cheaper. A CI-affordable seed therefore cannot assert "the index is used"
 * without being a lie at that size. What it CAN assert, and what actually
 * distinguishes the two shapes at every size, is whether the description
 * predicate is welded to the scan that produces candidate rows.
 *
 * ⚠️ The SQL below mirrors `list()` in server/src/services/issues.ts by hand
 * (this package cannot import the server). If that query's search shape
 * changes, change these with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const COMPANY = "33333333-3333-4333-8333-333333333333";
/** PEN-3596/0269: cross-company neighbours, so company-scoping is measurable. */
const OTHER_COMPANY_A = "33333333-3333-4333-8333-33333333aaaa";
const OTHER_COMPANY_B = "33333333-3333-4333-8333-33333333bbbb";
const TOTAL_ISSUES = 400;
const COMMENTS_PER_ISSUE = 6;
const TERM = "statement";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function startDatabase(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return { sql };
}

/** Production-shaped: ~6KB descriptions, so the per-row cost is production's. */
async function populate(sql: postgres.Sql) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO companies (id, name) VALUES ('${COMPANY}', 'pen-3596') ON CONFLICT DO NOTHING;
    INSERT INTO issues (id, company_id, title, description, status, priority, created_at, updated_at, last_activity_at)
    SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COMPANY}'::uuid,
           'seeded issue ' || g,
           repeat('lorem ipsum dolor sit amet consectetur adipiscing elit ', 110)
             || CASE WHEN g % 20 = 0 THEN ' mentions ${TERM} timeout ' ELSE '' END || ' tail ' || g,
           'in_progress', 'medium', now(), now(), now()
    FROM generate_series(1, ${TOTAL_ISSUES}) AS g;
    INSERT INTO issue_comments (company_id, issue_id, body, created_at, updated_at)
    SELECT '${COMPANY}'::uuid, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           CASE WHEN g % 10 = 0 THEN 'canceling ${TERM} due to ${TERM} timeout, ' ELSE 'ordinary chatter ' END
             || 'comment ' || g || '/' || c, now(), now()
    FROM generate_series(1, ${TOTAL_ISSUES}) AS g, generate_series(1, ${COMMENTS_PER_ISSUE}) AS c;
    SET session_replication_role = origin;
    ANALYZE issues;
    ANALYZE issue_comments;
  `);
}

/**
 * PEN-3596 / migration 0269: a corpus with MORE THAN ONE company in it.
 *
 * `populate()` above is deliberately single-company and the existing tests
 * depend on that (they assert inspected-row counts equal to TOTAL_ISSUES).
 * This one is separate rather than a widening of it, so those assertions keep
 * meaning what they say. Its whole job is to make cross-company fan-out exist:
 * the search term matches comments in every company, so an index that is not
 * company-scoped has other companies' matches to wade through and a
 * company-scoped one does not.
 */
async function populateMultiCompany(sql: postgres.Sql) {
  await populate(sql);
  const others = [OTHER_COMPANY_A, OTHER_COMPANY_B];
  for (const [offset, company] of others.entries()) {
    const base = TOTAL_ISSUES * (offset + 1);
    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO companies (id, name) VALUES ('${company}', 'pen-3596-other-${offset}')
        ON CONFLICT DO NOTHING;
      INSERT INTO issues (id, company_id, title, description, status, priority, created_at, updated_at, last_activity_at)
      SELECT ('00000000-0000-4000-8000-' || lpad((${base} + g)::text, 12, '0'))::uuid, '${company}'::uuid,
             'other issue ' || g, 'other description ' || g,
             'in_progress', 'medium', now(), now(), now()
      FROM generate_series(1, ${TOTAL_ISSUES}) AS g;
      INSERT INTO issue_comments (company_id, issue_id, body, created_at, updated_at)
      SELECT '${company}'::uuid,
             ('00000000-0000-4000-8000-' || lpad((${base} + g)::text, 12, '0'))::uuid,
             'canceling ${TERM} due to ${TERM} timeout, other comment ' || g || '/' || c,
             now(), now()
      FROM generate_series(1, ${TOTAL_ISSUES}) AS g, generate_series(1, ${COMMENTS_PER_ISSUE}) AS c;
      SET session_replication_role = origin;
      ANALYZE issues;
      ANALYZE issue_comments;
    `);
  }
}

const CORRELATED_COMMENT_MATCH = `
  EXISTS (
    SELECT 1 FROM issue_comments c
    WHERE c.issue_id = i.id
      AND c.company_id = '${COMPANY}'::uuid
      AND c.deleted_at IS NULL
      AND c.body ILIKE '%${TERM}%' ESCAPE '\\'
  )`;

/** The WHERE as it stood before this fix: four predicates under one OR. */
const SUPERSEDED_SEARCH_WHERE = `(
  i.title ILIKE '%${TERM}%' ESCAPE '\\'
  OR i.identifier ILIKE '%${TERM}%' ESCAPE '\\'
  OR i.description ILIKE '%${TERM}%' ESCAPE '\\'
  OR ${CORRELATED_COMMENT_MATCH}
)`;

/**
 * The WHERE as `list()` builds it now: one id set per branch, unioned.
 * ⚠️ Hand-copied from `issueSearchMatchCondition()` — see the header note; the
 * revert guard is the server-side shape suite, not this constant.
 */
const SHIPPED_SEARCH_WHERE = `i.id IN (
  SELECT s.id FROM issues s
  WHERE s.company_id = '${COMPANY}'::uuid AND s.title ILIKE '%${TERM}%' ESCAPE '\\'
  UNION
  SELECT s.id FROM issues s
  WHERE s.company_id = '${COMPANY}'::uuid AND s.identifier ILIKE '%${TERM}%' ESCAPE '\\'
  UNION
  SELECT s.id FROM issues s
  WHERE s.company_id = '${COMPANY}'::uuid AND s.description ILIKE '%${TERM}%' ESCAPE '\\'
  UNION
  SELECT c.issue_id FROM issue_comments c
  WHERE c.company_id = '${COMPANY}'::uuid AND c.deleted_at IS NULL
    AND c.body ILIKE '%${TERM}%' ESCAPE '\\'
)`;

/** Mirrors production: the predicate sits in the SORT KEY, so LIMIT cannot skip it. */
function listQuery(predicate: string) {
  return `
    SELECT i.id FROM issues i
    WHERE i.company_id = '${COMPANY}'::uuid AND i.hidden_at IS NULL
    ORDER BY (CASE WHEN ${predicate} THEN 4 ELSE 6 END), i.updated_at DESC, i.id DESC
    LIMIT 15`;
}

function searchQuery(where: string) {
  return `
    SELECT i.id FROM issues i
    WHERE i.company_id = '${COMPANY}'::uuid AND i.hidden_at IS NULL AND ${where}
    ORDER BY i.updated_at DESC, i.id DESC`;
}

/**
 * Total `Actual Loops` across every node scanning issue_comments. `Relation
 * Name` is set on Seq/Index/Bitmap-Heap scans, which is where loops are
 * reported; Bitmap *Index* Scan nodes carry `Index Name` and sit under their
 * heap scan, so nothing is double-counted.
 */
function commentScanLoops(node: any): number {
  if (!node || typeof node !== "object") return 0;
  const self = node["Relation Name"] === "issue_comments" ? Number(node["Actual Loops"] ?? 0) : 0;
  const children: any[] = Array.isArray(node.Plans) ? node.Plans : [];
  return children.reduce((sum, child) => sum + commentScanLoops(child), self);
}

/** The scan node that produces candidate `issues` rows for the outer query. */
function outermostIssuesScan(node: any): any {
  if (!node || typeof node !== "object") return undefined;
  if (node["Relation Name"] === "issues") return node;
  const children: any[] = Array.isArray(node.Plans) ? node.Plans : [];
  for (const child of children) {
    const found = outermostIssuesScan(child);
    if (found) return found;
  }
  return undefined;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("issues-list search cost shape (PEN-3596)", () => {
  // Lead 3, refuted. This is the assertion that makes the refutation durable:
  // if PostgreSQL ever STOPS flattening this, the test fails and de-correlating
  // by hand becomes worth revisiting. Until then it is a no-op.
  it("already flattens the correlated comment EXISTS into one uncorrelated scan", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-flatten-");
    await populate(sql);

    const rows = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${listQuery(CORRELATED_COMMENT_MATCH)}`,
    );
    const root = (rows as any)[0]["QUERY PLAN"][0];
    const loops = commentScanLoops(root.Plan);

    // One scan of issue_comments for the whole query, NOT one per candidate row.
    expect(loops).toBeGreaterThan(0);
    expect(loops).toBeLessThanOrEqual(2);
    // The planner's own word for it, so a future reader sees the mechanism.
    expect(JSON.stringify(root.Plan)).toContain("hashed SubPlan");
  }, 180_000);

  // The cause, pinned on the shape this replaced. Keeping it executable is the
  // point: it is the control the shipped shape is measured against, and if a
  // future change reintroduces an OR over the semi-join, this is what that
  // regression looks like.
  it("the superseded OR shape welds the description predicate to a full scan", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-superseded-");
    await populate(sql);

    // Descriptions are production-sized, which is the premise for the cost.
    const avgBytes = Number((await sql.unsafe(
      `SELECT avg(length(description))::int AS a FROM issues`,
    ))[0].a);
    expect(avgBytes).toBeGreaterThan(2_000);

    const rows = await sql.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${searchQuery(SUPERSEDED_SEARCH_WHERE)}`,
    );
    const scan = outermostIssuesScan((rows as any)[0]["QUERY PLAN"][0].Plan);

    // One scan of every issue in the company, with the 6KB description ILIKE
    // applied per row as a filter. No index can serve it from here.
    expect(String(scan["Node Type"] ?? "")).toContain("Seq Scan");
    expect(String(scan.Filter)).toContain("description");
    // Rows INSPECTED, not rows returned: `Actual Rows` is the post-filter
    // output, and it is the inspected count that the description predicate is
    // charged against.
    const inspected = Number(scan["Actual Rows"] ?? 0) + Number(scan["Rows Removed by Filter"] ?? 0);
    expect(inspected).toBe(TOTAL_ISSUES);
  }, 180_000);

  // The fix, asserted as the structural difference rather than as plan choice
  // (see the ⚠️ note in the file header on why plan choice is not assertable
  // at a CI-affordable seed size).
  it("the shipped union shape detaches the description predicate from the candidate scan", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-shipped-");
    await populate(sql);

    const rows = await sql.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${searchQuery(SHIPPED_SEARCH_WHERE)}`,
    );
    const root = (rows as any)[0]["QUERY PLAN"][0].Plan;
    const scan = outermostIssuesScan(root);

    // The scan that produces candidate rows no longer evaluates the 6KB
    // description predicate, so what it costs no longer scales with
    // description size. That is the whole change.
    expect(String(scan.Filter ?? "")).not.toContain("description");

    // The description predicate still exists — in its own branch, as the sole
    // qual of a scan, which is the form an index can serve. At the production
    // row count the planner does serve it from
    // issues_company_description_search_idx; at this seed size it correctly
    // prefers a seq scan of a small table, so only the FORM is asserted.
    expect(JSON.stringify(root)).toContain("description");
  }, 180_000);

  // Semantics. The restructure must be a pure shape change.
  it("returns exactly the same issues as the shape it replaced", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-equivalence-");
    await populate(sql);

    const before = (await sql.unsafe(searchQuery(SUPERSEDED_SEARCH_WHERE))) as any[];
    const after = (await sql.unsafe(searchQuery(SHIPPED_SEARCH_WHERE))) as any[];

    expect(after.length).toBeGreaterThan(0);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  }, 180_000);

  // Migration 0268. The restructure is worth ~1.6x without these and ~8x with
  // them, so a silently-missing migration is a silent ~2.7x regression on top of the restructure.
  it("ships the company-scoped trigram indexes the restructure depends on", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-indexes-");

    const present = (await sql.unsafe(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'issues' AND indexname IN (
        'issues_company_title_search_idx',
        'issues_company_identifier_search_idx',
        'issues_company_description_search_idx'
      ) ORDER BY indexname`)) as any[];

    expect(present.map((row) => row.indexname)).toEqual([
      "issues_company_description_search_idx",
      "issues_company_identifier_search_idx",
      "issues_company_title_search_idx",
    ]);
  }, 180_000);

  // Migration 0269. Structural, like the 0268 check above and for the same
  // reason the file header gives: plan choice is not assertable at a
  // CI-affordable seed size, so what is pinned is that the index the comment
  // arm depends on exists -- and that the un-scoped one it replaced is gone.
  // The second half is the part worth having: leaving both would quietly
  // reinstate the second GIN index on `body` that 0268 declined to pay for.
  it("replaces the un-scoped comment trigram index with the company-scoped one", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-comment-index-");

    const present = (await sql.unsafe(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'issue_comments' AND indexname IN (
        'issue_comments_company_body_search_idx',
        'issue_comments_body_search_idx'
      ) ORDER BY indexname`)) as any[];

    expect(present.map((row) => row.indexname)).toEqual([
      "issue_comments_company_body_search_idx",
    ]);
  }, 180_000);

  // The reason 0269 exists at all is that no seed here had a second company
  // in it, so a company-scoping change could not be measured. This pins the
  // corpus shape rather than a timing: if `populateMultiCompany` ever stops
  // producing cross-company matches, the next person measuring an index on
  // this table gets the same false negative 0268 got.
  it("seeds cross-company comment matches the single-company seed cannot", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-crosscompany-");
    await populateMultiCompany(sql);

    const [counts] = (await sql.unsafe(`
      SELECT
        (SELECT count(*) FROM issue_comments WHERE body ILIKE '%${TERM}%') AS "global",
        (SELECT count(*) FROM issue_comments
          WHERE company_id = '${COMPANY}'::uuid AND body ILIKE '%${TERM}%') AS "searched",
        (SELECT count(DISTINCT company_id) FROM issue_comments) AS "companies"`)) as any[];

    expect(Number(counts.companies)).toBeGreaterThan(1);
    // The amplification an un-scoped index would have to wade through. Asserted
    // as "strictly more than the searched company's share", not as a ratio --
    // the ratio is a property of the seed and would be a brittle thing to pin.
    expect(Number(counts.global)).toBeGreaterThan(Number(counts.searched));
    expect(Number(counts.searched)).toBeGreaterThan(0);
  }, 180_000);

  // Semantics, under the condition that actually makes the comment arm
  // dangerous: other companies hold comments matching the same term. The arm
  // filters company_id, so this must hold -- and it is cheap to prove, where
  // the single-company seed could not state the question.
  it("the comment arm never admits another company's issues", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-tenancy-");
    await populateMultiCompany(sql);

    const rows = (await sql.unsafe(searchQuery(SHIPPED_SEARCH_WHERE))) as any[];
    expect(rows.length).toBeGreaterThan(0);

    const [leaked] = (await sql.unsafe(`
      SELECT count(*) AS "n" FROM issues
      WHERE id = ANY(${`'{${rows.map((row) => row.id).join(",")}}'::uuid[]`})
        AND company_id <> '${COMPANY}'::uuid`)) as any[];
    expect(Number(leaked.n)).toBe(0);
  }, 180_000);
});
