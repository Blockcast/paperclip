import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_COVER_DEDUP_WINDOW_MINUTES, DEFAULT_ESCALATION_DEADLINE_MINUTES, STATE_KEYS } from "./constants.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { ORIGIN_KIND, type AlertmanagerAlert, type AlertmanagerPluginConfig, type AlertStateRecord } from "./types.js";

/** Origin kind stamped on board-owned "chain exhausted" cover issues. */
export const COVER_ORIGIN = "plugin:paperclip-plugin-alertmanager:escalation";
const MAX_ATTEMPTS = 3;

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
 * Idempotently records `siblingIssue` as sharing the retained cover, keyed
 * off a durable marker in the comment body rather than in-memory state — a
 * retry (crash, sweep re-run) that lands on the same sibling re-checks the
 * marker instead of posting a second comment.
 */
async function attachAsSibling(
  ctx: PluginContext,
  companyId: string,
  coverId: string,
  siblingIssue: { id: string; identifier?: string | null },
  alertname: string,
): Promise<void> {
  const marker = `sibling:${siblingIssue.id}`;
  const comments = await ctx.issues.listComments(coverId, companyId);
  if (comments.some((comment) => comment.body.includes(marker))) return;
  await ctx.issues.createComment(
    coverId,
    `[alert-escalation] (${marker}) Sibling alert ${siblingIssue.identifier ?? siblingIssue.id} ("${alertname}") also exhausted its agent chain within the dedup window; tracked here instead of opening a duplicate cover.`,
    companyId,
  );
}

/**
 * Creates (or joins) the board-owned "chain exhausted" cover for `issue`.
 *
 * Race safety: `originFingerprint` carries the alertname+window dedup key,
 * backed by a partial unique index on the host
 * (`issues_active_alert_escalation_cover_uq`). Two concurrent same-alertname
 * ladders both calling `ctx.issues.create()` cannot both win — the DB
 * constraint, not a read-then-create check here, is the source of truth. The
 * loser catches the 409 and attaches itself to the winner's cover instead of
 * creating a duplicate.
 */
async function createCover(
  ctx: PluginContext,
  issue: NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>,
  companyId: string,
  alertname: string,
  config: AlertmanagerPluginConfig,
  now: Date,
) {
  const owned = await ctx.issues.list({ companyId, originKind: COVER_ORIGIN, originId: issue.id, limit: 1 });
  if (owned.length) return;

  const windowMinutes = config.coverDedupWindowMinutes ?? DEFAULT_COVER_DEDUP_WINDOW_MINUTES;
  const fingerprint = coverDedupFingerprint(alertname, windowMinutes, now);
  const members = await ctx.access.members.list({ companyId });
  const owner = members.find((member) => member.principalType === "user" && member.status === "active" && ["owner", "admin"].includes(member.membershipRole ?? ""));

  // At most 2 attempts: the second only fires if the conflicting cover
  // vanished between our failed create and the follow-up lookup (e.g. it was
  // just cancelled) — in that narrow race the dedup slot is free again.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ctx.issues.create({
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
      return;
    } catch (err) {
      if (!isCoverDedupConflict(err)) throw err;
      const [retained] = await ctx.issues.list({ companyId, originKind: COVER_ORIGIN, originFingerprint: fingerprint, limit: 1 });
      if (!retained) continue;
      await attachAsSibling(ctx, companyId, retained.id, issue, alertname);
      return;
    }
  }
}

/**
 * BLO-15982 cascade cleanup: when the source alert issue resolves, every
 * open cover it owns (originKind=COVER_ORIGIN, originId=<alert issue id>)
 * should close with it instead of sitting open on the board forever. Bounded
 * to a single indexed list() call — no per-alert N+1 — and idempotent:
 * a cover already in a terminal state is skipped, so a retried resolve
 * neither re-comments nor re-cancels it.
 */
export async function cancelOpenEscalationCovers(
  ctx: PluginContext,
  companyId: string,
  alertIssueId: string,
): Promise<void> {
  const covers = await ctx.issues.list({ companyId, originKind: COVER_ORIGIN, originId: alertIssueId, limit: 50 });
  for (const cover of covers) {
    if (cover.status === "done" || cover.status === "cancelled") continue;
    await ctx.issues.createComment(cover.id, "[alert-escalation] Source alert resolved; closing cover.", companyId);
    await ctx.issues.update(cover.id, { status: "cancelled" }, companyId);
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
  const ref = { scopeKind: "instance" as const, stateKey: STATE_KEYS.alert(issue.originId) };
  const state = await ctx.state.get(ref) as AlertStateRecord | null;
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
