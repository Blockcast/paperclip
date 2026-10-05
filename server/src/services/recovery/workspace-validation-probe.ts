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
 * holds for a confirmed checkout and fails for every other park reason here, so
 * a confirmed checkout is the only one that keeps the no-wake shape and the
 * rest are handed back to the ordinary stranded cause — bounded wake attempts,
 * then a visible escalation.
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
 * True only when a probe positively confirmed the hazard.
 *
 * `probeGitCheckoutStateStrict` is the only producer of `gitProbeState`
 * (heartbeat.ts:4132), and "checkout" is its only affirmative verdict: a real
 * repository under the fallback cwd, whose removal is a repair only a
 * human/agent can perform. That is the one park that has earned the no-wake
 * shape.
 *
 * Everything else fails open and must NOT, including the two managed-worktree
 * reasons, which an earlier revision of this file wrongly asserted were
 * "genuine configuration faults, not unanswered probes":
 *   - `git_worktree_base_not_git_checkout` comes from `isGitCheckout`
 *     (heartbeat.ts:3832), which is `.catch(() => false)` with no timeout — any
 *     probe error reads as a confirmed "not a checkout". This very file already
 *     refuses to use that helper for the dispatch guard for exactly that reason
 *     (heartbeat.ts:4127-4131).
 *   - `git_worktree_branch_incoherence` comes from
 *     `inspectManagedGitWorktreeBranch` (workspace-runtime.ts:3766), whose four
 *     `.catch(() => null)` arms each turn a git exec failure into a
 *     confirmed-sounding verdict; its own throw message concedes it, reporting
 *     that "the checked-out branch could not be verified".
 *
 * So the predicate is an allowlist, not a denylist. A reason code added later
 * is unlatched by default, and the worst case for a genuine configuration fault
 * is a bounded set of wake attempts followed by a visible escalation — against
 * a worst case of a permanent silent strand on the other side.
 */
export function isConfirmedWorkspaceGitHazard(
  workspaceValidationPayload: Record<string, unknown> | null | undefined,
): boolean {
  return workspaceValidationPayload?.gitProbeState === "checkout";
}

/** The no-wake recovery cause a confirmed workspace hazard keeps. */
export const WORKSPACE_VALIDATION_RECOVERY_CAUSE = "workspace_validation_failed";

/**
 * The recovery cause a workspace-validation park should take, or `undefined` to
 * fall through to the ordinary stranded cause (`wake_owner`: bounded attempts,
 * then a visible escalation).
 *
 * Both heartbeat.ts park sites call this rather than repeating the decision:
 * service.ts:6069 already records that writing this kind of rule as parallel
 * expressions is what made the downstream wake-suppression sites drift apart
 * once, and the two sites here are ~600 lines apart.
 */
export function workspaceValidationRecoveryCause(
  workspaceValidationPayload: Record<string, unknown> | null | undefined,
): typeof WORKSPACE_VALIDATION_RECOVERY_CAUSE | undefined {
  return isConfirmedWorkspaceGitHazard(workspaceValidationPayload)
    ? WORKSPACE_VALIDATION_RECOVERY_CAUSE
    : undefined;
}
