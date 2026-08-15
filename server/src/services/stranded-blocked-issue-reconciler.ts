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
 * guards, and monitor gate waits.
 *
 * `blocked` -> `todo` is the target status, per BLO-21523's accepted safe
 * default (not the issue's pre-block status).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
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

async function reconcileCandidateBatch(
  tx: Pick<Db, "execute" | "select" | "update">,
  candidates: CandidateRow[],
) {
  const candidateIds = candidates.map((candidate) => candidate.id);
  await lockCandidatesAndCurrentBlockers(tx, candidateIds);

  const lockedCandidates = await listLockedBlockedCandidates(tx, candidateIds);
  if (lockedCandidates.length === 0) return [];

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
      const readiness = readinessMap.get(candidate.id);
      if (!readiness?.isDependencyReady) continue;
      if (suppressions.has(candidate.id)) continue;
      eligibleIds.push(candidate.id);
    }
  }

  if (eligibleIds.length === 0) return [];
  return tx
    .update(issues)
    .set({ status: "todo", updatedAt: new Date() })
    .where(and(inArray(issues.id, eligibleIds), eq(issues.status, "blocked")))
    .returning({ id: issues.id, identifier: issues.identifier });
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
  options: { batchSize?: number; maxIterations?: number; logger?: typeof defaultLogger } = {},
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
