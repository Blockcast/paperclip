import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  executionWorkspaceUsesGitWorktree,
  gateProjectExecutionWorkspacePolicy,
  isUnrunnableWorktreeCombo,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceEnvironmentId,
  resolvePinnedIssueWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.js";

describe("execution workspace policy helpers", () => {
  it("defaults new issue settings from enabled project policy", () => {
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit issue mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("centralizes unrunnable isolated worktree detection", () => {
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: "project-1",
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: "workspace-1",
          executionWorkspacePreference: "reuse_existing",
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "shared_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "agent_default",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "operator_branch",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
        hasResolvablePriorSessionWorkspace: true,
      }),
    ).toBe(false);
  });

  it("mirrors runtime default (project_primary) when pinned settings omit strategy type", () => {
    // Mode-only pin without explicit workspaceStrategy.type → same project_primary default as runtime.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: { mode: "isolated_workspace" },
      }),
    ).toBe("project_primary");
    // Explicit strategy type is always respected.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      }),
    ).toBe("git_worktree");
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        },
      }),
    ).toBe("project_primary");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("preserves project authorization policy for trust-preset resolution", () => {
    expect(parseProjectExecutionWorkspacePolicy({
      enabled: true,
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          projectIds: ["33333333-3333-4333-8333-333333333333"],
        },
      },
    })?.authorizationPolicy).toEqual({
      trustBoundary: {
        mode: "low_trust_review",
        projectIds: ["33333333-3333-4333-8333-333333333333"],
      },
    });
  });

  it("clears managed workspace strategy when issue opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "isolated",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
        environmentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      mode: "shared_workspace",
    });
    expect(
      parseIssueExecutionWorkspaceSettings(
        {
          mode: "project_primary",
          environmentId: "11111111-1111-4111-8111-111111111111",
        },
        { includeEnvironmentId: true },
      ),
    ).toEqual({
      mode: "shared_workspace",
      environmentId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("prefers the agent default environment", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "agent-env",
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "agent-env",
      source: "agent",
    });
  });

  it("falls back to the instance default environment when the agent has none", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "instance-env",
      source: "instance",
    });
  });

  it("falls back to the built-in local environment when neither agent nor instance selects one", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "local-env",
      source: "default",
    });
  });

  it("maps persisted execution workspace modes back to issue settings", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });
});

// BLO-31443: this predicate decides whether a run gets a per-issue tree key, so
// it decides whether the writer reservation follows the TREE or the RUN. It is
// deliberately mode-INDEPENDENT: "a worktree exists" and "workspace isolation
// was requested" are different questions, and realization
// (`realizeExecutionWorkspace`) branches solely on `workspaceStrategy.type`
// without ever consulting the mode. A mode-gated reading here would drop the
// tree key for runs that really do share a worktree, silently restoring the
// same-issue collision this row closed.
describe("executionWorkspaceUsesGitWorktree (BLO-31443)", () => {
  const base = {
    projectPolicy: null,
    issueSettings: null,
    legacyUseProjectWorkspace: null,
  } as const;

  it("follows an agent-level worktree strategy under isolated_workspace", () => {
    expect(
      executionWorkspaceUsesGitWorktree({
        ...base,
        agentConfig: { workspaceStrategy: { type: "git_worktree" } },
        mode: "isolated_workspace",
      }),
    ).toBe(true);
  });

  it("is false when no layer supplies a worktree strategy", () => {
    expect(
      executionWorkspaceUsesGitWorktree({
        ...base,
        agentConfig: { workspaceStrategy: { type: "project_primary" } },
        mode: "isolated_workspace",
      }),
    ).toBe(false);
  });

  // Divergence route 1: the mode gate is itself gated on `hasWorkspaceControl`
  // (a project policy, issue overrides, or an explicit
  // `legacyUseProjectWorkspace: false`). With none of those, a non-isolated mode
  // strips NOTHING and the agent-level worktree survives -- so a mode-derived
  // reading would call this run un-isolated while it works in a real worktree.
  it("keeps an agent-level worktree in a non-isolated mode when no layer has workspace control", () => {
    const untouched = buildExecutionWorkspaceAdapterConfig({
      ...base,
      agentConfig: { workspaceStrategy: { type: "git_worktree" } },
      mode: "shared_workspace",
    });
    expect(untouched.workspaceStrategy).toEqual({ type: "git_worktree" });

    expect(
      executionWorkspaceUsesGitWorktree({
        ...base,
        agentConfig: { workspaceStrategy: { type: "git_worktree" } },
        mode: "shared_workspace",
      }),
    ).toBe(true);
  });

  // Divergence route 2: with workspace control present the mode gate DOES strip
  // the agent-level strategy, but the issue `adapterConfig` overlay is applied
  // after that strip and re-introduces one, and realization honours it. Reading
  // only the policy layers here is a false negative: the run would work in a
  // real shared worktree while being keyed as if it had a private tree.
  it("honours an issue adapterConfig overlay that re-introduces a worktree in a NON-isolated mode", () => {
    const controlled = {
      agentConfig: { workspaceStrategy: { type: "git_worktree" } },
      projectPolicy: { enabled: true, defaultMode: "shared_workspace" } as const,
      issueSettings: null,
      mode: "shared_workspace",
      legacyUseProjectWorkspace: null,
    } as const;

    // Precondition: the mode gate really did drop the agent-level strategy, so
    // the assertion below is exercising the overlay and not a leftover.
    expect(
      buildExecutionWorkspaceAdapterConfig(controlled).workspaceStrategy,
    ).toBeUndefined();
    expect(executionWorkspaceUsesGitWorktree(controlled)).toBe(false);

    expect(
      executionWorkspaceUsesGitWorktree({
        ...controlled,
        issueAdapterConfig: { workspaceStrategy: { type: "git_worktree" } },
      }),
    ).toBe(true);
  });

  // Overlay precedence runs the other way too: an issue that pins
  // `project_primary` gets no worktree even though the agent asked for one, and
  // must therefore keep a run-unique reservation key.
  it("lets an issue adapterConfig overlay veto an agent-level worktree", () => {
    expect(
      executionWorkspaceUsesGitWorktree({
        ...base,
        agentConfig: { workspaceStrategy: { type: "git_worktree" } },
        mode: "isolated_workspace",
        issueAdapterConfig: { workspaceStrategy: { type: "project_primary" } },
      }),
    ).toBe(false);
  });

  // `resolveOverlaidWorkspaceStrategy` merges two plain records rather than
  // replacing, so an overlay that sets only `baseRef` must leave the inherited
  // `type` -- and hence the tree keying -- intact.
  it("keeps the inherited type when the overlay sets an unrelated field", () => {
    expect(
      executionWorkspaceUsesGitWorktree({
        ...base,
        agentConfig: { workspaceStrategy: { type: "git_worktree" } },
        mode: "isolated_workspace",
        issueAdapterConfig: { workspaceStrategy: { baseRef: "origin/release" } },
      }),
    ).toBe(true);
  });

  // Matches `realizeExecutionWorkspace`, which treats every value other than
  // the exact string `git_worktree` as `project_primary`.
  it("treats an unrecognised strategy type as not-a-worktree", () => {
    expect(
      executionWorkspaceUsesGitWorktree({
        ...base,
        agentConfig: { workspaceStrategy: { type: "cloud_sandbox" } },
        mode: "isolated_workspace",
      }),
    ).toBe(false);
  });
});
