import { describe, expect, it } from "vitest";
import { resolveStrandedEscalationStatus } from "./stranded-escalation-status.js";

/**
 * BLO-27635. These pin the *producer* half of the `blocked`-with-no-blocker
 * signature: `escalateStrandedAssignedIssue` writing `status: "blocked"` with an
 * empty `blockedByIssueIds`, which no drain can ever undo.
 *
 * The safety property being pinned is narrow and deliberate. `blocked` remains the
 * default; it is declined ONLY when the escalation can prove there is nothing to be
 * blocked on (no unresolved blocker edge) and nobody who will ever be woken (no
 * recovery owner, no provider-quota monitor park). Every test below is either a case
 * that must keep parking, or the one case that must not.
 */
describe("resolveStrandedEscalationStatus", () => {
  const owned = {
    currentStatus: "in_progress",
    recoveryOwnerAgentId: "agent-1",
    isWakeExhaustedEscalation: false,
    isProviderQuotaWait: false,
    blockerIssueIds: [] as string[],
    recoveryCause: "stranded_assigned_issue",
  };

  describe("keeps parking in `blocked` where a path exists", () => {
    it("parks when a recovery owner resolved, even with no blocker edge", () => {
      // An owner means `wakesOwner` is true, the action gets a horizon, and
      // `enqueueSourceScopedStrandedRecoveryWake` will wake somebody. `blocked` is a
      // real park with a real path out of it — while the action is still `active`.
      // Once the horizon burns, see the wake-exhausted block below.
      expect(resolveStrandedEscalationStatus(owned)).toEqual({
        status: "blocked",
        hasNoRecoveryPath: false,
      });
    });

    it("parks a provider-quota wait, which has no owner but does have a monitor", () => {
      // The quota park is the trap this predicate must not fall into: it looks
      // identical to the stranded case on `recoveryOwnerAgentId` alone. Its wake path
      // is the quota monitor armed for `returnOwnerAgentId` after commit, so flipping
      // it to `todo` would re-dispatch straight back into the exhausted quota.
      expect(resolveStrandedEscalationStatus({
        ...owned,
        recoveryOwnerAgentId: null,
        isProviderQuotaWait: true,
      })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
    });

    it("parks when unresolved blocker edges exist, even with no owner at all", () => {
      // With a real dependency, `blocked` is honest and the dependency sweeps drain
      // it. This is the case the row must NOT be diverted from — diverting it would
      // make a genuinely-dependent issue look dispatchable.
      expect(resolveStrandedEscalationStatus({
        ...owned,
        recoveryOwnerAgentId: null,
        blockerIssueIds: ["blocker-1"],
      })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
    });
  });

  describe("declines the unrecoverable park when no path exists", () => {
    it("leaves `todo` instead of `blocked` when no owner, no quota park, no blockers", () => {
      // The signature case. `resolveStrandedIssueRecoveryOwnerAgentId` returns null
      // only when the whole ladder — including the assignee itself — is non-invokable
      // or budget-blocked, which is a capacity condition, not a dependency. `todo`
      // keeps the row inside `STRANDED_ASSIGNED_ISSUE_STATUSES` so it resumes on its
      // own once capacity returns.
      expect(resolveStrandedEscalationStatus({
        ...owned,
        recoveryOwnerAgentId: null,
      })).toEqual({ status: "todo", hasNoRecoveryPath: true });
    });

    it("preserves `in_review` rather than downgrading it to `todo`", () => {
      // BLO-18643: `in_review` rows are parked on a review participant. Resetting
      // them to `todo` is the park-clobber regression, so the divert must leave the
      // review park alone while still declining to write `blocked`.
      expect(resolveStrandedEscalationStatus({
        ...owned,
        currentStatus: "in_review",
        recoveryOwnerAgentId: null,
      })).toEqual({ status: "in_review", hasNoRecoveryPath: true });
    });

    it("is idempotent on a row already left in `todo`", () => {
      // The diverted row stays sweepable, so the next sweep re-enters this path. It
      // must converge rather than flap: same input, same output, no status churn.
      const first = resolveStrandedEscalationStatus({ ...owned, recoveryOwnerAgentId: null });
      const second = resolveStrandedEscalationStatus({
        ...owned,
        currentStatus: first.status,
        recoveryOwnerAgentId: null,
      });
      expect(second).toEqual(first);
    });

    it("treats an undefined-ish owner the same as an explicit null", () => {
      expect(resolveStrandedEscalationStatus({
        ...owned,
        recoveryOwnerAgentId: "",
      }).hasNoRecoveryPath).toBe(true);
    });
  });

  it("re-parks in `blocked` once an owner becomes resolvable again", () => {
    // Completes the round trip: the divert is not sticky. When capacity returns and
    // routing finds an owner, the next escalation parks normally with a live wake.
    const diverted = resolveStrandedEscalationStatus({ ...owned, recoveryOwnerAgentId: null });
    expect(diverted.status).toBe("todo");
    expect(resolveStrandedEscalationStatus({
      ...owned,
      currentStatus: diverted.status,
      recoveryOwnerAgentId: "agent-1",
    })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
  });

  it.each(["workspace_validation_failed", "configuration_incomplete"])(
    "keeps %s parked for manual repair without an owner or blocker",
    (recoveryCause) => {
      expect(resolveStrandedEscalationStatus({
        ...owned,
        recoveryOwnerAgentId: null,
        recoveryCause,
      })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
    },
  );

  /**
   * BLO-30743. A named owner on an `escalated` action is not a recovery path — the status
   * transition writes only `status`, so `ownerAgentId` stays populated while every wake for
   * it is dropped at `exhaustedSkipped`. The reconciler already knows this (its suppression
   * set is `["active"]`, deliberately excluding `escalated`), so a producer that keeps
   * writing `blocked` here is writing a status the reconciler will immediately undo.
   *
   * That disagreement is the oscillation: measured on BLO-27999 at 458 writes in 10.3h,
   * 208 of them `issue.escalation.needs_human_decision` — each a Slack forward — across 14
   * rows estate-wide.
   */
  describe("wake-exhausted escalation (BLO-30743)", () => {
    const exhausted = { ...owned, isWakeExhaustedEscalation: true };

    it("declines `blocked` when the owner is named but its action has escalated", () => {
      // The production shape, verbatim: BLO-27999 carried a `stranded_assigned_issue`
      // action at attemptCount 748 / maxAttempts 5, twelve days past its `timeoutAt`,
      // with `ownerAgentId` still set.
      expect(resolveStrandedEscalationStatus(exhausted)).toEqual({
        status: "todo",
        hasNoRecoveryPath: true,
      });
    });

    it("agrees with the reconciler, so the two drains reach a fixed point", () => {
      // The reconciler flips such a row to `todo`. The producer must write that same
      // status rather than `blocked`, or each sweep undoes the other forever.
      const producerStatus = resolveStrandedEscalationStatus(exhausted).status;
      const reconcilerTarget = "todo";
      expect(producerStatus).toBe(reconcilerTarget);

      // And re-running the producer on its own output is stable.
      expect(resolveStrandedEscalationStatus({
        ...exhausted,
        currentStatus: producerStatus,
      })).toEqual({ status: "todo", hasNoRecoveryPath: true });
    });

    it("still parks when a real blocker edge exists, exhausted or not", () => {
      // Wake-exhaustion says nothing about dependencies. With an unresolved edge,
      // `blocked` remains honest and the dependency sweeps own the row.
      expect(resolveStrandedEscalationStatus({
        ...exhausted,
        blockerIssueIds: ["blocker-1"],
      })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
    });

    it("still parks a provider-quota wait, whose wake path is a monitor, not an owner wake", () => {
      // The quota park's path out is the post-commit monitor armed for
      // `returnOwnerAgentId`. Owner-wake exhaustion does not retire that, so flipping it
      // to `todo` would re-dispatch straight back into the exhausted quota.
      expect(resolveStrandedEscalationStatus({
        ...exhausted,
        recoveryOwnerAgentId: null,
        isProviderQuotaWait: true,
      })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
    });

    it.each(["workspace_validation_failed", "configuration_incomplete"])(
      "still parks %s, which is awaiting a human rather than a wake",
      (recoveryCause) => {
        expect(resolveStrandedEscalationStatus({
          ...exhausted,
          recoveryCause,
        })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
      },
    );

    it("preserves `in_review` rather than downgrading it", () => {
      expect(resolveStrandedEscalationStatus({
        ...exhausted,
        currentStatus: "in_review",
      })).toEqual({ status: "in_review", hasNoRecoveryPath: true });
    });

    it("re-parks in `blocked` once a fresh owner sequence restores a live wake", () => {
      // Not sticky: a reassignment resets the wake budget, so the next escalation parks
      // normally with a real path out.
      expect(resolveStrandedEscalationStatus({
        ...exhausted,
        isWakeExhaustedEscalation: false,
        recoveryOwnerAgentId: "agent-2",
      })).toEqual({ status: "blocked", hasNoRecoveryPath: false });
    });
  });
});
