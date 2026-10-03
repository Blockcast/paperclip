import type { Db } from "@paperclipai/db";
import { type AgentOrgRow, readCompanyAgentRoster } from "../agent-invokability.js";

/**
 * Default staleness bound for `createAgentRosterMemo`.
 *
 * Deliberately the same 5 s as `DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS`, and for the
 * same reason: the window — not the number of rows saved — is the only thing a reviewer
 * has to accept, and 5 s is small against every human action that changes an org chart
 * and against the 30 s recovery tick. Kept as its own constant rather than imported from
 * the pause-hold guard so the two can diverge if one of their freshness arguments ever
 * changes; they are the same number today by agreement, not by dependency.
 */
export const DEFAULT_AGENT_ROSTER_MEMO_TTL_MS = 5_000;

/**
 * Round-trips this memo took versus answered from cache, over its own lifetime.
 *
 * Same discipline as `ActivePauseHoldPrefilterStats` (PEN-3636): without this the saving
 * is a projection. `memoHits` is exactly the number of roster reads that did not happen.
 */
export type AgentRosterMemoStats = {
  liveReads: number;
  memoHits: number;
};

export type AgentRosterMemo = {
  companyAgents(companyId: string): Promise<AgentOrgRow[]>;
  stats(): AgentRosterMemoStats;
};

/**
 * Per-sweep memo of "every agent row in this company", the read behind
 * `evaluateAgentInvokabilityFromDb`.
 *
 * PEN-3636. The stranded sweep evaluates agent invokability once per candidate, and that
 * evaluation issues TWO round-trips: `getAgent(agentId)` for the subject's own row, then
 * a roster read scoped to the **company** with no id filter. The second cannot differ
 * between two candidates of the same company, and one measured pass put ≥994 candidates
 * through that site — so ≥994 of those reads returned byte-identical rows. At this row's
 * measured ~110 ms per round-trip that is minutes of a single pass spent re-asking one
 * question.
 *
 * ⭐ The non-obvious part, and the reason this is a memo rather than a cache with a
 * hit-rate to argue for: the candidate query already sorts by the memo key.
 * `ORDER BY companyId, assigneeAgentId, createdAt, id` (`service.ts`) means the duplicate
 * reads are not scattered across the pass, they are **adjacent**. A single company owns a
 * contiguous run of candidates, so even a TTL far shorter than the pass collapses most of
 * the run. The saving scales with candidates-per-company, i.e. it is largest exactly where
 * the sweep is slowest.
 *
 * ⚠️ Sizing, stated with its status: ~84% of the duplicates at a 5 s TTL and the measured
 * ~787 ms/candidate (which covers ~6 consecutive candidates). That is a **projection from
 * this row's own numbers, not a measurement** — which is why `stats()` exists. It is also
 * a LOWER bound on the population: candidates that reach the roster read and exit after it
 * also pay the cost and are not in the 994.
 *
 * ⛔ What this does NOT claim. Round-trip count is a real lever but it is not the whole
 * story: the DB's own per-round-trip floor was measured at 13–19 ms (PEN-3636,
 * 2026-10-03) against the sweep's ~131 ms, so a ~7–10× per-round-trip excess remains
 * untouched by this change and by #2194. Removing reads is worth doing and is not a fix
 * for that residual.
 *
 * ## The freshness trade
 *
 * Narrower than it first looks, and the narrowness is the argument. The subject agent's
 * OWN row is **not** memoised — it comes live from `getAgent` on every candidate — so the
 * direct status checks (`paused` / `terminated` / `pending_approval`) stay entirely fresh.
 * Only the roster reaches `getAgentWorkEligibility`'s org-chain walk, so the sole thing a
 * stale entry can misreport is the health of the subject's **ancestors**, within the TTL.
 *
 * Both directions are bounded, and they are not symmetric:
 * - stale roster says an ancestor is healthy when it was just terminated ⇒ reads
 *   `invokable` when the truth is not — recovery is **deferred** to the next pass. Safe.
 * - stale roster says an ancestor is missing/terminated when it was just repaired ⇒ reads
 *   not-invokable for an agent that is in fact healthy. This is the harmful direction: it
 *   can escalate away from a healthy agent, which is a mutation rather than a deferral.
 *
 * ⚠️ So the harmful direction is real and is accepted here only because the TTL bounds it
 * to 5 s and an org-chain repair is a human action. It is bounded by the TTL rather than
 * by pass duration precisely so that a 29-minute pass cannot widen it — the same property
 * that made the pause-hold prefilter acceptable.
 *
 * ⛔ A stronger mitigation was designed and is deliberately NOT built here: serve the memo
 * only to candidates that are about to *decide* and re-read live for any that are about to
 * *act* (the ≥994 suppressed candidates mutate nothing). It is omitted because threading
 * decision-versus-action through the sweep's downstream branches is a large, hard-to-review
 * change for an exposure already bounded at 5 s, and because a reviewer can check the TTL
 * argument but cannot easily check that such a split was applied to every branch. Recorded
 * so the omission is a choice rather than an oversight.
 *
 * ## Construction
 *
 * ⭐ The handle is bound at construction, not taken per call — the same shape
 * `createActivePauseHoldPrefilter` next door arrived at after Ally's review of #2194. The
 * memo is keyed by company alone, so a per-call handle would let one caller's entry be
 * served to another reading on a different handle, which is the hazard that matters: an
 * entry populated on the pool answering a caller inside a transaction hides that
 * transaction's uncommitted writes. Binding removes that *internal* inconsistency and is
 * why `companyAgents` takes only the key.
 *
 * ⚠️ It does NOT make the mismatch impossible, and the distinction is worth keeping
 * straight: nothing stops a caller passing a pool-bound memo while itself reading on a
 * transaction. The binding guarantees the memo is self-consistent, not that it agrees with
 * its caller. Construct one per handle; the sweep reads on the pool throughout.
 *
 * Scope to one pass and construct it there; a module-level cache would leak across
 * requests and across companies' lifetimes.
 */
export function createAgentRosterMemo(
  dbOrTx: Pick<Db, "select">,
  opts: { ttlMs?: number; now?: () => number } = {},
): AgentRosterMemo {
  const ttlMs = opts.ttlMs ?? DEFAULT_AGENT_ROSTER_MEMO_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { readAt: number; rows: AgentOrgRow[] }>();
  let liveReads = 0;
  let memoHits = 0;

  return {
    async companyAgents(companyId) {
      const cached = cache.get(companyId);
      const readAt = now();
      if (cached && readAt - cached.readAt < ttlMs) {
        memoHits += 1;
        return cached.rows;
      }
      // Counted here, BEFORE the await, so a read that throws is still booked as a
      // round-trip taken. Counting on return would silently flatter the saving on exactly
      // the passes where the database is in trouble — the reading would improve as the
      // system degraded. Same rule as the pause-hold prefilter.
      liveReads += 1;
      const rows = await readCompanyAgentRoster(dbOrTx, companyId);
      cache.set(companyId, { readAt, rows });
      return rows;
    },
    stats() {
      return { liveReads, memoHits };
    },
  };
}
