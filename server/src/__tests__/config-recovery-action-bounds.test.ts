import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("recovery action bounds config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.RECOVERY_ACTION_MAX_ATTEMPTS;
    delete process.env.RECOVERY_ACTION_TIMEOUT_MS;
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("preserves the legacy wake-owner bounds when overrides are unset", () => {
    expect(loadConfig()).toMatchObject({
      recoveryActionMaxAttempts: 5,
      recoveryActionTimeoutMs: 6 * 60 * 60_000,
    });
  });

  it("uses explicit recovery action bounds overrides", () => {
    process.env.RECOVERY_ACTION_MAX_ATTEMPTS = "9";
    process.env.RECOVERY_ACTION_TIMEOUT_MS = String(2 * 60 * 60_000);

    expect(loadConfig()).toMatchObject({
      recoveryActionMaxAttempts: 9,
      recoveryActionTimeoutMs: 2 * 60 * 60_000,
    });
  });
});
