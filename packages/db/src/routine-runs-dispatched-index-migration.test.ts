/**
 * PEN-4647: migration 0266's partial index must back the routine fire-gap
 * gauge's per-routine "most recent DISPATCHED fire" probe.
 *
 * Sibling of routine-runs-completed-index-migration.test.ts, which pins the
 * same property for 0254's `max(completed_at)` probe. Both probes run for
 * every active scheduled routine, on every collector tick, on every replica:
 *
 *   select max(triggered_at) from routine_runs
 *    where routine_id = <id>
 *      and linked_issue_id is not null
 *      and status <> 'skipped' and status <> 'coalesced'
 *
 * 0254's index cannot serve this one -- it holds only `status = 'completed'`
 * rows, a strict subset -- so without 0266 this probe reads every run the
 * routine has ever had, on a set that only grows.
 *
 * The probe below mirrors the correlated subquery in
 * selectScheduledRoutinesWithFireReceipts
 * (server/src/services/routine-fire-gap-metrics.ts) BY HAND, including the
 * LITERAL statuses -- a bind parameter would stop a generic plan from proving
 * the index predicate. Re-check that file when this one changes.
 *
 * WHY THE PREDICATE EXCLUDES RATHER THAN ENUMERATES. The question is "did this
 * fire produce its OWN execution issue". `skipped` (stood down behind a held
 * row under skip_if_active) and `coalesced` (folded onto one) both carry a
 * linked_issue_id -- the row they stood down behind -- so a null test ALONE
 * would be reset by every eaten firing, which is the PEN-4647 fail-open the
 * gauge exists to close, reproduced one layer down. The fixture below is built
 * so that a predicate missing either half returns a visibly wrong answer.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "routine_runs_routine_dispatched_idx";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** The probe, verbatim apart from the routine id. */
const PROBE = `
  SELECT max(triggered_at) FROM routine_runs
   WHERE routine_id = '${ROUTINE_ID}'
     AND linked_issue_id IS NOT NULL
     AND status <> 'skipped'
     AND status <> 'coalesced'
`;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("routine_runs dispatched partial index (migration 0266)", () => {
  it("is defined as (routine_id, triggered_at) WHERE linked and not skipped/coalesced", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-runs-dispatched-idx-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${INDEX_NAME}
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("ON public.routine_runs USING btree (routine_id, triggered_at)");
    expect(indexes[0]?.indexdef).toContain("linked_issue_id IS NOT NULL");
    expect(indexes[0]?.indexdef).toContain("<> 'skipped'::text");
    expect(indexes[0]?.indexdef).toContain("<> 'coalesced'::text");
  }, 60_000);

  it("answers the gauge's per-routine max(triggered_at) probe from the index, not a table scan", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-runs-dispatched-plan-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // A long-lived hourly routine: years of fires across every status, plus a
    // second routine sharing the table. FK triggers are bypassed so the
    // fixture needs no company/routine/issue graph.
    //
    // THE NEWEST ROWS ARE THE ONES THAT MUST NOT COUNT. g=1 and g=2 are the
    // most recent fires and are `skipped`/`coalesced` WITH a link -- exactly
    // the eaten-firing shape -- and g=3 is a link-less `failed` dispatch. So a
    // predicate that drops either half of the filter returns a strictly
    // newer, wrong answer rather than coincidentally the right one.
    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO routine_runs (company_id, routine_id, source, status, triggered_at, completed_at, linked_issue_id)
      SELECT '${COMPANY_ID}',
             CASE WHEN g % 4 = 0 THEN '${OTHER_ROUTINE_ID}'::uuid ELSE '${ROUTINE_ID}'::uuid END,
             'schedule',
             CASE WHEN g = 1 THEN 'skipped'
                  WHEN g = 2 THEN 'coalesced'
                  WHEN g = 3 THEN 'failed'
                  WHEN g % 5 = 0 THEN 'skipped'
                  WHEN g % 7 = 0 THEN 'coalesced'
                  ELSE 'completed' END,
             now() - (g || ' hours')::interval,
             now() - (g || ' hours')::interval + interval '5 minutes',
             CASE WHEN g = 3 THEN NULL ELSE '${ISSUE_ID}'::uuid END
      FROM generate_series(1, 30000) AS g;
      SET session_replication_role = origin;
      ANALYZE routine_runs;
    `);

    const plan = (await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${PROBE}`))
      .map((row) => row["QUERY PLAN"])
      .join("\n");

    expect(plan).toContain(INDEX_NAME);
    expect(plan).not.toMatch(/Seq Scan on routine_runs/);

    // The answer itself, not just the plan. Walking the newest rows: g=1
    // `skipped`, g=2 `coalesced`, g=3 `failed` with no link, g=4 belongs to
    // the other routine, g=5 `skipped` again (g % 5 = 0) -- so the newest
    // qualifying fire for this routine is g=6, six hours ago. A predicate
    // missing the status exclusions would return g=1's timestamp (1h); one
    // missing the null test would return g=3's (3h). Both are distinguishable
    // from the right answer, which is the point of ordering the fixture this
    // way rather than letting the newest row happen to qualify.
    const [{ max: newest }] = await sql.unsafe<{ max: Date | null }[]>(PROBE);
    expect(newest).not.toBeNull();
    const hoursAgo = Math.round((Date.now() - new Date(newest!).getTime()) / 3_600_000);
    expect(hoursAgo).toBe(6);
  }, 120_000);
});
