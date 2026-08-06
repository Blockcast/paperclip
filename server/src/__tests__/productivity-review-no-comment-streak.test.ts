import { describe, expect, it } from "vitest";
import {
  computeNoCommentStreak,
  isZeroTokenAbortRun,
  type NoCommentStreakRunInput,
} from "../services/recovery/zero-token-startup-failure.js";

// BLO-22054. The `issue_productivity_review` detector reported a no-comment
// streak of 5 against PlatformSREEngineer on BLO-20960. Four of those runs were
// terminal-failed having burned zero tokens — the harness never started them,
// so the agent had no opportunity to comment — and the fifth never left
// `queued` behind the executionRunId lock (BLO-20321). The verdict framework
// offers "stop/cancel the work", so a manager trusting that 5 could have
// cancelled healthy work on the strength of four infrastructure aborts.

const ZERO_TOKEN_USAGE = { inputTokens: 0, outputTokens: 0 } as const;
const REAL_USAGE = { inputTokens: 18_432, outputTokens: 1_204 } as const;

// The five runs from BLO-20960 exactly as recorded, newest first, plus the
// genuine no-comment run beneath them that the streak should actually report.
const BLO_20960_RUNS: NoCommentStreakRunInput[] = [
  { id: "d3bb3c91-6185-40cc-8c57-2ddb142c3108", status: "queued", usageJson: null },
  { id: "ebf6b9a6-cbb8-49a7-b935-d50fb0f802b6", status: "failed", usageJson: { ...ZERO_TOKEN_USAGE } },
  { id: "cec4bf99-78e5-427c-8138-5e34669772bb", status: "failed", usageJson: { ...ZERO_TOKEN_USAGE } },
  { id: "5c8a5826-d201-482f-bfec-fbe8ada30dfa", status: "failed", usageJson: { ...ZERO_TOKEN_USAGE } },
  { id: "f35e34a6-3728-4d22-9d23-aa5949c576ff", status: "failed", usageJson: { ...ZERO_TOKEN_USAGE } },
  { id: "genuine-silent-run", status: "succeeded", usageJson: { ...REAL_USAGE } },
];

describe("computeNoCommentStreak (BLO-22054)", () => {
  it("reports 1, not 5, over the recorded BLO-20960 run set", () => {
    const result = computeNoCommentStreak(BLO_20960_RUNS, new Set());

    expect(result.streak).toBe(1);
    expect(result.zeroTokenAborts).toBe(4);
  });

  it("does not count a run that never left queued as an abort or a silence", () => {
    const result = computeNoCommentStreak(
      [{ id: "never-started", status: "queued", usageJson: null }],
      new Set(),
    );

    expect(result.streak).toBe(0);
    expect(result.zeroTokenAborts).toBe(0);
  });

  it("skips non-terminal runs of every active status", () => {
    const result = computeNoCommentStreak(
      [
        { id: "a", status: "running", usageJson: { ...REAL_USAGE } },
        { id: "b", status: "scheduled_retry", usageJson: null },
        { id: "c", status: "succeeded", usageJson: { ...REAL_USAGE } },
      ],
      new Set(),
    );

    expect(result).toEqual({ streak: 1, zeroTokenAborts: 0 });
  });

  it("counts consecutive genuine silent runs across an interleaved abort", () => {
    // Skipping must be transparent, not stream-breaking: a flaky harness
    // landing between two genuinely silent runs must not reset the counter, or
    // the flakiness would mask a real silence problem instead of fabricating one.
    const result = computeNoCommentStreak(
      [
        { id: "silent-1", status: "succeeded", usageJson: { ...REAL_USAGE } },
        { id: "abort", status: "failed", usageJson: { ...ZERO_TOKEN_USAGE } },
        { id: "silent-2", status: "succeeded", usageJson: { ...REAL_USAGE } },
      ],
      new Set(),
    );

    expect(result).toEqual({ streak: 2, zeroTokenAborts: 1 });
  });

  it("breaks the streak at the newest run that produced a comment", () => {
    const result = computeNoCommentStreak(
      [
        { id: "silent", status: "succeeded", usageJson: { ...REAL_USAGE } },
        { id: "commented", status: "succeeded", usageJson: { ...REAL_USAGE } },
        { id: "older-silent", status: "succeeded", usageJson: { ...REAL_USAGE } },
      ],
      new Set(["commented"]),
    );

    expect(result).toEqual({ streak: 1, zeroTokenAborts: 0 });
  });

  it("lets a commenting run break the streak even if it recorded no usage", () => {
    // Ordering guard: the comment check runs before the abort check, so a run
    // credited with a comment always breaks the streak whatever its usage says.
    const result = computeNoCommentStreak(
      [
        { id: "abort", status: "failed", usageJson: { ...ZERO_TOKEN_USAGE } },
        { id: "commented-no-usage", status: "failed", usageJson: null },
        { id: "older-silent", status: "succeeded", usageJson: { ...REAL_USAGE } },
      ],
      new Set(["commented-no-usage"]),
    );

    expect(result).toEqual({ streak: 0, zeroTokenAborts: 1 });
  });

  it("still counts a genuinely silent streak with no aborts in play", () => {
    // The detector must keep firing on real silence — this change narrows a
    // false positive, it does not disarm the trigger.
    const runs = Array.from({ length: 10 }, (_, index) => ({
      id: `silent-${index}`,
      status: "succeeded",
      usageJson: { ...REAL_USAGE },
    }));

    expect(computeNoCommentStreak(runs, new Set())).toEqual({
      streak: 10,
      zeroTokenAborts: 0,
    });
  });

  it("counts succeeded runs that recorded no usage at all", () => {
    // Guard against re-widening the exclusion to every terminal status. Not
    // every adapter persists usage_json; if a succeeded run with no usage read
    // as an abort, the streak trigger would silently disarm itself fleet-wide.
    const runs = Array.from({ length: 10 }, (_, index) => ({
      id: `silent-${index}`,
      status: "succeeded",
      usageJson: null,
    }));

    expect(computeNoCommentStreak(runs, new Set())).toEqual({
      streak: 10,
      zeroTokenAborts: 0,
    });
  });
});

describe("isZeroTokenAbortRun (BLO-22054)", () => {
  it("treats an absent usage blob on a terminal run as an abort", () => {
    expect(isZeroTokenAbortRun({ id: "r", status: "failed", usageJson: null })).toBe(true);
  });

  it("accepts snake_case usage keys", () => {
    expect(
      isZeroTokenAbortRun({
        id: "r",
        status: "failed",
        usageJson: { input_tokens: 512, output_tokens: 0 },
      }),
    ).toBe(false);
  });

  it("does not treat a cached-input replay as an abort", () => {
    // Cached input still means the run reached the model, so it had every
    // opportunity to comment. Excluding it would excuse a real silent run.
    expect(
      isZeroTokenAbortRun({
        id: "r",
        status: "failed",
        usageJson: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 24_000 },
      }),
    ).toBe(false);
  });

  it("classifies zero-token runs of every unsuccessful terminal status", () => {
    for (const status of ["failed", "cancelled", "timed_out"]) {
      expect(isZeroTokenAbortRun({ id: "r", status, usageJson: null })).toBe(true);
    }
  });

  it("never classifies a succeeded run as an abort, even with no usage recorded", () => {
    // A succeeded run that reports no usage is a usage-reporting gap, not a
    // harness abort — it ran. Widening the exclusion to cover it would read
    // the entire no-comment history of any adapter that does not persist
    // usage_json as aborts, silently disarming the streak trigger.
    for (const status of ["succeeded", "interrupted"]) {
      expect(isZeroTokenAbortRun({ id: "r", status, usageJson: null })).toBe(false);
    }
  });

  it("never classifies a non-terminal run as an abort", () => {
    for (const status of ["queued", "running", "scheduled_retry"]) {
      expect(isZeroTokenAbortRun({ id: "r", status, usageJson: null })).toBe(false);
    }
  });
});
