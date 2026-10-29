/**
 * Wall-clock budget for the stranded sweep's candidate loop (BLO-48950).
 *
 * The loop is serial and issues ~3-5 dependent reads per candidate, so its duration is
 * candidates x DB round-trip. Population is stable (~1,100), so when the database slows
 * the pass grows with it and has nothing to stop it: measured 2026-10-25, one chain ran
 * 2,917 s against a 900 s target, each excursion tracking
 * `paperclip_pg:probe_latency_seconds:p50_1h`, while a healthy pass of the same
 * population took 30 s. Past `STRANDED_RECENT_PROGRESS_EXEMPTION_MS` (1,800 s) a long
 * pass also starts judging its own tail against a stale clock.
 *
 * So the loop stops once its budget is spent and the NEXT pass resumes after the last
 * candidate this one reached, wrapping. A slow database therefore costs recovery
 * latency (full coverage takes several chains) instead of chain length. A healthy pass
 * never touches the budget.
 *
 * Resuming by sort KEY rather than by issue id is load-bearing: the candidate this pass
 * reached last is very likely to have just been dispatched or escalated, i.e. to have
 * left the candidate set, so an id lookup would miss and restart at the head every time
 * -- starving the tail forever, which is the one outcome worse than a long pass.
 *
 * Diagnostic shape is unchanged: a budget stop is a truncated pass, which the phase-timing
 * line already reports as `candidatesScanned - candidates.count` (= never reached).
 */

export const STRANDED_SWEEP_BUDGET_MS = Math.max(
  60_000,
  Number(process.env.STRANDED_SWEEP_BUDGET_MS) || 450_000,
);

export type StrandedSweepKey = {
  companyId: string;
  assigneeAgentId: string | null;
  createdAt: Date;
  id: string;
};

// Mirrors the candidate query's ORDER BY (companyId, assigneeAgentId, createdAt, id), all
// ASC. Postgres sorts NULLs LAST under ASC; ids are lowercase uuid text, which compares
// the same bytewise as uuid does.
export function compareStrandedSweepKey(a: StrandedSweepKey, b: StrandedSweepKey): number {
  if (a.companyId !== b.companyId) return a.companyId < b.companyId ? -1 : 1;
  if (a.assigneeAgentId !== b.assigneeAgentId) {
    if (a.assigneeAgentId === null) return 1;
    if (b.assigneeAgentId === null) return -1;
    return a.assigneeAgentId < b.assigneeAgentId ? -1 : 1;
  }
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t < 0 ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Rotate `candidates` (already in key order) to start just after `resumeAfter`. */
export function rotateStrandedCandidates<T extends StrandedSweepKey>(
  candidates: readonly T[],
  resumeAfter: StrandedSweepKey | null,
): T[] {
  if (!resumeAfter) return [...candidates];
  const start = candidates.findIndex((c) => compareStrandedSweepKey(c, resumeAfter) > 0);
  if (start <= 0) return [...candidates];
  return [...candidates.slice(start), ...candidates.slice(0, start)];
}

/**
 * The budgeted candidate loop itself, so its two load-bearing lines -- the `break` and the
 * cursor reset -- are under test rather than only inside `service.ts`. `visit` must not
 * throw; the service wraps its per-candidate error boundary inside it.
 *
 * `resumeAfter` is the last candidate reached when the budget stopped the loop, and null
 * when every candidate was reached, so a clean pass sends the next one back to the head.
 */
export async function runBudgetedStrandedLoop<T extends StrandedSweepKey>(
  candidates: readonly T[],
  visit: (candidate: T) => Promise<void>,
  budgetMs: number = STRANDED_SWEEP_BUDGET_MS,
  now: () => number = Date.now,
  shouldStop?: () => boolean,
): Promise<{ reached: number; budgetExhausted: boolean; stopped: boolean; resumeAfter: T | null }> {
  const startedAt = now();
  let reached = 0;
  let last: T | null = null;
  for (const candidate of candidates) {
    // Shutdown wins over the budget; the cursor is in-memory, so there is nothing to keep.
    if (shouldStop?.()) return { reached, budgetExhausted: false, stopped: true, resumeAfter: null };
    // Checked before each candidate, so the one in flight always finishes.
    if (now() - startedAt > budgetMs) return { reached, budgetExhausted: true, stopped: false, resumeAfter: last };
    last = candidate;
    reached += 1;
    await visit(candidate);
  }
  return { reached, budgetExhausted: false, stopped: false, resumeAfter: null };
}
