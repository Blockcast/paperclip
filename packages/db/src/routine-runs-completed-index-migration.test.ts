/**
 * BLO-32638 / Ally review on #2352: migration 0254's partial index must back
 * the routine fire-gap gauge's per-routine probe.
 *
 * The gauge refresh runs, for every active scheduled routine, on every
 * collector tick on every replica:
 *
 *   select max(completed_at) from routine_runs
 *    where routine_id = <id> and status = 'completed'
 *
 * No other routine_runs index carries `status`, so without 0254 that probe
 * reads every run the routine has ever had -- and `completed` rows only
 * accumulate. This pins that the planner answers it from the partial index
 * (a one-row backward probe) rather than by scanning the table, on a table
 * deep enough that a scan would be the obvious alternative.
 *
 * The probe below mirrors the correlated subquery in
 * selectScheduledRoutinesWithLastCompletedFire
 * (server/src/services/routine-fire-gap-metrics.ts, paperclip#2352) by hand,
 * including the LITERAL status (a bind parameter would stop a generic plan
 * from proving the index predicate). Re-check that file when this one
 * changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "routine_runs_routine_completed_idx";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("routine_runs completed partial index (migration 0254)", () => {
  it("is defined as (routine_id, completed_at) WHERE status = 'completed'", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-runs-completed-idx-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${INDEX_NAME}
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("ON public.routine_runs USING btree (routine_id, completed_at)");
    expect(indexes[0]?.indexdef).toContain("WHERE (status = 'completed'::text)");
  }, 60_000);

  it("answers the gauge's per-routine max(completed_at) probe from the index, not a table scan", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-runs-completed-plan-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // A long-lived hourly routine: years of fires, most completed, some
    // skipped/coalesced, plus a second routine sharing the table. FK triggers
    // are bypassed so the fixture needs no company/routine graph.
    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO routine_runs (company_id, routine_id, source, status, triggered_at, completed_at)
      SELECT '${COMPANY_ID}',
             CASE WHEN g % 4 = 0 THEN '${OTHER_ROUTINE_ID}'::uuid ELSE '${ROUTINE_ID}'::uuid END,
             'schedule',
             CASE WHEN g % 5 = 0 THEN 'skipped' WHEN g % 7 = 0 THEN 'coalesced' ELSE 'completed' END,
             now() - (g || ' hours')::interval,
             now() - (g || ' hours')::interval + interval '5 minutes'
      FROM generate_series(1, 30000) AS g;
      SET session_replication_role = origin;
      ANALYZE routine_runs;
    `);

    const plan = (
      await sql.unsafe<{ "QUERY PLAN": string }[]>(`
        EXPLAIN
        SELECT max(completed_at) FROM routine_runs
         WHERE routine_id = '${ROUTINE_ID}' AND status = 'completed'
      `)
    )
      .map((row) => row["QUERY PLAN"])
      .join("\n");

    expect(plan).toContain(INDEX_NAME);
    expect(plan).not.toMatch(/Seq Scan on routine_runs/);

  }, 120_000);
});
