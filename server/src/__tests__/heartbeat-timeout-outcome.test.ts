import { describe, expect, it } from "vitest";
import {
  isConfirmedAdapterTimeout,
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
    expect(isSuccessfulAdapterResult({
      timedOut: true,
      exitCode: 0,
      errorMessage: "Result publication failed",
      errorCode: "timeout",
      resultJson: { summary: "work completed" },
    })).toBe(false);
  });
});
