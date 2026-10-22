import { describe, expect, it } from "vitest";

import {
  CASH_ZEROING_BILLING_TYPE,
  isBrokeredLane,
  isPenstockBaseUrl,
  normalizeLedgerBillingType,
  resolveLedgerBillingType,
} from "./billing-classification.js";

/**
 * The live lane, measured 2026-10-22 inside a running `claude_k8s` agent Job pod. Both
 * production tiers source `ANTHROPIC_API_KEY` from `secretKeyRef: paperclip-penstock-org-key`.
 */
const LIVE_PENSTOCK_BASE_URL = "https://api.penstock.run/anthropic";

describe("isPenstockBaseUrl", () => {
  it("accepts the live production lane and other penstock.run hosts", () => {
    expect(isPenstockBaseUrl(LIVE_PENSTOCK_BASE_URL)).toBe(true);
    expect(isPenstockBaseUrl("https://api.penstock.run")).toBe(true);
    expect(isPenstockBaseUrl("https://eu.penstock.run/anthropic")).toBe(true);
  });

  it("rejects direct provider endpoints", () => {
    expect(isPenstockBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(isPenstockBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("is hostname-exact, so a lookalike host cannot claim brokered status", () => {
    // A substring test for "penstock" would accept all three. What we assert about money
    // must not be forgeable by choosing a hostname.
    expect(isPenstockBaseUrl("https://penstock.run.evil.test/anthropic")).toBe(false);
    expect(isPenstockBaseUrl("https://notpenstock.run.example.com")).toBe(false);
    expect(isPenstockBaseUrl("https://api.penstock.run.attacker.test")).toBe(false);
  });

  it("treats absent, blank and unparseable values as not brokered", () => {
    expect(isPenstockBaseUrl(null)).toBe(false);
    expect(isPenstockBaseUrl(undefined)).toBe(false);
    expect(isPenstockBaseUrl("   ")).toBe(false);
    expect(isPenstockBaseUrl("not a url")).toBe(false);
  });
});

describe("normalizeLedgerBillingType", () => {
  it("maps adapter vocabulary onto the ledger union", () => {
    expect(normalizeLedgerBillingType("api")).toBe("metered_api");
    expect(normalizeLedgerBillingType("metered_api")).toBe("metered_api");
    expect(normalizeLedgerBillingType("subscription")).toBe("subscription_included");
    expect(normalizeLedgerBillingType("subscription_overage")).toBe("subscription_overage");
    expect(normalizeLedgerBillingType("credits")).toBe("credits");
    expect(normalizeLedgerBillingType("fixed")).toBe("fixed");
  });

  it("falls back to unknown for unrecognised, empty and non-string input", () => {
    expect(normalizeLedgerBillingType("nonsense")).toBe("unknown");
    expect(normalizeLedgerBillingType("")).toBe("unknown");
    expect(normalizeLedgerBillingType(null)).toBe("unknown");
    expect(normalizeLedgerBillingType(undefined)).toBe("unknown");
    expect(normalizeLedgerBillingType(42)).toBe("unknown");
  });
});

describe("isBrokeredLane", () => {
  it("reads the provider's own base-URL variable, not another provider's", () => {
    // An anthropic run must not be called brokered because OPENAI_BASE_URL happens to
    // point at Penstock, which it does on both production tiers.
    expect(
      isBrokeredLane({
        provider: "anthropic",
        env: { OPENAI_BASE_URL: LIVE_PENSTOCK_BASE_URL, ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      }),
    ).toBe(false);
    expect(
      isBrokeredLane({
        provider: "openai",
        env: { OPENAI_BASE_URL: LIVE_PENSTOCK_BASE_URL, ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      }),
    ).toBe(true);
  });

  it("prefers adapterConfig.env over process-level env, as the availability gate does", () => {
    const env = { ANTHROPIC_BASE_URL: LIVE_PENSTOCK_BASE_URL };
    expect(
      isBrokeredLane({
        provider: "anthropic",
        adapterConfig: { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
        env,
      }),
    ).toBe(false);
    // All 11 live agents carry `adapterConfig: {}`, so the process-env fallback is the
    // arm that actually runs in production today.
    expect(isBrokeredLane({ provider: "anthropic", adapterConfig: {}, env })).toBe(true);
  });

  it("never treats a provider it does not broker as brokered", () => {
    // openrouter bills its own key directly; it has no base-URL entry and must stay metered.
    expect(
      isBrokeredLane({ provider: "openrouter", env: { ANTHROPIC_BASE_URL: LIVE_PENSTOCK_BASE_URL } }),
    ).toBe(false);
    expect(isBrokeredLane({ provider: "unknown", env: { ANTHROPIC_BASE_URL: LIVE_PENSTOCK_BASE_URL } })).toBe(false);
    expect(isBrokeredLane({ provider: null, env: { ANTHROPIC_BASE_URL: LIVE_PENSTOCK_BASE_URL } })).toBe(false);
  });
});

describe("resolveLedgerBillingType", () => {
  const penstockEnv = { ANTHROPIC_BASE_URL: LIVE_PENSTOCK_BASE_URL };
  const directEnv = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };

  it("corrects the live claude_k8s lane, which reports an unconditional 'api'", () => {
    // 9 of 11 lanes. `vendor/paperclip-adapter-claude-k8s` carries one hardcoded literal.
    expect(
      resolveLedgerBillingType({ reported: "api", provider: "anthropic", adapterConfig: {}, env: penstockEnv }),
    ).toBe("unknown");
  });

  it("corrects the live claude_local lane, whose 'api' is inferred from a Penstock key", () => {
    // 2 of 11 lanes. `resolveClaudeBillingType` sees ANTHROPIC_API_KEY set — with the
    // psk_… Penstock org key the platform itself wrote there — and concludes "api".
    expect(
      resolveLedgerBillingType({ reported: "api", provider: "anthropic", env: penstockEnv }),
    ).toBe("unknown");
  });

  it("leaves a genuinely direct metered lane untouched", () => {
    expect(resolveLedgerBillingType({ reported: "api", provider: "anthropic", env: directEnv })).toBe("metered_api");
    expect(resolveLedgerBillingType({ reported: "metered_api", provider: "openrouter", env: penstockEnv })).toBe(
      "metered_api",
    );
  });

  it("passes non-metered claims through unchanged on a brokered lane", () => {
    // Correcting only the direct-metered claim is the whole scope. An adapter that has
    // real evidence of a subscription keeps its answer.
    for (const reported of ["subscription", "subscription_overage", "credits", "fixed", "unknown"] as const) {
      const expected = normalizeLedgerBillingType(reported);
      expect(resolveLedgerBillingType({ reported, provider: "anthropic", env: penstockEnv })).toBe(expected);
    }
  });

  /**
   * THE INVARIANT THAT MAKES LANDING THIS SAFE.
   *
   * `subscription_included` is the one value `normalizeBilledCostCents` zeroes. PEN-4463's
   * ruling was that correcting classification alone would take every cap to $0 silently.
   * This asserts the correction cannot synthesise that value — so no cap can move, and the
   * assertion fails rather than the fleet if anyone later widens the correction.
   */
  it("never synthesises the cash-zeroing type that was not already reported", () => {
    const reportedValues = [
      "api",
      "metered_api",
      "subscription_overage",
      "credits",
      "fixed",
      "unknown",
      "nonsense",
      "",
      null,
      undefined,
    ];
    const providers = ["anthropic", "claude", "openai", "codex", "openrouter", "unknown", null];
    const envs = [penstockEnv, directEnv, {}];

    for (const reported of reportedValues) {
      for (const provider of providers) {
        for (const env of envs) {
          const resolved = resolveLedgerBillingType({ reported, provider, adapterConfig: {}, env });
          expect(resolved).not.toBe(CASH_ZEROING_BILLING_TYPE);
        }
      }
    }

    // Positive control: the value IS reachable when an adapter genuinely reports it, so
    // the sweep above is proving a property rather than passing vacuously.
    expect(
      resolveLedgerBillingType({ reported: "subscription", provider: "anthropic", env: penstockEnv }),
    ).toBe(CASH_ZEROING_BILLING_TYPE);
  });
});
