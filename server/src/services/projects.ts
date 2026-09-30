import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  projects,
  projectGoals,
  goals,
  issues,
  budgetPolicies,
  pluginManagedResources,
  plugins,
  pluginState,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  deriveProjectUrlKey,
  hasNonAsciiContent,
  isUuidLike,
  normalizeProjectUrlKey,
  type BudgetWindowKind,
  type ProjectBudgetSummary,
  type ProjectCodebase,
  type ProjectExecutionWorkspacePolicy,
  type ProjectGoalRef,
  type LinearProjectLink,
  type ProjectManagedByPlugin,
  type ProjectWorkspaceRuntimeConfig,
  type ProjectWorkspace,
  type PrimaryWorkspaceSource,
  type WorkspaceRuntimeService,
  type PluginManagedProjectDeclaration,
  type PluginManagedProjectResolution,
} from "@paperclipai/shared";
import { listCurrentRuntimeServicesForProjectWorkspaces } from "./workspace-runtime-read-model.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { mergeProjectWorkspaceRuntimeConfig, readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { recordProjectPrimaryWorkspaceFallback } from "./metrics.js";
import { logger } from "../middleware/logger.js";

type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
type CreateWorkspaceInput = {
  name?: string | null;
  sourceType?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
  visibility?: string | null;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  remoteProvider?: string | null;
  remoteWorkspaceRef?: string | null;
  sharedWorkspaceKey?: string | null;
  metadata?: Record<string, unknown> | null;
  runtimeConfig?: Partial<ProjectWorkspaceRuntimeConfig> | null;
  isPrimary?: boolean;
};
type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;

interface ProjectWithGoals extends Omit<ProjectRow, "executionWorkspacePolicy"> {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  primaryWorkspaceSource: PrimaryWorkspaceSource;
  managedByPlugin: ProjectManagedByPlugin | null;
  linearProjectLink: LinearProjectLink | null;
  taskCount?: number;
  budget?: ProjectBudgetSummary | null;
}

interface ProjectShortnameRow {
  id: string;
  name: string;
}

interface ResolveProjectNameOptions {
  excludeProjectId?: string | null;
}

/** Batch-load goal refs for a set of projects. */
async function attachGoals(db: Db, rows: ProjectRow[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);

  // Fetch join rows + goal titles in one query
  const links = await db
    .select({
      projectId: projectGoals.projectId,
      goalId: projectGoals.goalId,
      goalTitle: goals.title,
    })
    .from(projectGoals)
    .innerJoin(goals, eq(projectGoals.goalId, goals.id))
    .where(inArray(projectGoals.projectId, projectIds));

  const map = new Map<string, ProjectGoalRef[]>();
  for (const link of links) {
    let arr = map.get(link.projectId);
    if (!arr) {
      arr = [];
      map.set(link.projectId, arr);
    }
    arr.push({ id: link.goalId, title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      urlKey: deriveProjectUrlKey(r.name, r.id),
      goalIds: g.map((x) => x.id),
      goals: g,
      executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(r.executionWorkspacePolicy),
    } as ProjectWithGoals;
  });
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkspace(
  row: ProjectWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ProjectWorkspace {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
  const runtimeConfig = readProjectWorkspaceRuntimeConfig(metadata);
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    sourceType: row.sourceType as ProjectWorkspace["sourceType"],
    cwd: normalizeWorkspaceCwd(row.cwd),
    repoUrl: row.repoUrl ?? null,
    repoRef: row.repoRef ?? null,
    defaultRef: row.defaultRef ?? row.repoRef ?? null,
    visibility: row.visibility as ProjectWorkspace["visibility"],
    setupCommand: row.setupCommand ?? null,
    cleanupCommand: row.cleanupCommand ?? null,
    remoteProvider: row.remoteProvider ?? null,
    remoteWorkspaceRef: row.remoteWorkspaceRef ?? null,
    sharedWorkspaceKey: row.sharedWorkspaceKey ?? null,
    metadata,
    runtimeConfig,
    hasWorkspaceRuntimeConfig: Boolean(runtimeConfig?.workspaceRuntime),
    isPrimary: row.isPrimary,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const raw = readNonEmptyString(repoUrl);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

function deriveProjectCodebase(input: {
  companyId: string;
  projectId: string;
  primaryWorkspace: ProjectWorkspace | null;
  fallbackWorkspaces: ProjectWorkspace[];
}): ProjectCodebase {
  const primaryWorkspace = input.primaryWorkspace ?? input.fallbackWorkspaces[0] ?? null;
  const repoUrl = primaryWorkspace?.repoUrl ?? null;
  const repoName = deriveRepoNameFromRepoUrl(repoUrl);
  const localFolder = primaryWorkspace?.cwd ?? null;
  const managedFolder = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName,
  });

  return {
    workspaceId: primaryWorkspace?.id ?? null,
    repoUrl,
    repoRef: primaryWorkspace?.repoRef ?? null,
    defaultRef: primaryWorkspace?.defaultRef ?? null,
    repoName,
    localFolder,
    managedFolder,
    effectiveLocalFolder: localFolder ?? managedFolder,
    origin: localFolder ? "local_folder" : "managed_checkout",
  };
}

/**
 * Resolve a project's primary workspace, and report whether it was
 * explicitly flagged or guessed (BLO-26184). Never throws and never refuses
 * to resolve — 0 workspaces resolves `null`/"none", and a multi-workspace
 * project with no explicit primary still resolves the earliest-created row
 * (fail-open contract affirmed by the CTO on BLO-23599's follow-up). What
 * changed is that the guess is no longer indistinguishable from a choice: the
 * caller gets `source: "inferred"` and a fallback counter/log fires, so drift
 * like CDN+ Supply Side Rewards's 3-workspaces/0-primary state is observable
 * instead of silently presented as `primaryWorkspace: <name>`.
 */
function pickPrimaryWorkspace(
  rows: ProjectWorkspaceRow[],
  runtimeServicesByWorkspaceId?: Map<string, WorkspaceRuntimeService[]>,
): { workspace: ProjectWorkspace | null; source: PrimaryWorkspaceSource } {
  if (rows.length === 0) return { workspace: null, source: "none" };
  const explicitPrimary = rows.find((row) => row.isPrimary);
  const primary = explicitPrimary ?? rows[0];
  const workspace = toWorkspace(primary, runtimeServicesByWorkspaceId?.get(primary.id) ?? []);
  if (explicitPrimary) return { workspace, source: "explicit" };
  recordProjectPrimaryWorkspaceFallback(primary.projectId);
  return { workspace, source: "inferred" };
}

/** Batch-load workspace refs for a set of projects. */
async function attachWorkspaces(db: Db, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const runtimeServicesByWorkspaceId = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    rows[0]!.companyId,
    workspaceRows.map((workspace) => workspace.id),
  );
  const sharedRuntimeServicesByWorkspaceId = new Map(
    Array.from(runtimeServicesByWorkspaceId.entries()).map(([workspaceId, services]) => [
      workspaceId,
      services.map(toRuntimeService),
    ]),
  );

  const map = new Map<string, ProjectWorkspaceRow[]>();
  for (const row of workspaceRows) {
    let arr = map.get(row.projectId);
    if (!arr) {
      arr = [];
      map.set(row.projectId, arr);
    }
    arr.push(row);
  }

  const managedRows = await db
    .select({
      id: pluginManagedResources.id,
      pluginId: pluginManagedResources.pluginId,
      pluginKey: pluginManagedResources.pluginKey,
      manifestJson: plugins.manifestJson,
      resourceKind: pluginManagedResources.resourceKind,
      resourceKey: pluginManagedResources.resourceKey,
      resourceId: pluginManagedResources.resourceId,
      defaultsJson: pluginManagedResources.defaultsJson,
      createdAt: pluginManagedResources.createdAt,
      updatedAt: pluginManagedResources.updatedAt,
    })
    .from(pluginManagedResources)
    .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
    .where(and(
      eq(pluginManagedResources.resourceKind, "project"),
      inArray(pluginManagedResources.resourceId, projectIds),
    ));
  const managedByProjectId = new Map<string, ProjectManagedByPlugin>();
  for (const row of managedRows) {
    managedByProjectId.set(row.resourceId, {
      id: row.id,
      pluginId: row.pluginId,
      pluginKey: row.pluginKey,
      pluginDisplayName: row.manifestJson.displayName ?? row.pluginKey,
      resourceKind: "project",
      resourceKey: row.resourceKey,
      defaultsJson: row.defaultsJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  // Resolve Linear project links stored in plugin_state by the linear sync plugin.
  // Keys follow the pattern "project-link:{paperclipProjectId}" under instance scope.
  const linearProjectLinkByProjectId = new Map<string, LinearProjectLink>();
  const linearProjectLinkKeys = projectIds.map((id) => `project-link:${id}`);
  const linearStateRows = await db
    .select({
      stateKey: pluginState.stateKey,
      valueJson: pluginState.valueJson,
    })
    .from(pluginState)
    .innerJoin(plugins, eq(pluginState.pluginId, plugins.id))
    .where(and(
      eq(plugins.pluginKey, "paperclip-plugin-linear"),
      eq(pluginState.scopeKind, "instance"),
      inArray(pluginState.stateKey, linearProjectLinkKeys),
    ));
  for (const row of linearStateRows) {
    const value = row.valueJson as Record<string, unknown>;
    const paperclipProjectId = typeof value.paperclipProjectId === "string" ? value.paperclipProjectId : null;
    if (
      paperclipProjectId
      && typeof value.linearProjectId === "string"
      && typeof value.linearProjectName === "string"
      && typeof value.syncDirection === "string"
      && typeof value.lastSyncAt === "string"
    ) {
      linearProjectLinkByProjectId.set(paperclipProjectId, {
        linearProjectId: value.linearProjectId,
        linearProjectName: value.linearProjectName,
        syncDirection: value.syncDirection as LinearProjectLink["syncDirection"],
        lastSyncAt: value.lastSyncAt,
      });
    }
  }

  return rows.map((row) => {
    const projectWorkspaceRows = map.get(row.id) ?? [];
    const workspaces = projectWorkspaceRows.map((workspace) =>
      toWorkspace(
        workspace,
        sharedRuntimeServicesByWorkspaceId.get(workspace.id) ?? [],
      ),
    );
    const primaryWorkspaceResolution = pickPrimaryWorkspace(projectWorkspaceRows, sharedRuntimeServicesByWorkspaceId);
    const { workspace: primaryWorkspace, source: primaryWorkspaceSource } = primaryWorkspaceResolution;
    return {
      ...row,
      codebase: deriveProjectCodebase({
        companyId: row.companyId,
        projectId: row.id,
        primaryWorkspace,
        fallbackWorkspaces: workspaces,
      }),
      workspaces,
      primaryWorkspace,
      primaryWorkspaceSource,
      managedByPlugin: managedByProjectId.get(row.id) ?? null,
      linearProjectLink: linearProjectLinkByProjectId.get(row.id) ?? null,
    };
  });
}

type TaskCountRow = { projectId: string | null; count: number };
type ProjectBudgetRow = { scopeId: string; amount: number; windowKind: string };

/**
 * Build the per-project task-count and budget lookups from the aggregate query
 * rows. Pure (no DB) so the merge logic can be unit-tested in isolation.
 * Only active policies with a positive amount surface as a budget.
 */
export function buildProjectListMetricMaps(taskCountRows: TaskCountRow[], budgetRows: ProjectBudgetRow[]) {
  const taskCountByProjectId = new Map<string, number>();
  for (const row of taskCountRows) {
    if (row.projectId) taskCountByProjectId.set(row.projectId, Number(row.count) || 0);
  }

  const budgetByProjectId = new Map<string, ProjectBudgetSummary>();
  for (const row of budgetRows) {
    if (row.amount > 0) {
      budgetByProjectId.set(row.scopeId, {
        amountCents: row.amount,
        windowKind: row.windowKind as BudgetWindowKind,
      });
    }
  }

  return { taskCountByProjectId, budgetByProjectId };
}

/**
 * Attach lightweight list-only metrics (task count + budget) to a set of
 * projects using two aggregate queries (no N+1). Used by the projects list
 * view (IA Phase 4 — PAP-60).
 */
async function attachListMetrics(
  db: Db,
  companyId: string,
  rows: ProjectWithGoals[],
): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return rows;

  const projectIds = rows.map((r) => r.id);

  const [taskCountRows, budgetRows] = await Promise.all([
    db
      .select({
        projectId: issues.projectId,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.projectId, projectIds)))
      .groupBy(issues.projectId),
    db
      .select({
        scopeId: budgetPolicies.scopeId,
        amount: budgetPolicies.amount,
        windowKind: budgetPolicies.windowKind,
      })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "project"),
          eq(budgetPolicies.metric, "billed_cents"),
          eq(budgetPolicies.isActive, true),
          inArray(budgetPolicies.scopeId, projectIds),
        ),
      ),
  ]);

  const { taskCountByProjectId, budgetByProjectId } = buildProjectListMetricMaps(
    taskCountRows,
    budgetRows,
  );

  return rows.map((row) => ({
    ...row,
    taskCount: taskCountByProjectId.get(row.id) ?? 0,
    budget: budgetByProjectId.get(row.id) ?? null,
  }));
}

/** Sync the project_goals join table for a single project. */
async function syncGoalLinks(db: Db, projectId: string, companyId: string, goalIds: string[]) {
  // Delete existing links
  await db.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // Insert new links
  if (goalIds.length > 0) {
    await db.insert(projectGoals).values(
      goalIds.map((goalId) => ({ projectId, goalId, companyId })),
    );
  }
}

/** Resolve goalIds from input, handling the legacy goalId field. */
function resolveGoalIds(data: { goalIds?: string[]; goalId?: string | null }): string[] | undefined {
  if (data.goalIds !== undefined) return data.goalIds;
  if (data.goalId !== undefined) {
    return data.goalId ? [data.goalId] : [];
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceCwd(value: unknown): string | null {
  const cwd = readNonEmptyString(value);
  if (!cwd) return null;
  return cwd === REPO_ONLY_CWD_SENTINEL ? null : cwd;
}

function deriveNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Local folder";
}

function deriveNameFromRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const cleanedPath = url.pathname.replace(/\/+$/, "");
    const lastSegment = cleanedPath.split("/").filter(Boolean).pop() ?? "";
    const noGitSuffix = lastSegment.replace(/\.git$/i, "");
    return noGitSuffix || repoUrl;
  } catch {
    return repoUrl;
  }
}

function deriveWorkspaceName(input: {
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
}) {
  const explicit = readNonEmptyString(input.name);
  if (explicit) return explicit;

  const cwd = readNonEmptyString(input.cwd);
  if (cwd) return deriveNameFromCwd(cwd);

  const repoUrl = readNonEmptyString(input.repoUrl);
  if (repoUrl) return deriveNameFromRepoUrl(repoUrl);

  return "Workspace";
}

function buildManagedProjectDefaults(declaration: PluginManagedProjectDeclaration) {
  return {
    projectKey: declaration.projectKey,
    displayName: declaration.displayName,
    description: declaration.description ?? null,
    status: declaration.status ?? "in_progress",
    color: declaration.color ?? null,
    settings: declaration.settings ?? {},
  };
}

export function resolveProjectNameForUniqueShortname(
  requestedName: string,
  existingProjects: ProjectShortnameRow[],
  options?: ResolveProjectNameOptions,
): string {
  const requestedShortname = normalizeProjectUrlKey(requestedName);
  if (!requestedShortname) return requestedName;
  // Non-ASCII names get a UUID suffix in deriveProjectUrlKey, making slugs inherently unique.
  if (hasNonAsciiContent(requestedName)) return requestedName;

  const usedShortnames = new Set(
    existingProjects
      .filter((project) => !(options?.excludeProjectId && project.id === options.excludeProjectId))
      .map((project) => normalizeProjectUrlKey(project.name))
      .filter((value): value is string => value !== null),
  );
  if (!usedShortnames.has(requestedShortname)) return requestedName;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidateName = `${requestedName} ${suffix}`;
    const candidateShortname = normalizeProjectUrlKey(candidateName);
    if (candidateShortname && !usedShortnames.has(candidateShortname)) {
      return candidateName;
    }
  }

  // Fallback guard for pathological naming collisions.
  return `${requestedName} ${Date.now()}`;
}

/**
 * Walk candidate workspaces in creation order and promote the first one that
 * still exists, retrying past rows that were concurrently removed.
 *
 * Termination (BLO-26184): every pass marks exactly one id as tried, and the
 * next candidate is always drawn from the *untried* remainder, so a project
 * holding N workspaces can burn at most N passes. `maxAttempts` is therefore
 * not the real bound — it is a safety valve against an unbounded stream of
 * concurrent INSERTs, deliberately set far above any plausible workspace count
 * so that genuine candidate exhaustion always wins the race to terminate.
 *
 * The previous implementation capped this at 5. That cap was low enough to be
 * reached by real candidates: a project with >5 workspaces whose promotions
 * kept losing the race would exit the loop with `candidateId` still pointing at
 * an untried row, having already demoted everything — and the caller's warning
 * only covered the exhausted case, so it exited silently. Hence the split
 * `result` below: callers must be able to tell "nothing left to promote" from
 * "gave up with work remaining".
 */
export async function promoteFirstSurvivingWorkspace(input: {
  initialCandidateId: string;
  tryPromote: (workspaceId: string) => Promise<boolean>;
  listCandidateIds: () => Promise<string[]>;
  maxAttempts?: number;
}): Promise<{
  result: "promoted" | "candidates_exhausted" | "attempt_cap_reached";
  promotedId: string | null;
  triedIds: string[];
}> {
  const maxAttempts = input.maxAttempts ?? 1_000;
  const triedIds = new Set<string>();
  let candidateId: string | null = input.initialCandidateId;
  let attempts = 0;

  while (candidateId && attempts < maxAttempts) {
    attempts += 1;
    triedIds.add(candidateId);

    if (await input.tryPromote(candidateId)) {
      return { result: "promoted", promotedId: candidateId, triedIds: Array.from(triedIds) };
    }

    const remaining = await input.listCandidateIds();
    candidateId = remaining.find((id) => !triedIds.has(id)) ?? null;
  }

  return {
    result: candidateId === null ? "candidates_exhausted" : "attempt_cap_reached",
    promotedId: null,
    triedIds: Array.from(triedIds),
  };
}

/**
 * Demote every workspace on a project and promote exactly `keepWorkspaceId`
 * (BLO-26184). Callers hold `keepWorkspaceId` from a SELECT that ran before
 * this function's own statements, so it is not guaranteed to still exist by
 * the time the promote UPDATE runs: a concurrent transaction touching the
 * SAME project (a second removeWorkspace racing this one, for example) can
 * delete that exact row in between. Previously the promote UPDATE would then
 * match zero rows, and — because the demote-all UPDATE just above it always
 * runs unconditionally — the project would be left with N workspaces and 0
 * primaries. That is precisely the drift shape seen on CDN+ Supply Side
 * Rewards (BLO-23599): this is the write-path hole scope item 3 asks to
 * close, identified by code inspection (a logical TOCTOU proof), not by
 * reproducing the historical incident against its actual audit trail, which
 * is not accessible from here.
 *
 * Fix: verify the promote UPDATE actually affected a row; if the target was
 * concurrently removed, re-pick a surviving candidate and retry rather than
 * leaving the project premoted-to-nobody. The walk itself lives in
 * `promoteFirstSurvivingWorkspace` below, which owns the termination argument.
 *
 * Whichever way the walk ends without promoting, a structured warning fires
 * rather than an assertion: 0 remaining workspaces is a legitimate
 * empty-project state, not a bug in this function. What must never happen is
 * returning *quietly* after the demote-all — the whole point of this function
 * is that a project is never silently left at 0 primaries.
 */
async function ensureSinglePrimaryWorkspace(
  dbOrTx: any,
  input: {
    companyId: string;
    projectId: string;
    keepWorkspaceId: string;
  },
) {
  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    );

  const outcome = await promoteFirstSurvivingWorkspace({
    initialCandidateId: input.keepWorkspaceId,
    tryPromote: async (workspaceId) => {
      const promoted = await dbOrTx
        .update(projectWorkspaces)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(
          and(
            eq(projectWorkspaces.companyId, input.companyId),
            eq(projectWorkspaces.projectId, input.projectId),
            eq(projectWorkspaces.id, workspaceId),
          ),
        )
        .returning({ id: projectWorkspaces.id });
      return promoted.length > 0;
    },
    listCandidateIds: async () => {
      const remaining: Array<{ id: string }> = await dbOrTx
        .select({ id: projectWorkspaces.id })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, input.companyId),
            eq(projectWorkspaces.projectId, input.projectId),
          ),
        )
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
      return remaining.map((row) => row.id);
    },
  });

  if (outcome.result === "promoted") return;

  // Every row is demoted by this point, so both remaining outcomes leave the
  // project at 0 primaries and both must be loud. Previously only the
  // exhausted branch warned, so hitting the attempt cap returned silently —
  // the exact "guess indistinguishable from a choice" failure this issue is
  // about, re-created inside its own fix.
  logger.warn(
    {
      companyId: input.companyId,
      projectId: input.projectId,
      triedWorkspaceIds: outcome.triedIds,
      result: outcome.result,
    },
    outcome.result === "candidates_exhausted"
      ? "ensureSinglePrimaryWorkspace: every candidate workspace was concurrently removed; "
        + "project has 0 remaining workspaces or all were deleted mid-promotion"
      : "ensureSinglePrimaryWorkspace: hit the concurrent-insert safety cap with candidates still "
        + "untried; project is left with 0 primaries and needs manual inspection",
  );
}

export function projectService(db: Db) {
  const createProject = async (
    companyId: string,
    data: Omit<typeof projects.$inferInsert, "companyId"> & { goalIds?: string[] },
  ): Promise<ProjectWithGoals> => {
    const { goalIds: inputGoalIds, ...projectData } = data;
    const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });

    // Note: color is intentionally NOT auto-assigned. New projects default to
    // `color = null` (neutral gray) unless an explicit color is supplied. See PAP-68.

    const existingProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects);

    // Also write goalId to the legacy column (first goal or null)
    const legacyGoalId = ids && ids.length > 0 ? ids[0] : projectData.goalId ?? null;

    const row = await db
      .insert(projects)
      .values({ ...projectData, goalId: legacyGoalId, companyId })
      .returning()
      .then((rows) => rows[0]);

    if (ids && ids.length > 0) {
      await syncGoalLinks(db, row.id, companyId, ids);
    }

    const [withGoals] = await attachGoals(db, [row]);
    const [enriched] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
    return enriched!;
  };

  const getProjectById = async (id: string): Promise<ProjectWithGoals | null> => {
    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [withGoals] = await attachGoals(db, [row]);
    if (!withGoals) return null;
    const [enriched] = await attachWorkspaces(db, [withGoals]);
    return enriched ?? null;
  };

  return {
    list: async (companyId: string): Promise<ProjectWithGoals[]> => {
      const rows = await db.select().from(projects).where(eq(projects.companyId, companyId));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      return attachListMetrics(db, companyId, withWorkspaces);
    },

    listByIds: async (companyId: string, ids: string[]): Promise<ProjectWithGoals[]> => {
      const dedupedIds = [...new Set(ids)];
      if (dedupedIds.length === 0) return [];
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, dedupedIds)));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      const byId = new Map(withWorkspaces.map((project) => [project.id, project]));
      return dedupedIds.map((id) => byId.get(id)).filter((project): project is ProjectWithGoals => Boolean(project));
    },

    getById: getProjectById,

    resolveManagedProject: async (input: {
      companyId: string;
      pluginId: string;
      pluginKey: string;
      projectKey: string;
      reset?: boolean;
      createIfMissing?: boolean;
    }): Promise<PluginManagedProjectResolution> => {
      const plugin = await db
        .select({ id: plugins.id, pluginKey: plugins.pluginKey, manifestJson: plugins.manifestJson })
        .from(plugins)
        .where(eq(plugins.id, input.pluginId))
        .then((rows) => rows[0] ?? null);
      if (!plugin || plugin.pluginKey !== input.pluginKey) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const declaration = plugin.manifestJson.projects?.find((project) => project.projectKey === input.projectKey);
      if (!declaration) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const defaults = buildManagedProjectDefaults(declaration);
      const existingBinding = await db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.pluginId, input.pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, input.projectKey),
        ))
        .then((rows) => rows[0] ?? null);

      if (existingBinding) {
        const existingProject = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)))
          .then((rows) => rows[0] ?? null);
        if (existingProject) {
          if (input.reset) {
            await db
              .update(projects)
              .set({
                name: declaration.displayName,
                description: declaration.description ?? null,
                status: declaration.status ?? "in_progress",
                color: declaration.color ?? null,
                updatedAt: new Date(),
              })
              .where(and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)));
          }
          if (input.createIfMissing !== false) {
            await db
              .update(pluginManagedResources)
              .set({ defaultsJson: defaults, updatedAt: new Date() })
              .where(eq(pluginManagedResources.id, existingBinding.id));
          }
          const project = await getProjectById(existingBinding.resourceId);
          return {
            pluginKey: input.pluginKey,
            resourceKind: "project",
            resourceKey: input.projectKey,
            companyId: input.companyId,
            projectId: project?.id ?? existingBinding.resourceId,
            project: project as import("@paperclipai/shared").Project | null,
            status: input.reset ? "reset" : "resolved",
          };
        }

        if (input.createIfMissing === false) {
          return {
            pluginKey: input.pluginKey,
            resourceKind: "project",
            resourceKey: input.projectKey,
            companyId: input.companyId,
            projectId: null,
            project: null,
            status: "missing",
          };
        }

        const project = await createProject(input.companyId, {
          name: declaration.displayName,
          description: declaration.description ?? null,
          status: declaration.status ?? "in_progress",
          color: declaration.color ?? undefined,
        });
        await db
          .update(pluginManagedResources)
          .set({ resourceId: project.id, defaultsJson: defaults, updatedAt: new Date() })
          .where(eq(pluginManagedResources.id, existingBinding.id));
        const hydrated = await getProjectById(project.id);
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: hydrated?.id ?? project.id,
          project: hydrated as import("@paperclipai/shared").Project | null,
          status: "relinked",
        };
      }

      if (input.createIfMissing === false) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const project = await createProject(input.companyId, {
        name: declaration.displayName,
        description: declaration.description ?? null,
        status: declaration.status ?? "in_progress",
        color: declaration.color ?? undefined,
      });
      await db.insert(pluginManagedResources).values({
        companyId: input.companyId,
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        resourceKind: "project",
        resourceKey: input.projectKey,
        resourceId: project.id,
        defaultsJson: defaults,
      });
      const hydrated = await getProjectById(project.id);
      return {
        pluginKey: input.pluginKey,
        resourceKind: "project",
        resourceKey: input.projectKey,
        companyId: input.companyId,
        projectId: hydrated?.id ?? project.id,
        project: hydrated as import("@paperclipai/shared").Project | null,
        status: "created",
      };
    },

    create: createProject,

    update: async (
      id: string,
      data: Partial<typeof projects.$inferInsert> & { goalIds?: string[] },
    ): Promise<ProjectWithGoals | null> => {
      const { goalIds: inputGoalIds, ...projectData } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });
      const existingProject = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingProject) return null;

      if (projectData.name !== undefined) {
        const existingShortname = normalizeProjectUrlKey(existingProject.name);
        const nextShortname = normalizeProjectUrlKey(projectData.name);
        if (existingShortname !== nextShortname) {
          const existingProjects = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(eq(projects.companyId, existingProject.companyId));
          projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects, {
            excludeProjectId: id,
          });
        }
      }

      // Keep legacy goalId column in sync
      const updates: Partial<typeof projects.$inferInsert> = {
        ...projectData,
        updatedAt: new Date(),
      };
      if (ids !== undefined) {
        updates.goalId = ids.length > 0 ? ids[0] : null;
      }

      const row = await db
        .update(projects)
        .set(updates)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (ids !== undefined) {
        await syncGoalLinks(db, id, row.companyId, ids);
      }

      const [withGoals] = await attachGoals(db, [row]);
      const [enriched] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
      return enriched ?? null;
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: projects.id,
          executionWorkspacePolicy: projects.executionWorkspacePolicy,
        })
        .from(projects)
        .where(eq(projects.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const policy = parseProjectExecutionWorkspacePolicy(row.executionWorkspacePolicy);
        if (policy?.environmentId !== environmentId) continue;

        await db
          .update(projects)
          .set({
            executionWorkspacePolicy: {
              ...policy,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(projects.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => {
          const row = rows[0] ?? null;
          if (!row) return null;
          return { ...row, urlKey: deriveProjectUrlKey(row.name, row.id) };
        }),

    listWorkspaces: async (projectId: string): Promise<ProjectWorkspace[]> => {
      const rows = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
      if (rows.length === 0) return [];
      const runtimeServicesByWorkspaceId = await listCurrentRuntimeServicesForProjectWorkspaces(
        db,
        rows[0]!.companyId,
        rows.map((workspace) => workspace.id),
      );
      return rows.map((row) =>
        toWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    createWorkspace: async (
      projectId: string,
      data: CreateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) return null;

      const cwd = normalizeWorkspaceCwd(data.cwd);
      const repoUrl = readNonEmptyString(data.repoUrl);
      const sourceType = readNonEmptyString(data.sourceType) ?? (repoUrl ? "git_repo" : cwd ? "local_path" : "remote_managed");
      const remoteWorkspaceRef = readNonEmptyString(data.remoteWorkspaceRef);
      if (sourceType === "remote_managed") {
        if (!remoteWorkspaceRef && !repoUrl) return null;
      } else if (!cwd && !repoUrl) {
        return null;
      }
      const name = deriveWorkspaceName({
        name: data.name,
        cwd,
        repoUrl,
      });

      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(asc(projectWorkspaces.createdAt))
        .then((rows) => rows);

      const shouldBePrimary = data.isPrimary === true || existing.length === 0;
      const created = await db.transaction(async (tx) => {
        if (shouldBePrimary) {
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.companyId, project.companyId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
        }

        const row = await tx
          .insert(projectWorkspaces)
          .values({
            companyId: project.companyId,
            projectId,
            name,
            sourceType,
            cwd: cwd ?? null,
            repoUrl: repoUrl ?? null,
            repoRef: readNonEmptyString(data.repoRef),
            defaultRef: readNonEmptyString(data.defaultRef) ?? readNonEmptyString(data.repoRef),
            visibility: readNonEmptyString(data.visibility) ?? "default",
            setupCommand: readNonEmptyString(data.setupCommand),
            cleanupCommand: readNonEmptyString(data.cleanupCommand),
            remoteProvider: readNonEmptyString(data.remoteProvider),
            remoteWorkspaceRef,
            sharedWorkspaceKey: readNonEmptyString(data.sharedWorkspaceKey),
            metadata:
              data.runtimeConfig !== undefined
                ? mergeProjectWorkspaceRuntimeConfig(
                    (data.metadata as Record<string, unknown> | null | undefined) ?? null,
                    data.runtimeConfig ?? null,
                  )
                : (data.metadata as Record<string, unknown> | null | undefined) ?? null,
            isPrimary: shouldBePrimary,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        return row;
      });

      return created ? toWorkspace(created) : null;
    },

    updateWorkspace: async (
      projectId: string,
      workspaceId: string,
      data: UpdateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextCwd =
        data.cwd !== undefined
          ? normalizeWorkspaceCwd(data.cwd)
          : normalizeWorkspaceCwd(existing.cwd);
      const nextRepoUrl =
        data.repoUrl !== undefined
          ? readNonEmptyString(data.repoUrl)
          : readNonEmptyString(existing.repoUrl);
      const nextSourceType =
        data.sourceType !== undefined
          ? readNonEmptyString(data.sourceType)
          : readNonEmptyString(existing.sourceType);
      const nextRemoteWorkspaceRef =
        data.remoteWorkspaceRef !== undefined
          ? readNonEmptyString(data.remoteWorkspaceRef)
          : readNonEmptyString(existing.remoteWorkspaceRef);
      if (nextSourceType === "remote_managed") {
        if (!nextRemoteWorkspaceRef && !nextRepoUrl) return null;
      } else if (!nextCwd && !nextRepoUrl) {
        return null;
      }

      const patch: Partial<typeof projectWorkspaces.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) patch.name = deriveWorkspaceName({ name: data.name, cwd: nextCwd, repoUrl: nextRepoUrl });
      if (data.name === undefined && (data.cwd !== undefined || data.repoUrl !== undefined)) {
        patch.name = deriveWorkspaceName({ cwd: nextCwd, repoUrl: nextRepoUrl });
      }
      if (data.cwd !== undefined) patch.cwd = nextCwd ?? null;
      if (data.repoUrl !== undefined) patch.repoUrl = nextRepoUrl ?? null;
      if (data.repoRef !== undefined) patch.repoRef = readNonEmptyString(data.repoRef);
      if (data.sourceType !== undefined && nextSourceType) patch.sourceType = nextSourceType;
      if (data.defaultRef !== undefined) patch.defaultRef = readNonEmptyString(data.defaultRef);
      if (data.visibility !== undefined && readNonEmptyString(data.visibility)) {
        patch.visibility = readNonEmptyString(data.visibility)!;
      }
      if (data.setupCommand !== undefined) patch.setupCommand = readNonEmptyString(data.setupCommand);
      if (data.cleanupCommand !== undefined) patch.cleanupCommand = readNonEmptyString(data.cleanupCommand);
      if (data.remoteProvider !== undefined) patch.remoteProvider = readNonEmptyString(data.remoteProvider);
      if (data.remoteWorkspaceRef !== undefined) patch.remoteWorkspaceRef = nextRemoteWorkspaceRef;
      if (data.sharedWorkspaceKey !== undefined) patch.sharedWorkspaceKey = readNonEmptyString(data.sharedWorkspaceKey);
      if (data.metadata !== undefined || data.runtimeConfig !== undefined) {
        patch.metadata =
          data.runtimeConfig !== undefined
            ? mergeProjectWorkspaceRuntimeConfig(
                data.metadata !== undefined
                  ? (data.metadata as Record<string, unknown> | null | undefined)
                  : ((existing.metadata as Record<string, unknown> | null | undefined) ?? null),
                data.runtimeConfig ?? null,
              )
            : data.metadata;
      }

      const updated = await db.transaction(async (tx) => {
        if (data.isPrimary === true) {
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.companyId, existing.companyId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
          patch.isPrimary = true;
        } else if (data.isPrimary === false) {
          patch.isPrimary = false;
        }

        const row = await tx
          .update(projectWorkspaces)
          .set(patch)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (row.isPrimary) return row;

        const hasPrimary = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, row.companyId),
              eq(projectWorkspaces.projectId, row.projectId),
              eq(projectWorkspaces.isPrimary, true),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!hasPrimary) {
          const nextPrimaryCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, row.companyId),
                eq(projectWorkspaces.projectId, row.projectId),
                eq(projectWorkspaces.id, row.id),
              ),
            )
            .then((rows) => rows[0] ?? null);
          const alternateCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, row.companyId),
                eq(projectWorkspaces.projectId, row.projectId),
              ),
            )
            .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
            .then((rows) => rows.find((candidate) => candidate.id !== row.id) ?? null);

          await ensureSinglePrimaryWorkspace(tx, {
            companyId: row.companyId,
            projectId: row.projectId,
            keepWorkspaceId: alternateCandidate?.id ?? nextPrimaryCandidate?.id ?? row.id,
          });
          const refreshed = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, row.id))
            .then((rows) => rows[0] ?? row);
          return refreshed;
        }

        return row;
      });

      return updated ? toWorkspace(updated) : null;
    },

    removeWorkspace: async (projectId: string, workspaceId: string): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const removed = await db.transaction(async (tx) => {
        const row = await tx
          .delete(projectWorkspaces)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (!row.isPrimary) return row;

        const next = await tx
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, row.companyId),
              eq(projectWorkspaces.projectId, row.projectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (next) {
          await ensureSinglePrimaryWorkspace(tx, {
            companyId: row.companyId,
            projectId: row.projectId,
            keepWorkspaceId: next.id,
          });
        }

        return row;
      });

      return removed ? toWorkspace(removed) : null;
    },

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { project: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const row = await db
          .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
          .from(projects)
          .where(and(eq(projects.id, raw), eq(projects.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) return { project: null, ambiguous: false } as const;
        return {
          project: { id: row.id, companyId: row.companyId, urlKey: deriveProjectUrlKey(row.name, row.id) },
          ambiguous: false,
        } as const;
      }

      const urlKey = normalizeProjectUrlKey(raw);
      if (!urlKey) {
        return { project: null, ambiguous: false } as const;
      }

      const rows = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      const matches = rows.filter((row) => deriveProjectUrlKey(row.name, row.id) === urlKey);
      if (matches.length === 1) {
        const match = matches[0]!;
        return {
          project: { id: match.id, companyId: match.companyId, urlKey: deriveProjectUrlKey(match.name, match.id) },
          ambiguous: false,
        } as const;
      }
      if (matches.length > 1) {
        return { project: null, ambiguous: true } as const;
      }
      return { project: null, ambiguous: false } as const;
    },
  };
}
