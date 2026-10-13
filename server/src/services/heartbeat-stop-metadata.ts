export type HeartbeatRunOutcome = "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";

export type HeartbeatRunStopReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "cancelled"
  | "budget_paused"
  | "paused"
  | "max_turns_exhausted"
  | "process_lost"
  | "unmanaged_background_task_stopped"
  | "adapter_failed";

export interface HeartbeatRunTimeoutPolicy {
  effectiveTimeoutSec: number | null;
  effectiveTimeoutMs?: number | null;
  /**
   * Whether a timeout bound was **in force** for this run — not whether the
   * agent's `adapterConfig` happened to name one.
   *
   * PEN-4023: these are not the same question, and treating them as the same
   * is what let this object contradict itself.  `timeoutFired` is derived from
   * the *outcome* and `timeoutConfigured` from the *config*, computed
   * independently and never reconciled, so a real kill persisted as
   * `{ timeoutFired: true, timeoutSource: "config", timeoutConfigured: false,
   * effectiveTimeoutSec: 0 }` — "a timeout fired, sourced from config" and "no
   * timeout was configured" in one record.  Production agents run with
   * `timeoutSec: 0` while their Kubernetes Job carries
   * `activeDeadlineSeconds: 7200` written by something outside the adapter, so
   * this was not an edge case: it was every 2-hour kill on the fleet, and it
   * made 11 runs across two agents unreadable because the bound that fired was
   * recorded nowhere (PEN-4016).
   *
   * A fired timeout proves a bound existed.  So when `timeoutFired` is true
   * this is true, and `timeoutSource` carries where the number came from —
   * including `"unknown"` when nothing could name it.  The pair
   * `timeoutFired: true` with `timeoutConfigured: false` is unreachable by
   * construction; `heartbeat-stop-metadata.test.ts` pins that.
   */
  timeoutConfigured: boolean;
  /**
   * Where `effectiveTimeoutSec` came from.
   *
   * - `config` — read from the agent's `adapterConfig`.
   * - `default` — the adapter's built-in default; `adapterConfig` was silent.
   * - `observed` — measured at runtime from the thing that actually enforced
   *   the kill (the Job's `spec.activeDeadlineSeconds`, the adapter's own wait
   *   budget), reported by the adapter rather than read from config.  This is
   *   the only source that can name a bound nothing in config knows about.
   * - `unknown` — a bound demonstrably fired and none of the above could name
   *   it.  `effectiveTimeoutSec` is then null: unknown is recorded as unknown,
   *   never as `0`.
   *
   * Gate paths in `heartbeat.ts` write their own gate name here directly
   * (`dependency_gate`, `duplicate_dispatch_gate`, …) without going through
   * this builder; those always pair with `timeoutFired: false`.
   */
  timeoutSource: "config" | "default" | "observed" | "unknown";
}

export interface HeartbeatRunStopMetadata extends HeartbeatRunTimeoutPolicy {
  stopReason: HeartbeatRunStopReason;
  timeoutFired: boolean;
}

/**
 * A bound an adapter measured at runtime, as it reports it on the run result.
 * `seconds` is null when the adapter knows a bound fired but could not read
 * its value — which must stay distinguishable from "the bound was zero".
 */
export interface ObservedHeartbeatRunTimeout {
  seconds: number | null;
  source: string | null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function defaultTimeoutSecForAdapter(adapterType: string) {
  return adapterType === "openclaw_gateway" ? 120 : 0;
}

export function normalizeMaxTurnStopReason(value: unknown): Extract<HeartbeatRunStopReason, "max_turns_exhausted"> | null {
  return value === "max_turns_exhausted" || value === "turn_limit_exhausted"
    ? "max_turns_exhausted"
    : null;
}

export function resolveHeartbeatRunTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): HeartbeatRunTimeoutPolicy {
  const config = adapterConfig ?? {};

  if (adapterType === "http") {
    const hasTimeoutMs = hasOwn(config, "timeoutMs");
    const rawTimeoutMs = hasTimeoutMs ? readFiniteNumber(config.timeoutMs) : 0;
    const timeoutMs = Math.max(0, Math.floor(rawTimeoutMs ?? 0));
    return {
      effectiveTimeoutSec: timeoutMs / 1000,
      effectiveTimeoutMs: timeoutMs,
      timeoutConfigured: timeoutMs > 0,
      timeoutSource: hasTimeoutMs ? "config" : "default",
    };
  }

  const hasTimeoutSec = hasOwn(config, "timeoutSec");
  const defaultTimeoutSec = defaultTimeoutSecForAdapter(adapterType);
  const rawTimeoutSec = hasTimeoutSec ? readFiniteNumber(config.timeoutSec) : defaultTimeoutSec;
  const timeoutSec = Math.max(0, Math.floor(rawTimeoutSec ?? defaultTimeoutSec));

  return {
    effectiveTimeoutSec: timeoutSec,
    timeoutConfigured: timeoutSec > 0,
    timeoutSource: hasTimeoutSec ? "config" : "default",
  };
}

export function inferHeartbeatRunStopReason(input: {
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopReason {
  if (input.outcome === "succeeded") return "completed";
  if (input.outcome === "interrupted") return "interrupted";
  const maxTurnStopReason = normalizeMaxTurnStopReason(input.errorCode);
  if (maxTurnStopReason) return maxTurnStopReason;
  if (input.outcome === "timed_out") return "timeout";
  if (input.outcome === "failed" && input.errorCode === "unmanaged_background_task_stopped") return "unmanaged_background_task_stopped";
  if (input.outcome === "failed" && input.errorCode === "process_lost") return "process_lost";
  if (input.outcome === "cancelled") {
    const message = (input.errorMessage ?? "").toLowerCase();
    if (message.includes("budget")) return "budget_paused";
    if (message.includes("pause") || message.includes("paused")) return "paused";
    return "cancelled";
  }
  return "adapter_failed";
}

/**
 * Read the runtime-observed bound an adapter reported on its result.
 *
 * Deliberately tolerant about `source` and strict about `seconds`: a source
 * string is provenance an unknown adapter may spell however it likes, whereas
 * a bogus number here would be written into the record as the bound that
 * killed the run. Anything not a finite positive number is treated as absent,
 * which degrades to `timeoutSource: "unknown"` rather than to a wrong number.
 *
 * Zero counts as absent, not as a bound of zero seconds. Nothing fires after
 * zero seconds, and writing `effectiveTimeoutSec: 0` beside `timeoutFired:
 * true` is the record PEN-4016 could not read.
 */
export function readObservedHeartbeatRunTimeout(
  resultJson: Record<string, unknown> | null | undefined,
): ObservedHeartbeatRunTimeout | null {
  if (!resultJson) return null;
  const hasSeconds = hasOwn(resultJson, "observedTimeoutSec");
  const hasSource = hasOwn(resultJson, "observedTimeoutSource");
  if (!hasSeconds && !hasSource) return null;
  const seconds = hasSeconds ? readFiniteNumber(resultJson.observedTimeoutSec) : null;
  const source = hasSource && typeof resultJson.observedTimeoutSource === "string"
    ? resultJson.observedTimeoutSource.trim() || null
    : null;
  return { seconds: seconds != null && seconds > 0 ? seconds : null, source };
}

/**
 * Reconcile the configured timeout policy against what actually happened.
 *
 * Only reached when a timeout fired. The config half is left untouched on
 * every other outcome, so a run that did not time out still reports its
 * configuration exactly as before — this widens what a *fired* timeout
 * records, and changes nothing else.
 */
function reconcileFiredTimeout(
  policy: HeartbeatRunTimeoutPolicy,
  observed: ObservedHeartbeatRunTimeout | null,
): HeartbeatRunTimeoutPolicy {
  if (observed?.seconds != null && observed.seconds > 0) {
    return {
      effectiveTimeoutSec: observed.seconds,
      // Preserve the millisecond field only where the policy carries one (the
      // `http` adapter), so the two never disagree about the same bound.
      ...(policy.effectiveTimeoutMs != null ? { effectiveTimeoutMs: observed.seconds * 1000 } : {}),
      timeoutConfigured: true,
      timeoutSource: "observed",
    };
  }

  // No observed bound. If config names a positive one it is the best available
  // account of what fired, so keep it verbatim.
  if (policy.timeoutConfigured) return policy;

  // A timeout fired and nothing can name the bound. Record that, rather than
  // the config's `0` — which is what `Timed out after 0s` was.
  return {
    effectiveTimeoutSec: null,
    ...(policy.effectiveTimeoutMs != null ? { effectiveTimeoutMs: null } : {}),
    timeoutConfigured: true,
    timeoutSource: "unknown",
  };
}

export function buildHeartbeatRunStopMetadata(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  /**
   * The bound the adapter measured at runtime, when it reported one. Absent
   * for adapters that do not, which is why `reconcileFiredTimeout` still has
   * to handle a fired timeout with nothing to name it.
   */
  observedTimeout?: ObservedHeartbeatRunTimeout | null;
}): HeartbeatRunStopMetadata {
  const timeoutPolicy = resolveHeartbeatRunTimeoutPolicy(input.adapterType, input.adapterConfig);
  const stopReason = inferHeartbeatRunStopReason(input);
  const timeoutFired = stopReason === "timeout";
  return {
    ...(timeoutFired ? reconcileFiredTimeout(timeoutPolicy, input.observedTimeout ?? null) : timeoutPolicy),
    stopReason,
    timeoutFired,
  };
}

export function mergeHeartbeatRunStopMetadata(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: HeartbeatRunStopMetadata,
): Record<string, unknown> {
  const existingMaxTurnStopReason = normalizeMaxTurnStopReason(resultJson?.stopReason);
  return {
    ...(resultJson ?? {}),
    stopReason: existingMaxTurnStopReason ?? metadata.stopReason,
    effectiveTimeoutSec: metadata.effectiveTimeoutSec,
    timeoutConfigured: metadata.timeoutConfigured,
    timeoutSource: metadata.timeoutSource,
    timeoutFired: metadata.timeoutFired,
    // PEN-4023: keyed on *presence*, not on non-nullness. Adapters other than
    // `http` carry no millisecond field at all and must keep leaving the key
    // untouched (unchanged behaviour). But `http` always carries one, and a
    // fired timeout whose bound could not be named sets it to null — which the
    // old `!= null` test dropped, leaving a stale `effectiveTimeoutMs` from an
    // earlier merge beside `effectiveTimeoutSec: null`. That is the same shape
    // of self-contradicting record this change exists to remove.
    ...("effectiveTimeoutMs" in metadata ? { effectiveTimeoutMs: metadata.effectiveTimeoutMs } : {}),
  };
}
