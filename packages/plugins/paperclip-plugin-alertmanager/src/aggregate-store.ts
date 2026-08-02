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
  reopenRequired: boolean;
  resolutionClaim: string | null;
}

export interface AggregateResolutionWork extends AlertAggregateRecord {
  claim: string;
  resolvedAt: string;
}

export interface AggregateReopenWork extends AlertAggregateRecord {
  claim: string;
}

export interface AggregateFinalizedWork extends AlertAggregateRecord {
  resolvedAt: string;
}

interface AggregateRow {
  aggregate_key: string;
  company_id: string;
  paperclip_issue_id: string | null;
  alertname: string;
  severity: string;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
  reopen_required: boolean;
  resolution_claim: string | null;
  final_resolved_at?: string | null;
}

function table(ctx: Pick<PluginContext, "db">, name: string): string {
  return `"${ctx.db.namespace}"."${name}"`;
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
  const aggregates = table(ctx, "alert_aggregates");
  const members = table(ctx, "alert_members");

  await ctx.db.execute(
    `WITH activated_aggregate AS (
      INSERT INTO ${aggregates} AS aggregate
       (aggregate_key, company_id, alertname, severity, active_fingerprints)
      VALUES ($1, $2, $3, $4, ARRAY[$5]::text[])
      ON CONFLICT (company_id, aggregate_key) DO UPDATE SET
        severity = EXCLUDED.severity,
        active_fingerprints = CASE
          WHEN $5 = ANY(aggregate.active_fingerprints)
            THEN aggregate.active_fingerprints
          ELSE array_append(aggregate.active_fingerprints, $5)
        END,
        generation = aggregate.generation + 1,
        reopen_required = aggregate.reopen_required
          OR aggregate.resolution_claim IS NOT NULL
          OR aggregate.final_resolved_at IS NOT NULL,
        final_resolved_at = NULL,
        updated_at = now()
      RETURNING company_id, aggregate_key
    )
    INSERT INTO ${members} AS member
       (company_id, aggregate_key, fingerprint, firing, first_seen_at, last_fired_at, resolved_at)
    SELECT company_id, aggregate_key, $5, true, $6::timestamptz, $6::timestamptz, NULL
      FROM activated_aggregate
    ON CONFLICT (company_id, aggregate_key, fingerprint) DO UPDATE SET
      firing = true,
      last_fired_at = GREATEST(member.last_fired_at, EXCLUDED.last_fired_at),
      resolved_at = NULL`,
    [aggregateKey, companyId, alertname, severity, alert.fingerprint, firedAt],
  );

  const [row] = await ctx.db.query<AggregateRow>(
    `SELECT aggregate_key, company_id, paperclip_issue_id, alertname, severity,
             assignee_user_id, assignee_agent_id, reopen_required, resolution_claim
       FROM ${aggregates}
       WHERE company_id = $1 AND aggregate_key = $2`,
    [companyId, aggregateKey],
  );
  if (!row) throw new Error(`Aggregate disappeared after join: ${aggregateKey}`);
  return fromRow(row);
}

export async function bindAggregateIssue(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  issueId: string,
  assignee: { assigneeUserId?: string; assigneeAgentId?: string },
): Promise<string> {
  const aggregates = table(ctx, "alert_aggregates");
  await ctx.db.execute(
    `UPDATE ${aggregates}
        SET paperclip_issue_id = COALESCE(paperclip_issue_id, $3),
            assignee_user_id = COALESCE(assignee_user_id, $4),
            assignee_agent_id = COALESCE(assignee_agent_id, $5),
            updated_at = now()
      WHERE company_id = $1 AND aggregate_key = $2`,
    [
      companyId,
      aggregateKey,
      issueId,
      assignee.assigneeUserId ?? null,
      assignee.assigneeAgentId ?? null,
    ],
  );
  const [binding] = await ctx.db.query<{ paperclip_issue_id: string | null }>(
    `SELECT paperclip_issue_id FROM ${aggregates}
      WHERE company_id = $1 AND aggregate_key = $2`,
    [companyId, aggregateKey],
  );
  return binding?.paperclip_issue_id ?? issueId;
}

export async function getAggregate(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
): Promise<AlertAggregateRecord | null> {
  const aggregates = table(ctx, "alert_aggregates");
  const [row] = await ctx.db.query<AggregateRow>(
    `SELECT aggregate_key, company_id, paperclip_issue_id, alertname, severity,
             assignee_user_id, assignee_agent_id, reopen_required, resolution_claim
       FROM ${aggregates}
       WHERE company_id = $1 AND aggregate_key = $2`,
    [companyId, aggregateKey],
  );
  return row ? fromRow(row) : null;
}

export async function resolveAggregateMember(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  fingerprint: string,
  resolvedAt: string,
): Promise<{
  memberKnown: boolean;
  resolutionAccepted: boolean;
  finalResolutionClaim: string | null;
}> {
  const aggregates = table(ctx, "alert_aggregates");
  const members = table(ctx, "alert_members");
  const claim = randomUUID();
  const [elected] = await ctx.db.query<{ resolution_claim: string | null }>(
    `WITH resolved_aggregate AS (
      UPDATE ${aggregates} AS aggregate
         SET active_fingerprints = array_remove(aggregate.active_fingerprints, $3),
            resolution_claim = CASE
              WHEN cardinality(array_remove(aggregate.active_fingerprints, $3)) = 0
                AND aggregate.paperclip_issue_id IS NOT NULL
                AND aggregate.final_resolved_at IS NULL
                AND (
                  aggregate.resolution_claim IS NULL OR
                  aggregate.resolution_claimed_at < now() - interval '5 minutes'
                )
                THEN $4
              ELSE aggregate.resolution_claim
            END,
            resolution_claimed_at = CASE
              WHEN cardinality(array_remove(aggregate.active_fingerprints, $3)) = 0
                AND aggregate.paperclip_issue_id IS NOT NULL
                AND aggregate.final_resolved_at IS NULL
                AND (
                  aggregate.resolution_claim IS NULL OR
                  aggregate.resolution_claimed_at < now() - interval '5 minutes'
                )
                THEN now()
              ELSE aggregate.resolution_claimed_at
            END,
            resolution_generation = CASE
              WHEN cardinality(array_remove(aggregate.active_fingerprints, $3)) = 0
                AND aggregate.paperclip_issue_id IS NOT NULL
                AND aggregate.final_resolved_at IS NULL
                AND (
                  aggregate.resolution_claim IS NULL OR
                  aggregate.resolution_claimed_at < now() - interval '5 minutes'
                )
                THEN aggregate.generation
              ELSE aggregate.resolution_generation
            END,
            resolution_requested_at = CASE
              WHEN cardinality(array_remove(aggregate.active_fingerprints, $3)) = 0
                AND aggregate.paperclip_issue_id IS NOT NULL
                AND aggregate.final_resolved_at IS NULL
                AND (
                  aggregate.resolution_claim IS NULL OR
                  aggregate.resolution_claimed_at < now() - interval '5 minutes'
                )
                THEN $5::timestamptz
              ELSE aggregate.resolution_requested_at
            END,
            updated_at = now()
       WHERE aggregate.company_id = $1
         AND aggregate.aggregate_key = $2
         AND EXISTS (
           SELECT 1 FROM ${members} AS member
            WHERE member.company_id = aggregate.company_id
              AND member.aggregate_key = aggregate.aggregate_key
              AND member.fingerprint = $3
              AND member.last_fired_at <= $5::timestamptz
         )
         AND (
          $3 = ANY(aggregate.active_fingerprints) OR
          EXISTS (
            SELECT 1 FROM ${members} AS member
           WHERE member.company_id = aggregate.company_id
             AND member.aggregate_key = aggregate.aggregate_key
             AND member.fingerprint = $3
           )
         )
      RETURNING aggregate.company_id, aggregate.aggregate_key, aggregate.resolution_claim
    ), resolved_member AS (
      UPDATE ${members} AS member
         SET firing = false, resolved_at = $5::timestamptz
        FROM resolved_aggregate
       WHERE member.company_id = resolved_aggregate.company_id
         AND member.aggregate_key = resolved_aggregate.aggregate_key
         AND member.fingerprint = $3
      RETURNING member.fingerprint
    )
    SELECT resolution_claim FROM resolved_aggregate`,
    [companyId, aggregateKey, fingerprint, claim, resolvedAt],
  );
  if (!elected) {
    const [member] = await ctx.db.query<{ present: boolean }>(
      `SELECT true AS present FROM ${members}
        WHERE company_id = $1 AND aggregate_key = $2 AND fingerprint = $3`,
      [companyId, aggregateKey, fingerprint],
    );
    return {
      memberKnown: Boolean(member),
      resolutionAccepted: false,
      finalResolutionClaim: null,
    };
  }
  return {
    memberKnown: true,
    resolutionAccepted: true,
    finalResolutionClaim: elected.resolution_claim === claim ? claim : null,
  };
}

export async function renewAggregateResolutionClaim(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  claim: string,
): Promise<boolean> {
  const aggregates = table(ctx, "alert_aggregates");
  const renewed = await ctx.db.execute(
    `UPDATE ${aggregates}
        SET resolution_claimed_at = now(), updated_at = now()
      WHERE company_id = $1
        AND aggregate_key = $2
        AND resolution_claim = $3
        AND resolution_generation = generation
        AND cardinality(active_fingerprints) = 0`,
    [companyId, aggregateKey, claim],
  );
  return renewed.rowCount === 1;
}

export async function completeAggregateResolution(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  claim: string,
  resolvedAt: string,
): Promise<"completed" | "firing" | "superseded"> {
  const aggregates = table(ctx, "alert_aggregates");
  const completed = await ctx.db.execute(
    `UPDATE ${aggregates}
        SET final_resolved_at = $4,
            reopen_required = false,
            resolution_claim = NULL,
            resolution_claimed_at = NULL,
            resolution_generation = NULL,
            updated_at = now()
      WHERE company_id = $1
        AND aggregate_key = $2
        AND resolution_claim = $3
        AND resolution_generation = generation
        AND cardinality(active_fingerprints) = 0`,
    [companyId, aggregateKey, claim, resolvedAt],
  );
  if (completed.rowCount === 1) return "completed";
  const firing = await ctx.db.query<{ present: boolean }>(
    `SELECT cardinality(active_fingerprints) > 0 AS present
       FROM ${aggregates}
      WHERE company_id = $1 AND aggregate_key = $2`,
    [companyId, aggregateKey],
  );
  return firing[0]?.present ? "firing" : "superseded";
}

export async function releaseAggregateResolution(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  claim: string,
): Promise<void> {
  const aggregates = table(ctx, "alert_aggregates");
  await ctx.db.execute(
    `UPDATE ${aggregates}
        SET resolution_claim = NULL,
            resolution_claimed_at = NULL,
            resolution_generation = NULL,
            updated_at = now()
      WHERE company_id = $1 AND aggregate_key = $2 AND resolution_claim = $3`,
    [companyId, aggregateKey, claim],
  );
}

export async function claimPendingAggregateResolutions(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  limit = 50,
): Promise<AggregateResolutionWork[]> {
  const aggregates = table(ctx, "alert_aggregates");
  const claim = randomUUID();
  const rows = await ctx.db.query<AggregateRow & {
    resolution_claim: string;
    resolved_at: string;
  }>(
    `WITH candidates AS (
       SELECT aggregate_key
         FROM ${aggregates}
        WHERE company_id = $1
          AND paperclip_issue_id IS NOT NULL
          AND final_resolved_at IS NULL
          AND cardinality(active_fingerprints) = 0
          AND (
            resolution_claim IS NULL OR
            resolution_generation <> generation OR
            resolution_claimed_at < now() - interval '5 minutes'
          )
        ORDER BY updated_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${aggregates} AS aggregate
        SET resolution_claim = $3,
            resolution_claimed_at = now(),
            resolution_generation = aggregate.generation,
            reopen_required = false,
            updated_at = now()
       FROM candidates
      WHERE aggregate.company_id = $1
        AND aggregate.aggregate_key = candidates.aggregate_key
     RETURNING aggregate.aggregate_key, aggregate.company_id,
       aggregate.paperclip_issue_id, aggregate.alertname, aggregate.severity,
       aggregate.assignee_user_id, aggregate.assignee_agent_id,
       aggregate.reopen_required, aggregate.resolution_claim,
       aggregate.resolution_claim,
       COALESCE(aggregate.resolution_requested_at, aggregate.updated_at)::text AS resolved_at`,
    [companyId, limit, claim],
  );
  return rows.map((row) => ({
    ...fromRow(row),
    claim: row.resolution_claim,
    resolvedAt: row.resolved_at,
  }));
}

export async function claimPendingAggregateReopens(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  limit = 50,
): Promise<AggregateReopenWork[]> {
  const aggregates = table(ctx, "alert_aggregates");
  const claim = randomUUID();
  const rows = await ctx.db.query<AggregateRow & { resolution_claim: string }>(
    `WITH candidates AS (
       SELECT aggregate_key
         FROM ${aggregates}
        WHERE company_id = $1
          AND paperclip_issue_id IS NOT NULL
          AND reopen_required
          AND cardinality(active_fingerprints) > 0
          AND (
            resolution_claim IS NULL OR
            resolution_generation <> generation OR
            resolution_claimed_at < now() - interval '5 minutes'
          )
        ORDER BY updated_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ${aggregates} AS aggregate
        SET resolution_claim = $3,
            resolution_claimed_at = now(),
            resolution_generation = aggregate.generation,
            updated_at = now()
       FROM candidates
      WHERE aggregate.company_id = $1
        AND aggregate.aggregate_key = candidates.aggregate_key
     RETURNING aggregate.aggregate_key, aggregate.company_id,
       aggregate.paperclip_issue_id, aggregate.alertname, aggregate.severity,
       aggregate.assignee_user_id, aggregate.assignee_agent_id,
       aggregate.reopen_required, aggregate.resolution_claim`,
    [companyId, limit, claim],
  );
  return rows.map((row) => ({ ...fromRow(row), claim: row.resolution_claim }));
}

export async function renewAggregateReopenClaim(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  claim: string,
): Promise<boolean> {
  const aggregates = table(ctx, "alert_aggregates");
  const renewed = await ctx.db.execute(
    `UPDATE ${aggregates}
        SET resolution_claimed_at = now(), updated_at = now()
      WHERE company_id = $1
        AND aggregate_key = $2
        AND resolution_claim = $3
        AND resolution_generation = generation
        AND reopen_required
        AND cardinality(active_fingerprints) > 0
    `,
    [companyId, aggregateKey, claim],
  );
  return renewed.rowCount === 1;
}

export async function completeAggregateReopen(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
  claim: string,
): Promise<boolean> {
  const aggregates = table(ctx, "alert_aggregates");
  const completed = await ctx.db.execute(
    `UPDATE ${aggregates}
        -- Keep reopen_required sticky while this generation is active. A
        -- superseded close RPC can resume after any finite lease expires.
        SET resolution_claim = NULL,
            resolution_claimed_at = NULL,
            resolution_generation = NULL,
            updated_at = now()
      WHERE company_id = $1
        AND aggregate_key = $2
        AND resolution_claim = $3
        AND resolution_generation = generation
        AND reopen_required
        AND cardinality(active_fingerprints) > 0`,
    [companyId, aggregateKey, claim],
  );
  return completed.rowCount === 1;
}

export async function listFinalizedAggregateWork(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  limit = 50,
): Promise<AggregateFinalizedWork[]> {
  const aggregates = table(ctx, "alert_aggregates");
  // final_resolved_at is the durable desired state. Re-enforcing it repairs a
  // stale reopen worker even if that worker dies immediately after its RPC.
  const rows = await ctx.db.query<AggregateRow & { final_resolved_at: string }>(
    `SELECT aggregate_key, company_id, paperclip_issue_id, alertname, severity,
            assignee_user_id, assignee_agent_id, reopen_required, resolution_claim,
            final_resolved_at::text
       FROM ${aggregates}
      WHERE company_id = $1
        AND paperclip_issue_id IS NOT NULL
        AND final_resolved_at IS NOT NULL
        AND cardinality(active_fingerprints) = 0
      ORDER BY updated_at
      LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((row) => ({ ...fromRow(row), resolvedAt: row.final_resolved_at }));
}

export async function markFinalizedAggregateReconciled(
  ctx: Pick<PluginContext, "db">,
  companyId: string,
  aggregateKey: string,
): Promise<void> {
  const aggregates = table(ctx, "alert_aggregates");
  await ctx.db.execute(
    `UPDATE ${aggregates}
        SET updated_at = now()
      WHERE company_id = $1
        AND aggregate_key = $2
        AND final_resolved_at IS NOT NULL
        AND cardinality(active_fingerprints) = 0`,
    [companyId, aggregateKey],
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
    reopenRequired: row.reopen_required,
    resolutionClaim: row.resolution_claim,
  };
}
