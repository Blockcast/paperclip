import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  isInfraClassStrandedFailure,
  isWorkspaceGitTransportStrandedFailure,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not classify a JSON response-parse failure as configuration_incomplete, even when the truncated payload contains config-like text (BLO-21116)", () => {
    // Regression for BLO-18991: a malformed/truncated adapter response was
    // classified as configuration_incomplete (-> manual_repair_required, a
    // permanent dead-end with no automatic retry) because the raw parse-failure
    // text happened to be matched against JSON.stringify(resultJson) in full.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: 'JSON parsing failed: Text: {"type":"response.completed","response":{"missing api key" ...',
      resultJson: { raw: "...truncated stream containing the phrase 'model xyz not found' by accident..." },
    })).toBeNull();
  });

  it("does not classify a JSON response-parse failure as provider_quota, even when the truncated payload contains a quota-like phrase (BLO-21116 Ally follow-up)", () => {
    // Same defect class as the configuration_incomplete regression above, the
    // other branch: `error` still carries `rawError` verbatim after the
    // parse-failure guard (only `resultJson` was dropped from the combined
    // search string), so a truncated payload containing "quota exceeded" or
    // "model is at capacity" used to reach PROVIDER_QUOTA_ERROR_RE and
    // misclassify as provider_quota -- scheduling a retry-at-reset-time
    // backoff for a transient parse fault that has no actual quota reset.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: 'JSON parsing failed: Text: {"type":"response.completed","response":{"error":"quota exceeded" ...',
      resultJson: null,
    })).toBeNull();
  });

  it("preserves an authoritative provider_quota code when its message mentions JSON parsing", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "JSON parsing failed while recording the provider quota response.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("preserves an authoritative configuration_incomplete code when its message mentions JSON parsing", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "configuration_incomplete",
      error: "JSON parsing failed while reading the configuration response.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("still classifies a genuine configuration failure reported via adapter_failed alongside an unrelated resultJson blob", () => {
    // The parse-failure guard must be narrowly scoped to the parse-failure
    // shape -- a real config error without that shape keeps classifying.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "No API credentials were found for this provider",
      resultJson: { detail: "some unrelated diagnostic payload" },
    })).toEqual({ kind: "configuration_incomplete" });
  });
});

/**
 * BLO-31351: a git transport fault during workspace setup must not be retried.
 *
 * The failure text below is byte-for-byte what the agent pods logged in
 * BLO-31338, including git's false "possible repository corruption on the remote
 * side". Before this classification these landed as bare `adapter_failed`, which
 * is a member of `TRANSIENT_INFRA_CONTINUATION_ERROR_CODES` and therefore bought
 * three re-dispatches against a cause that cannot change between them.
 */
const POD_GIT_TRANSPORT_FAILURE = [
  "error: git upload-pack: git-pack-objects died with error.",
  "fatal: git upload-pack: aborting due to possible repository corruption on the remote side.",
  "remote: aborting due to possible repository corruption on the remote side.",
  "fatal: early EOF",
  "fatal: fetch-pack: invalid index-pack output",
].join("\n");

describe("classifyAdapterFailureForRecovery -- workspace git transport", () => {
  it("classifies the exact pod failure text as a git transport fault", () => {
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: `Claude run failed: exit 128\n${POD_GIT_TRANSPORT_FAILURE}`,
      resultJson: null,
      usageJson: null,
    });

    expect(classification).toMatchObject({ kind: "workspace_git_transport" });
  });

  it.each([
    ["upload-pack death", "error: git upload-pack: git-pack-objects died with error."],
    ["fake corruption", "fatal: aborting due to possible repository corruption on the remote side."],
    ["early EOF", "fatal: early EOF"],
    ["index-pack output", "fatal: fetch-pack: invalid index-pack output"],
    ["hung up remote", "fatal: the remote end hung up unexpectedly"],
    ["unreadable remote", "fatal: could not read from remote repository"],
  ])("classifies %s", (_label, error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
      usageJson: null,
    })).toMatchObject({ kind: "workspace_git_transport" });
  });

  it("does NOT claim a failure that already reached a model call", () => {
    // The gate that keeps this from hijacking mid-run failures. Recorded usage
    // means the agent got a model call, so the fault is not workspace setup and
    // the existing paths own it.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: `Something broke later on\n${POD_GIT_TRANSPORT_FAILURE}`,
      resultJson: null,
      usageJson: { input_tokens: 1200, output_tokens: 88 },
    })).toBeNull();
  });

  it("does not fire on an ordinary git error that is not a transport fault", () => {
    // Anchoring on transport-layer phrases rather than on "git" is deliberate:
    // an agent's own failed git command is reported in its tool output, so
    // widening this would buy false positives without buying coverage.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "error: pathspec 'nope' did not match any file(s) known to git",
      resultJson: null,
      usageJson: null,
    })).toBeNull();
  });

  it("leaves a genuine credential failure classified as configuration_incomplete", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "No API credentials were found for this provider",
      resultJson: null,
      usageJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("does not reclassify the seat-entitlement failure that looks similar at a glance", () => {
    // BLO-31241's live recovery evidence. It is an entitlement fault, not a git
    // one, and conflating the two would route a recoverable seat problem into
    // manual workspace repair.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error:
        "Claude run failed: subtype=success: Failed to authenticate. API Error: 403 The connected " +
        "subscription for org 'org_penstock' provider 'anthropic' is not entitled to serve this request; " +
        "re-entitle the seat and retry.",
      resultJson: null,
      usageJson: null,
    })).toBeNull();
  });

  it("is not claimed for a non-adapter_failed error code", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "claude_truncated",
      error: POD_GIT_TRANSPORT_FAILURE,
      resultJson: null,
      usageJson: null,
    })).toBeNull();
  });
});

describe("isInfraClassStrandedFailure -- git transport", () => {
  it("records a pre-model-call git transport fault as infrastructure-class", () => {
    // AUDIT ONLY. `infraClassCause` has no production reader; the attempt-budget
    // exemption comes from routing this cause to `workspace_validation_failed`.
    expect(isWorkspaceGitTransportStrandedFailure({
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      error: POD_GIT_TRANSPORT_FAILURE,
      errorCode: "adapter_failed",
      contextSnapshot: null,
      livenessState: null,
      resultJson: null,
      usageJson: null,
      sessionIdBefore: null,
      scheduledRetryAttempt: 0,
      createdAt: new Date(),
      finishedAt: new Date(),
    })).toBe(true);
  });

  it("does not claim a run that recorded usage", () => {
    expect(isWorkspaceGitTransportStrandedFailure({
      id: "run-2",
      agentId: "agent-1",
      status: "failed",
      error: POD_GIT_TRANSPORT_FAILURE,
      errorCode: "adapter_failed",
      contextSnapshot: null,
      livenessState: null,
      resultJson: null,
      usageJson: { input_tokens: 10 },
      sessionIdBefore: null,
      scheduledRetryAttempt: 0,
      createdAt: new Date(),
      finishedAt: new Date(),
    })).toBe(false);
  });

  it("leaves the pre-existing pod-gone signal intact", () => {
    expect(isInfraClassStrandedFailure({
      id: "run-3",
      agentId: "agent-1",
      status: "failed",
      error: "pod is gone -- Job pod was removed before exit could be read",
      errorCode: "claude_truncated",
      contextSnapshot: null,
      livenessState: null,
      resultJson: null,
      usageJson: null,
      sessionIdBefore: null,
      scheduledRetryAttempt: 0,
      createdAt: new Date(),
      finishedAt: new Date(),
    })).toBe(true);
  });
});
