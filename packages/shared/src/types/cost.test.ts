import { describe, expect, it } from "vitest";
import { promptTokens, totalTokens } from "./cost.js";

// BLO-29842 split Anthropic cache writes out of `inputTokens` into their own
// column. Every volume total in the app used to read `inputTokens` and get
// fresh+creation; these helpers exist so that meaning lives in one place rather
// than being re-derived at ~13 call sites, one of which will otherwise drift.
describe("promptTokens", () => {
  it("counts cache writes as prompt tokens", () => {
    expect(promptTokens({ inputTokens: 1_000, cacheCreationInputTokens: 24_000 })).toBe(25_000);
  });

  // The regression this guards: summing `inputTokens` alone silently
  // under-reports by the whole cache-write volume, which on a cache-heavy
  // workload is most of the prompt.
  it("is strictly larger than inputTokens alone whenever cache was written", () => {
    const row = { inputTokens: 1_000, cacheCreationInputTokens: 24_000 };
    expect(promptTokens(row)).toBeGreaterThan(row.inputTokens);
  });

  // Cache reads bill at ~0.1x and stay a separate class — folding them in here
  // would overstate billed prompt volume and break the rate-card fit this
  // column was added to make possible.
  it("excludes cache reads", () => {
    expect(promptTokens({ inputTokens: 10, cacheCreationInputTokens: 0 })).toBe(10);
  });

  it("is a no-op for providers that report no cache creation", () => {
    expect(promptTokens({ inputTokens: 500, cacheCreationInputTokens: 0 })).toBe(500);
  });
});

describe("totalTokens", () => {
  it("sums all four billed classes", () => {
    expect(totalTokens({
      inputTokens: 1_000,
      cachedInputTokens: 45_000,
      cacheCreationInputTokens: 24_000,
      outputTokens: 2_000,
    })).toBe(72_000);
  });

  it("is zero only when every class is zero", () => {
    expect(totalTokens({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    })).toBe(0);
    expect(totalTokens({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 1,
      outputTokens: 0,
    })).toBe(1);
  });
});
