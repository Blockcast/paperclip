import { describe, expect, it } from "vitest";
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

  it("does not suppress a non-timeout error that accompanies exit zero", () => {
    const result = {
      timedOut: true,
      exitCode: 0,
      errorMessage: "Result publication failed",
      errorCode: "timeout",
      resultJson: { summary: "work completed" },
    };
    expect(isFalseAdapterTimeoutResult(result)).toBe(false);
    expect(isSuccessfulAdapterResult(result)).toBe(false);
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
});
