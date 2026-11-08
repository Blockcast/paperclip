import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * PEN-5937: backfill `cost_events.attributed_project_id`, the durable run->project
 * attribution that lets `costs/by-project` stop reconstructing one from `activity_log`
 * on every request.
 *
 * ## Why this is not in migration 0276
 *
 * The derivation reads `activity_log` joined to `issues` -- the exact relationship whose
 * read-time cost this row exists to delete. Running it inside a migration transaction is
 * the BLO-51377 shape: 0270's `issues.last_activity_at` backfill held SHARE ROW EXCLUSIVE
 * on `activity_log` plus every repaired row lock until commit and froze the fleet's
 * activity_log writes for ~35 min in production. Here each batch is ONE autocommit
 * statement over at most `batchSize` cost events, so no lock outlives a single short
 * statement and the role's own statement/lock timeouts bound it.
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
 * ## Why it runs on an INTERVAL and not once per lease acquisition
 *
 * The forward writer (`resolveLedgerScopeForRun`, services/heartbeat.ts) covers only the
 * rows IT writes. Three populations it cannot reach keep arriving:
 *
 *   1. `POST /companies/:companyId/cost-events` accepts a `heartbeatRunId` and calls
 *      `createEvent` with no attribution -- `createCostEventSchema` does not carry the
 *      column, and zod strips what it does not declare. Before this row such a cost event
 *      was attributed by the read-time join; now it has a NULL watermark, so
 *      `coalesce(project_id, attributed_project_id)` is NULL and `byProject`'s
 *      `innerJoin(projects)` DROPS the row.
 *   2. Rows written by a replica still serving the pre-0276 image during a roll.
 *   3. Rows this pass deliberately DEFERS -- see the next section.
 *
 * A once-per-lease pass leaves all three invisible to `by-project` until the next deploy
 * or failover, which is hours to days. The interval converges them without an operator
 * and without a deploy. A drained pass is one index scan over
 * `cost_events_unattributed_idx` (migration 0277), a partial index whose entries are
 * exactly the rows still awaiting a watermark -- so once drained it holds the in-flight
 * rows and nothing else, and the pass reads no `activity_log` row at all.
 *
 * ## Rows this DEFERS rather than stamps, and why
 *
 * The watermark is write-once: a stamped row is never revisited. So stamping a row whose
 * run is still RUNNING would freeze an attribution derived from partial activity -- the
 * run goes on to touch another issue, and the answer that was true mid-run is now
 * permanently wrong. The read-time join this replaces never had that failure mode,
 * because it re-derived from the run's complete activity on every request.
 *
 * A row is therefore eligible only when its answer can no longer change:
 *
 *   - it carries a write-time `project_id` (step 1 below wins outright, whatever the run
 *     goes on to do), or
 *   - it has no `heartbeat_run_id` at all (nothing to wait for), or
 *   - its run is over.
 *
 * "Over" is `finished_at IS NOT NULL OR status NOT IN ('queued','running',
 * 'scheduled_retry')`. Either arm alone is sufficient, and the disjunction is false only
 * for a genuinely live run, which is the direction that must not be wrong: a deferred row
 * costs one re-read on the next pass, a wrongly-stamped one is permanent. Two arms rather
 * than one because neither signal is complete on its own -- `issue-execution-lock.ts`
 * records `error` and `adapter_failed` as statuses observed in the column but absent from
 * the canonical union, and a dead run that never had `finished_at` set would otherwise
 * wait forever. The live set is the complement that module pins, so a status nobody has
 * enumerated reads as "over" and gets attributed rather than stranded.
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
 * ## Why the issue probe is driven from the primary key
 *
 * The predicate is `i.id = <al.entity_id as uuid>`, NOT the `i.id::text = al.entity_id`
 * the read-time query used. The cast-to-text form defeats `issues_pkey`, so each
 * evaluation had to reach `issues` through `company_id` alone and scan every issue the
 * company owns. That was survivable when it ran once per request; it is not survivable
 * here, where it would run up to `batchSize` times inside ONE statement and could push a
 * batch past `statement_timeout` -- and the timed-out batch would be skipped and retried
 * identically on every later pass. Casting the OTHER side keeps the probe on the pkey.
 *
 * The regex guard is load-bearing twice over. `activity_log.entity_id` is `text` and
 * carries ids of every entity type, so an unguarded `::uuid` would raise `22P02` on the
 * first non-UUID value and abort the batch. And it is deliberately LOWERCASE-ONLY, with
 * the canonical dash positions pinned: that matches exactly the strings `i.id::text`
 * produces, so the rewrite is result-preserving rather than a widening. It sits inside a
 * `CASE` because that is the one construct whose evaluation order Postgres guarantees --
 * the regex is proven before the cast is attempted. A non-matching value yields NULL,
 * and `i.id = NULL` matches nothing, which is the same outcome the text comparison gave.
 *
 * ## Rows this deliberately leaves unattributed
 *
 * A cost event with no `heartbeat_run_id` (reported through `POST /cost-events`) and no
 * `project_id` has nothing that could attribute it. It is still STAMPED -- watermark set,
 * id left NULL -- so the scan does not revisit it.
 *
 * `project_id` is READ (to apply step 1) and never WRITTEN. Nothing here may widen the
 * scope `services/budgets.ts` enforces project budget policies on.
 *
 * ## What deferral costs while it holds
 *
 * A deferred row is attributed to nothing, so `costs/by-project` drops it until its run
 * is over -- the read-time join this replaces attributed such a row live. Only rows with
 * NO write-time `project_id` are affected; the rest are returned immediately through
 * `coalesce(project_id, attributed_project_id)`. The window closes on its own, and a run
 * that dies without finalizing is finalized for it by `reapOrphanedRunsPeriodic`
 * (`server/src/index.ts`, every scheduler tick, 5-minute stale threshold), which sets a
 * terminal status and `finished_at`. That is why there is no age bound here and must not
 * be one: an age bound would stamp a run that is merely slow, which is exactly the
 * frozen-partial attribution the deferral exists to prevent.
 */
export type CostEventProjectAttributionRepairResult = {
  batches: number;
  /** Rows stamped with a watermark, whether or not a project was found. */
  stamped: number;
  /** Rows that got a non-NULL `attributed_project_id`. */
  attributed: number;
  /** Rows left for a later pass because their run had not finished. */
  deferred: number;
  failedBatches: number;
};

/**
 * Canonical lowercase UUID, with the dash positions pinned. Matches exactly the strings
 * `uuid::text` renders, so guarding the cast with it cannot admit a row the previous
 * `issues.id::text = activity_log.entity_id` comparison would have rejected.
 */
const CANONICAL_UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

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
    deferred: 0,
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
        eligible AS MATERIALIZED (
          SELECT b."id", b."company_id", b."project_id", b."heartbeat_run_id"
          FROM batch b
          LEFT JOIN "heartbeat_runs" hr ON hr."id" = b."heartbeat_run_id"
          WHERE b."project_id" IS NOT NULL
             OR b."heartbeat_run_id" IS NULL
             OR hr."id" IS NULL
             OR hr."finished_at" IS NOT NULL
             OR hr."status" NOT IN ('queued', 'running', 'scheduled_retry')
        ),
        resolved AS MATERIALIZED (
          SELECT e."id", COALESCE(e."project_id", link."project_id") AS "project_id"
          FROM eligible e
          LEFT JOIN LATERAL (
            SELECT i."project_id"
            FROM "activity_log" al
            INNER JOIN "issues" i
              ON i."id" = CASE
                   WHEN al."entity_id" ~ ${CANONICAL_UUID_PATTERN}
                   THEN al."entity_id"::uuid
                 END
             AND i."company_id" = e."company_id"
            WHERE al."run_id" = e."heartbeat_run_id"
              AND al."company_id" = e."company_id"
              AND al."entity_type" = 'issue'
              AND i."project_id" IS NOT NULL
            ORDER BY al."created_at" DESC, al."id" DESC
            LIMIT 1
          ) link ON e."project_id" IS NULL
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
            AS "attributed",
          ((SELECT COUNT(*) FROM batch) - (SELECT COUNT(*) FROM eligible))::int
            AS "deferred"
      `)) as unknown as Array<{
        last_id: string | null;
        stamped: number;
        attributed: number;
        deferred: number;
      }>;
      lastId = rows[0]?.last_id ?? null;
      result.stamped += rows[0]?.stamped ?? 0;
      result.attributed += rows[0]?.attributed ?? 0;
      result.deferred += rows[0]?.deferred ?? 0;
    } catch (err) {
      // A lock/statement timeout on one batch must not stall the pass or retry a hot
      // row forever. Skip past it by keyset; a later pass picks it up, because the
      // watermark on those rows is still NULL.
      result.failedBatches += 1;
      options.onBatchError?.(err, afterId);
      try {
        const next = (await db.execute(sql`
          SELECT ce."id"::text AS "id"
          FROM "cost_events" ce
          WHERE ce."attributed_project_at" IS NULL
            AND ce."id" > ${afterId}::uuid
          ORDER BY ce."id" OFFSET ${batchSize - 1} LIMIT 1
        `)) as unknown as Array<{ id: string }>;
        lastId = next[0]?.id ?? null;
      } catch (skipErr) {
        // The skip-ahead is the SAME table under the SAME lock and timeout that just
        // failed, so it is not a safe place to be outside a try: an unguarded throw here
        // rejects the whole pass, not just this batch. End the pass instead and let the
        // next interval retry from the start -- every row it had not reached still has a
        // NULL watermark, so nothing is lost by stopping early.
        result.failedBatches += 1;
        options.onBatchError?.(skipErr, afterId);
        lastId = null;
      }
    }
    result.batches += 1;
    if (lastId === null) break;
    afterId = lastId;
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return result;
}

/**
 * Run {@link repairCostEventProjectAttribution} on an interval until the returned stop
 * function is called. Same shape as `startPodLogSweeper`: fire immediately, then every
 * `intervalMs`, with an in-flight guard so a slow pass cannot overlap its successor.
 *
 * The interval is the point -- see "Why it runs on an INTERVAL" above. A once-per-lease
 * pass cannot converge rows that keep arriving from writers that do not set the column.
 */
export function startCostEventProjectAttributionRepair(
  db: Db,
  intervalMs: number,
  options: {
    batchSize?: number;
    pauseMs?: number;
    onBatchError?: (err: unknown, afterId: string) => void;
    onPassComplete?: (result: CostEventProjectAttributionRepairResult) => void;
    onPassError?: (err: unknown) => void;
  } = {},
): () => void {
  let stopped = false;
  let inFlight = false;

  const runTick = () => {
    if (inFlight || stopped) return;
    inFlight = true;
    repairCostEventProjectAttribution(db, {
      batchSize: options.batchSize,
      pauseMs: options.pauseMs,
      shouldStop: () => stopped,
      onBatchError: options.onBatchError,
    })
      .then((result) => options.onPassComplete?.(result))
      .catch((err) => options.onPassError?.(err))
      .finally(() => {
        inFlight = false;
      });
  };

  runTick();
  const timer = setInterval(runTick, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
