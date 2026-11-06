/**
 * PEN-4420: the deliberate park's RELEASE edge.
 *
 * `parked_until` (BLO-27912 / migration 0222) is read in six places, and every one of them
 * reads it to WITHHOLD something while the park is live — five by suppressing outright, the
 * sixth (PEN-5776) by deferring to the deadline instead, which is a weaker claim and is
 * called out on its own entry. Five defer to `isDeliberateParkActive` below; the sixth reads
 * the same two columns directly, as an interval. This list is the registry, so a seventh
 * site belongs here too:
 *
 *  - `hasLiveDeliberatePark` (`routes/github-webhook.ts`) — a live park suppresses
 *    `github_check_*` wakes (PEN-4114).
 *  - `hasActiveParkedDisposition` (`services/recovery/issue-graph-liveness.ts`) — a live
 *    park is the seventh explicit waiting path, so the strandedness invariants stop
 *    firing against the row.
 *  - the strandedness DISPATCH sweep's candidate filter
 *    (`runStrandedAssignedIssueSweep`, `services/recovery/service.ts`) — a live park
 *    keeps the row out of the re-dispatch population (PEN-4871). This one was missing
 *    until PEN-4871: the row above stopped being FLAGGED as stranded and went on being
 *    WOKEN anyway, ~9 minutes after every park, at full agent-session cost.
 *  - `hasLiveDeliberateParkWakePath` (`services/issues.ts`) — the blocker-attention walk's
 *    `in_review` arm (PEN-5021). The odd one out: it suppresses a false `stalled`
 *    CLASSIFICATION rather than a wake, so a blocker deliberately stood down stops minting
 *    a `severity: "high"` attention item. Listed because this registry is of park READERS,
 *    and that caller existed while the sentence above still read "three places" — the exact
 *    drift this list exists to prevent, reproduced on the list itself.
 *  - `deliberateParkWindow` (`services/productivity-review.ts`) — the `long_active_duration`
 *    trigger (PEN-4522, #3316, merged 2026-11-03T09:39Z). The second odd one out, and why the
 *    sentence above no longer says every reader defers to the boolean: this one needs a START
 *    as well as an end, so it reads `parkedAt`/`parkedUntil` itself and suppresses by
 *    SUBTRACTING `[parkedAt, min(parkedUntil, now)]` out of `unattendedMs` rather than by
 *    returning early. It calls `isDeliberateParkActive` too, but only to render the `live`
 *    clause of its evidence. It landed the same morning this list was corrected from three to
 *    four, and was missed — see the retraction below, which is that same error a second time.
 *
 *  - `wakeDeferredToParkExpiry` (`routes/issues.ts`) — the assignee wakes on
 *    `PATCH /api/issues/:id` (PEN-5776): the `issue_status_changed` arm AND the `reopened`
 *    branch of the comment arm. It governs both because one PATCH can carry a status
 *    change, a comment and a park together, both arms then evaluate, and `addWakeup`
 *    collects per agent — so a term on one arm alone suppresses nothing on that write.
 *    The plain `issue_commented` wake is deliberately left un-gated.
 *
 *    The gap the section below used to describe as open. The odd one out in the other
 *    direction: it is the only reader that is a DEFERRAL rather than a suppression,
 *    because it conjoins `isIssueParkExpiryWakeStatus(issue.status)` so the wake it drops
 *    is always one this module will fire at the deadline instead. Without that conjunct
 *    it would strand a `backlog` -> `blocked` park, which is the failure mode the
 *    `recovery/service.ts` entry above warns about on the lapsed-park axis.
 *
 * Nothing read it to RELEASE. `parked_until` passing produced no event on any status, so
 * a parked row whose only wake was the park itself sat inert indefinitely. The park had a
 * brake and no accelerator.
 *
 * ⚠️ This is the COMPLEMENT of PEN-4114, not a correction of it. Parked rows never woke at
 * expiry before PEN-4114 either; what that change did was make the silence deliberate and
 * guaranteed rather than accidental and unreliable. Suppression while the park is LIVE is
 * unchanged by this module and must stay that way.
 *
 * ## The API transitions where a live park WAS not read (PEN-5291, closed by PEN-5776)
 *
 * ✅ CLOSED 2026-11-06 for the `PATCH /api/issues/:id` assignee wakes — BOTH the
 * `issue_status_changed` arm and the `reopened` branch of the comment arm, which had to move
 * together: one PATCH can carry a status change, a comment and a park at once, both arms
 * then evaluate, and `addWakeup` collects per agent, so a term on one arm alone would have
 * suppressed nothing on exactly the write shape PEN-4363 measured.
 *
 * ⚠️ Scope of that CLOSED, stated so it is not read wider than it is. The plain
 * `issue_commented` wake (no reopen) is deliberately NOT park-gated: a human joining the
 * thread of a parked row is a conversation, not a resume. And the deferral is conditional on
 * the POST-UPDATE status, so WHICH transition you are on still decides whether the wake
 * survives — see below. Every other wake producer in this codebase is its own question; this
 * section closes one route, not the family.
 *
 * Three status-change flags in `PATCH /api/issues/:id` share ONE
 * `addWakeup(... reason: "issue_status_changed")` call (`routes/issues.ts`), and that call
 * carried NO park term — not at the guard, not in `dispatchIssueWakeups`, not in
 * `services/heartbeat.ts`. A park can be set on any status, so on all three a parked row KEPT
 * its park and was dispatched about a second later:
 *
 *  - `statusChangedFromBlockedToTodo` — `blocked` -> `todo`, by explicit status or `reopened`.
 *  - `statusChangedFromBacklog` — `backlog` -> ANY other status, not only `todo`.
 *  - `statusChangedFromClosedToTodo` — `done`/`cancelled` -> `todo`.
 *
 * Only the first is MEASURED (below). The other two are read from source — same call site,
 * same missing term — and carry no telemetry here; do not cite them as observed.
 *
 * PEN-5776 measured the third on PEN-4363: a reopen that set `parkedUntil` 5 h 43 m out in
 * the SAME write was followed by a dispatch of the same seat Δ = 1.099 s later, which took
 * the row to `in_progress` and so retired the disposition the park expressed. The fix defers
 * that wake to the deadline — but ONLY where the deadline fires, i.e. where the post-update
 * status is in `ISSUE_PARK_EXPIRY_WAKE_STATUSES`. `statusChangedFromBacklog` is the flag that
 * can leave that set (`backlog` -> `blocked`, `done`, `cancelled`), and on those targets the
 * wake still fires, because deferring to a deadline that is excluded from this sweep would be
 * a strand rather than a deferral. The asymmetry between the two hand transitions out of
 * `blocked`, described below, is therefore UNCHANGED by PEN-5776 on the `-> in_progress` side
 * and changed on the `-> todo` side only when a park is live: the double wake that section
 * describes ("two wakes, one intent") is now a single wake at the deadline.
 *
 * ### The two hand transitions out of `blocked` behave OPPOSITELY
 *
 * The list above is exhaustive, and that is the point: `blocked` -> `in_progress` matches
 * NONE of the three flags (`statusChangedFromBlockedToTodo` requires `issue.status === "todo"`
 * literally), and on a status-only PATCH no other branch covers it either — the sibling
 * `issue_assigned` arm needs an assignee change, and `buildExecutionStageWakeup` keys on
 * execution state rather than status. Both targets are wake statuses below, so:
 *
 *  - -> `todo`: woken at the transition (~1 s, measured above) AND again at the deadline,
 *    because the PATCH leaves the park live. Two wakes from one intent.
 *  - -> `in_progress`: silent at the transition, woken once at the deadline.
 *
 * Nothing in the API surfaces that difference. Which one to prefer is CONDITIONAL, though,
 * and the condition is the caveat below: `in_progress` buys one wake instead of two at the
 * cost of starting an un-suppressed `long_active_duration` clock.
 *
 * ⚠️ RETRACTED 2026-11-03, and the retraction is the part worth reading. An earlier revision
 * of this block asserted that `services/productivity-review.ts` "contains no reference to
 * `parked_until` or `isDeliberateParkActive` at all", and concluded from that a hand-parked
 * `in_progress` row accrues the whole park as unattended. BOTH are false at `master`
 * `ab43454`: that file imports `isDeliberateParkActive` from THIS module (:39) and reads both
 * park columns in `deliberateParkWindow` (:1364). The grep was run against this PR's own
 * branch at `9488baa`, which was behind `master` — #3316 had merged ~2.5 h earlier. Verify a
 * negative against the DEFAULT branch, never the branch under review: a "no hits" result is
 * only as current as the tree you ran it on, and it fails in the confident direction.
 *
 * ⚠️ The stale tree is only ONE of the two axes, and the second one bites in this same file,
 * on this same flag, at a perfectly current `master`. At `ab43454`,
 * `grep -c productivityReviewDisabled server/src/services/productivity-review.ts` returns 0 —
 * literally correct, and still the wrong conclusion. The key is never spelled in that file:
 * it is read inside `isProductivityReviewOptedOut`
 * (`packages/shared/src/types/issue.ts:781`, `record.productivityReviewDisabled === true`),
 * which `productivity-review.ts` imports at `:6` under the alias
 * `isPolicyProductivityReviewOptedOut`, wraps at `:5869-5870`, and applies at `:7118` and
 * `:6675`. ⇒ a literal-identifier grep is only as good as THE NAME AT THE USE SITE. An
 * encapsulating predicate and an aliased import of it each break the string while leaving the
 * behaviour exactly where you were looking for it. Grep the exported predicate and follow its
 * importers, or ask the type system; never conclude absence from the field name alone.
 * (Second axis found by @Devops on PEN-5141, 2026-11-03; re-verified here against `ab43454`.)
 *
 * What is actually true, and it removes the trade-off rather than resolving it:
 *
 *  - `deliberateParkWindow` covers `[parkedAt, min(parkedUntil, now)]`
 *    (`productivity-review.ts:1364`); that span becomes its own `parkedMs` bucket; and
 *    `unattendedMs` is computed net of it (:1466). The `long_active_duration` arm compares
 *    exactly that — `monitorGating.unattendedMs < thresholds.longActiveMs` (:5696). The rule
 *    the source states: the trigger fires on the time NOBODY was accounting for, and a
 *    deliberate park is somebody accounting for it.
 *  - `in_progress` does still RE-STAMP `issues.started_at` (`applyStatusSideEffects`,
 *    `services/issues.ts`; a status-only PATCH leaves `patch.startedAt` unset and takes
 *    `new Date()`). That half stands. It is simply no longer an exposure, because the park
 *    is netted out of the comparison the restarted clock feeds.
 *
 * ⇒ prefer `in_progress` for this technique without condition: one wake at the deadline
 * instead of two, and no productivity-review cost. The earlier "only if the row keeps its
 * holder, or the park is short" proviso was an artefact of the false premise and is withdrawn
 * with it.
 *
 * Three limits of the suppression, all deliberate, all pinned in `deliberateParkWindow`'s own
 * docblock:
 *
 *  - It covers `parkedAt` FORWARD, and the CURRENT park only. `parkedDisposition` restamps
 *    `parkedAt` on every arm, so EXTENDING a park returns the superseded span to
 *    `unattendedMs`. Do not "fix" that by carrying the earliest `parkedAt` forward — it would
 *    let a row chain short parks into unbounded suppression.
 *  - It requires BOTH columns and fails closed without them.
 *  - It is BOUNDED: the bucket stops growing at `min(parkedUntil, now)`, so a park whose wake
 *    never arrives surfaces as a productivity review on its own roughly 6 h later. That is a
 *    backstop for the technique above, not a defect — a dropped park wake is not silent.
 *
 * ⛔ Do NOT reach for `executionPolicy.productivityReviewDisabled` here, and do not read the
 * line above as a reason to. It is unnecessary given the netting, and it is not a narrowing of
 * one trigger: `isProductivityReviewOptedOut` (`packages/shared`) gates the candidate loop in
 * `productivity-review.ts`, which counts the row `optedOut` and `continue`s before evidence is
 * collected, and retires any in-flight review as `unreviewable_source`. It removes the row from
 * productivity review ENTIRELY — and in its top-level spelling it is durable, so it outlives
 * the park it was set for. The park is bounded; that flag is not.
 *
 * The `blocked` arm is the one the exclusion below depends on, because that is not how a row
 * normally reaches `todo`, and conflating the two writers is the trap.
 * `stranded-blocked-issue-reconciler.ts` flips with a bare `UPDATE` and enqueues nothing, so
 * a reconciler-drained row lands on `todo` silently, is held there by the dispatch sweep's
 * filter above, and fires once at its deadline — which is exactly the behaviour the `blocked`
 * exclusion in `ISSUE_PARK_EXPIRY_WAKE_STATUSES` below assumes and depends on.
 *
 * Measured 2026-11-03 on PEN-5159 — one row, one live park (`2026-11-04T12:00Z`), both writers
 * within six hours, read from a complete `agent_wakeup_requests` history (16 events, neither
 * the 50-request cap nor the 14-day lookback binding):
 *
 *  - reconciler flip at 02:30:29.412Z → NO wake request of any kind;
 *  - manual PATCH flip at 06:29:11.676Z → wake request 06:29:13.311Z, run claimed 06:29:18.
 *
 * Generalise neither half. "A live park suppresses dispatch" is false for these API
 * transitions; "a park is only a timer, never a suppressor" is false for the four readers
 * above, and that reading is what turned the correct measurement into a proposal to stop
 * draining rows at all. The cost is bounded — one run per transition, after which the
 * dispatch filter resumes holding the row — so it is recorded here rather than closed by
 * suppressing a wake that an operator moving a row by hand may well have intended.
 *
 * ## Why this is not a monitor
 *
 * A monitor is a POLL and carries the BLO-18294 convergence guard, which exists to stop
 * agents polling human gates. A park is a DEADLINE: one-shot by construction, so it cannot
 * converge and has nothing for that guard to measure. Routing park expiry through monitor
 * machinery would reintroduce exactly the stall that made six owners decline to re-arm a
 * monitor and park instead — and on `todo`/`backlog` a monitor cannot be armed at all
 * (`422 Monitor can only be scheduled on issues assigned to an agent in in_progress or
 * in_review`), which is why the park is the only primitive that exists on every status.
 *
 * ## Why this is not a review path
 *
 * The wake changes no status. It lands the row back where its CURRENT status rules apply,
 * which on `in_review` means `assertAgentInReviewReviewPath` applies again — the stated
 * intent of BLO-33572's refusal, which says admitting a live park as a review path would
 * "merely defer this same refusal to the park's deadline". This module is what makes that
 * deferral actually occur. The two compose; neither is weakened.
 *
 * ## `parkedWakeFiredAt` is a CLAIM, not an audit record (PEN-4894)
 *
 * The column exists to make the release edge fire exactly once per park. It is not, and
 * cannot be read as, a record of which parks woke:
 *
 *  - the park writer resets it to `null` on every `parkedDisposition` write, so a re-park
 *    erases it — and a park wake that WORKS dispatches a run which routinely re-parks the
 *    row, so the field systematically deletes its own positive cases;
 *  - the sweep rolls it back to `null` when `enqueueWakeup` throws, so even a stamp that
 *    survives re-parking is not a complete record of fires;
 *  - and the column errs in the OTHER direction too, which neither bullet above covers: a
 *    `null` RETURN from `enqueueWakeup` is a suppression, not a throw, and the sweep
 *    deliberately does not roll the claim back ("the edge fired; the platform declined it",
 *    `tickExpiredIssueParks`). A stamp that IS present therefore means the sweep claimed the
 *    park and attempted an enqueue — never that any run was woken.
 *
 * Measured 2026-10-28 on seven rows parked to one shared instant: 7 of 7 fired, between
 * +30.5 s and +75.4 s after the deadline (inside the historical park-fire band), and 7 of
 * 7 read `parkedWakeFiredAt = null` 45 minutes later, every one re-parked in between.
 * Across a 4,361-row census the discriminator was the re-park and not the wake outcome:
 * fired then re-parked ⇒ `null` 7/7, fired and never re-parked ⇒ present 12/12.
 *
 * ⚠️ The failure is in the REASSURING direction and gets worse as this module gets more
 * reliable, which is what made it expensive to find (three days and four monitor attempts
 * on PEN-4198 before a positive control caught it).
 *
 * The over-report has its own measurement, 2026-11-03 (PEN-5291), over the three rows the
 * sweep stamped in one millisecond, `2026-11-02T09:00:23.252Z`. All three read as fired on
 * this column and NONE of them is recorded as having woken a run:
 *
 *  - PEN-4793 — `issue_park_expired` at 09:00:57.960Z, `status: "skipped"`, `claimedAt: null`;
 *  - PEN-3233 — stamped, and NO `issue_park_expired` request exists at all. What the enqueue
 *    recorded is `issue_dependencies_blocked` at 09:01:32.665Z, `cancelled`, `claimedAt: null`;
 *  - PEN-4828 — a `reason: "other"` request at 09:00:28.317Z, and a monitor was due at the
 *    same instant, so it is unattributable in either direction.
 *
 * Both diagnostics reads were complete windows (`truncated: false`), so these are absences of
 * the event and not of the evidence. PEN-3233 is the sharp one, and it is a trap on the
 * REPLACEMENT surface rather than on this column: a claimed park can enqueue under a
 * different reason, so "no `issue_park_expired` row" does not imply "the sweep never claimed
 * this park". Pair the row with a control parked to the same millisecond before reading
 * either surface's silence as a down sweep.
 *
 * ⇒ `null` means "no release wake is owed for this row's current park". To ask whether
 * park wakes FIRED, read the `agent_wakeup_requests` TABLE, which is the durable
 * per-event record. `GET /api/issues/:id/diagnostics/wakes` serves it, but as a BOUNDED
 * view: the route passes no options, so both ceilings bind and a caller cannot raise
 * them — at most `ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS` (50) requests, within
 * `ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS` (14) days, and there is no offset or cursor to
 * page past either. Read `caps` and `truncatedSections.wakeRequests` off the response
 * before reading an absence as a negative; on a busy row, or a park older than the
 * lookback, empty means "outside the window", which is this module's own trap relocated
 * to the replacement surface.
 *
 * Note also that a park-expiry wake is NOT emitted to `GET /api/companies/:id/activity`
 * at all, unlike `issue.monitor_triggered` / `_scheduled` / `_cleared`, so the activity
 * feed is not a substitute either.
 *
 * Operator-facing version of all of the above, including the three meanings of `null` and
 * why preserving the stamp was declined: `runbooks/deliberate-park-release-edge.md`. That
 * file is the single source of truth; the other code sites point at it rather than
 * restating it, so the account cannot drift between five copies.
 */

/**
 * The wake reason stamped on a park-expiry wake, in both `agent_wakeup_requests.reason`
 * and `heartbeat_runs.context_wake_reason`.
 *
 * Distinct from every monitor reason on purpose: an operator asking "why did this agent
 * wake?" must be able to tell a deadline that elapsed from a gate that was polled, and
 * `issue_monitor_due` would conflate them.
 */
export const ISSUE_PARK_EXPIRED_WAKE_REASON = "issue_park_expired";

/**
 * The statuses on which an expired park fires its release wake.
 *
 * `todo` and `backlog` are the two that make this worth building: no monitor can be armed
 * there, so before this module they had no self-resume primitive at all.
 *
 * Two deliberate exclusions:
 *
 *  - **`done` / `cancelled`.** Waking a closed row is the BLO-23206 shape — a wake that
 *    revives work somebody finished. A park outliving the work it was protecting is
 *    ordinary (the row got closed before its deadline), and the correct response is to let
 *    the park lapse unremarked.
 *  - **`blocked`.** Not an oversight: a blocked row's next action belongs to its blocker,
 *    and the deadline passing does not resolve one. Its wake path is
 *    `issue_blockers_resolved` / `issue_blockers_resolved_sweep`, and a `blocked` row with
 *    no unresolved blocker is drained to `todo` by the stranded-blocked reconciler — after
 *    which this sweep covers it on `todo`. Waking the assignee of a genuinely blocked row
 *    on a timer is the poll this module exists to avoid being.
 *
 *    PEN-5291: that drain is CONDITIONAL, and the sentence above read as unconditional is
 *    what turned correct behaviour into a filed high-priority defect.
 *    `listBlockedIssueAutoResumeSuppressions` keeps a row `blocked` despite zero unresolved
 *    blockers for any reason in `BlockedIssueAutoResumeSuppressionReason` (`issues.ts`) —
 *    that union is the authoritative list and it GROWS (`external_wait` was a later
 *    addition, BLO-30445), so read the type rather than any prose enumeration of it,
 *    including this one. Such a row gets NEITHER the drain NOR this sweep, so its park
 *    lapses having fired nothing — by design, not by breakage.
 *
 *    Do NOT read that as "suppressed, therefore attended". The reasons do not share a wake
 *    path and only some carry one, so the inverse misdiagnosis — calling a genuinely dark
 *    row "by design" — is as available here as the one this note exists to stop. Classify
 *    before concluding:
 *
 *      - `pending_interaction` / `pending_approval` — the shape all 5 measured rows took,
 *        and the only shape the "a human answer is the wake" argument covers. Deciding an
 *        approval wakes the requester (`requesterWakeActorType`, `approval-resolution.ts`).
 *        An interaction wakes the assignee ONLY at `continuationPolicy` `wake_assignee` /
 *        `wake_assignee_on_accept` (`queueResolvedInteractionContinuationWakeup`,
 *        `routes/issues.ts`). Every kind prefaults to `wake_assignee` since PEN-5505
 *        (`request_confirmation` alone used to prefault to `none`), so an ANSWERED card
 *        now does wake the assignee, and there a timer wake adds nothing a human answer
 *        does not. An EXPIRED one wakes nobody under ANY policy — that function bails on
 *        `status === "expired"` whatever the policy said — so a card killed by
 *        `supersedeOnUserComment`, which also prefaults true, leaves the row dark exactly
 *        as this note warns. Check which of the two happened before concluding.
 *      - `convergence_stalled` — the opposite case, and the one to be most careful with.
 *        The assignee is barred from re-arming its own stalled monitor
 *        (`MONITOR_CONVERGENCE_RESET_REQUIRES_NON_ASSIGNEE_MESSAGE`,
 *        `issue-execution-policy.ts`), so nothing the assignee can do re-enters the row: it
 *        needs a non-assignee actor, and no human decision is pending to supply one.
 *      - everything else — check the wake path per reason before calling the row attended.
 *        Some carry one structurally: `monitor_gate` suppresses only while a live armed
 *        monitor passes `hasValidBlockerMonitor`, and `active_recovery_action` suppresses on
 *        `active` alone, with `escalated` deliberately excluded as wake-exhausted
 *        (`BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES`, BLO-21523). Others
 *        (`workspace_preflight_blocked`, `external_wait`) are waits on an operator with no
 *        timer behind them.
 *
 *    Measured 2026-11-02: 5 such rows, each behind an unanswered card 0.6-7.3 d old, while
 *    the reconciler was demonstrably live — it flipped PEN-5217 at 13:15:27Z the same day.
 *    So do NOT infer from an undrained row that the reconciler is wedged; read
 *    `issue.stranded_blocked_reconciled` in `activity_log` before concluding that.
 *
 *    The exclusion itself was re-measured 2026-11-03 against a pre-registered prediction,
 *    on three rows parked to the same millisecond, `09:00:00.000Z`: PEN-4828 and PEN-5291
 *    (both `in_progress`) each stamped AND delivered an `issue_park_expired` wake that a run
 *    claimed (09:03:33.037Z, 09:06:47.010Z), while PEN-4554 — `blocked`, zero unresolved
 *    blockers, held by a pending interaction — stamped nothing and enqueued no wake request
 *    of ANY reason. Its activity log carries no status change between 2026-10-25T13:06:35Z
 *    and 09:04:19Z, so it was `blocked` at the anchor rather than drained before it. That
 *    pairing is the same-millisecond control the down-sweep test above calls for.
 *
 *    ⇒ To classify a row you need the suppression REASON, and it is computed per sweep and
 *    never stored, so no issue field carries it. `paperclipInboxLite` projects
 *    `unresolvedBlockerCount` and nothing about the hold, which makes a correctly-held row
 *    byte-identical to a dark one on the surface an agent reads every heartbeat — that
 *    projection, not the drain, is how this behaviour came to be filed as a high-priority
 *    defect. The surface that DOES name the hold is the blocked inbox:
 *    `GET /api/companies/:id/issues?attention=blocked&includeBlockedInboxAttention=true`,
 *    whose `blockedInboxAttention` carries a `reason`, an `owner`/`action` pair, and the
 *    identifier of the thing being waited on (`approvalId`, `interactionId`,
 *    `overdueInteractionId`). Measured 2026-11-03 across that inbox's 81 rows, it resolved
 *    all five: PEN-5122/5137/5141 `pending_board_decision` each carrying its live
 *    `approvalId`, PEN-2208 `blocked_chain_stalled` carrying `overdueInteractionId`
 *    `e3934a88` (open since 2026-10-24), and PEN-4554 held by interaction `1c293b07` — which
 *    was withdrawn at 09:04:15.554Z, four seconds before its assignee closed the row.
 *
 *    Two limits on that surface, both load-bearing. It pages by OFFSET with no truncation
 *    flag, so a single page is not the population — PEN-5122 sat on page 2 and was absent
 *    from the first 60 rows, which reads exactly like "not held". And its `reason` is its
 *    own vocabulary, NOT `BlockedIssueAutoResumeSuppressionReason`: `blocked_chain_stalled`
 *    is not a member of that union. Use it to find the hold and its id, then confirm the
 *    suppression against the union; do not map the two by name.
 */
export const ISSUE_PARK_EXPIRY_WAKE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
] as const;

export type IssueParkExpiryWakeStatus = (typeof ISSUE_PARK_EXPIRY_WAKE_STATUSES)[number];

export function isIssueParkExpiryWakeStatus(status: string | null | undefined): boolean {
  return ISSUE_PARK_EXPIRY_WAKE_STATUSES.includes(status as IssueParkExpiryWakeStatus);
}

/**
 * Scoped to the individual PARK, not to the issue: `parkedAt` is restamped by the writer
 * on every `parkedDisposition` write, so a row that is parked, woken at expiry, and parked
 * again gets a fresh key and fires again. An issue-scoped key would make the release edge
 * one-shot per row for all time, which is a silent regression of exactly the shape this
 * module fixes.
 */
export function buildIssueParkExpiredWakeIdempotencyKey(input: {
  issueId: string;
  parkedAt: Date | string | null;
}): string {
  const parkedAt = input.parkedAt instanceof Date
    ? input.parkedAt.toISOString()
    : input.parkedAt ?? "unknown";
  return [ISSUE_PARK_EXPIRED_WAKE_REASON, input.issueId, parkedAt].join(":");
}

export interface IssueParkReleaseInput {
  status: string | null | undefined;
  parkedUntil: Date | string | null | undefined;
  parkedAt: Date | string | null | undefined;
  parkedWakeFiredAt: Date | string | null | undefined;
  assigneeAgentId: string | null | undefined;
  assigneeUserId: string | null | undefined;
}

function readMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is a deliberate park in force on this row right now?
 *
 * PEN-4871: the single owner of the live-park reading. Every path that SUPPRESSES on a
 * park defers to this function; none of them restates it.
 *
 * It did not start that way. The predicate was hand-copied into three places —
 * `hasActiveParkedDisposition` (`services/recovery/issue-graph-liveness.ts`),
 * `hasLiveDeliberatePark` (`routes/github-webhook.ts`) and, by its absence, the
 * strandedness dispatch sweep — each with a comment asking the next author to keep them in
 * step. That is the arrangement BLO-22660 already recorded failing on this exact column:
 * *"That pair of producers had already drifted once on `parkedUntil` (BLO-27912) and the
 * comment asking the next author to keep them in step did not prevent this one; a required
 * key does."* The third site did not drift so much as never exist, which is the same defect
 * with a cheaper disguise — nothing fails when a copy is simply missing.
 *
 * Keyed on the deadline alone and compared with `> nowMs`, so expiry is the default: a park
 * nobody restates stops suppressing on its own, and un-parking (writing
 * `parkedDisposition: null`, which clears the column) takes effect immediately. The
 * mechanism cannot decay into permanent silence on a row that genuinely needs the wake.
 *
 * An unparseable or absent deadline reads as NOT parked — suppression must be something a
 * row earns, never something it falls into.
 */
export function isDeliberateParkActive(
  parkedUntil: Date | string | null | undefined,
  nowMs: number,
): boolean {
  const parkedUntilMs = readMs(parkedUntil);
  return parkedUntilMs !== null && parkedUntilMs > nowMs;
}

/**
 * Does this row's park owe a release wake right now?
 *
 * This is the authoritative statement of the sweep's predicate. `tickExpiredIssueParks`
 * selects candidates with a SQL over-approximation of it, then re-checks each one with
 * THIS function before claiming — so the SQL only narrows the scan and this is the
 * decision, which is what keeps the two from drifting into disagreement the way two
 * hand-written copies of a predicate eventually do.
 *
 * Every conjunct is load-bearing:
 *
 *  - **a park exists and has lapsed.** `parkedUntil <= now` is the exact negation, for a
 *    row that is parked at all, of the live-park predicate PEN-4114 suppresses on. The two
 *    cannot both hold, which is what makes this additive rather than a weakening: a live
 *    park suppresses and fires nothing, a lapsed park fires once and suppresses nothing.
 *  - **the release wake has not already fired for THIS park.** `parkedWakeFiredAt` is the
 *    fire-once marker. `parkedWakeFiredAt < parkedAt` is an independent backstop against a
 *    writer that forgets to reset the marker on a re-park: it degrades that bug to a late
 *    wake instead of to permanent silence, which is the direction this whole row is about.
 *    Per-PARK, never per-row — see "`parkedWakeFiredAt` is a CLAIM" above before reading
 *    this column as a history of park wakes.
 *  - **the status still wants a wake.** See `ISSUE_PARK_EXPIRY_WAKE_STATUSES`.
 *  - **there is an agent to wake.** A human-assigned row has no agent target; `enqueueWakeup`
 *    takes an agent id, and a park on a `assigneeUserId` row is a note to a person, not a
 *    schedulable wake.
 */
export function issueParkOwesReleaseWake(
  issue: IssueParkReleaseInput,
  nowMs: number,
): boolean {
  if (!isIssueParkExpiryWakeStatus(issue.status)) return false;
  if (!issue.assigneeAgentId || issue.assigneeUserId) return false;

  // The exact negation of `isDeliberateParkActive`, written through it rather than beside
  // it so the "these two cannot both hold" claim above is enforced by construction. The
  // `=== null` arm is the separate "no park at all" case, which is neither live nor lapsed.
  if (readMs(issue.parkedUntil) === null) return false;
  if (isDeliberateParkActive(issue.parkedUntil, nowMs)) return false;

  const firedAtMs = readMs(issue.parkedWakeFiredAt);
  if (firedAtMs === null) return true;

  const parkedAtMs = readMs(issue.parkedAt);
  // A marker with no `parkedAt` to compare against is treated as fired. The four park
  // columns move together, so this shape means the park was cleared under a marker that
  // the writer then failed to reset -- and in that state there is no park whose deadline
  // could have lapsed, so firing would be a wake with nothing behind it.
  if (parkedAtMs === null) return false;
  return firedAtMs < parkedAtMs;
}
