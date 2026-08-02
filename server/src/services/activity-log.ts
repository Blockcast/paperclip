import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentApiKeys, companies, heartbeatRuns, issues, pluginEventOutbox } from "@paperclipai/db";
import { isUuidLike, PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  issue_thread_interaction_created: "issue.thread_interaction.created",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  // A withdrawal is a terminal transition out of `pending` exactly like the three
  // above, so plugin mirrors must see it or they keep showing the approval as
  // open forever. There is no dedicated `approval.withdrawn` plugin event; adding
  // one would break existing subscribers that already treat `approval.decided` as
  // "this approval left the queue", so it maps onto that.
  approval_withdrawn: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;
let _outboxDb: Db | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

/**
 * Wire the db used to enqueue plugin domain events into the cross-tier outbox.
 * Mirrors setPluginEventBus; both are set once at app boot on every tier.
 */
export function setPluginEventOutboxDb(db: Db): void {
  _outboxDb = db;
}

/** Accessor for the worker-tier outbox poller (the sole emitter). */
export function getPluginEventBus(): PluginEventBus | null {
  return _pluginEventBus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

/**
 * Enqueue a plugin domain event into the cross-tier outbox. This does NOT emit
 * in-process: the worker-tier poller (plugin-event-outbox.ts) is the sole
 * emitter, so events raised on any tier (notably the API tier, where plugins
 * are not loaded) reliably reach subscribed plugins. One writer + one emitter
 * ⇒ no double-delivery. Fire-and-forget to keep the signature synchronous.
 */
export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_outboxDb) {
    logger.warn(
      { eventType: event.eventType, eventId: event.eventId },
      "plugin event outbox db not set; dropping event",
    );
    return;
  }
  void _outboxDb
    .insert(pluginEventOutbox)
    .values({
      eventId: event.eventId,
      companyId: event.companyId,
      eventType: event.eventType,
      payload: event as unknown as Record<string, unknown>,
    })
    .catch((err) =>
      logger.warn({ err, eventType: event.eventType }, "failed to enqueue plugin event to outbox"),
    );
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
  issueId?: string | null;
  details?: Record<string, unknown> | null;
  /**
   * Extra fields merged into the emitted plugin domain event payload ONLY — not
   * persisted to the activity_log row. Use for data a subscribing plugin needs
   * in full but that would bloat or duplicate the activity log, e.g. an issue
   * comment's full `body` and `authorName` for the Linear comment bridge (the
   * persisted row keeps only a `bodySnippet`). Current-user / PII redaction is
   * applied; the key-based secret scrubber is not (see logActivity for why).
   */
  pluginEventPayloadExtra?: Record<string, unknown> | null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveResponsibleUserIdForActivity(db: Db, input: LogActivityInput) {
  if (input.actorType === "user") return readNonEmptyString(input.actorId);

  const runId = readNonEmptyString(input.runId);
  if (runId && isUuidLike(runId)) {
    const run = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)))
      .then((rows) => rows[0] ?? null);
    const runResponsibleUserId = readNonEmptyString(run?.responsibleUserId);
    if (runResponsibleUserId) return runResponsibleUserId;
  }

  const issueIdCandidate = readNonEmptyString(input.issueId)
    ?? (input.entityType === "issue" ? readNonEmptyString(input.entityId) : null);
  const issueId = isUuidLike(issueIdCandidate) ? issueIdCandidate : null;
  if (issueId) {
    const issue = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);
    const issueResponsibleUserId = readNonEmptyString(issue?.responsibleUserId)
      ?? readNonEmptyString(issue?.createdByUserId);
    if (issueResponsibleUserId) return issueResponsibleUserId;
  }

  const agentApiKeyId = readNonEmptyString(input.agentApiKeyId);
  const agentId = readNonEmptyString(input.agentId);
  if (agentApiKeyId && isUuidLike(agentApiKeyId)) {
    const apiKey = await db
      .select({ responsibleUserId: agentApiKeys.responsibleUserId })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.companyId, input.companyId),
        eq(agentApiKeys.id, agentApiKeyId),
        ...(agentId && isUuidLike(agentId) ? [eq(agentApiKeys.agentId, agentId)] : []),
      ))
      .then((rows) => rows[0] ?? null);
    const apiKeyResponsibleUserId = readNonEmptyString(apiKey?.responsibleUserId);
    if (apiKeyResponsibleUserId) return apiKeyResponsibleUserId;
  }

  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  return readNonEmptyString(company?.defaultResponsibleUserId);
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  const responsibleUserId = await resolveResponsibleUserIdForActivity(db, input);
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    responsibleUserId,
    details: redactedDetails,
  });

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      responsibleUserId,
      details: redactedDetails,
    },
  });

  const pluginEventType = eventTypeForActivityAction(input.action);
  if (pluginEventType) {
    // Event-only payload extras: merged into the emitted plugin event but never
    // written to the activity_log row above. We apply the current-user / PII
    // redactor but deliberately NOT the key-based secret scrubber
    // (sanitizeRecord): it false-positives on legitimate field names such as
    // "authorName" (the "auth" secret-key pattern) and would mangle the faithful
    // comment body the Linear bridge exists to mirror. Comment-body secret
    // scrubbing is not applied anywhere else in comment sync, so doing it only
    // here would be both inconsistent and lossy.
    const redactedEventExtra = input.pluginEventPayloadExtra
      ? (redactCurrentUserValue(
          input.pluginEventPayloadExtra,
          currentUserRedactionOptions,
        ) as Record<string, unknown>)
      : null;
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      companyId: input.companyId,
      payload: {
        ...redactedDetails,
        ...(redactedEventExtra ?? {}),
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        responsibleUserId,
      },
    };
    publishPluginDomainEvent(event);
  }
}
