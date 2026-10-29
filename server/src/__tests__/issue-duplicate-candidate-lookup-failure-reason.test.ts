/**
 * PEN-3596: the create-time duplicate-candidate lookup degrades gracefully in
 * four quite different ways, and until now all four logged the same
 * "lookup failed" line. Three of them are uninteresting; one
 * (`connection_unavailable`) is pool pressure.
 *
 * Why this sits on PEN-3596 rather than on a row of its own: the row's
 * acceptance criterion is "no `canceling statement due to statement timeout`
 * on this query shape in `paperclip-pg-0` over a representative window", and
 * this path emits that exact log line *by design*. Measured on the live
 * cluster 2026-10-29 11:55:57Z-12:38:16Z, three such lines appeared in 42
 * minutes and only one was the issues-list defect; the other two were this
 * 500 ms budget firing. `log_line_prefix` is `%m [%p]` with no
 * `application_name`, so the server log cannot separate them — which is what
 * makes an application-side classification the discriminator.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCreateIssueDuplicateCandidateLookupFailure,
  ISSUE_CREATE_DUPLICATE_CANDIDATE_TIMEOUT_MS,
  raceCreateIssueDuplicateCandidateLookup,
} from "../routes/issues.js";

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error("canceling statement due to statement timeout"), { code });
}

describe("classifyCreateIssueDuplicateCandidateLookupFailure", () => {
  it("reports the deliberate transaction-local budget as statement_timeout, not a failure", () => {
    expect(classifyCreateIssueDuplicateCandidateLookupFailure(postgresError("57014")))
      .toBe("statement_timeout");
  });

  it("does not classify other transient SQLSTATEs as the designed budget", () => {
    for (const code of ["40P01", "40001", "55P03"]) {
      expect(classifyCreateIssueDuplicateCandidateLookupFailure(postgresError(code))).toBe("error");
    }
  });

  it("separates pool pressure from the budget", () => {
    const err = new Error(
      "issue duplicate candidate lookup skipped because no database connection was available within 500ms",
    );
    expect(classifyCreateIssueDuplicateCandidateLookupFailure(err)).toBe("connection_unavailable");
  });

  it("classifies the wall-clock race loss as lookup_timeout", async () => {
    // Drive the real race rather than asserting against a hand-written string,
    // so a reworded rejection cannot silently demote this to "error".
    const err = await raceCreateIssueDuplicateCandidateLookup(
      new Promise(() => {}),
      1,
    ).catch((caught: unknown) => caught);
    expect(classifyCreateIssueDuplicateCandidateLookupFailure(err)).toBe("lookup_timeout");
  });

  it("falls back to error for an unexpected failure, and for non-Error throws", () => {
    expect(classifyCreateIssueDuplicateCandidateLookupFailure(new Error("boom"))).toBe("error");
    expect(classifyCreateIssueDuplicateCandidateLookupFailure(undefined)).toBe("error");
    expect(classifyCreateIssueDuplicateCandidateLookupFailure("boom")).toBe("error");
  });

  it("keeps the budget small enough that this path cannot reach the 30s role timeout", () => {
    // The whole point of the local budget: a cancellation here is never the
    // role-level `statement_timeout` the row is about.
    expect(ISSUE_CREATE_DUPLICATE_CANDIDATE_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
