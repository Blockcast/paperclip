import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref } from "@paperclipai/shared";
import {
  LOW_TRUST_REVIEW_PRESET,
  PUSH_CAPABILITY_ENV_KEYS,
  applyRunScopedMentionedSkillKeys,
  extractMentionedSkillIdsFromSources,
  requiresPushCapabilityPreflight,
  resolveExecutionRunAdapterConfig,
  translateGithubSeatTokenForExecutionTarget,
} from "../services/heartbeat.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays environment, project, and routine env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
      manifest: [
        {
          configPath: "env.AGENT_SECRET",
          envKey: "AGENT_SECRET",
          secretId: "secret-agent",
          secretKey: "agent-secret",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });
    const resolveEnvBindings = vi
      .fn()
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "environment",
          ENV_ONLY: "environment-only",
        },
        secretKeys: new Set(["ENV_SECRET"]),
        manifest: [
          {
            configPath: "env.ENV_SECRET",
            envKey: "ENV_SECRET",
            secretId: "secret-environment",
            secretKey: "environment-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "project",
          PROJECT_ONLY: "project-only",
        },
        secretKeys: new Set(["PROJECT_SECRET"]),
        manifest: [
          {
            configPath: "env.PROJECT_SECRET",
            envKey: "PROJECT_SECRET",
            secretId: "secret-project",
            secretKey: "project-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "routine",
          ROUTINE_ONLY: "routine-only",
        },
        secretKeys: new Set(["ROUTINE_SECRET"]),
        manifest: [
          {
            configPath: "env.ROUTINE_SECRET",
            envKey: "ROUTINE_SECRET",
            secretId: "secret-routine",
            secretKey: "routine-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      environmentId: "environment-1",
      environmentEnv: { SHARED_KEY: "environment" },
      projectEnv: { SHARED_KEY: "project" },
      routineEnv: { SHARED_KEY: "routine" },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "routine",
        ENV_ONLY: "environment-only",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
        ROUTINE_ONLY: "routine-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "ENV_SECRET", "PROJECT_SECRET", "ROUTINE_SECRET"]);
    expect(result.secretManifest.map((entry) => entry.secretId).sort()).toEqual([
      "secret-agent",
      "secret-environment",
      "secret-project",
      "secret-routine",
    ]);
    expect(JSON.stringify(result.secretManifest)).not.toContain("agent-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("environment-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("project-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("routine-only");
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      consumerType: "environment",
      consumerId: "environment-1",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      consumerType: "routine",
      consumerId: "routine-1",
    });
  });

  it("drops Paperclip runtime-owned env before resolving environment, agent, project, and routine overlays", async () => {
    const resolveAdapterConfigForRuntime = vi.fn(async (_companyId, config: Record<string, unknown>) => ({
      config: {
        ...config,
        env: { ...(config.env as Record<string, unknown>) },
      },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      environmentId: "environment-1",
      environmentEnv: {
        PAPERCLIP_API_KEY: "environment-api-key",
        PAPERCLIP_AGENT_ID: "environment-agent",
        ENV_ONLY: "environment-only",
      },
      executionRunConfig: {
        env: {
          PAPERCLIP_API_KEY: { type: "secret_ref", secretId: "secret-api-key", version: "latest" },
          PAPERCLIP_AGENT_ID: "spoofed-agent",
          AGENT_ONLY: "agent-only",
        },
      },
      projectEnv: {
        PAPERCLIP_API_KEY: "project-api-key",
        PAPERCLIP_COMPANY_ID: "spoofed-company",
        PROJECT_ONLY: "project-only",
      },
      routineEnv: {
        PAPERCLIP_API_KEY: "routine-api-key",
        PAPERCLIP_RUN_ID: "spoofed-run",
        ROUTINE_ONLY: "routine-only",
      },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveEnvBindings.mock.calls[0]?.[1]).toEqual({
      ENV_ONLY: "environment-only",
    });
    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[1]).toEqual({
      env: {
        AGENT_ONLY: "agent-only",
      },
    });
    expect(resolveEnvBindings.mock.calls[1]?.[1]).toEqual({
      PROJECT_ONLY: "project-only",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[1]).toEqual({
      ROUTINE_ONLY: "routine-only",
    });
    expect(result.resolvedConfig.env).toEqual({
      ENV_ONLY: "environment-only",
      AGENT_ONLY: "agent-only",
      PROJECT_ONLY: "project-only",
      ROUTINE_ONLY: "routine-only",
    });
    expect(JSON.stringify(result.resolvedConfig.env)).not.toContain("PAPERCLIP_");
  });

  // Companion to the test above, and the reason GH_SEAT_TOKEN_VALUE is spelled
  // without a `PAPERCLIP_` prefix (BLO-18927 step 2). The strip above is
  // correct and stays; what it means is that any credential delivered by the
  // scoped-binding path must live outside that namespace, because the strip
  // runs *before* agent-scope resolution and removes the key with no error
  // anywhere. A `PAPERCLIP_`-prefixed seat token is therefore not "a binding
  // that sometimes fails" — it can never arrive at all, and the gh wrapper
  // falls through to the fleet-wide mounted file as if nothing were configured.
  //
  // This asserts the key reaches resolveAdapterConfigForRuntime, which is the
  // precise thing renaming it back would break. It is deliberately paired with
  // a PAPERCLIP_-prefixed control in the same env block so that a future change
  // making the strip a no-op cannot make this test pass for the wrong reason.
  it("preserves the non-PAPERCLIP_ scoped seat-token key through agent-scope resolution", async () => {
    const resolveAdapterConfigForRuntime = vi.fn(async (_companyId, config: Record<string, unknown>) => ({
      config: {
        ...config,
        env: { ...(config.env as Record<string, unknown>) },
      },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: {
        env: {
          GH_SEAT_TOKEN_VALUE: { type: "secret_ref", secretId: "secret-seat-token", version: "latest" },
          // Control: same block, same scope, only the prefix differs.
          PAPERCLIP_GITHUB_TOKEN_VALUE: { type: "secret_ref", secretId: "secret-seat-token", version: "latest" },
        },
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    const agentEnvSeenByResolver = (resolveAdapterConfigForRuntime.mock.calls[0]?.[1] as any)?.env ?? {};
    expect(agentEnvSeenByResolver).toHaveProperty("GH_SEAT_TOKEN_VALUE");
    expect(agentEnvSeenByResolver).not.toHaveProperty("PAPERCLIP_GITHUB_TOKEN_VALUE");
    expect(result.resolvedConfig.env).toHaveProperty("GH_SEAT_TOKEN_VALUE");
  });

  // The rename above bought reachability at agent scope; on its own it would
  // also have bought reachability at *every lower* scope, which is strictly
  // worse than the PAPERCLIP_ name it replaced. Environment/project/routine env
  // are overlaid AFTER agent resolution, so an unprotected key means the
  // lowest-trust writer wins — and because the wrapper prefers this value over
  // the mounted App token, that writer picks the identity every `gh` call runs
  // as. Whitespace there fails them all with exit 64. These two tests pin the
  // asymmetry: agent scope may set it, no lower scope may set or override it.
  it("does not let environment, project, or routine env override an agent-scoped seat token", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { GH_SEAT_TOKEN_VALUE: "agent-seat-token" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: { GH_SEAT_TOKEN_VALUE: "agent-seat-token" } },
      environmentEnv: { GH_SEAT_TOKEN_VALUE: "environment-attacker", ENV_ONLY: "environment-only" },
      projectEnv: { GH_SEAT_TOKEN_VALUE: "project-attacker", PROJECT_ONLY: "project-only" },
      routineEnv: { GH_SEAT_TOKEN_VALUE: "   ", ROUTINE_ONLY: "routine-only" },
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
    });

    // The agent-scoped value survives all three overlays...
    expect(result.resolvedConfig.env).toMatchObject({ GH_SEAT_TOKEN_VALUE: "agent-seat-token" });
    // ...and the lower scopes are otherwise unaffected, so this is a targeted
    // filter and not an accidental drop of the whole overlay.
    expect(result.resolvedConfig.env).toMatchObject({
      ENV_ONLY: "environment-only",
      PROJECT_ONLY: "project-only",
      ROUTINE_ONLY: "routine-only",
    });
    // The key never even reaches the binding resolver for a lower scope, so a
    // secret_ref planted there cannot be dereferenced as a side effect.
    for (const call of resolveEnvBindings.mock.calls) {
      expect(call[1]).not.toHaveProperty("GH_SEAT_TOKEN_VALUE");
    }
  });

  it("does not let a lower scope introduce a seat token the agent never had", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { GH_SEAT_TOKEN_VALUE: "project-attacker" },
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
    });

    expect(result.resolvedConfig.env).not.toHaveProperty("GH_SEAT_TOKEN_VALUE");
  });

  // Ally's finding: raw resolution preserving the key is necessary but not
  // sufficient. requiresPushCapabilityPreflight-gated runs assert a push
  // credential is configured before dispatch, while remote execution targets
  // still need a stock-gh-compatible command env after secret resolution. These
  // tests exercise the real production contract by importing
  // PUSH_CAPABILITY_ENV_KEYS rather than restating it, so the tests cannot drift
  // away from the constant they guard.
  describe("push-capability preflight", () => {
    const pushCapabilityBinding = {
      keys: [...PUSH_CAPABILITY_ENV_KEYS],
      consumerScopes: ["agent", "project"] as Array<"agent" | "project">,
      reason: "push_write_credential_missing",
      remediation: "test remediation",
    };
    const stubSecretsSvc = () => ({
      resolveAdapterConfigForRuntime: vi.fn(async (_companyId, config: Record<string, unknown>) => ({
        config: { ...config, env: { ...(config.env as Record<string, unknown>) } },
        secretKeys: new Set<string>(),
        manifest: [],
      })),
      resolveEnvBindings: vi.fn(async () => ({
        env: {},
        secretKeys: new Set<string>(),
        manifest: [],
      })),
    });
    const remoteTarget = (transport: "sandbox" | "ssh") =>
      transport === "sandbox"
        ? {
            kind: "remote" as const,
            transport,
            remoteCwd: "/workspace",
          }
        : {
            kind: "remote" as const,
            transport,
            remoteCwd: "/workspace",
            spec: {
              host: "devbox.example",
              port: 22,
              username: "paperclip",
              remoteWorkspacePath: "/workspace",
              privateKey: null,
              knownHosts: null,
              strictHostKeyChecking: false,
              remoteCwd: "/workspace",
            },
          };

    it("gates on git-sensitive local adapters running the github-pr-workflow skill", () => {
      expect(requiresPushCapabilityPreflight({
        adapterType: "opencode_local",
        issueId: "issue-1",
        explicitRunScopedSkillKeys: ["github-pr-workflow"],
      })).toBe(true);
    });

    it("accepts an agent-scoped GH_SEAT_TOKEN_VALUE as a push credential", async () => {
      const result = await resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        executionRunConfig: {
          env: {
            GH_SEAT_TOKEN_VALUE: {
              type: "secret_ref",
              // Must be a real UUID: isConfiguredEnvBindingValue validates the
              // binding through envBindingSchema, and a malformed secretId
              // makes it read as "not configured" rather than as an error.
              secretId: "6f1c0c6e-6f2e-4a1e-9c2f-2b7d3a5e8c11",
              version: "latest",
            },
          },
        },
        requiredScopedEnvBinding: pushCapabilityBinding,
        secretsSvc: stubSecretsSvc() as any,
      });

      expect(result.resolvedConfig.env).toHaveProperty("GH_SEAT_TOKEN_VALUE");
    });

    it.each(["sandbox", "ssh"] as const)(
      "translates an agent-scoped GH_SEAT_TOKEN_VALUE into standard GitHub env for remote %s runs",
      async (transport) => {
        const resolveAdapterConfigForRuntime = vi.fn(async (_companyId, config: Record<string, unknown>) => ({
          config: {
            ...config,
            env: {
              ...(config.env as Record<string, unknown>),
              GH_SEAT_TOKEN_VALUE: " ghu_remote_seat\n",
            },
          },
          secretKeys: new Set(["GH_SEAT_TOKEN_VALUE"]),
          manifest: [],
        }));

        const result = await resolveExecutionRunAdapterConfig({
          companyId: "company-1",
          agentId: "agent-1",
          executionRunConfig: {
            env: {
              GH_SEAT_TOKEN_VALUE: {
                type: "secret_ref",
                secretId: "6f1c0c6e-6f2e-4a1e-9c2f-2b7d3a5e8c11",
                version: "latest",
              },
            },
          },
          requiredScopedEnvBinding: pushCapabilityBinding,
          secretsSvc: {
            resolveAdapterConfigForRuntime,
            resolveEnvBindings: vi.fn(async () => ({
              env: {},
              secretKeys: new Set<string>(),
              manifest: [],
            })),
          } as any,
        });

        const commandConfig = translateGithubSeatTokenForExecutionTarget({
          runtimeConfig: result.resolvedConfig,
          executionTarget: remoteTarget(transport),
        });

        expect(commandConfig.env).toMatchObject({
          GH_SEAT_TOKEN_VALUE: " ghu_remote_seat\n",
          GH_TOKEN: "ghu_remote_seat",
          GITHUB_TOKEN: "ghu_remote_seat",
        });
      },
    );

    it("translates GH_SEAT_TOKEN_VALUE into standard GitHub env for local runs too", () => {
      const commandConfig = translateGithubSeatTokenForExecutionTarget({
        runtimeConfig: {
          env: {
            GH_SEAT_TOKEN_VALUE: " ghu_local_seat\n",
          },
        },
        executionTarget: { kind: "local" },
      });

      expect(commandConfig.env).toMatchObject({
        GH_SEAT_TOKEN_VALUE: " ghu_local_seat\n",
        GH_TOKEN: "ghu_local_seat",
        GITHUB_TOKEN: "ghu_local_seat",
      });
    });

    it.each([
      ["blank", " \n\t "],
      ["embedded whitespace", "ghu_local seat"],
    ])("rejects a %s GH_SEAT_TOKEN_VALUE before target-specific setup", (_label, token) => {
      const runtimeConfig = {
        env: {
          GH_SEAT_TOKEN_VALUE: token,
        },
      };

      expect(() => translateGithubSeatTokenForExecutionTarget({
        runtimeConfig,
        executionTarget: { kind: "local" },
      })).toThrow(/GH_SEAT_TOKEN_VALUE/);
    });

    it("uses seat-token precedence over preexisting standard GitHub env on remote targets", () => {
      const commandConfig = translateGithubSeatTokenForExecutionTarget({
        runtimeConfig: {
          env: {
            GH_SEAT_TOKEN_VALUE: "ghu_agent_seat",
            GH_TOKEN: "ghu_project_token",
            GITHUB_TOKEN: "ghu_project_token",
          },
        },
        executionTarget: remoteTarget("sandbox"),
      });

      expect(commandConfig.env).toMatchObject({
        GH_SEAT_TOKEN_VALUE: "ghu_agent_seat",
        GH_TOKEN: "ghu_agent_seat",
        GITHUB_TOKEN: "ghu_agent_seat",
      });
    });

    it("still rejects a run with no push credential at any accepted key", async () => {
      await expect(resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        executionRunConfig: { env: { UNRELATED: "value" } },
        requiredScopedEnvBinding: pushCapabilityBinding,
        secretsSvc: stubSecretsSvc() as any,
      })).rejects.toThrow(/configuration incomplete/i);
    });

    // The seat key is agent-scope-only, so binding it at project scope must NOT
    // satisfy the preflight — otherwise the gate would pass on a binding the
    // strip above guarantees never arrives, dispatching a run that then fails
    // with no credential at all.
    it("does not accept a project-scoped seat token, which the overlay filter strips", async () => {
      await expect(resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        executionRunConfig: { env: {} },
        projectEnv: { GH_SEAT_TOKEN_VALUE: "project-seat-token" },
        requiredScopedEnvBinding: pushCapabilityBinding,
        secretsSvc: stubSecretsSvc() as any,
      })).rejects.toThrow(/configuration incomplete/i);
    });
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(result.secretManifest).toEqual([]);
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("passes low-trust allowed secret binding ids into all runtime secret contexts", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: {} },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {},
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      environmentId: "environment-1",
      projectId: "project-1",
      routineId: "routine-1",
      executionRunConfig: { env: {} },
      environmentEnv: { ENVIRONMENT_FLAG: "plain" },
      projectEnv: { PROJECT_FLAG: "plain" },
      routineEnv: { ROUTINE_FLAG: "plain" },
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["binding-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[1]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
  });

  it("blocks required missing user secrets before runtime env resolution", async () => {
    const resolveAdapterConfigForRuntime = vi.fn();
    const resolveEnvBindings = vi.fn();
    const collectMissingRuntimeBindings = vi.fn(async (_companyId, _env, context) =>
      context.consumerType === "agent"
        ? [
            {
              consumerType: "agent",
              consumerId: "agent-1",
              configPath: "env.GITHUB_TOKEN",
              envKey: "GITHUB_TOKEN",
              bindingType: "user_secret_ref",
              secretId: null,
              secretName: null,
              userSecretDefinitionId: "definition-1",
              userSecretDefinitionKey: "github_token",
              userSecretDefinitionName: "GitHub token",
              responsibleUserId: context.responsibleUserId,
              errorCode: "user_secret_missing",
            },
          ]
        : [],
    );

    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      responsibleUserId: "user-1",
      executionRunConfig: {
        env: {
          GITHUB_TOKEN: { type: "user_secret_ref", key: "github_token", required: true },
        },
      },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "secret_binding_missing",
          companyId: "company-1",
          agentId: "agent-1",
          issueId: "issue-1",
          missingBindings: [
            expect.objectContaining({
              bindingType: "user_secret_ref",
              userSecretDefinitionKey: "github_token",
              responsibleUserId: "user-1",
            }),
          ],
        },
      },
    });
    expect(collectMissingRuntimeBindings.mock.calls[0]?.[2]).toMatchObject({
      responsibleUserId: "user-1",
    });
    expect(resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("rejects inline sensitive env values for low-trust runs", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: {
        env: {
          FOO_TOKEN: "inline-secret",
        },
      },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "low_trust_inline_sensitive_env_denied" },
    });
  });

  // GH_SEAT_TOKEN_VALUE carries a raw token but matches none of the name-shaped
  // substrings the sensitive-key heuristic looks for, so without an explicit
  // rule a low-trust run could inline the seat credential. Introduced with the
  // key itself (BLO-18927) rather than left for later.
  it("rejects an inline agent-scope-only seat token for low-trust runs", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: {
        env: {
          GH_SEAT_TOKEN_VALUE: "inline-seat-token",
        },
      },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "low_trust_inline_sensitive_env_denied" },
    });
  });

  it("fails push-capability preflight when no GitHub write credential is bound at agent or project scope", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { PROJECT_ONLY: "project-only" },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at project or agent scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringContaining("GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN"),
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
          requiredEnvKeys: ["GH_TOKEN", "GITHUB_TOKEN"],
          requiredScopes: ["agent", "project"],
          missingBindings: [],
        },
      },
    });
  });

  it("passes push-capability preflight when a project-scoped GitHub credential is configured", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "github-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [],
    });
    const collectMissingRuntimeBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      projectId: "project-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { GH_TOKEN: { type: "plain", value: "github-token" } },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at project or agent scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      GH_TOKEN: "github-token",
    });
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect(collectMissingRuntimeBindings).toHaveBeenCalledTimes(2);
    expect(collectMissingRuntimeBindings.mock.calls[1]?.[2]).toMatchObject({
      consumerType: "project",
      consumerId: "project-1",
    });
  });
});

describe("resolveExecutionRunAdapterConfig codex_local credential pre-dispatch gate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function stubManagedCodexEnv(options: { seedSharedAuth: boolean }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-gate-"));
    cleanupDirs.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    if (options.seedSharedAuth) {
      await fs.writeFile(
        path.join(sharedCodexHome, "auth.json"),
        '{"OPENAI_API_KEY":"sk-shared"}\n',
        "utf8",
      );
    }
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedCodexHome);
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    return { root, managedAgentHome };
  }

  it("surfaces a configuration-incomplete blocker when a managed home has no auth and OPENAI_API_KEY is empty", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        issueId: "issue-1",
        responsibleUserId: "user-1",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }),
    ).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringContaining("no Codex credentials available"),
      resultJson: {
        configurationIncomplete: {
          reason: "codex_credentials_missing",
          adapterType: "codex_local",
          companyId: "company-1",
          agentId: "agent-1",
          issueId: "issue-1",
          responsibleUserId: "user-1",
          requiredEnvKeys: ["OPENAI_API_KEY"],
        },
      },
    });
    // The blocker message must not leak any secret value.
    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }).catch((err) => err.message),
    ).resolves.not.toContain("sk-");
  });

  it("dispatches normally when a per-agent OPENAI_API_KEY is resolved", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "sk-agent-resolved" } },
      secretKeys: new Set(["OPENAI_API_KEY"]),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: { type: "secret_ref" } } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.env).toMatchObject({ OPENAI_API_KEY: "sk-agent-resolved" });
  });

  it("dispatches normally when the shared host home carries subscription auth", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: true });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.command).toBe("codex");
  });

  it("does not gate non-codex adapters", async () => {
    await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "claude", env: { OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      executionRunConfig: { command: "claude", env: { OPENAI_API_KEY: "" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.command).toBe("claude");
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects UUID skill mention ids across issue sources", () => {
    const releaseSkillId = "11111111-1111-4111-8111-111111111111";
    const browserSkillId = "22222222-2222-4222-8222-222222222222";
    const releaseHref = buildSkillMentionHref(releaseSkillId, "release-changelog");
    const browserHref = buildSkillMentionHref(browserSkillId, "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual([releaseSkillId, browserSkillId]);
  });

  it("ignores legacy non-UUID skill mention ids before runtime database lookup", () => {
    const validSkillId = "33333333-3333-4333-8333-333333333333";
    const validHref = buildSkillMentionHref(validSkillId, "greploop");
    const legacyHref = buildSkillMentionHref("skill-greploop", "greploop");

    expect(
      extractMentionedSkillIdsFromSources([
        `Use [/greploop](${legacyHref}) and [/prcheckloop](${validHref})`,
      ]),
    ).toEqual([validSkillId]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });

  it("preserves existing version pins when adding mentioned skills", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
        ],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/security-review",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
          { key: "company/company-1/security-review", versionId: null },
        ],
      },
    });
  });
});
