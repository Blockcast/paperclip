import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import {
  EXTERNAL_LIFECYCLE_ADAPTER_TYPES,
  EXTERNAL_LIFECYCLE_MAX_CONCURRENT_RUNS,
  HEARTBEAT_POLICY_MAX_CONCURRENT_MAX,
  HEARTBEAT_POLICY_MAX_CONCURRENT_MIN,
  HEARTBEAT_PRESET_CONFIGS,
  type HeartbeatPreset,
} from "@paperclipai/shared/validators/agent";
import { asBoolean, asNumber, parseObject } from "../adapters/utils.js";

/**
 * The agent-concurrency ceiling, extracted out of `heartbeat.ts` (BLO-27698 C1)
 * so it has exactly one definition.
 *
 * `heartbeat.ts` owns dispatch and so owned this math, but it also imports
 * `productivityReviewService`; the productivity review needs the same ceiling to
 * report whether an assignee was saturated, and importing back would be
 * circular. This module is a leaf — constants from `@paperclipai/shared`, parse
 * helpers from `adapters/utils` — so both sides import it instead of
 * re-deriving it. `heartbeat.ts` re-exports the two public names, so its
 * existing callers and tests are unchanged.
 *
 * Re-deriving rather than sharing is the failure this file exists to prevent:
 * a reported ceiling that disagrees with the enforced one is worse than no
 * reported ceiling, because it reads as measurement.
 */

const EXTERNAL_LIFECYCLE_ADAPTERS = new Set<string>(EXTERNAL_LIFECYCLE_ADAPTER_TYPES);

export function hasExternalLifecycleAdapter(adapterType: string) {
  return EXTERNAL_LIFECYCLE_ADAPTERS.has(adapterType);
}

export function normalizeMaxConcurrentRuns(
  value: unknown,
  fallback: number = AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
) {
  const parsed = Math.floor(asNumber(value, fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(HEARTBEAT_POLICY_MAX_CONCURRENT_MIN, Math.min(HEARTBEAT_POLICY_MAX_CONCURRENT_MAX, parsed));
}

/**
 * The `maxConcurrentRuns` / `concurrencyEnabled` slice of the heartbeat policy.
 * `resolveHeartbeatPolicyForRuntimeConfig` composes this into the full policy;
 * nothing else should parse those two fields itself.
 */
export function resolveAgentConcurrencyPolicy(runtimeConfigValue: unknown): {
  maxConcurrentRuns: number;
  concurrencyEnabled: boolean;
} {
  const runtimeConfig = parseObject(runtimeConfigValue);
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  const presetCandidate =
    typeof heartbeat.preset === "string" && heartbeat.preset.trim().length > 0 ? heartbeat.preset : null;
  const presetConfig =
    presetCandidate && presetCandidate in HEARTBEAT_PRESET_CONFIGS
      ? HEARTBEAT_PRESET_CONFIGS[presetCandidate as HeartbeatPreset]
      : null;
  return {
    maxConcurrentRuns: normalizeMaxConcurrentRuns(
      heartbeat.maxConcurrentRuns,
      presetConfig?.maxConcurrentRuns ?? AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
    ),
    // BLO-15959: deliberately NOT influenced by preset — a preset tunes
    // interval/cooldown/maxConcurrentRuns, but opting an agent into actual
    // external-lifecycle concurrency must be an explicit, separate decision.
    concurrencyEnabled: asBoolean(heartbeat.concurrencyEnabled, false),
  };
}

/**
 * Resolve the admitted concurrency ceiling for external-lifecycle (k8s)
 * adapters (BLO-15959). This is a separate, default-off eligibility gate on
 * top of the per-agent `maxConcurrentRuns` policy value:
 *
 * - Disabled (default): every external-lifecycle agent is held to exactly
 *   one concurrent run, regardless of what `maxConcurrentRuns` is configured
 *   to. This is the fallback/rollback posture — flipping the flag back off
 *   restores it immediately with no migration or data repair, because it is
 *   computed fresh from policy on every dispatch rather than persisted.
 * - Enabled: the effective ceiling is `min(maxConcurrentRuns,
 *   EXTERNAL_LIFECYCLE_SLOT_CAPACITY)` — the operator's configured value,
 *   further bounded by the operational slot ceiling so a high
 *   `maxConcurrentRuns` cannot alone exceed what the cluster is provisioned
 *   for one agent.
 *
 * Serialization of shared-workspace / same-isolation-key runs is a distinct,
 * already-enforced invariant (the unique active-isolation-writer constraint
 * in external_runtime_reservations, BLO-15956/BLO-15958) and is unaffected by
 * this gate either way.
 */
export function resolveExternalLifecycleConcurrency(
  policy: { concurrencyEnabled: boolean; maxConcurrentRuns: number },
): { effectiveMaxConcurrentRuns: number; concurrencyEnabled: boolean } {
  if (!policy.concurrencyEnabled) {
    return { effectiveMaxConcurrentRuns: 1, concurrencyEnabled: false };
  }
  return {
    effectiveMaxConcurrentRuns: Math.max(
      1,
      Math.min(policy.maxConcurrentRuns, EXTERNAL_LIFECYCLE_MAX_CONCURRENT_RUNS),
    ),
    concurrencyEnabled: true,
  };
}

/**
 * The ceiling the dispatcher actually enforces for one agent — the same
 * composition `dispatchForAgent` performs: the external-lifecycle gate for k8s
 * adapters, the raw policy value for everything else.
 */
export function resolveEffectiveMaxConcurrentRuns(agent: {
  adapterType: string;
  runtimeConfig: unknown;
}): {
  maxConcurrentRuns: number;
  effectiveMaxConcurrentRuns: number;
  concurrencyEnabled: boolean;
  externalLifecycle: boolean;
} {
  const policy = resolveAgentConcurrencyPolicy(agent.runtimeConfig);
  const externalLifecycle = hasExternalLifecycleAdapter(agent.adapterType);
  return {
    maxConcurrentRuns: policy.maxConcurrentRuns,
    effectiveMaxConcurrentRuns: externalLifecycle
      ? resolveExternalLifecycleConcurrency(policy).effectiveMaxConcurrentRuns
      : policy.maxConcurrentRuns,
    concurrencyEnabled: policy.concurrencyEnabled,
    externalLifecycle,
  };
}
