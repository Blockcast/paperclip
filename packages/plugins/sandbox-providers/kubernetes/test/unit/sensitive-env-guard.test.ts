import { describe, it, expect } from "vitest";
import {
  isSensitiveEnvName,
  findLiteralSensitiveEnvVars,
  assertNoLiteralSensitiveEnv,
} from "../../src/sensitive-env-guard.js";

function podSpecWithEnv(env: unknown[], key = "containers"): Record<string, unknown> {
  return { [key]: [{ name: "agent", env }] };
}

describe("isSensitiveEnvName", () => {
  it("matches the agreed credential-name patterns, case-insensitively", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "BOOTSTRAP_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "DB_PASSWORD",
      "AWS_CREDENTIAL_FILE_CONTENTS",
      "PROXY_AUTHORIZATION",
      "lowercase_token",
    ]) {
      expect(isSensitiveEnvName(name), name).toBe(true);
    }
  });

  it("does not match ordinary configuration names", () => {
    for (const name of ["HOME", "PATH", "PAPERCLIP_RUN_ID", "NODE_ENV", "HOSTNAME"]) {
      expect(isSensitiveEnvName(name), name).toBe(false);
    }
  });

  it("exempts *_FILE path pointers, which hold a mount path and not the secret", () => {
    // Rejecting these would push callers off the very pattern we want them on.
    expect(isSensitiveEnvName("PAPERCLIP_GITHUB_TOKEN_FILE")).toBe(false);
    expect(isSensitiveEnvName("PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE")).toBe(false);
  });
});

describe("findLiteralSensitiveEnvVars", () => {
  it("reports a sensitive-named env var carrying a literal value", () => {
    const found = findLiteralSensitiveEnvVars(
      podSpecWithEnv([{ name: "ANTHROPIC_API_KEY", value: "sk-not-a-real-key" }]),
    );
    expect(found).toEqual([{ container: "agent", envName: "ANTHROPIC_API_KEY" }]);
  });

  it("accepts a sensitive name sourced via valueFrom.secretKeyRef", () => {
    const found = findLiteralSensitiveEnvVars(
      podSpecWithEnv([
        { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
      ]),
    );
    expect(found).toEqual([]);
  });

  it("accepts non-sensitive literals such as HOME", () => {
    expect(findLiteralSensitiveEnvVars(podSpecWithEnv([{ name: "HOME", value: "/home/paperclip" }])))
      .toEqual([]);
  });

  it("also inspects initContainers and ephemeralContainers", () => {
    for (const key of ["initContainers", "ephemeralContainers"]) {
      const found = findLiteralSensitiveEnvVars(
        podSpecWithEnv([{ name: "MCP_AUTH_HEADER", value: "Bearer nope" }], key),
      );
      expect(found, key).toEqual([{ container: "agent", envName: "MCP_AUTH_HEADER" }]);
    }
  });

  it("tolerates malformed specs without throwing", () => {
    expect(findLiteralSensitiveEnvVars(undefined)).toEqual([]);
    expect(findLiteralSensitiveEnvVars({})).toEqual([]);
    expect(findLiteralSensitiveEnvVars({ containers: "nope" })).toEqual([]);
    expect(findLiteralSensitiveEnvVars({ containers: [null, { env: [null, 7] }] })).toEqual([]);
  });
});

describe("assertNoLiteralSensitiveEnv", () => {
  it("throws naming the offending container and env var", () => {
    expect(() =>
      assertNoLiteralSensitiveEnv(
        podSpecWithEnv([{ name: "DB_PASSWORD", value: "hunter2" }]),
        "Job r-test",
      ),
    ).toThrow(/Job r-test.*agent\.env\[DB_PASSWORD\]/s);
  });

  it("does not leak the offending value into the error message", () => {
    const secret = "super-secret-value";
    let message = "";
    try {
      assertNoLiteralSensitiveEnv(podSpecWithEnv([{ name: "DB_PASSWORD", value: secret }]), "Job x");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(secret);
  });

  it("passes a clean spec", () => {
    expect(() =>
      assertNoLiteralSensitiveEnv(podSpecWithEnv([{ name: "HOME", value: "/home/paperclip" }]), "Job x"),
    ).not.toThrow();
  });
});
