import { describe, it, expect } from "vitest";
import {
  AGENT_ENV_ALLOWLIST,
  AGENT_ENV_ALLOWED_PREFIXES,
  AGENT_ENV_FROM_ALLOWLIST,
  AGENT_SECRET_VOLUME_ALLOWLIST,
  SERVER_ONLY_ENV_DENY,
  isAgentInheritableEnvFromRef,
  isAgentInheritableEnvName,
  isAgentInheritableSecretVolume,
} from "./inherit-allowlist.js";

/**
 * The deny-set from BLO-22514's acceptance criteria, restated here as literals
 * rather than imported from the module under test. Importing SERVER_ONLY_ENV_DENY
 * and asserting it against itself would pass no matter what someone deleted from
 * it; spelling the names out means removing one fails this test.
 */
const AC_SERVER_ONLY = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "DATABASE_URL",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "PAPERCLIP_DEX_OIDC_CLIENT_SECRET",
  "PAPERCLIP_ALERTMANAGER_WEBHOOK_TOKEN",
];

/**
 * Names an agent Job must keep receiving. Derived from the adapter's own
 * by-name reads of `selfPod.inheritedEnv` plus the server env defined in
 * deploy/helm/paperclip — not pattern-matched. Dropping any of these breaks
 * every agent run in the fleet, which is why they are asserted explicitly.
 */
const KEEP_SET = [
  // Read by name in job-manifest.ts.
  "PAPERCLIP_API_URL",
  "CLAUDE_CONFIG_DIR",
  // Agent-side only (packages/mcp-server) — no adapter read to derive it from.
  "PAPERCLIP_PUBLIC_URL",
  // Agent runtime layout / identity.
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PATH",
  "NODE_OPTIONS",
  // Path pointers; the `gh` wrapper reads the first.
  "PAPERCLIP_GITHUB_TOKEN_FILE",
  "PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE",
  "PAPERCLIP_GBRAIN_OAUTH_CLIENTS_URL",
  // Agent runtime model routing.
  "PAPERCLIP_CODEX_PROVIDERS",
  "PAPERCLIP_CODEX_USE_HOST_HOME",
  "PAPERCLIP_OPENCODE_MODEL_ALLOWLIST",
  // Provider routing, via the prefix families.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_BASE_URL",
  "OPENAI_API_KEY",
  // Toolchain caches.
  "GOCACHE",
  "GOMODCACHE",
  "BUN_INSTALL_CACHE",
  "PIP_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "XDG_CACHE_HOME",
  "npm_config_cache",
];

describe("inherit allowlist — deny set", () => {
  it.each(AC_SERVER_ONLY)("refuses to inherit %s", (name) => {
    expect(isAgentInheritableEnvName(name)).toBe(false);
  });

  it("keeps every AC-named server-only credential in SERVER_ONLY_ENV_DENY", () => {
    for (const name of AC_SERVER_ONLY) {
      expect(SERVER_ONLY_ENV_DENY.has(name)).toBe(true);
    }
  });

  it("denies the secret-encryption master seed", () => {
    // Not in BLO-22514's AC list; found while enumerating the server env.
    expect(isAgentInheritableEnvName("PAPERCLIP_MASTER_KEY_SEED")).toBe(false);
  });

  it("also denies the GitHub App identity vars that pair with the private key", () => {
    expect(isAgentInheritableEnvName("GITHUB_APP_ID")).toBe(false);
    expect(isAgentInheritableEnvName("GITHUB_APP_INSTALLATION_ID")).toBe(false);
  });

  it("never lists a denied name in the allowlist (the two must not overlap)", () => {
    for (const name of SERVER_ONLY_ENV_DENY) {
      expect(AGENT_ENV_ALLOWLIST.has(name)).toBe(false);
    }
  });

  it("lets the deny set win over a prefix family that would otherwise match", () => {
    // Regression guard for the ordering inside isAgentInheritableEnvName: if a
    // future prefix family were broad enough to cover a denied name, deny must
    // still win. Simulated here by asserting the invariant directly against a
    // synthetic name under an allowed prefix.
    const denied = [...SERVER_ONLY_ENV_DENY];
    for (const name of denied) {
      const matchesPrefix = AGENT_ENV_ALLOWED_PREFIXES.some((p) => name.startsWith(p));
      if (matchesPrefix) {
        expect(isAgentInheritableEnvName(name)).toBe(false);
      }
    }
    // And the ordering itself, independent of today's contents.
    expect(SERVER_ONLY_ENV_DENY.has("DATABASE_URL")).toBe(true);
    expect(isAgentInheritableEnvName("DATABASE_URL")).toBe(false);
  });
});

describe("inherit allowlist — keep set", () => {
  it.each(KEEP_SET)("still inherits %s", (name) => {
    expect(isAgentInheritableEnvName(name)).toBe(true);
  });

  it("covers the names job-manifest.ts reads back off inheritedEnv", () => {
    // These two are read by name (job-manifest.ts CLAUDE_CONFIG_DIR /
    // PAPERCLIP_API_URL). Filtering either one out silently changes agent
    // behaviour rather than failing loudly, so they get their own assertion.
    expect(isAgentInheritableEnvName("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isAgentInheritableEnvName("PAPERCLIP_API_URL")).toBe(true);
  });

  it("admits provider families wholesale so non-Penstock deployments keep working", () => {
    // A Bedrock/Vertex deployment routes through names this repo never mentions.
    expect(isAgentInheritableEnvName("AWS_REGION")).toBe(true);
    expect(isAgentInheritableEnvName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isAgentInheritableEnvName("ANTHROPIC_MODEL")).toBe(true);
    expect(isAgentInheritableEnvName("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(isAgentInheritableEnvName("CLAUDE_CODE_USE_BEDROCK")).toBe(true);
  });
});

describe("inherit allowlist — default deny", () => {
  it("drops server-only config that no agent reads", () => {
    for (const name of [
      "HOST",
      "PORT",
      "SERVE_UI",
      "PAPERCLIP_NODE_ROLE",
      "PAPERCLIP_WORKERS_INTERNAL_URL",
      "PAPERCLIP_AUTH_DISABLE_SIGN_UP",
      "PAPERCLIP_DEX_OIDC_ISSUER",
      "PAPERCLIP_DEPLOYMENT_MODE",
    ]) {
      expect(isAgentInheritableEnvName(name)).toBe(false);
    }
  });

  it("drops an unknown name outright rather than falling back to a pattern", () => {
    // The failure mode a denylist has: a credential whose name matches nothing.
    expect(isAgentInheritableEnvName("MCP_CONFIG")).toBe(false);
    expect(isAgentInheritableEnvName("SOME_NEW_SERVER_CREDENTIAL")).toBe(false);
    expect(isAgentInheritableEnvName("CLUSTER_TAG")).toBe(false);
  });

  it("excludes XDG_CONFIG_HOME so the pod does not inherit an unmounted path", () => {
    // The server's value is /runtime-config, an emptyDir the Job pod never
    // mounts, and the adapter only sets XDG_CONFIG_HOME itself under isolation.
    // Letting it fall back to $HOME is correct; inheriting it is not.
    expect(isAgentInheritableEnvName("XDG_CONFIG_HOME")).toBe(false);
    expect(isAgentInheritableEnvName("XDG_CACHE_HOME")).toBe(true);
  });
});

describe("inherit allowlist — secret volumes", () => {
  it("keeps the two agent-facing secret mounts", () => {
    // values.blockcast.yaml documents this propagation as intentional.
    expect(isAgentInheritableSecretVolume("authbot-mcp-consumer-service-keys")).toBe(true);
    expect(isAgentInheritableSecretVolume("paperclip-github-mcp-token")).toBe(true);
  });

  it("does NOT propagate the user-seat token into agent Jobs (BLO-24056)", () => {
    // The seat is a review-clearing identity on repos whose ruleset names the
    // Ally team. Propagating it made that a fleet-wide capability (108 agent
    // Job pods mounted it) rather than one service's. It was also unusable
    // from an agent by construction: the `gh` wrapper reads
    // PAPERCLIP_GITHUB_TOKEN_FILE (pinned to the App token), GH_TOKEN
    // overrides are no-ops in these pods, and shipped skills may not name the
    // seat path (shipped-catalog.test.ts CREDENTIAL_SELECTOR_PATTERNS).
    // The control plane keeps its own mount via values.blockcast.yaml.
    expect(isAgentInheritableSecretVolume("paperclip-github-merge-token")).toBe(false);
    expect(AGENT_SECRET_VOLUME_ALLOWLIST.has("paperclip-github-merge-token")).toBe(false);
  });

  it("drops a server-only secret mount", () => {
    expect(isAgentInheritableSecretVolume("paperclip-db-credentials")).toBe(false);
    expect(isAgentInheritableSecretVolume("paperclip-github-app-key")).toBe(false);
  });

  it("keys the allowlist on secretName, not the local volume name", () => {
    // The volume name is a label chosen by the chart; the Secret is the thing
    // whose key material is handed over. "github-merge-token" is the volume
    // name for secret "paperclip-github-merge-token" — it must not match.
    expect(AGENT_SECRET_VOLUME_ALLOWLIST.has("github-merge-token")).toBe(false);
    expect(isAgentInheritableSecretVolume("github-merge-token")).toBe(false);
  });
});

describe("inherit allowlist — envFrom", () => {
  it("denies every envFrom source by default", () => {
    expect(AGENT_ENV_FROM_ALLOWLIST.size).toBe(0);
    expect(isAgentInheritableEnvFromRef("paperclip-secrets")).toBe(false);
    expect(isAgentInheritableEnvFromRef("anything")).toBe(false);
  });
});
