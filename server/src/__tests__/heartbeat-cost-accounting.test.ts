import { describe, expect, it } from "vitest";
import {
  countConsecutiveZeroTokenCompletedRuns,
  resolveLedgerCostStatus,
} from "../services/heartbeat.js";

describe("heartbeat cost accounting", () => {
  it("marks token-bearing CLI usage without a reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
    })).toBe("unpriced");
  });

  it("marks reported CLI cost as priced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 1.25,
      inputTokens: 2_090,
      cachedInputTokens: 300_000,
      outputTokens: 77_000,
    })).toBe("reported");
  });
});

/**
 * BLO-29842. Anthropic bills three input classes at three prices — fresh input
 * (1x), cache creation (1.25x/2x) and cache read (0.1x) — so cache creation has
 * to survive as its own quantity all the way to `cost_events`. These cover the
 * server-side leg: the raw snake_case payload is read, and a provider that
 * reports no cache-creation field is unaffected.
 */
describe("cache-write token accounting (BLO-29842)", () => {
  const completed = (usageJson: Record<string, unknown> | null) => ({
    status: "succeeded",
    usageJson,
  });

  it("reads cache_creation_input_tokens out of a raw Anthropic usage payload", () => {
    // A run that only wrote cache did real, billable model work. If the raw
    // snake_case field were not mapped server-side this would read as a
    // zero-token run and be misclassified as throttled/never-reached-the-model.
    expect(
      countConsecutiveZeroTokenCompletedRuns([
        completed({
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 48_000,
          output_tokens: 0,
        }),
      ]),
    ).toBe(0);
  });

  it("prefers the raw cache-creation total when both raw and normalized are present", () => {
    expect(
      countConsecutiveZeroTokenCompletedRuns([
        completed({
          rawInputTokens: 0,
          rawCachedInputTokens: 0,
          rawCacheCreationInputTokens: 12_000,
          rawOutputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
      ]),
    ).toBe(0);
  });

  it("leaves providers that report no cache-creation field unchanged", () => {
    // The absent case: nothing to map, so this is still a genuine zero-token run.
    expect(
      countConsecutiveZeroTokenCompletedRuns([
        completed({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }),
      ]),
    ).toBe(1);
  });

  it("counts a cache-write-only run as billable usage when no cost was reported", () => {
    expect(
      resolveLedgerCostStatus({
        costUsd: null,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 48_000,
        outputTokens: 0,
      }),
    ).toBe("unpriced");
  });

  it("treats a run with no usage of any class as reported", () => {
    expect(
      resolveLedgerCostStatus({
        costUsd: null,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("reported");
  });
});
