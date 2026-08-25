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
  DEFAULT_OPERATOR_SUPPRESSION_HOURS,
  MAX_OPERATOR_SUPPRESSION_HOURS,
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

/**
 * Largest bearer credential worth sending to the host for verification.
 *
 * Mirrors the host's own `MAX_PRESENTED_SECRET_BYTES`
 * (`server/src/services/plugin-secrets-handler.ts`). Anything larger is
 * rejected there as `presented_secret_invalid` — an error, not a `false` — so
 * without this cap an oversized `Authorization` header turns a plainly-wrong
 * credential into a failed delivery that Alertmanager then retries. No secret
 * budget is spent either way (the host checks size before any database work),
 * but the retry volume and error rate are anonymous-triggerable, so reject the
 * over-long credential here and answer 401 instead.
 */
const MAX_BEARER_CREDENTIAL_BYTES = 4_096;

export function readBearerCredential(
  headers: Record<string, string | string[]>,
): string | null {
  const raw =
    pickHeader(headers, "authorization") ??
    pickHeader(headers, "Authorization");
  if (!raw?.startsWith("Bearer ")) return null;
  const credential = raw.slice("Bearer ".length);
  if (credential.length === 0) return null;
  // Byte length, matching how the host measures it — a multi-byte UTF-8
  // credential inside the character limit can still exceed the byte limit.
  if (Buffer.byteLength(credential, "utf8") > MAX_BEARER_CREDENTIAL_BYTES) return null;
  return credential;
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
 * Milliseconds an operator-closed issue suppresses re-fires, or `null` for
 * "suppress indefinitely" (`operatorSuppressionHours: 0`, the pre-BLO-24234
 * behaviour). A negative or non-finite setting is treated as unset rather than
 * silently disabling suppression in either direction, and an over-large one is
 * clamped to `MAX_OPERATOR_SUPPRESSION_HOURS` so the millisecond conversion
 * cannot overflow to `Infinity` (or to a finite-but-geological window) and
 * re-create the unbounded mute. The clamped value is what the operator-facing
 * labels report, so a clamped config shows up as the window it actually got.
 */
function operatorSuppressionMs(config: AlertmanagerPluginConfig): number | null {
  const hours = config.operatorSuppressionHours;
  const effective =
    typeof hours === "number" && Number.isFinite(hours) && hours >= 0
      ? Math.min(hours, MAX_OPERATOR_SUPPRESSION_HOURS)
      : DEFAULT_OPERATOR_SUPPRESSION_HOURS;
  return effective === 0 ? null : effective * 60 * 60 * 1000;
}

/**
 * Decide what a re-fire should do to an issue that already exists for this
 * fingerprint. Split out from `handleFiring` so the four decision points the
 * incident review asked for are enumerable in one place, and testable without
 * driving a whole webhook delivery.
 *
 * `terminal + resolvedAt` means the plugin closed it when the alert cleared, so
 * a re-fire is a genuine recurrence → re-open. `terminal` with no `resolvedAt`
 * means a human closed it while the alert was still firing → honour that, but
 * only until the suppression window expires (BLO-24234).
 */
type RefireDecision =
  | { kind: "refresh" }
  | { kind: "reopen"; reason: "plugin_resolved" | "suppression_expired" }
  | { kind: "suppressed"; suppressedAt: string; firstObservation: boolean }
  | { kind: "issue_missing" };

export function decideRefire(
  issue: { status: string } | null | undefined,
  existing: Pick<AlertStateRecord, "resolvedAt" | "operatorSuppressedAt">,
  config: AlertmanagerPluginConfig,
  nowMs: number,
): RefireDecision {
  if (!issue) return { kind: "issue_missing" };

  const terminal = issue.status === "done" || issue.status === "cancelled";
  if (!terminal) return { kind: "refresh" };
  if (existing.resolvedAt) return { kind: "reopen", reason: "plugin_resolved" };

  // Operator-closed. Anchor the window on the first re-fire we see against the
  // closed issue — not on the close itself, which the plugin never observes.
  const suppressedAt = existing.operatorSuppressedAt ?? new Date(nowMs).toISOString();
  const firstObservation = !existing.operatorSuppressedAt;
  const windowMs = operatorSuppressionMs(config);
  if (windowMs === null) return { kind: "suppressed", suppressedAt, firstObservation };

  const anchorMs = Date.parse(suppressedAt);
  // An unparseable anchor (hand-edited or corrupted state row) must not mute the
  // alert forever — re-anchor to now and keep suppressing for one more window.
  if (!Number.isFinite(anchorMs)) {
    return {
      kind: "suppressed",
      suppressedAt: new Date(nowMs).toISOString(),
      firstObservation: true,
    };
  }
  if (nowMs - anchorMs >= windowMs) {
    return { kind: "reopen", reason: "suppression_expired" };
  }
  return { kind: "suppressed", suppressedAt, firstObservation };
}

/**
 * Human-readable suppression window for log lines and the re-open comment.
 */
function operatorSuppressionHoursLabel(config: AlertmanagerPluginConfig): string {
  const ms = operatorSuppressionMs(config);
  if (ms === null) return "indefinite";
  return `${ms / (60 * 60 * 1000)}h`;
}

/** When the current suppression window runs out, for operator-facing logs. */
function suppressionExpiryLabel(
  suppressedAt: string,
  config: AlertmanagerPluginConfig,
): string {
  const ms = operatorSuppressionMs(config);
  if (ms === null) return "never (operatorSuppressionHours=0)";
  const anchorMs = Date.parse(suppressedAt);
  if (!Number.isFinite(anchorMs)) return "unknown (unparseable suppression anchor)";
  return new Date(anchorMs + ms).toISOString();
}

/**
 * Per-delivery memo for the named-fallback owner lookup.
 *
 * `resolveFallbackAgentId` is one unwindowed `ctx.agents.list({ companyId })`,
 * and that call is not cheap on the host side: `server/src/services/agents.ts`
 * issues two full-table selects for the company (the filtered rows plus the org
 * chain) and then `hydrateAgentSpend`, which aggregates `costEvents` for the
 * current month. The fallback rung is also the *common* path — by BLO-20576's
 * own numbers most firing alerts resolve to no owner — so without a memo every
 * alert in a batch pays it, and a storm is exactly when the batch is largest
 * and the host is busiest.
 *
 * The resolution is constant for a given `(companyId, fallbackAgentName)`
 * within a single `handleWebhook` call, so caching it there collapses N host
 * round-trips to one without changing any semantics. Scoping the memo to the
 * delivery (rather than the module) is what keeps it correct: a config edit or
 * an agent being paused takes effect on the very next delivery.
 */
export type FallbackOwnerMemo = Map<string, Promise<string | undefined>>;

function resolveFallbackAgentIdMemoized(
  ctx: Pick<PluginContext, "agents" | "logger">,
  companyId: string,
  fallbackAgentName: string | undefined,
  memo: FallbackOwnerMemo | undefined,
): Promise<string | undefined> {
  if (!memo) return resolveFallbackAgentId(ctx, companyId, fallbackAgentName);
  // JSON-encoded pair rather than a naive `a + sep + b`: agent names are
  // operator-supplied config, so any single-character separator could be
  // embedded in a name to collide with another company's key.
  const key = JSON.stringify([companyId, fallbackAgentName ?? ""]);
  const cached = memo.get(key);
  if (cached) return cached;
  const pending = resolveFallbackAgentId(
    ctx,
    companyId,
    fallbackAgentName,
  ).catch((err: unknown) => {
    // Evict on failure. A refusal (bad name / paused / ambiguous) resolves to
    // `undefined` and IS cached — it is a config fact, stable for the delivery.
    // A *throw* is a transient host fault, and caching it would let one failed
    // `agents.list` poison every remaining alert in the batch, converting a
    // blip that previously cost one alert into a whole-delivery failure.
    memo.delete(key);
    throw err;
  });
  memo.set(key, pending);
  return pending;
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
  fallbackOwnerMemo?: FallbackOwnerMemo,
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
    // re-open if the plugin previously auto-cancelled it on resolve, or if an
    // operator's close has aged past the suppression window (BLO-24234).
    const newDescription = buildIssueDescription(alert);
    // Carried out of the try so the state write below records what actually
    // happened. A decision the RPC then failed to apply must not be persisted
    // as applied — otherwise a transient issues.update outage would bank the
    // suppression anchor (or clear it) on the strength of a call that never
    // landed, and the next re-fire would reason from a fiction.
    let decision: RefireDecision = { kind: "issue_missing" };
    let decisionApplied = false;
    try {
      const issue = await ctx.issues.get(
        existing.paperclipIssueId,
        existing.paperclipCompanyId,
      );
      decision = decideRefire(issue, existing, config, Date.now());

      if (decision.kind === "reopen") {
        await ctx.issues.update(
          existing.paperclipIssueId,
          { status: "todo", description: newDescription },
          existing.paperclipCompanyId,
        );
        if (decision.reason === "suppression_expired") {
          // Say why the close did not stick, on the issue itself — an operator
          // who closed this yesterday needs to know it re-opened because the
          // alert never stopped firing, not because something ignored them.
          try {
            await ctx.issues.createComment(
              existing.paperclipIssueId,
              `Re-opened by paperclip-plugin-alertmanager: this issue was closed by hand, but \`${alertname}\` has kept firing past the ${operatorSuppressionHoursLabel(config)} suppression window. Closing it again will suppress it for another window; silence the alert rule itself if it should stop paging.`,
              existing.paperclipCompanyId,
            );
          } catch (commentErr) {
            // The re-open is the load-bearing half and has already landed.
            ctx.logger.warn(
              `Re-opened issue ${existing.paperclipIssueId} after suppression expiry but could not post the explanatory comment: ${String(commentErr)}`,
            );
          }
          await ctx.metrics.write("alertmanager.firing.suppression_expired", 1, {
            alertname,
            severity,
          });
        }
        await ctx.metrics.write("alertmanager.firing.reopened", 1, {
          alertname,
          severity,
        });
      } else if (decision.kind === "refresh") {
        await ctx.issues.update(
          existing.paperclipIssueId,
          { description: newDescription },
          existing.paperclipCompanyId,
        );
      } else if (decision.kind === "suppressed") {
        // The whole point of BLO-24234: this path used to be entirely silent,
        // emitting only `firing.deduped` — indistinguishable from a healthy
        // re-fire against an open issue. A muted fingerprint must be visible
        // as muted, every time it fires, or nobody can tell that a delivered
        // page produced no actionable artifact.
        if (decision.firstObservation) {
          ctx.logger.warn(
            `Alert ${alertname} (${alert.fingerprint}) re-fired against operator-closed issue ${existing.paperclipIssueId}; suppressing re-open until ${suppressionExpiryLabel(decision.suppressedAt, config)}`,
          );
        } else {
          ctx.logger.info(
            `Alert ${alertname} (${alert.fingerprint}) still suppressed by operator close of issue ${existing.paperclipIssueId} (until ${suppressionExpiryLabel(decision.suppressedAt, config)})`,
          );
        }
        await ctx.metrics.write("alertmanager.firing.suppressed", 1, {
          alertname,
          severity,
        });
      } else {
        // `issues.get` returned nothing — the issue was hard-deleted out from
        // under the state row. Previously this fell through both branches in
        // silence; say so, since the fingerprint is now tracking a ghost.
        ctx.logger.warn(
          `Alert ${alertname} (${alert.fingerprint}) re-fired but its tracked issue ${existing.paperclipIssueId} could not be read; leaving state intact`,
        );
        await ctx.metrics.write("alertmanager.firing.issue_missing", 1, {
          alertname,
          severity,
        });
      }
      decisionApplied = true;
    } catch (err) {
      ctx.logger.warn(
        `Failed to re-sync existing issue ${existing.paperclipIssueId} on re-fire: ${String(err)}`,
      );
    }

    // Ladder restart keeps its original trigger — the alert going
    // resolved → firing — which is independent of the issue's status: an
    // operator may have re-opened the issue by hand, in which case the branch
    // above is a plain `refresh` but `handleResolved` has still left
    // `nextEscalationAt` null and `escalationComplete` true. Gating this on the
    // re-open would silently disarm escalation for exactly that case.
    //
    // A suppression-expiry re-open is the one new trigger: the ladder has been
    // frozen for the whole suppression window, so the now-visible issue needs a
    // live deadline or it will never page anyone.
    const suppressionExpiryReopen =
      decisionApplied &&
      decision.kind === "reopen" &&
      decision.reason === "suppression_expired";
    const ladderRestart = Boolean(existing.resolvedAt) || suppressionExpiryReopen;
    // Only a decision we actually applied may move the anchor. `issue_missing`
    // preserves it: the issue was unreadable, so we learned nothing about
    // whether the operator's close still stands, and dropping the anchor would
    // restart the whole window on the next readable re-fire.
    const suppressionAnchor =
      !decisionApplied || decision.kind === "issue_missing"
        ? (existing.operatorSuppressedAt ?? null)
        : decision.kind === "suppressed"
          ? decision.suppressedAt
          : null;

    const updated: AlertStateRecord = {
      ...existing,
      alertname,
      severity,
      lastFiredAt: nowIso,
      resolvedAt: null,
      operatorSuppressedAt: suppressionAnchor,
      nextEscalationAt: ladderRestart
        ? (() => {
            const delay = escalationDeadlineMs(alert, config);
            return delay === null ? null : new Date(Date.now() + delay).toISOString();
          })()
        : existing.nextEscalationAt,
      escalationAttempt: ladderRestart ? 0 : existing.escalationAttempt,
      escalationComplete: ladderRestart ? false : existing.escalationComplete,
      escalationIntervalMs: ladderRestart
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

  // Creation floor. Deliberately placed *after* the re-fire branch above and
  // before creation only: an `info` alert that already owns an issue (filed
  // before this floor existed) keeps being refreshed, and `handleResolved`
  // still closes it. Gating the whole delivery instead would strand those
  // legacy issues open forever, which is the resolution behavior this ticket
  // explicitly excludes from scope.
  //
  // Reads the `severity` already computed above rather than re-reading the
  // label: two normalizations of one value drift the moment either changes.
  if (severity.trim().toLowerCase() === "info") {
    ctx.logger.info(
      `Alertmanager: ${alertname} is below the issue creation floor (severity=info)`,
    );
    try {
      await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
        alertname,
        severity: "info",
      });
    } catch (metricErr) {
      // Best-effort: this drop is permanent policy, already decided. Letting a
      // metrics outage throw would mark the delivery failed and make
      // Alertmanager retry an alert we will drop identically every time.
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to record issue floor metric for ${alert.fingerprint}: ${String(metricErr)}`,
      );
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
  const createAssigneeAgentId = ownerOverride
    ? assigneeAgentId
    : routeAssigneeAgentId ?? assigneeAgentId;
  const createAssigneeUserId = createAssigneeAgentId
    ? undefined
    : ownerOverride
      ? assigneeUserId
      : routeHasAssigneeUserId
        ? routeAssigneeUserId
        : assigneeUserId;
  // Last rung of the owner chain. Before this, an unresolved owner fell through
  // to a conditional spread on `issues.create` that simply omitted the field —
  // so the alert landed as an ownerless issue, which nobody is woken for and
  // which auto-cancels unattended (BLO-27435 / BLO-27436 / BLO-27438 all did
  // exactly this on 2026-08-17). Assigning a configured named agent is what
  // makes an intake issue actionable.
  const fallbackAssigneeAgentId =
    createAssigneeAgentId || createAssigneeUserId
      ? undefined
      : await resolveFallbackAgentIdMemoized(
          ctx,
          companyId,
          config.fallbackAgentName,
          fallbackOwnerMemo,
        );
  const finalAssigneeAgentId = createAssigneeAgentId ?? fallbackAssigneeAgentId;
  if (!finalAssigneeAgentId && !createAssigneeUserId) {
    // Fail closed. Throwing (rather than returning) is deliberate: this is a
    // *configuration* fault, not a property of the alert, so the delivery is
    // genuinely incomplete. handleWebhook collects the fingerprint and answers
    // non-2xx, Alertmanager keeps retrying, and the alert survives until an
    // operator fixes `fallbackAgentName`. Returning here would acknowledge the
    // delivery and destroy the alert silently — the BLO-20467 loss class.
    ctx.logger.warn(
      `Cannot create issue for ${alertname}: fallbackAgentName is missing, unmatched, ambiguous, or matched only non-invokable agents; refusing ownerless issue creation`,
    );
    try {
      await ctx.metrics.write("alertmanager.owner.fallback_failed", 1, {
        alertname,
        severity,
      });
    } catch (metricErr) {
      // Unlike the policy drops above, this path throws either way — so the
      // wrapper is not about the delivery outcome, it is about the message.
      // An unwrapped metrics outage would replace the explicit
      // "Fallback owner resolution failed" below with an opaque metrics error,
      // degrading the diagnostic for exactly the misconfiguration this path
      // exists to surface.
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to record fallback owner failure metric for ${alert.fingerprint}: ${String(metricErr)}`,
      );
    }
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
    finalAssigneeAgentId ?? createAssigneeUserId ?? "(no assignee)";
  ctx.logger.debug(
    `Owner resolution for ${alertname}: ${resolution.source} → ${resolvedTarget} → ${resolvedAssignee}${
      fallbackAssigneeAgentId ? " (named fallback)" : ""
    }`,
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

  const issue = await ctx.issues.create({
    companyId,
    title,
    description,
    priority,
    originKind: ORIGIN_KIND,
    originId: alert.fingerprint,
    ...(routeProjectId ? { projectId: routeProjectId } : {}),
    ...(routeGoalId ? { goalId: routeGoalId } : {}),
    ...(routeStatus ? { status: routeStatus } : {}),
    ...(createAssigneeUserId ? { assigneeUserId: createAssigneeUserId } : {}),
    ...(finalAssigneeAgentId ? { assigneeAgentId: finalAssigneeAgentId } : {}),
    ...(billingCode ? { billingCode } : {}),
  });

  const record: AlertStateRecord = {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    assigneeUserId: createAssigneeUserId ?? null,
    assigneeAgentId: finalAssigneeAgentId ?? null,
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
    assigneeUserId: createAssigneeUserId ?? null,
    assigneeAgentId: finalAssigneeAgentId ?? null,
    reFired: false,
  });

  await ctx.activity.log({
    companyId,
    message: `Alertmanager: created issue for firing alert "${alertname}" (severity=${severity})`,
    entityType: "issue",
    entityId: issue.id,
    metadata: {
      fingerprint: alert.fingerprint,
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

/**
 * BLO-29908: the resolve-driven cancel pins both execution-lock columns to
 * `null`, so a row a live run holds fails the precondition instead of being
 * cancelled. `updateIssue` answers that with a 409 whose message is one of
 * three "…before the update could be applied" variants (checkout owner,
 * execution owner, or the in-transaction precondition catch-all).
 *
 * Matching the shared suffix is deliberate: those are the ONLY preconditions
 * this call sets, so any of them failing means exactly one thing — a lock
 * appeared or was already held. Anything else is a real fault and must
 * propagate so the delivery fails and Alertmanager retries, rather than being
 * silently reported as a withheld cancel.
 */
function isExecutionLockPreconditionFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("before the update could be applied");
}

/**
 * Marker line keyed on the holding run, not on `resolvedAt`. A flapping
 * fingerprint resolves twice an hour (BLO-29905 / BLO-29393), so keying the
 * idempotency on the timestamp would append a near-identical comment on every
 * cycle. One notification per holding run is the useful signal: it tells the
 * run that its subject cleared, once.
 */
function cancelWithheldMarker(runId: string): string {
  return `<!-- alertmanager:cancel-withheld:${runId} -->`;
}

async function ensureCancelWithheldComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  resolvedAt: string,
  runId: string,
) {
  const marker = cancelWithheldMarker(runId);
  const comments = await ctx.issues.listComments(issueId, companyId);
  if (comments.some((comment) => comment.body.includes(marker))) return;
  const body = [
    marker,
    `**Alert resolved at ${resolvedAt} — auto-cancel withheld.**`,
    "",
    `This issue is held by execution run \`${runId}\`, so \`paperclip-plugin-alertmanager\` left`,
    "the status untouched rather than cancelling the row and clearing the execution lock.",
    "",
    "- The underlying alert is no longer firing. If your investigation is done, close this issue yourself.",
    "- The lock is intact: nothing was released out from under the holding run.",
    "- Cancelling here is the holder's decision, not the bridge's ([BLO-29908](/BLO/issues/BLO-29908)).",
  ].join("\n");
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
  let cancelWithheldForRunId: string | null = null;

  if (config.autoCloseOnResolve !== false) {
    const issue = await ctx.issues.get(
      existing.paperclipIssueId,
      existing.paperclipCompanyId,
    );
    if (issue && issue.status !== "done" && issue.status !== "cancelled") {
      // Read for the diagnostic only. The *authorization* is the pair of
      // preconditions below, evaluated inside the update's transaction — this
      // snapshot is racy by construction and must never be the thing that
      // decides whether the cancel is safe.
      const holderRunId = issue.executionRunId ?? issue.checkoutRunId ?? null;
      try {
        await ctx.issues.update(
          existing.paperclipIssueId,
          {
            status: "cancelled",
            // BLO-29908. A resolve used to cancel unconditionally, and
            // `updateIssue` clears checkoutRunId/executionRunId/
            // executionAgentNameKey/executionLockedAt on any transition out of
            // `in_progress` — so the bridge silently evicted whatever run held
            // the row. Observed 46s after a live run wrote its findings
            // document, twice an hour per alert while a fingerprint flaps.
            //
            // Pinning BOTH columns to null is what makes the cancel safe:
            // `executionRunId` alone is not enough, because an issue can be
            // held via `checkoutRunId` with `executionRunId` still null
            // (BLO-19749), which is precisely the window a lock-holder check
            // on one column would miss.
            expectedCurrentCheckoutRunId: null,
            expectedCurrentExecutionRunId: null,
          },
          existing.paperclipCompanyId,
        );
      } catch (err) {
        if (!isExecutionLockPreconditionFailure(err)) throw err;
        // Stated choice (BLO-29908 acceptance criterion b): leave the status
        // untouched and annotate, rather than deferring the cancel behind new
        // state the plugin would then have to reconcile. The holder disposes
        // of the row when it finishes — which is the correct owner of that
        // decision — and a later re-fire refreshes it in place (BLO-24234).
        // The diagnostic read above can race with checkout/release. Re-read
        // after the CAS conflict so a newly acquired owner is notified rather
        // than persisting a misleading `unknown` marker that would suppress
        // future notifications for the real holder.
        const currentIssue = await ctx.issues.get(
          existing.paperclipIssueId,
          existing.paperclipCompanyId,
        );
        cancelWithheldForRunId =
          currentIssue?.executionRunId ?? currentIssue?.checkoutRunId ?? holderRunId;
        if (cancelWithheldForRunId) {
          await ensureCancelWithheldComment(
            ctx,
            existing.paperclipIssueId,
            existing.paperclipCompanyId,
            resolvedAt,
            cancelWithheldForRunId,
          );
        }
        ctx.logger.info(
          `Alertmanager: withheld resolve-cancel for ${alertname} (${alert.fingerprint}) — issue ${existing.paperclipIssueId} is held by run ${cancelWithheldForRunId ?? "an unobserved owner"}`,
        );
        await ctx.metrics.write("alertmanager.resolved.cancel_withheld", 1, {
          alertname,
          severity: existing.severity,
        });
      }
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
    cancelWithheldForRunId,
    cancelWithheldAt: cancelWithheldForRunId ? resolvedAt : null,
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
      cancelWithheldForRunId,
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
  // A terminal issue is deliberately NOT adopted here, which means a lost state
  // row plus a closed issue files a fresh one rather than reviving the old.
  // That diverges from the state-present path (which suppresses per
  // BLO-24234) — on purpose: after a state loss the plugin cannot tell whether
  // the close was its own resolve or an operator's, and the safe failure mode
  // for a paging system is a visible duplicate, not a silent mute. Do not
  // "unify" this branch by returning the terminal issue; that would let a state
  // loss inherit a suppression nobody chose.
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
 * Top-level webhook handler. Pure-ish: takes ctx + config + an authentication
 * verdict + input, returns void. Throws `WebhookUnauthorizedError` when that
 * verdict is `false` — the worker's onWebhook re-throws this so the host
 * can surface a 401 / drop the delivery. Throws `AlertDeliveryIncompleteError`
 * when any alert in the batch failed to process, so the host records the
 * delivery `failed` and Alertmanager retries it.
 *
 * `authenticated` is a verdict, never a credential. `authenticateWebhook`
 * (config-scope.ts) owns every way a request can authenticate — inline token
 * and `webhookTokenRef` alike — so this function does no comparison and never
 * sees a secret. It also records no credential health: given only a verdict it
 * could not tell "no credential configured" from "wrong bearer presented", and
 * conflating those is exactly what credential-health.ts exists to prevent
 * (BLO-20572). `resolveCompanyScope` is the sole recorder.
 *
 * Returning normally is an acknowledgement: it makes the host answer HTTP 200
 * and ends Alertmanager's retries. Only do that when the delivery needs no
 * retry — a malformed or unsupported-version payload, or a filtered alert —
 * never when something that could succeed later has failed.
 */
export async function handleWebhook(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  authenticated: boolean,
  input: PluginWebhookInput,
): Promise<void> {
  if (input.endpointKey !== WEBHOOK_KEYS.alertmanager) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: ignoring webhook for unknown endpoint key "${input.endpointKey}"`,
    );
    return;
  }

  if (!authenticated) {
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
  // Scoped to this delivery — see FallbackOwnerMemo. A storm is the case that
  // matters: without it, every ownerless alert in the batch repeats the same
  // company-wide agent lookup.
  const fallbackOwnerMemo: FallbackOwnerMemo = new Map();

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
      // Rule-level `paperclip_issue` policy, honored before handleFiring so it
      // precedes every issue-creating and state-writing side effect on the
      // firing path, at any severity — an opted-out rule must not create an
      // issue, refresh one, or bank a suppression anchor. Accepted from either
      // labels or annotations because Prometheus rules commonly carry policy in
      // annotations.
      //
      // BOTH gates it produces — the malformed drop and the opt-out — are
      // evaluated here but applied only inside the firing branch, and
      // deliberately do NOT gate the resolved path; see the dispatch below for
      // why. `paperclip_issue` is a *creation* policy: nothing on the resolved
      // path reads it, so neither a malformed value nor an explicit opt-out has
      // any business suppressing the close of an issue that was already filed.
      const policyValues = [
        alert.labels.paperclip_issue,
        alert.annotations.paperclip_issue,
      ];
      const malformedPolicy = policyValues.some(
        (value) => value !== undefined && typeof value !== "string",
      );
      const optedOut = policyValues.some(
        (value) =>
          typeof value === "string" && value.trim().toLowerCase() === "false",
      );
      if (status === "firing") {
        if (malformedPolicy) {
          // A non-string here means the rule author wrote something structurally
          // wrong. Refusing to guess is safer than coercing: `paperclip_issue`
          // decides whether a page becomes an issue at all.
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
        if (optedOut) {
          ctx.logger.info(
            `Alertmanager: ${alertname} opted out via paperclip_issue=false`,
          );
          try {
            await ctx.metrics.write("alertmanager.webhook.issue_opt_out", 1, {
              alertname,
            });
          } catch (metricErr) {
            // Best-effort for the same reason as the creation floor: a permanent
            // policy drop must stay acknowledged even if telemetry is down.
            ctx.logger.error(
              `paperclip-plugin-alertmanager: failed to record issue opt-out metric for ${alert.fingerprint}: ${String(metricErr)}`,
            );
          }
          continue;
        }
        await handleFiring(ctx, config, alert, fallbackOwnerMemo);
      } else if (status === "resolved") {
        // Reached with BOTH policy gates above deliberately bypassed — this
        // path is creation-only, exactly like the severity floor in
        // handleFiring, and for the same reason. Gating it would strand any
        // issue the rule had *already* filed: handleResolved would never run,
        // so `state.resolvedAt` would stay null and the issue would never reach
        // done/cancelled. `advanceIssueLadder` (escalation.ts:377,380) returns
        // early only on resolvedAt, escalationComplete, or a terminal issue
        // status — none of which would ever happen — so the sweep would keep
        // advancing the ladder, waking agents, and eventually file a
        // [user-cover] board escalation for an alert that had already resolved.
        //
        // That is the modal adoption path for the opt-out, not an exotic one:
        // operators opt a rule out *because* it has been filing noisy issues,
        // so a tracked issue almost always exists at that moment. An opt-out is
        // meant to stop new noise, not to wedge the issues it already made.
        //
        // The malformed gate reaches the same conclusion by a shorter route: a
        // non-string `paperclip_issue` is a defect in a *creation* policy, and
        // dropping the resolve over it would convert a typo — a YAML `true`
        // where a `"true"` was meant — into a permanently escalating issue for
        // an alert that has cleared. The firing-side drop already refuses to
        // guess what the author meant; the resolve never had to guess, because
        // it does not read the value at all.
        //
        // This does not weaken the "no state side effect" guarantee for a rule
        // opted out from the start: with no issue ever filed there is no state
        // row, and handleResolved drops an unknown fingerprint without touching
        // anything.
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
