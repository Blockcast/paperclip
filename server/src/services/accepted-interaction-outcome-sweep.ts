/**
 * Accepted-interaction outcome sweep (PEN-4409).
 *
 * ## The gap
 *
 * An accepted interaction records that a decision was MADE. Nothing anywhere
 * records whether the action it AUTHORISED happened. Measured instance:
 * interaction `f2a8595c` (PEN-4318, `request_confirmation`) was accepted
 * 2026-10-19T07:01:42Z authorising the merge of `Blockcast/paperclip#2584`. At
 * 2026-10-20T09:4xZ — 26h45m and 28 unrelated merges later — the PR was still
 * open at its original head and the card still read `accepted`, having emitted
 * nothing. Critically, no gate was holding it: 4 of 6 sampled PRs that merged in
 * that window merged with zero approving reviews, and one merged 59 minutes
 * after the acceptance in the same gate state. The authorised action simply was
 * not done, and nothing noticed.
 *
 * That is a schema property, not a frequency claim: an accepted decision whose
 * action never happened is byte-identical to one whose action did, so nothing
 * can query the difference and nothing does.
 *
 * ## Shape
 *
 * Modelled on `stranded-blocked-issue-reconciler.ts` — state that asserts
 * something nobody is holding — but with the mutation removed. THIS SWEEP
 * REPORTS ONLY. It performs no writes of any kind, it cannot resolve, cancel,
 * re-open or wake anything, and it must never gain the ability to: the records
 * it reads are board and operator decisions, and a sweep that could act on one
 * would be executing a decision nobody delegated to it. The only outputs are
 * Prometheus gauges and a log line.
 *
 * ## The three buckets are EXHAUSTIVE, and `untracked` is emitted
 *
 * - `observed`  — a declared outcome that has been observed to have happened.
 * - `unobserved`— a declared outcome not (yet) observed.
 * - `untracked` — accepted, with no declared outcome at all.
 *
 * `untracked` is deliberately REPORTED rather than filtered. A sweep that
 * silently drops the cards which declared nothing reads clean precisely because
 * it only sees the cards that volunteered — it would be a dashboard whose scope
 * excludes the failures it exists to catch, and `f2a8595c` itself, which
 * declares nothing, would be invisible to it. Every accepted confirmation lands
 * in exactly one bucket.
 *
 * No time window bounds membership either, for the same reason: an acceptance
 * that was never acted on does not become acceptable by ageing out of the
 * query. The threshold below partitions the REPORT, never the population.
 *
 * ## Every ambiguity resolves toward the alarm, never toward the clear
 *
 * An unrecognised outcome kind, an unresolvable reference, a merge this
 * installation has no record of — all read `unobserved`. A false alarm costs a
 * look; a false clear is strictly worse than today's honest silence, because
 * silence at least does not claim to have checked.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  ACCEPTED_INTERACTION_OUTCOME_BUCKETS,
  type AcceptedInteractionOutcomeBucket,
} from "@paperclipai/shared";

// Re-exported so a consumer of this sweep has one import rather than two; the
// taxonomy itself lives in shared because `metrics.ts` needs it too and must
// not import from this module (that would close a cycle).
export type { AcceptedInteractionOutcomeBucket };
import { logger as defaultLogger } from "../middleware/logger.js";
import {
  setAcceptedInteractionOutcomeMetrics,
  setAcceptedInteractionOutcomeMetricsRefreshSuccess,
} from "./metrics.js";

/**
 * Interaction kinds whose acceptance authorises an action someone else must
 * then perform.
 *
 * `suggest_tasks` also reaches `status: accepted` and is deliberately EXCLUDED:
 * its acceptance creates the issues inside the same transaction and records them
 * in `result.createdTasks`, so the authorised action is performed by the
 * platform and already has a durable record. It is not in the class "decision
 * recorded, action unrecorded". `ask_user_questions` resolves to `answered` and
 * `request_item_verdicts` carries a per-item verdict record, so neither reaches
 * this population at all.
 */
export const ACCEPTED_OUTCOME_SWEEP_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;


/**
 * Where the outcome record came from. Reported alongside the bucket so a reader
 * can tell an agent's declaration from the platform's own tool-action lifecycle.
 */
export type AcceptedInteractionOutcomeSource = "declared" | "tool_action" | "none";

/** Report-only threshold. Partitions the OUTPUT; never filters the population. */
export const DEFAULT_UNOBSERVED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Cap on per-bucket samples carried in the result and log line. */
const SAMPLE_LIMIT = 10;

export interface AcceptedInteractionOutcomeSample {
  interactionId: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  kind: string;
  outcomeKind: string | null;
  source: AcceptedInteractionOutcomeSource;
  resolvedAt: string;
  ageSeconds: number;
  beyondThreshold: boolean;
}

export interface AcceptedInteractionOutcomeBucketReport {
  bucket: AcceptedInteractionOutcomeBucket;
  count: number;
  /** Null when the bucket is empty — never 0, which would read as "resolved this instant". */
  oldestAgeSeconds: number | null;
  /** How many of `count` are older than the reporting threshold. */
  beyondThresholdCount: number;
  samples: AcceptedInteractionOutcomeSample[];
}

export interface AcceptedInteractionOutcomeReport {
  generatedAt: Date;
  unobservedAfterMs: number;
  buckets: Record<AcceptedInteractionOutcomeBucket, AcceptedInteractionOutcomeBucketReport>;
}

/** One accepted confirmation with its observation already resolved. */
export interface ClassifiedRow {
  interactionId: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  kind: string;
  outcomeKind: string | null;
  source: AcceptedInteractionOutcomeSource;
  resolvedAt: Date | string;
  observed: boolean;
}

function toRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? rows as T[] : Array.from(rows as Iterable<T>);
}

/**
 * Classify every accepted confirmation.
 *
 * ## Why the reference comparisons are TEXT comparisons
 *
 * `prNumber` and `issueId` arrive as JSON scalars read out with `->>`, i.e. as
 * text. Casting that text to `int` / `uuid` inside the predicate would throw on
 * a malformed value and take the whole sweep down — and a predicate's AND
 * operands are not evaluated in written order, so a regex guard beside the cast
 * does not reliably protect it. Comparing `pr_number::text` and `id::text`
 * instead cannot throw. The column-side cast costs the index only on the final
 * column; `company_id` and `repo_full_name` equality still select the row.
 *
 * `lower()` on the declared `issueId` is load-bearing, not defensive tidying:
 * `uuid::text` renders lowercase, while the zod `.uuid()` that admitted the
 * value accepts uppercase. Without it an uppercase declaration is admitted at
 * creation, matches nothing here, and reads `unobserved` forever — a permanent
 * false finding produced entirely by formatting.
 */
async function listClassifiedRows(db: Pick<Db, "execute">): Promise<ClassifiedRow[]> {
  const kinds = sql.join(
    ACCEPTED_OUTCOME_SWEEP_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const rows = await db.execute(sql<ClassifiedRow>`
    WITH accepted AS (
      SELECT
        ti.id::text AS "interactionId",
        ti.company_id::text AS "companyId",
        ti.issue_id::text AS "issueId",
        iss.identifier AS "issueIdentifier",
        ti.kind AS kind,
        ti.resolved_at AS "resolvedAt",
        ti.payload -> 'expectedOutcome' AS expected_outcome,
        (ti.payload -> 'toolAction') IS NOT NULL AS has_tool_action,
        ti.result -> 'toolAction' ->> 'status' AS tool_action_status
      FROM issue_thread_interactions ti
      LEFT JOIN issues iss ON iss.id = ti.issue_id
      WHERE ti.status = 'accepted'
        AND ti.kind IN (${kinds})
        AND ti.resolved_at IS NOT NULL
    )
    SELECT
      a."interactionId",
      a."companyId",
      a."issueId",
      a."issueIdentifier",
      a.kind,
      a."resolvedAt",
      a.expected_outcome ->> 'kind' AS "outcomeKind",
      CASE
        WHEN a.expected_outcome IS NOT NULL THEN 'declared'
        WHEN a.has_tool_action THEN 'tool_action'
        ELSE 'none'
      END AS source,
      CASE
        -- A declared outcome wins over the platform's tool-action lifecycle:
        -- the agent was explicit about what it wanted observed.
        WHEN a.expected_outcome ->> 'kind' = 'github_pr_merged' THEN EXISTS (
          SELECT 1
          FROM issue_pull_requests pr
          WHERE pr.company_id = a."companyId"::uuid
            AND pr.repo_full_name = a.expected_outcome -> 'ref' ->> 'repoFullName'
            AND pr.pr_number::text = a.expected_outcome -> 'ref' ->> 'prNumber'
            AND pr.merged_at IS NOT NULL
        )
        WHEN a.expected_outcome ->> 'kind' = 'issue_status' THEN EXISTS (
          SELECT 1
          FROM issues target
          WHERE target.id::text = lower(a.expected_outcome -> 'ref' ->> 'issueId')
            AND target.company_id = a."companyId"::uuid
            AND target.status = a.expected_outcome -> 'ref' ->> 'status'
        )
        -- An expectedOutcome naming a kind this build has no observer for falls
        -- through to false, i.e. 'unobserved'. Adding a kind without adding its
        -- observer therefore fails toward the alarm, never toward the clear.
        WHEN a.expected_outcome IS NOT NULL THEN false
        WHEN a.has_tool_action THEN a.tool_action_status = 'executed'
        ELSE false
      END AS observed
    FROM accepted a
  `);
  return toRows<ClassifiedRow>(rows);
}

function emptyBucket(bucket: AcceptedInteractionOutcomeBucket): AcceptedInteractionOutcomeBucketReport {
  return { bucket, count: 0, oldestAgeSeconds: null, beyondThresholdCount: 0, samples: [] };
}

function bucketFor(row: ClassifiedRow): AcceptedInteractionOutcomeBucket {
  if (row.source === "none") return "untracked";
  return row.observed ? "observed" : "unobserved";
}

/**
 * Build the three-bucket report. Pure once `listClassifiedRows` has answered, so
 * the bucketing rules are unit-testable without a database.
 */
export function buildAcceptedInteractionOutcomeReport(
  rows: ReadonlyArray<ClassifiedRow>,
  options: { now?: Date; unobservedAfterMs?: number } = {},
): AcceptedInteractionOutcomeReport {
  const now = options.now ?? new Date();
  const unobservedAfterMs = Math.max(0, options.unobservedAfterMs ?? DEFAULT_UNOBSERVED_AFTER_MS);
  const buckets: Record<AcceptedInteractionOutcomeBucket, AcceptedInteractionOutcomeBucketReport> = {
    observed: emptyBucket("observed"),
    unobserved: emptyBucket("unobserved"),
    untracked: emptyBucket("untracked"),
  };

  const samplesByBucket: Record<AcceptedInteractionOutcomeBucket, AcceptedInteractionOutcomeSample[]> = {
    observed: [],
    unobserved: [],
    untracked: [],
  };

  for (const row of rows) {
    const resolvedAt = new Date(row.resolvedAt);
    const resolvedMs = resolvedAt.getTime();
    // An unparseable resolved_at cannot be aged. Count it — dropping it would
    // shrink the population silently — but leave it out of the age statistics
    // rather than inventing an age of zero, which would read as "just now".
    const ageSeconds = Number.isFinite(resolvedMs)
      ? Math.max(0, (now.getTime() - resolvedMs) / 1000)
      : null;
    const beyondThreshold = ageSeconds !== null && ageSeconds * 1000 >= unobservedAfterMs;
    const bucket = bucketFor(row);
    const report = buckets[bucket];

    report.count += 1;
    if (beyondThreshold) report.beyondThresholdCount += 1;
    if (ageSeconds !== null) {
      report.oldestAgeSeconds = report.oldestAgeSeconds === null
        ? ageSeconds
        : Math.max(report.oldestAgeSeconds, ageSeconds);
    }

    samplesByBucket[bucket].push({
      interactionId: row.interactionId,
      companyId: row.companyId,
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier ?? null,
      kind: row.kind,
      outcomeKind: row.outcomeKind ?? null,
      source: row.source,
      resolvedAt: Number.isFinite(resolvedMs) ? resolvedAt.toISOString() : String(row.resolvedAt),
      ageSeconds: ageSeconds ?? 0,
      beyondThreshold,
    });
  }

  // Oldest first: the sample is what a human reads to find the actual card, so
  // it must carry the worst offenders rather than an arbitrary slice.
  for (const bucket of ACCEPTED_INTERACTION_OUTCOME_BUCKETS) {
    buckets[bucket].samples = samplesByBucket[bucket]
      .sort((a, b) => b.ageSeconds - a.ageSeconds)
      .slice(0, SAMPLE_LIMIT);
  }

  return { generatedAt: now, unobservedAfterMs, buckets };
}

/** Classify and report. Read-only: issues no INSERT, UPDATE or DELETE. */
export async function sweepAcceptedInteractionOutcomes(
  db: Db,
  options: { now?: Date; unobservedAfterMs?: number } = {},
): Promise<AcceptedInteractionOutcomeReport> {
  const rows = await listClassifiedRows(db);
  return buildAcceptedInteractionOutcomeReport(rows, options);
}

/**
 * Refresh the accepted-interaction outcome gauges.
 *
 * Same contract as every other DB-derived refresh in `scrape-metrics-collector`
 * (BLO-28865): on failure do NOT overwrite the last snapshot with synthetic
 * zeros — an all-zero report reads as "every acceptance has been acted on",
 * which is the one wrong answer this sweep exists to prevent. The freshness
 * gauge fails loudly instead.
 */
export async function refreshAcceptedInteractionOutcomeMetrics(
  db: Db,
  options: { now?: Date; unobservedAfterMs?: number; logger?: typeof defaultLogger } = {},
): Promise<void> {
  const log = options.logger ?? defaultLogger;
  try {
    const report = await sweepAcceptedInteractionOutcomes(db, options);
    setAcceptedInteractionOutcomeMetrics({
      entries: ACCEPTED_INTERACTION_OUTCOME_BUCKETS.map((bucket) => ({
        bucket,
        count: report.buckets[bucket].count,
        oldestAgeSeconds: report.buckets[bucket].oldestAgeSeconds,
      })),
    });
    setAcceptedInteractionOutcomeMetricsRefreshSuccess(true);

    const unobserved = report.buckets.unobserved;
    const untracked = report.buckets.untracked;
    if (unobserved.beyondThresholdCount > 0 || untracked.beyondThresholdCount > 0) {
      log.info(
        {
          unobservedAfterMs: report.unobservedAfterMs,
          observed: report.buckets.observed.count,
          unobserved: unobserved.count,
          unobservedBeyondThreshold: unobserved.beyondThresholdCount,
          untracked: untracked.count,
          untrackedBeyondThreshold: untracked.beyondThresholdCount,
          unobservedSample: unobserved.samples,
          untrackedSample: untracked.samples,
        },
        "accepted interactions whose authorised action has not been observed (PEN-4409)",
      );
    }
  } catch (error) {
    setAcceptedInteractionOutcomeMetricsRefreshSuccess(false);
    throw error;
  }
}
