import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_ESCALATION_DEADLINE_MINUTES, STATE_KEYS } from "./constants.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { ORIGIN_KIND, type AlertmanagerAlert, type AlertmanagerPluginConfig, type AlertStateRecord } from "./types.js";

const COVER_ORIGIN = "plugin:paperclip-plugin-alertmanager:escalation";
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

async function createCover(ctx: PluginContext, issue: NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>, companyId: string) {
  const duplicate = await ctx.issues.list({ companyId, originKind: COVER_ORIGIN, originId: issue.id, limit: 1 });
  if (duplicate.length) return;
  const members = await ctx.access.members.list({ companyId });
  const owner = members.find((member) => member.principalType === "user" && member.status === "active" && ["owner", "admin"].includes(member.membershipRole ?? ""));
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
  });
}

export async function runAlertEscalationSweep(ctx: PluginContext, config: AlertmanagerPluginConfig, now = new Date()): Promise<void> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return;
  const issues = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, limit: 200 });
  for (const issue of issues) {
    if (["done", "cancelled"].includes(issue.status) || !issue.originId) continue;
    const ref = { scopeKind: "instance" as const, stateKey: STATE_KEYS.alert(issue.originId) };
    const state = await ctx.state.get(ref) as AlertStateRecord | null;
    if (!state || state.resolvedAt || state.escalationComplete || !state.nextEscalationAt || Date.parse(state.nextEscalationAt) > now.getTime()) continue;
    const hold = holdUntil(await ctx.issues.listComments(issue.id, companyId));
    if (hold && hold > now.getTime()) {
      await ctx.state.set(ref, { ...state, nextEscalationAt: new Date(hold).toISOString() });
      continue;
    }
    const attempt = state.escalationAttempt ?? 0;
    const current = issue.assigneeAgentId ? await ctx.agents.get(issue.assigneeAgentId, companyId) : null;
    if (attempt === 0 && current) {
      await ctx.issues.createComment(issue.id, `[alert-escalation 1/${MAX_ATTEMPTS}] Alert is still firing; waking current owner ${current.name}.`, companyId);
      await ctx.issues.requestWakeup(issue.id, companyId, { reason: "alert_escalation_deadline", contextSource: "alertmanager-escalation", idempotencyKey: `alert-escalation:${issue.id}:1` });
    } else if (current?.reportsTo && attempt < MAX_ATTEMPTS) {
      const manager = await ctx.agents.get(current.reportsTo, companyId);
      await ctx.issues.update(issue.id, { assigneeAgentId: current.reportsTo, assigneeUserId: null }, companyId);
      await ctx.issues.createComment(issue.id, `[alert-escalation ${attempt + 1}/${MAX_ATTEMPTS}] Alert remains firing; reassigned from ${current.name} to ${manager?.name ?? current.reportsTo}.`, companyId);
    } else {
      await createCover(ctx, issue, companyId);
      await ctx.issues.createComment(issue.id, "[alert-escalation] Agent chain exhausted while alert remains firing; created a [user-cover] escalation.", companyId);
      await ctx.state.set(ref, { ...state, escalationAttempt: MAX_ATTEMPTS, escalationComplete: true, nextEscalationAt: null });
      continue;
    }
    const next = attempt + 1;
    await ctx.state.set(ref, { ...state, escalationAttempt: next, escalationComplete: false, nextEscalationAt: new Date(now.getTime() + rungIntervalMs(state, config)).toISOString() });
  }
}
