import { describe, expect, it } from "vitest";
import {
  isPlausiblySensitiveEnvValue,
  isSensitiveEnvKey,
} from "./sensitive-env.js";

describe("sensitive env detection", () => {
  it.each([
    "TOKEN",
    "WEBFLOW_BOT_CONTROL_TOKEN",
    "ORC8R_CERTIFIER_TOKEN",
    "GENERIC_TOKEN",
    "GHTOKEN",
    "CONTROLTOKEN",
    "LINEAR_API_KEY",
    "OCM_QA_WALLET_PRIVATE_KEY_BASE58",
  ])("recognizes %s as a sensitive key", (key) => {
    expect(isSensitiveEnvKey(key)).toBe(true);
  });

  it("does not match token as part of a non-token suffix", () => {
    expect(isSensitiveEnvKey("TOKENIZED_OUTPUT")).toBe(false);
  });

  it("recognizes credential-shaped values without exposing their contents", () => {
    expect(isPlausiblySensitiveEnvValue("ghp_0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isPlausiblySensitiveEnvValue("  ghp_0123456789abcdef0123456789abcdef\n")).toBe(true);
    expect(isPlausiblySensitiveEnvValue("production")).toBe(false);
  });
});
