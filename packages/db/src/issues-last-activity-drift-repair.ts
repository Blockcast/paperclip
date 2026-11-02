import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * BLO-51379: the one-shot `issues.last_activity_at` drift repair that 0270 ran
 * inside its migration transaction, moved out of it.
 *
 * Migration 0271 arms the activity_log arm of last_activity_at maintenance. Rows
 * whose newest activity predates that trigger can still sit behind the
 * canonical value; this re-runs 0076's backfill expression over every issue and
 * advances the column where it lags. Inside the migration it held SHARE ROW
 * EXCLUSIVE on activity_log plus every repaired row lock until commit, which
 * froze the fleet's activity_log writes for ~35 min in prod (BLO-51377).
 *
 * Here each batch is ONE autocommit statement over at most `batchSize` issues,
 * so no lock outlives a single short statement, and the role's own
 * statement/lock timeouts bound it. Drifted rows are locked in ascending `id`
 * order before the UPDATE, the order every last_activity_at trigger locks in.
 *
 * The guard is `<`, never `<>`: the column is monotone, and a disagreement in
 * the other direction (a deleted comment or activity row) is the column being
 * deliberately ahead. That also makes the repair idempotent: a second pass
 * updates nothing.
 */
export type IssuesLastActivityDriftRepairResult = {
  batches: number;
  repaired: number;
  failedBatches: number;
};

export async function repairIssuesLastActivityDrift(
  db: Db,
  options: {
    batchSize?: number;
    pauseMs?: number;
    shouldStop?: () => boolean;
    onBatchError?: (err: unknown, afterId: string) => void;
  } = {},
): Promise<IssuesLastActivityDriftRepairResult> {
  const batchSize = options.batchSize ?? 500;
  const pauseMs = options.pauseMs ?? 100;
  const result: IssuesLastActivityDriftRepairResult = { batches: 0, repaired: 0, failedBatches: 0 };
  let afterId = "00000000-0000-0000-0000-000000000000";

  while (!options.shouldStop?.()) {
    let lastId: string | null;
    try {
      const rows = (await db.execute(sql`
        WITH batch AS MATERIALIZED (
          SELECT i."id", i."company_id", i."created_at", i."updated_at", i."last_activity_at"
          FROM "issues" i
          WHERE i."id" > ${afterId}::uuid
          ORDER BY i."id"
          LIMIT ${batchSize}
        ),
        computed AS (
          SELECT
            b."id",
            GREATEST(
              b."last_activity_at",
              b."updated_at",
              b."created_at",
              COALESCE(
                (SELECT MAX(c."created_at") FROM "issue_comments" c
                  WHERE c."issue_id" = b."id" AND c."company_id" = b."company_id"),
                to_timestamp(0)
              ),
              COALESCE(
                (SELECT MAX(al."created_at") FROM "activity_log" al
                  WHERE al."company_id" = b."company_id"
                    AND al."entity_type" = 'issue'
                    AND al."entity_id" = b."id"::text
                    AND al."action" NOT IN (
                      'issue.read_marked',
                      'issue.read_unmarked',
                      'issue.inbox_archived',
                      'issue.inbox_unarchived'
                    )),
                to_timestamp(0)
              )
            ) AS "canonical_at"
          FROM batch b
        ),
        drifted AS MATERIALIZED (
          SELECT i."id", c."canonical_at"
          FROM "issues" i
          INNER JOIN computed c ON c."id" = i."id"
          WHERE i."last_activity_at" < c."canonical_at"
          ORDER BY i."id"
          FOR NO KEY UPDATE OF i
        ),
        repaired AS (
          UPDATE "issues" AS i
          SET "last_activity_at" = d."canonical_at"
          FROM drifted d
          WHERE i."id" = d."id"
            AND i."last_activity_at" < d."canonical_at"
          RETURNING i."id"
        )
        SELECT
          (SELECT b."id" FROM batch b ORDER BY b."id" DESC LIMIT 1)::text AS "last_id",
          (SELECT COUNT(*) FROM repaired)::int AS "repaired"
      `)) as unknown as Array<{ last_id: string | null; repaired: number }>;
      lastId = rows[0]?.last_id ?? null;
      result.repaired += rows[0]?.repaired ?? 0;
    } catch (err) {
      // A lock/statement timeout on one batch must not stall the pass or retry
      // a hot row forever. Skip past it by keyset; a later pass picks it up.
      result.failedBatches += 1;
      options.onBatchError?.(err, afterId);
      const next = (await db.execute(sql`
        SELECT "id"::text AS "id" FROM "issues" WHERE "id" > ${afterId}::uuid
        ORDER BY "id" OFFSET ${batchSize - 1} LIMIT 1
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
