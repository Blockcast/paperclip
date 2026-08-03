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

async function findActiveAggregateIssue(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
) {
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

  if (existing && existing.paperclipIssueId) {
    // Re-fire: refresh body (drill-in URLs may carry a fresh time range) and
    // re-open if the plugin previously auto-cancelled it on resolve.
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
        await ctx.issues.update(
          existing.paperclipIssueId,
          { status: "todo", description: newDescription },
          existing.paperclipCompanyId,
        );
        await ctx.metrics.write("alertmanager.firing.reopened", 1, {
          alertname,
          severity,
        });
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

    const updated: AlertStateRecord = {
      ...existing,
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
      existing.paperclipCompanyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        severity,
        labels: alert.labels,
        annotations: alert.annotations,
        paperclipIssueId: existing.paperclipIssueId,
        assigneeUserId: existing.assigneeUserId,
        assigneeAgentId: existing.assigneeAgentId ?? null,
        reFired: true,
      },
    );
    await ctx.metrics.write("alertmanager.firing.deduped", 1, {
      alertname,
      severity,
    });
    return;
  }

  if ((alert.labels.severity ?? "").trim().toLowerCase() === "info") {
    ctx.logger.info(
      `Alertmanager: ${alertname} is below the issue creation floor (severity=info)`,
    );
    await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
      alertname,
      severity: "info",
    });
    return;
  }

  // First time we've seen this fingerprint — create a new issue. `companyId` is
  // already resolved and non-empty; it scoped the state read above.
  const aggregateKey = aggregateKeyForAlert(alert);
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
  let retainedIssue = null;
  if (!createAssigneeAgentId && !createAssigneeUserId) {
    retainedIssue = await findActiveAggregateIssue(ctx, companyId, aggregateKey);
    if (!retainedIssue) {
      createAssigneeAgentId = await resolveFallbackAgentId(
        ctx,
        companyId,
        config.fallbackAgentName,
      );
    }
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
  const resolvedTarget =
    resolution.agentId
      ? `agent:${resolution.agentId}`
      : resolution.email ?? "(none)";
  const resolvedAssignee =
    createAssigneeAgentId ?? createAssigneeUserId ?? "(no assignee)";
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

  let created = retainedIssue === null;
  let issue = retainedIssue;
  if (!issue) {
    try {
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
      assigneeResolutionSource: resolution.source,
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

  if (config.autoCloseOnResolve !== false) {
    const issue = await ctx.issues.get(
      existing.paperclipIssueId,
      existing.paperclipCompanyId,
    );
    if (issue && issue.status !== "done" && issue.status !== "cancelled") {
      await ctx.issues.update(
        existing.paperclipIssueId,
        { status: "cancelled" },
        existing.paperclipCompanyId,
      );
    }
  } else {
    await ensureResolutionComment(
      ctx,
      existing.paperclipIssueId,
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
  await recordSourceResolvedAndCloseCovers(ctx, existing.paperclipCompanyId, existing.paperclipIssueId);

  const updated: AlertStateRecord = {
    ...existing,
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
      paperclipIssueId: existing.paperclipIssueId,
      resolvedAt,
    },
  );

  await ctx.metrics.write("alertmanager.resolved.handled", 1, {
    alertname,
    severity: existing.severity,
  });
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
        await ctx.metrics.write("alertmanager.webhook.issue_opt_out", 1, {
          alertname,
        });
        continue;
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
