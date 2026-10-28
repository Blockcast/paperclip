/**
 * PEN-4420: the deliberate park's RELEASE edge.
 *
 * `parked_until` (BLO-27912 / migration 0222) is read on the wake path in three places,
 * and all of them read it to SUPPRESS. Each defers to `isDeliberateParkActive` below;
 * this list is the registry, so a fourth suppression site belongs here too:
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
 *    survives re-parking is not a complete record of fires.
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
 * ⇒ `null` means "no release wake is owed for this row's current park". To ask whether
 * park wakes FIRED, read `agent_wakeup_requests` — exposed as
 * `GET /api/issues/:id/diagnostics/wakes`, which is durable, per-event and paginable.
 * Note that a park-expiry wake is NOT emitted to `GET /api/companies/:id/activity` at all,
 * unlike `issue.monitor_triggered` / `_scheduled` / `_cleared`, so the activity feed is
 * not a substitute either.
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
