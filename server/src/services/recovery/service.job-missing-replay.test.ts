import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

type Run = Parameters<typeof classifyContinuationFailure>[0];

describe("job_missing continuation recovery", () => {
  it("does not treat an invoked external lifecycle Job as retryable work", () => {
    const classification = classifyContinuationFailure({ errorCode: "job_missing" } as unknown as Run);

    expect(classification).toMatchObject({
      kind: "non_retryable",
      maxAttempts: 0,
      errorCode: "job_missing",
    });
  });
});
