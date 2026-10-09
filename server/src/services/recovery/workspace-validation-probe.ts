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
 * ladder (`resolveStrandedRecoveryRouting`) returns none, `wakesOwner` is false,
 * so `recoveryActionBoundsAtCreation` is skipped and `maxAttempts`/`timeoutAt`
 * are written null, `wakePolicy` takes the unbounded
 * `board_escalation`/`no_invokable_recovery_owner` shape, and
 * `enqueueSourceScopedStrandedRecoveryWake` returns before enqueueing anything
 * (its `!input.action.ownerAgentId` return — the third of three adjacent early
 * returns, after the `provider_quota` guard and the cause return). The backstop
 * sweep skips it too, and ORDERING is why this change is inert there: in
 * `reconcileStrandedRecoveryWakeBackstopImpl` the `!ownerAgentId` skip runs
 * BEFORE the cause test this change was aimed at, so an ownerless row only moves from
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
 * On that escalation the source issue stays `blocked`, as the confirmed class
 * does. `resolveStrandedEscalationStatus` cannot learn "manual repair" from the
 * cause any more, so it reads the run's `workspace_validation_failed` error code
 * instead; without that it wrote `todo`, and dispatch refused and re-parked the
 * row on every pass. What this does NOT close: the BLO-21523 reconciler does not
 * suppress on an `escalated` action, so it can still drain such a row to `todo`.
 * That is shared with the confirmed class, whose unbounded action BLO-40297
 * retires on the same horizon, so it is not widened here.
 *
 * Measured 2026-10-05 on BLO-19924: of 99 blocked rows carrying
 * `k8s_agent_home_git_bootstrap_unsupported`, 99/99 recorded
 * `gitProbeState: "indeterminate"` and 0/99 recorded "checkout" — i.e. no stray
 * repository was ever found on any of them. Re-probing six of the implicated
 * fallback dirs returned "not_a_checkout" cleanly in 14-53ms against a 5000ms
 * timeout.
 *
 * One downstream effect of the cause change is not obvious from here: for the
 * parks that lose the cause, the action's `kind` moves "workspace_validation" ->
 * "stranded_assigned_issue" (`strandedRecoveryActionKind` in service.ts), so
 * anything filtering or alerting on that kind stops seeing those rows — the
 * diagnostics survive on the issue comment.
 *
 * ⚠ An earlier revision of this file also claimed the
 * `git_worktree_branch_incoherence` arm of the `nextAction` text in service.ts
 * "became unreachable and was deleted". That was wrong, and deleting the arm broke
 * two master tests in `heartbeat-workspace-branch-containment.test.ts`. The claim
 * rested on reading only the finalize-path producer (in `heartbeatService`,
 * fingerprinted by `fingerprintFinalizeWorkspaceBranchValidation`) and missing
 * BLO-32628's branch-containment producer (`inspectGitWorktreeBranchIncoherence`
 * in workspace-runtime.ts), which
 * reaches a positively confirmed divergence. The arm is reachable, is restored,
 * and the containment tests are its positive control.
 */

/**
 * True only when a probe positively confirmed the hazard.
 *
 * `probeGitCheckoutStateStrict` is the only producer of `gitProbeState`
 * (heartbeat.ts), and "checkout" is its only affirmative verdict: a real
 * repository under the fallback cwd, whose removal is a repair only a
 * human/agent can perform. That is the one park that has earned the no-wake
 * shape.
 *
 * The second affirmative verdict is BLO-32628's
 * `provenance.ancestryVerdict: "diverged"`. That is the same answered/unanswered
 * shape one level down: `getGitWorktreeBranchAncestryVerdict`
 * (workspace-runtime.ts) runs `git merge-base --is-ancestor` and maps exit
 * 0 -> "ancestor", exit 1 -> "diverged", and EVERY failure mode — missing
 * expected/actual SHA, `.catch(() => null)` on the exec, any other exit code —
 * to "unknown". So "diverged" means git answered and the recorded branch is
 * provably not an ancestor of the checked-out one, with two resolved 40-hex
 * SHAs on the payload to show for it. That is a confirmed hazard by
 * construction, and it is why the predicate keys on the verdict rather than on
 * `reason`.
 *
 * Keying on `reason === "git_worktree_branch_incoherence"` instead would be
 * wrong in the fail-open direction this file exists to close, because that
 * reason has TWO producers and only one of them carries provenance:
 *   - BLO-32628 branch containment (`inspectGitWorktreeBranchIncoherence`)
 *     — carries `provenance.ancestryVerdict`, so it can be judged. A park at
 *     `ancestryVerdict: "unknown"` is a dead probe and must stay unlatched.
 *   - the finalize-path check in `heartbeatService` — carries
 *     `managedGitWorktreeBranch` and NO provenance, from
 *     `inspectManagedGitWorktreeBranch` (workspace-runtime.ts), whose four
 *     `.catch(() => null)` arms each turn a git exec failure into a
 *     confirmed-sounding reasonCode; its own throw message concedes it,
 *     reporting that "the checked-out branch could not be verified". Nothing on
 *     that payload separates a configuration fault from a dead probe, so it
 *     stays unlatched.
 *
 * `git_worktree_base_not_git_checkout` stays unlatched for the same reason: it
 * comes from `isGitCheckout` (heartbeat.ts), which is `.catch(() => false)`
 * with no timeout, so any probe error reads as a confirmed "not a checkout".
 * This very file already refuses to use that helper for the dispatch guard for
 * exactly that reason (the comment above its `probeGitCheckoutStateStrict` call
 * in `assertGitSensitiveAdapterWorkspaceValid`).
 *
 * So the predicate is an allowlist of verdicts, not a denylist of reasons. It
 * governs only the two heartbeat.ts park sites that call
 * `workspaceValidationRecoveryCause` below, not the BLO-31351 git-transport
 * producer (the `workspace_git_transport` branch in `recoveryService`), which
 * writes the cause directly. At those two park
 * sites, a reason code added later is unlatched by default, and the worst case
 * for a genuine configuration fault is a bounded set of wake attempts followed
 * by a visible escalation — against a worst case of a permanent silent strand on
 * the other side.
 */
export function isConfirmedWorkspaceGitHazard(
  workspaceValidationPayload: Record<string, unknown> | null | undefined,
): boolean {
  if (workspaceValidationPayload?.gitProbeState === "checkout") return true;
  // `provenance` arrives from a persisted resultJson blob, so it is typed only by
  // convention. No typeof/Array guard: the `=== "diverged"` compare already rejects
  // every non-object shape (a string or array has no `ancestryVerdict`), and `?.`
  // covers null/undefined. Guards past that have no failing mutation.
  return (workspaceValidationPayload?.provenance as Record<string, unknown> | undefined)
    ?.ancestryVerdict === "diverged";
}

/** The no-wake recovery cause a confirmed workspace hazard keeps. */
export const WORKSPACE_VALIDATION_RECOVERY_CAUSE = "workspace_validation_failed";

/**
 * The recovery cause a workspace-validation park should take, or `undefined` to
 * fall through to the ordinary stranded cause (`wake_owner`: bounded attempts,
 * then a visible escalation).
 *
 * Both heartbeat.ts park sites call this rather than repeating the decision:
 * the comment above `wakesOwner` in service.ts already records that writing
 * this kind of rule as parallel expressions is what made the downstream
 * wake-suppression sites drift apart once, and the two sites here are far
 * apart in heartbeat.ts.
 */
export function workspaceValidationRecoveryCause(
  workspaceValidationPayload: Record<string, unknown> | null | undefined,
): typeof WORKSPACE_VALIDATION_RECOVERY_CAUSE | undefined {
  return isConfirmedWorkspaceGitHazard(workspaceValidationPayload)
    ? WORKSPACE_VALIDATION_RECOVERY_CAUSE
    : undefined;
}
