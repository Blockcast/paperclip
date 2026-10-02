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

export type ActivePauseHoldPrefilter = {
  companyHasActivePauseHold(
    companyId: string,
    treeControlSvc: IssueTreeControlService,
    dbOrTx: Pick<Db, "select">,
  ): Promise<boolean>;
};

/**
 * Per-sweep memo of "does this company have any active pause hold at all".
 *
 * PEN-3636. `isAutomaticRecoverySuppressedByPauseHold` is called once per candidate, and
 * the first thing it does is read `issue_tree_holds` scoped to the **company** — a query
 * whose result cannot differ between two candidates of the same company. One measured
 * pass carried ~3.2k candidates (`skipped: 2234` plus 994 suppressed), and the measured
 * cost of one round-trip is ~110 ms of *queueing*, not execution (the lookups are index
 * seeks — PEN-3636 Done-when #2, measured 2026-10-02 off `pg_heartbeat_runs_access`:
 * `seq_scan` delta 0 across 18 minutes of one in-flight pass). So no index can help and
 * round-trip count is the only lever. The saving scales with candidates-per-company, so
 * it is largest exactly where the sweep is slowest; it is not assumed to be one company.
 *
 * Scope the memo to one pass and construct it there; a module-level cache would leak
 * across requests and across companies' lifetimes.
 *
 * ⚠️ The freshness trade, stated rather than buried: a pause hold created in a company
 * that had none, less than `ttlMs` ago, is not seen, so a candidate processed in that
 * window can still be recovered. Today that check is live, so this is a real — if tightly
 * bounded — weakening of the guard, and it is bounded by the TTL rather than by pass
 * duration precisely so that a 29-minute pass cannot widen it. The opposite direction is
 * free: a hold *released* inside the window only delays recovery to the next pass.
 *
 * Only the negative is cached. When a company does have a hold the caller falls through
 * to the full gate, whose ancestor walk is per-issue and stays entirely live — so the
 * issue-specific half of the decision is never served from cache.
 *
 * ⚠️ Do not share a prefilter across different `dbOrTx` handles. The memo is keyed by
 * company alone, so an entry populated on the pool would be served to a caller running
 * inside a transaction — which `issue-tree-control-service.test.ts` ("routes
 * getActivePauseHoldGate through tx so callers see uncommitted txn state") exists to
 * guarantee against. The sweep reads on the pool throughout; a transactional caller
 * wanting this should construct its own, or pass none and keep the live read.
 */
export function createActivePauseHoldPrefilter(
  opts: { ttlMs?: number; now?: () => number } = {},
): ActivePauseHoldPrefilter {
  const ttlMs = opts.ttlMs ?? DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { readAt: number; present: boolean }>();

  return {
    async companyHasActivePauseHold(companyId, treeControlSvc, dbOrTx) {
      const cached = cache.get(companyId);
      const readAt = now();
      if (cached && readAt - cached.readAt < ttlMs) return cached.present;
      const present = await treeControlSvc.hasAnyActivePauseHold(companyId, dbOrTx);
      cache.set(companyId, { readAt, present });
      return present;
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
  if (prefilter && !(await prefilter.companyHasActivePauseHold(companyId, treeControlSvc, dbOrTx))) {
    return false;
  }
  // dbOrTx: pass tx from inside db.transaction() to reuse the txn connection (BLO-3855).
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId, dbOrTx);
  return Boolean(activePauseHold);
}
