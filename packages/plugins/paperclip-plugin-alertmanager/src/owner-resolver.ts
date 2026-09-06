/**
 * Owner / assignee resolution per spec §7.7.
 *
 * Pure email lookup is split from the cached Paperclip-user resolution so the
 * email-finding logic can be unit tested without a plugin context.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getAgentWorkEligibility } from "@paperclipai/shared";
import {
  ASSIGNEE_OVERRIDE_ANNOTATION,
  ASSIGNEE_OVERRIDE_LABEL,
  STATE_KEYS,
} from "./constants.js";
import type {
  AlertmanagerAlert,
  OwnerMap,
  OwnerResolution,
} from "./types.js";

const AGENT_PREFIX = "agent:";

/**
 * Parse a raw ownerMap / label / annotation value into either an email or
 * an agentId. Values whose case-insensitive prefix is `agent:` route to
 * `assigneeAgentId` (the id after the prefix is trimmed but otherwise
 * preserved as-is — agent ids are opaque UUIDs, not emails). Anything else
 * is treated as an email and normalized (trim + lowercase).
 *
 * Returns `{ email: null, agentId: null }` for blank input or a bare
 * `agent:` prefix with no id after it.
 */
function parseTarget(raw: string): { email: string | null; agentId: string | null } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { email: null, agentId: null };
  if (trimmed.toLowerCase().startsWith(AGENT_PREFIX)) {
    const agentId = trimmed.slice(AGENT_PREFIX.length).trim();
    return { email: null, agentId: agentId.length > 0 ? agentId : null };
  }
  return { email: normalizeEmail(trimmed), agentId: null };
}

/**
 * Resolve which email or agent should own this alert.
 *
 * Resolution order (first hit wins):
 *   1. Direct override label  `alert.labels.paperclip_assignee_email`
 *   2. Owner-map by label key — iterate `ownerMap` (e.g.
 *      `{ team: { platform: "alice@..." }}` or
 *      `{ alertname: { Foo: "agent:c0bccc75-a449-4ece-a789-ce40bdd8e785" }}`)
 *      and match against `alert.labels[key]`.
 *   3. Annotation `paperclip_assignee_email` (same name as 1, just located in
 *      annotations).
 *   4. (V1: not implemented) default per-company on-call.
 *   5. No match → returns `email: null, agentId: null, source: "no-match"`.
 *
 * Values prefixed with `agent:<uuid>` resolve to `agentId` (mutually
 * exclusive with `email`); plain values resolve to `email`. The label
 * key `paperclip_assignee_email` is kept for backward compat — despite
 * the name, the value can be either an email or an `agent:<id>`.
 *
 * Pure function; does not touch the host. Returned email is normalized
 * (trimmed + lowercased) so the caller can use it as a cache key directly.
 */
export function resolveOwnerEmail(
  alert: AlertmanagerAlert,
  ownerMap: OwnerMap | undefined,
): OwnerResolution {
  const labelOverride = alert.labels[ASSIGNEE_OVERRIDE_LABEL];
  if (typeof labelOverride === "string" && labelOverride.trim().length > 0) {
    const parsed = parseTarget(labelOverride);
    return { ...parsed, source: "label-override" };
  }

  if (ownerMap) {
    for (const labelKey of Object.keys(ownerMap)) {
      const labelValue = alert.labels[labelKey];
      if (!labelValue) continue;
      const valueMap = ownerMap[labelKey];
      if (!valueMap) continue;
      const value = valueMap[labelValue];
      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = parseTarget(value);
        if (parsed.email || parsed.agentId) {
          return { ...parsed, source: "owner-map" };
        }
      }
    }
  }

  const annotationOverride = alert.annotations[ASSIGNEE_OVERRIDE_ANNOTATION];
  if (
    typeof annotationOverride === "string" &&
    annotationOverride.trim().length > 0
  ) {
    const parsed = parseTarget(annotationOverride);
    return { ...parsed, source: "annotation-override" };
  }

  return { email: null, agentId: null, source: "no-match" };
}

/**
 * Cached email → Paperclip user id lookup. Mirror of the Linear plugin's
 * `resolvePaperclipUserIdForEmail` helper (worker.ts:117–140).
 *
 * Cache shape:
 *   `owner-by-email:<normalized-email>` → string user id  (positive)
 *   `owner-by-email:<normalized-email>` → ""              (negative — looked up, no match)
 *   missing                              → never queried
 *
 * `cached === null` (the host's "not set" sentinel) and `cached === ""` are
 * intentionally distinct: the empty string is a real negative cache hit and
 * suppresses a redundant lookup.
 */
export async function resolveOwnerUserId(
  ctx: Pick<PluginContext, "users" | "state" | "logger">,
  email: string | undefined | null,
): Promise<string | undefined> {
  if (!email) return undefined;
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;

  const stateKey = STATE_KEYS.ownerByEmail(normalized);
  const cached = await ctx.state.get({ scopeKind: "instance", stateKey });
  if (typeof cached === "string" && cached.length > 0) return cached;
  if (cached === "") return undefined;

  try {
    const user = await ctx.users.findByEmail(normalized);
    const userId = user?.id ?? null;
    await ctx.state.set({ scopeKind: "instance", stateKey }, userId ?? "");
    return userId ?? undefined;
  } catch (err) {
    ctx.logger.warn(`Failed to resolve owner ${normalized}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Combined helper: resolve email from alert → cached Paperclip user id.
 * Returns undefined when nothing matches; the caller must resolve the named
 * fallback agent before creating an issue.
 */
export async function resolveAssigneeUserId(
  ctx: Pick<PluginContext, "users" | "state" | "logger">,
  alert: AlertmanagerAlert,
  ownerMap: OwnerMap | undefined,
): Promise<{
  assigneeUserId: string | undefined;
  assigneeAgentId: string | undefined;
  resolution: OwnerResolution;
}> {
  const resolution = resolveOwnerEmail(alert, ownerMap);
  if (resolution.agentId) {
    // Agent targets bypass the users.findByEmail cache — the agentId is
    // already opaque enough to pass directly to ctx.issues.create.
    return {
      assigneeUserId: undefined,
      assigneeAgentId: resolution.agentId,
      resolution,
    };
  }
  if (!resolution.email) {
    return { assigneeUserId: undefined, assigneeAgentId: undefined, resolution };
  }
  const assigneeUserId = await resolveOwnerUserId(ctx, resolution.email);
  return { assigneeUserId, assigneeAgentId: undefined, resolution };
}

/**
 * Last resort in the owner chain: the configured named fallback agent.
 *
 * Matching is by exact agent *name* (case-insensitively, after trimming) —
 * operators configure a name because agent ids are opaque UUIDs that nobody
 * can review in a config diff. That makes the lookup ambiguous in principle,
 * so anything other than exactly one match is refused: zero matches means the
 * name is wrong, and more than one means the caller cannot know which agent
 * the operator meant. Both return `undefined`, and the caller fails closed
 * rather than filing an ownerless issue.
 *
 * Returning `undefined` for blank/absent config is deliberate: an instance
 * with no `fallbackAgentName` at all is a misconfiguration for this plugin,
 * and the caller — not this resolver — decides how loudly to fail.
 *
 * A name match is not enough: the agent must also be *invokable*. The host's
 * `agents.list` filters only `terminated` (`server/src/services/agents.ts`), so
 * `paused` and `pending_approval` agents come back and could be the single
 * match — and `ctx.agents.invoke` throws on exactly those. Assigning one
 * produces a non-null `assigneeAgentId` pointing at an agent that can never be
 * woken, which is the BLO-27435/27436/27438 harm wearing a disguise: the issue
 * still goes unactioned and still auto-cancels, while the post-deploy check for
 * ownerless issues passes clean. Eligibility is delegated to
 * `getAgentWorkEligibility` rather than re-listing statuses here, so this stays
 * in step with what `invoke` actually enforces (including an invalid reporting
 * chain, which blocks invoke just as surely as a paused status). The whole
 * company snapshot is already in hand, which is exactly the input it needs.
 */
export async function resolveFallbackAgentId(
  ctx: Pick<PluginContext, "agents" | "logger">,
  companyId: string,
  fallbackAgentName: string | undefined,
): Promise<string | undefined> {
  const target = fallbackAgentName?.trim().toLowerCase();
  if (!target) return undefined;
  // One unwindowed company-wide snapshot rather than a paged scan: the host's
  // list is unordered, so paging could drift a match across page boundaries
  // and turn a stable config into an intermittent ownerless-issue bug.
  const agents = await ctx.agents.list({ companyId });
  const nameMatches = agents.filter(
    (agent) => agent.name.trim().toLowerCase() === target,
  );
  const evaluated = nameMatches.map((agent) => ({
    agent,
    eligibility: getAgentWorkEligibility({ agent, agents }),
  }));
  const invokable = evaluated.filter((entry) => entry.eligibility.invokable);
  if (invokable.length !== 1) {
    if (evaluated.length > 0 && invokable.length === 0) {
      // Distinct from the unmatched case on purpose: "your fallback agent is
      // paused" and "your fallback agent name is wrong" need different fixes,
      // and an operator reading `resolved to 0 agents` would go hunting for a
      // typo that isn't there.
      const reasons = evaluated
        .map(
          (entry) =>
            `${entry.agent.id}=${entry.eligibility.invokabilityReason}`,
        )
        .join(", ");
      ctx.logger.warn(
        `Fallback agent "${fallbackAgentName}" matched ${evaluated.length} agent(s) but none are invokable (${reasons}); refusing ownerless issue creation`,
      );
      return undefined;
    }
    ctx.logger.warn(
      `Fallback agent "${fallbackAgentName}" resolved to ${invokable.length} invokable agents; refusing ownerless issue creation`,
    );
    return undefined;
  }
  return invokable[0]?.agent.id;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
