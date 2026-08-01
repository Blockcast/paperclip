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
import { ACCEPTED_SCHEMA_VERSIONS, STATE_KEYS, WEBHOOK_KEYS } from "./constants.js";
import {
  alertMatchesLabelFilter,
  buildIssueDescription,
  buildIssueTitle,
  effectiveAlertStatus,
  severityToPriority,
} from "./issue-mapping.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { resolveAssigneeUserId, resolveFallbackAgentId } from "./owner-resolver.js";
import { escalationDeadlineMs, recordSourceResolvedAndCloseCovers } from "./escalation.js";
import {
  aggregateKeyForAlert,
  bindAggregateIssue,
  completeAggregateResolution,
  getAggregate,
  joinAggregate,
  resolveAggregateMember,
} from "./aggregate-store.js";
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

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const aggregateQueues = new Map<string, Promise<void>>();

async function withAggregateLock(
  alert: AlertmanagerAlert,
  work: () => Promise<void>,
): Promise<void> {
  const key = aggregateKeyForAlert(alert);
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
 * §8.1 — first time we see a fingerprint, create an issue. On re-fire, just
 * bump `lastFiredAt` and re-emit the firing event. On re-fire after a manual
 * close, re-open the existing issue (§8.3 option A).
 */
export async function handleFiring(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  const companyId = config.defaultCompanyId;
  if (!companyId) {
    ctx.logger.warn(
      `Cannot create issue for alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }

  const stateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.alert(alert.fingerprint),
  };
  const existing = (await ctx.state.get(stateRef)) as AlertStateRecord | null;
  const nowIso = new Date().toISOString();
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const severity = alert.labels.severity ?? "unknown";
  const aggregate = (ctx as Partial<PluginContext>).db
    ? await joinAggregate(ctx, companyId, alert)
    : {
        aggregateKey: alert.fingerprint,
        companyId,
        paperclipIssueId: existing?.paperclipIssueId ?? null,
        alertname,
        severity,
        assigneeUserId: existing?.assigneeUserId ?? null,
        assigneeAgentId: existing?.assigneeAgentId ?? null,
      };

  const existingIssueId =
    aggregate.paperclipIssueId ?? existing?.paperclipIssueId ?? null;
  const existingCompanyId = existing?.paperclipCompanyId ?? aggregate.companyId;
  if (existingIssueId) {
    if (!aggregate.paperclipIssueId) {
      await bindAggregateIssue(ctx, aggregate.aggregateKey, existingIssueId, {
        assigneeUserId: existing?.assigneeUserId ?? undefined,
      });
    }
    // Re-fire: refresh body and reopen a terminal aggregate issue.
    const newDescription = buildIssueDescription(alert);
    try {
      const issue = await ctx.issues.get(
        existingIssueId,
        existingCompanyId,
      );
      if (
        issue &&
        (issue.status === "done" || issue.status === "cancelled") &&
        existing?.resolvedAt
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
    } catch (err) {
      ctx.logger.warn(
        `Failed to re-sync existing issue ${existingIssueId} on re-fire: ${String(err)}`,
      );
    }

    const updated: AlertStateRecord = {
      paperclipIssueId: existingIssueId,
      paperclipCompanyId: existingCompanyId,
      assigneeUserId: existing?.assigneeUserId ?? aggregate.assigneeUserId,
      firstSeenAt: existing?.firstSeenAt ?? alert.startsAt ?? nowIso,
      alertname,
      severity,
      lastFiredAt: nowIso,
      resolvedAt: null,
      nextEscalationAt: existing?.resolvedAt
        ? (() => {
            const delay = escalationDeadlineMs(alert, config);
            return delay === null ? null : new Date(Date.now() + delay).toISOString();
          })()
        : existing?.nextEscalationAt,
      escalationAttempt: existing?.resolvedAt ? 0 : existing?.escalationAttempt,
      escalationComplete: existing?.resolvedAt ? false : existing?.escalationComplete,
      escalationIntervalMs: existing?.resolvedAt
        ? escalationDeadlineMs(alert, config)
        : (existing?.escalationIntervalMs ?? escalationDeadlineMs(alert, config)),
      aggregateKey: aggregate.aggregateKey,
      assigneeAgentId: existing?.assigneeAgentId ?? aggregate.assigneeAgentId,
    };
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
    await bindAggregateIssue(ctx, aggregate.aggregateKey, issue.id, {
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
  const stateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.alert(alert.fingerprint),
  };
  const stateRecord = (await ctx.state.get(stateRef)) as AlertStateRecord | null;
  const existing = stateRecord ?? (await recoverStateFromIssue(ctx, config, alert));
  const resolvedAt = alert.endsAt || new Date().toISOString();
  const aggregateKey = existing?.aggregateKey ?? aggregateKeyForAlert(alert);
  const resolution = (ctx as Partial<PluginContext>).db
    ? await resolveAggregateMember(
        ctx,
        aggregateKey,
        alert.fingerprint,
        resolvedAt,
      )
    : { memberKnown: false, finalResolutionClaim: null };
  const aggregate = (ctx as Partial<PluginContext>).db
    ? await getAggregate(ctx, aggregateKey)
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

  let resolutionApplied = false;
  try {
    if (config.autoCloseOnResolve !== false) {
      const issue = await ctx.issues.get(
        issueId,
        companyId,
      );
      if (issue && issue.status !== "done" && issue.status !== "cancelled") {
        await ctx.issues.update(
          issueId,
          { status: "cancelled" },
          companyId,
        );
      }
    } else {
      await ctx.issues.createComment(
        issueId,
        `Alert resolved at ${resolvedAt}.`,
        companyId,
      );
    }
    resolutionApplied = true;
  } catch (err) {
    ctx.logger.warn(
      `Failed to apply resolution to issue ${issueId}: ${String(err)}`,
    );
  }

  if (resolutionApplied) {
    try {
      await recordSourceResolvedAndCloseCovers(ctx, companyId, issueId);
    } catch (err) {
      ctx.logger.warn(
        `Failed to record resolution against escalation covers for issue ${issueId}: ${String(err)}`,
      );
    }
  }

  if (existing) {
    const updated: AlertStateRecord = {
      ...existing,
      resolvedAt,
      nextEscalationAt: null,
      escalationComplete: true,
    };
    await ctx.state.set(stateRef, updated);
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
  if (resolution.finalResolutionClaim && resolutionApplied) {
    await completeAggregateResolution(
      ctx,
      aggregateKey,
      resolution.finalResolutionClaim,
      resolvedAt,
    );
    ctx.logger.info(`Alertmanager: final resolution for aggregate ${aggregateKey}`);
    await ctx.metrics.write("alertmanager.aggregate.final_resolved", 1, {
      alertname,
      severity,
    });
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
  if (!issue) return null;
  if (issue.status === "done" || issue.status === "cancelled") return null;

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
  };
}

/**
 * Top-level webhook handler. Pure-ish: takes ctx + config + token + input,
 * returns void. Throws `WebhookUnauthorizedError` when the bearer token
 * fails verification — the worker's onWebhook re-throws this so the host
 * can surface a 401 / drop the delivery.
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
    if ((alert.labels.severity ?? "").trim().toLowerCase() === "info") {
      ctx.logger.info(`Alertmanager: ${alertname} suppressed by info creation floor`);
      await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
        alertname,
        severity: "info",
      });
      continue;
    }

    const status = effectiveAlertStatus(alert, body);
    try {
      await withAggregateLock(alert, async () => {
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
      // Spec §5.2 step 3: log + 200 on schema mismatch; same principle
      // here — don't let a single bad alert poison the whole batch.
      ctx.logger.error(
        `paperclip-plugin-alertmanager: error processing alert ${alert.fingerprint}: ${String(err)}`,
      );
      await ctx.metrics.write("alertmanager.alert.error", 1, {
        alertname: alert.labels.alertname ?? "unknown",
      });
    }
  }
}
