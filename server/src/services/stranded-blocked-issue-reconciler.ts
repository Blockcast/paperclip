/**
 * Stranded-blocked-issue reconciler (BLO-21523, phase 1).
 *
 * Clearing an issue's last `blockedBy` entry does not recompute `status` —
 * see BLO-21523 for the full defect writeup. The eager-recompute fix (phase
 * 2: recompute on blocker-transition) is a separate, more invasive change to
 * the write path and is deliberately not part of this file. This sweep only
 * drains the existing population and keeps it drained: `status = 'blocked'`
 * with no unresolved blocker.
 *
 * Several other mechanisms independently leave an issue `blocked` with zero
 * unresolved blockers. They must not be touched by this sweep or they lose
 * their own wake/repair path: pending interactions or approvals, latest-agent
 * comments that are waiting on the user, executive hold comments, workspace
 * preflight failures, active source-scoped recovery actions, convergence-stall
 * guards, monitor gate waits, and — since BLO-30445 — a two-line external-wait
 * declaration in the description. That last one has no wake path by design (a
 * human-only gate does not move on a timer), so its path out is the blocked
 * inbox, which surfaces it as `external_wait` with the declared owner and
 * action rather than as a stalled row.
 *
 * `blocked` -> `todo` is the target status, per BLO-21523's accepted safe
 * default (not the issue's pre-block status).
 *
 * PEN-3974: every flip also posts a system comment on the issue announcing the
 * change and naming the two-line external-wait declaration that would have held
 * the park. The sweep is correct and stays unconditional; what was wrong is that
 * it was legible only from `activity_log`, so the assignee that set `blocked`
 * saw its status change with no actor, no reason and no remedy. See
 * `announcementBody` for why this is an announcement rather than another
 * suppression.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueComments, issueRelations, issues } from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { logger as defaultLogger } from "../middleware/logger.js";
import {
  listBlockedIssueAutoResumeSuppressions,
  listIssueDependencyReadinessMap,
} from "./issues.js";

/** Rows flipped per batch — keeps each UPDATE's lock window bounded. */
const RECONCILE_BATCH_SIZE = 500;

/** Batches per sweep — backstop against an unbounded loop on a huge backlog. */
const MAX_ITERATIONS = 50;

export interface StrandedBlockedIssueReconcileResult {
  reconciled: number;
  iterations: number;
}

export type StrandedBlockedIssueReconcilerScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: StrandedBlockedIssueReconcilerScheduler = {
  setInterval,
  clearInterval,
};

type CandidateCursor = {
  updatedAt: Date | string;
  id: string;
};

type CandidateRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  updatedAt: Date | string;
};

type LockedCandidateRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  status: string;
};

function toRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? rows as T[] : Array.from(rows as Iterable<T>);
}

async function listCandidateRows(
  dbOrTx: Pick<Db, "execute">,
  batchSize: number,
  cursor: CandidateCursor | null,
): Promise<CandidateRow[]> {
  const cursorPredicate = cursor
    ? sql<boolean>`(i.updated_at, i.id) > (${cursor.updatedAt}, ${cursor.id}::uuid)`
    : sql<boolean>`true`;
  const rows = await dbOrTx.execute(sql<CandidateRow>`
    SELECT
      i.id::text AS id,
      i.company_id::text AS "companyId",
      i.identifier AS identifier,
      i.updated_at AS "updatedAt"
    FROM issues i
    WHERE i.status = 'blocked'
      AND NOT EXISTS (
        SELECT 1
        FROM heartbeat_runs active_run
        WHERE active_run.id IN (i.execution_run_id, i.checkout_run_id)
          AND active_run.status IN ('queued', 'running', 'scheduled_retry')
      )
      AND NOT (
        i.monitor_next_check_at IS NOT NULL
        AND i.monitor_next_check_at > now()
      )
      AND ${cursorPredicate}
    ORDER BY i.updated_at ASC, i.id ASC
    LIMIT ${batchSize}
  `);
  return toRows<CandidateRow>(rows);
}

async function lockIssueRows(dbOrTx: Pick<Db, "execute">, issueIds: string[]) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))].sort();
  if (uniqueIssueIds.length === 0) return;
  await dbOrTx.execute(sql`
    SELECT ${issues.id}
    FROM ${issues}
    WHERE ${inArray(issues.id, uniqueIssueIds)}
    ORDER BY ${issues.id}
    FOR UPDATE
  `);
}

async function listCurrentBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  candidateIds: string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const rows = await dbOrTx
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .where(and(eq(issueRelations.type, "blocks"), inArray(issueRelations.relatedIssueId, candidateIds)));
  return [...new Set(rows.map((row) => row.blockerIssueId))];
}

async function lockCandidatesAndCurrentBlockers(
  dbOrTx: Pick<Db, "execute" | "select">,
  candidateIds: string[],
) {
  const initialBlockerIds = await listCurrentBlockerIssueIds(dbOrTx, candidateIds);
  const lockedIssueIds = new Set([...candidateIds, ...initialBlockerIds]);
  await lockIssueRows(dbOrTx, [...lockedIssueIds]);

  // Relation writers lock the dependent issue before changing blockedBy edges.
  // After candidate rows are locked, the blocker set cannot change under us; if
  // a relation committed immediately before the lock, lock that newly visible
  // blocker too before the final readiness check.
  const currentBlockerIds = await listCurrentBlockerIssueIds(dbOrTx, candidateIds);
  const missingBlockerIds = currentBlockerIds.filter((id) => !lockedIssueIds.has(id));
  if (missingBlockerIds.length > 0) {
    await lockIssueRows(dbOrTx, missingBlockerIds);
  }
}

async function listLockedBlockedCandidates(
  dbOrTx: Pick<Db, "select">,
  candidateIds: string[],
): Promise<LockedCandidateRow[]> {
  if (candidateIds.length === 0) return [];
  const rows = await dbOrTx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issues)
    .where(inArray(issues.id, candidateIds));
  return rows.filter((row) => row.status === "blocked");
}

async function listLockedLivePathIssueIds(
  dbOrTx: Pick<Db, "execute">,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await dbOrTx.execute(sql<{ id: string }>`
    SELECT DISTINCT i.id::text AS id
    FROM issues i
    LEFT JOIN heartbeat_runs active_run
      ON active_run.id IN (i.execution_run_id, i.checkout_run_id)
      AND active_run.status IN ('queued', 'running', 'scheduled_retry')
    WHERE i.id IN (${sql.join(candidateIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND (
        active_run.id IS NOT NULL
        OR (i.monitor_next_check_at IS NOT NULL AND i.monitor_next_check_at > now())
      )
  `);
  return new Set(toRows<{ id: string }>(rows).map((row) => row.id));
}

/**
 * BLO-21523 / PEN-3974 — the flip has to be legible to the row's assignee, not
 * only to `activity_log`.
 *
 * The sweep already writes `issue.stranded_blocked_reconciled`, so the override
 * was never unaudited. But an assignee reads the issue thread, not the activity
 * log, so from the seat that set `blocked` the status simply changed with no
 * actor and no reason — and the row then advertises itself in `inbox-lite` as
 * ordinary buildable work. Measured on PEN-3789: the same card was flipped twice
 * ~2h15m apart while its real gate (a human approving a PR) never moved, and the
 * assignee spent part of two heartbeats rediscovering the flip by observation
 * each time, because nothing it reads said the flip had happened.
 *
 * So: announce the flip on the thread, and name the one carrier that would have
 * held the park. Agent-facing guidance sanctions `blocked` for "a named unblock
 * owner/action" without saying WHERE that has to be written, and prose in a
 * comment is the documented non-match — which is exactly the mistake PEN-3789
 * made. The remedy belongs in the announcement because that is the moment the
 * mistake becomes visible.
 *
 * PEN-5065: the announcement must also say WHAT STATUS, for the same reason. All
 * three readers of the declaration are scoped to `blocked` — this sweep's own
 * suppression, the blocked-inbox `external_wait` attention state, and
 * `isDeadEndBlocked` — so an assignee who follows the remedy above and leaves the
 * row on the `todo` this sweep just set has written two inert lines and been told
 * nothing. That is the worst response available to a correct diagnosis, and this
 * announcement is the one surface guaranteed to be read at exactly that moment,
 * because it fires as the row leaves `blocked`. Measured 2026-10-29 over 756 open
 * rows: 12 carried a well-formed declaration and 6 of them were not `blocked`.
 *
 * Deliberately NOT a widening of `listBlockedIssueAutoResumeSuppressions` to
 * scan comments. Every past widening of that predicate has ended up making rows
 * permanently undrainable — BLO-27553 measured 19 of 23 estate-wide strands
 * sitting behind a suppression that had quietly become unconditional — and a
 * comment is writable by any agent, so a comment-scanning suppression would let
 * any run strand a row forever with two lines of prose. The drain stays; only
 * its silence goes.
 */
const ANNOUNCEMENT_PRESENTATION: IssueCommentPresentation = {
  kind: "system_notice",
  tone: "warning",
  title: "Status changed `blocked` → `todo` automatically",
  detailsDefaultOpen: false,
};

function announcementBody(): string {
  return [
    "**This issue was `blocked` with no unresolved blocker edges and no recognised hold, so the",
    "stranded-blocked-issue reconciler returned it to `todo`.** It is dispatchable again.",
    "",
    "This is an automatic sweep (BLO-21523), not a decision by a person or an agent. Clearing an",
    "issue's last blocker does not by itself recompute `status`, so a row left `blocked` with every",
    "blocker `done` would otherwise sit forever in a state no scheduler can tell apart from a",
    "genuine block.",
    "",
    "**If this issue really is waiting on something the issue graph cannot represent** — an",
    "approval, a credential grant, a human review — then naming the owner in prose does not",
    "register, and a comment is not scanned at all. Put both of these lines in the issue",
    "**description**, each on a line of its own:",
    "",
    "```",
    "external owner: <who must act>",
    "external action: <the concrete action they must take>",
    "```",
    "",
    "Both lines are required. A declared external wait is exempt from this sweep and from the",
    "blocker-resolved wake, and the row is surfaced in the blocked inbox as `external_wait` with",
    "the declared owner and action instead of as a stalled row. Delete the two lines when the gate",
    "clears — a stale declaration parks the row just as effectively as a live one.",
    "",
    "**Set the status back to `blocked` as well — the declaration is read only on a `blocked` row.**",
    "This sweep has just moved this issue to `todo`, so adding the two lines and stopping there",
    "leaves them inert: on `todo`, `in_progress`, `in_review` or `backlog` nothing reads them, and",
    "the row stays dispatchable. If the row is not `blocked` because real agent work remains, hold",
    "it with the instrument that works on its status instead — a `parkedUntil` for a human gate, a",
    "monitor for CI or a queue.",
    "",
    "See `doc/execution-semantics.md#declaring-an-external-wait`.",
  ].join("\n");
}

function announcementMetadata(identifier: string | null): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "Automatic status change",
        rows: [
          { type: "key_value", label: "Changed by", value: "stranded-blocked-issue-reconciler" },
          { type: "key_value", label: "Status before", value: "blocked" },
          { type: "key_value", label: "Status after", value: "todo" },
          { type: "key_value", label: "Reason", value: "no unresolved blockers and no recognised hold" },
          ...(identifier ? [{ type: "key_value" as const, label: "Issue", value: identifier }] : []),
        ],
      },
    ],
  };
}

/**
 * One announcement per FLIP, not per issue.
 *
 * `issue_comments_issue_system_idempotency_idx` is a partial UNIQUE index over
 * `(issue_id, idempotency_key)` for exactly these author-less rows, so this
 * enforces at-most-once in the database rather than checking for it — two
 * replicas sweeping concurrently cannot both post. The key is salted with the
 * flip's own clock on purpose: a row can be legitimately re-blocked and
 * re-promoted (PEN-3789 was, twice), and an issue-scoped key would silence every
 * recurrence after the first — which is precisely the repeat that made the
 * behaviour expensive. Each real flip announces itself; a retry of the same
 * transaction does not.
 */
function announcementIdempotencyKey(issueId: string, reconciledAt: Date): string {
  return `stranded-blocked-issue-reconciler:${issueId}:${reconciledAt.toISOString()}`;
}

async function reconcileCandidateBatch(
  tx: Pick<Db, "execute" | "insert" | "select" | "update">,
  candidates: CandidateRow[],
) {
  const candidateIds = candidates.map((candidate) => candidate.id);
  await lockCandidatesAndCurrentBlockers(tx, candidateIds);

  const lockedCandidates = await listLockedBlockedCandidates(tx, candidateIds);
  if (lockedCandidates.length === 0) return [];
  const livePathIds = await listLockedLivePathIssueIds(tx, candidateIds);

  const candidatesByCompany = new Map<string, LockedCandidateRow[]>();
  for (const candidate of lockedCandidates) {
    const rows = candidatesByCompany.get(candidate.companyId) ?? [];
    rows.push(candidate);
    candidatesByCompany.set(candidate.companyId, rows);
  }

  const eligibleIds: string[] = [];
  for (const [companyId, companyCandidates] of candidatesByCompany) {
    const companyIssueIds = companyCandidates.map((candidate) => candidate.id);
    const [readinessMap, suppressions] = await Promise.all([
      listIssueDependencyReadinessMap(tx, companyId, companyIssueIds),
      listBlockedIssueAutoResumeSuppressions(tx, companyId, companyIssueIds, {
        triggerPath: "stranded_blocked_reconciler",
      }),
    ]);

    for (const candidate of companyCandidates) {
      if (livePathIds.has(candidate.id)) continue;
      const readiness = readinessMap.get(candidate.id);
      if (!readiness?.isDependencyReady) continue;
      if (suppressions.has(candidate.id)) continue;
      eligibleIds.push(candidate.id);
    }
  }

  if (eligibleIds.length === 0) return [];
  // One clock for the flip, its audit row and its announcement, so the
  // announcement's idempotency key is derived from the promotion it describes.
  const reconciledAt = new Date();
  const reconciled = await tx
    .update(issues)
    .set({ status: "todo", updatedAt: reconciledAt })
    .where(and(inArray(issues.id, eligibleIds), eq(issues.status, "blocked")))
    .returning({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier });

  if (reconciled.length > 0) {
    // Announce before the audit row: the thread is the surface the assignee
    // actually reads, and `onConflictDoNothing` keeps a replayed transaction
    // from double-posting.
    await tx
      .insert(issueComments)
      .values(reconciled.map((row) => ({
        companyId: row.companyId,
        issueId: row.id,
        authorType: "system" as const,
        idempotencyKey: announcementIdempotencyKey(row.id, reconciledAt),
        body: announcementBody(),
        presentation: ANNOUNCEMENT_PRESENTATION,
        metadata: announcementMetadata(row.identifier),
      })))
      .onConflictDoNothing();

    await tx.insert(activityLog).values(reconciled.map((row) => ({
      companyId: row.companyId,
      actorType: "system" as const,
      actorId: "stranded-blocked-issue-reconciler",
      action: "issue.stranded_blocked_reconciled",
      entityType: "issue",
      entityId: row.id,
      details: {
        identifier: row.identifier,
        statusBefore: "blocked",
        statusAfter: "todo",
        disposition: "unclassified_external_wait_made_visible",
      },
    })));
  }

  return reconciled;
}

/**
 * Flip `status = 'blocked'` -> `'todo'` for issues with zero unresolved
 * blockers, excluding the intentional blocked populations described above.
 * Idempotent and safe to call on any schedule from any number of replicas:
 * each scanned issue and its current blocker rows are locked, canonical
 * dependency readiness and blocked-resume suppressions are re-evaluated under
 * that lock, and the final write still requires `status = 'blocked'`.
 */
export async function reconcileStrandedBlockedIssues(
  db: Db,
  options: {
    batchSize?: number;
    maxIterations?: number;
    logger?: typeof defaultLogger;
    afterCandidatesSelected?: (candidateIds: string[]) => Promise<void>;
  } = {},
): Promise<StrandedBlockedIssueReconcileResult> {
  const batchSize = Math.max(1, options.batchSize ?? RECONCILE_BATCH_SIZE);
  const maxIterations = Math.max(1, options.maxIterations ?? MAX_ITERATIONS);
  const log = options.logger ?? defaultLogger;

  let reconciled = 0;
  let iterations = 0;
  let cursor: CandidateCursor | null = null;

  while (iterations < maxIterations) {
    const { candidates, flipped } = await db.transaction(async (tx) => {
      const candidates = await listCandidateRows(tx, batchSize, cursor);
      if (candidates.length === 0) return { candidates, flipped: [] };
      await options.afterCandidatesSelected?.(candidates.map((candidate) => candidate.id));
      return { candidates, flipped: await reconcileCandidateBatch(tx, candidates) };
    });

    const lastCandidate = candidates[candidates.length - 1] ?? null;
    if (lastCandidate) {
      cursor = { updatedAt: lastCandidate.updatedAt, id: lastCandidate.id };
    }

    reconciled += flipped.length;
    iterations += 1;

    if (flipped.length > 0) {
      log.info(
        { reconciled: flipped.length, sample: flipped.slice(0, 10).map((r) => r.identifier ?? r.id) },
        "stranded-blocked-issue reconciler flipped blocked issues with zero unresolved blockers to todo (BLO-21523)",
      );
    }

    if (candidates.length < batchSize) break;
  }

  if (iterations >= maxIterations) {
    log.warn(
      { reconciled, iterations },
      "stranded-blocked-issue reconciler hit its iteration cap; some stranded issues may remain until the next sweep",
    );
  }

  return { reconciled, iterations };
}

/**
 * Start a periodic sweep. Mirrors `startPluginLogRetention` /
 * `reconcilerSweepTick` (pr-reconciler-sweep.ts): run once immediately so the
 * backlog starts draining without waiting a full interval, then on the
 * configured cadence. Returns a stop function.
 */
export function startStrandedBlockedIssueReconciler(
  db: Db,
  intervalMs: number,
  options: { batchSize?: number; maxIterations?: number } = {},
  scheduler: StrandedBlockedIssueReconcilerScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (inFlight) return;
    inFlight = reconcileStrandedBlockedIssues(db, options)
      .catch((err) => {
        defaultLogger.error({ err }, "stranded-blocked-issue reconciler sweep failed");
      })
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}
