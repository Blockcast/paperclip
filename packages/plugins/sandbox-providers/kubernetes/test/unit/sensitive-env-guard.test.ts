import { describe, it, expect } from "vitest";
import {
  isMountedSecretPath,
  isSafeLiteralEnv,
  findLiteralSensitiveEnvVars,
  assertNoLiteralSensitiveEnv,
  assertManifestHasNoLiteralSensitiveEnv,
} from "../../src/sensitive-env-guard.js";

function podSpecWithEnv(env: unknown[], key = "containers"): Record<string, unknown> {
  return { [key]: [{ name: "agent", env }] };
}

describe("isMountedSecretPath", () => {
  it("accepts absolute paths under a known secret-mount root", () => {
    for (const value of [
      "/paperclip/.secrets/github-token/token",
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "/run/secrets/db-password",
      "/etc/paperclip/tls.key",
    ]) {
      expect(isMountedSecretPath(value), value).toBe(true);
    }
  });

  it("rejects anything that is not actually a mounted path", () => {
    for (const value of [
      "sk-ant-not-a-real-key", // the bypass this check exists to close
      "ghp_0123456789abcdef",
      "relative/path/token",
      "/tmp/token", // absolute, but outside the allowed roots
      "/paperclip/../etc/shadow", // traversal
      "/paperclip/.secrets/a b", // whitespace
      "",
      undefined,
      42,
    ]) {
      expect(isMountedSecretPath(value), String(value)).toBe(false);
    }
  });
});

describe("isSafeLiteralEnv", () => {
  it("permits explicitly allowlisted non-secret names", () => {
    expect(isSafeLiteralEnv("HOME", "/home/paperclip")).toBe(true);
  });

  // This is the inversion. Under the previous denylist these all passed purely
  // because their names missed /TOKEN|SECRET|.../i. MCP_CONFIG is the known
  // counter-example: it carries a merged mcp.json with embedded
  // `Authorization: Bearer ...` headers.
  it("refuses any literal that is not affirmatively known to be safe", () => {
    for (const name of ["MCP_CONFIG", "PATH", "NODE_ENV", "PAPERCLIP_RUN_ID", "HOSTNAME"]) {
      expect(isSafeLiteralEnv(name, "anything"), name).toBe(false);
    }
  });

  it("permits a *_FILE pointer only when its value really is a mounted path", () => {
    expect(
      isSafeLiteralEnv("PAPERCLIP_GITHUB_TOKEN_FILE", "/paperclip/.secrets/github-token/token"),
    ).toBe(true);
    // The name-only exemption was a bypass: a *_FILE var whose value is the
    // credential itself, not a path to it.
    expect(isSafeLiteralEnv("API_TOKEN_FILE", "sk-ant-the-actual-token")).toBe(false);
    expect(isSafeLiteralEnv("DB_PASSWORD_FILE", "hunter2")).toBe(false);
  });
});

describe("findLiteralSensitiveEnvVars", () => {
  it("reports an env var carrying a literal credential value", () => {
    const found = findLiteralSensitiveEnvVars(
      podSpecWithEnv([{ name: "ANTHROPIC_API_KEY", value: "sk-not-a-real-key" }]),
    );
    expect(found).toEqual([
      { container: "agent", envName: "ANTHROPIC_API_KEY", reason: "not-allowlisted" },
    ]);
  });

  it("reports MCP_CONFIG, which the previous name-pattern denylist missed", () => {
    const found = findLiteralSensitiveEnvVars(
      podSpecWithEnv([{ name: "MCP_CONFIG", value: '{"headers":{"Authorization":"Bearer x"}}' }]),
    );
    expect(found).toEqual([{ container: "agent", envName: "MCP_CONFIG", reason: "not-allowlisted" }]);
  });

  it("reports a *_FILE var whose value is a credential rather than a path", () => {
    const found = findLiteralSensitiveEnvVars(
      podSpecWithEnv([{ name: "API_TOKEN_FILE", value: "sk-ant-the-actual-token" }]),
    );
    expect(found).toEqual([
      { container: "agent", envName: "API_TOKEN_FILE", reason: "file-pointer-not-a-path" },
    ]);
  });

  it("accepts a *_FILE var pointing at a real mounted secret path", () => {
    expect(
      findLiteralSensitiveEnvVars(
        podSpecWithEnv([
          { name: "PAPERCLIP_GITHUB_TOKEN_FILE", value: "/paperclip/.secrets/github-token/token" },
        ]),
      ),
    ).toEqual([]);
  });

  it("accepts a value sourced via valueFrom.secretKeyRef", () => {
    const found = findLiteralSensitiveEnvVars(
      podSpecWithEnv([
        { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
      ]),
    );
    expect(found).toEqual([]);
  });

  it("accepts the allowlisted HOME literal", () => {
    expect(findLiteralSensitiveEnvVars(podSpecWithEnv([{ name: "HOME", value: "/home/paperclip" }])))
      .toEqual([]);
  });

  it("also inspects initContainers and ephemeralContainers", () => {
    for (const key of ["initContainers", "ephemeralContainers"]) {
      const found = findLiteralSensitiveEnvVars(
        podSpecWithEnv([{ name: "MCP_AUTH_HEADER", value: "Bearer nope" }], key),
      );
      expect(found, key).toEqual([
        { container: "agent", envName: "MCP_AUTH_HEADER", reason: "not-allowlisted" },
      ]);
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

  it("tells the caller how to fix it, including the allowlist escape hatch", () => {
    let message = "";
    try {
      assertNoLiteralSensitiveEnv(podSpecWithEnv([{ name: "NODE_ENV", value: "production" }]), "Job x");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SAFE_LITERAL_ENV_NAMES");
    expect(message).toContain("secretKeyRef");
  });

  it("passes a clean spec", () => {
    expect(() =>
      assertNoLiteralSensitiveEnv(podSpecWithEnv([{ name: "HOME", value: "/home/paperclip" }]), "Job x"),
    ).not.toThrow();
  });
});

describe("assertManifestHasNoLiteralSensitiveEnv", () => {
  // The builders assert on their own output, but createJob/createSandboxCr take
  // an arbitrary manifest — this is the check that cannot be bypassed.
  const jobManifest = (env: unknown[]) => ({
    apiVersion: "batch/v1",
    kind: "Job",
    spec: { template: { spec: { containers: [{ name: "agent", env }] } } },
  });
  const sandboxCrManifest = (env: unknown[]) => ({
    apiVersion: "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    spec: { podTemplate: { spec: { containers: [{ name: "agent", env }] } } },
  });

  it("finds a pod spec nested under a Job's spec.template.spec", () => {
    expect(() =>
      assertManifestHasNoLiteralSensitiveEnv(
        jobManifest([{ name: "API_TOKEN", value: "leaked" }]),
        "Job in ns",
      ),
    ).toThrow(/agent\.env\[API_TOKEN\]/);
  });

  it("finds a pod spec nested under a Sandbox CR's spec.podTemplate.spec", () => {
    expect(() =>
      assertManifestHasNoLiteralSensitiveEnv(
        sandboxCrManifest([{ name: "API_TOKEN", value: "leaked" }]),
        "Sandbox in ns",
      ),
    ).toThrow(/agent\.env\[API_TOKEN\]/);
  });

  it("passes clean manifests of both shapes", () => {
    const clean = [{ name: "HOME", value: "/home/paperclip" }];
    expect(() => assertManifestHasNoLiteralSensitiveEnv(jobManifest(clean), "Job")).not.toThrow();
    expect(() =>
      assertManifestHasNoLiteralSensitiveEnv(sandboxCrManifest(clean), "Sandbox"),
    ).not.toThrow();
  });

  it("tolerates manifests with no pod spec, and cyclic/deep input", () => {
    expect(() => assertManifestHasNoLiteralSensitiveEnv({ kind: "ConfigMap" }, "cm")).not.toThrow();
    expect(() => assertManifestHasNoLiteralSensitiveEnv(null, "null")).not.toThrow();
    const cyclic: Record<string, unknown> = { kind: "Job" };
    cyclic.self = cyclic;
    // Depth-bounded, so a cycle terminates instead of blowing the stack.
    expect(() => assertManifestHasNoLiteralSensitiveEnv(cyclic, "cyclic")).not.toThrow();
  });

  // Recognising a pod spec and scanning one must agree on where containers
  // live, or a spec carrying only initContainers/ephemeralContainers would be
  // walked past without ever being scanned.
  it("recognises a pod spec by any container list, not just `containers`", () => {
    for (const key of ["containers", "initContainers", "ephemeralContainers"]) {
      const manifest = {
        kind: "Job",
        spec: { template: { spec: { [key]: [{ name: "agent", env: [{ name: "API_TOKEN", value: "x" }] }] } } },
      };
      expect(() => assertManifestHasNoLiteralSensitiveEnv(manifest, "Job"), key).toThrow(
        /agent\.env\[API_TOKEN\]/,
      );
    }
  });
});
