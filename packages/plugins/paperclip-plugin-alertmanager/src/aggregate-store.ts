import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AlertmanagerAlert } from "./types.js";

export interface AlertAggregateRecord {
  aggregateKey: string;
  companyId: string;
  paperclipIssueId: string | null;
  alertname: string;
  severity: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
}

interface AggregateRow {
  aggregate_key: string;
  company_id: string;
  paperclip_issue_id: string | null;
  alertname: string;
  severity: string;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
}

export function aggregateKeyForAlert(alert: AlertmanagerAlert): string {
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const domain =
    alert.labels.paperclip_dedupe_domain ??
    alert.annotations.paperclip_dedupe_domain ??
    null;
  return `alert-aggregate:v1:${JSON.stringify([alertname, domain])}`;
}

export async function joinAggregate(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  alert: AlertmanagerAlert,
): Promise<AlertAggregateRecord> {
  const aggregateKey = aggregateKeyForAlert(alert);
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const severity = alert.labels.severity ?? "unknown";
  const firedAt = alert.startsAt || new Date().toISOString();

  await ctx.db.execute(
    `INSERT INTO alert_aggregates (aggregate_key, company_id, alertname, severity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (aggregate_key) DO UPDATE SET
       severity = EXCLUDED.severity,
       resolution_claim = NULL,
       resolution_claimed_at = NULL,
       final_resolved_at = NULL,
       updated_at = now()`,
    [aggregateKey, companyId, alertname, severity],
  );
  await ctx.db.execute(
    `INSERT INTO alert_members
       (aggregate_key, fingerprint, firing, first_seen_at, last_fired_at, resolved_at)
     VALUES ($1, $2, true, $3, now(), NULL)
     ON CONFLICT (aggregate_key, fingerprint) DO UPDATE SET
       firing = true,
       last_fired_at = now(),
       resolved_at = NULL`,
    [aggregateKey, alert.fingerprint, firedAt],
  );

  const [row] = await ctx.db.query<AggregateRow>(
    `SELECT aggregate_key, company_id, paperclip_issue_id, alertname, severity,
            assignee_user_id, assignee_agent_id
       FROM alert_aggregates
      WHERE aggregate_key = $1`,
    [aggregateKey],
  );
  if (!row) throw new Error(`Aggregate disappeared after join: ${aggregateKey}`);
  return fromRow(row);
}

export async function bindAggregateIssue(
  ctx: Pick<PluginContext, "db">,
  aggregateKey: string,
  issueId: string,
  assignee: { assigneeUserId?: string; assigneeAgentId?: string },
): Promise<void> {
  await ctx.db.execute(
    `UPDATE alert_aggregates
        SET paperclip_issue_id = COALESCE(paperclip_issue_id, $2),
            assignee_user_id = COALESCE(assignee_user_id, $3),
            assignee_agent_id = COALESCE(assignee_agent_id, $4),
            updated_at = now()
      WHERE aggregate_key = $1`,
    [
      aggregateKey,
      issueId,
      assignee.assigneeUserId ?? null,
      assignee.assigneeAgentId ?? null,
    ],
  );
}

export async function getAggregate(
  ctx: Pick<PluginContext, "db">,
  aggregateKey: string,
): Promise<AlertAggregateRecord | null> {
  const [row] = await ctx.db.query<AggregateRow>(
    `SELECT aggregate_key, company_id, paperclip_issue_id, alertname, severity,
            assignee_user_id, assignee_agent_id
       FROM alert_aggregates
      WHERE aggregate_key = $1`,
    [aggregateKey],
  );
  return row ? fromRow(row) : null;
}

export async function resolveAggregateMember(
  ctx: Pick<PluginContext, "db">,
  aggregateKey: string,
  fingerprint: string,
  resolvedAt: string,
): Promise<{ memberKnown: boolean; finalResolutionClaim: string | null }> {
  const member = await ctx.db.execute(
    `UPDATE alert_members
        SET firing = false, resolved_at = $3
      WHERE aggregate_key = $1 AND fingerprint = $2 AND firing = true`,
    [aggregateKey, fingerprint, resolvedAt],
  );
  if (member.rowCount === 0) {
    const rows = await ctx.db.query<{ firing: boolean }>(
      `SELECT firing FROM alert_members
        WHERE aggregate_key = $1 AND fingerprint = $2`,
      [aggregateKey, fingerprint],
    );
    return { memberKnown: rows.length > 0, finalResolutionClaim: null };
  }

  const claim = randomUUID();
  const elected = await ctx.db.execute(
    `UPDATE alert_aggregates AS aggregate
        SET resolution_claim = $2,
            resolution_claimed_at = now(),
            updated_at = now()
      WHERE aggregate.aggregate_key = $1
        AND aggregate.paperclip_issue_id IS NOT NULL
        AND aggregate.final_resolved_at IS NULL
        AND (
          aggregate.resolution_claim IS NULL OR
          aggregate.resolution_claimed_at < now() - interval '5 minutes'
        )
        AND NOT EXISTS (
          SELECT 1 FROM alert_members AS member
           WHERE member.aggregate_key = aggregate.aggregate_key
             AND member.firing
        )`,
    [aggregateKey, claim],
  );
  return {
    memberKnown: true,
    finalResolutionClaim: elected.rowCount === 1 ? claim : null,
  };
}

export async function completeAggregateResolution(
  ctx: Pick<PluginContext, "db">,
  aggregateKey: string,
  claim: string,
  resolvedAt: string,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE alert_aggregates
        SET final_resolved_at = $3,
            resolution_claim = NULL,
            resolution_claimed_at = NULL,
            updated_at = now()
      WHERE aggregate_key = $1 AND resolution_claim = $2`,
    [aggregateKey, claim, resolvedAt],
  );
}

function fromRow(row: AggregateRow): AlertAggregateRecord {
  return {
    aggregateKey: row.aggregate_key,
    companyId: row.company_id,
    paperclipIssueId: row.paperclip_issue_id,
    alertname: row.alertname,
    severity: row.severity,
    assigneeUserId: row.assignee_user_id,
    assigneeAgentId: row.assignee_agent_id,
  };
}
