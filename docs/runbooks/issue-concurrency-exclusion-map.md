# What stops two runs of one agent from colliding on one issue

**Audience:** anyone about to file, scope, or build "nothing serialises dispatch onto a row
whose `executionRunId` is live".

**Short answer: something does, and has since BLO-19001.** The exclusion is real, it is keyed on
exactly that column, and it is enforced in the dispatcher. It is spread across five modules, each
of which documents its own layer well and none of which documents the set — which is why the
question keeps getting re-asked and re-answered from scratch (PEN-5082, PEN-5356).

This file is a map, not a mechanism. It holds no logic and pins no behaviour. Every claim below
carries a grep anchor; grep the anchor rather than trusting this page, and when a layer moves,
fix the anchor here.

## The five layers

| # | Unit excluded | Signal read | On conflict | Anchor |
|---|---|---|---|---|
| L1 | issue | a `running` sibling of the **same agent** carrying this `issueId` in its `contextSnapshot` | cancels the queued run `duplicate_dispatch_suppressed` | `inFlightIssueIds` (`heartbeat.ts`) |
| L2 | issue | **`issues.executionRunId`** | claim UPDATE matches zero rows → cancels `issue_execution_lock_not_acquired` | `executionRunClaimCondition` (`heartbeat.ts`) |
| L3 | issue | `activeRun`, and a sibling's armed `scheduled_retry` | withholds the row from self-selection | `isIssueHeldByForeignRun`, `isIssueHeldByForeignScheduledRetry` (`issue-run-holding.ts`) |
| L4 | worktree | the resolved execution-workspace **tree** | second run serialises on the reservation index | `withTreeScopedReservationKey` (`heartbeat.ts`, BLO-31443) |
| L5 | git branch | `(companyId, branchKey)` | `BranchClaimConflictError` | `branch-run-claims.ts` |

L2 **is** PEN-5082 done-when 1, verbatim. It is built unconditionally and is always present in the
claiming UPDATE's `.where(...)`. In the non-retry case it is:

```ts
or(isNull(issues.executionRunId), eq(issues.executionRunId, claimed.id))
```

That is one of two branches. When `requiresIssueExecutionRetryLock(claimedRetryReason) &&
claimed.retryOfRunId`, the condition carries a third arm —
`eq(issues.executionRunId, claimed.retryOfRunId)` — so a qualifying retry **inherits its
predecessor's lock** instead of being excluded by it. Unconditional presence is the invariant;
the snippet above is not the whole condition.

**A zero-row claim does not by itself prove another run held the column.** The same `.where(...)`
also ANDs `issueStatusCondition` and `issueActorCondition`, so the UPDATE can match nothing
because the issue left `in_progress`/`in_review`, or because the claimant is neither its assignee
nor its execution-review participant. All three outcomes cancel with the same
`issue_execution_lock_not_acquired`. Anyone who later builds the missing L2 counter (below) must
not read it as "lock collisions" without separating those conditions first.

L1 and L2 are distinct and both load-bearing. L1 runs *before* the claim and is scoped to one
agent's dispatch pass, so it cannot see a holder whose `contextSnapshot` carries no `issueId` —
which is every **autonomous** run, because such a run selects its issue *after* dispatch. L2 is
the backstop that catches exactly that case, because the autonomous holder's checkout did set the
column.

## The one deliberate hole

L2's failure is **tolerated** — not repaired — for two populations:

- `allowsIssueInteractionWake` (`dispatch-readiness.ts`): an issue-interaction wake carrying a
  comment id, so a human can talk to an assignee mid-flight.
- `isNonOwnershipRetryLineage` (BLO-38064): the promoted retry of such a wake.

For these, `issueLockRequired` is false, the zero-row claim is swallowed, and the run proceeds
**without ever acquiring the lock**. It is a deliberately lock-less run, not a competing lock
holder — so there is no lock-ordering or retry fix available, and no configuration in which the
race closes. The consequence is bounded one layer down by L4, which makes two same-issue runs
collide on the tree reservation instead of both writing it.

**Do not "fix" this by widening L2 to refuse the carve-out.** That re-closes the path a human uses
to reach a busy assignee, which is the behaviour the carve-out exists to provide.

## Can a stale `executionRunId` wedge a row?

No, and three independent mechanisms are why. This is worth knowing before proposing a control
keyed on the column, because "it would fail closed and wedge the row" is the usual objection and
the design already answers it.

1. **Terminal runs release.** `runStatusHoldsIssueExecutionLock` is the strict complement of
   `TERMINAL_HEARTBEAT_RUN_STATUSES`, and that terminal set is deliberately a *superset* of the
   canonical union — `error` and `adapter_failed` are included precisely because "treating an
   unknown-but-clearly-dead status as holding a lock would strand the issue forever. Fail toward
   releasing." (`issue-execution-lock.ts`)
2. **Checkout clears before it conflicts.** `clearExecutionRunIfTerminal` /
   `clearCheckoutRunIfTerminal` run at the top of `checkout()` and null the columns for terminal
   runs *before* the conflict is evaluated (`issues.ts`). So a 409 naming a run id means, by
   construction, that run is not terminal.
3. **A time-bounded sweep catches most of the rest.** `sweepStaleIssueLocks` (grep finds two
   definition sites — `heartbeat.ts` and `recovery/service.ts`; the 2h/6h logic is the
   `recovery/service.ts` copy) clears a `running` holder's lock after
   `STALE_RUNNING_ISSUE_LOCK_MS` (2h, corroborated against pod CPU since BLO-30087), and a
   never-started `queued` holder after `STALE_PRE_CLAIM_ISSUE_LOCK_MS` (6h).

   A `scheduled_retry` holder is swept on that same 6h bound **only when its
   `scheduledRetryReason` is not in `SCHEDULED_RETRY_REASONS_REQUIRING_CONTINUOUS_ISSUE_LOCK`**
   (`max_turns_continuation`, `capacity_blocked`, `job_failed`). For those three,
   `isPreClaimLockExpired` returns false unconditionally (BLO-19848) and **the sweep never clears
   the lock, at any age** — so do not expect a max-turns continuation's lock to time out. Clearing
   it would destroy the continuation rather than delay it: the promotion path gates on the lock
   under `FOR UPDATE`, and the pre-start staleness check cancels the run outright with
   `issue_execution_lock_changed` if the column moved underneath it. That population's lock is
   bounded by the promotion path (`requiresIssueExecutionRetryLock`), not by a clock — which is a
   handoff, not a gap, but it is the one holder state where "6h and it releases" is the wrong
   mental model.

A related but separate defect is that `executionAgentNameKey` can go stale against a fresh
`executionRunId` (PEN-5351). That misattributes the holder's **name**, which is a legibility
problem (PEN-5342), not an exclusion problem: every layer above compares **run ids**, never names.
A control keyed on `executionRunId` therefore does not depend on PEN-5351 landing.

## How often this fires

`paperclip_heartbeat_duplicate_dispatch_suppressed_total` — L1's landed cancels, 376–648/day on
seven consecutive days (2026-10-27 → 2026-11-02), mean ≈499/day. Read its own help text before
quoting it: it is unlabelled, and it mixes benign same-tick wake dedupes with genuine
stale-running losses, so it is not an alertable signal.

**L2 has no counter.** `issue_execution_lock_not_acquired` is a durable `heartbeat_runs.error_code`
and a log line only, so the layer that carries PEN-5082 done-when 1 is the one layer whose firing
rate is not in Prometheus. Same family as PEN-5357.

## What is actually still open

Not same-issue exclusion. The live gap is **cross-issue**: two runs of one seat, legitimately
checked out on two *different* issues, resolving to one git branch. L5 is the control for it and
only arms for runs that have an execution-workspace branch name at dispatch — a run with
`executionWorkspaceId: null` clones ad hoc and pushes a branch the table never sees. Measured on
PEN-4764; mechanism decided on PEN-4868; the force-push guard from that decision shipped as
PEN-4869 (#3051).
