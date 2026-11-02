/**
 * PEN-5213 — the one-shot `issues.last_activity_at` drift repair, OFF the
 * migration path.
 *
 * ## Why this is not a migration
 *
 * It was one, briefly: migration 0270 armed the `activity_log` maintenance
 * trigger and ran this repair in the same statement list.
 * `applyPendingMigrationsManually` wraps every statement of one migration file
 * in a single `runInTransaction`, so the two shared one lock hold — and
 * `CREATE TRIGGER` on `activity_log` takes SHARE ROW EXCLUSIVE, which conflicts
 * with the ROW EXCLUSIVE every INSERT takes. The transaction then held that
 * lock for the length of a 55,903-issue repair reading 3.4M activity rows.
 *
 * Production outage 2026-11-02 02:41–03:16Z: every `insert into activity_log`
 * failed `55P03`, every agent run failed in setup, and API writes returned 503
 * after they had already committed, producing duplicate comments. 0270 is
 * deleted; `0271_issues_last_activity_at_activity_log_trigger.sql` arms the
 * trigger alone.
 *
 * ⚠️ BATCHING INSIDE ONE TRANSACTION BUYS NOTHING. 0270 was batched, and said
 * so, and still caused the outage: row locks taken by batch 1 are still held at
 * batch N until that transaction commits. What makes this version safe is that
 * **each batch is its own transaction** — `sql.unsafe` here runs in autocommit,
 * so locks are released at the end of every batch rather than at the end of the
 * run. Do not wrap {@link repairIssuesLastActivityDrift} in a transaction, and
 * do not re-home it into a migration file; both silently restore the outage.
 *
 * ## Correctness
 *
 * The guard is `<`, never `<>`: the column is monotone non-decreasing (every
 * maintenance path is a `<` guarded bump), and a disagreement in the other
 * direction — a deleted comment, an activity row removed — is the column being
 * deliberately ahead, not drift. Lowering it would resurrect inbox rows a user
 * already archived, since `inboxVisibleForUserCondition` compares
 * `archived_at >= last_activity_at`.
 *
 * That monotonicity is also what makes running this *after* the trigger is
 * armed the correct order, and what makes the run interruptible: a partial run
 * leaves every batch it did finish correct, and re-running is idempotent
 * (a repaired row no longer satisfies the `<` guard). It is safe to run
 * concurrently with live traffic — a row the trigger advances mid-run is simply
 * already at or past its canonical value.
 *
 * `created_at` is in the `GREATEST` because 0076's backfill has it. It can only
 * matter for a row whose `created_at` postdates its `updated_at`, which no live
 * write path produces; it is kept so this expression stays comparable with the
 * one it re-runs.
 */
import postgres, { type Sql } from "postgres";

/** Issues scanned per batch. Each batch is one statement, one transaction. */
export const DEFAULT_DRIFT_REPAIR_BATCH_SIZE = 2_000;

/**
 * Per-batch lock acquisition bound. Mirrors `MIGRATION_DDL_LOCK_TIMEOUT_MS`:
 * this repair must yield to live traffic rather than queue writers behind it,
 * which is the failure the outage was made of. A batch that loses the race is
 * retried, not abandoned — see {@link repairIssuesLastActivityDrift}.
 */
export const DRIFT_REPAIR_LOCK_TIMEOUT_MS = 3_000;

/** Per-batch statement bound. A batch that cannot finish inside this is retried. */
export const DRIFT_REPAIR_STATEMENT_TIMEOUT_MS = 60_000;

/** Lock contention and deadlock: retryable, because the next pass re-reads the row. */
const RETRYABLE_SQLSTATES = new Set(["55P03", "40P01", "40001", "57014"]);

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * One batch: scan `limit` issues with `id > $1` in ascending `id` order — the
 * same order every trigger in this area locks in — and advance the ones that
 * have fallen behind.
 *
 * `repaired` is a data-modifying CTE, which Postgres executes exactly once and
 * to completion regardless of whether the primary query reads it, so counting
 * it in a subquery does not make the UPDATE conditional on the count.
 *
 * `last_id` is the last id SCANNED, not the last repaired: advancing the cursor
 * by repaired rows would re-scan every already-correct row forever.
 */
export const DRIFT_REPAIR_BATCH_SQL = `
WITH batch AS MATERIALIZED (
  SELECT
    i."id",
    i."company_id",
    i."created_at",
    i."updated_at",
    i."last_activity_at"
  FROM "issues" i
  WHERE i."id" > $1::uuid
  ORDER BY i."id"
  LIMIT $2::int
),
computed AS (
  SELECT
    b."id",
    GREATEST(
      b."last_activity_at",
      b."updated_at",
      b."created_at",
      COALESCE(
        (
          SELECT MAX(c."created_at")
          FROM "issue_comments" c
          WHERE c."issue_id" = b."id"
            AND c."company_id" = b."company_id"
        ),
        to_timestamp(0)
      ),
      COALESCE(
        (
          SELECT MAX(al."created_at")
          FROM "activity_log" al
          WHERE al."company_id" = b."company_id"
            AND al."entity_type" = 'issue'
            AND al."entity_id" = b."id"::text
            AND al."action" NOT IN (
              'issue.read_marked',
              'issue.read_unmarked',
              'issue.inbox_archived',
              'issue.inbox_unarchived'
            )
        ),
        to_timestamp(0)
      )
    ) AS "canonical_at"
  FROM batch b
),
repaired AS (
  UPDATE "issues" AS i
  SET "last_activity_at" = c."canonical_at"
  FROM computed c
  WHERE i."id" = c."id"
    AND i."last_activity_at" < c."canonical_at"
  RETURNING i."id"
)
SELECT
  (SELECT b."id" FROM batch b ORDER BY b."id" DESC LIMIT 1) AS "last_id",
  (SELECT COUNT(*) FROM batch) AS "scanned",
  (SELECT COUNT(*) FROM repaired) AS "repaired"
`;

export type DriftRepairProgress = {
  readonly batches: number;
  readonly scanned: number;
  readonly repaired: number;
  readonly lastId: string;
};

export type DriftRepairOptions = {
  readonly batchSize?: number;
  /** Retries per batch before giving up on the run. */
  readonly maxAttemptsPerBatch?: number;
  readonly onProgress?: (progress: DriftRepairProgress) => void;
  readonly log?: (message: string) => void;
  /** Injectable for tests; defaults to a 250ms-step linear backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
};

function sqlstate(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

function isRetryable(error: unknown): boolean {
  const code = sqlstate(error);
  return code !== null && RETRYABLE_SQLSTATES.has(code);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run the repair to completion, one autocommitted batch at a time.
 *
 * The caller owns the connection and must NOT have a transaction open: the
 * whole safety property of this function is that each batch commits on its own.
 */
export async function repairIssuesLastActivityDrift(
  sql: Sql,
  options: DriftRepairOptions = {},
): Promise<DriftRepairProgress> {
  const batchSize = options.batchSize ?? DEFAULT_DRIFT_REPAIR_BATCH_SIZE;
  const maxAttempts = options.maxAttemptsPerBatch ?? 5;
  const sleep = options.sleep ?? defaultSleep;

  await sql.unsafe(`SET lock_timeout = '${DRIFT_REPAIR_LOCK_TIMEOUT_MS}ms'`);
  await sql.unsafe(`SET statement_timeout = '${DRIFT_REPAIR_STATEMENT_TIMEOUT_MS}ms'`);

  let lastId = ZERO_UUID;
  let batches = 0;
  let scanned = 0;
  let repaired = 0;

  for (;;) {
    let row: { last_id: string | null; scanned: string; repaired: string } | undefined;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const rows = (await sql.unsafe(DRIFT_REPAIR_BATCH_SQL, [lastId, batchSize])) as unknown as Array<{
          last_id: string | null;
          scanned: string;
          repaired: string;
        }>;
        row = rows[0];
        break;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryable(error)) throw error;
        const delayMs = attempt * 250;
        options.log?.(
          `batch after ${lastId}: ${sqlstate(error)} on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }

    // No rows scanned => the keyset cursor has passed the last issue.
    if (!row || row.last_id === null) break;

    batches += 1;
    scanned += Number(row.scanned);
    repaired += Number(row.repaired);
    lastId = row.last_id;

    options.onProgress?.({ batches, scanned, repaired, lastId });
  }

  return { batches, scanned, repaired, lastId };
}

/**
 * Count the issues the repair WOULD advance, changing nothing.
 *
 * Deliberately one statement over the whole table rather than the batched
 * path: it takes no row locks, so there is nothing for batching to bound.
 */
export async function countIssuesLastActivityDrift(sql: Sql): Promise<number> {
  const rows = (await sql.unsafe(`
    SELECT COUNT(*)::bigint AS "drifted"
    FROM "issues" i
    WHERE i."last_activity_at" < GREATEST(
      i."updated_at",
      i."created_at",
      COALESCE((SELECT MAX(c."created_at") FROM "issue_comments" c
                WHERE c."issue_id" = i."id" AND c."company_id" = i."company_id"), to_timestamp(0)),
      COALESCE((SELECT MAX(al."created_at") FROM "activity_log" al
                WHERE al."company_id" = i."company_id"
                  AND al."entity_type" = 'issue'
                  AND al."entity_id" = i."id"::text
                  AND al."action" NOT IN ('issue.read_marked', 'issue.read_unmarked',
                                          'issue.inbox_archived', 'issue.inbox_unarchived')),
               to_timestamp(0))
    )
  `)) as unknown as Array<{ drifted: string }>;
  return Number(rows[0]?.drifted ?? 0);
}

/**
 * Connect, run the repair (or just count), disconnect.
 *
 * Connection policy lives here rather than in the caller because it is part of
 * the safety argument: `max: 1` because the repair is strictly sequential (a
 * keyset cursor), so a larger pool would only hold idle connections against the
 * budget in `doc/DATABASE-CONNECTION-BUDGET.md`.
 */
export async function runIssuesLastActivityDriftRepair(
  url: string,
  options: DriftRepairOptions & { readonly dryRun?: boolean } = {},
): Promise<DriftRepairProgress | { readonly dryRunDrifted: number }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    if (options.dryRun) {
      await sql.unsafe(`SET statement_timeout = '${DRIFT_REPAIR_STATEMENT_TIMEOUT_MS * 10}ms'`);
      return { dryRunDrifted: await countIssuesLastActivityDrift(sql) };
    }
    return await repairIssuesLastActivityDrift(sql, options);
  } finally {
    await sql.end();
  }
}
