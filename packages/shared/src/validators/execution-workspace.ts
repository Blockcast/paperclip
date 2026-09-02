import { z } from "zod";
import {
  WORKSPACE_OVERVIEW_DEFAULT_LIMIT,
  WORKSPACE_OVERVIEW_MAX_LIMIT,
} from "../constants.js";

export const executionWorkspaceStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

/**
 * Placeholder keys a `workspaceStrategy.branchTemplate` may reference.
 *
 * This is the declared half of a contract whose other half is
 * `buildWorkspaceTemplateData` (server/src/services/workspace-runtime.ts) — the
 * object actually handed to `renderTemplate`. A test in
 * `server/src/__tests__/workspace-runtime.test.ts` asserts the two agree
 * exactly, in both directions, so adding a key to one without the other fails
 * CI rather than silently producing a template key that renders empty.
 */
export const EXECUTION_WORKSPACE_BRANCH_TEMPLATE_KEYS = [
  "agent.id",
  "agent.name",
  "issue.id",
  "issue.identifier",
  "issue.title",
  "project.id",
  "slug",
  "workspace.repoRef",
] as const;

/**
 * Mirrors the substitution pattern in `renderTemplate`
 * (packages/adapter-utils/src/server-utils.ts). Only a double-braced token
 * whose key matches this shape is ever substituted; everything else survives
 * into the branch name verbatim.
 */
const BRANCH_TEMPLATE_PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;

/**
 * BLO-31281: report every way a `branchTemplate` would fail to render.
 *
 * Two independent failure modes, both of which used to pass validation and
 * render literally into every branch name on the project:
 *
 *  1. An unknown key — `{{issueNumber}}` is well-formed but resolves to the
 *     empty string, silently deleting the part of the name meant to vary.
 *  2. Brace syntax that is never substituted at all — `{issueNumber}` (single
 *     braces) is the observed case. Note a rendered branch name can never
 *     legitimately contain `{` or `}`: `sanitizeBranchName` rewrites both to
 *     `-`. So any brace surviving substitution is unambiguously a mistake,
 *     which is what makes rejecting it safe rather than merely opinionated.
 *
 * Deliberately NOT reported: a template that references no issue-varying key
 * (e.g. a constant `release-branch`). `applyIssueIdentifierToBranchName`
 * force-prefixes the issue identifier, so such a template is redundant rather
 * than broken, and rejecting valid-if-pointless config is a worse trade.
 *
 * Returns an empty array for an absent, empty, or whitespace-only template —
 * those mean "use the default".
 */
export function collectBranchTemplateProblems(template: string | null | undefined): string[] {
  if (typeof template !== "string" || template.trim().length === 0) return [];

  const known = new Set<string>(EXECUTION_WORKSPACE_BRANCH_TEMPLATE_KEYS);
  const unknownKeys: string[] = [];

  // Strip exactly what `renderTemplate` would substitute; whatever is left is
  // what would reach the branch name.
  const residue = template.replace(BRANCH_TEMPLATE_PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!known.has(key) && !unknownKeys.includes(key)) unknownKeys.push(key);
    return "";
  });

  const problems: string[] = [];
  if (unknownKeys.length > 0) {
    problems.push(
      `branchTemplate references unknown placeholder ${unknownKeys.length === 1 ? "key" : "keys"} `
        + `${unknownKeys.map((key) => `{{${key}}}`).join(", ")}. An unknown key renders as empty `
        + `text. Known keys: ${EXECUTION_WORKSPACE_BRANCH_TEMPLATE_KEYS.map((key) => `{{${key}}}`).join(", ")}.`,
    );
  }
  if (/[{}]/.test(residue)) {
    problems.push(
      `branchTemplate contains brace syntax that is never substituted and would appear literally `
        + `in every branch name. Placeholders must be double-braced with a known key, e.g. `
        + `"{{issue.identifier}}-{{slug}}" (single braces such as "{issue.identifier}" are not `
        + `substituted).`,
    );
  }
  return problems;
}

const branchTemplateSchema = z
  .string()
  .optional()
  .nullable()
  .superRefine((value, ctx) => {
    for (const message of collectBranchTemplateProblems(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

/**
 * Shared by the project policy (`executionWorkspacePolicy.workspaceStrategy`)
 * and the per-issue override (`executionWorkspaceSettings.workspaceStrategy`).
 * These were two byte-identical copies until BLO-31281; keep one, so a
 * validation rule can never apply to only one of the two write paths.
 */
export const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: branchTemplateSchema,
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
    // BLO-19063: opt into a per-run working tree. Omitted => "per_issue", the
    // historical behaviour.
    runScope: z.enum(["per_issue", "per_run"]).optional().nullable(),
  })
  .strict();

const workspaceOverviewStatusFilterSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const statuses = rawValues.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    return entry.split(",").map((part) => part.trim()).filter(Boolean);
  });
  return statuses.length > 0 ? statuses : undefined;
}, z.array(executionWorkspaceStatusSchema).optional());

export const workspaceOverviewQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  status: workspaceOverviewStatusFilterSchema,
  limit: z.coerce.number().int().min(1).max(WORKSPACE_OVERVIEW_MAX_LIMIT).optional().default(WORKSPACE_OVERVIEW_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
}).strict();

export const executionWorkspaceConfigSchema = z.object({
  environmentId: z.string().uuid().optional().nullable(),
  provisionCommand: z.string().optional().nullable(),
  teardownCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

export const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
}).strict();

export const executionWorkspaceCloseReadinessStateSchema = z.enum([
  "ready",
  "ready_with_warnings",
  "blocked",
]);

export const executionWorkspaceCloseActionKindSchema = z.enum([
  "archive_record",
  "stop_runtime_services",
  "cleanup_command",
  "teardown_command",
  "git_worktree_remove",
  "git_branch_delete",
  "remove_local_directory",
]);

export const executionWorkspaceCloseActionSchema = z.object({
  kind: executionWorkspaceCloseActionKindSchema,
  label: z.string(),
  description: z.string(),
  command: z.string().nullable(),
}).strict();

export const executionWorkspaceCloseLinkedIssueSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  isTerminal: z.boolean(),
}).strict();

export const executionWorkspaceCloseGitReadinessSchema = z.object({
  repoRoot: z.string().nullable(),
  workspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  baseRef: z.string().nullable(),
  hasDirtyTrackedFiles: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  dirtyEntryCount: z.number().int().nonnegative(),
  untrackedEntryCount: z.number().int().nonnegative(),
  aheadCount: z.number().int().nonnegative().nullable(),
  behindCount: z.number().int().nonnegative().nullable(),
  isMergedIntoBase: z.boolean().nullable(),
  createdByRuntime: z.boolean(),
}).strict();

export const workspaceRuntimeServiceSchema = z.object({
  id: z.string(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  projectWorkspaceId: z.string().uuid().nullable(),
  executionWorkspaceId: z.string().uuid().nullable(),
  issueId: z.string().uuid().nullable(),
  scopeType: z.enum(["project_workspace", "execution_workspace", "run", "agent"]),
  scopeId: z.string().nullable(),
  serviceName: z.string(),
  status: z.enum(["starting", "running", "stopped", "failed"]),
  lifecycle: z.enum(["shared", "ephemeral"]),
  reuseKey: z.string().nullable(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  provider: z.enum(["local_process", "adapter_managed"]),
  providerRef: z.string().nullable(),
  ownerAgentId: z.string().uuid().nullable(),
  startedByRunId: z.string().uuid().nullable(),
  lastUsedAt: z.coerce.date(),
  startedAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  stopPolicy: z.record(z.string(), z.unknown()).nullable(),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]),
  configIndex: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export const executionWorkspaceCloseReadinessSchema = z.object({
  workspaceId: z.string().uuid(),
  state: executionWorkspaceCloseReadinessStateSchema,
  blockingReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  linkedIssues: z.array(executionWorkspaceCloseLinkedIssueSchema),
  plannedActions: z.array(executionWorkspaceCloseActionSchema),
  isDestructiveCloseAllowed: z.boolean(),
  isSharedWorkspace: z.boolean(),
  isProjectPrimaryWorkspace: z.boolean(),
  git: executionWorkspaceCloseGitReadinessSchema.nullable(),
  runtimeServices: z.array(workspaceRuntimeServiceSchema),
}).strict();

export const updateExecutionWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  cwd: z.string().optional().nullable(),
  repoUrl: z.string().optional().nullable(),
  baseRef: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  providerRef: z.string().optional().nullable(),
  status: executionWorkspaceStatusSchema.optional(),
  cleanupEligibleAt: z.string().datetime().optional().nullable(),
  cleanupReason: z.string().optional().nullable(),
  config: executionWorkspaceConfigSchema.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

const branchReconcileReasonSchema = z.string().trim().min(1);

export const reconcileExecutionWorkspaceBranchSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("forward"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
  z.object({
    mode: z.literal("override"),
    reason: branchReconcileReasonSchema,
  }).strict(),
  z.object({
    mode: z.literal("quarantine_restore"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
]);

export type UpdateExecutionWorkspace = z.infer<typeof updateExecutionWorkspaceSchema>;
export type ReconcileExecutionWorkspaceBranch = z.infer<typeof reconcileExecutionWorkspaceBranchSchema>;
export type WorkspaceOverviewQuery = z.infer<typeof workspaceOverviewQuerySchema>;
