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
 *
 * BLO-31354: every plan-shape assertion here is made against the projection the
 * dispatcher actually issues — the keyset-only page from
 * `readQueuedDispatchPage`, which both the main and critical lanes call. The
 * superseded `SELECT *` shapes are still measured and recorded, but asserting
 * on them pinned a plan choice that sits inside PostgreSQL's 1% cost fuzz
 * against `heartbeat_runs_queued_age_idx` + Sort, so the winner was decided by
 * ANALYZE's random sample and the test ejected unrelated PRs from the merge
 * queue. See DISPATCH_QUERY_BEFORE for the measurements.
 *
 * Scope: the assertions cover the dispatcher's PROJECTION, exercised as a
 * custom plan. They do NOT cover the generic plan production actually executes
 * for the prepared statement, which is separately known to pick the wrong
 * index — see the scope limit on `explain` below, and BLO-31392.
 *
 * Second scope limit, on the word "actually" above: the projection is mirrored
 * BY HAND in DISPATCH_HEAD_PROBE. Nothing here reads `readQueuedDispatchPage`'s
 * SQL, so if production reverts to `SELECT *` these assertions stay green while
 * pinning a plan production no longer issues. Verified by reading
 * `server/src/services/heartbeat.ts` when this file changes; unenforced between
 * those reads.
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
/**
 * BLO-31392. Migration 0237's index: same `status = 'queued'` predicate as
 * 0217's queue-age index, but with (created_at, id) as trailing keys so it can
 * satisfy the dispatcher's ORDER BY directly.
 */
const QUEUED_DISPATCH_INDEX = "heartbeat_runs_agent_queued_dispatch_idx";
/** Migration 0217's queue-age index — applicable to the dispatch filter but NOT ordered for it. */
const AGE_INDEX = "heartbeat_runs_queued_age_idx";
/**
 * Indexes that carry (created_at, id) in the ORDER BY's order, so the head page
 * can be emitted without a Sort. The assertion below deliberately accepts
 * EITHER rather than pinning one: measured generic costs for the cursor-bearing
 * shapes are 5.08 vs 5.16 and 4.58 vs 4.61 — inside and beside PostgreSQL's 1%
 * STD_FUZZ_FACTOR. Pinning the winner would recreate exactly the knife-edge
 * flake BLO-31354 was filed for. The load-bearing property is "ordered,
 * index-only, no Sort", not which of the two ordered indexes supplies it.
 */
const ORDERED_DISPATCH_INDEXES = [QUEUED_DISPATCH_INDEX, DISPATCH_INDEX];
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

/**
 * `rowsInspected` for the PLAN REPORT, which mixes executed and non-executed
 * plans in one file.
 *
 * `EXPLAIN (GENERIC_PLAN)` never runs the query, so no node carries
 * `Actual Rows` and every counter `rowsInspected` sums defaults to 0. Printing
 * that as `rows inspected: 0` renders the LEAST informative case ("not
 * executed, nothing measured") as the MOST reassuring one ("examined no rows
 * at all") — and it does so directly beneath entries where the same number is
 * a real measurement. This report is what a human reads when comparing the
 * fixture against production's `EXPLAIN (GENERIC_PLAN)` for BLO-31392, so the
 * two kinds of zero have to stay distinguishable.
 */
function formatRowsInspected(node: Record<string, unknown>): string {
  const executed = planNodes(node).some((entry) => entry["Actual Rows"] !== undefined);
  return executed ? String(rowsInspected(node)) : "n/a (not executed — EXPLAIN without ANALYZE)";
}

/**
 * BLO-31392: which ordering-capable dispatch index this plan used, if any.
 *
 * Every assertion in this file that used to name `heartbeat_runs_agent_dispatch_idx`
 * goes through here instead. The reason is not tolerance for drift — it is that
 * the identity of the winner was never the invariant. Migration 0237 added a
 * SECOND index that satisfies `agent_id = ? AND status = 'queued'` in
 * `(created_at, id)` order, and it is deliberately NARROWER than 0208's (whose
 * predicate spans `status IN ('queued', 'scheduled_retry')`), so for the
 * queued-only predicates below the planner now legitimately prefers it. Pinning
 * either name turns a correct planner choice between two correct plans into a
 * red build — and this test gates the merge queue, so that is not a cosmetic
 * cost. BLO-31354 was filed because these plans sit inside PostgreSQL's 1%
 * STD_FUZZ_FACTOR and the winner flips on ANALYZE's random sample.
 *
 * What still IS asserted, unchanged and at every site: no `Seq Scan`, no
 * `Bitmap Heap Scan`, no `Sort`, the keyset predicate resolved in `Index Cond`
 * rather than `Filter`, and an absolute bound on rows inspected. Those are the
 * properties BLO-20396 and BLO-20736 were closed on. Whichever of the two
 * ordered indexes supplies them is an implementation detail.
 *
 * `heartbeat_runs_queued_age_idx` is NOT in this set and must never be: its
 * second key is `coalesce(queued_at, created_at)`, so it cannot supply this
 * ORDER BY and its plans always carry the `Sort` this whole test exists to
 * forbid.
 */
function orderedDispatchIndexScanNode(
  node: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    planNodes(node).find(
      (entry) =>
        typeof entry["Index Name"] === "string"
        && ORDERED_DISPATCH_INDEXES.includes(entry["Index Name"] as string),
    ) ?? null
  );
}

/** Assert the plan is served by one of the ordering-capable dispatch indexes. */
function expectOrderedDispatchIndex(node: Record<string, unknown>) {
  const used = indexesUsed(node);
  expect(
    used.some((name) => ORDERED_DISPATCH_INDEXES.includes(name)),
    `expected one of ${ORDERED_DISPATCH_INDEXES.join(" | ")}, got [${used.join(", ")}]`,
  ).toBe(true);
  // The queue-age index cannot supply (created_at, id) ordering, so its
  // presence here means a Sort was reintroduced. Called out separately from the
  // generic `not.toContain("Sort")` checks because this is the specific
  // regression BLO-31392 was filed for, and the failure message should say so.
  expect(used).not.toContain(AGE_INDEX);
}

/**
 * The keyset predicate as PostgreSQL renders a row comparison, e.g.
 * `((created_at, id) > ('...'::timestamptz, '...'::uuid))`. Matched as a row
 * constructor rather than by substring: bare `id` also appears inside
 * `agent_id`, so `toContain("id")` would pass on a plan that never used the
 * cursor at all.
 */
const KEYSET_PREDICATE = /\(\s*created_at\s*,\s*id\s*\)/;

/**
 * BLO-31392: the head scan in BOUND-PARAMETER form, for EXPLAIN (GENERIC_PLAN).
 *
 * Everything else in this file interpolates literals, which is what the
 * dispatcher's `status = 'queued'` really is — but `agent_id` is a BOUND
 * parameter in production (Drizzle `eq`), and postgres.js prepares by default.
 * A statement with a bound parameter gets custom plans for five executions and
 * then the generic plan if it costs less, so the literal-only assertions above
 * measure a plan production may stop using. `$1` here is what makes this the
 * generic case; the projection and ORDER BY are otherwise identical.
 *
 * LIMIT is a PLACEHOLDER, not a literal, because production binds it too:
 * `readQueuedDispatchPage` ends in `.limit(input.limit)`, and drizzle's PG
 * dialect emits that as ``sql` limit ${limit}` `` (pg-core/dialect.ts), where an
 * interpolated number becomes a bind parameter — so the text production
 * prepares ends in `LIMIT $n`, never `LIMIT 200`.
 *
 * This matters to the plan, but in the OPPOSITE direction to the obvious guess,
 * so measure before changing it back. `preprocess_limit()` reads a constant
 * LIMIT into an absolute tuple count and a non-constant one into `count_est =
 * -1`, which falls back to assuming 10% of rows are fetched. Here `LIMIT 200`
 * is 2-200x LARGER than the generic estimate (1-91 rows), so as a literal it
 * normalises to "retrieve all rows" and a Sort's startup cost is fully
 * amortised; the 10% fraction is what charges that startup in full. Measured on
 * this fixture, depth 1000, head shape:
 *
 *   LIMIT 200 literal:  Limit cost=0.28..4.73 rows=20  (= the whole scan)
 *   LIMIT $n bound:     Limit cost=0.28..0.70 rows=2   (scan alone is 4.75)
 *
 * So binding it makes this probe faithful to production AND makes the no-Sort
 * assertion easier to satisfy, not harder. Do not read the placeholder as the
 * strict choice — the negative control below is what carries this test.
 *
 * The cutoff arm's `$n` is deliberately UNCAST, matching production's
 * `gte(heartbeatRuns.createdAt, input.cutoff)`, which binds through the column
 * mapper with no explicit cast. Measured both ways on a 2000-row fixture: the
 * plans are identical — same index, same `0.28..9.88` cost, and PostgreSQL
 * renders the same `Index Cond: (created_at >= $2)` either way, because
 * operator resolution against a `timestamptz` column types the parameter
 * regardless. So the cast was pure divergence with no planner effect, and
 * dropping it costs nothing. The CURSOR arm below keeps its casts: it is a
 * row-wise comparison, where the unknowns are not resolvable from a single
 * column, and production casts there explicitly too.
 */
function dispatchHeadProbeGenericQuery(shape: { cutoff: boolean; cursor: boolean }) {
  let next = 2;
  const cutoff = shape.cutoff ? `AND created_at >= $${next++}` : "";
  const cursor = shape.cursor
    ? `AND (created_at, id) > ($${next++}::timestamptz, $${next++}::uuid)`
    : "";
  return `
    SELECT created_at::text AS dispatch_created_at_cursor, id FROM heartbeat_runs
     WHERE agent_id = $1 AND status = 'queued'
       ${cutoff}
       ${cursor}
     ORDER BY created_at ASC, id ASC
     LIMIT $${next++}
  `;
}

/**
 * All four predicate shapes `readQueuedDispatchPage` can emit. Each is a
 * DISTINCT SQL text, so each gets its own plan-cache entry and makes its own
 * custom-vs-generic decision — the head shape being safe says nothing about the
 * paging shape, which is the one a deep queue actually spends its time in.
 */
const DISPATCH_PREDICATE_SHAPES = [
  { label: "head (no cutoff, no cursor)", cutoff: false, cursor: false },
  { label: "cutoff only", cutoff: true, cursor: false },
  { label: "cursor only (paging)", cutoff: false, cursor: true },
  { label: "cutoff and cursor", cutoff: true, cursor: true },
] as const;

async function explainGeneric(sql: postgres.Sql, query: string) {
  const rows = await sql.unsafe(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${query}`);
  const plan = (rows[0] as Record<string, unknown>)["QUERY PLAN"] as Array<Record<string, unknown>>;
  const root = plan[0].Plan as Record<string, unknown>;
  const text = await sql.unsafe(`EXPLAIN (GENERIC_PLAN) ${query}`);
  return {
    root,
    text: text.map((row) => String((row as Record<string, unknown>)["QUERY PLAN"])).join("\n"),
  };
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
  // VACUUM, not just ANALYZE — for the same reason seedInterleavedQueue does it,
  // and it is load-bearing here rather than tidiness. The dispatcher's head page
  // is served by an INDEX ONLY scan, and index-only scans are costed against the
  // visibility map: on a never-vacuumed table (relallvisible = 0) the planner
  // must assume every tuple needs a heap visibility check, prices the ordered
  // path as if it fetched heap, and the result lands within ~1% of
  // heartbeat_runs_queued_age_idx + Sort. Inside PostgreSQL's 1% fuzz factor the
  // winner is decided by ANALYZE's random sample, which is how BLO-31354 ejected
  // an unrelated PR from the merge queue. Measured on this fixture: without
  // VACUUM the two plans sit 0.01 cost units apart (-0.86%..+0.18%, flipping);
  // with it the ordered path wins by +185%..+273% across 20 re-ANALYZEs.
  // heartbeat_runs is continuously autovacuumed in production and the cost model
  // reads the table-wide relallvisible/relpages fraction, so vacuuming here is
  // what makes the fixture honest rather than what makes it pass.
  await sql.unsafe(`VACUUM ANALYZE heartbeat_runs`);
  await sql.unsafe(`ANALYZE issues`);
}

/**
 * SCOPE LIMIT — this exercises the CUSTOM plan only.
 *
 * The statement is interpolated with literals, so the planner sees constant
 * values and plans for them. Production instead binds `agent_id` through a
 * prepared statement (postgres.js prepares by default) and under
 * `plan_cache_mode = auto` switches to the GENERIC plan once the cost check
 * favours it. Those plans differ here, and the generic one is currently WRONG:
 * measured on production it picks `heartbeat_runs_queued_age_idx` plus a `Sort`
 * rather than the ordered dispatch index, because that index's partial
 * predicate is exactly `status = 'queued'` while its `Index Cond` bounds only
 * `agent_id = $1`. So the assertions below can be green while production runs
 * the plan they forbid. That live defect is BLO-31392, which owns the
 * `EXPLAIN (GENERIC_PLAN)` assertion; nothing in this file covers it. Read
 * every plan-shape claim here as "for the statement as written", not "for the
 * plan production executes".
 */
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

/**
 * The head page as the dispatcher issued it BEFORE BLO-20736, kept as recorded
 * evidence and deliberately NOT asserted on — same policy as
 * PRIORITY_LANE_BEFORE below and as the `SELECT *` record in the head-scan test.
 *
 * `readQueuedDispatchPage` replaced this with the two-phase read: phase 1
 * projects only the keyset columns, phase 2 hydrates that page by primary key.
 * Nothing in the dispatcher issues `SELECT *` ordered by (created_at, id) any
 * more — the main lane and the critical lane both call that one function.
 *
 * Pinning this shape's plan is what made BLO-31354 flaky. Fetching whole ~2.8 kB
 * rows in index order prices the ordered path against random heap I/O, which
 * lands it within PostgreSQL's 1% fuzz factor of
 * heartbeat_runs_queued_age_idx + Sort — 20.15 vs 20.14 cost units at the
 * fixture's estimate. Inside the fuzz the winner is whichever way ANALYZE's
 * random sample fell, so this assertion was a coin flip on a merge-queue gate.
 * The property it was meant to protect is asserted below on the projection the
 * dispatcher actually issues, where the same fixture prefers the ordered path by
 * +185%..+273%.
 */
const DISPATCH_QUERY_BEFORE = `
  SELECT * FROM heartbeat_runs
   WHERE agent_id = '${AGENT}'::uuid
     AND status = 'queued'
   ORDER BY created_at ASC, id ASC
   LIMIT ${SCAN_LIMIT}
`;

const DISPATCH_CURSOR_QUERY_BEFORE = `
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
 *
 * The projection is the dispatcher's, not `SELECT *`: production's critical
 * lane calls the very same `readQueuedDispatchPage` as the main lane, so its
 * step 1 IS the keyset-only index-only read. Measuring `SELECT *` here would
 * measure a statement the dispatcher does not issue, and would reintroduce the
 * BLO-31354 near-tie that this projection removes.
 */
const PRIORITY_LANE_CRITICAL_CANDIDATES = `
  SELECT created_at::text AS dispatch_created_at_cursor, id FROM heartbeat_runs
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
 * Where to resume from when probing `seed`'s fixture mid-queue, expressed as an
 * OFFSET into the agent's own backlog rather than as a wall-clock interval.
 *
 * A `now() - interval` bound cannot express "mid-queue" against this fixture.
 * `seed` stamps row `series` at `now() - (AGENT_QUEUED_ROWS - series)` seconds,
 * so a bound of `now() - interval 'N seconds'` evaluated `d` seconds later
 * qualifies `series > AGENT_QUEUED_ROWS - N + d` — i.e. `N - d` rows, one fewer
 * per second of elapsed setup time. Here `d` spans a 200k-row INSERT, a
 * VACUUM ANALYZE and several EXPLAIN ANALYZE calls, so the resumed page shrinks
 * with runner load and at `d >= N` sits past the entire backlog and resumes
 * nothing. That degrades SILENTLY: index name, `Index Cond`, `Filter` and
 * `Index Only Scan` are all plan properties independent of row count, so the
 * assertions below would still pass while covering an empty page. Resolving the
 * cursor from a real row instead is mid-queue by construction at any `d` — the
 * same approach the deferred passes already take.
 *
 * Offset so that exactly SCAN_LIMIT rows remain behind the cursor: the resumed
 * page then saturates its LIMIT, which is what makes the bounded-work assertion
 * meaningful rather than merely satisfied by a short page.
 */
const MID_QUEUE_CURSOR_OFFSET = AGENT_QUEUED_ROWS - SCAN_LIMIT - 1;

function dispatchHeadProbeQuery(cursor: { createdAt: string; id: string } | null = null) {
  return `
    SELECT created_at::text AS dispatch_created_at_cursor, id FROM heartbeat_runs
     WHERE agent_id = '${AGENT}'::uuid
       AND status = 'queued'
       ${cursor ? `AND (created_at, id) > ('${cursor.createdAt}'::timestamptz, '${cursor.id}'::uuid)` : ""}
     ORDER BY created_at ASC, id ASC
     LIMIT ${SCAN_LIMIT}
  `;
}

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
 * That "asserting the wrong thing" argument is about a projection that FETCHES
 * THE HEAP, which is what this file used to assert on. It does not apply to the
 * keyset-only projection: with no heap access to price, clustering stops
 * deciding the plan, which is why the head-scan test above does assert the
 * ordered index-only plan on `seed`'s fixture and measures a +185%..+273%
 * margin there rather than the old 1% tie. Do not read the paragraph above as
 * grounds for deleting those assertions — if one of them goes red, the
 * projection or the index is the thing that changed, not the fixture.
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
      report.push(`\n===== ${title} =====\n${plan.text}\n-- rows inspected: ${formatRowsInspected(plan.root)}`);
      if (PLAN_REPORT) fs.writeFileSync(PLAN_REPORT, report.join("\n"));
    };

    // --- AC: the dispatch query uses the new index -------------------------
    // The superseded `SELECT *` shape is RECORDED, not asserted on — see
    // DISPATCH_QUERY_BEFORE. Asserting its plan is what made this test eject
    // unrelated PRs from the merge queue (BLO-31354).
    record("dispatch head scan BEFORE (SELECT *)", await explain(sql, DISPATCH_QUERY_BEFORE));
    record(
      "dispatch keyset cursor scan BEFORE (SELECT *)",
      await explain(sql, DISPATCH_CURSOR_QUERY_BEFORE),
    );

    const head = await explain(sql, DISPATCH_HEAD_PROBE);
    record("dispatch head scan", head);
    expectOrderedDispatchIndex(head.root);
    expect(scanKinds(head.root)).not.toContain("Seq Scan");

    // Resume from a real row rather than a wall-clock interval, so the page is
    // mid-queue regardless of how long the fixture took to build — see
    // MID_QUEUE_CURSOR_OFFSET.
    const midQueueCursorRow = (await sql.unsafe(
      `SELECT created_at::text AS created_at_text, id::text AS id FROM heartbeat_runs
        WHERE agent_id = '${AGENT}'::uuid AND status = 'queued'
        ORDER BY created_at ASC, id ASC
        OFFSET ${MID_QUEUE_CURSOR_OFFSET} LIMIT 1`,
    ) as Array<{ created_at_text: string; id: string }>)[0];
    expect(midQueueCursorRow).toBeDefined();
    const midQueueCursorQuery = dispatchHeadProbeQuery({
      createdAt: midQueueCursorRow!.created_at_text,
      id: midQueueCursorRow!.id,
    });

    const cursor = await explain(sql, midQueueCursorQuery);
    record("dispatch keyset cursor scan", cursor);
    expectOrderedDispatchIndex(cursor.root);

    // It is not enough that the index appears somewhere in the plan: the keyset
    // predicate has to be SATISFIED BY the index rather than re-checked after
    // it. If `(created_at, id) > (...)` lands in `Filter` instead of
    // `Index Cond`, PostgreSQL walks the agent's partition from the beginning
    // and discards the prefix on every resumed pass — the scan is then bounded
    // only by LIMIT on OUTPUT, which is the unbounded-work shape the resume
    // cursor exists to remove. That plan still contains the index name, so the
    // assertion above cannot distinguish it.
    const cursorNode = orderedDispatchIndexScanNode(cursor.root);
    expect(cursorNode).not.toBeNull();
    expect(String(cursorNode?.["Index Cond"] ?? "")).toMatch(KEYSET_PREDICATE);
    expect(String(cursorNode?.["Filter"] ?? "")).not.toMatch(KEYSET_PREDICATE);

    // The resumed page must actually RESUME A FULL PAGE. Every other assertion
    // on `cursor` is a plan property that holds trivially — and in
    // `rowsInspected`'s case MORE easily — on a short or empty page, so without
    // this the mid-queue coverage can vanish while the test stays green. That
    // is exactly how the previous wall-clock cursor degraded: measured on one
    // runner it resumed 166 rows instead of 200, losing 17% of its coverage
    // silently.
    //
    // MID_QUEUE_CURSOR_OFFSET is derived to leave SCAN_LIMIT rows after the
    // cursor row, so a full page is the only correct answer — but that
    // derivation is only sound while the fixture really seeds
    // AGENT_QUEUED_ROWS queued rows for AGENT. Assert the seeded count itself,
    // because that is the invariant a fixture change actually breaks (an edit
    // to `generate_series` in `seed`, or any second writer of queued rows for
    // this agent). Restating the offset arithmetic here instead would reduce to
    // `SCAN_LIMIT >= SCAN_LIMIT` and could never fail.
    const seededQueued = Number(
      (
        (await sql.unsafe(
          `SELECT count(*)::int AS n FROM heartbeat_runs
            WHERE agent_id = '${AGENT}'::uuid AND status = 'queued'`,
        )) as Array<{ n: number }>
      )[0]!.n,
    );
    expect(seededQueued).toBe(AGENT_QUEUED_ROWS);
    expect(Number(cursor.root["Actual Rows"] ?? 0)).toBe(SCAN_LIMIT);

    // The resumed page is held to the same plan shape as the head page, and to
    // the same shape the deep-queue test asserts on its own cursor: a Sort
    // would mean the whole remaining match set is consumed before the first row
    // is emitted, and anything other than an index-only scan means the cursor
    // page pays heap I/O the projection exists to avoid.
    expect(planNodes(cursor.root).map((n) => n["Node Type"])).not.toContain("Sort");
    expect(scanKinds(cursor.root)).toContain("Index Only Scan");
    expect(scanKinds(cursor.root)).not.toContain("Bitmap Heap Scan");

    // The index supplies (created_at, id) order, so no Sort over wide rows.
    expect(planNodes(head.root).map((n) => n["Node Type"])).not.toContain("Sort");
    // What keeps the assertions above off the cost-model knife edge: with no
    // heap fetches to pay for, the ordered path is not merely the planner's
    // narrow preference over heartbeat_runs_queued_age_idx + Sort but its
    // decisive one. This is the assertion that would fail first if a future
    // change reverted the projection to `SELECT *`.
    expect(scanKinds(head.root)).toContain("Index Only Scan");
    expect(scanKinds(head.root)).not.toContain("Bitmap Heap Scan");

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
    expectOrderedDispatchIndex(laneCriticalCandidates.root);
    expect(scanKinds(laneCriticalCandidates.root)).not.toContain("Seq Scan");
    // Same reason as the head scan above: the keyset-only projection is what
    // keeps this off the BLO-31354 knife edge against
    // heartbeat_runs_queued_age_idx + Sort.
    expect(scanKinds(laneCriticalCandidates.root)).toContain("Index Only Scan");
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
    //
    // THIS PIN IS DELIBERATE, unlike the dispatch-lane ones above (which
    // BLO-31392 relaxed to `expectOrderedDispatchIndex`). Read this before
    // adding another `status = 'queued'` index.
    //
    // 0237 made this lane a two-horse race for the first time: it has the
    // IDENTICAL key columns to 0209 — `(agent_id, created_at, id)` — and a
    // strictly WIDER predicate (`status = 'queued'` alone), which this query's
    // `status = 'queued' AND source = ... AND recoveryActionId IS NOT NULL`
    // implies. So 0237 is now a legitimate candidate here, which is exactly the
    // shape that made the dispatch pins flake (BLO-31354).
    //
    // It is pinned anyway because the margin is wide rather than knife-edge,
    // and for a structural reason rather than a cost one: 0209 absorbs BOTH
    // JSON qualifiers into its predicate, so it holds only recovery rows and
    // applies no `Filter`; 0237 holds the agent's ENTIRE queued backlog and
    // would have to re-check both qualifiers as a `Filter`. The dispatch lane
    // sat on a 0.24% margin because the two indexes there differed only in
    // predicate width over near-identical row sets. Here the row sets differ by
    // orders of magnitude, in 0209's favour.
    //
    // And the pin is not the only guard: `rowsInspected` below is bounded by
    // RECOVERY_LANE_ABSOLUTE_BOUND, so picking 0237 fails on WORK VOLUME too,
    // not merely on a name. If this ever does flake, that is the signal to
    // check — a name-only failure with the bound still satisfied means the
    // planner found an equally cheap path and the pin should be relaxed; the
    // bound failing too means a real regression.
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
          + `${laneRecovery.text}\n-- rows inspected: ${formatRowsInspected(laneRecovery.root)}`,
      );
    }

    // The fixture has to be deep enough that a filtered walk and a bounded scan
    // are actually distinguishable; asserting a ceiling against a shallow
    // backlog proves nothing.
    expect(DEEP_BACKLOG_ROWS).toBeGreaterThan(SCAN_LIMIT * 4);
    // Deliberate name pin — see the long note at the other RECOVERY_INDEX
    // assertion for why 0237 is a candidate here and why the margin is safe.
    // This site is the stronger of the two: the fixture's backlog is
    // deliberately deep and non-recovery, so 0237 would hold DEEP_BACKLOG_ROWS
    // rows to 0209's handful.
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
        report.push(`\n===== ${title} =====\n${plan.text}\n-- rows inspected: ${formatRowsInspected(plan.root)}`);
        if (PLAN_REPORT) fs.writeFileSync(PLAN_REPORT, report.join("\n"));
      };

      // The shape the dispatcher used to issue, MEASURED but not asserted on —
      // it is the before-evidence for why the projection changed, and pinning
      // it would lock in the bad plan as a requirement.
      record(`depth ${depth}: head scan BEFORE (SELECT *)`, await explain(sql, DISPATCH_QUERY_BEFORE));

      const probe = await explain(sql, DISPATCH_HEAD_PROBE);
      record(`depth ${depth}: head probe (created_at, id only)`, probe);

      expectOrderedDispatchIndex(probe.root);
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
      const probeCursorNode = orderedDispatchIndexScanNode(probeCursor.root);
      expect(probeCursorNode).not.toBeNull();
      expect(String(probeCursorNode?.["Index Cond"] ?? "")).toMatch(KEYSET_PREDICATE);
      expect(String(probeCursorNode?.["Filter"] ?? "")).not.toMatch(KEYSET_PREDICATE);
      expect(planNodes(probeCursor.root).map((n) => n["Node Type"])).not.toContain("Sort");
      expect(rowsInspected(probeCursor.root)).toBeLessThanOrEqual(HEAD_ABSOLUTE_BOUND);

      /**
       * BLO-31392: the same guarantee under the GENERIC plan, for every one of
       * the four predicate shapes.
       *
       * Everything above interpolates `agent_id` as a literal, so PostgreSQL
       * plans it one-shot as a custom plan. Production BINDS it, prepares the
       * statement, and after five executions may switch to the generic plan for
       * the life of a pooled connection — so the assertions above can be green
       * on a plan production has stopped using. That is the gap that let this
       * defect through, and `EXPLAIN (GENERIC_PLAN)` is what closes it.
       *
       * READ THIS BEFORE TRUSTING GREEN. This assertion does NOT reproduce the
       * production inversion, and it is important not to mistake it for a
       * regression test that would. Measured 2026-09-03 on this fixture family:
       *
       *   fixture, VACUUMed:    dispatch_idx 4.30 (no Sort) vs age_idx 8.32 (Sort)
       *   fixture, relallvisible=0: dispatch_idx 8.30      vs age_idx 8.32
       *   PRODUCTION:           dispatch_idx 5.84          vs age_idx 2.50 (Sort WINS)
       *
       * The controlling variable is the visibility map, not the row estimate
       * (swept agent cardinality from 200 to 20,000 — n_distinct 200..20054,
       * estimates 1..10 rows — and the ordered index won every time). An
       * index-only scan is only costed cheaply when relallvisible/relpages is
       * high; every fixture here VACUUMs immediately before measuring and gets
       * the full discount, while production churns continuously and does not —
       * `Heap Fetches: 18` in the production plan is the fingerprint. Forcing
       * relallvisible to 0 brings the two within 0.24%, i.e. inside
       * STD_FUZZ_FACTOR, but still does not invert them.
       *
       * The same measurement run against the index THIS issue adds, 0237 vs
       * 0217 head-to-head at the 1-row generic estimate, says the fix inherits
       * the same ceiling:
       *
       *   relallvisible/relpages = 1.00:  4.30 vs 8.32  -> 48.3% cheaper
       *   relallvisible/relpages = 0.00:  8.30 vs 8.32  ->  0.24% cheaper
       *
       * Production is the second row. So the index is necessary but probably
       * not sufficient, and this assertion should not be read as proof that
       * production stopped sorting — at a 1-row estimate a Sort costs ~0.02 and
       * no index design beats a smaller unordered one by more than a rounding
       * error. Only taking the statement off the generic plan makes it
       * deterministic. Tracked on BLO-31392.
       *
       * So what this DOES catch: losing every ordering-capable index, a
       * projection change that stops the scan being index-only, or a future
       * narrower partial index that beats both. What it does NOT catch is
       * production's specific cost inversion. That needs the production
       * `EXPLAIN (GENERIC_PLAN)` recorded on BLO-31392.
       */
      for (const shape of DISPATCH_PREDICATE_SHAPES) {
        const genericQuery = dispatchHeadProbeGenericQuery(shape);
        const generic = await explainGeneric(sql, genericQuery);
        record(`depth ${depth}: GENERIC plan, ${shape.label}`, {
          text: generic.text,
          root: generic.root,
        });

        // A Sort cannot emit its first row until it has consumed its whole
        // input, so a Sort here means LIMIT stops bounding the work and the
        // dispatcher reads the agent's entire backlog under the start lock.
        expect(planNodes(generic.root).map((node) => node["Node Type"])).not.toContain("Sort");
        expect(scanKinds(generic.root)).not.toContain("Seq Scan");
        expect(scanKinds(generic.root)).not.toContain("Bitmap Heap Scan");
        expect(scanKinds(generic.root)).toContain("Index Only Scan");
        // Either ordered index is acceptable (see ORDERED_DISPATCH_INDEXES);
        // the queue-age index is not, because it cannot supply this ORDER BY.
        expect(indexesUsed(generic.root)).not.toContain(AGE_INDEX);
        expect(
          indexesUsed(generic.root).some((name) => ORDERED_DISPATCH_INDEXES.includes(name)),
        ).toBe(true);

        /**
         * NEGATIVE CONTROL — the assertion above is green on UNFIXED code, so
         * on its own it does not test this fix at all.
         *
         * Measured on this fixture: without 0237, the generic plan still picks
         * 0208's dispatch index (4.30) over the queue-age index (8.32), so
         * every assertion above passes with the fix reverted. That is the exact
         * "green forever" shape BLO-31354 was filed for, one level up — an
         * assertion that looks like a regression test and is not one.
         *
         * The reproduction condition for production's inversion is a low
         * visibility fraction (production reported `Heap Fetches: 18`; this
         * fixture VACUUMs immediately before measuring and gets a full
         * index-only discount it does not), and it could not be reproduced here
         * — forcing relallvisible to 0 brought the two within 0.24% but never
         * inverted them. So rather than chase a cost inversion this fixture
         * cannot produce, isolate the CAPABILITY the fix adds.
         *
         * Drop 0208's index inside a transaction that is always rolled back.
         * The queue-age index is then the only OTHER candidate, and it cannot
         * supply `(created_at, id)` ordering at any cost — so the absence of a
         * Sort here is possible if and only if 0237 exists and serves this
         * query. This fails deterministically with the fix reverted, on a
         * structural impossibility rather than a cost margin, which is also why
         * it cannot become the next knife-edge flake.
         *
         * Driving transaction state through raw BEGIN/ROLLBACK is only correct
         * because this pool is `max: 1` (see the `postgres(...)` call above), so
         * the DROP and both EXPLAINs are guaranteed the same connection. Widen
         * the pool and this control breaks in two ways at once: the EXPLAINs may
         * run on a connection that still has the index, silently voiding the
         * control, or the non-concurrent DROP INDEX (ACCESS EXCLUSIVE) may block
         * on a connection waiting for the ROLLBACK that would release it. If the
         * pool ever needs to grow, convert this to `sql.begin(async (tx) => ...)`,
         * which is pool-independent and rolls back on throw.
         */
        await sql.unsafe("BEGIN");
        try {
          await sql.unsafe(`DROP INDEX ${DISPATCH_INDEX}`);
          const isolated = await explainGeneric(sql, genericQuery);
          record(
            `depth ${depth}: GENERIC plan, ${shape.label}, ${DISPATCH_INDEX} dropped`,
            { text: isolated.text, root: isolated.root },
          );
          expect(indexesUsed(isolated.root)).toContain(QUEUED_DISPATCH_INDEX);
          expect(planNodes(isolated.root).map((node) => node["Node Type"])).not.toContain("Sort");
          expect(scanKinds(isolated.root)).toContain("Index Only Scan");
        } finally {
          // Restores the index for every later assertion in this test.
          await sql.unsafe("ROLLBACK");
        }
      }

      // Deferred emergency-admission refusals are filtered *after* the raw
      // cursor-bearing probe in production. If they were pushed into SQL as
      // `NOT IN (...)`, PostgreSQL would have to keep walking the ordered index
      // until it found SCAN_LIMIT non-deferred rows or proved none remained.
      // Simulate several pages of deferred ids: each raw probe remains bounded,
      // advances from the unfiltered page, and liveness reaches the next
      // non-deferred page.
      const deferredRows = await sql.unsafe(
        `SELECT created_at::text AS created_at_text, id::text AS id FROM heartbeat_runs
          WHERE agent_id = '${AGENT}'::uuid AND status = 'queued'
          ORDER BY created_at ASC, id ASC
          LIMIT ${SCAN_LIMIT * 3}`,
      ) as Array<{ created_at_text: string; id: string }>;
      expect(deferredRows).toHaveLength(SCAN_LIMIT * 3);
      const deferredIds = new Set(deferredRows.map((row) => row.id));
      let deferredCursor: { createdAt: string; id: string } | null = null;
      for (let pass = 0; pass < 3; pass += 1) {
        const deferredProbeQuery = dispatchHeadProbeQuery(deferredCursor);
        const deferredProbe = await explain(sql, deferredProbeQuery);
        record(`depth ${depth}: deferred raw probe pass ${pass + 1}`, deferredProbe);
        expect(rowsInspected(deferredProbe.root)).toBeLessThanOrEqual(HEAD_ABSOLUTE_BOUND);

        const rawPage = await sql.unsafe(deferredProbeQuery) as Array<{
          dispatch_created_at_cursor: string;
          id: string;
        }>;
        expect(rawPage).toHaveLength(SCAN_LIMIT);
        expect(rawPage.every((row) => deferredIds.has(row.id))).toBe(true);
        const last = rawPage[rawPage.length - 1]!;
        deferredCursor = { createdAt: last.dispatch_created_at_cursor, id: last.id };
      }
      const afterDeferredRows = await sql.unsafe(dispatchHeadProbeQuery(deferredCursor)) as Array<{
        dispatch_created_at_cursor: string;
        id: string;
      }>;
      expect(afterDeferredRows).toHaveLength(SCAN_LIMIT);
      expect(afterDeferredRows.every((row) => !deferredIds.has(row.id))).toBe(true);

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
