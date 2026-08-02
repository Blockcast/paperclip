/**
 * Webhook handler logic — separated from `worker.ts` so tests can drive it
 * without triggering the RPC host bootstrap that runs at module load time.
 *
 * All host interaction goes through the `PluginContext` argument; the
 * resolved bearer token is passed in explicitly so the handler stays
 * independent of how the operator chose to supply it (secret-ref vs inline).
 */

import { timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import {
  ACCEPTED_SCHEMA_VERSIONS,
  STATE_KEYS,
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
import {
  escalationDeadlineMs,
} from "./escalation.js";
import {
  aggregateKeyForAlert,
  bindAggregateIssue,
  completeAggregateReopen,
  getAggregate,
  joinAggregate,
  resolveAggregateMember,
} from "./aggregate-store.js";
import { applyAggregateResolution } from "./aggregate-reconciliation.js";
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

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const aggregateQueues = new Map<string, Promise<void>>();

async function withAggregateLock(
  companyId: string | undefined,
  alert: AlertmanagerAlert,
  work: () => Promise<void>,
): Promise<void> {
  const key = `${companyId ?? "unconfigured"}:${aggregateKeyForAlert(alert)}`;
  const previous = aggregateQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  aggregateQueues.set(key, queued);
  await previous;
  try {
    await work();
  } finally {
    release();
    if (aggregateQueues.get(key) === queued) aggregateQueues.delete(key);
  }
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
  const nowIso = new Date().toISOString();
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const severity = alert.labels.severity ?? "unknown";
  const aggregate = (ctx as Partial<PluginContext>).db
    ? await joinAggregate(ctx, companyId, alert)
    : {
        aggregateKey: alert.fingerprint,
        companyId,
        paperclipIssueId: stateRecord?.paperclipIssueId ?? null,
        alertname,
        severity,
        assigneeUserId: stateRecord?.assigneeUserId ?? null,
        assigneeAgentId: stateRecord?.assigneeAgentId ?? null,
        reopenRequired: false,
        resolutionClaim: null,
      };
  // A bound aggregate is the durable recovery record for a create/bind that
  // committed before its state write. Only query issue origin when binding did
  // not commit either; that closes the create-success/bind-failure window
  // without adding an origin lookup to every genuinely new aggregate.
  const existing = stateRecord ?? (aggregate.paperclipIssueId
    ? {
        paperclipIssueId: aggregate.paperclipIssueId,
        paperclipCompanyId: aggregate.companyId,
        assigneeUserId: aggregate.assigneeUserId,
        assigneeAgentId: aggregate.assigneeAgentId,
        alertname: aggregate.alertname,
        severity: aggregate.severity,
        firstSeenAt: alert.startsAt || nowIso,
        lastFiredAt: alert.startsAt || nowIso,
        resolvedAt: null,
        aggregateKey: aggregate.aggregateKey,
        nextEscalationAt: (() => {
          const delay = escalationDeadlineMs(alert, config);
          return delay === null ? null : new Date(Date.now() + delay).toISOString();
        })(),
        escalationAttempt: 0,
        escalationComplete: false,
        escalationIntervalMs: escalationDeadlineMs(alert, config),
      }
    : await recoverStateFromIssue(ctx, config, alert));
  const aggregateStateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.aggregate(companyId, aggregate.aggregateKey),
  };
  const aggregateState = (await ctx.state.get(
    aggregateStateRef,
  )) as AlertStateRecord | null;

  const existingIssueId =
    aggregate.paperclipIssueId ?? existing?.paperclipIssueId ?? null;
  const existingCompanyId = existing?.paperclipCompanyId ?? aggregate.companyId;
  if (existingIssueId) {
    const supersededLegacyIssueId =
      aggregate.paperclipIssueId && stateRecord?.paperclipIssueId !== aggregate.paperclipIssueId
        ? stateRecord?.paperclipIssueId
        : null;
    if (supersededLegacyIssueId) {
      const legacyIssue = await ctx.issues.get(supersededLegacyIssueId, companyId);
      if (legacyIssue && legacyIssue.status !== "done" && legacyIssue.status !== "cancelled") {
        await ctx.issues.update(
          supersededLegacyIssueId,
          { status: "cancelled" },
          companyId,
        );
        ctx.logger.info(
          `Alertmanager: cancelled superseded legacy issue ${supersededLegacyIssueId}; aggregate ${aggregate.aggregateKey} is bound to ${existingIssueId}`,
        );
        await ctx.metrics.write("alertmanager.aggregate.legacy_issue_superseded", 1, {
          alertname,
          severity,
        });
      }
    }
    if (!aggregate.paperclipIssueId) {
      await bindAggregateIssue(ctx, companyId, aggregate.aggregateKey, existingIssueId, {
        assigneeUserId: existing?.assigneeUserId ?? undefined,
      });
    }
    // Re-fire: refresh body and reopen a terminal aggregate issue.
    const newDescription = buildIssueDescription(alert);
    let issueSynchronized = false;
    try {
      const issue = await ctx.issues.get(
        existingIssueId,
        existingCompanyId,
      );
      if (
        issue &&
        (issue.status === "done" || issue.status === "cancelled") &&
        (existing?.resolvedAt || aggregateState?.resolvedAt || aggregate.reopenRequired)
      ) {
        await ctx.issues.update(
          existingIssueId,
          { status: "todo", description: newDescription },
          existingCompanyId,
        );
        await ctx.metrics.write("alertmanager.firing.reopened", 1, {
          alertname,
          severity,
        });
      } else if (issue && issue.status !== "done" && issue.status !== "cancelled") {
        await ctx.issues.update(
          existingIssueId,
          { description: newDescription },
          existingCompanyId,
        );
      }
      issueSynchronized = Boolean(issue);
    } catch (err) {
      ctx.logger.warn(
        `Failed to re-sync existing issue ${existingIssueId} on re-fire: ${String(err)}`,
      );
    }
    if (issueSynchronized && (ctx as Partial<PluginContext>).db) {
      await completeAggregateReopen(ctx, companyId, aggregate.aggregateKey);
    }

    const lifecycleState = aggregateState ?? existing;
    const updated: AlertStateRecord = {
      paperclipIssueId: existingIssueId,
      paperclipCompanyId: existingCompanyId,
      assigneeUserId: existing?.assigneeUserId ?? aggregate.assigneeUserId,
      firstSeenAt: existing?.firstSeenAt ?? alert.startsAt ?? nowIso,
      alertname,
      severity,
      lastFiredAt: nowIso,
      resolvedAt: null,
      nextEscalationAt: lifecycleState?.resolvedAt
        ? (() => {
            const delay = escalationDeadlineMs(alert, config);
            return delay === null ? null : new Date(Date.now() + delay).toISOString();
          })()
        : lifecycleState?.nextEscalationAt,
      escalationAttempt: lifecycleState?.resolvedAt ? 0 : lifecycleState?.escalationAttempt,
      escalationComplete: lifecycleState?.resolvedAt ? false : lifecycleState?.escalationComplete,
      escalationIntervalMs: lifecycleState?.resolvedAt
        ? escalationDeadlineMs(alert, config)
        : (lifecycleState?.escalationIntervalMs ?? escalationDeadlineMs(alert, config)),
      aggregateKey: aggregate.aggregateKey,
      assigneeAgentId: existing?.assigneeAgentId ?? aggregate.assigneeAgentId,
    };
    if (!aggregateState || aggregateState.resolvedAt) {
      await ctx.state.set(aggregateStateRef, updated);
    }
    await ctx.state.set(stateRef, updated);

    await ctx.events.emit(
      "alertmanager.alert.firing",
      existingCompanyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        severity,
        labels: alert.labels,
        annotations: alert.annotations,
        paperclipIssueId: existingIssueId,
        assigneeUserId: existing?.assigneeUserId ?? aggregate.assigneeUserId,
        assigneeAgentId: existing?.assigneeAgentId ?? aggregate.assigneeAgentId,
        reFired: true,
      },
    );
    await ctx.metrics.write("alertmanager.firing.deduped", 1, {
      alertname,
      severity,
    });
    if ((ctx as Partial<PluginContext>).db) {
      ctx.logger.info(
        `Alertmanager: joined ${alert.fingerprint} to aggregate ${aggregate.aggregateKey}`,
      );
      await ctx.metrics.write("alertmanager.aggregate.joined", 1, {
        alertname,
        severity,
      });
    }
    return;
  }

  // First time we've seen this fingerprint — create a new issue. `companyId` is
  // already resolved and non-empty; it scoped the state read above.
  const { assigneeUserId, assigneeAgentId, resolution } =
    await resolveAssigneeUserId(ctx, alert, config.ownerMap);
  const issueRouteResolution = resolveIssueRoute(alert, config.issueRouteMap);
  const issueRoute = issueRouteResolution.route;
  const ownerOverride =
    resolution.source === "label-override" ||
    resolution.source === "annotation-override";
  const routeAssigneeAgentId = nonEmptyString(issueRoute?.assigneeAgentId);
  const routeHasAssigneeUserId = Object.prototype.hasOwnProperty.call(
    issueRoute ?? {},
    "assigneeUserId",
  );
  const routeAssigneeUserId = routeHasAssigneeUserId
    ? nonEmptyString(issueRoute?.assigneeUserId ?? undefined)
    : undefined;
  let createAssigneeAgentId = ownerOverride
    ? assigneeAgentId
    : routeAssigneeAgentId ?? assigneeAgentId;
  let createAssigneeUserId = createAssigneeAgentId
    ? undefined
    : ownerOverride
      ? assigneeUserId
      : routeHasAssigneeUserId
        ? routeAssigneeUserId
        : assigneeUserId;
  const routeProjectId = nonEmptyString(issueRoute?.projectId);
  const routeGoalId = nonEmptyString(issueRoute?.goalId);
  const routeStatus = issueRoute?.status;
  const resolvedTarget =
    resolution.agentId
      ? `agent:${resolution.agentId}`
      : resolution.email ?? "(none)";
  if (!createAssigneeAgentId && !createAssigneeUserId) {
    createAssigneeAgentId = await resolveFallbackAgentId(
      ctx,
      companyId,
      config.fallbackAgentName,
    );
  }
  if (!createAssigneeAgentId && !createAssigneeUserId) {
    ctx.logger.warn(
      `Cannot create issue for aggregate ${aggregate.aggregateKey}: no owner resolved and fallbackAgentName is missing or invalid`,
    );
    await ctx.metrics.write("alertmanager.owner.fallback_failed", 1, {
      alertname,
      severity,
    });
    return;
  }
  const resolvedAssignee = createAssigneeAgentId ?? createAssigneeUserId;
  ctx.logger.debug(
    `Owner resolution for ${alertname}: ${resolution.source} → ${resolvedTarget} → ${resolvedAssignee}`,
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

  let issue;
  let created = true;
  try {
    issue = await ctx.issues.create({
      companyId,
      title,
      description,
      priority,
      originKind: ORIGIN_KIND,
      originId: aggregate.aggregateKey,
      ...(routeProjectId ? { projectId: routeProjectId } : {}),
      ...(routeGoalId ? { goalId: routeGoalId } : {}),
      ...(routeStatus ? { status: routeStatus } : {}),
      ...(createAssigneeUserId ? { assigneeUserId: createAssigneeUserId } : {}),
      ...(createAssigneeAgentId ? { assigneeAgentId: createAssigneeAgentId } : {}),
      ...(billingCode ? { billingCode } : {}),
    });
  } catch (err) {
    const [winner] = await ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originId: aggregate.aggregateKey,
      limit: 1,
    });
    if (!winner) throw err;
    issue = winner;
    created = false;
  }
  if ((ctx as Partial<PluginContext>).db) {
    await bindAggregateIssue(ctx, companyId, aggregate.aggregateKey, issue.id, {
      assigneeUserId: createAssigneeUserId,
      assigneeAgentId: createAssigneeAgentId,
    });
  }

  const record: AlertStateRecord = {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    assigneeUserId: createAssigneeUserId ?? null,
    assigneeAgentId: createAssigneeAgentId ?? null,
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
    aggregateKey: aggregate.aggregateKey,
  };
  await ctx.state.set(aggregateStateRef, record);
  await ctx.state.set(stateRef, record);

  await ctx.events.emit("alertmanager.alert.firing", companyId, {
    fingerprint: alert.fingerprint,
    alertname,
    severity,
    labels: alert.labels,
    annotations: alert.annotations,
    paperclipIssueId: issue.id,
    assigneeUserId: createAssigneeUserId ?? null,
    assigneeAgentId: createAssigneeAgentId ?? null,
    reFired: !created,
  });

  await ctx.activity.log({
    companyId,
    message: `Alertmanager: created issue for firing alert "${alertname}" (severity=${severity})`,
    entityType: "issue",
    entityId: issue.id,
    metadata: {
      fingerprint: alert.fingerprint,
      aggregateKey: aggregate.aggregateKey,
      assigneeResolutionSource: resolution.source,
      issueRouteSource: issueRouteResolution.source
        ? `${issueRouteResolution.source.labelKey}=${issueRouteResolution.source.labelValue}`
        : "no-match",
    },
  });

  await ctx.metrics.write("alertmanager.firing.handled", 1, {
    alertname,
    severity,
  });
  if (!created) {
    await ctx.metrics.write("alertmanager.aggregate.joined", 1, {
      alertname,
      severity,
    });
  }
}

/**
 * §8.2 — alert cleared. If we have state for the fingerprint, close or
 * comment per `autoCloseOnResolve`. If not, log and drop.
 */
export async function handleResolved(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  const configuredCompanyId = config.defaultCompanyId;
  if (!configuredCompanyId) {
    ctx.logger.warn(
      `Cannot resolve alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }
  const { ref: stateRef, record: stateRecord } = await readAlertState(
    ctx,
    configuredCompanyId,
    alert.fingerprint,
  );
  const existing = stateRecord ?? (await recoverStateFromIssue(ctx, config, alert));
  const resolvedAt = alert.endsAt || new Date().toISOString();
  const aggregateKey = existing?.aggregateKey ?? aggregateKeyForAlert(alert);
  const resolution = (ctx as Partial<PluginContext>).db
      ? await resolveAggregateMember(
        ctx,
        configuredCompanyId,
        aggregateKey,
        alert.fingerprint,
        resolvedAt,
      )
    : { memberKnown: false, finalResolutionClaim: null };
  const aggregate = (ctx as Partial<PluginContext>).db
    ? await getAggregate(ctx, configuredCompanyId, aggregateKey)
    : null;
  if (!existing && !resolution.memberKnown) {
    ctx.logger.info(
      `Alertmanager: resolved for unknown fingerprint ${alert.fingerprint}, dropping`,
    );
    return;
  }
  const issueId = aggregate?.paperclipIssueId ?? existing?.paperclipIssueId;
  const companyId = aggregate?.companyId ?? existing?.paperclipCompanyId;
  const alertname =
    aggregate?.alertname ?? existing?.alertname ?? alert.labels.alertname ?? "unknown";
  const severity = aggregate?.severity ?? existing?.severity ?? alert.labels.severity ?? "unknown";
  if (!issueId || !companyId) {
    ctx.logger.warn(`Alertmanager: aggregate ${aggregateKey} has no bound issue`);
    return;
  }
  if (existing && !aggregate && !resolution.memberKnown) {
    // Some SDK/unit-test contexts predate plugin DB support. Production
    // contexts stage legacy cleanup into the durable aggregate saga below.
    if (!(ctx as Partial<PluginContext>).db) {
      if (config.autoCloseOnResolve !== false) {
        const issue = await ctx.issues.get(issueId, companyId);
        if (issue && issue.status !== "done" && issue.status !== "cancelled") {
          await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
        }
      } else {
        await ctx.issues.createComment(
          issueId,
          `Alert resolved at ${resolvedAt}.`,
          companyId,
        );
      }
      await ctx.state.set(stateRef, {
        ...existing,
        resolvedAt,
        nextEscalationAt: null,
        escalationComplete: true,
      });
      await ctx.events.emit("alertmanager.alert.resolved", companyId, {
        fingerprint: alert.fingerprint,
        alertname,
        paperclipIssueId: issueId,
        resolvedAt,
      });
      await ctx.metrics.write("alertmanager.resolved.handled", 1, {
        alertname,
        severity,
      });
      return;
    }
    const staged = await joinAggregate(ctx, companyId, alert);
    await bindAggregateIssue(ctx, companyId, aggregateKey, issueId, {
      assigneeUserId: existing.assigneeUserId ?? undefined,
      assigneeAgentId: existing.assigneeAgentId ?? undefined,
    });
    const stagedResolution = await resolveAggregateMember(
      ctx,
      companyId,
      aggregateKey,
      alert.fingerprint,
      resolvedAt,
    );
    if (stagedResolution.finalResolutionClaim) {
      const completion = await applyAggregateResolution(ctx, config, {
        ...staged,
        paperclipIssueId: issueId,
        claim: stagedResolution.finalResolutionClaim,
        resolvedAt,
      });
      if (completion === "failed") {
        throw new Error(`Failed to apply aggregate resolution for ${aggregateKey}`);
      }
    }
    await ctx.state.set(stateRef, {
      ...existing,
      aggregateKey,
      resolvedAt,
      nextEscalationAt: null,
      escalationComplete: true,
    });
    await ctx.events.emit("alertmanager.alert.resolved", companyId, {
      fingerprint: alert.fingerprint,
      alertname,
      paperclipIssueId: issueId,
      resolvedAt,
    });
    await ctx.metrics.write("alertmanager.resolved.handled", 1, {
      alertname,
      severity,
    });
    return;
  }
  if (resolution.memberKnown && !resolution.finalResolutionClaim) {
    if (existing) {
      await ctx.state.set(stateRef, {
        ...existing,
        resolvedAt,
        nextEscalationAt: null,
        escalationComplete: true,
      });
    }
    await ctx.events.emit(
      "alertmanager.alert.resolved",
      companyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        paperclipIssueId: issueId,
        resolvedAt,
        aggregateStillFiring: true,
      },
    );
    await ctx.metrics.write("alertmanager.aggregate.member_resolved", 1, {
      alertname,
    });
    return;
  }

  const resolvedState = existing
    ? {
        ...existing,
        aggregateKey,
        resolvedAt,
        nextEscalationAt: null,
        escalationComplete: true,
      }
    : null;
  if (resolution.finalResolutionClaim) {
    const completion = await applyAggregateResolution(
      ctx,
      config,
      {
        aggregateKey,
        companyId,
        paperclipIssueId: issueId,
        alertname,
        severity,
        assigneeUserId: aggregate?.assigneeUserId ?? null,
        assigneeAgentId: aggregate?.assigneeAgentId ?? null,
        reopenRequired: aggregate?.reopenRequired ?? false,
        resolutionClaim: aggregate?.resolutionClaim ?? null,
        claim: resolution.finalResolutionClaim,
        resolvedAt,
      },
    );
    if (completion === "failed") {
      throw new Error(`Failed to apply aggregate resolution for ${aggregateKey}`);
    }
    if (completion === "completed") {
      if (resolvedState) {
        await ctx.state.set(
          {
            scopeKind: "instance",
            stateKey: STATE_KEYS.aggregate(companyId, aggregateKey),
          },
          resolvedState,
        );
      }
    } else if (completion === "firing") {
      ctx.logger.info(
        `Alertmanager: resolution fence for aggregate ${aggregateKey} was invalidated by a re-fire`,
      );
    }
  }
  if (resolvedState) {
    await ctx.state.set(stateRef, resolvedState);
  }

  await ctx.events.emit(
    "alertmanager.alert.resolved",
    companyId,
    {
      fingerprint: alert.fingerprint,
      alertname,
      paperclipIssueId: issueId,
      resolvedAt,
    },
  );

  await ctx.metrics.write("alertmanager.resolved.handled", 1, {
    alertname,
    severity,
  });
}

async function recoverStateFromIssue(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<AlertStateRecord | null> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return null;

  const aggregateKey = aggregateKeyForAlert(alert);
  let matches = await ctx.issues.list({
    companyId,
    originKind: ORIGIN_KIND,
    originId: aggregateKey,
    limit: 1,
  });
  if (matches.length === 0) {
    matches = await ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originId: alert.fingerprint,
      limit: 1,
    });
  }
  const issue = matches[0];
  if (!issue) return null;
  if (issue.status === "done" || issue.status === "cancelled") return null;

  if ((ctx as Partial<PluginContext>).db) {
    await bindAggregateIssue(ctx, companyId, aggregateKey, issue.id, {
      assigneeUserId: issue.assigneeUserId ?? undefined,
      assigneeAgentId: issue.assigneeAgentId ?? undefined,
    });
  }

  return {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    assigneeUserId: issue.assigneeUserId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    alertname: alert.labels.alertname ?? "UnnamedAlert",
    severity: alert.labels.severity ?? "unknown",
    firstSeenAt: alert.startsAt || new Date().toISOString(),
    lastFiredAt: alert.startsAt || new Date().toISOString(),
    resolvedAt: null,
    aggregateKey,
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

    const alertname = alert.labels.alertname ?? "unknown";
    const optedOut =
      (alert.labels.paperclip_issue ?? alert.annotations.paperclip_issue)
        ?.trim()
        .toLowerCase() === "false";
    if (optedOut) {
      ctx.logger.info(`Alertmanager: ${alertname} opted out via paperclip_issue=false`);
      await ctx.metrics.write("alertmanager.webhook.issue_opt_out", 1, {
        alertname,
      });
      continue;
    }
    const status = effectiveAlertStatus(alert, body);
    if (
      status === "firing" &&
      (alert.labels.severity ?? "").trim().toLowerCase() === "info"
    ) {
      ctx.logger.info(`Alertmanager: ${alertname} suppressed by info creation floor`);
      await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
        alertname,
        severity: "info",
      });
      continue;
    }

    try {
      await withAggregateLock(config.defaultCompanyId, alert, async () => {
        if (status === "firing") {
          await handleFiring(ctx, config, alert);
        } else if (status === "resolved") {
          await handleResolved(ctx, config, alert);
        } else {
          ctx.logger.warn(
            `paperclip-plugin-alertmanager: unknown alert status "${status}" for fingerprint ${alert.fingerprint}`,
          );
        }
      });
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
