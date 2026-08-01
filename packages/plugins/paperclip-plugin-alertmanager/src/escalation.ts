import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_COVER_DEDUP_WINDOW_MINUTES, DEFAULT_ESCALATION_DEADLINE_MINUTES, STATE_KEYS } from "./constants.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { ORIGIN_KIND, type AlertmanagerAlert, type AlertmanagerPluginConfig, type AlertStateRecord } from "./types.js";

/** Origin kind stamped on board-owned "chain exhausted" cover issues. */
export const COVER_ORIGIN = "plugin:paperclip-plugin-alertmanager:escalation";
const MAX_ATTEMPTS = 3;
const COVERS_TABLE = "alert_escalation_covers";
const MEMBERS_TABLE = "alert_escalation_cover_members";
const STUCK_COVER_RECONCILE_LIMIT = 200;

function q(ns: string, table: string): string {
  return `${ns}.${table}`;
}

export function escalationDeadlineMs(alert: AlertmanagerAlert, config: AlertmanagerPluginConfig): number | null {
  const severity = alert.labels.severity ?? "unknown";
  const minutes = resolveIssueRoute(alert, config.issueRouteMap).route?.escalationDeadlineMinutes
    ?? config.escalationDeadlineMinutes?.[severity]
    ?? DEFAULT_ESCALATION_DEADLINE_MINUTES[severity];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
}

/**
 * Interval between ladder rungs for an already-tracked alert. Prefers the
 * route/severity-resolved interval captured at firing time; state records
 * written before that field existed fall back to severity config.
 */
function rungIntervalMs(state: AlertStateRecord, config: AlertmanagerPluginConfig): number {
  if (typeof state.escalationIntervalMs === "number" && Number.isFinite(state.escalationIntervalMs) && state.escalationIntervalMs > 0) {
    return state.escalationIntervalMs;
  }
  const minutes = config.escalationDeadlineMinutes?.[state.severity]
    ?? DEFAULT_ESCALATION_DEADLINE_MINUTES[state.severity];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 60 * 60_000;
}

function holdUntil(comments: Array<{ body: string }>): number | null {
  let latest: number | null = null;
  for (const { body } of comments) {
    const value = /do not retry before\s+([^\n]+)/i.exec(body)?.[1]?.trim();
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed) && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

/**
 * Bucketed dedup key for the board-cover storm-batching invariant (BLO-15982):
 * concurrent ladders for the same alertname that reach the cover rung within
 * the same window bucket share one cover. Deliberately NOT a rolling window
 * — a fixed bucket is expressible as a DB unique-key equality, which is what
 * makes the create-or-attach race safe under concurrent workers (see
 * `createCover`). The tradeoff is a possible split right at a bucket
 * boundary; acceptable against "at most one cover per storm."
 */
function coverDedupFingerprint(alertname: string, windowMinutes: number, now: Date): string {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const bucket = Math.floor(now.getTime() / windowMs);
  return `cover:${alertname}:${bucket}`;
}

/** Matches the 409 the host throws when `issues_active_alert_escalation_cover_uq` rejects a create(). */
function isCoverDedupConflict(err: unknown): boolean {
  const message = err instanceof Error
    ? err.message
    : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);
  return message.includes("Alert escalation cover conflict");
}

/**
 * Idempotently upserts `alertIssueId` as an OPEN member of `coverIssueId`.
 * A brand-new pairing inserts a fresh row; a pairing that previously
 * resolved (the alert re-fired into the same still-open cover) reopens it.
 * Backed by the `(cover_issue_id, alert_issue_id)` unique constraint, so
 * concurrent callers racing the same pairing serialize at the DB and only
 * one of them observes `rowCount > 0` (used to gate the one-time
 * "sibling attached" comment — a retried attach is a silent no-op).
 */
async function upsertOpenMember(ctx: PluginContext, coverIssueId: string, alertIssueId: string): Promise<boolean> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `INSERT INTO ${q(ns, MEMBERS_TABLE)} (id, cover_issue_id, alert_issue_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (cover_issue_id, alert_issue_id)
     DO UPDATE SET resolved_at = NULL, updated_at = now()
     WHERE ${q(ns, MEMBERS_TABLE)}.resolved_at IS NOT NULL`,
    [randomUUID(), coverIssueId, alertIssueId],
  );
  return result.rowCount > 0;
}

/**
 * Creates (or joins) the board-owned "chain exhausted" cover for `issue`.
 *
 * Race safety has two independent layers:
 *  1. `originFingerprint` carries the alertname+window dedup key, backed by
 *     a partial unique index on the host (`issues_active_alert_escalation_cover_uq`).
 *     Two concurrent same-alertname ladders both calling `ctx.issues.create()`
 *     cannot both win the *issue* — the DB constraint, not a read-then-create
 *     check here, is the source of truth. The loser catches the 409 and
 *     joins the winner's cover instead of creating a duplicate.
 *  2. Membership in that cover (winner's own alert, plus every losing
 *     sibling) is a durable, race-safe row in `alert_escalation_cover_members`
 *     (BLO-16120) — not a free-form comment — so resolving any one member
 *     never has to guess whether siblings are still firing.
 */
async function createCover(
  ctx: PluginContext,
  issue: NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>,
  companyId: string,
  alertname: string,
  config: AlertmanagerPluginConfig,
  now: Date,
) {
  const ns = ctx.db.namespace;

  // Already an open member of a still-open cover? Reopen (in case this is a
  // re-fire racing the sweep) and stop — idempotent guard against a partial
  // failure earlier in this same sweep tick retrying from the top. Excludes
  // covers that already won the closing claim (`closing_claimed_at IS NOT
  // NULL`): those are mid-`closeCoverIfEligible`/`finalizeCoverCancellation`
  // (or sitting in the stuck-reconcile window) and about to cancel — silently
  // reopening membership there would let the cover finalize anyway (it only
  // re-checks the claim timestamps, not membership) and orphan this re-fire
  // from any cover. Falling through instead routes it into `createCover`'s
  // normal create-or-join path, which opens/joins a fresh cover (BLO-16120
  // PR #662 review).
  const already = await ctx.db.execute(
    `UPDATE ${q(ns, MEMBERS_TABLE)} AS m
     SET resolved_at = NULL, updated_at = now()
     FROM ${q(ns, COVERS_TABLE)} c
     WHERE m.cover_issue_id = c.cover_issue_id
       AND m.alert_issue_id = $1
       AND c.cancelled_at IS NULL
       AND c.closing_claimed_at IS NULL`,
    [issue.id],
  );
  if (already.rowCount > 0) return;

  const windowMinutes = config.coverDedupWindowMinutes ?? DEFAULT_COVER_DEDUP_WINDOW_MINUTES;
  const fingerprint = coverDedupFingerprint(alertname, windowMinutes, now);
  const members = await ctx.access.members.list({ companyId });
  const owner = members.find((member) => member.principalType === "user" && member.status === "active" && ["owner", "admin"].includes(member.membershipRole ?? ""));

  // At most 2 attempts: the second only fires if the conflicting cover
  // vanished (or already fully resolved) between our failed create and the
  // follow-up lookup — in that narrow race the dedup slot is free again.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = await ctx.issues.create({
        companyId,
        parentId: issue.id,
        projectId: issue.projectId ?? undefined,
        goalId: issue.goalId ?? undefined,
        title: `[user-cover] unresolved alert escalation: ${issue.identifier ?? issue.title}`,
        description: `Alert ${issue.identifier ?? issue.id} exhausted its agent chain while still firing. Board direction is required.`,
        status: "todo",
        priority: issue.priority,
        assigneeUserId: owner?.principalId ?? null,
        originKind: COVER_ORIGIN,
        originId: issue.id,
        originFingerprint: fingerprint,
      });
      await ctx.db.execute(
        `INSERT INTO ${q(ns, COVERS_TABLE)} (cover_issue_id, company_id, dedup_fingerprint)
         VALUES ($1, $2, $3)
         ON CONFLICT (cover_issue_id) DO NOTHING`,
        [created.id, companyId, fingerprint],
      );
      await upsertOpenMember(ctx, created.id, issue.id);
      return;
    } catch (err) {
      if (!isCoverDedupConflict(err)) throw err;
      const [retained] = await ctx.issues.list({ companyId, originKind: COVER_ORIGIN, originFingerprint: fingerprint, limit: 1 });
      if (!retained || retained.status === "done" || retained.status === "cancelled") continue;
      // Defensive upsert: makes the covers-row bootstrap convergent from
      // whichever caller reaches it first, even if the winner's own insert
      // above hasn't landed yet (or failed) when this loser runs.
      await ctx.db.execute(
        `INSERT INTO ${q(ns, COVERS_TABLE)} (cover_issue_id, company_id, dedup_fingerprint)
         VALUES ($1, $2, $3)
         ON CONFLICT (cover_issue_id) DO NOTHING`,
        [retained.id, companyId, fingerprint],
      );
      const attached = await upsertOpenMember(ctx, retained.id, issue.id);
      if (attached) {
        await ctx.issues.createComment(
          retained.id,
          `[alert-escalation] Sibling alert ${issue.identifier ?? issue.id} ("${alertname}") also exhausted its agent chain within the dedup window; tracked here instead of opening a duplicate cover.`,
          companyId,
        );
      }
      return;
    }
  }
}

/**
 * Attempts to close `coverIssueId` once every represented source alert has
 * resolved. The claim (who gets to run the resolution comment + terminal
 * transition) is a single atomic UPDATE of `closing_claimed_at`, guarded by
 * `NOT EXISTS (unresolved members)` — under concurrent callers (duplicate
 * resolve deliveries, two siblings resolving at once), Postgres row-level
 * locking on the covers row serializes the UPDATEs, so exactly one caller
 * observes `rowCount > 0`. Only that caller proceeds inline; every other
 * concurrent caller returns immediately rather than racing the winner
 * through `ctx.issues.update` — a second read-then-write "is it cancelled
 * yet" check there would reintroduce exactly the race this claim exists to
 * prevent. A winner that crashes before finishing relies on the sweep's
 * reconciliation pass (`reconcileStuckCovers`) to resume, not on another
 * concurrent resolve.
 *
 * `closing_claimed_at` is deliberately a separate column from
 * `resolution_comment_posted_at` (BLO-16120 PR #662 review): the claim must
 * be won before the comment is attempted (that's what makes it an exclusive
 * claim), but the comment isn't durably posted until `createComment`
 * resolves. Conflating the two into one flag set ahead of the fact it names
 * meant a `createComment` failure left the cover reading as "resolution
 * comment posted" when it never was, and nothing ever retried it.
 */
async function closeCoverIfEligible(ctx: PluginContext, companyId: string, coverIssueId: string): Promise<void> {
  const ns = ctx.db.namespace;
  const claim = await ctx.db.execute(
    `UPDATE ${q(ns, COVERS_TABLE)} AS c
     SET closing_claimed_at = now(), updated_at = now()
     WHERE c.cover_issue_id = $1
       AND c.closing_claimed_at IS NULL
       AND c.cancelled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${q(ns, MEMBERS_TABLE)} m
         WHERE m.cover_issue_id = c.cover_issue_id AND m.resolved_at IS NULL
       )`,
    [coverIssueId],
  );
  if (claim.rowCount === 0) return; // not yet eligible, or another caller already claimed it
  await finalizeCoverCancellation(ctx, companyId, coverIssueId);
}

/**
 * Completes the terminal transition for a cover that has already won the
 * closing claim (`closing_claimed_at` set). Called by the claim winner
 * inline, and by the sweep's `reconcileStuckCovers` pass when a prior winner
 * claimed but crashed (or failed) before finishing — never by a losing
 * concurrent caller, which avoids a second read-then-write "is it cancelled
 * yet" race here.
 *
 * Posts the resolution comment first if a prior attempt claimed but never
 * got it to land (`resolution_comment_posted_at` still null) — the flag is
 * only set once `createComment` actually resolves, so a `createComment`
 * failure here just leaves the claim intact for the next call to retry,
 * instead of silently finalizing with no audit trail.
 */
async function finalizeCoverCancellation(ctx: PluginContext, companyId: string, coverIssueId: string): Promise<void> {
  const ns = ctx.db.namespace;
  const [row] = await ctx.db.query<{ closing_claimed_at: string | null; resolution_comment_posted_at: string | null; cancelled_at: string | null }>(
    `SELECT closing_claimed_at, resolution_comment_posted_at, cancelled_at FROM ${q(ns, COVERS_TABLE)} WHERE cover_issue_id = $1`,
    [coverIssueId],
  );
  if (!row || !row.closing_claimed_at || row.cancelled_at) return;
  if (!row.resolution_comment_posted_at) {
    await ctx.issues.createComment(
      coverIssueId,
      "[alert-escalation] All source alerts represented by this cover have resolved; closing.",
      companyId,
    );
    await ctx.db.execute(
      `UPDATE ${q(ns, COVERS_TABLE)} SET resolution_comment_posted_at = now(), updated_at = now() WHERE cover_issue_id = $1 AND resolution_comment_posted_at IS NULL`,
      [coverIssueId],
    );
  }
  const issue = await ctx.issues.get(coverIssueId, companyId);
  if (issue && issue.status !== "done" && issue.status !== "cancelled") {
    await ctx.issues.update(coverIssueId, { status: "cancelled" }, companyId);
  }
  await ctx.db.execute(
    `UPDATE ${q(ns, COVERS_TABLE)} SET cancelled_at = now(), updated_at = now() WHERE cover_issue_id = $1 AND cancelled_at IS NULL`,
    [coverIssueId],
  );
}

/**
 * BLO-16120 aggregate-aware cascade cleanup: marks `alertIssueId` resolved
 * within every cover it's a member of (idempotent — a retried resolve is a
 * no-op UPDATE), then attempts to close each of those covers. A cover only
 * actually closes once its LAST unresolved member resolves — resolving the
 * winning source before a sibling leaves the cover open. Membership lookup
 * is a single indexed query keyed on `alert_issue_id`, so it can't silently
 * stop short the way a paginated `ctx.issues.list(..., limit: 50)` scan can.
 */
export async function recordSourceResolvedAndCloseCovers(
  ctx: PluginContext,
  companyId: string,
  alertIssueId: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  const resolved = await ctx.db.execute(
    `UPDATE ${q(ns, MEMBERS_TABLE)}
     SET resolved_at = COALESCE(resolved_at, now()), updated_at = now()
     WHERE alert_issue_id = $1`,
    [alertIssueId],
  );
  if (resolved.rowCount === 0) return; // never joined a cover — nothing to cascade

  const coverRows = await ctx.db.query<{ cover_issue_id: string }>(
    `SELECT DISTINCT cover_issue_id FROM ${q(ns, MEMBERS_TABLE)} WHERE alert_issue_id = $1`,
    [alertIssueId],
  );
  for (const { cover_issue_id: coverIssueId } of coverRows) {
    await closeCoverIfEligible(ctx, companyId, coverIssueId);
  }
}

/**
 * Sweep backstop for the durable-retry requirement: a cover whose closing
 * claim succeeded but whose terminal transition never completed (a crash or
 * transient failure — including a failed `createComment`, BLO-16120 PR #662
 * review — anywhere between claiming and cancelling) has no further inbound
 * trigger — no more alerts will resolve into an already-fully-resolved
 * cover. The sweep already runs every minute (see manifest `jobs`), so it
 * doubles as the retry loop via the partial index on "claimed but not
 * cancelled". `finalizeCoverCancellation` itself re-checks whether the
 * comment landed, so this resumes correctly whether the prior attempt died
 * before or after posting it.
 */
async function reconcileStuckCovers(ctx: PluginContext, companyId: string): Promise<void> {
  const ns = ctx.db.namespace;
  const stuck = await ctx.db.query<{ cover_issue_id: string }>(
    `SELECT cover_issue_id FROM ${q(ns, COVERS_TABLE)}
     WHERE company_id = $1 AND closing_claimed_at IS NOT NULL AND cancelled_at IS NULL
     LIMIT ${STUCK_COVER_RECONCILE_LIMIT}`,
    [companyId],
  );
  for (const { cover_issue_id: coverIssueId } of stuck) {
    try {
      await finalizeCoverCancellation(ctx, companyId, coverIssueId);
    } catch (err) {
      ctx.logger.warn(`alert-escalation: failed to finalize stuck cover ${coverIssueId}: ${String(err)}`);
    }
  }
}

export async function runAlertEscalationSweep(ctx: PluginContext, config: AlertmanagerPluginConfig, now = new Date()): Promise<void> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return;
  const issues = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, limit: 200 });
  for (const issue of issues) {
    try {
      await advanceIssueLadder(ctx, config, issue, companyId, now);
    } catch (err) {
      // One broken issue must not stall the sweep for the rest of the fleet
      // (live incident 2026-07-11: a throwing requestWakeup aborted the whole
      // sweep before the state write, repeating rung 1 every minute).
      ctx.logger.warn(`alert-escalation: skipping issue ${issue.identifier ?? issue.id}: ${String(err)}`);
    }
  }
  try {
    await reconcileStuckCovers(ctx, companyId);
  } catch (err) {
    ctx.logger.warn(`alert-escalation: cover reconciliation pass failed: ${String(err)}`);
  }
}

type SweepIssue = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];

async function advanceIssueLadder(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  issue: SweepIssue,
  companyId: string,
  now: Date,
): Promise<void> {
  if (["done", "cancelled"].includes(issue.status) || !issue.originId) return;
  const aggregateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.aggregate(companyId, issue.originId),
  };
  const aggregateState = await ctx.state.get(aggregateRef) as AlertStateRecord | null;
  const legacyRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.alert(issue.originId),
  };
  const ref = aggregateState ? aggregateRef : legacyRef;
  const state = aggregateState ?? await ctx.state.get(legacyRef) as AlertStateRecord | null;
  if (!state || state.resolvedAt || state.escalationComplete || !state.nextEscalationAt || Date.parse(state.nextEscalationAt) > now.getTime()) return;
  const hold = holdUntil(await ctx.issues.listComments(issue.id, companyId));
  if (hold && hold > now.getTime()) {
    await ctx.state.set(ref, { ...state, nextEscalationAt: new Date(hold).toISOString() });
    return;
  }
  const attempt = state.escalationAttempt ?? 0;
  const current = issue.assigneeAgentId ? await ctx.agents.get(issue.assigneeAgentId, companyId) : null;

  if (!(attempt === 0 && current) && !(current?.reportsTo && attempt < MAX_ATTEMPTS)) {
    // Chain exhausted (or no agent owner at all): board cover. Cover creation
    // stays ahead of the state write — it dedups via originKind/originId (and,
    // cross-issue, via originFingerprint), so a partial failure retries next
    // sweep instead of silently never covering.
    await createCover(ctx, issue, companyId, state.alertname, config, now);
    await ctx.issues.createComment(issue.id, "[alert-escalation] Agent chain exhausted while alert remains firing; created a [user-cover] escalation.", companyId);
    await ctx.state.set(ref, { ...state, escalationAttempt: MAX_ATTEMPTS, escalationComplete: true, nextEscalationAt: null });
    return;
  }

  // Persist the advanced rung BEFORE side effects: a failing comment or wake
  // then degrades to a missed notification on this rung, never a per-sweep
  // repeat of the same rung (comment storm). The reassign rung re-reads the
  // live assignee next time, so an interrupted rung self-heals upward.
  const next = attempt + 1;
  await ctx.state.set(ref, { ...state, escalationAttempt: next, escalationComplete: false, nextEscalationAt: new Date(now.getTime() + rungIntervalMs(state, config)).toISOString() });

  if (attempt === 0 && current) {
    await ctx.issues.createComment(issue.id, `[alert-escalation 1/${MAX_ATTEMPTS}] Alert is still firing; waking current owner ${current.name}.`, companyId);
    await requestWakeupBestEffort(ctx, issue, companyId, next);
  } else if (current?.reportsTo) {
    const manager = await ctx.agents.get(current.reportsTo, companyId);
    await ctx.issues.update(issue.id, { assigneeAgentId: current.reportsTo, assigneeUserId: null }, companyId);
    await ctx.issues.createComment(issue.id, `[alert-escalation ${next}/${MAX_ATTEMPTS}] Alert remains firing; reassigned from ${current.name} to ${manager?.name ?? current.reportsTo}.`, companyId);
    // Plugin-side issues.update does not fire core's assignment wake, so the
    // new owner is woken explicitly — otherwise the reassignment just sits in
    // their backlog until the next scheduled heartbeat.
    await requestWakeupBestEffort(ctx, issue, companyId, next);
  }
}

async function requestWakeupBestEffort(ctx: PluginContext, issue: SweepIssue, companyId: string, rung: number): Promise<void> {
  try {
    await ctx.issues.requestWakeup(issue.id, companyId, { reason: "alert_escalation_deadline", contextSource: "alertmanager-escalation", idempotencyKey: `alert-escalation:${issue.id}:${rung}` });
  } catch (err) {
    // The escalation comment already landed and the ladder state already
    // advanced; a refused wake (paused agent, budget block) must not repeat
    // the rung.
    ctx.logger.warn(`alert-escalation: wakeup for ${issue.identifier ?? issue.id} rung ${rung} failed: ${String(err)}`);
  }
}
