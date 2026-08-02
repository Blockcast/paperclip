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
 * It also measures the priority lane, which review flagged separately. The lane
 * used to join issues through `context_snapshot ->> 'issueId' = cast(issues.id
 * as text)`, whose LIMIT bounded returned rows rather than rows inspected; the
 * zero-match case is the worst case, because nothing lets the executor stop
 * early. Both the old shape and the bounded statements that replaced it are
 * measured here, so the improvement is executable evidence rather than a claim
 * in a review comment.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const DISPATCH_INDEX = "heartbeat_runs_agent_dispatch_idx";
const RECOVERY_INDEX = "heartbeat_runs_recovery_dispatch_idx";
const SCAN_LIMIT = 200;
const TOTAL_RUNS = 200_000;
const TOTAL_ISSUES = Number(process.env.BLO20396_ISSUES ?? 20_000);
const AGENT_QUEUED_ROWS = 350;
/**
 * Backlog depth for the recovery-lane bound test — several times SCAN_LIMIT on
 * purpose. At 1.75x (the depth the first fixture uses) a filtered walk inspects
 * 350 rows and reads as "a bit over the limit", which is not distinguishable
 * from a bounded plan; at 25x the two answers differ by orders of magnitude.
 */
const DEEP_BACKLOG_ROWS = 5_000;
/** Recovery rows owned by OTHER agents, so the recovery index is not empty. */
const OTHER_AGENT_RECOVERY_ROWS = 2_000;
/**
 * What the recovery lane may inspect REGARDLESS of queue depth, once its
 * predicate is index-restricted (migration 0209). Deliberately NOT derived from
 * the backlog size: being independent of it is the property under test.
 */
const RECOVERY_LANE_ABSOLUTE_BOUND = 50;
/**
 * The issue ids the agent's queued rows point at — the exact set the
 * dispatcher screens for UUID shape and then passes to the lookup below.
 * Mirrors the `series + 100` offset used when seeding that backlog.
 */
const LANE_ISSUE_IDS = Array.from(
  { length: AGENT_QUEUED_ROWS },
  (_, index) => `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
);
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

/**
 * Total rows the executor actually EXAMINED, summed across all nodes.
 *
 * `Actual Rows` alone counts rows a node EMITTED, which hides exactly the cost
 * this test exists to bound: a scan that walks 50k rows and filters them down
 * to 200 reports 200, and every bounded-work assertion below would pass while
 * the executor did arbitrarily more work. PostgreSQL reports the discarded rows
 * separately, so they are added back here. Both `Actual Rows` and the
 * `Rows Removed by ...` counters are per-loop averages, so both scale by loops.
 */
function rowsInspected(node: Record<string, unknown>): number {
  return planNodes(node).reduce((total, entry) => {
    const loops = Number(entry["Actual Loops"] ?? 1);
    const emitted = Number(entry["Actual Rows"] ?? 0);
    const discarded =
      Number(entry["Rows Removed by Filter"] ?? 0)
      + Number(entry["Rows Removed by Index Recheck"] ?? 0)
      + Number(entry["Rows Removed by Join Filter"] ?? 0);
    return total + (emitted + discarded) * loops;
  }, 0);
}

/** The plan node that scans a named index, so its conditions can be inspected. */
function indexScanNode(
  node: Record<string, unknown>,
  indexName: string,
): Record<string, unknown> | null {
  return planNodes(node).find((entry) => entry["Index Name"] === indexName) ?? null;
}

/**
 * The keyset predicate as PostgreSQL renders a row comparison, e.g.
 * `((created_at, id) > ('...'::timestamptz, '...'::uuid))`. Matched as a row
 * constructor rather than by substring: bare `id` also appears inside
 * `agent_id`, so `toContain("id")` would pass on a plan that never used the
 * cursor at all.
 */
const KEYSET_PREDICATE = /\(\s*created_at\s*,\s*id\s*\)/;

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

/** The priority lane as it was BEFORE the fifth review follow-up. Kept as
 * executable evidence of why it changed: the JSON->text join makes issues_pkey
 * unusable, so the lane's LIMIT bounds returned rows while the executor scans
 * the whole company issue table. */
const PRIORITY_LANE_BEFORE = `
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
 * The lane as the dispatcher issues it TODAY: split in two, so each kind of
 * row gets its own budget.
 *
 * Lane A — critical issues. The dispatcher first reads a fixed-size indexed
 * page of queued runs, then UUID-screens and resolves only that page's issues.
 * Filtering critical priority after the bounded read is what makes the
 * zero-match case independent of total queue depth.
 */
const PRIORITY_LANE_CRITICAL_CANDIDATES = `
  SELECT * FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND heartbeat_runs.status = 'queued'
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

const PRIORITY_LANE_CRITICAL_ISSUE_LOOKUP = `
  SELECT id, status, priority FROM issues
   WHERE company_id = '${COMPANY}'::uuid
     AND id IN (${LANE_ISSUE_IDS.slice(0, SCAN_LIMIT).map((id) => `'${id}'::uuid`).join(", ")})
`;

/**
 * Lane B — recovery-action wakes. Recovery-ness is a property of the RUN, so
 * this needs no join at all: the agent's queued rows are a bounded candidate
 * set through the dispatch index.
 */
const PRIORITY_LANE_RECOVERY = `
  SELECT * FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND status = 'queued'
     AND context_snapshot ->> 'source' = 'issue_recovery_action'
     AND context_snapshot ->> 'recoveryActionId' is not null
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

/**
 * Lane B step 2. The id list is built and UUID-screened in JS, so it arrives as
 * bound parameters rather than as a cast inside a join condition.
 */
const PRIORITY_LANE_ISSUE_LOOKUP = `
  SELECT id, status, priority FROM issues
   WHERE company_id = '${COMPANY}'::uuid
     AND id IN (${LANE_ISSUE_IDS.map((id) => `'${id}'::uuid`).join(", ")})
`;

/**
 * BLO-20736. Two depths, both well past SCAN_LIMIT and an order of magnitude
 * apart, so a single shared ceiling can distinguish bounded work from work that
 * tracks the backlog.
 */
const DISPATCH_HEAD_DEPTHS = [1_000, 5_000] as const;

/**
 * The head page as the dispatcher reads it now: ONLY the keyset columns.
 *
 * Every column here lives in heartbeat_runs_agent_dispatch_idx behind the
 * (agent_id, status) prefix, so the page is served entirely from the index with
 * no heap access — an ordered `Index Only Scan` that stops after SCAN_LIMIT
 * entries. That is what makes the plan insensitive to the cardinality
 * underestimate: with no heap fetches to pay for, the ordered path's
 * LIMIT-scaled cost stays ~10 whether the planner believes 126 rows or 5167,
 * while the bitmap alternative must still materialize the whole match set
 * before its sort can emit a single row.
 *
 * `created_at::text` mirrors the dispatcher exactly, cast and all: it carries
 * the cursor as text so postgres' microsecond timestamps survive a round trip
 * through a JS Date, which only has millisecond resolution. The cast is applied
 * on top of an indexed column, so the page is still served index-only — but the
 * projection has to match production or this plan is not the production plan.
 */
const DISPATCH_HEAD_PROBE = `
  SELECT created_at::text AS dispatch_created_at_cursor, id FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND status = 'queued'
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

const DISPATCH_HEAD_PROBE_CURSOR = `
  SELECT created_at::text AS dispatch_created_at_cursor, id FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND status = 'queued'
     AND (created_at, id) > (now() - interval '90000 seconds', '00000000-0000-4000-8000-000000000000'::uuid)
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

/**
 * A deep queue whose rows are physically INTERLEAVED with everyone else's.
 *
 * `seed` above appends the agent's backlog in one block, which packs it into a
 * few dozen heap pages — and against clustering that tight, bitmap+sort really
 * is the cheaper plan, so asserting the ordered plan there would be asserting
 * the wrong thing. Spreading one queued row per stride puts each on its own
 * heap page (`Heap Blocks: exact=<depth>`), which is what a queue accumulated
 * over time actually looks like.
 *
 * VACUUM, not just ANALYZE: index-only scans are costed against the visibility
 * map, and a never-vacuumed table reports relallvisible = 0 and gets bitmap+sort
 * regardless of projection. Production is continuously autovacuumed, so
 * vacuuming here is what makes the fixture honest rather than what makes it
 * pass.
 */
async function seedInterleavedQueue(sql: postgres.Sql, depth: number) {
  await sql.unsafe(`SET session_replication_role = replica`);
  const stride = Math.floor(TOTAL_RUNS / depth);
  await sql.unsafe(`
    INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, updated_at, context_snapshot)
    SELECT
      '${COMPANY}'::uuid,
      CASE WHEN series % ${stride} = 0
        THEN '${AGENT}'::uuid
        ELSE ('33333333-3333-4333-8333-' || lpad((series % 50)::text, 12, '0'))::uuid END,
      CASE WHEN series % ${stride} = 0 OR series % 200 = 0 THEN 'queued' ELSE 'completed' END,
      now() - ((series % 100000) || ' seconds')::interval,
      now(),
      jsonb_build_object(
        'issueId', '00000000-0000-4000-8000-' || lpad(((series % ${TOTAL_ISSUES}) + 1)::text, 12, '0'),
        'source', 'heartbeat_timer'
      )
    FROM generate_series(1, ${TOTAL_RUNS}) AS series
  `);
  await sql.unsafe(`SET session_replication_role = origin`);
  await sql.unsafe(`VACUUM ANALYZE heartbeat_runs`);
}


describeEmbeddedPostgres("BLO-20396 dispatch query plans", () => {
  it("uses the dispatch index for the keyset scan and bounds the priority lane", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-blo20396-plan-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await seed(sql);

    const report: string[] = [];
    // Flushed on every record rather than once at the end: these plans are the
    // diagnostic you most want when an assertion below FAILS, and a single
    // write placed after the assertions produces no report in exactly that case.
    const record = (title: string, plan: { text: string; root: Record<string, unknown> }) => {
      report.push(`\n===== ${title} =====\n${plan.text}\n-- rows inspected: ${rowsInspected(plan.root)}`);
      if (PLAN_REPORT) fs.writeFileSync(PLAN_REPORT, report.join("\n"));
    };

    // --- AC: the dispatch query uses the new index -------------------------
    const head = await explain(sql, DISPATCH_QUERY);
    record("dispatch head scan", head);
    expect(indexesUsed(head.root)).toContain(DISPATCH_INDEX);
    expect(scanKinds(head.root)).not.toContain("Seq Scan");

    const cursor = await explain(sql, DISPATCH_CURSOR_QUERY);
    record("dispatch keyset cursor scan", cursor);
    expect(indexesUsed(cursor.root)).toContain(DISPATCH_INDEX);

    // It is not enough that the index appears somewhere in the plan: the keyset
    // predicate has to be SATISFIED BY the index rather than re-checked after
    // it. If `(created_at, id) > (...)` lands in `Filter` instead of
    // `Index Cond`, PostgreSQL walks the agent's partition from the beginning
    // and discards the prefix on every resumed pass — the scan is then bounded
    // only by LIMIT on OUTPUT, which is the unbounded-work shape the resume
    // cursor exists to remove. That plan still contains the index name, so the
    // assertion above cannot distinguish it.
    const cursorNode = indexScanNode(cursor.root, DISPATCH_INDEX);
    expect(cursorNode).not.toBeNull();
    expect(String(cursorNode?.["Index Cond"] ?? "")).toMatch(KEYSET_PREDICATE);
    expect(String(cursorNode?.["Filter"] ?? "")).not.toMatch(KEYSET_PREDICATE);

    // The index supplies (created_at, id) order, so no Sort over wide rows.
    expect(planNodes(head.root).map((n) => n["Node Type"])).not.toContain("Sort");

    // A LIMIT-bounded scan must not touch the whole backlog. `rowsInspected`
    // counts rows discarded by filters as well as emitted, so a plan that
    // post-filters the cursor fails here rather than reporting its 200 output
    // rows and passing.
    expect(rowsInspected(head.root)).toBeLessThanOrEqual(SCAN_LIMIT * 3);
    expect(rowsInspected(cursor.root)).toBeLessThanOrEqual(SCAN_LIMIT * 3);

    // --- Priority lane: zero-match worst case ------------------------------
    const laneBefore = await explain(sql, PRIORITY_LANE_BEFORE);
    record("priority lane BEFORE (single query, OR, JSON->text join)", laneBefore);

    const laneCriticalCandidates = await explain(sql, PRIORITY_LANE_CRITICAL_CANDIDATES);
    record("priority lane A step 1 (bounded queued candidates)", laneCriticalCandidates);

    const laneCriticalIssues = await explain(sql, PRIORITY_LANE_CRITICAL_ISSUE_LOOKUP);
    record("priority lane A step 2 (critical issues by primary key)", laneCriticalIssues);

    const laneRecovery = await explain(sql, PRIORITY_LANE_RECOVERY);
    record("priority lane B (recovery, run-side only)", laneRecovery);

    const laneIssues = await explain(sql, PRIORITY_LANE_ISSUE_LOOKUP);
    record("priority lane B step 2 (issues by primary key)", laneIssues);

    // The superseded lane is MEASURED but deliberately NOT asserted on. It is
    // recorded in the plan report as the justification for the split — at the
    // time of the change it seq-scanned the company's whole issue table on
    // every dispatch pass under the strict per-agent start lock, 14,034 rows at
    // 20k issues and 67,367 at 100k. Asserting that it *stays* that way would
    // turn diagnostic evidence into a regression lock: adding an expression
    // index that rescued the old shape is a legitimate change, and it would
    // fail CI here for no reason. What must hold is the bound on the lanes the
    // dispatcher actually issues, asserted absolutely below.

    // Lane A step 1 is absolutely bounded by SCAN_LIMIT even when no queued
    // run targets a critical issue. The dispatcher keyset-pages this statement
    // across detached passes, so the bound does not sacrifice any-depth
    // coverage.
    expect(indexesUsed(laneCriticalCandidates.root)).toContain(DISPATCH_INDEX);
    expect(scanKinds(laneCriticalCandidates.root)).not.toContain("Seq Scan");
    expect(rowsInspected(laneCriticalCandidates.root)).toBeLessThanOrEqual(SCAN_LIMIT * 3);

    // Lane A step 2 resolves at most SCAN_LIMIT UUID-screened ids by primary
    // key, then filters priority/status in JS. Keeping those predicates out of
    // SQL is intentional: otherwise PostgreSQL may drive from the company-wide
    // priority index and inspect every critical issue before applying the id
    // list. This shape never joins against or walks either total backlog.
    expect(indexesUsed(laneCriticalIssues.root)).toContain("issues_pkey");
    expect(scanKinds(laneCriticalIssues.root)).not.toContain("Seq Scan");
    expect(rowsInspected(laneCriticalIssues.root)).toBeLessThanOrEqual(SCAN_LIMIT * 3);

    // Lane B needs no join at all, and since migration 0209 its predicate is
    // index-restricted rather than filtered over the agent's queued rows. The
    // absolute bound this buys is asserted in its own test below, on a backlog
    // deep enough for the difference to be visible.
    expect(indexesUsed(laneRecovery.root)).toContain(RECOVERY_INDEX);
    expect(scanKinds(laneRecovery.root)).not.toContain("Seq Scan");

    // Resolving lane B's issues stays on the primary key.
    expect(indexesUsed(laneIssues.root)).toContain("issues_pkey");
    expect(scanKinds(laneIssues.root)).not.toContain("Seq Scan");

    // The bound is stated independently of AGENT_QUEUED_ROWS. Growing the
    // backlog therefore cannot make a single critical-lane query inspect more
    // work while the start lock is held.
    expect(SCAN_LIMIT * 3).toBeLessThan(TOTAL_ISSUES / 4);
  }, 900_000);

  /**
   * Review follow-up: the bound above is O(agent queue depth), and for lane B
   * that is not good enough.
   *
   * Lane B's predicate is entirely run-side, so before migration 0209 the
   * planner could only supply the agent's queued rows in dispatch order and
   * filter each one on two unindexed jsonb expressions. In the zero-match case
   * — the common one, since most agents have no recovery work — there is
   * nothing for the LIMIT to stop early on, so PostgreSQL walks the agent's
   * ENTIRE queued set to return nothing, while the strict per-agent start lock
   * is held.
   *
   * A separate fixture rather than a deeper version of the one above, for two
   * reasons. It needs a backlog several times SCAN_LIMIT to tell a bounded plan
   * from an unbounded one, and it needs no issues, no join and no 200k-row bulk
   * — so a focused fixture is both a sharper test and a much faster one. It
   * also keeps this measurement from perturbing the plans the first test
   * calibrates: those assertions are sensitive to the agent's row count and to
   * how the rows are physically clustered, and changing either to serve this
   * question would silently recalibrate them.
   */
  it("bounds the recovery lane absolutely, not by the agent's queue depth", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-blo20396-recovery-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql.unsafe(`SET session_replication_role = replica`);
    // The agent under test: a deep queued backlog with NO recovery work in it.
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, updated_at, context_snapshot)
      SELECT
        '${COMPANY}'::uuid,
        '${AGENT}'::uuid,
        'queued',
        now() - ((${DEEP_BACKLOG_ROWS} - series) || ' seconds')::interval,
        now(),
        jsonb_build_object(
          'issueId', '00000000-0000-4000-8000-' || lpad(series::text, 12, '0'),
          'source', 'github_pr_review_requested'
        )
      FROM generate_series(1, ${DEEP_BACKLOG_ROWS}) AS series
    `);
    // Other agents' recovery wakes. Without these the recovery index would be
    // globally EMPTY, and "inspected ~0 rows" would prove nothing — every plan
    // is cheap against an empty index. With them, the measured property is the
    // real one: the lane is bounded by this agent's slice of the index, not by
    // the index as a whole.
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, created_at, updated_at, context_snapshot)
      SELECT
        '${COMPANY}'::uuid,
        ('44444444-4444-4444-8444-' || lpad((series % 25)::text, 12, '0'))::uuid,
        'queued',
        now() - ((series % 5000) || ' seconds')::interval,
        now(),
        jsonb_build_object(
          'issueId', '00000000-0000-4000-8000-' || lpad(series::text, 12, '0'),
          'source', 'issue_recovery_action',
          'recoveryActionId', gen_random_uuid()
        )
      FROM generate_series(1, ${OTHER_AGENT_RECOVERY_ROWS}) AS series
    `);
    await sql.unsafe(`SET session_replication_role = origin`);
    await sql.unsafe(`ANALYZE heartbeat_runs`);

    const laneRecovery = await explain(sql, PRIORITY_LANE_RECOVERY);
    if (PLAN_REPORT) {
      fs.writeFileSync(
        `${PLAN_REPORT}.recovery`,
        `\n===== recovery lane, ${DEEP_BACKLOG_ROWS}-row non-recovery backlog =====\n`
          + `${laneRecovery.text}\n-- rows inspected: ${rowsInspected(laneRecovery.root)}`,
      );
    }

    // The fixture has to be deep enough that a filtered walk and a bounded scan
    // are actually distinguishable; asserting a ceiling against a shallow
    // backlog proves nothing.
    expect(DEEP_BACKLOG_ROWS).toBeGreaterThan(SCAN_LIMIT * 4);
    expect(indexesUsed(laneRecovery.root)).toContain(RECOVERY_INDEX);
    expect(scanKinds(laneRecovery.root)).not.toContain("Seq Scan");

    // The point of the whole exercise: a FIXED ceiling, not one that grows with
    // the queue. Pre-0209 this inspected DEEP_BACKLOG_ROWS.
    expect(rowsInspected(laneRecovery.root)).toBeLessThanOrEqual(RECOVERY_LANE_ABSOLUTE_BOUND);
    expect(RECOVERY_LANE_ABSOLUTE_BOUND).toBeLessThan(DEEP_BACKLOG_ROWS / 10);
  }, 300_000);

  /**
   * BLO-20736: the head scan's own bound, at production-shaped depth.
   *
   * The first test's `not.toContain("Sort")` assertion passed for the wrong
   * reason. At AGENT_QUEUED_ROWS = 350, packed densely at the tail of the heap,
   * PostgreSQL estimated the match set at a handful of rows and the ordered
   * index scan won by a hair — not because the plan was robust, but because the
   * estimate was tiny. `agent_id = X` and `status = 'queued'` are estimated
   * independently and multiplied, and they are in fact almost perfectly
   * correlated, so the estimate is wildly low: measured 200x low at depth 1000
   * (rows=5 vs 1000) and 42x low at depth 5000 (rows=120 vs 5000). Deepen the
   * queue and the planner flips to `Bitmap Heap Scan` + top-N `Sort`, which
   * cannot emit until it has consumed its whole input — so the dispatcher reads
   * and sorts the agent's ENTIRE queue to return SCAN_LIMIT rows, under the
   * strict per-agent start lock, and it gets worse as the backlog grows.
   *
   * Two properties are asserted, at two depths, against the SAME ceiling:
   * the head page is served by an ordered index-only scan with no Sort, and the
   * work it does is independent of queue depth. One depth cannot show the
   * second property, which is the one that actually matters.
   *
   * The fixture interleaves the agent's rows one per stride across the whole
   * insert order. The original packed 1000 rows into ~38 heap blocks, where
   * bitmap+sort is genuinely the better plan and the good plan is not worth
   * asserting. Interleaved, each queued row sits on its own heap page
   * (`Heap Blocks: exact=<depth>` in the report), which is the production shape.
   *
   * The fixture is also VACUUMed, and that is load-bearing rather than
   * incidental: an index-only scan is costed cheaply only when the visibility
   * map reports most pages all-visible, and on a NEVER-vacuumed table
   * (relallvisible = 0) the planner falls back to bitmap+sort even for this
   * projection. Production is continuously autovacuumed and the cost model reads
   * the table-wide relallvisible/relpages fraction, so a vacuumed fixture is the
   * honest one. Churn alone does not break it — updating every queued row and
   * re-ANALYZEing without a VACUUM still plans index-only.
   */
  it("bounds the dispatch head scan independently of queue depth", async () => {
    const report: string[] = [];
    /**
     * Same ceiling for every depth. Deriving it from the depth would make the
     * assertion vacuous: the whole claim is that the work does NOT grow.
     */
    const HEAD_ABSOLUTE_BOUND = SCAN_LIMIT * 3;

    for (const depth of DISPATCH_HEAD_DEPTHS) {
      const database = await startEmbeddedPostgresTestDatabase(`paperclip-blo20736-${depth}-`);
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => sql.end());

      await seedInterleavedQueue(sql, depth);
      const [{ queued }] = await sql.unsafe(
        `SELECT count(*)::int AS queued FROM heartbeat_runs
          WHERE agent_id = '${AGENT}'::uuid AND status = 'queued'`,
      ) as Array<{ queued: number }>;
      expect(queued).toBe(depth);

      const record = (title: string, plan: { text: string; root: Record<string, unknown> }) => {
        report.push(`\n===== ${title} =====\n${plan.text}\n-- rows inspected: ${rowsInspected(plan.root)}`);
        if (PLAN_REPORT) fs.writeFileSync(PLAN_REPORT, report.join("\n"));
      };

      // The shape the dispatcher used to issue, MEASURED but not asserted on —
      // it is the before-evidence for why the projection changed, and pinning
      // it would lock in the bad plan as a requirement.
      record(`depth ${depth}: head scan BEFORE (SELECT *)`, await explain(sql, DISPATCH_QUERY));

      const probe = await explain(sql, DISPATCH_HEAD_PROBE);
      record(`depth ${depth}: head probe (created_at, id only)`, probe);

      expect(indexesUsed(probe.root)).toContain(DISPATCH_INDEX);
      expect(scanKinds(probe.root)).not.toContain("Seq Scan");
      expect(scanKinds(probe.root)).not.toContain("Bitmap Heap Scan");
      // Ordered straight off the index. A Sort here would mean the whole match
      // set is consumed before the first row is emitted, which is the defect.
      expect(planNodes(probe.root).map((n) => n["Node Type"])).not.toContain("Sort");
      expect(scanKinds(probe.root)).toContain("Index Only Scan");
      expect(rowsInspected(probe.root)).toBeLessThanOrEqual(HEAD_ABSOLUTE_BOUND);

      // Same, resumed mid-queue: the cursor must be satisfied BY the index, not
      // rechecked after it, or every resumed pass re-walks the discarded prefix.
      const probeCursor = await explain(sql, DISPATCH_HEAD_PROBE_CURSOR);
      record(`depth ${depth}: head probe, resumed`, probeCursor);
      const probeCursorNode = indexScanNode(probeCursor.root, DISPATCH_INDEX);
      expect(probeCursorNode).not.toBeNull();
      expect(String(probeCursorNode?.["Index Cond"] ?? "")).toMatch(KEYSET_PREDICATE);
      expect(String(probeCursorNode?.["Filter"] ?? "")).not.toMatch(KEYSET_PREDICATE);
      expect(planNodes(probeCursor.root).map((n) => n["Node Type"])).not.toContain("Sort");
      expect(rowsInspected(probeCursor.root)).toBeLessThanOrEqual(HEAD_ABSOLUTE_BOUND);

      // Phase 2 hydrates exactly the probed page by primary key, so it is bounded
      // by SCAN_LIMIT and not by the queue behind it.
      const pageIds = (await sql.unsafe(
        `SELECT id FROM heartbeat_runs
          WHERE agent_id = '${AGENT}'::uuid AND status = 'queued'
          ORDER BY created_at ASC, id ASC LIMIT ${SCAN_LIMIT}`,
      ) as Array<{ id: string }>).map((row) => `'${row.id}'::uuid`);
      // Phase 2 hydrates exactly the probed page by primary key, so it is bounded
      // by SCAN_LIMIT and not by the queue behind it. The id list is the ONLY
      // predicate on purpose: adding `AND status = 'queued'` here makes the
      // dispatch index look attractive again and PostgreSQL drives the fetch
      // from it instead of the primary key, reintroducing the unbounded shape.
      // The dispatcher re-checks status in JS instead.
      const hydrate = await explain(
        sql,
        `SELECT * FROM heartbeat_runs WHERE id IN (${pageIds.join(", ")})`,
      );
      record(`depth ${depth}: page hydrate by primary key`, hydrate);
      expect(indexesUsed(hydrate.root)).toContain("heartbeat_runs_pkey");
      expect(scanKinds(hydrate.root)).not.toContain("Seq Scan");
      expect(rowsInspected(hydrate.root)).toBeLessThanOrEqual(HEAD_ABSOLUTE_BOUND * 2);

      while (cleanups.length > 0) await cleanups.pop()?.();
    }

    // The two depths are far enough apart, and deep enough, that a plan whose
    // work tracks the backlog cannot satisfy one ceiling at both.
    expect(DISPATCH_HEAD_DEPTHS[0]).toBeGreaterThanOrEqual(SCAN_LIMIT * 5);
    expect(DISPATCH_HEAD_DEPTHS[1]).toBeGreaterThanOrEqual(DISPATCH_HEAD_DEPTHS[0]! * 5);
    expect(HEAD_ABSOLUTE_BOUND).toBeLessThan(DISPATCH_HEAD_DEPTHS[0]! / 1.5);
  }, 900_000);
});

