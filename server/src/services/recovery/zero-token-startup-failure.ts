// Pre-model startup failures: a run that fails before the agent does any
// model work. `context_overflow` / `context_length_exceeded` mean the session
// was already too large to prime the model; `startup_error_pre_model` covers
// other crashes that happen before the first model turn. When such a run also
// burned zero tokens (input + output), the wedge is *structural* — a poisoned
// or oversized session DB, or a model-config mismatch — and re-running it
// inherits the exact same failure mode.
//
// A `stranded_issue_recovery` wrapper is only useful when the failure is
// *transient* (rate limit, network, MCP timeout): a wrapper re-invokes the
// same wedged session, so for this family it just produces another zero-token
// failed run and loops. Observed concretely on BLO-5378 → wrapper BLO-5676 →
// productivity review BLO-5678: 9 consecutive zero-token failed runs in ~1h
// before a human cancelled the wrapper. See BLO-5681.
export const ZERO_TOKEN_STARTUP_FAILURE_ERROR_CODES = new Set<string>([
  "context_overflow",
  "context_length_exceeded",
  "session_unavailable",
  "startup_error_pre_model",
]);

// A missing configured skill is deterministic and must not consume the
// one-shot session reset retry reserved for structural startup wedges.
export const DETERMINISTIC_SKILL_FAILURE_ERROR_CODE = "skill_not_found";

const LEGACY_SESSION_UNAVAILABLE_ERROR_RE = /\bsession\s+unavailable\b/i;
const OPENCODE_ADAPTER_TYPES = new Set(["opencode_local", "opencode_k8s"]);

// Heartbeat-run terminal statuses that represent an unsuccessful outcome.
// Mirrors UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES in heartbeat.ts /
// recovery/service.ts; kept local so this module stays a dependency-free
// pure classifier that can be unit-tested in isolation.
const UNSUCCESSFUL_TERMINAL_STATUSES = new Set<string>([
  "failed",
  "cancelled",
  "timed_out",
]);

export type ZeroTokenStartupFailureRunInput =
  | {
    adapterType?: string | null;
    status?: string | null;
    error?: string | null;
    errorCode?: string | null;
    usageJson?: Record<string, unknown> | null;
  }
  | null
  | undefined;

// Read a token count from a heartbeat-run `usage_json` blob. Adapters write
// either camelCase (`inputTokens`) or snake_case (`input_tokens`) — see the
// coalesce in services/activity.ts — so both spellings are accepted. A missing
// or non-finite value counts as 0, so an absent usage blob reads as zero work.
function readTokenCount(
  usage: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number {
  if (!usage) return 0;
  for (const key of keys) {
    const raw = usage[key];
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

// Extract input/output token counts from a heartbeat-run `usage_json` blob,
// tolerating both camelCase and snake_case key spellings.
export function runUsageTokenCounts(
  usage: Record<string, unknown> | null | undefined,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: readTokenCount(usage, ["inputTokens", "input_tokens"]),
    outputTokens: readTokenCount(usage, ["outputTokens", "output_tokens"]),
  };
}

// BLO-22097: `usageJson: null` means usage was never *recorded*, not that
// zero tokens were consumed — a post-model failure whose result event never
// arrives leaves usage null even though the model produced output. Treating
// null the same as an explicit `{inputTokens: 0, outputTokens: 0}` (which
// `runUsageTokenCounts` does, since it exists to parse the blob once it
// exists) misclassifies that run as never-executed. `logBytes` corroborates
// the unknown case: every run log opens with ~15-20KB of session boilerplate
// before any model turn, and explicit-zero-usage runs sampled across
// BLO-19924/BLO-21091/BLO-21025 topped out at 111,337 bytes (still no model
// turn — likely a slow upstream timeout inflating the pre-failure log). A
// run that genuinely executed but lost its usage accounting (BLO-19924's
// `claude_truncated` case) logged 844,801 bytes, two orders of magnitude
// above that ceiling. The floor below is set with wide margin above the
// observed boilerplate ceiling and well below the observed executed-run
// floor — see BLO-22097 for the full sample tables.
const NEVER_EXECUTED_UNKNOWN_USAGE_LOG_BYTES_CEILING = 200_000;

// The fields `isInfraFailureRun` reads. Structural rather than a `Pick` off the
// schema row so this module stays dependency-free and unit-testable in isolation,
// matching `ZeroTokenStartupFailureRunInput` above.
export type NeverExecutedRunInput = {
  livenessState?: string | null;
  usageJson?: Record<string, unknown> | null;
  logBytes?: number | null;
  errorCode?: string | null;
};

// True when the dependency gate cancelled a queued run before dispatch (see
// `cancelQueuedRunForBlockedDependencies` in heartbeat.ts). The run never
// reached the adapter, so it is disjoint from `isInfraFailureRun` below even
// though both are zero-token: this one is a graph-state fact about the issue
// (an unresolved `blockedBy` edge), not an infrastructure fault, and it must
// not be reported as one (BLO-22436).
export function isDependencyBlockedRun(run: Pick<NeverExecutedRunInput, "errorCode">): boolean {
  return run.errorCode === "issue_dependencies_blocked";
}

// True when a run's most recent classification is `failed` liveness AND it
// burned zero input+output tokens. That combination means the agent never
// got a model turn — the runtime crashed, the process was killed, or every
// model call errored before producing output. Observed causes include a K8s
// crashloop (`BackoffLimitExceeded`), an inference-gateway 503 storm, a
// provider capacity 429 kill, and retry-budget exhaustion with no error code
// at all (`error: "unknown"`, `error_status: null`). Keying on token usage
// rather than error code/status/dispatch-state is deliberate: it is the one
// signature all four causes share (BLO-21769). Excludes dependency-gate
// cancellations (BLO-22436) — those never reached the adapter at all, so they
// are a graph-state fact rather than an infrastructure fault, and are counted
// separately.
//
// `usageJson: null` is unknown, not a measured zero (BLO-22097): it is only
// read as never-executed when `logBytes` also stays at or under the
// boilerplate-only ceiling. An *explicit* zero-usage blob is never
// second-guessed by `logBytes` — a large log with confirmed zero tokens
// (observed up to 111,337 bytes) is still never-executed, since the
// corroboration only fills in for missing telemetry, not disputed telemetry.
//
// The two narrowings compose without collapsing: BLO-22097 narrows *within*
// this predicate (which failed runs count as infra), while BLO-22436 widens
// the *union* in productivity-review's `isNeverExecutedRun` (which populations
// count as never-executed). Keep them disjoint — folding the dependency gate
// into the usage test would let a blocker edge masquerade as an infrastructure
// fault.
//
// BLO-32679 moved this here from productivity-review.ts, where it was private,
// so the stranded-assigned-issue sweep can ask the same question without a
// second definition. Two definitions of "never executed" would drift silently
// in the dangerous direction: the sweep suppressing a seizure the review
// treats as agent silence, or the reverse. Same reasoning as
// `openPullRequestWakePathConditions`, which was extracted for the same hazard.
export function isInfraFailureRun(run: NeverExecutedRunInput): boolean {
  if (isDependencyBlockedRun(run)) return false;
  if (run.livenessState !== "failed") return false;
  if (run.usageJson == null) {
    return (run.logBytes ?? 0) <= NEVER_EXECUTED_UNKNOWN_USAGE_LOG_BYTES_CEILING;
  }
  const { inputTokens, outputTokens } = runUsageTokenCounts(run.usageJson);
  return inputTokens === 0 && outputTokens === 0;
}

function readAdapterType(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isLegacySessionUnavailableAdapterFailure(
  run: Pick<NonNullable<ZeroTokenStartupFailureRunInput>, "error" | "errorCode"> | null | undefined,
): boolean {
  const errorCode = typeof run?.errorCode === "string" ? run.errorCode.trim() : "";
  return (
    errorCode === "adapter_failed" &&
    typeof run?.error === "string" &&
    LEGACY_SESSION_UNAVAILABLE_ERROR_RE.test(run.error)
  );
}

export function isLegacySessionUnavailableAdapterMismatch(input: {
  run: ZeroTokenStartupFailureRunInput;
  currentAdapterType?: string | null;
}): boolean {
  const historicalAdapterType = readAdapterType(input.run?.adapterType);
  const currentAdapterType = readAdapterType(input.currentAdapterType);
  return Boolean(
    historicalAdapterType &&
      currentAdapterType &&
      historicalAdapterType !== currentAdapterType &&
      isLegacySessionUnavailableAdapterFailure(input.run),
  );
}

// True when a run's most recent terminal failure is a structural, pre-model
// startup wedge that produced zero token usage. The recovery sweep uses this
// to gate `stranded_issue_recovery` wrapper creation: for this family the
// source issue is escalated straight to `blocked` instead of spawning a
// wrapper that would re-run the same wedged session.
export function isZeroTokenStartupFailureRun(
  run: ZeroTokenStartupFailureRunInput,
): boolean {
  if (!run) return false;
  if (!run.status || !UNSUCCESSFUL_TERMINAL_STATUSES.has(run.status)) return false;
  const errorCode = typeof run.errorCode === "string" ? run.errorCode.trim() : "";
  if (errorCode === DETERMINISTIC_SKILL_FAILURE_ERROR_CODE) return false;
  const isLegacySessionUnavailable =
    OPENCODE_ADAPTER_TYPES.has(readAdapterType(run.adapterType) ?? "") &&
    isLegacySessionUnavailableAdapterFailure(run);
  if (!isLegacySessionUnavailable && (!errorCode || !ZERO_TOKEN_STARTUP_FAILURE_ERROR_CODES.has(errorCode))) {
    return false;
  }
  const { inputTokens, outputTokens } = runUsageTokenCounts(run.usageJson);
  return inputTokens === 0 && outputTokens === 0;
}

// BLO-10889 (BLO-10866 WS2): marker written into the wake `contextSnapshot`
// (as `retryReason`) when the recovery sweep dispatches its one bounded
// reset-and-retry attempt for a zero-token startup failure (see
// resetSessionAndRetryZeroTokenFailure in recovery/service.ts).
export const ZERO_TOKEN_SESSION_RESET_RETRY_REASON = "zero_token_session_reset";
export const SESSION_UNAVAILABLE_RECOVERY_RETRY_REASON = "session_unavailable";
export const SESSION_UNAVAILABLE_RECOVERY_MAX_ATTEMPTS = 2;

// True when the latest run was itself dispatched as that one-shot
// reset-and-retry attempt and failed again with the same zero-token
// signature — i.e. clearing the persisted task session already happened
// once for this failure streak and didn't help. The recovery sweep uses
// this to fall back to `blocked` escalation instead of resetting forever
// when the wedge isn't actually session-poisoning (e.g. a genuinely
// oversized workspace tripping context_overflow every time).
export function isZeroTokenSessionResetRetryRun(
  run: {
    contextSnapshot?: Record<string, unknown> | null;
    scheduledRetryAttempt?: number | null;
  } | null | undefined,
): boolean {
  const context = run?.contextSnapshot;
  if (!context || typeof context !== "object") return false;
  const retryReason = context.retryReason;
  if (retryReason === ZERO_TOKEN_SESSION_RESET_RETRY_REASON) return true;
  return (
    retryReason === SESSION_UNAVAILABLE_RECOVERY_RETRY_REASON &&
    (run?.scheduledRetryAttempt ?? 0) >= SESSION_UNAVAILABLE_RECOVERY_MAX_ATTEMPTS
  );
}
