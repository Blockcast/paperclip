/**
 * PEN-5937: the run->project attribution repair, and the two properties that decide
 * whether moving attribution from read time to write time actually removed this row's
 * cliff rather than relocating it.
 *
 * 1. THE ISSUE PROBE MUST RIDE `issues_pkey`. The read-time query this replaces joined
 *    `issues` on `i.id::text = al.entity_id`, and the cast defeats the primary key, so
 *    every evaluation reached `issues` through `company_id` alone and scanned every issue
 *    the company owned. That ran once per request. Here it runs up to `batchSize` times
 *    inside ONE statement, and in the forward writer it runs on every run finalization --
 *    so the same expression, moved, would be strictly worse than the thing it replaced.
 *    A timed-out batch is skipped and retried identically on every later pass, so this
 *    fails permanently rather than transiently.
 *
 *    The plan test below is the `EXPLAIN` on a large company that this rewrite was not
 *    allowed to land without. The fixture is sized so the two plans are distinguishable:
 *    at 20k issues against a handful of activity rows, a pkey probe is a few index
 *    lookups and the cast form is 20k rows per evaluation.
 *
 * 2. AN IN-FLIGHT RUN MUST NOT BE STAMPED. `attributed_project_at` is write-once -- that
 *    is what makes the repair idempotent -- so a row stamped from a running run's partial
 *    activity is frozen at an answer that was only ever true mid-run. The read-time join
 *    had no such failure mode, because it re-derived from complete activity on every
 *    request. Deferring costs one re-read on the next pass; stamping early is permanent.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDbFromPostgresClient } from "./client.js";
import { repairCostEventProjectAttribution } from "./cost-events-project-attribution-repair.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "cost_events_unattributed_idx";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const ISSUE_A = "55555555-5555-4555-8555-555555555555";
const ISSUE_B = "66666666-6666-4666-8666-666666666666";
const RUN_DONE = "77777777-7777-4777-8777-777777777777";
const RUN_LIVE = "88888888-8888-4888-8888-888888888888";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

async function connect(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return sql;
}

/**
 * Company, agent, two projects, two issues. FK triggers stay ON -- the fixtures below
 * are small enough not to need the `session_replication_role` bypass, and leaving the
 * constraints live means a fixture that drifts from the schema fails here rather than
 * producing a quietly meaningless plan.
 */
async function seedGraph(sql: postgres.Sql) {
  await sql.unsafe(`
    INSERT INTO companies (id, name, issue_prefix) VALUES ('${COMPANY}', 'Paperclip', 'PEN');
    INSERT INTO agents (id, company_id, name, role, status, adapter_type)
      VALUES ('${AGENT}', '${COMPANY}', 'Engineer', 'engineer', 'active', 'codex_local');
    INSERT INTO projects (id, company_id, name, status) VALUES
      ('${PROJECT_A}', '${COMPANY}', 'Project A', 'active'),
      ('${PROJECT_B}', '${COMPANY}', 'Project B', 'active');
    INSERT INTO issues (id, company_id, project_id, title, status, priority, issue_number, identifier) VALUES
      ('${ISSUE_A}', '${COMPANY}', '${PROJECT_A}', 'A', 'done', 'medium', 1, 'PEN-1'),
      ('${ISSUE_B}', '${COMPANY}', '${PROJECT_B}', 'B', 'in_progress', 'medium', 2, 'PEN-2');
  `);
}

describeEmbeddedPostgres("cost_events project attribution repair (PEN-5937)", () => {
  it("ships the 0277 partial index on exactly the repair's predicate", async () => {
    const sql = await connect("paperclip-cost-events-unattributed-idx-");

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${INDEX_NAME}
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("ON public.cost_events USING btree (id)");
    // PARTIAL is the whole point: a full index on `id` is the primary key again and
    // would not let the planner skip the rows that already carry a watermark.
    expect(indexes[0]?.indexdef).toContain("WHERE (attributed_project_at IS NULL)");
  }, 120_000);

  it("probes issues through the primary key, not a scan of the company's issues", async () => {
    const sql = await connect("paperclip-cost-events-attribution-plan-");
    await seedGraph(sql);

    // A large company: 20k issues, so a pkey probe and a `id::text` scan are far apart.
    // FKs are bypassed for the bulk insert only -- these rows reference the real company
    // and project above, so nothing dangles. `last_activity_at` is supplied explicitly
    // because `session_replication_role = replica` also disables the trigger that
    // maintains it (migration 0270), and the column is NOT NULL.
    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO issues (company_id, project_id, title, status, priority, issue_number, identifier, last_activity_at)
      SELECT '${COMPANY}', '${PROJECT_A}', 'Bulk ' || g, 'done', 'medium', g + 1000, 'PEN-' || (g + 1000), now()
      FROM generate_series(1, 20000) AS g;
      INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, finished_at)
      VALUES ('${RUN_DONE}', '${COMPANY}', '${AGENT}', 'on_demand', 'succeeded', now() - interval '1 hour', now() - interval '59 minutes');
      INSERT INTO activity_log (company_id, run_id, actor_type, actor_id, agent_id, action, entity_type, entity_id, details)
      VALUES ('${COMPANY}', '${RUN_DONE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', '${ISSUE_A}', '{}'::jsonb);
      INSERT INTO cost_events (company_id, agent_id, heartbeat_run_id, provider, biller, billing_type, model, cost_cents, occurred_at)
      SELECT '${COMPANY}', '${AGENT}', '${RUN_DONE}', 'anthropic', 'anthropic', 'metered_api', 'claude-opus-5', 10, now()
      FROM generate_series(1, 500) AS g;
      SET session_replication_role = origin;
      ANALYZE issues; ANALYZE activity_log; ANALYZE cost_events; ANALYZE heartbeat_runs;
    `);

    // The lateral the repair runs, transcribed with the batch's correlated columns bound
    // to the fixture's single run. `EXPLAIN` of the full CTE would report the plan for a
    // statement this test built rather than the one the module ships, so the shape under
    // test is kept to the probe itself -- the part the rewrite changed.
    const plan = (
      await sql.unsafe<{ "QUERY PLAN": string }[]>(`
        EXPLAIN
        SELECT i.project_id
        FROM activity_log al
        INNER JOIN issues i
          ON i.id = CASE
               WHEN al.entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN al.entity_id::uuid
             END
         AND i.company_id = '${COMPANY}'
        WHERE al.run_id = '${RUN_DONE}'
          AND al.company_id = '${COMPANY}'
          AND al.entity_type = 'issue'
          AND i.project_id IS NOT NULL
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT 1
      `)
    )
      .map((row) => row["QUERY PLAN"])
      .join("\n");

    expect(plan).toContain("issues_pkey");
    // The failure this rewrite exists to prevent. Before it, `issues` could only be
    // reached through `company_id`, and on this fixture that is 20k rows per evaluation.
    expect(plan).not.toMatch(/Seq Scan on issues/);

    // The plan is necessary but not sufficient: a batch that plans well and still times
    // out is the reported failure mode, and the repair swallows a batch error into
    // `failedBatches` rather than throwing. So run the SHIPPED statement -- 500 rows, the
    // production batch size -- against a statement_timeout far below the role default.
    // `max: 1`, so this SET applies to the one connection the repair will use.
    await sql.unsafe(`SET statement_timeout = '5s'`);
    const db = createDbFromPostgresClient(sql);
    const result = await repairCostEventProjectAttribution(db, { batchSize: 500, pauseMs: 0 });

    expect(result.failedBatches).toBe(0);
    expect(result.stamped).toBe(500);
    expect(result.attributed).toBe(500);
  }, 180_000);

  it("defers a row whose run is still in flight, and stamps it once the run finishes", async () => {
    const sql = await connect("paperclip-cost-events-attribution-inflight-");
    await seedGraph(sql);

    await sql.unsafe(`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, finished_at) VALUES
        ('${RUN_DONE}', '${COMPANY}', '${AGENT}', 'on_demand', 'succeeded', now() - interval '1 hour', now() - interval '59 minutes'),
        ('${RUN_LIVE}', '${COMPANY}', '${AGENT}', 'on_demand', 'running', now() - interval '1 minute', NULL);
      INSERT INTO activity_log (company_id, run_id, actor_type, actor_id, agent_id, action, entity_type, entity_id, details) VALUES
        ('${COMPANY}', '${RUN_DONE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', '${ISSUE_A}', '{}'::jsonb),
        ('${COMPANY}', '${RUN_LIVE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', '${ISSUE_A}', '{}'::jsonb);
      INSERT INTO cost_events (id, company_id, agent_id, heartbeat_run_id, provider, biller, billing_type, model, cost_cents, occurred_at) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${COMPANY}', '${AGENT}', '${RUN_DONE}', 'anthropic', 'anthropic', 'metered_api', 'claude-opus-5', 10, now()),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${COMPANY}', '${AGENT}', '${RUN_LIVE}', 'anthropic', 'anthropic', 'metered_api', 'claude-opus-5', 20, now());
    `);

    const db = createDbFromPostgresClient(sql);
    const first = await repairCostEventProjectAttribution(db, { pauseMs: 0 });
    expect(first.failedBatches).toBe(0);
    expect(first.stamped).toBe(1);
    expect(first.deferred).toBe(1);

    const afterFirst = await sql<
      { id: string; attributed_project_id: string | null; attributed_project_at: Date | null }[]
    >`SELECT id, attributed_project_id, attributed_project_at FROM cost_events ORDER BY id`;
    expect(afterFirst[0]?.attributed_project_id).toBe(PROJECT_A);
    // The live run's row is untouched -- NOT stamped with a NULL id, which would be
    // write-once and would lock in "unattributed" for a run that had barely started.
    expect(afterFirst[1]?.attributed_project_at).toBeNull();

    // The run then finishes, having moved on to a DIFFERENT project. This is the value
    // an early stamp would have frozen wrong: mid-run the answer was PROJECT_A.
    await sql.unsafe(`
      INSERT INTO activity_log (company_id, run_id, actor_type, actor_id, agent_id, action, entity_type, entity_id, details, created_at)
      VALUES ('${COMPANY}', '${RUN_LIVE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', '${ISSUE_B}', '{}'::jsonb, now() + interval '1 minute');
      UPDATE heartbeat_runs SET status = 'succeeded', finished_at = now() WHERE id = '${RUN_LIVE}';
    `);

    const second = await repairCostEventProjectAttribution(db, { pauseMs: 0 });
    expect(second.stamped).toBe(1);
    expect(second.deferred).toBe(0);

    const live = await sql<{ attributed_project_id: string | null }[]>`
      SELECT attributed_project_id FROM cost_events WHERE heartbeat_run_id = ${RUN_LIVE}
    `;
    expect(live[0]?.attributed_project_id).toBe(PROJECT_B);

    // Idempotent: the watermark means a third pass has nothing to do.
    const third = await repairCostEventProjectAttribution(db, { pauseMs: 0 });
    expect(third.stamped).toBe(0);
    expect(third.deferred).toBe(0);
  }, 120_000);

  it("stamps a row with no heartbeat run, and one whose write-time project already wins", async () => {
    const sql = await connect("paperclip-cost-events-attribution-eligibility-");
    await seedGraph(sql);

    // `project_id` set AND a live run that is touching a DIFFERENT project. Step 1 says
    // the write-time scope wins outright, so there is nothing to wait for -- this row
    // must be stamped on the first pass rather than deferred behind its run.
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, finished_at)
      VALUES ('${RUN_LIVE}', '${COMPANY}', '${AGENT}', 'on_demand', 'running', now(), NULL);
      INSERT INTO activity_log (company_id, run_id, actor_type, actor_id, agent_id, action, entity_type, entity_id, details)
      VALUES ('${COMPANY}', '${RUN_LIVE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', '${ISSUE_B}', '{}'::jsonb);
      INSERT INTO cost_events (id, company_id, agent_id, project_id, heartbeat_run_id, provider, biller, billing_type, model, cost_cents, occurred_at) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${COMPANY}', '${AGENT}', '${PROJECT_A}', '${RUN_LIVE}', 'anthropic', 'anthropic', 'metered_api', 'claude-opus-5', 10, now()),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${COMPANY}', '${AGENT}', NULL, NULL, 'anthropic', 'anthropic', 'metered_api', 'claude-opus-5', 20, now());
    `);

    const db = createDbFromPostgresClient(sql);
    const pass = await repairCostEventProjectAttribution(db, { pauseMs: 0 });
    expect(pass.deferred).toBe(0);
    expect(pass.stamped).toBe(2);
    expect(pass.attributed).toBe(1);

    const rows = await sql<
      { attributed_project_id: string | null; attributed_project_at: Date | null }[]
    >`SELECT attributed_project_id, attributed_project_at FROM cost_events ORDER BY id`;
    // Write-time scope, NOT the PROJECT_B its run is touching.
    expect(rows[0]?.attributed_project_id).toBe(PROJECT_A);
    // Nothing could attribute this one, but it is still watermarked so the scan does not
    // revisit it forever.
    expect(rows[1]?.attributed_project_id).toBeNull();
    expect(rows[1]?.attributed_project_at).not.toBeNull();
  }, 120_000);

  it("survives a non-UUID entity_id, which an unguarded ::uuid cast would abort on", async () => {
    const sql = await connect("paperclip-cost-events-attribution-entity-id-");
    await seedGraph(sql);

    // `activity_log.entity_id` is text and carries ids of every entity type. A run that
    // logged a non-UUID issue entity_id would raise 22P02 and fail the whole batch
    // without the regex guard -- and the batch would then fail identically forever.
    await sql.unsafe(`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at, finished_at)
      VALUES ('${RUN_DONE}', '${COMPANY}', '${AGENT}', 'on_demand', 'succeeded', now() - interval '1 hour', now() - interval '59 minutes');
      INSERT INTO activity_log (company_id, run_id, actor_type, actor_id, agent_id, action, entity_type, entity_id, details, created_at) VALUES
        ('${COMPANY}', '${RUN_DONE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', 'not-a-uuid', '{}'::jsonb, now() + interval '1 minute'),
        ('${COMPANY}', '${RUN_DONE}', 'agent', '${AGENT}', '${AGENT}', 'issue.checked_out', 'issue', '${ISSUE_A}', '{}'::jsonb, now());
      INSERT INTO cost_events (company_id, agent_id, heartbeat_run_id, provider, biller, billing_type, model, cost_cents, occurred_at)
      VALUES ('${COMPANY}', '${AGENT}', '${RUN_DONE}', 'anthropic', 'anthropic', 'metered_api', 'claude-opus-5', 10, now());
    `);

    const db = createDbFromPostgresClient(sql);
    const pass = await repairCostEventProjectAttribution(db, { pauseMs: 0 });

    expect(pass.failedBatches).toBe(0);
    // The junk row is NEWER, so it is the one `ORDER BY created_at DESC` reaches first.
    // It yields NULL through the CASE, matches no issue, and the real row behind it wins.
    expect(pass.attributed).toBe(1);
    const rows = await sql<{ attributed_project_id: string | null }[]>`
      SELECT attributed_project_id FROM cost_events
    `;
    expect(rows[0]?.attributed_project_id).toBe(PROJECT_A);
  }, 120_000);
});
