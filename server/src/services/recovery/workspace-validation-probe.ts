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
 * That last clause holds ONLY when an invokable owner resolves. When the owner
 * ladder returns none (service.ts:5534), `wakesOwner` is false (:6073), so
 * `maxAttempts`/`timeoutAt` are written null (:6186-6187), `wakePolicy` is the
 * unbounded `board_escalation`/`no_invokable_recovery_owner` shape (:6176-6177),
 * and `enqueueSourceScopedStrandedRecoveryWake` returns before enqueueing
 * anything (:6210 — note :6208 is the `provider_quota` guard and :6209 the
 * cause return; three adjacent returns, only :6210 is the ownerless one). The
 * backstop sweep skips it too, and ORDERING is why this change is inert there:
 * the `!ownerAgentId` test (:13761-13764) runs BEFORE the cause test
 * (:13765-13771) this change was aimed at, so an ownerless row only moves from
 * "skipped by cause" to "skipped by no owner" — same zero wakes, same null
 * budget.
 *
 * BLO-40525 measured that residual and closed it DECLINED (2026-10-06): the
 * branch has never fired. Over the whole table (12,852 actions, 2026-05-25 ->
 * 2026-10-06) ownerless `stranded_assigned_issue` actions are 0 of 11,296, and
 * `board_escalation` of any kind is 1 of 12,852 — a `pr_review_non_convergence`
 * row on BLO-22145 that lived 13m18s and was cancelled. Control: `ownerAgentId`
 * IS nullable in that projection (1/12,852), so the zero is a measurement, not
 * a hydration artifact. The ladder ends assignee's-manager -> creator's-manager
 * -> creator -> CTO -> CEO -> assignee, so emptying it needs every rung
 * non-invokable at once. Re-measure before reopening:
 *   GET /api/companies/{id}/recovery-actions?limit=500&offset=N&order=asc
 *   jq -s '[.[]|select(.kind=="stranded_assigned_issue" and .ownerAgentId==null)]|length'
 *
 * Do NOT "fix" the null budget on this branch. It is deliberate for every shape
 * that wakes nobody, and is pinned by
 * `packages/db/src/issue-recovery-action-legacy-wake-bounds-migration.test.ts`:
 * bounding these makes them retirable by `escalateExpiredWakeHorizons` while
 * still waking no one, which is BLO-19124's damage in reverse.
 *
 * This is deliberately the fix that is correct under BOTH readings of the
 * underlying probe fault, which was measured but NOT explained — again, on the
 * owner-resolved branch:
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
 *
 * Two downstream effects of the cause change, neither obvious from here:
 * the action's `kind` moves "workspace_validation" -> "stranded_assigned_issue"
 * (service.ts:6115, `strandedRecoveryActionKind`), so anything filtering or
 * alerting on that kind stops seeing this class entirely — the diagnostics
 * survive on the issue comment; and the `git_worktree_branch_incoherence` arm
 * of the `nextAction` text became unreachable and was deleted (service.ts:6148),
 * because the heartbeat park sites now grant `workspace_validation_failed` only
 * on `gitProbeState: "checkout"`, whose sole producer (heartbeat.ts:4132-4145)
 * always writes reason `k8s_agent_home_git_bootstrap_unsupported`; the cause's
 * other writer, the BLO-31351 git-transport producer (service.ts:9322), sets it
 * on an `adapter_failed` run that carries no `workspaceValidation` payload.
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
 * So the predicate is an allowlist, not a denylist. It governs only the two
 * heartbeat.ts park sites that call `workspaceValidationRecoveryCause` below,
 * not the BLO-31351 git-transport producer (service.ts:9322), which writes the
 * cause directly. At those two park sites, a reason code added later
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
