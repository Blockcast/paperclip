/**
 * BLO-19924: a `workspace_validation_failed` park routes to `wakePolicy:
 * manual_repair_required`, which carries no wake, no attempt budget and no
 * horizon — nothing re-probes the issue, ever. That is the correct shape for a
 * CONFIRMED hazard ("this fallback dir really does contain a checkout; remove
 * it"). It is the wrong shape for a probe that never answered.
 *
 * `probeGitCheckoutStateStrict` (heartbeat.ts) returns "indeterminate" whenever
 * it could not reach a verdict — exec timeout, empty stdout, or ENOENT with the
 * path still present. The dispatch guard then fails closed. That refusal is
 * correct and is NOT changed here: BLO-18147 exists precisely so a storage-layer
 * probe failure cannot wave an unsafe clone source through to the pod.
 *
 * What is wrong is that the *recovery* shape treats "could not answer" as
 * "answered yes", so one failed probe latches the issue out of every automatic
 * path permanently.
 *
 * The rule this bucket is supposed to follow is already stated for the git
 * transport classifier in service.ts: route to the no-wake cause only when "the
 * same agent against the same source cannot produce a different result". That
 * holds for a confirmed checkout and fails for a probe that never completed, so
 * the inconclusive case is handed back to the ordinary stranded cause — bounded
 * wake attempts, then a visible escalation.
 *
 * This is deliberately the fix that is correct under BOTH readings of the
 * underlying probe fault, which was measured but NOT explained:
 *   - transient  -> the next attempt re-probes, gets a verdict, and drains.
 *   - determinis -> the attempts exhaust and the action escalates where someone
 *                   can see it, instead of latching silently forever.
 *
 * Measured 2026-10-05 on BLO-19924: of 99 blocked rows carrying
 * `k8s_agent_home_git_bootstrap_unsupported`, 99/99 recorded
 * `gitProbeState: "indeterminate"` and 0/99 recorded "checkout" — i.e. no stray
 * repository was ever found on any of them. Re-probing six of the implicated
 * fallback dirs returned "not_a_checkout" cleanly in 14-53ms against a 5000ms
 * timeout.
 */

/**
 * True only when the strict git probe positively failed to reach a verdict.
 *
 * Deliberately narrow. "checkout" is a confirmed hazard and keeps the
 * manual-repair shape, because removing that checkout really is a repair only a
 * human/agent can perform. The managed-worktree reasons
 * (`git_worktree_base_not_git_checkout`, `git_worktree_branch_incoherence`)
 * carry no `gitProbeState` at all and likewise keep it: those are genuine
 * configuration faults, not unanswered probes.
 */
export function isInconclusiveWorkspaceGitProbe(
  workspaceValidationPayload: Record<string, unknown> | null | undefined,
): boolean {
  return workspaceValidationPayload?.gitProbeState === "indeterminate";
}
