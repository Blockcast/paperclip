import { describe, expect, it } from "vitest";
import { mergeEnvironmentConfig } from "@paperclipai/adapter-utils";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import { agentScopeOnlyConfigKeyOverrides } from "../services/agent-config-key-pins.ts";
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
// as, and SCCACHE_* selects the private compiler-cache writer identity. Both
// introducing and dropping those credentials are exploits, and both are
// asserted.
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

  it("does not let an issue adapter override introduce private compiler-cache credentials", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { env: { AGENT_ONLY: "agent-only" } },
      modelProfile: { ...noProfile },
      issueAdapterConfig: {
        env: {
          SCCACHE_ACCESS_KEY_ID: "issue-attacker-id",
          SCCACHE_SECRET_ACCESS_KEY: "issue-attacker-secret",
        },
      },
    });

    expect(merged.env).not.toHaveProperty("SCCACHE_ACCESS_KEY_ID");
    expect(merged.env).not.toHaveProperty("SCCACHE_SECRET_ACCESS_KEY");
  });

  it("does not let an issue adapter override replace or drop private compiler-cache credentials", () => {
    const replaced = mergeModelProfileAdapterConfig({
      baseConfig: {
        env: {
          SCCACHE_ACCESS_KEY_ID: "agent-cache-access",
          SCCACHE_SECRET_ACCESS_KEY: "agent-cache-secret",
        },
      },
      modelProfile: { ...noProfile },
      issueAdapterConfig: {
        env: {
          SCCACHE_ACCESS_KEY_ID: "issue-attacker-id",
          SCCACHE_SECRET_ACCESS_KEY: "issue-attacker-secret",
        },
      },
    });
    const displaced = mergeModelProfileAdapterConfig({
      baseConfig: {
        env: {
          SCCACHE_ACCESS_KEY_ID: "agent-cache-access",
          SCCACHE_SECRET_ACCESS_KEY: "agent-cache-secret",
        },
      },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { env: { UNRELATED: "issue-only" } },
    });

    expect(replaced.env).toMatchObject({
      SCCACHE_ACCESS_KEY_ID: "agent-cache-access",
      SCCACHE_SECRET_ACCESS_KEY: "agent-cache-secret",
    });
    expect(replaced.env).not.toMatchObject({
      SCCACHE_ACCESS_KEY_ID: "issue-attacker-id",
      SCCACHE_SECRET_ACCESS_KEY: "issue-attacker-secret",
    });
    expect(displaced.env).toMatchObject({
      SCCACHE_ACCESS_KEY_ID: "agent-cache-access",
      SCCACHE_SECRET_ACCESS_KEY: "agent-cache-secret",
    });
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

// PEN-5017. The env boundary above is drawn one level too low to cover a
// TOP-LEVEL adapterConfig key. `enableGitHubPublishBroker` decides whether the
// GitHub push credential is mounted into the agent container or into a sidecar
// at a different uid (PEN-4933 / PEN-3183 D1); buildJobManifest reads it off
// this merged object. The issue overlay is spread last and accepts arbitrary
// keys, and an agent can file an issue assigned to itself, so without
// withAgentScopedConfigProvenance the principal the boundary constrains can
// decline it per-run — and silently, because an agent that opted out still
// publishes perfectly well.
//
// These assertions are the server half of "an issue-scope override cannot
// change the rendered broker boundary". The adapter half — the broker is
// rendered if and only if the config it is handed carries the flag — is
// asserted in the adapter's own job-manifest.github-publish-broker.test.ts.
// Together they cover the path; neither alone does.
describe("mergeModelProfileAdapterConfig agent-scope-only top-level config boundary", () => {
  const noProfile = {
    requested: null,
    requestedBy: null,
    applied: null,
    configSource: null,
    fallbackReason: null,
    adapterConfig: null,
  } as const;

  // The direction that matters once D1 stage 1 sets the gate true at agent
  // scope: opting the run back out of the broker puts the credential back in
  // the agent's own container.
  it("does not let an issue adapter override disable an agent-scoped publish broker", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enableGitHubPublishBroker: false },
    });

    expect(merged.enableGitHubPublishBroker).toBe(true);
  });

  // Deleting the key is the same exploit by another route: buildJobManifest
  // reads it with `asBoolean(config.enableGitHubPublishBroker, false)`, so an
  // absent key is an opted-out pod.
  it("does not let an issue adapter override delete an agent-scoped publish broker gate", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enableGitHubPublishBroker: undefined },
    });

    expect(merged.enableGitHubPublishBroker).toBe(true);
  });

  // Both directions, as for the env keys: an override must not be able to turn
  // the broker ON for an agent that is not running it either. That renders a
  // sidecar and takes away the agent's credential, which fails every publish
  // on an issue anyone can file.
  it("does not let an issue adapter override enable a broker the agent does not run", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enableGitHubPublishBroker: true },
    });

    expect(merged).not.toHaveProperty("enableGitHubPublishBroker");
  });

  it("does not let a model profile overlay change the publish broker gate", () => {
    const enabled = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true },
      modelProfile: {
        ...noProfile,
        applied: "cheap",
        configSource: "agent_runtime",
        adapterConfig: { enableGitHubPublishBroker: false },
      },
      issueAdapterConfig: null,
    });
    const absent = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile: {
        ...noProfile,
        applied: "cheap",
        configSource: "agent_runtime",
        adapterConfig: { enableGitHubPublishBroker: true },
      },
      issueAdapterConfig: null,
    });

    expect(enabled.enableGitHubPublishBroker).toBe(true);
    expect(absent).not.toHaveProperty("enableGitHubPublishBroker");
  });

  // PEN-4932 stage 4b. Same boundary, different key and a different hazard: the
  // per-agent workspace volume gate decides which VOLUME the Job mounts, and
  // turning it on is destructive to a run that was not expecting it — a fresh,
  // empty claim with no checkout, no worktrees and no pnpm store, which an
  // agent would then work in as though nothing had happened.
  it("does not let an issue adapter override move a run onto a per-agent workspace volume", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enablePerAgentWorkspaceVolume: true },
    });

    expect(merged).not.toHaveProperty("enablePerAgentWorkspaceVolume");
  });

  // ...and the other direction, which is the one that puts the broader-
  // privileged uid-0 seeder shape back into an opted-in agent's pod.
  it("does not let an issue adapter override opt a run back onto the shared claim", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enablePerAgentWorkspaceVolume: true },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enablePerAgentWorkspaceVolume: false },
    });

    expect(merged.enablePerAgentWorkspaceVolume).toBe(true);
  });

  // PEN-6247. The pod's KUBERNETES IDENTITY. `resolveServiceAccountName` takes
  // this verbatim, and the adapter sets `automountServiceAccountToken` nowhere
  // — so the pod inherits it from the ServiceAccount this key NAMES. The agent
  // SAs set it `false`; sibling SAs in the same namespace do not set it at all
  // (⇒ true) and one holds three ClusterRoleBindings. The containment is
  // therefore a property of the value being overridden, and overriding it
  // discards the containment in the same stroke.
  //
  // Unconditional, not broker-gated: it decides the identity on every run.
  it("does not let an issue adapter override choose the pod's service account", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { serviceAccountName: "penstock-general-agent" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { serviceAccountName: "paperclip-ci-deploy" },
    });

    expect(merged.serviceAccountName).toBe("penstock-general-agent");
  });

  // The other direction, and it is not symmetric decoration. Deleting the key
  // does not fall back to the agent's SA — `resolveServiceAccountName` falls
  // through to PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME, a DIFFERENT identity
  // chosen by whatever that env var holds, so a bare delete is also a way to
  // move the pod off its intended SA.
  it("does not let an issue adapter override delete an agent-scoped service account", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { serviceAccountName: "penstock-general-agent" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { serviceAccountName: undefined },
    });

    expect(merged.serviceAccountName).toBe("penstock-general-agent");
  });

  // Introducing it where agent scope has none is the same exploit on an agent
  // that relies on the fleet default: the overlay would name an SA the agent
  // never chose.
  it("does not let an issue adapter override introduce a service account the agent never set", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { serviceAccountName: "paperclip-ci-deploy" },
    });

    expect(merged).not.toHaveProperty("serviceAccountName");
  });

  // The pin is taken against the model-profile overlay too, which can be
  // agent-provenanced — same reason the keys above are: the key resolves from
  // the agent's primary config and nowhere else, so there is one place to audit.
  it("does not let a model profile overlay change the pod's service account", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { serviceAccountName: "penstock-general-agent" },
      modelProfile: {
        ...noProfile,
        applied: "cheap",
        configSource: "agent_runtime",
        adapterConfig: { serviceAccountName: "paperclip-ci-deploy" },
      },
      issueAdapterConfig: null,
    });

    expect(merged.serviceAccountName).toBe("penstock-general-agent");
  });

  // Must-pass arm. A gate that only ever refuses is not shown to work: agent
  // scope is where a per-agent SA is legitimately configured, and this pin must
  // not reach it.
  it("still lets agent scope set the pod's service account", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { serviceAccountName: "penstock-general-agent", model: "primary" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { model: "issue-explicit" },
    });

    expect(merged).toEqual({
      serviceAccountName: "penstock-general-agent",
      model: "issue-explicit",
    });
  });

  // Scoped, not blanket. `assigneeAdapterOverrides.adapterConfig` is
  // load-bearing for model selection and workspace strategy, and this row is
  // not a refactor of that surface.
  it("leaves every other top-level issue override honoured when the broker is off", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary", enableDocker: false, image: "agent-img" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { model: "issue-explicit", enableDocker: true, image: "issue-img" },
    });

    expect(merged).toEqual({
      model: "issue-explicit",
      enableDocker: true,
      image: "issue-img",
    });
  });

  // Pinning the gate and the broker's image stops an override choosing the
  // code INSIDE the boundary. This stops one standing a privileged container
  // up BESIDE it: the DinD sidecar is `privileged: true, runAsUser: 0` in the
  // same pod as the broker, so it defeats an in-pod uid boundary without
  // needing the credential volume mounted at all.
  it("does not let an issue adapter override add privileged docker when the broker is on", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enableDocker: true, dockerImage: "attacker-dind" },
    });

    expect(merged).not.toHaveProperty("enableDocker");
    expect(merged).not.toHaveProperty("dockerImage");
  });

  // A pinned `enableDocker` with an overridable image is a pin in name only.
  it("does not let an issue adapter override retarget docker the agent did enable", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        enableGitHubPublishBroker: true,
        enableDocker: true,
        dockerImage: "docker:28-dind",
      },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { dockerImage: "attacker-dind" },
    });

    expect(merged.dockerImage).toBe("docker:28-dind");
  });

  // PEN-5027. The third composition key, and the one that reaches a REFUSAL
  // rather than a weaker pod. `buildJobManifest` narrows the shared data
  // volume by `subPath` only when the Job's claim is this server's own, and it
  // throws outright rather than render a brokered pod on the broad fallback —
  // so a foreign issue-scope claim fails every dispatch of a brokered agent at
  // manifest build. That is the per-issue denial of service the gate key's own
  // pin declines to create, reached by a different key.
  it("does not let an issue adapter override supply a foreign data claim when the broker is on", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { workspaceVolumeClaim: "attacker-claim" },
    });

    expect(merged).not.toHaveProperty("workspaceVolumeClaim");
  });

  // Both directions, as everywhere else in this set. Replacing an agent-scoped
  // claim is the denial of service; deleting one is a per-issue redirection of
  // where the run's data lives, which is equally not an issue's to make.
  it("does not let an issue adapter override replace or delete an agent-scoped data claim", () => {
    const base = { enableGitHubPublishBroker: true, workspaceVolumeClaim: "paperclip-data" };
    const replaced = mergeModelProfileAdapterConfig({
      baseConfig: { ...base },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { workspaceVolumeClaim: "attacker-claim" },
    });
    const deleted = mergeModelProfileAdapterConfig({
      baseConfig: { ...base },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { workspaceVolumeClaim: undefined },
    });

    expect(replaced.workspaceVolumeClaim).toBe("paperclip-data");
    expect(deleted.workspaceVolumeClaim).toBe("paperclip-data");
  });

  it("does not let a model profile overlay change the data claim when the broker is on", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true, workspaceVolumeClaim: "paperclip-data" },
      modelProfile: {
        ...noProfile,
        applied: "cheap",
        configSource: "agent_runtime",
        adapterConfig: { workspaceVolumeClaim: "profile-claim" },
      },
      issueAdapterConfig: null,
    });

    expect(merged.workspaceVolumeClaim).toBe("paperclip-data");
  });

  // PEN-5027 constraint 1, pinned as a property of the SITE rather than left
  // as prose. The pin above discards an ISSUE-scope claim; an ENVIRONMENT-scope
  // one must still win, because the environment's K8sRemoteSpec is the only
  // legitimate writer of this key (see ui/src/lib/environment-form.ts and
  // packages/shared/src/validators/environment.ts).
  //
  // It wins because of WHERE the guard sits: the environment overlay is applied
  // DOWNSTREAM, by `mergeEnvironmentConfig` in the claude-k8s adapter's
  // execute.ts, over the config this merge returns.
  //
  // This test documents that intended order; it does NOT cover the site order.
  // The adapter holds its own copy of `mergeEnvironmentConfig` — defined in
  // that same execute.ts, and called from within `execute()` — and this test
  // both imports a different copy (@paperclipai/adapter-utils)
  // and chooses the call order itself, so a refactor moving the pin below the
  // overlay inside execute.ts leaves it green. A real site-order test would
  // have to go through execute().
  //
  // What IS pinned here is the semantics of the composition: the merge discards
  // the issue-scope claim, an environment value applied after it wins, and a
  // null environment value does not clobber the agent value.
  it("still lets an environment-scope data claim win over the agent-scope pin", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: true, workspaceVolumeClaim: "agent-claim" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { workspaceVolumeClaim: "attacker-claim" },
    });
    // Mirrors the adapter's own call:
    // `mergeEnvironmentConfig(adapterConfigObj, target?.config ?? null)`. The
    // `?? null` only normalises an absent config, which the function already
    // ignores; the null case below exercises the separate per-key skip.
    const effective = mergeEnvironmentConfig(merged, { workspaceVolumeClaim: "paperclip-data" });
    // A partially-populated K8sRemoteSpec must not clobber the agent value.
    const partial = mergeEnvironmentConfig(merged, { workspaceVolumeClaim: null });

    expect(merged.workspaceVolumeClaim).toBe("agent-claim");
    expect(effective.workspaceVolumeClaim).toBe("paperclip-data");
    expect(partial.workspaceVolumeClaim).toBe("agent-claim");
  });

  // The no-op proof for today's fleet, as an assertion rather than a claim:
  // the gate is `false` on every agent, so every current render takes this
  // branch and the overlay is honoured exactly as it was before PEN-5027.
  //
  // Scoped deliberately. With the broker off a foreign claim merely forgoes
  // the subPath narrowing (a `claude_k8s.data_mount_broad_rw` warn, no throw),
  // so there is no refusal to prevent — and whether an issue should be able to
  // choose the data volume at all is a wider question this row does not answer.
  it("leaves a data-claim override honoured when the broker is off", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { workspaceVolumeClaim: "paperclip-data" },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { workspaceVolumeClaim: "issue-claim" },
    });

    expect(merged.workspaceVolumeClaim).toBe("issue-claim");
  });

  // The composition pin is conditional on the AGENT-scope gate, and the
  // predicate mirrors the adapter's strict `asBoolean`. A non-boolean is not
  // "on" there, so it must not be "on" here — if the two drift, the
  // composition keys silently stop being pinned for a pod the adapter does
  // broker, which is the permissive direction.
  it("treats a non-boolean gate as off, exactly as the adapter's asBoolean does", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { enableGitHubPublishBroker: "true" as unknown as boolean },
      modelProfile: { ...noProfile },
      issueAdapterConfig: { enableDocker: true },
    });

    expect(merged.enableDocker).toBe(true);
  });

  // The guard discards rather than throws, so the dispatch path logs the
  // attempt instead. Without a reported attempt the refusal is invisible, and
  // an operator cannot tell a boundary that held from one never reached.
  it("reports which overlay keys were refused, so the discard is not silent", () => {
    expect(
      agentScopeOnlyConfigKeyOverrides({ enableGitHubPublishBroker: false, model: "x" }, {}),
    ).toEqual(["enableGitHubPublishBroker"]);
    expect(agentScopeOnlyConfigKeyOverrides({ model: "x" }, {})).toEqual([]);
    expect(agentScopeOnlyConfigKeyOverrides(null, {})).toEqual([]);
  });

  // Reporting is run-dependent too: a refused `enableDocker` must be reported
  // on a brokered run and must NOT be reported on an unbrokered one, where it
  // was honoured. A fixed list here would misreport one of the two.
  it("reports the composition keys as refused only on a brokered run", () => {
    const probe = { enableDocker: true, dockerImage: "d" };

    expect(agentScopeOnlyConfigKeyOverrides(probe, { enableGitHubPublishBroker: true })).toEqual([
      "enableDocker",
      "dockerImage",
    ]);
    expect(agentScopeOnlyConfigKeyOverrides(probe, {})).toEqual([]);
  });

  // Membership pin. The guard is a list, so it is exactly as complete as its
  // last edit — this makes adding or removing a key a deliberate act with a
  // diff on it rather than something a refactor can do by accident.
  //
  // ⚠ `image` is deliberately NOT in this set, and that is a decision rather
  // than an omission. It reaches the broker sidecar — which runs the credential
  // — but it also selects the AGENT container's image, which has legitimate
  // lower-scope uses and an unmeasured live set. Pinning it here would have
  // been a silent behaviour change for every issue-scope image override.
  // PEN-5017 closes that route adapter-side instead: the broker renders from
  // `ctx.agent.adapterConfig`, so an override moves the agent container (which
  // holds no credential once brokered) and never the broker. See
  // job-manifest.github-publish-broker.test.ts "broker image provenance".
  // If that adapter-side pin is ever removed, `image` belongs in this set.
  //
  // ⚠ `serviceAccountName` IS here (PEN-6247) and the contrast with `image` is
  // the point, not an inconsistency. `image` has a per-use pin available —
  // the broker renders from `ctx.agent.adapterConfig`, so an override moves
  // only the credential-less agent container. `serviceAccountName` has no such
  // narrower site: it is ONE field on the pod spec, read verbatim, and it
  // decides the identity the apiserver grants the whole pod. There is nothing
  // smaller to pin it at, so it is pinned here.
  it("pins the agent-scope-only top-level key sets", () => {
    const probe = {
      enableGitHubPublishBroker: false,
      enableDocker: true,
      dockerImage: "d",
      workspaceVolumeClaim: "c",
      model: "x",
      workspaceStrategy: { type: "git_worktree" },
      serviceAccountName: "sa",
      image: "img",
      env: {},
    };

    expect(agentScopeOnlyConfigKeyOverrides(probe, {})).toEqual([
      "enableGitHubPublishBroker",
      "serviceAccountName",
    ]);
    expect(agentScopeOnlyConfigKeyOverrides(probe, { enableGitHubPublishBroker: true })).toEqual([
      "enableGitHubPublishBroker",
      "enableDocker",
      "dockerImage",
      "workspaceVolumeClaim",
      "serviceAccountName",
    ]);
  });
});

// PEN-6201, done-when 1: SEVERITY MEASUREMENT, not a boundary this file asks
// for. The question the row could not answer by inference was whether a model
// profile's `adapterConfig` instructions keys are HONOURED at dispatch, or
// discarded the way the pinned keys are. The row's own bound was explicit —
// "not shown to be defended", not "shown to be exploitable" — and the answer
// decides whether the rollback bypass is a live instruction-source rewrite.
//
// They are honoured. `mergeModelProfileAdapterConfig` spreads the profile's
// adapterConfig OVER baseConfig, and the only things restored from agent scope
// afterwards are `withAgentScopedEnvProvenance` (env), `withPolicyResolved
// WorkspaceStrategy` (workspaceStrategy) and `withAgentScopedConfigProvenance`
// (`agentScopeOnlyConfigKeysFor`, i.e. the broker/volume keys). The
// instructions-bundle keys are in none of those sets, so they survive — and
// the merged config is what reaches the run: mergedConfig ->
// stripWorkspaceRuntimeFromExecutionRunConfig -> resolveExecutionRunAdapterConfig
// -> effectiveResolvedConfig -> the dispatch `runtimeConfig`, which is handed
// to `materializeExternalK8sSharedDocs({ config })` and to the adapter that
// reads `instructionsFilePath`.
//
// This is NOT an argument that the merge should discard them — a model profile
// legitimately carries adapter config. It is the reason the WRITE path has to
// be guarded on every route that reaches it, rollback included.
describe("mergeModelProfileAdapterConfig instructions-bundle reachability (PEN-6201)", () => {
  const noProfile = {
    requested: null,
    requestedBy: null,
    applied: null,
    configSource: null,
    fallbackReason: null,
    adapterConfig: null,
  } as const;

  function withProfileConfig(adapterConfig: Record<string, unknown>) {
    return { ...noProfile, requested: "cheap", applied: "cheap", adapterConfig } as const;
  }

  it("honours a model-profile instructions bundle path over the agent's own", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/paperclip/agents/security-engineer",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/paperclip/agents/security-engineer/AGENTS.md",
      },
      modelProfile: withProfileConfig({
        instructionsRootPath: "/tmp/attacker",
        instructionsFilePath: "/tmp/attacker/AGENTS.md",
      }),
      issueAdapterConfig: null,
    });

    // The measurement. If either of these ever flips to the agent's value, the
    // merge has grown a defence and PEN-6201's severity drops — re-read
    // withAgentScopedConfigProvenance before changing this expectation.
    expect(merged.instructionsRootPath).toBe("/tmp/attacker");
    expect(merged.instructionsFilePath).toBe("/tmp/attacker/AGENTS.md");
  });

  it("honours a model-profile instructions bundle path the agent did not set at all", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "agent-model" },
      modelProfile: withProfileConfig({
        instructionsBundleMode: "external",
        instructionsRootPath: "/tmp/attacker",
        instructionsEntryFile: "AGENTS.md",
      }),
      issueAdapterConfig: null,
    });

    expect(merged.instructionsRootPath).toBe("/tmp/attacker");
    expect(merged.instructionsEntryFile).toBe("AGENTS.md");
    expect(merged.instructionsBundleMode).toBe("external");
  });

  // DISCRIMINATING CONTROL, and the reason the two assertions above are a
  // finding rather than a broken test: the SAME call shape, same profile slot,
  // with a key that IS pinned — the merge discards it and restores agent
  // scope. So the merge demonstrably can refuse a profile-supplied key; it
  // just does not refuse these.
  it("discards a model-profile pinned key at the same time, from the same slot", () => {
    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        enableGitHubPublishBroker: true,
        instructionsRootPath: "/paperclip/agents/security-engineer",
      },
      modelProfile: withProfileConfig({
        enableGitHubPublishBroker: false,
        instructionsRootPath: "/tmp/attacker",
      }),
      issueAdapterConfig: null,
    });

    expect(merged.enableGitHubPublishBroker).toBe(true);
    expect(merged.instructionsRootPath).toBe("/tmp/attacker");
  });
});
