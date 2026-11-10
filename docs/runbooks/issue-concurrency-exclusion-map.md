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
| L1 | issue | a `running` sibling of the **same agent** carrying this `issueId` in its `contextSnapshot` | **same wake class:** cancels the queued run `duplicate_dispatch_suppressed`; **github wake vs non-github incumbent:** leaves it `queued` and reports `duplicate_dispatch_cross_reason_deferred` | `inFlightIssueWakeClasses`, `classifyHeartbeatWakeClass` (`heartbeat.ts`) |
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
because the issue is not in a status this claim accepts, or because the claimant is neither its
assignee nor its execution-review participant. "Not in a status this claim accepts" is wider than
"left `in_progress`/`in_review`": `issueStatusCondition` has three branches
(`heartbeat.ts`, search `const issueStatusCondition`) — a `requiresInProgressIssueRetry` retry
narrows it to `in_progress` **alone**, and an auto-checkout wake on a dependency-ready issue
*widens* it to also admit `todo`/`backlog`/`blocked`. All three outcomes cancel with the same
`issue_execution_lock_not_acquired`. Anyone who later builds the missing L2 counter (below) must
not read it as "lock collisions" without separating those conditions first.

L1 and L2 are distinct and both load-bearing. L1 runs *before* the claim and is scoped to one
agent's dispatch pass, so it cannot see a holder whose `contextSnapshot` carries no `issueId` —
which is every **autonomous** run, because such a run selects its issue *after* dispatch. L2 is
the backstop that catches exactly that case, because the autonomous holder's checkout did set the
column.

**L1 excludes concurrency; it does not decide that the arriving wake is redundant.** Those were the
same thing until PEN-6407, which measured the difference: cancelling assumes the incumbent covers
the arrival, and across wake classes it does not. An `issue_commented` run does not do the work of a
`github_pr_review_requested` delivery, because an issue-local wake has a successor that re-reads the
whole row while a GitHub webhook fires **once** per push or review request. So a `github_*` arrival
landing on a non-github incumbent is now **deferred** — left `queued`, picked up when the incumbent
finishes — rather than cancelled. Concurrency is still excluded either way; only the arrival's fate
differs. (Same asymmetry `isStaleMaintenanceSweepCandidate` encodes for the stale-queued sweep,
BLO-35488.)

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

No, and five independent mechanisms are why. This is worth knowing before proposing a control
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
   bounded by the promotion path (`requiresIssueExecutionRetryLock`), not by a clock — a handoff,
   not a gap, but it is the one holder state where "6h and it releases" is the wrong mental model.
   Mechanism 5 is what makes that handoff a bound rather than a promise; mechanism 4 can end it
   sooner, but is an event rather than a bound.
4. **A never-started holder is reaped regardless of reason.**
   `ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES` (`issue-execution-lock.ts`) is
   `["queued", "scheduled_retry"]`, and `issues.checkout()` cancels and adopts such a row **while
   `startedAt` is null** — independent of the sweep and independent of `scheduledRetryReason`. So
   a continuous-lock reason does not protect a holder that never ran.

   **Do not read that as "started holders take the handoff in 3 and never-started ones take this".
   There is no started population here.** All four writers that park a run *insert* a fresh row and
   none of them sets `startedAt` (verified at each of the four sites), so **every** continuous-lock
   `scheduled_retry` holder is never-started and therefore reapable by `checkout()`. The real split
   between 4 and 5 is not the holder's state but **which event arrives first**: a checkout adoption
   (4) or the due time reaching the promotion gate (5).

   Mechanism 4 is accordingly **event-driven, not a bound** — nothing schedules it. It fires only
   when a live `running` actor checks the issue out (`actorLive`) and no active external runtime
   reservation is held (`issues.ts`, search `hasActiveExternalRuntimeReservation`). If no such
   checkout ever happens, 4 never fires and 5 is the only thing that ends the hold.

   Note also what 4 *does* when it fires on this population: it **cancels a
   `max_turns_continuation` park**. That is precisely the "clearing it would destroy the
   continuation" outcome BLO-19848 kept out of the age sweep, reached here by a different door. It
   is a deliberate trade-off in favour of the live claimant, not a protection — do not cite
   mechanism 4 as evidence that continuations are safe.
5. **A refused promotion releases the lock.** This is the actual bound, and it is the mechanism
   the "promotion owns the lifecycle" wording hides. When the promotion gate declines —
   `issue_not_found`, assignee mismatch, `issue_cancelled`, `issue_terminal_status`,
   `issue_not_in_progress`, or `issue_execution_lock_changed` — the gate sets the run `cancelled`
   **and** nulls `executionRunId`, `executionAgentNameKey` and `executionLockedAt`, guarded by
   `eq(issues.executionRunId, cancelled.id)`. A gate refusal
   therefore cannot strand the column; the two outcomes are "promoted, lock legitimately retained"
   and "cancelled, lock cleared".

   **"In the same transaction" is true of only one of the two paths — say which.**
   `gate_suppressed` returns **nine** hits in `heartbeat.ts`, spanning two different release
   mechanisms, so "the `gate_suppressed` branch" is not a single thing:
   - The **in-transaction gate** inside the atomic promotion does cancel and clear in one
     `db.transaction`.
   - The **earlier** `gate_suppressed` returns — agent missing, an `evaluateScheduledRetryGate`
     refusal such as `issue_execution_lock_changed`, and `timer_no_actionable_work` — route
     through `cancelScheduledRetryForGate`, which issues the cancel and the lock clear as
     **separate `db` statements with no enclosing transaction**.

   A crash between those two statements therefore leaves a holder — but a **terminal** one
   (`cancelled`), which mechanisms 1 and 2 release on their own schedule. So "cannot strand" holds
   for both paths; "atomically" holds for only the first.

   **The residual that closes:** the only remaining unbounded shape would be a continuous-lock
   holder whose promotion sweep never selects it, since that sweep selects on
   `lte(heartbeatRuns.scheduledRetryAt, now)` — which a NULL never satisfies. It is not reachable.
   All four writers that park a run into `scheduled_retry` stamp a non-null `scheduledRetryAt` at
   insert, so every park carries a concrete due time and every holder eventually reaches the gate
   in 5. Grepping `status: "scheduled_retry"` returns **seven** sites, not four — the inserts are
   `heartbeat.ts` ×3 and `recovery/service.ts` ×1; the other three are a type union and a `SELECT`
   re-tag in `issues.ts` plus a comment in `queued-run-age-metrics.ts`. Nothing writes
   `scheduledRetryAt: null` to the database at all: all five hits for that literal are in-memory
   return shapes.

   This is the population BLO-20983 stranded for ~4 days, so the claim is worth checking rather
   than trusting: that incident's cause was the **basis** `isPreClaimLockExpired` measured from,
   fixed in BLO-21309 by re-basing on `lockedAt`, not an absence of mechanism 5.

A related but separate defect is that `executionAgentNameKey` can go stale against a fresh
`executionRunId` (PEN-5351). That misattributes the holder's **name**, which is a legibility
problem (PEN-5342), not an exclusion problem: every layer above compares **run ids**, never names.
A control keyed on `executionRunId` therefore does not depend on PEN-5351 landing.

## How often this fires

`paperclip_heartbeat_duplicate_dispatch_suppressed_total` — L1's landed cancels, 376–648/day on
seven consecutive days (2026-10-27 → 2026-11-02), mean ≈499/day. Read its own help text before
quoting it: it is unlabelled, and it mixes benign same-tick wake dedupes with genuine
stale-running losses, so it is not an alertable signal.

⚠️ **Those figures predate PEN-6407 and are not comparable across it.** The cross-class population
no longer reaches this counter at all — it is deferred, and reported as
`paperclip_queued_run_claim_refused_total{arm="duplicate_dispatch_cross_reason_deferred"}`. Expect a
step DOWN in the counter above on the deploy; that is the fix landing, not the gate breaking. Scale,
measured over `heartbeat_runs` before the change: of the `github_*` wakes cancelled here, **33 of 47**
classifiable kills on 2026-11-10 and **22 of 23** on 2026-11-06 had a non-github incumbent.

The split is also the start of the separation this section asks for. It does **not** finish it: the
residual `_suppressed` counter still mixes same-class benign dedupes with same-class stale-running
losses, and only the *cross-class* population has been pulled out. ⛔ Do not read a non-zero
`cross_reason_deferred` rate as a fault — a deferral is the correct outcome, and the arm is the
measure of how often the old cancel's premise was wrong.

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
