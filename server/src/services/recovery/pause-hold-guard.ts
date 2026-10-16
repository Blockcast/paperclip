import type { Db } from "@paperclipai/db";
import type { ActivePauseHoldRow } from "../issue-tree-control.js";
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
  /**
   * Company-scoped SELECTs `getActivePauseHoldGate` did not issue because it was handed
   * the rows instead (PEN-3636 increment 2).
   *
   * ⚠️ This is NOT a subset of `memoHits`, and the two must not be added. `memoHits`
   * counts reads this prefilter skipped; this counts reads the GATE skipped, and the very
   * first candidate of a company scores on this counter while scoring `liveReads` — the
   * live read IS the gate's read, hoisted out of the loop. Only candidates whose company
   * has at least one active hold reach the gate at all, so on a fleet with no pause holds
   * anywhere this is 0 and increment 2 bought nothing; that is a true reading, not a bug.
   *
   * Accuracy rests on `isAutomaticRecoverySuppressedByPauseHold` being the only consumer
   * of `companyActivePauseHolds`, and on it passing every non-empty answer straight to the
   * gate. A second consumer that read the rows for some other purpose would inflate this.
   * That is why increment 2 also DROPPED the prefilter's boolean accessor rather than
   * deriving it from the list and leaving it in place: a caller wanting only the boolean
   * would have scored here without any gate read being avoided, making this counter
   * quietly wrong. `issueTreeControlService.hasAnyActivePauseHold` is still the right call
   * for that question, and is deliberately unmemoised.
   */
  gateReadsAvoided: number;
};

export type ActivePauseHoldPrefilter = {
  /**
   * The company's active pause holds, in the gate's own projection and order.
   *
   * PEN-3636 increment 2: this is what the memo now stores. An empty array carries the
   * same proof the boolean did — the gate cannot fire for any issue in the company — and a
   * non-empty one additionally saves the gate its own company-scoped read.
   */
  companyActivePauseHolds(companyId: string): Promise<readonly ActivePauseHoldRow[]>;
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
 * ⚠️ The freshness trade, stated rather than buried: a pause hold created less than
 * `ttlMs` ago is not seen, so a candidate processed in that window can still be recovered.
 * Today that check is live, so this is a real — if tightly bounded — weakening of the
 * guard, and it is bounded by the TTL rather than by pass duration precisely so that a
 * 29-minute pass cannot widen it. The opposite direction is free: a hold *released* inside
 * the window only delays recovery to the next pass.
 *
 * ⛔ PEN-3636 increment 2 WIDENED that window, and this is the one thing a reviewer has to
 * accept. While the memo held a boolean, the weakening applied only to a company whose
 * hold set went from EMPTY to non-empty inside the window: once a company had any hold the
 * prefilter stopped short-circuiting, and the gate re-read the list live on every
 * candidate, so a hold added alongside an existing one was picked up at once. Now the ROWS
 * are memoised, so a hold added to a company that ALREADY had one is also invisible for up
 * to `ttlMs`. The bound is unchanged (the same wall-clock TTL, still independent of pass
 * duration) and so is the direction (fail-open on a just-created hold, fail-safe on a
 * just-released one); what changed is that it now covers every company rather than only
 * the empty ones. That is the price of the saving, and it is why `ttlMs` is small: the
 * window a human creating a pause hold would have to lose a race inside is 5 seconds.
 *
 * Only the EMPTY result short-circuits. Every outcome is memoised — `cache.set` runs
 * unconditionally — but only an empty list ends the call there. When a company does have a
 * hold the caller falls through to the full gate, whose ancestor walk is per-issue and
 * stays entirely live, so the issue-specific half of the decision is never served from
 * cache. The rows only ever stand in for the gate's OWN company-scoped read — the same
 * query, from `listActivePauseHolds`, which the gate would otherwise have issued itself.
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
  const cache = new Map<string, { readAt: number; holds: readonly ActivePauseHoldRow[] }>();
  let liveReads = 0;
  let memoHits = 0;
  let gateReadsAvoided = 0;

  const companyActivePauseHolds = async (companyId: string) => {
    const cached = cache.get(companyId);
    const readAt = now();
    if (cached && readAt - cached.readAt < ttlMs) {
      memoHits += 1;
      if (cached.holds.length > 0) gateReadsAvoided += 1;
      return cached.holds;
    }
    // Counted here, BEFORE the await, so a read that throws is still booked as a
    // round-trip taken. Counting on return would silently flatter the saving on exactly
    // the passes where the database is in trouble — the reading would improve as the
    // system degraded.
    liveReads += 1;
    const holds = await treeControlSvc.listActivePauseHolds(companyId, dbOrTx);
    cache.set(companyId, { readAt, holds });
    if (holds.length > 0) gateReadsAvoided += 1;
    return holds;
  };

  return {
    companyActivePauseHolds,
    stats() {
      return { liveReads, memoHits, gateReadsAvoided };
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
  // PEN-3636 increment 2: one read now answers BOTH halves. The empty check is the same
  // short-circuit the boolean prefilter did; the non-empty case hands the rows to the gate
  // so it skips re-reading them. Before this, a company that did have a hold paid the
  // company-scoped list read once per candidate and the prefilter saved it nothing.
  let preloadedActivePauseHolds: readonly ActivePauseHoldRow[] | undefined;
  if (prefilter) {
    preloadedActivePauseHolds = await prefilter.companyActivePauseHolds(companyId);
    if (preloadedActivePauseHolds.length === 0) return false;
  }
  // dbOrTx: pass tx from inside db.transaction() to reuse the txn connection (BLO-3855).
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
    companyId,
    issueId,
    dbOrTx,
    preloadedActivePauseHolds,
  );
  return Boolean(activePauseHold);
}
