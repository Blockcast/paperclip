import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
  isConfigurationIncompleteFailedRun,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("uses the Codex local adapter cheap default when the agent has no runtime override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {
        model: "gpt-5-mini",
        modelReasoningEffort: "high",
      },
    });
  });

  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it("treats model resolution failures as non-retryable configuration failures", () => {
    expect(isConfigurationIncompleteFailedRun({ errorCode: "model_not_found" })).toBe(true);
    expect(isConfigurationIncompleteFailedRun({ errorCode: "provider_quota" })).toBe(false);
  });
});

// The merged config is handed to resolveExecutionRunAdapterConfig as
// `executionRunConfig`, which treats it wholesale as agent scope and strips only
// `PAPERCLIP_*`. issue.assigneeAdapterOverrides.adapterConfig is overlaid into it
// last and accepts arbitrary keys, so without withAgentScopedEnvProvenance an
// issue override reaches agent scope — the boundary BLO-18927 exists to draw.
// GH_SEAT_TOKEN_VALUE selects the identity every `gh` invocation authenticates
// as, so both introducing and dropping it are exploits, and both are asserted.
describe("mergeModelProfileAdapterConfig agent-scope-only env boundary", () => {
  const noProfile = {
    requested: null,
    requestedBy: null,
    applied: null,
    configSource: null,
    fallbackReason: null,
    adapterConfig: null,
  } as const;

  it("does not let an issue adapter override introduce a seat token the agent never had", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { env: { AGENT_ONLY: "agent-only" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { env: { GH_SEAT_TOKEN_VALUE: "issue-attacker" } },
    });

    expect(merged.env).not.toHaveProperty("GH_SEAT_TOKEN_VALUE");
  });

  it("does not let an issue adapter override replace an agent-scoped seat token", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { env: { GH_SEAT_TOKEN_VALUE: "agent-seat-token" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { env: { GH_SEAT_TOKEN_VALUE: "issue-attacker" } },
    });

    expect(merged.env).toMatchObject({ GH_SEAT_TOKEN_VALUE: "agent-seat-token" });
  });

  // Whitespace in the key fails every `gh` invocation with exit 64, so denial is
  // as much an exploit as substitution. The shallow overlay spread replaces the
  // agent's `env` wholesale, which is how an override reaches this without ever
  // naming the key.
  it("does not let an issue adapter override drop or blank an agent-scoped seat token", () => {
    const blanked = mergeModelProfileAdapterConfig({
      baseConfig: { env: { GH_SEAT_TOKEN_VALUE: "agent-seat-token" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { env: { GH_SEAT_TOKEN_VALUE: "   " } },
    });
    const displaced = mergeModelProfileAdapterConfig({
      baseConfig: { env: { GH_SEAT_TOKEN_VALUE: "agent-seat-token" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { env: { UNRELATED: "issue-only" } },
    });

    expect(blanked.env).toMatchObject({ GH_SEAT_TOKEN_VALUE: "agent-seat-token" });
    expect(displaced.env).toMatchObject({ GH_SEAT_TOKEN_VALUE: "agent-seat-token" });
  });

  it("does not let a model profile overlay introduce a seat token", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { env: { AGENT_ONLY: "agent-only" } },
      modelProfile: {
        ...noProfile,
        applied: "cheap",
        configSource: "agent_runtime",
        adapterConfig: { env: { GH_SEAT_TOKEN_VALUE: "profile-attacker" } },
      },
      issueAdapterConfig: null,
    });

    expect(merged.env).not.toHaveProperty("GH_SEAT_TOKEN_VALUE");
  });

  // The boundary is scoped to AGENT_SCOPE_ONLY_ENV_KEYS; every other key keeps
  // the pre-existing shallow-overlay semantics the tests above this rely on.
  it("leaves non-agent-scope-only overlay semantics unchanged", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary", env: { SHARED: "agent", AGENT_ONLY: "agent-only" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { env: { SHARED: "issue" } },
    });
    const untouched = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary", env: { SHARED: "agent" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { model: "issue-explicit" },
    });

    expect(merged).toEqual({ model: "primary", env: { SHARED: "issue" } });
    expect(untouched).toEqual({ model: "issue-explicit", env: { SHARED: "agent" } });
  });
});
