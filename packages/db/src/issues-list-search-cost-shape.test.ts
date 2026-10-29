/**
 * PEN-3596: where the issues-list search query actually spends its time, pinned
 * so the next person does not re-chase the leads that have already been refuted.
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
 * THREE REFUTED LEADS. Each was proposed on the row; none is the cause:
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
 *     directly. Rewriting the predicate by hand was measured at no
 *     improvement (147-152ms before, 140-163ms after, i.e. noise) and was
 *     reverted. Do not re-attempt it.
 *
 * WHAT IT ACTUALLY IS: `descriptionContainsMatch`. Production descriptions
 * average ~6KB, and `description ILIKE '%term%'` must read and scan all of it
 * for every candidate row — once in the WHERE's `or(...)` and again in the
 * `searchOrder` sort key. Measured here on a production-shaped seed (1500
 * issues, 6KB descriptions, 6 comments each), same WHERE/ORDER BY shape:
 *
 *   current (correlated comment + description everywhere) .. 147-152ms
 *   de-correlated comment, description unchanged ........... 140-163ms  (noise)
 *   description dropped from the SORT KEY only ............. 156-198ms  (no help:
 *                                                             the WHERE still
 *                                                             detoasts)
 *   no description predicate at all ......................... 45-53ms   (~3x)
 *
 * i.e. ~2/3 of the time is the description scan, and removing it from only one
 * of its two sites buys nothing.
 *
 * Note the cost is CPU, not I/O, and that was measured rather than assumed: a
 * 6KB description of repetitive prose is pglz-compressed to well under the 2KB
 * out-of-line threshold, so it is stored INLINE and the TOAST relation is never
 * touched (an earlier version of this test asserted TOAST block reads and
 * measured exactly zero). The per-row work is decompress-and-scan. So "move it
 * out of TOAST" is not the fix either; the fix has to stop evaluating the
 * predicate per row. A trigram index alone will not do that while the four
 * search predicates sit under one `OR`, which forces the seq scan asserted
 * below.
 *
 * These tests assert STRUCTURE, not wall-clock: the timings above are evidence
 * recorded in prose, deliberately not assertions. BLO-31354 recorded that
 * pinning plan *choice* here sits inside PostgreSQL's 1% cost fuzz and ejected
 * unrelated PRs from the merge queue; a timing assertion would be worse still.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const COMPANY = "33333333-3333-4333-8333-333333333333";
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

/** Production-shaped: ~6KB descriptions, so they TOAST exactly as production's do. */
async function populate(sql: postgres.Sql) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO companies (id, name) VALUES ('${COMPANY}', 'pen-3596') ON CONFLICT DO NOTHING;
    INSERT INTO issues (id, company_id, title, description, status, priority, created_at, updated_at, last_activity_at)
    SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COMPANY}'::uuid,
           'seeded issue ' || g,
           repeat('lorem ipsum dolor sit amet consectetur adipiscing elit ', 110) || ' tail ' || g,
           'in_progress', 'medium', now(), now(), now()
    FROM generate_series(1, ${TOTAL_ISSUES}) AS g;
    INSERT INTO issue_comments (company_id, issue_id, body, created_at, updated_at)
    SELECT '${COMPANY}'::uuid, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           'canceling ${TERM} due to ${TERM} timeout, comment ' || g || '/' || c, now(), now()
    FROM generate_series(1, ${TOTAL_ISSUES}) AS g, generate_series(1, ${COMMENTS_PER_ISSUE}) AS c;
    SET session_replication_role = origin;
    ANALYZE issues;
    ANALYZE issue_comments;
  `);
}

const CORRELATED_COMMENT_MATCH = `
  EXISTS (
    SELECT 1 FROM issue_comments c
    WHERE c.issue_id = i.id
      AND c.company_id = '${COMPANY}'::uuid
      AND c.deleted_at IS NULL
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

  // The actual cost driver, pinned structurally. Not a timing assertion: the
  // point is that the description predicate is applied as a per-row FILTER on a
  // full scan of issues, so no index can serve it while it sits under the `OR`
  // with the other three search predicates. That is why it costs what it costs,
  // and it is what any real fix has to change.
  it("applies the description predicate as a per-row filter on a full scan", async () => {
    const { sql } = await startDatabase("paperclip-pen3596-descr-");
    await populate(sql);

    // Descriptions are production-sized, which is the premise for the cost.
    const avgBytes = Number((await sql.unsafe(
      `SELECT avg(length(description))::int AS a FROM issues`,
    ))[0].a);
    expect(avgBytes).toBeGreaterThan(2_000);

    // The WHERE as the search path builds it: four predicates under one OR.
    const rows = await sql.unsafe(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT i.id FROM issues i
      WHERE i.company_id = '${COMPANY}'::uuid AND i.hidden_at IS NULL
        AND (
          i.title ILIKE '%${TERM}%' ESCAPE '\\'
          OR i.identifier ILIKE '%${TERM}%' ESCAPE '\\'
          OR i.description ILIKE '%${TERM}%' ESCAPE '\\'
          OR ${CORRELATED_COMMENT_MATCH}
        )`);
    const plan = (rows as any)[0]["QUERY PLAN"][0].Plan;

    // A full scan of issues, with the description ILIKE evaluated per row.
    expect(plan["Node Type"] ?? "").toContain("Seq Scan");
    expect(plan["Relation Name"]).toBe("issues");
    expect(String(plan.Filter)).toContain("description");
    // Every row in the company is inspected; LIMIT cannot reduce this, and the
    // sort key then pays for the surviving rows a second time.
    expect(Number(plan["Actual Rows"] ?? 0)).toBe(TOTAL_ISSUES);
  }, 180_000);
});
