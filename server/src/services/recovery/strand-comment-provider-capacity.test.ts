// BLO-18278 AC3 — when a strand is genuinely unavoidable, the comment must
// name the provider 429 and its advertised reset instant.
//
// The text this replaces is the one the real strand on BLO-18278 produced:
//
//   Latest retry failure: `job_failed` - External lifecycle Job failed:
//   BackoffLimitExceeded: Job has reached the specified backoff limit.
//
// That describes the symptom (our Job gave up) and reads as an infrastructure
// fault. It sent readers to the cluster while the actual cause was a provider
// capacity window that had already reopened on its own. Naming the 429 and the
// instant is the difference between "our runtime broke" and "the provider was
// closed until 21:29:59Z".
import { describe, expect, it } from "vitest";
import { summarizeRunFailureForIssueComment } from "./service.js";

const RESET_ISO = "2026-07-26T21:29:59.782Z";

function run(overrides: Record<string, unknown>) {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "failed",
    error: null,
    errorCode: null,
    contextSnapshot: null,
    livenessState: null,
    resultJson: null,
    usageJson: null,
    createdAt: new Date(),
    ...overrides,
  } as Parameters<typeof summarizeRunFailureForIssueComment>[0];
}

describe("summarizeRunFailureForIssueComment — provider capacity 429", () => {
  it("names the 429 and the reset instant instead of the BackoffLimitExceeded symptom", () => {
    const summary = summarizeRunFailureForIssueComment(
      run({
        errorCode: "job_failed",
        error: "External lifecycle Job failed: BackoffLimitExceeded: Job has reached the specified backoff limit.",
        resultJson: {
          errorFamily: "rate_limit_exhausted",
          providerCapacityResetAt: RESET_ISO,
        },
      }),
    );

    expect(summary).toContain("429");
    expect(summary).toContain(RESET_ISO);
    expect(summary).toContain("transient");
    // The generic symptom text must not be what the reader sees first.
    expect(summary).not.toContain("BackoffLimitExceeded");
    // ...but the terminal code is still recoverable for anyone debugging.
    expect(summary).toContain("job_failed");
  });

  it("derives the instant from retryNotBefore when the explicit field is absent", () => {
    const summary = summarizeRunFailureForIssueComment(
      run({
        errorCode: "rate_limit_exhausted",
        resultJson: { errorFamily: "rate_limit_exhausted", retryNotBefore: RESET_ISO },
      }),
    );
    expect(summary).toContain(RESET_ISO);
    expect(summary).toContain("429");
  });

  it("leaves non-throttle failures on the generic summary", () => {
    // A bare retryNotBefore on some other family is not a capacity 429, and a
    // real crash must keep reporting itself as a crash.
    const summary = summarizeRunFailureForIssueComment(
      run({
        errorCode: "adapter_failed",
        error: "TypeError: x is not a function",
        resultJson: { errorFamily: "transient_upstream", retryNotBefore: RESET_ISO },
      }),
    );
    expect(summary).toContain("adapter_failed");
    expect(summary).toContain("TypeError");
    expect(summary).not.toContain("429");
  });

  it("still summarizes a plain failure with no resultJson", () => {
    const summary = summarizeRunFailureForIssueComment(
      run({ errorCode: "job_failed", error: "External lifecycle Job failed: BackoffLimitExceeded" }),
    );
    expect(summary).toContain("job_failed");
    expect(summary).toContain("BackoffLimitExceeded");
  });

  it("returns null when there is no run", () => {
    expect(summarizeRunFailureForIssueComment(null)).toBeNull();
  });
});
