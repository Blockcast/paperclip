import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * PEN-5937: backfill `cost_events.attributed_project_id`, the durable run->project
 * attribution that lets `costs/by-project` stop reconstructing one from `activity_log`
 * on every request.
 *
 * ## Why this is not in migration 0276
 *
 * The derivation reads `activity_log` joined to `issues` on `issues.id::text` -- the
 * exact expression whose read-time cost this row exists to delete. Running it inside a
 * migration transaction is the BLO-51377 shape: 0270's `issues.last_activity_at`
 * backfill held SHARE ROW EXCLUSIVE on `activity_log` plus every repaired row lock
 * until commit and froze the fleet's activity_log writes for ~35 min in production.
 * This one reads the same table through a more expensive join, so it is strictly worse
 * in that shape. Here each batch is ONE autocommit statement over at most `batchSize`
 * cost events, so no lock outlives a single short statement and the role's own
 * statement/lock timeouts bound it.
 *
 * ## Why the watermark column exists
 *
 * `attributed_project_id IS NULL` means BOTH "never resolved" and "resolved, and this
 * run touched no project with an issue". Keying the scan on it would therefore re-derive
 * every unattributable row on every pass, forever -- the join this row exists to stop
 * running, run again on a schedule. `attributed_project_at` separates them: NULL is
 * "never resolved", a timestamp is "resolved", whatever the answer was. That also makes
 * the repair idempotent -- a second pass selects nothing and updates nothing.
 *
 * ## Why it stays armed after the backfill drains
 *
 * It is not only a one-shot. Migration 0276 lands before the image that populates the
 * column forward, so every cost event written in that gap has a NULL watermark; so does
 * any row written by a replica still serving the old image during a roll. Leaving the
 * repair armed converges those without an operator. Once drained, a pass is a single
 * keyset query that scans the primary key and returns nothing -- it reads no
 * `activity_log` row at all, because the derivation is a lateral over the batch and the
 * batch is empty.
 *
 * ## Attribution rule, which must match the forward writer
 *
 * `resolveLedgerScopeForRun` (server/src/services/heartbeat.ts) and this query must
 * agree, or a row's attribution would depend on which of the two happened to reach it.
 * The rule has two steps, in order:
 *
 *   1. If the row carries a WRITE-TIME `project_id`, that is the answer and nothing is
 *      derived. `coalesce(project_id, attributed_project_id)` could never return the
 *      derived value for such a row, so deriving one would be an `activity_log` read
 *      taken to produce a number nothing can read -- and `activity_log` reads are the
 *      cost this whole row exists to remove. The lateral below is skipped for these.
 *   2. Otherwise, the most recent `activity_log` row this run wrote against an issue
 *      that has a project, ordered `created_at DESC, id DESC`.
 *
 * PEN-5624: `activity_log.created_at` is `defaultNow()` -- TRANSACTION start time, so
 * two issue activity rows written by one run in one transaction tie by CONSTRUCTION.
 * `activity_log.id` is `defaultRandom()`, a v4 UUID with no time component, so the `id`
 * tiebreaker makes the pick STABLE rather than recency-correct. At a true tie there is
 * no recency answer to be faithful to, and stable beats flapping. Unlike the read-time
 * query this replaces, the result is now WRITTEN DOWN, so a row cannot change project
 * between two requests over identical data at all.
 *
 * ## Rows this deliberately leaves unattributed
 *
 * A cost event with no `heartbeat_run_id` (reported through `POST /cost-events`) and no
 * `project_id` has nothing that could attribute it. It is still STAMPED -- watermark set,
 * id left NULL -- so the scan does not revisit it.
 *
 * `project_id` is READ (to apply step 1) and never WRITTEN. Nothing here may widen the
 * scope `services/budgets.ts` enforces project budget policies on.
 */
export type CostEventProjectAttributionRepairResult = {
  batches: number;
  /** Rows stamped with a watermark, whether or not a project was found. */
  stamped: number;
  /** Rows that got a non-NULL `attributed_project_id`. */
  attributed: number;
  failedBatches: number;
};

export async function repairCostEventProjectAttribution(
  db: Db,
  options: {
    batchSize?: number;
    pauseMs?: number;
    shouldStop?: () => boolean;
    onBatchError?: (err: unknown, afterId: string) => void;
  } = {},
): Promise<CostEventProjectAttributionRepairResult> {
  const batchSize = options.batchSize ?? 500;
  const pauseMs = options.pauseMs ?? 100;
  const result: CostEventProjectAttributionRepairResult = {
    batches: 0,
    stamped: 0,
    attributed: 0,
    failedBatches: 0,
  };
  let afterId = "00000000-0000-0000-0000-000000000000";

  while (!options.shouldStop?.()) {
    let lastId: string | null;
    try {
      const rows = (await db.execute(sql`
        WITH batch AS MATERIALIZED (
          SELECT ce."id", ce."company_id", ce."project_id", ce."heartbeat_run_id"
          FROM "cost_events" ce
          WHERE ce."attributed_project_at" IS NULL
            AND ce."id" > ${afterId}::uuid
          ORDER BY ce."id"
          LIMIT ${batchSize}
        ),
        resolved AS MATERIALIZED (
          SELECT b."id", COALESCE(b."project_id", link."project_id") AS "project_id"
          FROM batch b
          LEFT JOIN LATERAL (
            SELECT i."project_id"
            FROM "activity_log" al
            INNER JOIN "issues" i
              ON i."id"::text = al."entity_id"
             AND i."company_id" = b."company_id"
            WHERE al."run_id" = b."heartbeat_run_id"
              AND al."company_id" = b."company_id"
              AND al."entity_type" = 'issue'
              AND i."project_id" IS NOT NULL
            ORDER BY al."created_at" DESC, al."id" DESC
            LIMIT 1
          ) link ON b."project_id" IS NULL
        ),
        stamped AS (
          UPDATE "cost_events" AS ce
          SET "attributed_project_id" = r."project_id",
              "attributed_project_at" = now()
          FROM resolved r
          WHERE ce."id" = r."id"
            AND ce."attributed_project_at" IS NULL
          RETURNING ce."id", ce."attributed_project_id"
        )
        SELECT
          (SELECT b."id" FROM batch b ORDER BY b."id" DESC LIMIT 1)::text AS "last_id",
          (SELECT COUNT(*) FROM stamped)::int AS "stamped",
          (SELECT COUNT(*) FROM stamped WHERE "attributed_project_id" IS NOT NULL)::int
            AS "attributed"
      `)) as unknown as Array<{
        last_id: string | null;
        stamped: number;
        attributed: number;
      }>;
      lastId = rows[0]?.last_id ?? null;
      result.stamped += rows[0]?.stamped ?? 0;
      result.attributed += rows[0]?.attributed ?? 0;
    } catch (err) {
      // A lock/statement timeout on one batch must not stall the pass or retry a hot
      // row forever. Skip past it by keyset; a later pass picks it up, because the
      // watermark on those rows is still NULL.
      result.failedBatches += 1;
      options.onBatchError?.(err, afterId);
      const next = (await db.execute(sql`
        SELECT ce."id"::text AS "id"
        FROM "cost_events" ce
        WHERE ce."attributed_project_at" IS NULL
          AND ce."id" > ${afterId}::uuid
        ORDER BY ce."id" OFFSET ${batchSize - 1} LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      lastId = next[0]?.id ?? null;
    }
    result.batches += 1;
    if (lastId === null) break;
    afterId = lastId;
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return result;
}
