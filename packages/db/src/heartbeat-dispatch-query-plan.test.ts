/**
 * BLO-20396: query-plan evidence for the per-agent dispatch path.
 *
 * The acceptance criteria ask for "query-plan or integration evidence [that]
 * confirms the dispatch query uses the new index". Migration 0208 has its own
 * test, but that only proves the index EXISTS and is defined correctly — not
 * that the planner actually chooses it, which is the property the ticket cares
 * about. This test closes that gap by seeding a production-shaped table
 * (~200k heartbeat_runs, ~20k issues, one agent holding a deep queued backlog)
 * and asserting on EXPLAIN (ANALYZE, BUFFERS) output.
 *
 * It also measures the priority lane, which review flagged separately: the lane
 * joins issues through `context_snapshot ->> 'issueId' = cast(issues.id as text)`
 * and its LIMIT bounds returned rows, not rows inspected. The zero-match case is
 * the worst case, because nothing lets the executor stop early.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const DISPATCH_INDEX = "heartbeat_runs_agent_dispatch_idx";
const SCAN_LIMIT = 200;
const TOTAL_RUNS = 200_000;
const TOTAL_ISSUES = Number(process.env.BLO20396_ISSUES ?? 20_000);
const AGENT_QUEUED_ROWS = 350;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PLAN_REPORT = process.env.BLO20396_PLAN_REPORT ?? null;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 120_000);

/** Collect every node in an EXPLAIN (FORMAT JSON) plan tree. */
function planNodes(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const children = (node.Plans as Array<Record<string, unknown>> | undefined) ?? [];
  return [node, ...children.flatMap(planNodes)];
}

function indexesUsed(node: Record<string, unknown>): string[] {
  return planNodes(node)
    .map((entry) => entry["Index Name"])
    .filter((name): name is string => typeof name === "string");
}

function scanKinds(node: Record<string, unknown>): string[] {
  return planNodes(node)
    .map((entry) => String(entry["Node Type"] ?? ""))
    .filter((kind) => kind.includes("Scan"));
}

/** Total rows the executor actually touched, summed across all nodes. */
function rowsInspected(node: Record<string, unknown>): number {
  return planNodes(node).reduce((total, entry) => {
    const rows = Number(entry["Actual Rows"] ?? 0);
    const loops = Number(entry["Actual Loops"] ?? 1);
    return total + rows * loops;
  }, 0);
}

async function seed(sql: postgres.Sql) {
  // FK triggers off: this fixture only needs the two tables under test.
  await sql.unsafe(`SET session_replication_role = replica`);

  // ~20k issues for the company. Exactly one is critical and non-terminal, and
  // it is deliberately NOT referenced by the agent's queue, so the priority
  // lane's zero-match worst case is what we measure.
  await sql.unsafe(`
    INSERT INTO issues (id, company_id, title, status, priority, created_at, updated_at, last_activity_at)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
      '${COMPANY}'::uuid,
      'seeded issue ' || series,
      CASE WHEN series % 3 = 0 THEN 'done' ELSE 'in_progress' END,
      CASE WHEN series = 1 THEN 'critical' ELSE 'medium' END,
      now() - (series || ' seconds')::interval,
      now(),
      now()
    FROM generate_series(1, ${TOTAL_ISSUES}) AS series
  `);

  // The agent's own queued backlog: deep, and none of it critical or recovery,
  // which is the shape that gives the priority lane nothing to stop early on.
  await sql.unsafe(`
    INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, updated_at, context_snapshot)
    SELECT
      '${COMPANY}'::uuid,
      '${AGENT}'::uuid,
      'queued',
      now() - ((${AGENT_QUEUED_ROWS} - series) || ' seconds')::interval,
      now(),
      jsonb_build_object(
        'issueId', '00000000-0000-4000-8000-' || lpad((series + 100)::text, 12, '0'),
        'source', 'github_pr_review_requested'
      )
    FROM generate_series(1, ${AGENT_QUEUED_ROWS}) AS series
  `);

  // Bulk of the table: other agents, mixed statuses. This is what makes an
  // unindexed plan expensive and an indexed plan cheap.
  await sql.unsafe(`
    INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, updated_at, context_snapshot)
    SELECT
      '${COMPANY}'::uuid,
      ('33333333-3333-4333-8333-' || lpad((series % 50)::text, 12, '0'))::uuid,
      CASE WHEN series % 200 = 0 THEN 'queued' ELSE 'completed' END,
      now() - ((series % 100000) || ' seconds')::interval,
      now(),
      jsonb_build_object(
        'issueId', '00000000-0000-4000-8000-' || lpad(((series % ${TOTAL_ISSUES}) + 1)::text, 12, '0'),
        'source', 'heartbeat_timer'
      )
    FROM generate_series(1, ${TOTAL_RUNS - AGENT_QUEUED_ROWS}) AS series
  `);

  await sql.unsafe(`SET session_replication_role = origin`);
  await sql.unsafe(`ANALYZE heartbeat_runs`);
  await sql.unsafe(`ANALYZE issues`);
}

async function explain(sql: postgres.Sql, query: string) {
  const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
  const plan = (rows[0] as Record<string, unknown>)["QUERY PLAN"] as Array<Record<string, unknown>>;
  const root = plan[0].Plan as Record<string, unknown>;
  const text = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
  return {
    root,
    text: text.map((line) => String((line as Record<string, unknown>)["QUERY PLAN"])).join("\n"),
  };
}

const DISPATCH_QUERY = `
  SELECT * FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND status = 'queued'
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

const DISPATCH_CURSOR_QUERY = `
  SELECT * FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND status = 'queued'
     AND (created_at, id) > (now() - interval '200 seconds', '00000000-0000-4000-8000-000000000000'::uuid)
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

/** The priority lane exactly as the dispatcher issues it today. */
const PRIORITY_LANE_QUERY = `
  SELECT heartbeat_runs.*, issues.id, issues.status, issues.priority
    FROM heartbeat_runs
    INNER JOIN issues
      ON issues.company_id = '${COMPANY}'::uuid
     AND heartbeat_runs.context_snapshot ->> 'issueId' = cast(issues.id as text)
   WHERE heartbeat_runs.agent_id = '${AGENT}'::uuid
     AND heartbeat_runs.status = 'queued'
     AND issues.status NOT IN ('done', 'cancelled')
     AND (
       issues.priority = 'critical'
       OR (
         heartbeat_runs.context_snapshot ->> 'source' = 'issue_recovery_action'
         AND heartbeat_runs.context_snapshot ->> 'recoveryActionId' is not null
       )
     )
   ORDER BY heartbeat_runs.created_at ASC, heartbeat_runs.id ASC
   LIMIT ${SCAN_LIMIT}
`;

/**
 * Same lane, but joined on the stored generated column instead of the JSON
 * expression. context_issue_id has existed since migration 0079
 * (GENERATED ALWAYS AS (context_snapshot ->> 'issueId') STORED), so this is a
 * rewrite of the predicate, not a new column.
 */
const PRIORITY_LANE_SARGABLE = `
  SELECT heartbeat_runs.*, issues.id, issues.status, issues.priority
    FROM heartbeat_runs
    INNER JOIN issues
      ON issues.company_id = '${COMPANY}'::uuid
     AND issues.id = heartbeat_runs.context_issue_id::uuid
   WHERE heartbeat_runs.agent_id = '${AGENT}'::uuid
     AND heartbeat_runs.status = 'queued'
     AND heartbeat_runs.context_issue_id IS NOT NULL
     AND issues.status NOT IN ('done', 'cancelled')
     AND (
       issues.priority = 'critical'
       OR (
         heartbeat_runs.context_snapshot ->> 'source' = 'issue_recovery_action'
         AND heartbeat_runs.context_snapshot ->> 'recoveryActionId' is not null
       )
     )
   ORDER BY heartbeat_runs.created_at ASC, heartbeat_runs.id ASC
   LIMIT ${SCAN_LIMIT}
`;

describeEmbeddedPostgres("BLO-20396 dispatch query plans", () => {
  it("uses the dispatch index for the keyset scan and bounds the priority lane", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-blo20396-plan-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await seed(sql);

    const report: string[] = [];
    const record = (title: string, plan: { text: string; root: Record<string, unknown> }) => {
      report.push(`\n===== ${title} =====\n${plan.text}\n-- rows inspected: ${rowsInspected(plan.root)}`);
    };

    // --- AC: the dispatch query uses the new index -------------------------
    const head = await explain(sql, DISPATCH_QUERY);
    record("dispatch head scan", head);
    expect(indexesUsed(head.root)).toContain(DISPATCH_INDEX);
    expect(scanKinds(head.root)).not.toContain("Seq Scan");

    const cursor = await explain(sql, DISPATCH_CURSOR_QUERY);
    record("dispatch keyset cursor scan", cursor);
    expect(indexesUsed(cursor.root)).toContain(DISPATCH_INDEX);

    // The index supplies (created_at, id) order, so no Sort over wide rows.
    expect(planNodes(head.root).map((n) => n["Node Type"])).not.toContain("Sort");

    // A LIMIT-bounded head scan must not touch the whole backlog.
    expect(rowsInspected(head.root)).toBeLessThanOrEqual(SCAN_LIMIT * 3);

    // --- Priority lane: zero-match worst case ------------------------------
    const lane = await explain(sql, PRIORITY_LANE_QUERY);
    record("priority lane (current, JSON join, zero matches)", lane);

    const laneSargable = await explain(sql, PRIORITY_LANE_SARGABLE);
    record("priority lane (join on stored context_issue_id)", laneSargable);

    if (PLAN_REPORT) fs.writeFileSync(PLAN_REPORT, report.join("\n"));

    // The lane must at least stay off a sequential scan of heartbeat_runs; the
    // agent's queued rows are reachable through the dispatch index.
    expect(indexesUsed(lane.root)).toContain(DISPATCH_INDEX);

    // Measured behaviour of the lane as written today: the heartbeat_runs side
    // is bounded by the dispatch index, but `... ->> 'issueId' = cast(id as text)`
    // is not sargable on issues.id, so the issues side is a full company scan on
    // every dispatch pass. Rows inspected therefore scale with the company's
    // issue count, not with the LIMIT — measured 14,034 at 20k issues and 67,367
    // at 100k, i.e. linear.
    expect(scanKinds(lane.root)).toContain("Seq Scan");
    expect(rowsInspected(lane.root)).toBeGreaterThan(TOTAL_ISSUES / 4);

    // Joining on the stored generated column instead keeps the issues side on
    // its primary key, so rows inspected stay flat in the agent's queue depth
    // (350 at both 20k and 100k issues). Recorded here so the difference is
    // executable evidence rather than an assertion in a review comment.
    expect(indexesUsed(laneSargable.root)).toContain("issues_pkey");
    expect(scanKinds(laneSargable.root)).not.toContain("Seq Scan");
    expect(rowsInspected(laneSargable.root)).toBeLessThanOrEqual(AGENT_QUEUED_ROWS * 2);
  }, 900_000);
});
