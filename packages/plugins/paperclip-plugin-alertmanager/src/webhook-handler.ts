/**
 * Webhook handler logic — separated from `worker.ts` so tests can drive it
 * without triggering the RPC host bootstrap that runs at module load time.
 *
 * All host interaction goes through the `PluginContext` argument; the
 * resolved bearer token is passed in explicitly so the handler stays
 * independent of how the operator chose to supply it (secret-ref vs inline).
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import {
  ACCEPTED_SCHEMA_VERSIONS,
  WEBHOOK_KEYS,
  alertStateRef,
  legacyInstanceAlertStateRef,
} from "./constants.js";
import {
  alertMatchesLabelFilter,
  buildIssueDescription,
  buildIssueTitle,
  effectiveAlertStatus,
  severityToPriority,
} from "./issue-mapping.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { resolveAssigneeUserId, resolveFallbackAgentId } from "./owner-resolver.js";
import { aggregateKeyForAlert } from "./aggregate-key.js";
import { escalationDeadlineMs, recordSourceResolvedAndCloseCovers } from "./escalation.js";
import { recordCredentialResolution } from "./credential-health.js";
import {
  ORIGIN_KIND,
  type AlertStateRecord,
  type AlertmanagerAlert,
  type AlertmanagerPluginConfig,
  type AlertmanagerWebhookPayload,
} from "./types.js";

export class WebhookUnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "WebhookUnauthorizedError";
  }
}

/**
 * Raised after the per-alert loop when at least one alert in the batch could not
 * be processed, so that the delivery fails and Alertmanager retries it.
 *
 * Alerts are caught individually to keep batch isolation — one poisoned alert
 * must not abandon its siblings — but "isolated" must not become "acknowledged".
 * Returning normally makes the host record `success` and answer HTTP 200
 * (`server/src/routes/plugins.ts` "Step 8"), which ends Alertmanager's retries
 * for a delivery that produced no durable issue or state row.
 */
export class AlertDeliveryIncompleteError extends Error {
  readonly fingerprints: readonly string[];

  constructor(fingerprints: readonly string[]) {
    super(
      `${fingerprints.length} alert(s) in this delivery could not be processed (${fingerprints.join(", ")}) — failing the delivery so Alertmanager retries`,
    );
    this.name = "AlertDeliveryIncompleteError";
    this.fingerprints = fingerprints;
  }
}

const AGGREGATE_CREATION_CLAIMS_TABLE = "alertmanager_aggregate_creation_claims";
const AGGREGATE_MEMBERS_TABLE = "alertmanager_aggregate_members";
const AGGREGATE_LIFECYCLE_FENCES_TABLE = "alertmanager_aggregate_lifecycle_fences";

type IssueReference = {
  id: string;
  status?: string | null;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
};

type AggregateMemberResolution = {
  disposition:
    | "no-membership"
    | "has-unresolved-siblings"
    | "last-member-resolved"
    | "finalization-pending";
  issueId: string;
  resolutionToken?: string;
};

function q(ns: string, table: string): string {
  return `${ns}.${table}`;
}

async function findActiveAggregateIssue(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
): Promise<IssueReference | null> {
  const activeStatuses = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
  ] as const;
  for (const status of activeStatuses) {
    const [issue] = await ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originFingerprint: aggregateKey,
      status,
      limit: 1,
    });
    if (issue) return issue;
  }
  return null;
}

async function tryClaimAggregateCreation(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `DELETE FROM ${q(ns, AGGREGATE_CREATION_CLAIMS_TABLE)}
     WHERE company_id = $1
       AND aggregate_key = $2
       AND claimed_at < now() - interval '5 minutes'`,
    [companyId, aggregateKey],
  );
  const claimToken = randomUUID();
  const result = await ctx.db.execute(
    `INSERT INTO ${q(ns, AGGREGATE_CREATION_CLAIMS_TABLE)}
       (company_id, aggregate_key, claim_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, aggregate_key) DO NOTHING`,
    [companyId, aggregateKey, claimToken],
  );
  return result.rowCount > 0 ? claimToken : null;
}

async function releaseAggregateCreationClaim(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  claimToken: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `DELETE FROM ${q(ns, AGGREGATE_CREATION_CLAIMS_TABLE)}
     WHERE company_id = $1 AND aggregate_key = $2 AND claim_token = $3`,
    [companyId, aggregateKey, claimToken],
  );
}

async function upsertAggregateMember(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  issueId: string,
  fingerprint: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `INSERT INTO ${q(ns, AGGREGATE_MEMBERS_TABLE)}
       (company_id, aggregate_key, fingerprint, issue_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, aggregate_key, fingerprint)
     DO UPDATE SET
       issue_id = EXCLUDED.issue_id,
       resolved_at = NULL,
       updated_at = now()`,
    [companyId, aggregateKey, fingerprint, issueId],
  );
}

/**
 * Firing claims the aggregate fence before it mutates member state or touches
 * the issue. A resolver may only begin finalization while the fence is active;
 * once it is cancelling, a new firing fails its delivery and retries after the
 * terminal transition instead of attaching a live member to a cancelled issue.
 */
async function beginAggregateFiring(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  const token = randomUUID();
  const fences = q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE);
  // This is intentionally a fence rather than a lease. A delayed worker can
  // resume after an arbitrary timeout, so stealing `firing` or `cancelling`
  // would allow it to attach a member after a newer resolver has started the
  // terminal transition. A stuck owner therefore fails closed and needs an
  // explicit recovery action, rather than silently reintroducing that race.
  const result = await ctx.db.execute(
    `INSERT INTO ${fences}
       (company_id, aggregate_key, phase, firing_token)
     VALUES ($1, $2, 'firing', $3)
     ON CONFLICT (company_id, aggregate_key) DO UPDATE
     SET phase = 'firing',
         firing_token = EXCLUDED.firing_token,
         resolution_token = NULL,
         updated_at = now()
     WHERE ${fences}.phase IN ('active', 'finalizing')`,
    [companyId, aggregateKey, token],
  );
  return result.rowCount > 0 ? token : null;
}

async function finishAggregateFiring(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
     SET phase = 'active',
         firing_token = NULL,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'firing'
       AND firing_token = $3`,
    [companyId, aggregateKey, token],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `Alertmanager aggregate firing fence was lost for ${aggregateKey}; retrying delivery`,
    );
  }
}

async function tryClaimAggregateFinalization(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  issueId: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  const fences = q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE);
  const members = q(ns, AGGREGATE_MEMBERS_TABLE);
  const token = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${fences} (company_id, aggregate_key)
     VALUES ($1, $2)
     ON CONFLICT (company_id, aggregate_key) DO NOTHING`,
    [companyId, aggregateKey],
  );
  const result = await ctx.db.execute(
    `UPDATE ${fences}
     SET phase = 'finalizing',
         firing_token = NULL,
         resolution_token = $4,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'active'
       AND NOT EXISTS (
         SELECT 1
         FROM ${members}
         WHERE company_id = $1
           AND aggregate_key = $2
           AND issue_id = $3
           AND resolved_at IS NULL
       )`,
    [companyId, aggregateKey, issueId, token],
  );
  return result.rowCount > 0 ? token : null;
}

async function beginAggregateCancellation(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<boolean> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
     SET phase = 'cancelling',
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'finalizing'
       AND resolution_token = $3`,
    [companyId, aggregateKey, token],
  );
  return result.rowCount > 0;
}

async function releaseAggregateFinalization(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
     SET phase = 'active',
         resolution_token = NULL,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'cancelling'
       AND resolution_token = $3`,
    [companyId, aggregateKey, token],
  );
}

async function resolveAggregateMember(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  issueId: string,
  fingerprint: string,
  claimFinalization: boolean,
): Promise<AggregateMemberResolution> {
  const ns = ctx.db.namespace;
  const [resolved] = await ctx.db.query<{ issue_id: string }>(
    `UPDATE ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     SET resolved_at = COALESCE(resolved_at, now()),
         updated_at = now()
     WHERE company_id = $1 AND aggregate_key = $2 AND fingerprint = $3
     RETURNING issue_id`,
    [companyId, aggregateKey, fingerprint],
  );
  const resolvedIssueId = resolved?.issue_id ?? issueId;
  if (!resolved) {
    return { disposition: "no-membership", issueId: resolvedIssueId };
  }

  const unresolved = await ctx.db.query<{ one: number }>(
    `SELECT 1 AS one
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1
       AND aggregate_key = $2
       AND issue_id = $3
       AND resolved_at IS NULL
     LIMIT 1`,
    [companyId, aggregateKey, resolvedIssueId],
  );
  if (unresolved.length > 0) {
    return { disposition: "has-unresolved-siblings", issueId: resolvedIssueId };
  }
  if (!claimFinalization) {
    return { disposition: "last-member-resolved", issueId: resolvedIssueId };
  }
  const resolutionToken = await tryClaimAggregateFinalization(
    ctx,
    companyId,
    aggregateKey,
    resolvedIssueId,
  );
  return resolutionToken
    ? {
        disposition: "last-member-resolved",
        issueId: resolvedIssueId,
        resolutionToken,
      }
    : { disposition: "finalization-pending", issueId: resolvedIssueId };
}

async function findAggregateMemberKey(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  fingerprint: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  const [member] = await ctx.db.query<{ aggregate_key: string }>(
    `SELECT aggregate_key
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1
       AND issue_id = $2
       AND fingerprint = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [companyId, issueId, fingerprint],
  );
  return member?.aggregate_key ?? null;
}

async function recoverStateFromAggregateMember(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<AlertStateRecord | null> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return null;
  const ns = ctx.db.namespace;
  const [member] = await ctx.db.query<{ issue_id: string; aggregate_key: string }>(
    `SELECT issue_id, aggregate_key
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1
       AND fingerprint = $2
       AND resolved_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
    [companyId, alert.fingerprint],
  );
  if (!member) return null;
  const issue = await ctx.issues.get(member.issue_id, companyId);
  if (!issue || issue.status === "done" || issue.status === "cancelled") {
    return null;
  }
  return buildRecoveredStateRecord(companyId, issue, alert, config, member.aggregate_key);
}

function rebindAlertState(
  record: AlertStateRecord,
  issue: IssueReference,
): AlertStateRecord {
  return {
    ...record,
    paperclipIssueId: issue.id,
    assigneeUserId: issue.assigneeUserId ?? record.assigneeUserId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? record.assigneeAgentId ?? null,
  };
}

function isAggregateCreationConflict(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);
  return message.includes("Alertmanager aggregate creation conflict");
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Verify `Authorization: Bearer <token>` against the configured token.
 * Constant-time comparison; rejects on missing token, missing header,
 * length mismatch.
 */
export function verifyBearerToken(
  headers: Record<string, string | string[]>,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) return false;
  const raw =
    pickHeader(headers, "authorization") ??
    pickHeader(headers, "Authorization");
  if (!raw) return false;
  const expected = `Bearer ${expectedToken}`;
  if (raw.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(raw), Buffer.from(expected));
}

function pickHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/**
 * Type-guard that an unknown body matches the AM v2 envelope shape.
 * Doesn't validate every label/annotation entry — Alertmanager always
 * sends strings and rejecting on a stray non-string value would be fragile.
 */
export function isAlertmanagerPayload(
  body: unknown,
): body is AlertmanagerWebhookPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.version !== "string") return false;
  if (typeof b.status !== "string") return false;
  if (!Array.isArray(b.alerts)) return false;
  for (const alert of b.alerts) {
    if (!alert || typeof alert !== "object") return false;
    const a = alert as Record<string, unknown>;
    if (typeof a.status !== "string") return false;
    if (typeof a.fingerprint !== "string") return false;
    if (typeof a.startsAt !== "string") return false;
    if (typeof a.endsAt !== "string") return false;
    if (!a.labels || typeof a.labels !== "object") return false;
    if (!a.annotations || typeof a.annotations !== "object") return false;
  }
  return true;
}

/**
 * Read a fingerprint's dedup row from its owning company's scope, migrating a
 * pre-BLO-20467 instance-scoped row on first sight.
 *
 * The migration is gated on `paperclipCompanyId`: a legacy row is adopted only
 * by the company whose issue it actually tracks. A row belonging to another
 * tenant is ignored (and left in place), which is precisely the cross-tenant
 * reuse this change exists to stop. Without the read-through, every alert
 * firing at upgrade time would look new — duplicating live issues and orphaning
 * the originals so their resolution could never close them.
 */
async function readAlertState(
  ctx: PluginContext,
  companyId: string,
  fingerprint: string,
): Promise<{ ref: ReturnType<typeof alertStateRef>; record: AlertStateRecord | null }> {
  const ref = alertStateRef(companyId, fingerprint);
  const scoped = (await ctx.state.get(ref)) as AlertStateRecord | null;
  if (scoped) return { ref, record: scoped };

  const legacyRef = legacyInstanceAlertStateRef(fingerprint);
  const legacy = (await ctx.state.get(legacyRef)) as AlertStateRecord | null;
  if (legacy && legacy.paperclipCompanyId === companyId) {
    await ctx.state.set(ref, legacy);
    try {
      await ctx.state.delete(legacyRef);
    } catch (err) {
      // The scoped copy is already durable, so the migration has taken effect;
      // a stale legacy row is inert (only this company could ever adopt it, and
      // it will never be read again now that the scoped row exists).
      ctx.logger.warn(
        `paperclip-plugin-alertmanager: migrated alert ${fingerprint} to company scope but could not remove the legacy row: ${String(err)}`,
      );
    }
    return { ref, record: legacy };
  }
  return { ref, record: null };
}

/**
 * §8.1 — first time we see a fingerprint, create an issue. On re-fire, just
 * bump `lastFiredAt` and re-emit the firing event. On re-fire after a manual
 * close, re-open the existing issue (§8.3 option A).
 */
export async function handleFiring(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  // Resolved up front because it now scopes the state read, not just issue
  // creation. Without it there is no namespace to look in, so a delivery that
  // could not have created an issue anyway is dropped here instead of after a
  // guaranteed-miss lookup.
  const companyId = config.defaultCompanyId;
  if (!companyId) {
    ctx.logger.warn(
      `Cannot track alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }
  const { ref: stateRef, record: stateRecord } = await readAlertState(
    ctx,
    companyId,
    alert.fingerprint,
  );
  // BLO-20467: `issues.create` below commits before its `state.set`, so a
  // state-store failure in between leaves a real issue with no state row. That
  // delivery now fails (rather than being acknowledged), so Alertmanager
  // retries it — and a retry that trusted the state miss would file a *second*
  // issue for the same fingerprint, turning a repeating state-store outage into
  // a duplicate-issue storm. Reconciling against the issue the previous attempt
  // already created is what makes the retry idempotent.
  //
  // This is the same `state ?? recover-from-issue` fallback the resolved path
  // has always used; only the firing path was missing it.
  const existing = stateRecord ?? (await recoverStateFromIssue(ctx, config, alert));
  const nowIso = new Date().toISOString();
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const severity = alert.labels.severity ?? "unknown";
  const storedAggregateKey = existing
    ? (existing.aggregateKey ??
      (await findAggregateMemberKey(
        ctx,
        existing.paperclipCompanyId,
        existing.paperclipIssueId,
        alert.fingerprint,
      )))
    : null;
  const aggregateKey = storedAggregateKey ?? aggregateKeyForAlert(alert);

  if (!existing && (alert.labels.severity ?? "").trim().toLowerCase() === "info") {
    ctx.logger.info(
      `Alertmanager: ${alertname} is below the issue creation floor (severity=info)`,
    );
    try {
      await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
        alertname,
        severity: "info",
      });
    } catch (metricErr) {
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to record issue floor metric for ${alert.fingerprint}: ${String(metricErr)}`,
      );
    }
    return;
  }

  const firingToken = await beginAggregateFiring(ctx, companyId, aggregateKey);
  if (!firingToken) {
    throw new Error(
      `Alertmanager aggregate ${aggregateKey} is finalizing; retrying firing delivery`,
    );
  }

  try {

  if (existing && existing.paperclipIssueId) {
    // Re-fire: refresh body (drill-in URLs may carry a fresh time range) and
    // re-open if the plugin previously auto-cancelled it on resolve.
    let tracked = existing;
    const newDescription = buildIssueDescription(alert);
    try {
      const issue = await ctx.issues.get(
        existing.paperclipIssueId,
        existing.paperclipCompanyId,
      );
      if (
        issue &&
        (issue.status === "done" || issue.status === "cancelled") &&
        existing.resolvedAt
      ) {
        const activeAggregateIssue = await findActiveAggregateIssue(
          ctx,
          existing.paperclipCompanyId,
          aggregateKey,
        );
        if (
          activeAggregateIssue &&
          activeAggregateIssue.id !== existing.paperclipIssueId
        ) {
          tracked = rebindAlertState(existing, activeAggregateIssue);
          await ctx.issues.update(
            activeAggregateIssue.id,
            { description: newDescription },
            existing.paperclipCompanyId,
          );
          await ctx.metrics.write("alertmanager.aggregate.rebound", 1, {
            alertname,
            severity,
          });
        } else {
          try {
            await ctx.issues.update(
              existing.paperclipIssueId,
              { status: "todo", description: newDescription },
              existing.paperclipCompanyId,
            );
            await ctx.metrics.write("alertmanager.firing.reopened", 1, {
              alertname,
              severity,
            });
          } catch (err) {
            const reboundIssue = await findActiveAggregateIssue(
              ctx,
              existing.paperclipCompanyId,
              aggregateKey,
            );
            if (!reboundIssue || reboundIssue.id === existing.paperclipIssueId) {
              throw err;
            }
            tracked = rebindAlertState(existing, reboundIssue);
            await ctx.issues.update(
              reboundIssue.id,
              { description: newDescription },
              existing.paperclipCompanyId,
            );
            await ctx.metrics.write("alertmanager.aggregate.rebound", 1, {
              alertname,
              severity,
            });
          }
        }
      } else if (issue && issue.status !== "done" && issue.status !== "cancelled") {
        await ctx.issues.update(
          existing.paperclipIssueId,
          { description: newDescription },
          existing.paperclipCompanyId,
        );
      }
    } catch (err) {
      ctx.logger.warn(
        `Failed to re-sync existing issue ${existing.paperclipIssueId} on re-fire: ${String(err)}`,
      );
    }

    await upsertAggregateMember(
      ctx,
      tracked.paperclipCompanyId,
      aggregateKey,
      tracked.paperclipIssueId,
      alert.fingerprint,
    );

    const updated: AlertStateRecord = {
      ...tracked,
      aggregateKey,
      alertname,
      severity,
      lastFiredAt: nowIso,
      resolvedAt: null,
      nextEscalationAt: existing.resolvedAt
        ? (() => {
            const delay = escalationDeadlineMs(alert, config);
            return delay === null ? null : new Date(Date.now() + delay).toISOString();
          })()
        : existing.nextEscalationAt,
      escalationAttempt: existing.resolvedAt ? 0 : existing.escalationAttempt,
      escalationComplete: existing.resolvedAt ? false : existing.escalationComplete,
      escalationIntervalMs: existing.resolvedAt
        ? escalationDeadlineMs(alert, config)
        : (existing.escalationIntervalMs ?? escalationDeadlineMs(alert, config)),
    };
    await ctx.state.set(stateRef, updated);

    await ctx.events.emit(
      "alertmanager.alert.firing",
      tracked.paperclipCompanyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        severity,
        labels: alert.labels,
        annotations: alert.annotations,
        paperclipIssueId: tracked.paperclipIssueId,
        assigneeUserId: tracked.assigneeUserId,
        assigneeAgentId: tracked.assigneeAgentId ?? null,
        reFired: true,
      },
    );
    await ctx.metrics.write("alertmanager.firing.deduped", 1, {
      alertname,
      severity,
    });
    return;
  }

  // First time we've seen this fingerprint — create a new issue. `companyId` is
  // already resolved and non-empty; it scoped the state read above.
  let retainedIssue = await findActiveAggregateIssue(ctx, companyId, aggregateKey);
  const issueRouteResolution = resolveIssueRoute(alert, config.issueRouteMap);
  const issueRoute = issueRouteResolution.route;
  const routeAssigneeAgentId = nonEmptyString(issueRoute?.assigneeAgentId);
  const routeHasAssigneeUserId = Object.prototype.hasOwnProperty.call(
    issueRoute ?? {},
    "assigneeUserId",
  );
  const routeAssigneeUserId = routeHasAssigneeUserId
    ? nonEmptyString(issueRoute?.assigneeUserId ?? undefined)
    : undefined;
  let createAssigneeAgentId: string | undefined;
  let createAssigneeUserId: string | undefined;
  let assigneeResolutionSource = "aggregate-winner";
  let resolvedTarget = "(aggregate-winner)";
  if (!retainedIssue) {
    const { assigneeUserId, assigneeAgentId, resolution } =
      await resolveAssigneeUserId(ctx, alert, config.ownerMap);
    const ownerOverride =
      resolution.source === "label-override" ||
      resolution.source === "annotation-override";
    createAssigneeAgentId = ownerOverride
      ? assigneeAgentId
      : routeAssigneeAgentId ?? assigneeAgentId;
    createAssigneeUserId = createAssigneeAgentId
      ? undefined
      : ownerOverride
        ? assigneeUserId
        : routeHasAssigneeUserId
          ? routeAssigneeUserId
          : assigneeUserId;
    if (!createAssigneeAgentId && !createAssigneeUserId) {
      createAssigneeAgentId = await resolveFallbackAgentId(
        ctx,
        companyId,
        config.fallbackAgentName,
      );
    }
    assigneeResolutionSource = resolution.source;
    resolvedTarget =
      resolution.agentId
        ? `agent:${resolution.agentId}`
        : resolution.email ?? "(none)";
  }
  if (!retainedIssue && !createAssigneeAgentId && !createAssigneeUserId) {
    ctx.logger.warn(
      `Cannot create issue for ${alertname}: fallbackAgentName is missing, invalid, or ambiguous`,
    );
    await ctx.metrics.write("alertmanager.owner.fallback_failed", 1, {
      alertname,
      severity,
    });
    throw new Error(
      `Fallback owner resolution failed for ${alertname}; refusing ownerless issue creation`,
    );
  }
  const routeProjectId = nonEmptyString(issueRoute?.projectId);
  const routeGoalId = nonEmptyString(issueRoute?.goalId);
  const routeStatus = issueRoute?.status;
  const resolvedAssignee =
    createAssigneeAgentId ?? createAssigneeUserId ?? "(no assignee)";
  ctx.logger.debug(
    `Owner resolution for ${alertname}: ${assigneeResolutionSource} → ${resolvedTarget} → ${resolvedAssignee}`,
  );
  if (issueRouteResolution.source) {
    ctx.logger.debug(
      `Issue route for ${alertname}: ${issueRouteResolution.source.labelKey}=${issueRouteResolution.source.labelValue}`,
    );
  }

  const title = buildIssueTitle(alert);
  const description = buildIssueDescription(alert);
  const priority = severityToPriority(severity, config.severityToPriority);

  const billingCode = alert.labels.billing_code ?? null;

  let created = retainedIssue === null;
  let issue = retainedIssue;
  if (!issue) {
    let claimToken: string | null = null;
    try {
      claimToken = await tryClaimAggregateCreation(ctx, companyId, aggregateKey);
      if (!claimToken) {
        const retained = await findActiveAggregateIssue(
          ctx,
          companyId,
          aggregateKey,
        );
        if (retained) {
          issue = retained;
          created = false;
        } else {
          throw new Error(
            `Alertmanager aggregate creation already in progress for ${aggregateKey}`,
          );
        }
      }
      if (!issue) {
        issue = await ctx.issues.create({
          companyId,
          title,
          description,
          priority,
          originKind: ORIGIN_KIND,
          originId: alert.fingerprint,
          originFingerprint: aggregateKey,
          ...(routeProjectId ? { projectId: routeProjectId } : {}),
          ...(routeGoalId ? { goalId: routeGoalId } : {}),
          ...(routeStatus ? { status: routeStatus } : {}),
          ...(createAssigneeUserId ? { assigneeUserId: createAssigneeUserId } : {}),
          ...(createAssigneeAgentId ? { assigneeAgentId: createAssigneeAgentId } : {}),
          ...(billingCode ? { billingCode } : {}),
        });
      }
    } catch (err) {
      if (!isAggregateCreationConflict(err)) throw err;
      const retained = await findActiveAggregateIssue(
        ctx,
        companyId,
        aggregateKey,
      );
      if (!retained) throw err;
      issue = retained;
      created = false;
    } finally {
      if (claimToken) {
        try {
          await releaseAggregateCreationClaim(
            ctx,
            companyId,
            aggregateKey,
            claimToken,
          );
        } catch (releaseErr) {
          ctx.logger.warn(
            `paperclip-plugin-alertmanager: failed to release aggregate creation claim for ${aggregateKey}: ${String(releaseErr)}`,
          );
        }
      }
    }
  }
  const effectiveAssigneeUserId = created
    ? createAssigneeUserId ?? null
    : issue.assigneeUserId ?? null;
  const effectiveAssigneeAgentId = created
    ? createAssigneeAgentId ?? null
    : issue.assigneeAgentId ?? null;

  const record: AlertStateRecord = {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    aggregateKey,
    assigneeUserId: effectiveAssigneeUserId,
    assigneeAgentId: effectiveAssigneeAgentId,
    alertname,
    severity,
    firstSeenAt: alert.startsAt || nowIso,
    lastFiredAt: nowIso,
    resolvedAt: null,
    nextEscalationAt: (() => {
      const delay = escalationDeadlineMs(alert, config);
      return delay === null ? null : new Date(Date.now() + delay).toISOString();
    })(),
    escalationAttempt: 0,
    escalationComplete: false,
    escalationIntervalMs: escalationDeadlineMs(alert, config),
  };
  await upsertAggregateMember(
    ctx,
    companyId,
    aggregateKey,
    issue.id,
    alert.fingerprint,
  );
  await ctx.state.set(stateRef, record);

  await ctx.events.emit("alertmanager.alert.firing", companyId, {
    fingerprint: alert.fingerprint,
    alertname,
    severity,
    labels: alert.labels,
    annotations: alert.annotations,
    paperclipIssueId: issue.id,
    assigneeUserId: effectiveAssigneeUserId,
    assigneeAgentId: effectiveAssigneeAgentId,
    reFired: !created,
  });

  await ctx.activity.log({
    companyId,
    message: created
      ? `Alertmanager: created issue for firing alert "${alertname}" (severity=${severity})`
      : `Alertmanager: attached firing alert "${alertname}" to aggregate issue (severity=${severity})`,
    entityType: "issue",
    entityId: issue.id,
    metadata: {
      fingerprint: alert.fingerprint,
      aggregateKey,
      created,
      assigneeResolutionSource,
      issueRouteSource: issueRouteResolution.source
        ? `${issueRouteResolution.source.labelKey}=${issueRouteResolution.source.labelValue}`
        : "no-match",
    },
  });

  if (!created) {
    await ctx.metrics.write("alertmanager.aggregate.joined", 1, {
      alertname,
      severity,
    });
  }

  await ctx.metrics.write("alertmanager.firing.handled", 1, {
    alertname,
    severity,
  });
  } finally {
    await finishAggregateFiring(ctx, companyId, aggregateKey, firingToken);
  }
}

/**
 * §8.2 — alert cleared. If we have state for the fingerprint, close or
 * comment per `autoCloseOnResolve`. If not, log and drop.
 */
async function ensureResolutionComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  resolvedAt: string,
) {
  const body = `Alert resolved at ${resolvedAt}.`;
  const comments = await ctx.issues.listComments(issueId, companyId);
  if (comments.some((comment) => comment.body === body)) return;
  await ctx.issues.createComment(issueId, body, companyId);
}

export async function handleResolved(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  // Same scoping rule as handleFiring: without a company there is no namespace
  // to look in, and `recoverStateFromIssue` could not query either.
  const companyId = config.defaultCompanyId;
  if (!companyId) {
    ctx.logger.warn(
      `Cannot resolve alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }
  const { ref: stateRef, record: stateRecord } = await readAlertState(
    ctx,
    companyId,
    alert.fingerprint,
  );
  const existing = stateRecord ?? (await recoverStateFromIssue(ctx, config, alert));
  if (!existing) {
    ctx.logger.info(
      `Alertmanager: resolved for unknown fingerprint ${alert.fingerprint}, dropping`,
    );
    return;
  }

  const resolvedAt = alert.endsAt || new Date().toISOString();
  const alertname = existing.alertname;
  const storedAggregateKey =
    existing.aggregateKey ??
    (await findAggregateMemberKey(
      ctx,
      existing.paperclipCompanyId,
      existing.paperclipIssueId,
      alert.fingerprint,
    ));
  const aggregateKey = storedAggregateKey ?? aggregateKeyForAlert(alert);
  const aggregateResolution = await resolveAggregateMember(
    ctx,
    existing.paperclipCompanyId,
    aggregateKey,
    existing.paperclipIssueId,
    alert.fingerprint,
    config.autoCloseOnResolve !== false,
  );
  let cancellationToken: string | null = null;

  try {
    if (config.autoCloseOnResolve !== false) {
      if (aggregateResolution.disposition === "finalization-pending") {
        throw new Error(
          `Alertmanager aggregate ${aggregateKey} is already finalizing; retrying resolution delivery`,
        );
      }
      // Old per-fingerprint records have no aggregate key or member row, so
      // retain their historical close behavior. Aggregate-tracked records are
      // fail-closed: a missing membership never authorizes cancellation.
      const shouldCancel =
        aggregateResolution.disposition === "last-member-resolved" ||
        (!storedAggregateKey && aggregateResolution.disposition === "no-membership");
      if (shouldCancel) {
        if (aggregateResolution.disposition === "last-member-resolved") {
          const resolutionToken = aggregateResolution.resolutionToken;
          if (
            !resolutionToken ||
            !(await beginAggregateCancellation(
              ctx,
              existing.paperclipCompanyId,
              aggregateKey,
              resolutionToken,
            ))
          ) {
            throw new Error(
              `Alertmanager aggregate ${aggregateKey} firing invalidated finalization; retrying resolution delivery`,
            );
          }
          cancellationToken = resolutionToken;
        }
        const issue = await ctx.issues.get(
          aggregateResolution.issueId,
          existing.paperclipCompanyId,
        );
        if (issue && issue.status !== "done" && issue.status !== "cancelled") {
          await ctx.issues.update(
            aggregateResolution.issueId,
            { status: "cancelled" },
            existing.paperclipCompanyId,
          );
        }
      } else if (aggregateResolution.disposition === "no-membership") {
        ctx.logger.warn(
          `Alertmanager: refusing to cancel aggregate issue ${aggregateResolution.issueId} for ${alert.fingerprint} because its membership is missing`,
        );
      }
    } else {
      await ensureResolutionComment(
        ctx,
        aggregateResolution.issueId,
        existing.paperclipCompanyId,
        resolvedAt,
      );
    }

    // BLO-16120: mark this source resolved within every cover it's a member
    // of, and close each cover only once its last unresolved member resolves.
    // Runs unconditionally (independent of autoCloseOnResolve) — the ladder
    // exhausted because the alert kept firing, not because the underlying
    // issue's status policy says so, so a resolved alert means its membership
    // in the shared cover is done either way.
    await recordSourceResolvedAndCloseCovers(
      ctx,
      existing.paperclipCompanyId,
      aggregateResolution.issueId,
    );

    const updated: AlertStateRecord = {
      ...existing,
      aggregateKey,
      paperclipIssueId: aggregateResolution.issueId,
      resolvedAt,
      nextEscalationAt: null,
      escalationComplete: true,
    };
    await ctx.state.set(stateRef, updated);

    await ctx.events.emit(
      "alertmanager.alert.resolved",
      existing.paperclipCompanyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        paperclipIssueId: aggregateResolution.issueId,
        resolvedAt,
      },
    );

    await ctx.metrics.write("alertmanager.resolved.handled", 1, {
      alertname,
      severity: existing.severity,
    });
  } finally {
    if (cancellationToken) {
      await releaseAggregateFinalization(
        ctx,
        existing.paperclipCompanyId,
        aggregateKey,
        cancellationToken,
      );
    }
  }
}

async function recoverStateFromIssue(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<AlertStateRecord | null> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return null;

  const matches = await ctx.issues.list({
    companyId,
    originKind: ORIGIN_KIND,
    originId: alert.fingerprint,
    limit: 1,
  });
  const issue = matches[0];
  if (!issue) return recoverStateFromAggregateMember(ctx, config, alert);
  if (issue.status === "done" || issue.status === "cancelled") return null;

  return buildRecoveredStateRecord(companyId, issue, alert, config);
}

function buildRecoveredStateRecord(
  companyId: string,
  issue: IssueReference,
  alert: AlertmanagerAlert,
  config: AlertmanagerPluginConfig,
  aggregateKey?: string,
): AlertStateRecord {
  return {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    ...(aggregateKey ? { aggregateKey } : {}),
    assigneeUserId: issue.assigneeUserId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    alertname: alert.labels.alertname ?? "UnnamedAlert",
    severity: alert.labels.severity ?? "unknown",
    firstSeenAt: alert.startsAt || new Date().toISOString(),
    lastFiredAt: alert.startsAt || new Date().toISOString(),
    resolvedAt: null,
    // BLO-20467: arm the ladder on the recovered record. The firing path now
    // adopts this when state was lost, and the re-fire branch carries these
    // fields through unchanged for a still-firing alert — so leaving them unset
    // would silently disarm escalation for exactly the alert whose state we
    // just had to reconstruct. Ladder progress made before the state loss is
    // not recoverable from the issue, so this restarts the ladder rather than
    // resuming it: a late page beats no page. Inert on the resolved path, which
    // overwrites both fields.
    nextEscalationAt: (() => {
      const delay = escalationDeadlineMs(alert, config);
      return delay === null ? null : new Date(Date.now() + delay).toISOString();
    })(),
    escalationAttempt: 0,
    escalationComplete: false,
    escalationIntervalMs: escalationDeadlineMs(alert, config),
  };
}

/**
 * Top-level webhook handler. Pure-ish: takes ctx + config + token + input,
 * returns void. Throws `WebhookUnauthorizedError` when the bearer token
 * fails verification — the worker's onWebhook re-throws this so the host
 * can surface a 401 / drop the delivery. Throws `AlertDeliveryIncompleteError`
 * when any alert in the batch failed to process, so the host records the
 * delivery `failed` and Alertmanager retries it.
 *
 * Returning normally is an acknowledgement: it makes the host answer HTTP 200
 * and ends Alertmanager's retries. Only do that when the delivery needs no
 * retry — a malformed or unsupported-version payload, or a filtered alert —
 * never when something that could succeed later has failed.
 */
export async function handleWebhook(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  resolvedToken: string | null,
  input: PluginWebhookInput,
): Promise<void> {
  if (input.endpointKey !== WEBHOOK_KEYS.alertmanager) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: ignoring webhook for unknown endpoint key "${input.endpointKey}"`,
    );
    return;
  }

  // Config-resolution outcome, not request-auth outcome: this reflects
  // whether the company has a usable credential configured at all, not
  // whether THIS request presented it correctly (BLO-20572).
  recordCredentialResolution(input.companyId, resolvedToken);

  if (!verifyBearerToken(input.headers, resolvedToken)) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: rejecting webhook — bearer token missing or invalid",
    );
    await ctx.metrics.write("alertmanager.webhook.unauthorized", 1);
    throw new WebhookUnauthorizedError();
  }

  const body = input.parsedBody;
  if (!isAlertmanagerPayload(body)) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: dropping webhook with malformed body",
    );
    await ctx.metrics.write("alertmanager.webhook.malformed", 1);
    return;
  }

  if (!ACCEPTED_SCHEMA_VERSIONS.has(body.version)) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: dropping webhook with unsupported schema version "${body.version}"`,
    );
    await ctx.metrics.write("alertmanager.webhook.unsupported_version", 1, {
      version: body.version,
    });
    return;
  }

  const failedFingerprints: string[] = [];

  for (const alert of body.alerts) {
    if (!alertMatchesLabelFilter(alert, config.acceptOnlyLabels)) {
      await ctx.metrics.write("alertmanager.webhook.filtered", 1, {
        alertname: alert.labels.alertname ?? "unknown",
      });
      continue;
    }

    const status = effectiveAlertStatus(alert, body);
    const alertname = alert.labels.alertname ?? "unknown";
    try {
      const policyValues = [
        alert.labels.paperclip_issue,
        alert.annotations.paperclip_issue,
      ];
      if (
        policyValues.some(
          (value) => value !== undefined && typeof value !== "string",
        )
      ) {
        ctx.logger.warn(
          `paperclip-plugin-alertmanager: dropping alert ${alert.fingerprint} because paperclip_issue must be a string when provided`,
        );
        try {
          await ctx.metrics.write("alertmanager.alert.malformed", 1, {
            alertname,
          });
        } catch (metricErr) {
          ctx.logger.error(
            `paperclip-plugin-alertmanager: failed to record malformed alert metric for ${alert.fingerprint}: ${String(metricErr)}`,
          );
        }
        continue;
      }
      const optedOut = policyValues.some(
        (value) =>
          typeof value === "string" && value.trim().toLowerCase() === "false",
      );
      if (optedOut) {
        ctx.logger.info(
          `Alertmanager: ${alertname} opted out via paperclip_issue=false`,
        );
        try {
          await ctx.metrics.write("alertmanager.webhook.issue_opt_out", 1, {
            alertname,
          });
        } catch (metricErr) {
          ctx.logger.error(
            `paperclip-plugin-alertmanager: failed to record issue opt-out metric for ${alert.fingerprint}: ${String(metricErr)}`,
          );
        }
        if (status !== "resolved") continue;
      }
      if (status === "firing") {
        await handleFiring(ctx, config, alert);
      } else if (status === "resolved") {
        await handleResolved(ctx, config, alert);
      } else {
        ctx.logger.warn(
          `paperclip-plugin-alertmanager: unknown alert status "${status}" for fingerprint ${alert.fingerprint}`,
        );
      }
    } catch (err) {
      // Catch per alert so one failure cannot abandon the rest of the batch —
      // but record it, because the delivery is NOT complete. Spec §5.2 step 3's
      // "log + 200" applies to a *malformed payload*, which is handled above and
      // is permanent; these failures are issue-RPC, state-store, event, and
      // metric errors, which are transient. Swallowing them answered HTTP 200,
      // so Alertmanager stopped retrying and the alert was destroyed with no
      // durable issue or state row — the same silent-loss class as the outage
      // this plugin already suffered (BLO-20467).
      ctx.logger.error(
        `paperclip-plugin-alertmanager: error processing alert ${alert.fingerprint}: ${String(err)}`,
      );
      failedFingerprints.push(alert.fingerprint);
      try {
        await ctx.metrics.write("alertmanager.alert.error", 1, {
          alertname: alert.labels.alertname ?? "unknown",
        });
      } catch (metricErr) {
        // Telemetry is best-effort; a metrics outage must not be the thing that
        // aborts the remaining alerts. The delivery already counts as failed.
        ctx.logger.error(
          `paperclip-plugin-alertmanager: failed to record alert error metric for ${alert.fingerprint}: ${String(metricErr)}`,
        );
      }
    }
  }

  if (failedFingerprints.length > 0) {
    // Replaying the whole batch is safe: handleFiring/handleResolved both key
    // off the stored per-fingerprint alert state, so alerts that already
    // succeeded update their existing issue rather than filing a duplicate.
    throw new AlertDeliveryIncompleteError(failedFingerprints);
  }
}
