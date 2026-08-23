/**
 * Shared Dependabot-alert issue plumbing used by both the GitHub webhook
 * route (server/src/routes/github-webhook.ts, live deliveries) and the
 * heartbeat dispatcher (server/src/services/heartbeat.ts, BLO-16446
 * backfill for wakes enqueued before the scoping fix landed). Split out so
 * heartbeat.ts doesn't need to import from a route module.
 */
import { type Db, agents, issues } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { issueService } from "./issues.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { logger } from "../middleware/logger.js";

export const GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND = "github_dependabot_alert";
export const GITHUB_DEPENDABOT_WEBHOOK_DIAGNOSTIC_ORIGIN_KIND = "github_dependabot_webhook_diagnostic";

// BLO-26613: the Dependabot alert path has exactly one configured owner
// (PAPERCLIP_DEPENDABOT_AGENT_ID) and no fallback owner. Issue creation
// here used to assign that configured agent unconditionally -- if it is
// paused, terminated, or otherwise uninvokable, every new alert (and
// diagnostic/terminal-receipt row) silently queued on a dead run path with
// no signal. Resolve to the configured agent when it's invokable; otherwise
// fall back to unassigned so `allow_company_agent` lets any agent pick the
// issue up, and log distinctly so this can back a fleet-level alert rule
// separate from the per-issue `blocked_by_uninvokable_assignee` escalation.
export async function resolveDependabotIssueAssigneeId(
  db: Db,
  companyId: string,
  configuredAgentId: string,
): Promise<string | null> {
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, configuredAgentId))
    .then((rows) => rows[0] ?? null);
  const invokability = await evaluateAgentInvokabilityFromDb(db, agent);
  if (invokability.invokable) return configuredAgentId;

  logger.warn(
    {
      companyId,
      configuredAgentId,
      reason: invokability.reason,
      message: invokability.message,
    },
    "dependabot alert route's configured assignee is not invokable; filing issue unassigned instead of silently assigning it",
  );
  return null;
}

export async function findOpenDependabotAlertIssue(db: Db, companyId: string, originId: string) {
  return db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND),
        eq(issues.originId, originId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// BLO-28981: the counterpart to findOpenDependabotAlertIssue -- the rows it
// deliberately excludes. `issues_active_dependabot_alert_uq` only covers
// non-terminal rows, so once a cycle's issue is closed the next
// `reintroduced`/`reopened` delivery matches nothing and the intake mints a
// brand-new full-weight row. On `Blockcast/magma` that produced 8 alerts x 3
// re-fire cycles = 24 rows under 8 identical originIds, each one context-free:
// the adjudication that closed the previous cycle never travelled with the
// alert, so the fleet re-derived the same conclusion three times.
//
// Ordered newest-first so callers can both reopen the most recent row and
// quote the older ones as the adjudication chain. Bounded because the point is
// to carry forward a readable history, not to page through an unbounded one.
export async function findTerminalDependabotAlertIssues(
  db: Db,
  companyId: string,
  originId: string,
  limit = 10,
) {
  return db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, GITHUB_DEPENDABOT_ALERT_ORIGIN_KIND),
        eq(issues.originId, originId),
        isNull(issues.hiddenAt),
        inArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(limit);
}

// Records a durable diagnostic when a `dependabot_alert` delivery (or a
// stale pre-fix wake, see resolveStaleDependabotAlertWakeIssue below) can't
// be resolved into a scoped alert. Without this the event/wake was silently
// dropped or launched unscoped -- exactly the "fails invisibly" failure mode
// BLO-16319/BLO-16446 called out. Best-effort: a raced concurrent insert
// just logs and re-queries rather than fighting over a uniqueness index for
// a path this rare. Returns the (existing or created) diagnostic issue id,
// or null if creation failed.
export async function recordDependabotWebhookDiagnostic(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string;
    event: string;
    deliveryId: string | null;
    action: string | undefined;
    repoFullName: string | null;
    reason: string;
    alertNumber?: number | null;
  },
): Promise<{ issueId: string } | null> {
  const originId = `${input.event}:${input.deliveryId ?? "no-delivery"}`;
  const existing = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, GITHUB_DEPENDABOT_WEBHOOK_DIAGNOSTIC_ORIGIN_KIND),
        eq(issues.originId, originId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return { issueId: existing.id };

  const assigneeAgentId = await resolveDependabotIssueAssigneeId(db, input.companyId, input.assigneeAgentId);

  const title = `Dependabot webhook payload could not be scoped (${input.repoFullName ?? "unknown repo"})`;
  const description = [
    `A \`dependabot_alert\` webhook delivery could not be resolved into a scoped alert. ${input.reason}`,
    "",
    "## What's known",
    `- Event: \`${input.event}\``,
    `- Delivery id: \`${input.deliveryId ?? "unknown"}\``,
    `- Action: \`${input.action ?? "unknown"}\``,
    `- Repository: \`${input.repoFullName ?? "unknown"}\``,
    ...(input.alertNumber != null ? [`- Alert number: #${input.alertNumber}`] : []),
    "",
    "This is a webhook-processing gap, not a specific vulnerability to remediate. If it recurs, the Dependabot webhook payload shape likely changed upstream -- escalate to the CTO.",
  ].join("\n");

  try {
    const created = await issueService(db).create(input.companyId, {
      title,
      description,
      status: "todo",
      priority: "high",
      assigneeAgentId,
      originKind: GITHUB_DEPENDABOT_WEBHOOK_DIAGNOSTIC_ORIGIN_KIND,
      originId,
      originFingerprint: originId,
    });
    return { issueId: created.id };
  } catch (error) {
    logger.error(
      { err: error, deliveryId: input.deliveryId },
      "github webhook dependabot diagnostic issue insert failed",
    );
    return null;
  }
}

const DEPENDABOT_TASK_KEY_PATTERN = /^github-dependabot:(.+)#(\d+)$/;

// BLO-16446: a large backlog of dependabot_alert wakes was enqueued (queued
// heartbeatRuns rows) before the BLO-16319 scoping fix shipped. Those rows'
// contextSnapshot was frozen at enqueue time -- `{ taskKey, wakeReason,
// wakeSource, wakeTriggerDetail }` only, no issueId -- so redeploying the
// webhook route's fix never touches them; each one launches an unscoped
// agent run the moment the heartbeat scheduler dispatches it, no matter how
// long after the fix that dispatch happens. Called from heartbeat.ts right
// before a run launches: if the wake reason is github_dependabot_alert and
// the run still has no issueId, this resolves (or creates) a durable issue
// from what little the stale context has left -- taskKey's `repo#alertNumber`
// -- instead of handing the agent an empty task.
export async function resolveStaleDependabotAlertWakeIssue(
  db: Db,
  input: { companyId: string; assigneeAgentId: string; taskKey: string | null },
): Promise<{ issueId: string } | null> {
  const taskKey = input.taskKey;
  if (!taskKey) return null;
  const match = DEPENDABOT_TASK_KEY_PATTERN.exec(taskKey);
  if (!match) return null;
  const [, repoFullName, alertNumberRaw] = match;
  const alertNumber = Number(alertNumberRaw);

  // A fresh redelivery of this same alert after the fix shipped (a
  // `reintroduced`/`reopened` event) may already have created the real,
  // fully-detailed issue for it -- prefer that over a diagnostic stand-in.
  const existing = await findOpenDependabotAlertIssue(db, input.companyId, taskKey);
  if (existing) return { issueId: existing.id };

  const alertUrl = `https://github.com/${repoFullName}/security/dependabot/${alertNumber}`;
  return recordDependabotWebhookDiagnostic(db, {
    companyId: input.companyId,
    assigneeAgentId: input.assigneeAgentId,
    event: "dependabot_wake_stale_context",
    deliveryId: taskKey,
    action: undefined,
    repoFullName,
    alertNumber,
    reason: [
      "This wake was enqueued before the BLO-16319 dependabot wake-scoping fix shipped, so its",
      `context snapshot never got a linked issue or alert payload -- only \`${taskKey}\` survived.`,
      `Open ${alertUrl} to read the current severity, package, and advisory, then remediate or`,
      "dismiss as appropriate; close this issue once the alert itself is fixed or dismissed on GitHub.",
    ].join(" "),
  });
}
