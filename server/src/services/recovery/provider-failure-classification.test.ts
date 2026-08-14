import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
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
