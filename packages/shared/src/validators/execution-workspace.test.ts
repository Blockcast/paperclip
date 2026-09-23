import { describe, expect, it } from "vitest";
import {
  collectBranchTemplateProblems,
  EXECUTION_WORKSPACE_BRANCH_TEMPLATE_KEYS,
  executionWorkspaceStrategySchema,
} from "./execution-workspace.js";
import { projectExecutionWorkspacePolicySchema } from "./project.js";
import { issueExecutionWorkspaceSettingsSchema } from "./issue.js";

describe("branchTemplate placeholder validation (BLO-31281)", () => {
  it("accepts the default template", () => {
    expect(collectBranchTemplateProblems("{{issue.identifier}}-{{slug}}")).toEqual([]);
  });

  it.each(EXECUTION_WORKSPACE_BRANCH_TEMPLATE_KEYS)("accepts the declared key %s", (key) => {
    expect(collectBranchTemplateProblems(`prefix-{{${key}}}`)).toEqual([]);
  });

  it("tolerates whitespace inside the braces, as renderTemplate does", () => {
    expect(collectBranchTemplateProblems("{{ issue.identifier }}")).toEqual([]);
  });

  it.each([undefined, null, "", "   "])("treats %p as unset rather than invalid", (value) => {
    expect(collectBranchTemplateProblems(value)).toEqual([]);
  });

  it("accepts a template with no placeholders at all", () => {
    // Constant names are redundant (applyIssueIdentifierToBranchName still
    // prefixes the identifier) but not broken, so they must not be rejected.
    expect(collectBranchTemplateProblems("release-branch")).toEqual([]);
  });

  // The observed production value on project e76067d4 ("Reliable Multicast"),
  // which produced 36 worktrees all suffixed "-blo-issueNumber".
  it("rejects single-brace syntax, which is never substituted", () => {
    const problems = collectBranchTemplateProblems("blo-{issueNumber}");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/never substituted/);
  });

  it("rejects a well-formed placeholder whose key is unknown", () => {
    const problems = collectBranchTemplateProblems("blo-{{issueNumber}}");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/unknown placeholder key \{\{issueNumber\}\}/);
    // The message must name the fix, not just the fault.
    expect(problems[0]).toContain("{{issue.identifier}}");
  });

  it("reports both faults independently when both are present", () => {
    const problems = collectBranchTemplateProblems("{{issueNumber}}-{slug}");
    expect(problems).toHaveLength(2);
  });

  it("lists every unknown key once, in order", () => {
    const problems = collectBranchTemplateProblems("{{a}}-{{b}}-{{a}}");
    expect(problems[0]).toContain("{{a}}, {{b}}");
    expect(problems[0]).toMatch(/unknown placeholder keys/);
  });

  it.each([
    "{{issue.identifier}",
    "{issue.identifier}}",
    "{{{issue.identifier}}}",
    "{{issue identifier}}",
  ])("rejects malformed brace syntax %s", (template) => {
    expect(collectBranchTemplateProblems(template).length).toBeGreaterThan(0);
  });

  it("rejects a key that is close to a real one but wrong", () => {
    // `projectId` / `repoRef` are the flat names an operator would guess; the
    // renderer only exposes the nested `project.id` / `workspace.repoRef`.
    expect(collectBranchTemplateProblems("{{projectId}}")).not.toEqual([]);
    expect(collectBranchTemplateProblems("{{repoRef}}")).not.toEqual([]);
  });
});

describe("branchTemplate validation is wired into every write path", () => {
  const bad = { type: "git_worktree" as const, branchTemplate: "blo-{issueNumber}" };
  const good = { type: "git_worktree" as const, branchTemplate: "blo-{{issue.identifier}}" };

  it("rejects at the strategy schema", () => {
    expect(() => executionWorkspaceStrategySchema.parse(bad)).toThrow();
    expect(() => executionWorkspaceStrategySchema.parse(good)).not.toThrow();
  });

  it("rejects on the project execution-workspace policy", () => {
    expect(() => projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      workspaceStrategy: bad,
    })).toThrow();
    expect(() => projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      workspaceStrategy: good,
    })).not.toThrow();
  });

  it("rejects on the per-issue workspace override", () => {
    expect(() => issueExecutionWorkspaceSettingsSchema.parse({
      mode: "isolated_workspace",
      workspaceStrategy: bad,
    })).toThrow();
    expect(() => issueExecutionWorkspaceSettingsSchema.parse({
      mode: "isolated_workspace",
      workspaceStrategy: good,
    })).not.toThrow();
  });

  it("surfaces the error on the branchTemplate path so the UI can point at the field", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      workspaceStrategy: bad,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["workspaceStrategy", "branchTemplate"]);
  });
});
