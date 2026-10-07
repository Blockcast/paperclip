import { describe, expect, it } from "vitest";
import { promptTokens, totalTokens, type BilledTokenCounts } from "./cost.js";

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
  // column was added to make possible. The read leg is deliberately far larger
  // than the other two: on this fleet it is ~99% of the prompt, so a helper
  // that leaked it would be off by orders of magnitude, not by a rounding.
  // Bound to a variable because `promptTokens` takes a `Pick<>` and an inline
  // literal would be rejected for the excess property rather than exercising it.
  it("excludes cache reads", () => {
    const row = { inputTokens: 10, cachedInputTokens: 400_000, cacheCreationInputTokens: 0 };
    expect(promptTokens(row)).toBe(10);
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

// The types say every leg is required; the WIRE does not. Both helpers are
// called straight onto API-deserialized rows in the UI, so during the rolling
// deploy that ships this column a new bundle can reach an old pod whose
// response omits it. Bare `+` propagates the absent leg into the whole sum as
// `NaN` — every tile renders "NaN" rather than the old, merely-stale number.
// The casts are the point: they reproduce a shape TypeScript cannot see.
// Reverting the `?? 0` legs in cost.ts reddens these two and nothing else.
describe("absent legs on the wire (rolling-deploy window)", () => {
  it("promptTokens drops an absent cache-write leg instead of poisoning the sum", () => {
    const stale = { inputTokens: 1_000 } as unknown as BilledTokenCounts;
    expect(promptTokens(stale)).toBe(1_000);
  });

  it("totalTokens drops absent legs instead of poisoning the sum", () => {
    const stale = { inputTokens: 1_000, outputTokens: 2_000 } as unknown as BilledTokenCounts;
    expect(totalTokens(stale)).toBe(3_000);
  });
});
