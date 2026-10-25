import { describe, expect, it } from "vitest";
import { formatTimeoutMessage } from "@paperclipai/adapter-utils/server-utils";
import {
  isConfirmedAdapterTimeout,
  isFalseAdapterTimeoutResult,
  isSuccessfulAdapterResult,
} from "../services/heartbeat.js";

describe("heartbeat timeout outcome", () => {
  it("rejects a contradictory timeout marker on a confirmed successful exit", () => {
    const malformedResult = {
      timedOut: true,
      exitCode: 0,
      errorMessage: "Timed out after 3600s",
      errorCode: "timeout",
      resultJson: null,
    };
    expect(isConfirmedAdapterTimeout(malformedResult)).toBe(false);
    expect(isFalseAdapterTimeoutResult(malformedResult)).toBe(true);
    expect(isSuccessfulAdapterResult(malformedResult)).toBe(true);
  });

  it("preserves genuine timeout outcomes", () => {
    expect(isConfirmedAdapterTimeout({ timedOut: true, exitCode: null })).toBe(true);
    expect(isConfirmedAdapterTimeout({ timedOut: true, exitCode: 137 })).toBe(true);
  });

  it("does not infer a timeout from a failed exit alone", () => {
    expect(isConfirmedAdapterTimeout({ timedOut: false, exitCode: 1 })).toBe(false);
    expect(isSuccessfulAdapterResult({
      timedOut: false,
      exitCode: 1,
      errorMessage: "adapter failed",
      errorCode: "adapter_failed",
      resultJson: null,
    })).toBe(false);
  });

  it("ignores errorMessage text; a non-timeout error code still blocks suppression", () => {
    // BLO-23296: the decision is structural. A genuine non-timeout failure has
    // to be carried by errorCode or by structured evidence in resultJson.
    expect(isFalseAdapterTimeoutResult({
      timedOut: true,
      exitCode: 0,
      errorMessage: "Result publication failed",
      errorCode: "adapter_failed",
      resultJson: null,
    })).toBe(false);
  });

  it.each([
    ["a result error", { error: "Result publication failed" }],
    ["an is_error flag", { is_error: true }],
    ["an error subtype", { subtype: "error_during_execution" }],
    ["a failed status", { status: "failed" }],
  ])("does not suppress structured failure evidence from %s", (_label, resultJson) => {
    const result = {
      timedOut: true,
      exitCode: 0,
      errorMessage: "Timed out after 3600s",
      errorCode: "timeout",
      resultJson,
    };
    expect(isFalseAdapterTimeoutResult(result)).toBe(false);
    expect(isSuccessfulAdapterResult(result)).toBe(false);
  });

  it("accepts explicit structured success evidence on the malformed timeout", () => {
    const result = {
      timedOut: true,
      exitCode: 0,
      errorMessage: "Timed out after 3600s",
      errorCode: "timeout",
      resultJson: { type: "result", subtype: "success", is_error: false },
    };
    expect(isFalseAdapterTimeoutResult(result)).toBe(true);
    expect(isSuccessfulAdapterResult(result)).toBe(true);
  });

  // Mirrors the finalize branch order in heartbeat.ts (timed_out, then success, else failed).
  function finalize(result: Parameters<typeof isSuccessfulAdapterResult>[0]) {
    if (isConfirmedAdapterTimeout(result)) return "timed_out";
    return isSuccessfulAdapterResult(result) ? "succeeded" : "failed";
  }

  describe("structural false-timeout matcher (BLO-23296)", () => {
    const falseTimeout = (errorMessage: string, resultJson: Record<string, unknown> | null = null) => ({
      timedOut: true,
      exitCode: 0,
      errorMessage,
      errorCode: "timeout",
      resultJson,
    });

    it("finalizes a non-legacy-message false timeout as succeeded", () => {
      expect(finalize(falseTimeout("Timed out after 384s (limit 3600s)"))).toBe("succeeded");
    });

    it("finalizes a genuine timeout (exitCode !== 0) as timed_out", () => {
      expect(finalize({ ...falseTimeout("Timed out after 3600s (limit 3600s)"), exitCode: 137 })).toBe("timed_out");
      expect(finalize({ ...falseTimeout("Timed out after 3600s (limit 3600s)"), exitCode: null })).toBe("timed_out");
    });

    it("finalizes a structured-failure result as failed", () => {
      expect(finalize(falseTimeout("Timed out after 384s (limit 3600s)", { error: "Result publication failed" }))).toBe("failed");
    });

    it("still finalizes a legacy-message false timeout as succeeded", () => {
      expect(finalize(falseTimeout("Timed out after 3600s"))).toBe("succeeded");
    });

    // The vendored claude_k8s adapter (`buildTimeoutExecutionResult`) emits
    // `errorCode: "timeout"` with non-legacy text and the pod's real exit code.
    // Its exact output is pinned by `execute: timeout result construction` in
    // vendor/paperclip-adapter-claude-k8s/src/server/execute.test.ts; this pins
    // how the server finalizes it. Under the old regex an exit-0 run here
    // finalized `failed`; it must now be `succeeded`.
    const claudeK8sTimeout = (exitCode: number | null) => ({
      exitCode,
      signal: null,
      timedOut: true,
      errorCode: "timeout",
      errorMessage: "Timed out after 7200s (Job activeDeadlineSeconds; adapter timeoutSec=0)",
      resultJson: { observedTimeoutSec: 7200, observedTimeoutSource: "job_deadline", configuredTimeoutSec: 0 },
    });

    it("finalizes a claude_k8s exit-0 timeout as succeeded", () => {
      expect(finalize(claudeK8sTimeout(0))).toBe("succeeded");
    });

    it("finalizes a claude_k8s non-zero or unknown-exit timeout as timed_out", () => {
      expect(finalize(claudeK8sTimeout(137))).toBe("timed_out");
      expect(finalize(claudeK8sTimeout(null))).toBe("timed_out");
    });
  });

  describe("formatTimeoutMessage (BLO-23296)", () => {
    it("reports measured elapsed time, not the configured timeoutSec", () => {
      const startedAt = "2026-08-08T00:00:00.000Z";
      const now = Date.parse(startedAt) + 384_000; // 6m24s, as on run 90ac448e
      const message = formatTimeoutMessage(3600, startedAt, now);
      expect(message).not.toBe("Timed out after 3600s");
      expect(message).toBe("Timed out after 384s (limit 3600s)");
    });

    it("omits the duration when no start time is known", () => {
      expect(formatTimeoutMessage(3600, null)).toBe("Timed out (limit 3600s)");
    });
  });
});
