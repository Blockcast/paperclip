import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "../issue-tree-control.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

/**
 * Default staleness bound for `createActivePauseHoldPrefilter`.
 *
 * Deliberately short. The prefilter's whole cost is that a hold created inside the
 * window is not seen, and that window — not the number of rows it saves — is the only
 * thing a reviewer has to accept. Five seconds is small against every human action that
 * creates a pause hold, and small against the 30 s recovery tick, while still collapsing
 * the per-candidate reads of a long sweep by roughly the ratio of pass duration to TTL.
 */
export const DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS = 5_000;

/**
 * Round-trips this prefilter took versus answered from the memo, over its own lifetime.
 *
 * PEN-3636: without this the saving is a projection. The sweep's funnel reports what the
 * pass *did*, never what it *cost*, so "the prefilter removed N round-trips" had no
 * observable. `memoHits` is exactly the number of company-scoped reads that did not
 * happen; `liveReads` is what they cost instead.
 */
export type ActivePauseHoldPrefilterStats = {
  liveReads: number;
  memoHits: number;
};

export type ActivePauseHoldPrefilter = {
  companyHasActivePauseHold(companyId: string): Promise<boolean>;
  stats(): ActivePauseHoldPrefilterStats;
};

/**
 * Per-sweep memo of "does this company have any active pause hold at all".
 *
 * PEN-3636. `isAutomaticRecoverySuppressedByPauseHold` is called once per candidate, and
 * the first thing it does is read `issue_tree_holds` scoped to the **company** — a query
 * whose result cannot differ between two candidates of the same company. One measured
 * pass skipped 2,234 candidates, and the measured cost of one round-trip is ~110 ms of
 * *queueing*, not execution (the lookups are index seeks — PEN-3636 Done-when #2, measured
 * 2026-10-02 off `pg_heartbeat_runs_access`: `seq_scan` delta 0 across 18 minutes of one
 * in-flight pass). So no index can help and round-trip count is the only lever. The saving
 * scales with candidates-per-company, so it is largest exactly where the sweep is slowest;
 * it is not assumed to be one company.
 *
 * ⚠️ 2,234 is a **lower bound on candidates, not a count of them**, and the two funnel
 * populations must not be added: `dependencyWaitEscalationSuppressed` counts suppressions
 * *inside* `escalateStrandedAssignedIssue`, which returns null, and every call site books
 * that null as `result.skipped += 1`. The 994 are therefore a subset of the 2,234, not a
 * disjoint addend. The true candidate count is not derivable from the funnel at all —
 * which is why `candidatesScanned` is now a first-class field on it.
 *
 * Scope the memo to one pass and construct it there; a module-level cache would leak
 * across requests and across companies' lifetimes.
 *
 * FOLLOW-UP, recorded so it is not rediscovered: four sibling sweeps in `recovery/service.ts`
 * run this same guard inside their own per-candidate loops and still pay the O(candidates)
 * company read — `createIssueGraphLivenessEscalation`,
 * `reconcileResolvedDependencyWakeBackstopImpl`, `reconcileStrandedRecoveryHandBacksImpl` and
 * `reconcileStrandedRecoveryWakeBackstopImpl`. They are deliberately NOT converted here:
 * PEN-3636 is scoped to the stranded sweep, which is 85% of the chain, and those four are
 * ~5 minutes combined against its 29. Each needs its own prefilter instance — sharing one
 * across sweeps would outlive the TTL's premise that a pass is the unit of staleness.
 *
 * ⚠️ The freshness trade, stated rather than buried: a pause hold created in a company
 * that had none, less than `ttlMs` ago, is not seen, so a candidate processed in that
 * window can still be recovered. Today that check is live, so this is a real — if tightly
 * bounded — weakening of the guard, and it is bounded by the TTL rather than by pass
 * duration precisely so that a 29-minute pass cannot widen it. The opposite direction is
 * free: a hold *released* inside the window only delays recovery to the next pass.
 *
 * Only the negative SHORT-CIRCUITS. Both outcomes are memoised — `cache.set` below runs
 * unconditionally — but only `false` ends the call there. When a company does have a hold
 * the caller falls through to the full gate, whose ancestor walk is per-issue and stays
 * entirely live, so the issue-specific half of the decision is never served from cache. A
 * memoised `true` costs one extra live gate call and decides nothing by itself, which is
 * why caching it is harmless; the load-bearing property is the short-circuit, not the
 * storage.
 *
 * `treeControlSvc` and `dbOrTx` are bound HERE, at construction, rather than taken per
 * call. The memo is keyed by company alone, so a per-call handle would let an entry
 * populated on the pool be served to a caller running inside a transaction — which
 * `issue-tree-control-service.test.ts` ("routes getActivePauseHoldGate through tx so
 * callers see uncommitted txn state") exists to guarantee against. Binding makes that
 * entry unrepresentable instead of merely warned about: one prefilter answers on exactly
 * one handle. The sweep reads on the pool throughout; a transactional caller wanting this
 * should construct its own against its tx, or pass none and keep the live read.
 */
export function createActivePauseHoldPrefilter(
  treeControlSvc: IssueTreeControlService,
  dbOrTx: Pick<Db, "select">,
  opts: { ttlMs?: number; now?: () => number } = {},
): ActivePauseHoldPrefilter {
  const ttlMs = opts.ttlMs ?? DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { readAt: number; present: boolean }>();
  let liveReads = 0;
  let memoHits = 0;

  return {
    async companyHasActivePauseHold(companyId) {
      const cached = cache.get(companyId);
      const readAt = now();
      if (cached && readAt - cached.readAt < ttlMs) {
        memoHits += 1;
        return cached.present;
      }
      // Counted here, BEFORE the await, so a read that throws is still booked as a
      // round-trip taken. Counting on return would silently flatter the saving on exactly
      // the passes where the database is in trouble — the reading would improve as the
      // system degraded.
      liveReads += 1;
      const present = await treeControlSvc.hasAnyActivePauseHold(companyId, dbOrTx);
      cache.set(companyId, { readAt, present });
      return present;
    },
    stats() {
      return { liveReads, memoHits };
    },
  };
}

export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
  dbOrTx: Pick<Db, "select"> = db,
  // PEN-3636: optional, and omitting it preserves today's behaviour exactly — every
  // caller that does not pass one still takes a live per-issue read. Callers in a sweep
  // pass one so the company-scoped half is answered once instead of once per candidate.
  prefilter?: ActivePauseHoldPrefilter,
) {
  // Short-circuits *inside* this function rather than at the call site on purpose: the
  // adoption-interleaving regression test (`issue-recovery-actions.test.ts`) uses this
  // call as its seam for "commit an adoption between the candidate snapshot and the
  // handover branch", and a call site that skipped the call would silently retire that
  // seam while leaving the test green.
  if (prefilter && !(await prefilter.companyHasActivePauseHold(companyId))) {
    return false;
  }
  // dbOrTx: pass tx from inside db.transaction() to reuse the txn connection (BLO-3855).
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId, dbOrTx);
  return Boolean(activePauseHold);
}
