/**
 * Pure unit tests for credential-health.ts, independent of the webhook
 * plumbing (see worker.test.ts for the handleWebhook integration coverage).
 *
 * Regression cover for BLO-20572: through two outages the alertmanager
 * plugin reported `status: ok` while rejecting 100% of deliveries because
 * `onHealth()` returned a hardcoded `{ status: "ok" }`. `onHealth()` has no
 * company scope, so this module is fed from observed delivery outcomes
 * instead of a config probe.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  getCredentialHealth,
  recordCredentialResolution,
  resetCredentialHealth,
} from "../credential-health.js";

beforeEach(() => {
  resetCredentialHealth();
});

describe("getCredentialHealth", () => {
  it("is ok when no delivery has been recorded (absence of traffic is not a fault)", () => {
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("goes degraded and names the company once a resolution fails", () => {
    recordCredentialResolution("company-x", null);

    const health = getCredentialHealth();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("company-x");
    expect(health.details).toEqual({ companyIds: ["company-x"] });
  });

  it("treats an empty-string token the same as no token", () => {
    recordCredentialResolution("company-x", "");
    expect(getCredentialHealth().status).toBe("degraded");
  });

  it("returns to ok once that company later resolves a credential, no restart involved", () => {
    recordCredentialResolution("company-x", null);
    expect(getCredentialHealth().status).toBe("degraded");

    recordCredentialResolution("company-x", "a-real-token");
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("reports each affected company independently", () => {
    recordCredentialResolution("company-a", null);
    recordCredentialResolution("company-b", "token-b");
    recordCredentialResolution("company-c", null);

    expect(getCredentialHealth().details).toEqual({
      companyIds: ["company-a", "company-c"],
    });
  });

  it("never includes a secret value in the health output", () => {
    const token = "super-secret-value-should-never-appear";
    recordCredentialResolution("company-x", null);
    recordCredentialResolution("company-y", token);

    const serialized = JSON.stringify(getCredentialHealth());
    expect(serialized).not.toContain(token);
  });
});
