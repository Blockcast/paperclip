import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type {
  PaperclipPluginManifestV1,
  PluginExecutionWorkspaceMetadata,
  PluginWorkspace,
} from "../src/types.js";

const manifest = {
  id: "paperclip.test-workspaces",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Workspaces",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["project.workspaces.read"],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

const COMPANY_ID = "company-1";
const PROJECT_ID = "project-1";
const BASE_CHECKOUT = "/srv/projects/paperclip";

const primaryWorkspace: PluginWorkspace = {
  id: "project-workspace-1",
  projectId: PROJECT_ID,
  name: "paperclip",
  path: BASE_CHECKOUT,
  repoUrl: "https://github.com/Blockcast/paperclip.git",
  repoRef: "master",
  defaultRef: "master",
  isPrimary: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function executionWorkspace(
  overrides: Partial<PluginExecutionWorkspaceMetadata> & Pick<PluginExecutionWorkspaceMetadata, "id">,
): PluginExecutionWorkspaceMetadata {
  const cwd = overrides.cwd ?? `${BASE_CHECKOUT}/.paperclip/worktrees/${overrides.id}`;
  return {
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    projectWorkspaceId: primaryWorkspace.id,
    name: `wt-${overrides.id}`,
    path: cwd,
    cwd,
    repoUrl: null,
    baseRef: "origin/master",
    branchName: `branch-${overrides.id}`,
    providerType: "git_worktree",
    mode: "isolated_workspace",
    providerMetadata: null,
    ...overrides,
  };
}

function harnessWith(executionWorkspaces: PluginExecutionWorkspaceMetadata[], issueBindings: Array<{ id: string; executionWorkspaceId: string | null }>) {
  const harness = createTestHarness({ manifest });
  harness.seed({
    projects: [{ id: PROJECT_ID, companyId: COMPANY_ID, name: "Paperclip" } as never],
    issues: issueBindings.map(
      (binding) =>
        ({
          id: binding.id,
          companyId: COMPANY_ID,
          projectId: PROJECT_ID,
          title: `Issue ${binding.id}`,
          status: "in_progress",
          priority: "medium",
          executionWorkspaceId: binding.executionWorkspaceId,
        }) as never,
    ),
    projectWorkspaces: [primaryWorkspace],
    executionWorkspaces,
  });
  return harness;
}

describe("createTestHarness getWorkspaceForIssue", () => {
  it("resolves the issue's own bound execution workspace, labelled the way the host labels it", async () => {
    const workspace = executionWorkspace({ id: "ws-a" });
    const harness = harnessWith([workspace], [{ id: "issue-a", executionWorkspaceId: "ws-a" }]);

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    expect(result).toMatchObject({
      id: "ws-a",
      path: workspace.cwd,
      isIssueScoped: true,
      mode: "isolated_workspace",
      isPrimary: false,
    });
    expect(result?.path).not.toBe(BASE_CHECKOUT);
    // The host labels the result with the execution workspace's own `name`
    // column, not its branch — so the double must too, or a workspace whose
    // name is not its branch gets a different label from each.
    expect(result?.name).toBe("wt-ws-a");
  });

  it("gives two issues in one project the paths of their own worktrees", async () => {
    const harness = harnessWith(
      [executionWorkspace({ id: "ws-a" }), executionWorkspace({ id: "ws-b" })],
      [
        { id: "issue-a", executionWorkspaceId: "ws-a" },
        { id: "issue-b", executionWorkspaceId: "ws-b" },
      ],
    );

    const a = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);
    const b = await harness.ctx.projects.getWorkspaceForIssue("issue-b", COMPANY_ID);

    expect(a?.path).not.toBe(b?.path);
    expect([a?.path, b?.path]).not.toContain(BASE_CHECKOUT);
  });

  // BLO-31349 / Ally review of 97cd239: the happy path above asserts
  // `mode: "isolated_workspace"` against a helper that SEEDS that same literal,
  // so it passes identically whether the double passes the seeded mode through,
  // falls back, or hard-codes it — replacing the mapping with a bare literal
  // would break nothing. These two cases separate the limbs: the first seeds a
  // mode that is not the default and asserts it survives (passthrough), the
  // second omits the field entirely and asserts the substitute (default).
  it("passes a seeded non-isolated mode through rather than substituting", async () => {
    const workspace = executionWorkspace({ id: "ws-a", mode: "operator_branch" });
    const harness = harnessWith([workspace], [{ id: "issue-a", executionWorkspaceId: "ws-a" }]);

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    // `operator_branch` is issue-bound but NOT isolated, so a plugin asking the
    // isolation question must get `false` here even though the workspace did
    // resolve issue-scoped. Those two facts are independent.
    expect(result).toMatchObject({ id: "ws-a", isIssueScoped: true, mode: "operator_branch" });
  });

  it("substitutes a non-isolated mode when the seeded workspace omits one", async () => {
    // Seeded as a raw metadata object rather than via `executionWorkspace`,
    // because that helper always seeds a `mode` — omission is the case under
    // test and the helper cannot express it.
    const cwd = `${BASE_CHECKOUT}/.paperclip/worktrees/ws-a`;
    const harness = harnessWith(
      [
        {
          id: "ws-a",
          companyId: COMPANY_ID,
          projectId: PROJECT_ID,
          projectWorkspaceId: primaryWorkspace.id,
          name: "wt-ws-a",
          path: cwd,
          cwd,
          repoUrl: null,
          baseRef: "origin/master",
          branchName: "branch-ws-a",
          providerType: "git_worktree",
          providerMetadata: null,
        },
      ],
      [{ id: "issue-a", executionWorkspaceId: "ws-a" }],
    );

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    // Non-null, because the host's column is non-null and `mode: null` on an
    // issue-scoped result would tell callers to read it as project-scoped...
    expect(result?.mode).not.toBeNull();
    // ...but NOT one of the two isolation-guaranteeing modes. An author who
    // seeded nothing about isolation must not be handed the strongest claim:
    // this is the assertion that fails if the default is flipped back to
    // `isolated_workspace`.
    expect(result?.mode).toBe("shared_workspace");
    expect(result).toMatchObject({ id: "ws-a", isIssueScoped: true });
  });

  // BLO-31349 / Ally review of a8a2628: the host rejects a bound workspace on
  // THREE tests — wrong company, closed/archived, and no realized `cwd`. Before
  // `closed` existed on PluginExecutionWorkspaceMetadata a plugin author could
  // not seed an archived workspace at all, so this fallback was unreachable from
  // the double and the harness modelled every seeded workspace as live. Each
  // case below pins one rejection limb.
  it("falls back to the project-scoped workspace when the bound workspace is closed", async () => {
    const harness = harnessWith(
      [executionWorkspace({ id: "ws-a", closed: true })],
      [{ id: "issue-a", executionWorkspaceId: "ws-a" }],
    );

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    // A torn-down worktree has no directory to offer, so the honest answer is
    // the project-scoped fallback — explicitly flagged, never a bare path.
    expect(result).toMatchObject({ id: primaryWorkspace.id, path: BASE_CHECKOUT, isIssueScoped: false, mode: null });
  });

  // `closed` is documented as "absent or `false` both mean not closed"
  // (`types.ts`). The happy path above inherits the helper's absent default, so
  // this pins the other half of that promise explicitly.
  it("resolves the bound workspace when `closed` is explicitly false", async () => {
    const workspace = executionWorkspace({ id: "ws-a", closed: false });
    const harness = harnessWith([workspace], [{ id: "issue-a", executionWorkspaceId: "ws-a" }]);

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    expect(result).toMatchObject({ id: "ws-a", path: workspace.cwd, isIssueScoped: true });
  });

  it("falls back when the bound workspace has no realized cwd", async () => {
    const harness = harnessWith(
      [executionWorkspace({ id: "ws-a", cwd: null })],
      [{ id: "issue-a", executionWorkspaceId: "ws-a" }],
    );

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    expect(result).toMatchObject({ isIssueScoped: false, path: BASE_CHECKOUT });
  });

  it("falls back when the bound workspace belongs to another company", async () => {
    const harness = harnessWith(
      [executionWorkspace({ id: "ws-a", companyId: "company-2" })],
      [{ id: "issue-a", executionWorkspaceId: "ws-a" }],
    );

    const result = await harness.ctx.projects.getWorkspaceForIssue("issue-a", COMPANY_ID);

    expect(result).toMatchObject({ isIssueScoped: false, path: BASE_CHECKOUT });
  });

  it("leaves getPrimaryWorkspace project-scoped and unflagged", async () => {
    const harness = harnessWith([executionWorkspace({ id: "ws-a" })], [{ id: "issue-a", executionWorkspaceId: "ws-a" }]);

    const primary = await harness.ctx.projects.getPrimaryWorkspace(PROJECT_ID, COMPANY_ID);

    expect(primary?.path).toBe(BASE_CHECKOUT);
    // Deliberately undefined, not `false`: the question does not apply to a
    // project-scoped reader, and asserting `false` here would be the lie the
    // isIssueScoped doc exists to prevent.
    expect(primary?.isIssueScoped).toBeUndefined();
  });
});
