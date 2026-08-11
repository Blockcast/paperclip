import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterRuntimeServiceReport } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issueComments, issues, projectWorkspaces, workspaceRuntimeServices } from "@paperclipai/db";
import {
  listWorkspaceServiceCommandDefinitions,
  type ExecutionWorkspaceRunScope,
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeBranchIncoherenceEvidence as SharedGitWorktreeBranchIncoherenceEvidence,
  type GitWorktreeInProgressOperation,
  type WorkspaceOperationPhase,
  type WorkspaceRuntimeDesiredState,
  type WorkspaceRuntimeServiceStateMap,
} from "@paperclipai/shared";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { asNumber, asString, parseObject, renderTemplate } from "../adapters/utils.js";
import { resolveHomeAwarePath, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import {
  createLocalServiceKey,
  findLocalServiceRegistryRecordByRuntimeServiceId,
  findAdoptableLocalService,
  isLocalServiceProcessInWorkspace,
  readLocalServiceProcessCwd,
  readLocalServicePortOwner,
  removeLocalServiceRegistryRecord,
  terminateLocalService,
  touchLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "./local-service-supervisor.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";
import {
  authorizeOwnedGitWorktreeCleanup,
  lockGitWorktreeForOwner,
  pruneOwnStaleGitWorktree,
} from "./git-worktree-ownership.js";
import { executionWorkspaceService, readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";

export function resolveShell(): string {
  const fallback = process.platform === "win32" ? "sh" : "/bin/sh";
  const shell = process.env.SHELL?.trim();
  if (!shell) return fallback;
  if (path.isAbsolute(shell) && !existsSync(shell)) return fallback;
  return shell;
}

export interface ExecutionWorkspaceInput {
  baseCwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
}

export interface ExecutionWorkspaceIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  workMode?: string | null;
}

export interface ExecutionWorkspaceAgentRef {
  id: string | null;
  name: string;
  companyId: string;
}

export interface RealizedExecutionWorkspace extends ExecutionWorkspaceInput {
  strategy: "project_primary" | "git_worktree";
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  warnings: string[];
  created: boolean;
  baseRefSha?: string | null;
  pendingForwardBranchReconcile?: PendingForwardBranchReconcile | null;
}

export class WorkspaceRuntimeValidationFailure extends Error {
  code = "workspace_validation_failed" as const;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceRuntimeValidationFailure";
    this.resultJson = resultJson;
  }
}

export interface RuntimeServiceRef {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  reused: boolean;
}

export class WorkspaceRepoMismatchError extends Error {
  code = "workspace_repo_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRepoMismatchError";
  }
}

export class WorkspaceGitSubmoduleError extends Error {
  code = "workspace_git_submodule_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGitSubmoduleError";
  }
}

interface RuntimeServiceRecord extends RuntimeServiceRef {
  db?: Db;
  child: ChildProcess | null;
  leaseRunIds: Set<string>;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  envFingerprint: string;
  serviceKey: string;
  profileKind: string;
  processGroupId: number | null;
}

type LocalRuntimeServiceStart = {
  record: RuntimeServiceRecord;
  readiness: Promise<void>;
};

type StoppedRuntimeServiceReuseCandidate = {
  id: string;
  port: number | null;
};

const runtimeServicesById = new Map<string, RuntimeServiceRecord>();
const runtimeServicesByReuseKey = new Map<string, string>();
const runtimeServiceLeasesByRun = new Map<string, string[]>();
const DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES = 256 * 1024;
/**
 * How long to keep draining stdio after the spawned command has already exited.
 *
 * `close` waits for every writer on the inherited pipes, so a descendant that
 * outlives the command can hold it open long after the command's own status is
 * known. Settling on a bound rather than on `close` keeps that from turning into
 * an unbounded wait. Healthy commands emit `close` within a tick of `exit`, so
 * this only elapses in the pathological case.
 */
const PROCESS_STDIO_DRAIN_GRACE_MS = 2_000;
const PROCESS_TIMEOUT_GROUP_LIVENESS_GRACE_MS = 750;
const PROCESS_TIMEOUT_GROUP_LIVENESS_POLL_MS = 25;
const WORKSPACE_SUBMODULE_REPAIR_TIMEOUT_MS = 5 * 60 * 1000;

// `git submodule status --recursive` is ~96% filesystem latency, not CPU: on the
// shared pim-multicast-gateway checkout only ~50ms of a 1160ms run is git work,
// the rest is metadata round-trips across 9 sequential submodule--helper walks on
// CephFS. Measured on that workspace (BLO-18784): warm p50 1163ms / p99 1356ms
// (n=20), cold worst case 5903ms (5.1x), and 2.3x further amplification under
// induced metadata load. 60s = 44x warm p99 = 10.2x cold worst case, and clears
// the composed cold-x-load amplification (~13.6s) by 4.4x.
//
// The budget is deliberately a backstop, NOT the safety mechanism. Because the
// cost tracks an unbounded-variance quantity, no constant makes a single attempt
// safe -- that is what the retry + non-fatal degrade below are for.
const WORKSPACE_SUBMODULE_INSPECT_TIMEOUT_MS = 60_000;
const WORKSPACE_SUBMODULE_INSPECT_ATTEMPTS = 3;
const WORKSPACE_SUBMODULE_INSPECT_RETRY_DELAY_MS = 1_000;

// Upper bounds for the env overrides below. Deliberately *operational* limits
// rather than Node's `2^31 - 1` timer ceiling: clamping an oversized timeout to
// the ceiling would mean ~24.8 days, which does not bound the preflight at all
// -- it just trades fail-open for hang-forever. These keep the worst case an
// operator can configure bounded at 5 x 300s + backoff ~= 30 minutes, while
// staying far enough below the timer ceiling that no product of them can
// overflow it.
//
// 300s is 50x the measured cold worst case (5903ms) and matches
// `WORKSPACE_SUBMODULE_REPAIR_TIMEOUT_MS`. Past 5 attempts a checkout is broken,
// not slow -- that is the deterministic-failure path, which throws.
const WORKSPACE_SUBMODULE_INSPECT_MAX_TIMEOUT_MS = 300_000;
const WORKSPACE_SUBMODULE_INSPECT_MAX_ATTEMPTS = 5;
const WORKSPACE_SUBMODULE_INSPECT_MAX_RETRY_DELAY_MS = 30_000;

// Lower bound on the *timeout* override specifically. An oversized value and an
// undersized one fail open identically -- every probe times out, so every
// workspace takes the degrade path and the check stops running fleet-wide -- but
// only the oversized end was guarded. A seconds-vs-milliseconds slip
// (`...TIMEOUT_MS=60`, meaning the documented 60s) is the likeliest way to reach
// that state, and it is indistinguishable from a deliberate tightening without a
// floor.
//
// 15s is the smallest floor that keeps the floor itself outside the hazard it
// exists to exclude. The bound has to be a budget under which a *healthy*
// checkout still completes, and the slowest healthy inspection measured on the
// shared CephFS tree is the composed cold-x-load case, ~13.6s (5.1x cold cache
// x 2.3x induced metadata load, see above) -- so anything at or below that lets
// an operator sit exactly at the minimum and still degrade every cold first
// touch, which is the fail-open this floor is for. 15s clears it, and is 2.5x
// the cold worst case (5903ms) and 11x warm p99 (1356ms).
//
// It is deliberately not tighter. A floor between warm p99 and the cold worst
// case would look like it permits tightening during an incident, but the values
// it permits are exactly the ones that stop the check from running.
//
// No floor on `attempts` or `retryDelayMs`: the minimum each can reach is 1, and
// neither disables the check. `attempts=1` is a coherent "do not retry" choice
// (the pre-BLO-18784 behaviour), and a 1ms backoff only retries sooner.
const WORKSPACE_SUBMODULE_INSPECT_MIN_TIMEOUT_MS = 15_000;

/**
 * Env overrides for the submodule-inspection budget. Read at call time so they
 * can be tuned on a running server without a deploy.
 *
 * Out-of-range values fall back to the default rather than clamping to the
 * nearest bound: a value outside the operational range is a typo, and silently
 * honouring "some other number than the one you typed" is the same class of
 * surprise as the two truncation bugs called out below.
 */
function readBoundedIntEnv(
  name: string,
  fallback: number,
  bounds: { min?: number; max: number },
): number {
  const { min = 1, max } = bounds;
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Require an exact positive integer rather than truncating. A fractional value
  // like "0.5" satisfies a bare `> 0` check and then truncates to 0, which does
  // not fall back -- it disables `executeProcess`'s timeout (0 is not `> 0`
  // there) or skips the retry loop entirely. Both fail open silently, which is
  // the opposite of what an operator tuning this value would expect.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  // Reject undersized values: a budget too small to ever complete makes every
  // probe time out and takes the degrade path on a healthy checkout, which is
  // the same fail-open as the oversized case below reached from the other end.
  if (parsed < min) return fallback;
  // Reject oversized values for the same reason. Every one of these settings
  // feeds a `setTimeout`, and Node clamps any delay above `2^31 - 1` ms to *1ms*
  // with a `TimeoutOverflowWarning`. So a plausible-looking large override (an
  // extra digit, or seconds/ms confusion) would make every probe time out
  // immediately and take the fail-open degradation path on a healthy checkout.
  if (parsed > max) return fallback;
  return parsed;
}

type SubmoduleInspectSettings = { timeoutMs: number; attempts: number; retryDelayMs: number };

let submoduleInspectSettingsOverrideForTests: Partial<SubmoduleInspectSettings> | null = null;
let processGroupLivenessProbeForTests: ((processGroupId: number) => boolean) | null = null;

/**
 * Test-only seam for the inspection budget. Tests need a timeout small enough to
 * guarantee a stall, which is deliberately below what the env override accepts
 * (see `WORKSPACE_SUBMODULE_INSPECT_MIN_TIMEOUT_MS`) -- so forcing a timeout must
 * not go through the operator-facing path. Same convention as
 * `resetRuntimeServicesForTests`: not reachable from configuration, which is the
 * whole point of keeping it separate from the env overrides. Pass `null` to clear.
 */
export function setSubmoduleInspectSettingsForTests(override: Partial<SubmoduleInspectSettings> | null) {
  submoduleInspectSettingsOverrideForTests = override;
}

export function setProcessGroupLivenessProbeForTests(override: ((processGroupId: number) => boolean) | null) {
  processGroupLivenessProbeForTests = override;
}

function readSubmoduleInspectSettings(): SubmoduleInspectSettings {
  return {
    timeoutMs: readBoundedIntEnv(
      "PAPERCLIP_WORKSPACE_SUBMODULE_INSPECT_TIMEOUT_MS",
      WORKSPACE_SUBMODULE_INSPECT_TIMEOUT_MS,
      {
        min: WORKSPACE_SUBMODULE_INSPECT_MIN_TIMEOUT_MS,
        max: WORKSPACE_SUBMODULE_INSPECT_MAX_TIMEOUT_MS,
      },
    ),
    attempts: readBoundedIntEnv(
      "PAPERCLIP_WORKSPACE_SUBMODULE_INSPECT_ATTEMPTS",
      WORKSPACE_SUBMODULE_INSPECT_ATTEMPTS,
      { max: WORKSPACE_SUBMODULE_INSPECT_MAX_ATTEMPTS },
    ),
    retryDelayMs: readBoundedIntEnv(
      "PAPERCLIP_WORKSPACE_SUBMODULE_INSPECT_RETRY_DELAY_MS",
      WORKSPACE_SUBMODULE_INSPECT_RETRY_DELAY_MS,
      { max: WORKSPACE_SUBMODULE_INSPECT_MAX_RETRY_DELAY_MS },
    ),
    ...(submoduleInspectSettingsOverrideForTests ?? {}),
  };
}

type ProcessOutputCapture = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

type ProcessOutputAccumulator = {
  append(chunk: string): void;
  finish(): ProcessOutputCapture;
};

export async function resetRuntimeServicesForTests() {
  for (const record of runtimeServicesById.values()) {
    clearIdleTimer(record);
  }
  runtimeServicesById.clear();
  runtimeServicesByReuseKey.clear();
  runtimeServiceLeasesByRun.clear();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type WorkspaceLinkMismatch = {
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function findWorkspaceRoot(startCwd: string) {
  let current = path.resolve(startCwd);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isLinkedGitWorktreeCheckout(rootDir: string) {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    if (!existsSync(dirPath)) return;

    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

function findServerWorkspaceLinkMismatches(rootDir: string): WorkspaceLinkMismatch[] {
  const serverPackageJsonPath = path.join(rootDir, "server", "package.json");
  if (!existsSync(serverPackageJsonPath)) return [];

  const serverPackageJson = readJsonFile(serverPackageJsonPath);
  const dependencies = {
    ...(serverPackageJson.dependencies as Record<string, unknown> | undefined),
    ...(serverPackageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const workspacePackagePaths = discoverWorkspacePackagePaths(rootDir);
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;
    const normalizedExpectedPath = existsSync(expectedPath) ? path.resolve(realpathSync(expectedPath)) : path.resolve(expectedPath);

    const linkPath = path.join(rootDir, "server", "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === normalizedExpectedPath) continue;

    mismatches.push({
      packageName,
      expectedPath: normalizedExpectedPath,
      actualPath,
    });
  }

  return mismatches;
}

export async function ensureServerWorkspaceLinksCurrent(
  startCwd: string,
  opts?: {
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) {
  const workspaceRoot = findWorkspaceRoot(startCwd);
  if (!workspaceRoot) return;
  if (!isLinkedGitWorktreeCheckout(workspaceRoot)) return;

  const mismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (mismatches.length === 0) return;

  if (opts?.onLog) {
    await opts.onLog("stdout", "[runtime] detected stale workspace package links for server; relinking dependencies...\n");
    for (const mismatch of mismatches) {
      await opts.onLog(
        "stdout",
        `[runtime]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}\n`,
      );
    }
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(workspaceRoot, "server", "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all server package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}

function stableRuntimeServiceId(input: {
  adapterType: string;
  runId: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
  serviceName: string;
  reportId: string | null;
  providerRef: string | null;
  reuseKey: string | null;
}) {
  if (input.reportId) return input.reportId;
  const digest = createHash("sha256")
    .update(
      stableStringify({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        serviceName: input.serviceName,
        providerRef: input.providerRef,
        reuseKey: input.reuseKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.adapterType}-${digest}`;
}

function toRuntimeServiceRef(record: RuntimeServiceRecord, overrides?: Partial<RuntimeServiceRef>): RuntimeServiceRef {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: record.lastUsedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    reused: record.reused,
    ...overrides,
  };
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function renderWorkspaceTemplate(template: string, input: {
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  projectId: string | null;
  repoRef: string | null;
}) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "paperclip-work";
}

/**
 * Option (A) (BLO-9117): ensure the issue identifier is present in the branch
 * name so a merged PR ref-links at merge time (the github-webhook forward-capture
 * keys on the `BLO-` ref in the branch). The default branchTemplate already
 * carries `{{issue.identifier}}`; this guarantees it even when a custom template
 * omits it, by prepending the identifier when it's absent.
 *
 * sanitizeBranchName preserves case, so the uppercase `BLO-####` form the
 * (uppercase-only) webhook extractor requires survives. A unit test asserts the
 * result is extractor-matchable, locking this guarantee against a future
 * sanitizer that lowercases.
 */
export function applyIssueIdentifierToBranchName(
  renderedBranch: string,
  issueIdentifier: string | null | undefined,
): string {
  const base = sanitizeBranchName(renderedBranch);
  if (!issueIdentifier) return base;
  const sanitizedIdentifier = sanitizeBranchName(issueIdentifier);
  if (!sanitizedIdentifier || base.includes(sanitizedIdentifier)) return base;
  return sanitizeBranchName(`${sanitizedIdentifier}-${renderedBranch}`);
}

function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

/** Width of the hex run token appended to per-run branch names. */
const RUN_SCOPE_TOKEN_LENGTH = 8;
/** Keep the composed name inside sanitizeBranchName's 120-char ceiling. */
const BRANCH_NAME_MAX_LENGTH = 120;

/**
 * BLO-19063: derive a run-scoped branch name so that two concurrent runs never
 * share a working tree.
 *
 * Worktrees are keyed by branch name (`worktreePath = join(parentDir, branch)`),
 * so making the branch run-unique makes the *path* run-unique for free. It also
 * keeps `git worktree add` legal: git refuses to check the same branch out
 * twice, so a per-run tree genuinely requires a per-run branch, not just a
 * per-run directory.
 *
 * The issue identifier is preserved verbatim in the result, so the BLO-9117
 * ref-linking guarantee (see applyIssueIdentifierToBranchName) still holds — the
 * token is appended, never substituted. Returns `branchName` unchanged for
 * `per_issue` scope or when no run id is available, which is what keeps this
 * opt-in rather than a fleet-wide migration.
 */
export function applyRunScopeToBranchName(
  branchName: string,
  runScope: ExecutionWorkspaceRunScope | null | undefined,
  heartbeatRunId: string | null | undefined,
): string {
  if (runScope !== "per_run") return branchName;
  // Derive the token from the raw run id rather than via sanitizeBranchName:
  // that helper substitutes a literal "paperclip-work" for empty input, which
  // would turn every run *without* a run id into the same token ("papercli")
  // and silently collapse them back onto one shared tree while still looking
  // per-run. A missing id must degrade to the issue-scoped name loudly, not to
  // a colliding one quietly.
  const token = (heartbeatRunId ?? "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, RUN_SCOPE_TOKEN_LENGTH)
    .toLowerCase();
  // No usable run id (e.g. a non-heartbeat realize path): fall back to the
  // issue-scoped name rather than inventing a token, which would strand a tree
  // nothing can find again.
  if (!token) return branchName;
  const suffix = `-r${token}`;
  const base = branchName.slice(0, BRANCH_NAME_MAX_LENGTH - suffix.length);
  return sanitizeBranchName(`${base}${suffix}`);
}

function resolveExecutionWorkspaceRunScope(raw: unknown): ExecutionWorkspaceRunScope {
  return asString(raw, "") === "per_run" ? "per_run" : "per_issue";
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

function formatCommandForDisplay(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function trimToLastBytes(value: string, limit: number) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= limit) return value;
  return Buffer.from(value, "utf8").subarray(byteLength - limit).toString("utf8");
}

function createProcessOutputCapture(maxBytes: number): ProcessOutputAccumulator {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let text = "";
  let truncated = false;
  let totalBytes = 0;

  return {
    append(chunk: string) {
      if (!chunk) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");

      const combined = text + chunk;
      if (Buffer.byteLength(combined, "utf8") <= limit) {
        text = combined;
        return;
      }

      text = trimToLastBytes(combined, limit);
      truncated = true;
    },
    finish(): ProcessOutputCapture {
      if (!truncated) {
        return {
          text,
          truncated: false,
          totalBytes,
        };
      }
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${text}`,
        truncated: true,
        totalBytes,
      };
    },
  };
}

/**
 * `process.kill(-pgid, 0)` cannot distinguish a running process group from a
 * group leader that has exited but not yet been reaped by its parent: the
 * kernel keeps a zombie's PID reserved until `wait()` is called, so signal 0
 * still succeeds against it. That makes an unreaped-zombie leader read as
 * "alive". Accepted as a documented false *degrade* (a live tree misreported
 * as gone would be the dangerous direction; this is the safe one) rather than
 * corrected -- the alternative is parsing `/proc/<pid>/stat` for state `Z`,
 * which is Linux-only and buys a nuisance fix on the safe side of the
 * failure. See the `isProcessGroupAlive` test coverage for the documented
 * behaviour.
 */
function isProcessGroupAlive(processGroupId: number): boolean {
  if (process.platform === "win32") return false;
  if (processGroupLivenessProbeForTests) return processGroupLivenessProbeForTests(processGroupId);
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExitAfterKill(child: ChildProcess): Promise<boolean> {
  if (!child.pid || process.platform === "win32") return false;
  const processGroupId = child.pid;
  const deadline = Date.now() + PROCESS_TIMEOUT_GROUP_LIVENESS_GRACE_MS;

  while (isProcessGroupAlive(processGroupId)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return true;
    await delay(Math.min(PROCESS_TIMEOUT_GROUP_LIVENESS_POLL_MS, remainingMs));
  }

  return false;
}

async function executeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  processGroupAliveAfterTimeout: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}> {
  const proc = await new Promise<{
    stdout: ProcessOutputAccumulator;
    stderr: ProcessOutputAccumulator;
    code: number | null;
    timedOut: boolean;
    processGroupAliveAfterTimeout: boolean;
  }>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let killTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let drainTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const stdout = createProcessOutputCapture(input.maxStdoutBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    const stderr = createProcessOutputCapture(input.maxStderrBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    const onStdoutData = (chunk: Buffer | string) => {
      stdout.append(String(chunk));
    };
    const onStderrData = (chunk: Buffer | string) => {
      stderr.append(String(chunk));
    };
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
      // Lead a process group so a timeout can reap the whole tree. `git
      // submodule status --recursive` forks per submodule; signalling only the
      // command we spawned leaves those children running against the same
      // checkout -- still doing IO we have given up waiting for, and still
      // holding the stdio pipes that `close` waits on. Platform-guarded to match
      // the runtime-service spawn: on Windows `detached` means a new console,
      // not a process group, and `terminateChildProcess` falls back there anyway.
      detached: process.platform !== "win32",
    });

    const clearTimers = () => {
      if (timeoutTimer) globalThis.clearTimeout(timeoutTimer);
      if (killTimer) globalThis.clearTimeout(killTimer);
      if (drainTimer) globalThis.clearTimeout(drainTimer);
      timeoutTimer = null;
      killTimer = null;
      drainTimer = null;
    };
    /**
     * Finish the SIGTERM -> SIGKILL escalation now instead of leaving it on the
     * clock.
     *
     * A timed-out call must not hand control back while the group-wide SIGKILL is
     * still only *scheduled*: the caller retries after a backoff shorter than the
     * remaining kill grace, so a descendant that ignored SIGTERM would still be
     * walking the same checkout when attempt N+1 spawns against it -- overlapping
     * git trees and extra metadata load during exactly the stall this is meant to
     * contain. Escalating here keeps "settled as timed out" coupled to "the tree
     * has been killed".
     *
     * SIGKILL is followed by a bounded liveness check rather than an unbounded
     * wait. A process wedged in uninterruptible IO on a stalled mount dies only
     * once that IO returns; if the group is still alive after the bound, callers
     * must treat the timeout as unresolved and avoid starting another tree
     * against the same checkout.
     */
    const escalateTermination = async () => {
      if (killTimer) {
        globalThis.clearTimeout(killTimer);
        killTimer = null;
      }
      terminateChildProcess(child, "SIGKILL");
      return await waitForProcessGroupExitAfterKill(child);
    };
    const cleanupCapturedStreams = (destroy: boolean) => {
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      if (destroy) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    };
    const settle = (code: number | null, options?: { destroyStreams?: boolean }) => {
      if (settled) return;
      settled = true;
      cleanupCapturedStreams(options?.destroyStreams ?? false);
      void (async () => {
        const processGroupAliveAfterTimeout = timedOut ? await escalateTermination() : false;
        clearTimers();
        resolve({ stdout, stderr, code, timedOut, processGroupAliveAfterTimeout });
      })();
    };

    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.trunc(input.timeoutMs)
        : null;
    if (timeoutMs) {
      timeoutTimer = globalThis.setTimeout(() => {
        timedOut = true;
        terminateChildProcess(child, "SIGTERM");
        // Settle from *this* timer, not from the SIGTERM callback above: a
        // child wedged in uninterruptible I/O (D state) never delivers
        // SIGKILL, so it emits neither `exit` nor `close`, and without this
        // the wall-clock budget stops being enforced the moment SIGKILL is
        // merely scheduled -- the exact stranding BLO-18784 removed, reached
        // by a different route (BLO-20047). Settling here instead of inline
        // on SIGTERM preserves the 5s grace for a child that honours it.
        // `settle` already escalates to SIGKILL + a bounded liveness wait
        // when `timedOut`, so the redundant kill below is harmless.
        // Must hold the event loop open to fire even with nothing else
        // pending -- do not `.unref()` it.
        killTimer = globalThis.setTimeout(() => {
          killTimer = null;
          terminateChildProcess(child, "SIGKILL");
          settle(null, { destroyStreams: true });
        }, 5_000);
      }, timeoutMs);
    }
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanupCapturedStreams(true);
      void (async () => {
        await (timedOut ? escalateTermination() : Promise.resolve(false));
        clearTimers();
        reject(error);
      })();
    });
    // `exit` fires when the command itself terminates; `close` additionally
    // waits for every writer on the inherited pipes, which can include
    // descendants that outlive it. Stopping the budget here is what keeps the
    // two apart: once the command has exited, its status is definitive, so a
    // descendant holding a pipe open must not be allowed to let the timer fire
    // and relabel a deterministic failure (e.g. git's exit 128) as a timeout.
    child.on("exit", (code) => {
      // `error` can settle (and reject) without an `exit`, but the reverse
      // ordering is possible too; arming the drain after we have settled would
      // leave a timer nothing clears, holding the event loop open for its full
      // grace period to call a no-op.
      if (settled) return;
      if (timeoutTimer) globalThis.clearTimeout(timeoutTimer);
      timeoutTimer = null;
      // No kill-timer bookkeeping here: `killTimer` only exists once `timedOut`
      // is set, and `settle` owns finishing that escalation.
      // Bound the wait for the remaining stdio. Without this a lingering
      // descendant means `close` never arrives and the promise never settles --
      // the timeout budget stops being enforced at all, which is a worse
      // failure than the one it was meant to catch.
      drainTimer ??= globalThis.setTimeout(
        () => settle(code, { destroyStreams: true }),
        PROCESS_STDIO_DRAIN_GRACE_MS,
      );
    });
    child.on("close", (code) => {
      settle(code);
    });
  });
  const stdout = proc.stdout.finish();
  const stderr = proc.stderr.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: proc.code,
    timedOut: proc.timedOut,
    processGroupAliveAfterTimeout: proc.processGroupAliveAfterTimeout,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
  };
}

/**
 * Test seam for `executeProcess`.
 *
 * The exit-vs-close distinction it now draws is only observable here: proving it
 * needs a command that returns a definitive status while a descendant still
 * holds the inherited pipes, which no real `git` invocation can be made to do on
 * demand. Not reachable from configuration, same rationale as
 * `setSubmoduleInspectSettingsForTests`.
 */
export const executeProcessForTests = executeProcess;

/**
 * Test seam for `isProcessGroupAlive`. Every other test drives the
 * `setProcessGroupLivenessProbeForTests` override, which proves the policy
 * built on top of this function but never exercises the primitive itself --
 * see its doc comment for the accepted zombie-leader false positive this is
 * meant to cover.
 */
export const isProcessGroupAliveForTests = isProcessGroupAlive;

/**
 * Raised when a git subprocess exceeded its wall-clock budget. Distinguished from
 * a non-zero exit so callers can retry a transient stall without also retrying a
 * deterministic failure (e.g. "not a git repository"). The message is unchanged
 * from the historical string so existing `gitErrorIncludes` matching still works.
 */
class GitCommandTimeoutError extends Error {
  /**
   * Whatever the command had already written to stdout before it was killed,
   * raw and untrimmed.
   *
   * Kept because a stalled command can still have emitted *conclusive* output:
   * `git submodule status --recursive` flushes each entry as it walks, so it can
   * print a definitive `U`/`-` record for one submodule and then stall on a
   * later one. Discarding this would throw away evidence the probe already
   * produced and let a known-broken checkout through the degrade path.
   *
   * Two properties callers must respect (both measured against a real
   * multi-submodule checkout, see BLO-18784):
   * - The captured text can be unreliable at *both* ends: a stream killed
   *   mid-write ends in a partial line, and a byte-capped stream keeps only the
   *   last N bytes (so it is chopped at its head and carries a truncation
   *   banner). `salvageGitSubmoduleFaults` handles both.
   * - Absence of a fault record here is NOT evidence of health: an early kill
   *   or buffering can yield zero bytes for a checkout that is in fact broken.
   *   Presence may be acted on; absence must still degrade.
   */
  readonly stdout: string;
  readonly stdoutEndsWithNewline: boolean;
  readonly processGroupAliveAfterTimeout: boolean;

  constructor(message: string, partial?: { stdout: string; processGroupAliveAfterTimeout?: boolean }) {
    super(message);
    this.name = "GitCommandTimeoutError";
    this.stdout = partial?.stdout ?? "";
    this.stdoutEndsWithNewline = this.stdout.endsWith("\n");
    this.processGroupAliveAfterTimeout = partial?.processGroupAliveAfterTimeout ?? false;
  }
}

/**
 * `git submodule status` line shape: a status character, the full object id,
 * then the path. Anchored deliberately -- it is the guard that makes salvaging a
 * *partial* stream safe, because neither a head-chopped fragment (which has lost
 * its status character and part of its object id) nor the capture layer's
 * `[output truncated ...]` banner can match it. Only `-` (uninitialized) and `U`
 * (conflicted) are of interest; ` ` and `+` are healthy states.
 */
const GIT_SUBMODULE_FAULT_LINE = /^[-U][0-9a-f]{40,64} \S/;

/**
 * Recover submodule faults a stalled probe had already reported.
 *
 * Safe in one direction only: a fault found here is real (git printed it), so it
 * may be acted on, but finding none is NOT evidence of health -- see
 * `GitCommandTimeoutError.stdout`.
 */
function salvageGitSubmoduleFaults(error: GitCommandTimeoutError): GitSubmoduleReadinessEntry[] {
  if (!error.stdout) return [];
  const lines = error.stdout.split("\n");
  // A stream killed mid-write ends in a partial line. That fragment can still
  // match the shape above while carrying a *truncated path*, which would name
  // the wrong submodule, so drop it outright rather than filtering it.
  if (!error.stdoutEndsWithNewline) lines.pop();
  return parseGitSubmoduleReadiness(lines.filter((line) => GIT_SUBMODULE_FAULT_LINE.test(line)).join("\n"));
}

async function runGit(
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number } = {},
): Promise<string> {
  const proc = await executeProcess({
    command: "git",
    args,
    cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
  });
  // Timeout first, and only sound because `executeProcess` stops the budget the
  // moment git itself exits: `timedOut` therefore means the timer fired while
  // git was still running, never that a descendant held the pipes open past a
  // status git had already returned. Without that invariant this ordering would
  // relabel a deterministic exit 128 as a retryable stall and let a broken
  // checkout through the degrade path.
  if (proc.timedOut) {
    throw new GitCommandTimeoutError(`git ${args.join(" ")} timed out after ${options.timeoutMs}ms`, {
      stdout: proc.stdout,
      processGroupAliveAfterTimeout: proc.processGroupAliveAfterTimeout,
    });
  }
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

function formatShortSha(value: string | null | undefined) {
  return value ? value.slice(0, 12) : "unknown";
}

function gitErrorIncludes(error: unknown, needle: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

function parseRemoteTrackingRef(ref: string): { remote: string; branch: string } | null {
  const trimmed = ref.trim();
  const refsRemotesPrefix = "refs/remotes/";
  const normalized = trimmed.startsWith(refsRemotesPrefix)
    ? trimmed.slice(refsRemotesPrefix.length)
    : trimmed;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) return null;
  const remote = normalized.slice(0, slashIndex);
  const branch = normalized.slice(slashIndex + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;
  return { remote, branch };
}

async function refreshRemoteTrackingBaseRef(repoRoot: string, baseRef: string): Promise<string[]> {
  const remoteTracking = parseRemoteTrackingRef(baseRef);
  if (!remoteTracking) return [];

  const remoteExists = await runGit(["remote", "get-url", remoteTracking.remote], repoRoot)
    .then(() => true)
    .catch(() => false);
  if (!remoteExists) return [];

  try {
    await runGit([
      "fetch",
      "--prune",
      remoteTracking.remote,
      `+refs/heads/${remoteTracking.branch}:refs/remotes/${remoteTracking.remote}/${remoteTracking.branch}`,
    ], repoRoot);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Could not refresh base ref ${baseRef} before preparing the execution workspace: ${message}`];
  }
}

async function resolveBaseRefSha(repoRoot: string, baseRef: string): Promise<string | null> {
  return await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot).catch(() => null);
}

function readRecordedBaseRefSha(metadata: Record<string, unknown> | null | undefined): string | null {
  const snapshot = parseObject(metadata?.baseRefSnapshot);
  const resolvedSha = snapshot.resolvedSha;
  return typeof resolvedSha === "string" && resolvedSha.trim().length > 0 ? resolvedSha.trim() : null;
}

export async function inspectExecutionWorkspaceBaseDrift(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string | null;
  recordedBaseRefSha?: string | null;
  skipRefresh?: boolean;
}): Promise<{
  warnings: string[];
  currentBaseRefSha: string | null;
  branchBaseRefSha: string | null;
}> {
  const baseRef = input.baseRef?.trim();
  if (!baseRef) {
    return { warnings: [], currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const warnings = input.skipRefresh ? [] : await refreshRemoteTrackingBaseRef(input.repoRoot, baseRef);
  const currentBaseRefSha = await resolveBaseRefSha(input.repoRoot, baseRef);
  if (!currentBaseRefSha) {
    warnings.push(`Could not resolve base ref ${baseRef} while checking execution workspace freshness.`);
    return { warnings, currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const branchBaseRefSha = await runGit(["merge-base", "HEAD", baseRef], input.worktreePath).catch(() => null);
  if (!branchBaseRefSha) {
    warnings.push(`Could not compare execution workspace ${input.branchName ?? "branch"} against base ref ${baseRef}.`);
    return { warnings, currentBaseRefSha, branchBaseRefSha: null };
  }

  if (branchBaseRefSha !== currentBaseRefSha) {
    const behindCountRaw = await runGit(["rev-list", "--count", `HEAD..${baseRef}`], input.worktreePath).catch(() => "");
    const behindCount = Number.parseInt(behindCountRaw, 10);
    const behindText = Number.isFinite(behindCount) && behindCount > 0
      ? `${behindCount} commit${behindCount === 1 ? "" : "s"}`
      : "newer commits";
    const recordedText = input.recordedBaseRefSha
      ? `recorded base ${formatShortSha(input.recordedBaseRefSha)}`
      : `merge-base ${formatShortSha(branchBaseRefSha)}`;
    warnings.push(
      `Execution workspace branch ${input.branchName ? `"${input.branchName}"` : "HEAD"} is behind ${baseRef} by ${behindText}: ${recordedText}, current base ${formatShortSha(currentBaseRefSha)}. Refresh or rebase the workspace before relying on recent base-branch fixes.`,
    );
  }

  return { warnings, currentBaseRefSha, branchBaseRefSha };
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)
    .then(() => true)
    .catch(() => false);
}

async function remoteExists(repoRoot: string, remote: string): Promise<boolean> {
  return runGit(["remote", "get-url", remote], repoRoot)
    .then(() => true)
    .catch(() => false);
}

const GIT_WORKTREE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

type GitWorktreeCleanliness = SharedGitWorktreeBranchIncoherenceEvidence["cleanliness"];

type GitWorktreeBranchIncoherenceEvidence = SharedGitWorktreeBranchIncoherenceEvidence;

type GitWorktreeBranchContention = NonNullable<GitWorktreeBranchIncoherenceEvidence["contention"]>;

type GitWorktreeBranchCoherenceResult = {
  branchName: string | null;
  reconciledForward: boolean;
  pendingForwardBranchReconcile?: PendingForwardBranchReconcile | null;
  dirtyQuarantineRepair?: DirtyQuarantineRepairResult | null;
  warnings: string[];
};

type DirtyQuarantineRepairResult = {
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  clearedInProgressOperation: GitWorktreeInProgressOperation | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
};

export type PendingForwardBranchReconcile = {
  recordedBranchName: string;
  adoptedBranchName: string;
  prePersistenceFingerprint: string;
  reason: string;
};

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

const GIT_IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{
  operation: GitWorktreeInProgressOperation;
  marker: string;
}> = [
  { operation: "rebase", marker: "rebase-merge" },
  { operation: "rebase", marker: "rebase-apply" },
  { operation: "merge", marker: "MERGE_HEAD" },
  { operation: "cherry_pick", marker: "CHERRY_PICK_HEAD" },
  { operation: "revert", marker: "REVERT_HEAD" },
  { operation: "bisect", marker: "BISECT_LOG" },
];

const GIT_IN_PROGRESS_OPERATION_LABELS: Record<GitWorktreeInProgressOperation, string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

// `--quit` clears the interrupted operation's state directory without touching
// the working tree or moving HEAD, unlike `--abort` which resets both.
const GIT_IN_PROGRESS_OPERATION_QUIT_ARGS: Record<GitWorktreeInProgressOperation, string[]> = {
  rebase: ["rebase", "--quit"],
  merge: ["merge", "--quit"],
  cherry_pick: ["cherry-pick", "--quit"],
  revert: ["revert", "--quit"],
  bisect: ["bisect", "reset", "HEAD"],
};

async function detectGitWorktreeInProgressOperation(
  worktreePath: string,
): Promise<GitWorktreeInProgressOperation | null> {
  for (const { operation, marker } of GIT_IN_PROGRESS_OPERATION_MARKERS) {
    const markerPath = await runGit(["rev-parse", "--git-path", marker], worktreePath).catch(() => null);
    if (!markerPath) continue;
    if (existsSync(path.resolve(worktreePath, markerPath))) return operation;
  }
  return null;
}

const DIRTY_PATH_SAMPLE_LIMIT = 5;

function parseGitPorcelainPath(line: string) {
  const raw = line.trimEnd();
  if (raw.trim().length <= 3) return raw.trim();
  if (raw[1] === " " && raw[2] !== " ") return raw.slice(2).trim();
  return raw.slice(3).trim();
}

function sampleDirtyStatusPaths(statusLines: string[] | null) {
  return (statusLines ?? [])
    .map(parseGitPorcelainPath)
    .filter((value) => value.length > 0)
    .slice(0, DIRTY_PATH_SAMPLE_LIMIT);
}

function formatUtcBranchTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDirtyQuarantineRescueBranch(sourceIssue: ExecutionWorkspaceIssueRef | null) {
  const issueComponent = sanitizeBranchName(sourceIssue?.identifier ?? sourceIssue?.id ?? "issue");
  return sanitizeBranchName(`paperclip/rescue/${issueComponent}/${formatUtcBranchTimestamp()}`);
}

function formatIssueReference(issueId: string | null | undefined, identifier: string | null | undefined) {
  if (!identifier) return issueId ? `\`${issueId}\`` : "`unknown`";
  const match = identifier.match(/^([A-Z]+)-\d+$/);
  if (!match) return `\`${identifier}\``;
  return `[${identifier}](/${match[1]}/issues/${identifier})`;
}

async function readIssueCompanyId(db: Db, issueId: string | null | undefined): Promise<string | null> {
  if (!issueId) return null;
  return db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0]?.companyId ?? null);
}

async function findGitWorktreeBranchContention(input: {
  db: Db | null | undefined;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  actualBranchName: string | null;
}): Promise<GitWorktreeBranchContention | null> {
  if (!input.db) return null;
  const companyId = await readIssueCompanyId(input.db, input.sourceIssue?.id);
  if (!companyId) return null;
  return executionWorkspaceService(input.db).findGitWorktreeContention({
    companyId,
    worktreePath: input.worktreePath,
    liveBranchName: input.actualBranchName,
    excludingExecutionWorkspaceId: input.executionWorkspaceId,
  });
}

function executionWorkspaceUsesInheritedProjectRuntimeServices(
  row: typeof executionWorkspaces.$inferSelect,
) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

async function findActiveRuntimeServiceBlockingDirtyQuarantine(input: {
  db: Db;
  workspace: typeof executionWorkspaces.$inferSelect;
}) {
  const inheritedProjectWorkspaceId = executionWorkspaceUsesInheritedProjectRuntimeServices(input.workspace)
    ? input.workspace.projectWorkspaceId
    : null;
  const serviceScopeCondition = inheritedProjectWorkspaceId
    ? and(
        eq(workspaceRuntimeServices.companyId, input.workspace.companyId),
        eq(workspaceRuntimeServices.projectWorkspaceId, inheritedProjectWorkspaceId),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      )
    : and(
        eq(workspaceRuntimeServices.companyId, input.workspace.companyId),
        eq(workspaceRuntimeServices.executionWorkspaceId, input.workspace.id),
      );

  const [service] = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      serviceName: workspaceRuntimeServices.serviceName,
      status: workspaceRuntimeServices.status,
      scopeType: workspaceRuntimeServices.scopeType,
    })
    .from(workspaceRuntimeServices)
    .where(and(serviceScopeCondition, ne(workspaceRuntimeServices.status, "stopped")))
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt))
    .limit(1);
  return service ?? null;
}

async function assertDirtyQuarantineRuntimeServicesStopped(input: {
  db: Db;
  executionWorkspaceId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
}) {
  if (!input.executionWorkspaceId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires an execution workspace id for runtime-service checks";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const [workspace] = await input.db
    .select()
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, input.executionWorkspaceId));
  if (!workspace) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a persisted execution workspace for runtime-service checks";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const activeService = await findActiveRuntimeServiceBlockingDirtyQuarantine({
    db: input.db,
    workspace,
  });
  if (!activeService) return;

  input.evidence.safeRepair.eligible = false;
  input.evidence.safeRepair.reason =
    `dirty quarantine repair requires runtime service "${activeService.serviceName}" (${activeService.id}) to be stopped; current status is ${activeService.status}`;
  throw branchIncoherenceValidationFailure(input.evidence);
}

async function assertGitIndexIsUnlocked(worktreePath: string) {
  const indexLockPath = await runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
    .catch(() => null);
  if (indexLockPath && existsSync(indexLockPath)) {
    throw new Error(`git index lock exists at ${indexLockPath}`);
  }
}

function fingerprintWorkspaceBranchIncoherence(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: GitWorktreeCleanliness;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  if (!proc) return "unknown";
  if (proc.code === 0) return "ancestor";
  if (proc.code === 1) return "diverged";
  return "unknown";
}

function explainGitWorktreeBranchIncoherence(input: {
  expectedBranchName: string;
  actualBranchName: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  sameHead: boolean;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  const actualBranch = formatBranchForMessage(input.actualBranchName);
  if (!input.expectedHeadSha || !input.actualHeadSha) {
    return `Paperclip could not determine branch ancestry because the recorded branch "${input.expectedBranchName}" or checked-out branch "${actualBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.sameHead) {
    return `The recorded branch "${input.expectedBranchName}" and checked-out branch "${actualBranch}" resolve to the same commit, so the mismatch is branch metadata rather than commit divergence.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.expectedBranchName}" is an ancestor of the checked-out branch "${actualBranch}", so the checked-out branch is forward of the recorded branch.`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.expectedBranchName}" is not an ancestor of the checked-out branch "${actualBranch}", so Paperclip cannot prove a forward-only reconciliation.`;
  }
  return `Paperclip could not determine whether the checked-out branch "${actualBranch}" is forward of the recorded branch "${input.expectedBranchName}".`;
}

async function inspectGitWorktreeBranchIncoherence(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const dirtyPathSample = sampleDirtyStatusPaths(statusLines);
  const cleanliness: GitWorktreeCleanliness =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const inProgressOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const actualHeadSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  const actualBranchExists = input.actualBranchName
    ? await localBranchExists(input.repoRoot, input.actualBranchName)
    : null;
  const registered = await findRegisteredGitWorktreeByPath(input.repoRoot, input.worktreePath);
  const actualBranchRef = input.actualBranchName ? `refs/heads/${input.actualBranchName}` : null;
  const registeredBranchRef = registered?.branch ?? null;
  const registeredBranchMatchesHead = Boolean(registered && registeredBranchRef === actualBranchRef);
  const sameHead = Boolean(expectedHeadSha && actualHeadSha && expectedHeadSha === actualHeadSha);
  const expectedBranchExists = Boolean(expectedHeadSha);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  const basePlainLanguageReason = explainGitWorktreeBranchIncoherence({
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
    expectedHeadSha,
    actualHeadSha,
    sameHead,
    ancestryVerdict,
  });
  const plainLanguageReason = inProgressOperation
    ? `${basePlainLanguageReason} An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is still in progress in this worktree.`
    : basePlainLanguageReason;
  const canCheckoutRecordedBranch =
    cleanliness === "clean" && expectedBranchExists && sameHead && registeredBranchMatchesHead;
  const canAdoptForwardActualBranch =
    cleanliness === "clean" &&
    expectedBranchExists &&
    actualBranchExists === true &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const canAttachRecordedBranchToDetachedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    input.actualBranchName === null &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const eligible =
    canCheckoutRecordedBranch || canAdoptForwardActualBranch || canAttachRecordedBranchToDetachedHead;
  const safeRepairReason = eligible
    ? canCheckoutRecordedBranch
      ? "clean worktree and expected branch points at the current HEAD"
      : canAdoptForwardActualBranch
        ? "clean worktree and checked-out branch is forward of the recorded branch"
        : "clean detached worktree HEAD is forward of the recorded branch"
    : cleanliness !== "clean"
      ? inProgressOperation
        ? `worktree is not clean and a git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is in progress`
        : "worktree is not clean"
      : !registered
        ? "worktree path is not registered"
      : !registeredBranchMatchesHead
        ? "registered worktree branch does not match HEAD"
      : !expectedBranchExists
        ? "expected branch does not exist"
        : !sameHead
          ? "expected branch and current HEAD differ"
          : "safe repair could not be proven";
  const fingerprint = fingerprintWorkspaceBranchIncoherence({
    sourceIssueId: input.sourceIssue?.id ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    expectedHeadSha,
    actualHeadSha,
  });
  const contention = await findGitWorktreeBranchContention({
    db: input.db ?? null,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    actualBranchName: input.actualBranchName,
  });

  return {
    reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
    fingerprint,
    sourceIssueId: input.sourceIssue?.id ?? null,
    sourceIdentifier: input.sourceIssue?.identifier ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    inProgressOperation,
    statusEntryCount: statusLines?.length ?? null,
    dirtyPathSample,
    contention,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef,
      registeredBranchRef,
      registeredPathFound: Boolean(registered),
      registeredBranchMatchesHead,
      expectedBranchExists,
      actualBranchExists,
      expectedHeadSha,
      actualHeadSha,
      sameHead,
      ancestryVerdict,
      plainLanguageReason,
    },
    safeRepair: {
      eligible,
      attempted: false,
      succeeded: false,
      reason: safeRepairReason,
    },
  };
}

function branchIncoherenceValidationFailure(evidence: GitWorktreeBranchIncoherenceEvidence) {
  return new WorkspaceRuntimeValidationFailure(
    `Execution workspace git worktree expected branch "${evidence.expectedBranch}" but found "${formatBranchForMessage(evidence.actualBranch)}" at "${evidence.worktreePath}". Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`,
    {
      workspaceValidation: evidence,
    },
  );
}

function formatDirtyQuarantineContentionRefusal(contention: GitWorktreeBranchContention) {
  const activeRunText = contention.activeRun
    ? ` with active run ${contention.activeRun.id}`
    : " with no active run";
  return `dirty quarantine repair refused because workspace ${contention.claimedByWorkspaceId} already claims the live branch${activeRunText}`;
}

function formatDirtyQuarantineFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    gitErrorIncludes(error, "index.lock") ||
    gitErrorIncludes(error, "index lock") ||
    gitErrorIncludes(error, "another git process") ||
    gitErrorIncludes(error, "Unable to create")
  ) {
    return `dirty quarantine repair aborted because git reported index contention: ${message}`;
  }
  return `dirty quarantine repair failed: ${message}`;
}

function formatDirtyQuarantineAuditComment(input: {
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  claimant: GitWorktreeBranchContention | null;
}) {
  const dirtySample = input.evidence.dirtyPathSample.length > 0
    ? input.evidence.dirtyPathSample.map((entry) => `\`${entry}\``).join(", ")
    : "`none captured`";
  return [
    "Execution workspace dirty worktree quarantined before restore.",
    "",
    `- Source issue: ${formatIssueReference(input.evidence.sourceIssueId, input.evidence.sourceIdentifier ?? input.sourceIssue?.identifier ?? null)}`,
    `- Workspace: \`${input.evidence.executionWorkspaceId ?? "unpersisted"}\``,
    `- Worktree: \`${input.evidence.worktreePath}\``,
    `- Recorded branch: \`${input.evidence.expectedBranch}\``,
    `- Live branch: \`${formatBranchForMessage(input.evidence.actualBranch)}\``,
    `- Rescue branch: \`${input.rescueBranch}\``,
    `- Rescue commit: \`${input.rescueCommitSha}\``,
    `- Dirty file count: \`${input.fileCount}\``,
    `- Dirty path sample: ${dirtySample}`,
    ...(input.evidence.inProgressOperation
      ? [`- Interrupted operation: \`git ${GIT_IN_PROGRESS_OPERATION_LABELS[input.evidence.inProgressOperation]}\` (state cleared after rescue; resolution preserved on the rescue branch)`]
      : []),
    `- Fingerprint: \`${input.evidence.fingerprint}\``,
    input.claimant
      ? `- Claimant: workspace \`${input.claimant.claimedByWorkspaceId}\` on issue ${formatIssueReference(input.claimant.claimedByIssueId, input.claimant.claimedByIssueIdentifier)}${input.claimant.activeRun ? ` with active run \`${input.claimant.activeRun.id}\`` : " with no active run"}`
      : "- Claimant: none",
  ].join("\n");
}

async function writeDirtyQuarantineAuditComments(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  heartbeatRunId: string | null;
}): Promise<{ sourceAuditCommentId: string | null; claimantAuditCommentId: string | null }> {
  const body = formatDirtyQuarantineAuditComment({
    evidence: input.evidence,
    rescueBranch: input.rescueBranch,
    rescueCommitSha: input.rescueCommitSha,
    fileCount: input.fileCount,
    sourceIssue: input.sourceIssue,
    claimant: input.evidence.contention,
  });
  let sourceAuditCommentId: string | null = null;
  let claimantAuditCommentId: string | null = null;
  const now = new Date();
  if (input.evidence.sourceIssueId) {
    const [sourceComment] = await input.db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: input.evidence.sourceIssueId,
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        createdByRunId: input.heartbeatRunId,
        body,
      })
      .returning({ id: issueComments.id });
    sourceAuditCommentId = sourceComment?.id ?? null;
    await input.db
      .update(issues)
      .set({ updatedAt: now })
      .where(eq(issues.id, input.evidence.sourceIssueId));
  }

  const claimantIssueId = input.evidence.contention?.claimedByIssueId ?? null;
  if (claimantIssueId && claimantIssueId !== input.evidence.sourceIssueId) {
    const [claimantComment] = await input.db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: claimantIssueId,
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        createdByRunId: input.heartbeatRunId,
        body,
      })
      .returning({ id: issueComments.id });
    claimantAuditCommentId = claimantComment?.id ?? null;
    await input.db
      .update(issues)
      .set({ updatedAt: now })
      .where(eq(issues.id, claimantIssueId));
  }

  return { sourceAuditCommentId, claimantAuditCommentId };
}

async function logDirtyQuarantineActivity(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  heartbeatRunId: string | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.heartbeatRunId,
    action: "execution_workspace.dirty_worktree_quarantined",
    entityType: input.evidence.executionWorkspaceId ? "execution_workspace" : "issue",
    entityId: input.evidence.executionWorkspaceId ?? input.evidence.sourceIssueId ?? input.companyId,
    details: {
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.evidence.sourceIssueId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      worktreePath: input.evidence.worktreePath,
      expectedBranch: input.evidence.expectedBranch,
      actualBranch: input.evidence.actualBranch,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      contention: input.evidence.contention,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

async function recordDirtyQuarantineOperation(input: {
  recorder?: WorkspaceOperationRecorder | null;
  phase?: "worktree_prepare" | "workspace_finalize";
  cwd: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  if (!input.recorder) return;
  await input.recorder.recordOperation({
    phase: input.phase ?? "worktree_prepare",
    cwd: input.cwd,
    metadata: {
      repoRoot: input.evidence.repoRoot,
      worktreePath: input.evidence.worktreePath,
      expectedBranchName: input.evidence.expectedBranch,
      actualBranchName: input.evidence.actualBranch,
      branchIncoherenceDirtyQuarantineRepair: true,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      sourceIssueId: input.evidence.sourceIssueId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
    },
    run: async () => ({
      status: "succeeded",
      system:
        `Quarantined dirty git worktree state on ${input.rescueBranch} (${formatShortSha(input.rescueCommitSha)}) and restored recorded branch ${input.evidence.expectedBranch}.\n`,
    }),
  });
}

async function quarantineDirtyWorktreeBranchIncoherence(input: {
  db: Db;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId: string | null;
  heartbeatRunId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  phase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<DirtyQuarantineRepairResult> {
  const companyId = await readIssueCompanyId(input.db, input.evidence.sourceIssueId);
  if (!companyId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a source issue company for audit";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const freshContention = await findGitWorktreeBranchContention({
    db: input.db,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId,
    worktreePath: input.worktreePath,
    actualBranchName: input.evidence.actualBranch,
  });
  input.evidence.contention = freshContention;
  if (freshContention) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(freshContention);
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const rescueBranch = buildDirtyQuarantineRescueBranch(input.sourceIssue);
  const fileCount = input.evidence.statusEntryCount ?? input.evidence.dirtyPathSample.length;
  const baseMetadata = {
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.evidence.actualBranch,
    branchIncoherenceDirtyQuarantineRepair: true,
    rescueBranch,
    fingerprint: input.evidence.fingerprint,
    sourceIssueId: input.evidence.sourceIssueId,
    executionWorkspaceId: input.evidence.executionWorkspaceId,
    fileCount,
    dirtyPathSample: input.evidence.dirtyPathSample,
    contention: input.evidence.contention,
  };

  let rescueBranchCreated = false;
  let expectedBranchRestored = false;
  try {
    await assertGitIndexIsUnlocked(input.worktreePath);
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["checkout", "-b", rescueBranch],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Created rescue branch ${rescueBranch} for dirty git worktree state at ${input.worktreePath}\n`,
      failureLabel: `git checkout -b ${rescueBranch}`,
    });
    rescueBranchCreated = true;
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["add", "-A"],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Staged dirty git worktree state for rescue branch ${rescueBranch}\n`,
      failureLabel: "git add -A",
    });
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: [
        "commit",
        "-m",
        "Paperclip dirty workspace rescue",
        "-m",
        [
          `Source-Issue: ${input.evidence.sourceIdentifier ?? input.evidence.sourceIssueId ?? "unknown"}`,
          `Run-Id: ${input.heartbeatRunId ?? "unknown"}`,
          `Recorded-Branch: ${input.expectedBranchName}`,
          `Live-Branch: ${formatBranchForMessage(input.evidence.actualBranch)}`,
          `Fingerprint: ${input.evidence.fingerprint}`,
        ].join("\n"),
      ],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Committed dirty git worktree state to rescue branch ${rescueBranch}\n`,
      failureLabel: "git commit dirty workspace rescue",
    });
    const rescueCommitSha = await runGit(["rev-parse", "HEAD"], input.worktreePath);
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["checkout", input.expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        ...baseMetadata,
        rescueCommitSha,
      },
      successMessage: `Restored recorded branch ${input.expectedBranchName} after dirty workspace rescue ${rescueBranch}\n`,
      failureLabel: `git checkout ${input.expectedBranchName}`,
    });
    expectedBranchRestored = true;

    // A run that died mid-rebase (or mid-merge/cherry-pick/revert/bisect)
    // leaves the operation's state directory behind even after the recorded
    // branch is checked out, which wedges the next git command in the
    // worktree. The rescue commit above already preserved the in-flight
    // resolution, so clearing the state metadata here loses nothing.
    let clearedInProgressOperation: GitWorktreeInProgressOperation | null = null;
    const lingeringOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
    if (lingeringOperation) {
      const operationLabel = GIT_IN_PROGRESS_OPERATION_LABELS[lingeringOperation];
      const quitArgs = GIT_IN_PROGRESS_OPERATION_QUIT_ARGS[lingeringOperation];
      await recordGitOperation(input.recorder, {
        phase: input.phase ?? "worktree_prepare",
        args: quitArgs,
        cwd: input.worktreePath,
        metadata: {
          ...baseMetadata,
          clearedInProgressOperation: lingeringOperation,
        },
        successMessage: `Cleared interrupted git ${operationLabel} state after dirty workspace rescue ${rescueBranch}\n`,
        failureLabel: `git ${quitArgs.join(" ")}`,
      });
      const stillInProgress = await detectGitWorktreeInProgressOperation(input.worktreePath);
      if (stillInProgress) {
        input.evidence.safeRepair.succeeded = false;
        input.evidence.safeRepair.reason =
          `dirty quarantine repair could not clear the interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[stillInProgress]} state`;
        throw branchIncoherenceValidationFailure(input.evidence);
      }
      clearedInProgressOperation = lingeringOperation;
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== input.expectedBranchName) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason =
        `dirty quarantine repair checked out ${formatBranchForMessage(repairedBranch)} instead of ${input.expectedBranchName}`;
      throw branchIncoherenceValidationFailure(input.evidence);
    }
    const repairedStatus = await runGit(["status", "--porcelain", "--untracked-files=all"], input.worktreePath);
    if (repairedStatus.trim().length > 0) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason = "dirty quarantine repair completed but the worktree is still dirty";
      throw branchIncoherenceValidationFailure(input.evidence);
    }

    const comments = await writeDirtyQuarantineAuditComments({
      db: input.db,
      companyId,
      evidence: input.evidence,
      sourceIssue: input.sourceIssue,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      heartbeatRunId: input.heartbeatRunId,
    });
    await logDirtyQuarantineActivity({
      db: input.db,
      companyId,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      heartbeatRunId: input.heartbeatRunId,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    await recordDirtyQuarantineOperation({
      recorder: input.recorder,
      phase: input.phase,
      cwd: input.worktreePath,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    return {
      rescueBranch,
      rescueCommitSha,
      fileCount,
      clearedInProgressOperation,
      ...comments,
    };
  } catch (error) {
    if (rescueBranchCreated && !expectedBranchRestored) {
      await runGit(["checkout", input.expectedBranchName], input.worktreePath).catch(() => null);
    }
    if (error instanceof WorkspaceRuntimeValidationFailure) throw error;
    input.evidence.safeRepair.succeeded = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineFailure(error);
    throw branchIncoherenceValidationFailure(input.evidence);
  }
}

async function recordForwardBranchReconcileOperation(input: {
  recorder?: WorkspaceOperationRecorder | null;
  phase?: "worktree_prepare" | "workspace_finalize";
  cwd: string;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string;
  executionWorkspaceId: string | null;
  sourceIssueId: string | null;
  fingerprint: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  mode: "record_updated" | "adopt_for_realize";
  auditCommentId?: string | null;
  recoveryActionId?: string | null;
}) {
  if (!input.recorder) return;

  await input.recorder.recordOperation({
    phase: input.phase ?? "worktree_prepare",
    cwd: input.cwd,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName: input.expectedBranchName,
      actualBranchName: input.actualBranchName,
      branchIncoherenceReconcileForward: true,
      reconcileMode: input.mode,
      fingerprint: input.fingerprint,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
      ancestryVerdict: input.ancestryVerdict,
      auditCommentId: input.auditCommentId ?? null,
      recoveryActionId: input.recoveryActionId ?? null,
    },
    run: async () => ({
      status: "succeeded",
      system:
        input.mode === "record_updated"
          ? `Reconciled execution workspace branch record from ${input.expectedBranchName} to ${input.actualBranchName}; worktree left unchanged.\n`
          : `Adopted live git worktree branch ${input.actualBranchName} for this execution workspace realization; worktree left unchanged.\n`,
    }),
  });
}

async function logForwardBranchReconcileActivity(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  sourceIssueId: string | null;
  runId: string | null;
  mode: "forward";
  reason: string | null;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  fingerprint: string;
  auditCommentId: string | null;
  recoveryActionId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.branch_reconciled",
    entityType: "execution_workspace",
    entityId: input.executionWorkspaceId,
    details: {
      mode: input.mode,
      reason: input.reason,
      fromBranch: input.fromBranch,
      toBranch: input.toBranch,
      fromSha: input.fromSha,
      toSha: input.toSha,
      ancestryVerdict: input.ancestryVerdict,
      fingerprint: input.fingerprint,
      sourceIssueId: input.sourceIssueId,
      auditCommentId: input.auditCommentId,
      recoveryActionId: input.recoveryActionId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

export async function reconcilePendingForwardBranchAfterPersistence(input: {
  db: Db;
  executionWorkspaceId: string;
  pending: PendingForwardBranchReconcile;
  heartbeatRunId?: string | null;
  reconcileOperationPhase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
    input.executionWorkspaceId,
    {
      mode: "forward",
      reason: input.pending.reason,
      alternateRecoveryFingerprints: [input.pending.prePersistenceFingerprint],
      actor: {
        actorType: "system",
        actorId: "workspace_runtime",
        agentId: null,
        runId: input.heartbeatRunId ?? null,
      },
    },
  );
  await logForwardBranchReconcileActivity({
    db: input.db,
    companyId: result.workspace.companyId,
    executionWorkspaceId: result.workspace.id,
    sourceIssueId: result.workspace.sourceIssueId,
    runId: input.heartbeatRunId ?? null,
    mode: "forward",
    reason: input.pending.reason,
    fromBranch: result.inspection.fromBranch,
    toBranch: result.inspection.toBranch,
    fromSha: result.inspection.fromSha,
    toSha: result.inspection.toSha,
    ancestryVerdict: result.inspection.ancestryVerdict,
    fingerprint: result.inspection.fingerprint,
    auditCommentId: result.auditCommentId,
    recoveryActionId: result.recoveryAction?.id ?? null,
  });
  await recordForwardBranchReconcileOperation({
    recorder: input.recorder,
    phase: input.reconcileOperationPhase,
    cwd: result.inspection.worktreePath,
    repoRoot: result.inspection.repoRoot,
    worktreePath: result.inspection.worktreePath,
    expectedBranchName: result.inspection.fromBranch,
    actualBranchName: result.inspection.toBranch,
    executionWorkspaceId: result.workspace.id,
    sourceIssueId: result.workspace.sourceIssueId,
    fingerprint: result.inspection.fingerprint,
    expectedHeadSha: result.inspection.fromSha,
    actualHeadSha: result.inspection.toSha,
    ancestryVerdict: result.inspection.ancestryVerdict,
    mode: "adopt_for_realize",
    auditCommentId: result.auditCommentId,
    recoveryActionId: result.recoveryAction?.id ?? null,
  });
  return result;
}

export async function ensureGitWorktreeBranchCoherent(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
  actualBranchName?: string | null;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  persistForwardReconcile?: boolean;
  reconcileOperationPhase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<GitWorktreeBranchCoherenceResult> {
  const expectedBranchName = input.expectedBranchName?.trim();
  if (!expectedBranchName) return { branchName: null, reconciledForward: false, warnings: [] };

  const currentBranch = input.actualBranchName !== undefined
    ? input.actualBranchName
    : await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  if (currentBranch === expectedBranchName) {
    return { branchName: expectedBranchName, reconciledForward: false, warnings: [] };
  }

  const evidence = await inspectGitWorktreeBranchIncoherence({
    db: input.db ?? null,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName,
    actualBranchName: currentBranch,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
  });

  if (evidence.cleanliness === "dirty" && input.enableWorkspaceDirtyQuarantineRepair === true) {
    if (!input.db) {
      evidence.safeRepair.reason = "dirty quarantine repair requires database access for claimant checks and audit";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.registeredPathFound) {
      evidence.safeRepair.reason = "dirty quarantine repair requires a registered git worktree path";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.expectedBranchExists) {
      evidence.safeRepair.reason = "dirty quarantine repair requires the recorded branch to exist";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (evidence.contention) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(evidence.contention);
      throw branchIncoherenceValidationFailure(evidence);
    }
    await assertDirtyQuarantineRuntimeServicesStopped({
      db: input.db,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      evidence,
    });
    evidence.safeRepair.eligible = true;
    evidence.safeRepair.attempted = true;
    evidence.safeRepair.reason = "dirty worktree can be quarantined on a rescue branch before restoring the recorded branch";
    const result = await quarantineDirtyWorktreeBranchIncoherence({
      db: input.db,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName,
      sourceIssue: input.sourceIssue,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      evidence,
      phase: input.reconcileOperationPhase,
      recorder: input.recorder ?? null,
    });
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = result.clearedInProgressOperation
      ? `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}; interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} state cleared`
      : `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}`;
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      dirtyQuarantineRepair: result,
      warnings: [
        `Execution workspace dirty worktree state was quarantined on rescue branch "${result.rescueBranch}" (${formatShortSha(result.rescueCommitSha)}; ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}) before restoring recorded branch "${expectedBranchName}".${result.clearedInProgressOperation ? ` An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} was also cleared; its in-flight state is preserved on the rescue branch.` : ""}`,
      ],
    };
  }

  if (
    input.enableWorkspaceBranchReconcileForward === true &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.cleanliness === "clean" &&
    currentBranch
  ) {
    const reason = "Automatic forward reconciliation: recorded branch is an ancestor of the checked-out branch.";
    if (input.executionWorkspaceId && input.persistForwardReconcile !== false) {
      if (!input.db) {
        evidence.safeRepair.reason = "forward reconciliation requires database access to update the execution workspace record";
        throw branchIncoherenceValidationFailure(evidence);
      }
      try {
        const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
          input.executionWorkspaceId,
          {
            mode: "forward",
            reason,
            actor: {
              actorType: "system",
              actorId: "workspace_runtime",
              agentId: null,
              runId: input.heartbeatRunId ?? null,
            },
          },
        );
        await logForwardBranchReconcileActivity({
          db: input.db,
          companyId: result.workspace.companyId,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          runId: input.heartbeatRunId ?? null,
          mode: "forward",
          reason,
          fromBranch: result.inspection.fromBranch,
          toBranch: result.inspection.toBranch,
          fromSha: result.inspection.fromSha,
          toSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          fingerprint: result.inspection.fingerprint,
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        await recordForwardBranchReconcileOperation({
          recorder: input.recorder,
          phase: input.reconcileOperationPhase,
          cwd: input.worktreePath,
          repoRoot: result.inspection.repoRoot,
          worktreePath: result.inspection.worktreePath,
          expectedBranchName: result.inspection.fromBranch,
          actualBranchName: result.inspection.toBranch,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          fingerprint: result.inspection.fingerprint,
          expectedHeadSha: result.inspection.fromSha,
          actualHeadSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          mode: "record_updated",
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        return { branchName: result.inspection.toBranch, reconciledForward: true, warnings: [] };
      } catch (error) {
        evidence.safeRepair.reason =
          `forward reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
        throw branchIncoherenceValidationFailure(evidence);
      }
    }

    if (!input.db) {
      evidence.safeRepair.reason = "forward reconciliation adoption requires database access to audit after workspace realization";
      throw branchIncoherenceValidationFailure(evidence);
    }
    return {
      branchName: currentBranch,
      reconciledForward: true,
      warnings: [],
      pendingForwardBranchReconcile: {
        recordedBranchName: expectedBranchName,
        adoptedBranchName: currentBranch,
        prePersistenceFingerprint: evidence.fingerprint,
        reason,
      },
    };
  }

  if (!evidence.safeRepair.eligible) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.attempted = true;
  const warningPrefix =
    `Execution workspace branch metadata was self-healed from "${expectedBranchName}" to "${formatBranchForMessage(currentBranch)}" at ${input.worktreePath}.`;
  if (
    currentBranch &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean worktree adopted the checked-out branch because it is forward of the recorded branch";
    return {
      branchName: currentBranch,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The checked-out branch contains the recorded branch plus newer commits, so Paperclip adopted it for subsequent runs.`,
      ],
    };
  }

  if (
    currentBranch === null &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.provenance.actualHeadSha
  ) {
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["checkout", "-B", expectedBranchName, evidence.provenance.actualHeadSha],
        cwd: input.worktreePath,
        metadata: {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          expectedBranchName,
          actualBranchName: currentBranch,
          branchIncoherenceRepair: true,
          detachedHeadRepair: true,
          fingerprint: evidence.fingerprint,
          sourceIssueId: evidence.sourceIssueId,
          executionWorkspaceId: evidence.executionWorkspaceId,
        },
        successMessage: `Reattached detached git worktree HEAD at ${input.worktreePath} to ${expectedBranchName}\n`,
        failureLabel: `git checkout -B ${expectedBranchName} ${formatShortSha(evidence.provenance.actualHeadSha)}`,
      });
    } catch (error) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `safe detached HEAD reattachment failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== expectedBranchName) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `reattach completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean detached worktree HEAD was reattached to the recorded branch";
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The detached HEAD contained the recorded branch plus newer commits, so Paperclip moved the recorded branch to that HEAD.`,
      ],
    };
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["checkout", expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName,
        actualBranchName: currentBranch,
        branchIncoherenceRepair: true,
        fingerprint: evidence.fingerprint,
        sourceIssueId: evidence.sourceIssueId,
        executionWorkspaceId: evidence.executionWorkspaceId,
      },
      successMessage: `Repaired clean git worktree branch mismatch at ${input.worktreePath}: checked out ${expectedBranchName}\n`,
      failureLabel: `git checkout ${expectedBranchName}`,
    });
  } catch (error) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `safe checkout failed: ${error instanceof Error ? error.message : String(error)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
    .catch(() => null);
  if (repairedBranch !== expectedBranchName) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `checkout completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.succeeded = true;
  evidence.safeRepair.reason = "clean worktree checked out the recorded branch";
  return {
    branchName: expectedBranchName,
    reconciledForward: false,
    warnings: [
      `Execution workspace branch metadata was self-healed by checking out recorded branch "${expectedBranchName}" at ${input.worktreePath}.`,
    ],
  };
}

// Resolve the authoritative base ref for a fresh worktree. A configured local
// branch is mapped to its `origin/<branch>` counterpart so unpushed local
// divergence never leaks into the task branch; remote-tracking refs, SHAs, and
// tags are used verbatim, and an unset/`HEAD` base falls back to the detected
// default branch (which already prefers `origin/master`).
async function resolveAuthoritativeBaseRef(
  repoRoot: string,
  configuredBaseRef: string | null,
): Promise<{ baseRef: string; warnings: string[]; refreshed: boolean }> {
  const warnings: string[] = [];
  const detectOrHead = async () => (await detectDefaultBranch(repoRoot)) ?? "HEAD";

  const configured = configuredBaseRef?.trim();
  if (!configured || configured === "HEAD") {
    return { baseRef: await detectOrHead(), warnings, refreshed: false };
  }

  if (parseRemoteTrackingRef(configured)) {
    return { baseRef: configured, warnings, refreshed: false };
  }

  if (await localBranchExists(repoRoot, configured)) {
    const remoteCandidate = `origin/${configured}`;
    // Refresh here and keep the warnings; the caller skips its own refresh of
    // the returned ref (see `refreshed`) so we never fetch the same ref twice.
    warnings.push(...await refreshRemoteTrackingBaseRef(repoRoot, remoteCandidate));
    if (await resolveBaseRefSha(repoRoot, remoteCandidate)) {
      return { baseRef: remoteCandidate, warnings, refreshed: true };
    }
    if (await remoteExists(repoRoot, "origin")) {
      warnings.push(
        `Configured base ref "${configured}" is a local branch with no matching origin/${configured}; basing the execution workspace on the local ref, which may include unpushed commits.`,
      );
    }
    return { baseRef: configured, warnings, refreshed: false };
  }

  return { baseRef: configured, warnings, refreshed: false };
}

// Auto-refresh a reused worktree to the latest base only when it is provably
// unstarted: no task commits past the base and a clean tree (including untracked
// files). This pulls an idle worktree forward to the freshest `origin/master`
// after a long planning phase without ever destroying in-progress work. Only
// remote-tracking bases are eligible; local-only bases keep warn-only drift.
async function refreshUnstartedWorktreeToBase(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string;
  currentBaseRefSha: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ refreshed: boolean; baseRefSha: string | null }> {
  if (!parseRemoteTrackingRef(input.baseRef)) {
    return { refreshed: false, baseRefSha: null };
  }

  const headSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  if (!headSha) {
    return { refreshed: false, baseRefSha: null };
  }
  if (headSha === input.currentBaseRefSha) {
    return { refreshed: false, baseRefSha: input.currentBaseRefSha };
  }

  const commitsPastBaseRaw = await runGit(
    ["rev-list", "--count", `${input.currentBaseRefSha}..HEAD`],
    input.worktreePath,
  ).catch(() => null);
  const commitsPastBase = commitsPastBaseRaw === null ? null : Number.parseInt(commitsPastBaseRaw, 10);
  if (commitsPastBase === null || !Number.isFinite(commitsPastBase) || commitsPastBase > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  // Force `--untracked-files=all` so untracked files are counted regardless of a
  // local `status.showUntrackedFiles=no`; otherwise the clean-tree guard could
  // pass and the `reset --hard` below would destroy untracked work.
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  if (status === null || status.trim().length > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  await recordGitOperation(input.recorder, {
    phase: "worktree_prepare",
    args: ["reset", "--hard", input.currentBaseRefSha],
    cwd: input.worktreePath,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      previousHeadSha: headSha,
      baseRefSha: input.currentBaseRefSha,
      refreshedUnstartedWorktree: true,
    },
    successMessage: `Refreshed unstarted git worktree at ${input.worktreePath} to ${input.baseRef} (${formatShortSha(input.currentBaseRefSha)})\n`,
    failureLabel: `git reset --hard ${input.currentBaseRefSha}`,
  });

  return { refreshed: true, baseRefSha: input.currentBaseRefSha };
}


type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
};

export type ManagedGitWorktreeBranchInspection = {
  valid: boolean;
  reason: string | null;
  reasonCode:
    | "missing_worktree"
    | "not_a_git_checkout"
    | "not_registered"
    | "wrong_repository_root"
    | "branch_mismatch"
    | null;
  repoRoot: string | null;
  worktreePath: string;
  expectedBranchName: string | null;
  actualBranchName: string | null;
};

function parseGitWorktreeListPorcelain(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
      });
      current = {};
    }
  }

  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

async function resolveGitOwnerRepoRoot(cwd: string): Promise<string> {
  const checkoutRoot = path.resolve(await runGit(["rev-parse", "--show-toplevel"], cwd));
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], checkoutRoot).catch(() => null);
  if (!commonDir) return checkoutRoot;
  return path.dirname(path.resolve(checkoutRoot, commonDir));
}

async function findRegisteredGitWorktreeByBranch(repoRoot: string, branchName: string): Promise<string | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedBranchRef = `refs/heads/${branchName}`;
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (entry.branch !== expectedBranchRef) continue;
    return path.resolve(entry.worktree);
  }

  return null;
}

async function findRegisteredGitWorktreeByPath(repoRoot: string, worktreePath: string): Promise<GitWorktreeListEntry | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedPath = await resolvePathForWorktreeComparison(worktreePath);
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (await resolvePathForWorktreeComparison(entry.worktree) === expectedPath) {
      return entry;
    }
  }
  return null;
}

async function isGitCheckout(cwd: string): Promise<boolean> {
  return Boolean(await runGit(["rev-parse", "--git-dir"], cwd).catch(() => null));
}

function normalizeRepoIdentity(repoUrl: string | null | undefined): string | null {
  const trimmed = (repoUrl ?? "").trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  const pathish = sshMatch
    ? `/${sshMatch[2]}`
    : (() => {
        try {
          return new URL(trimmed).pathname;
        } catch {
          return trimmed;
        }
      })();
  const parts = pathish.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length >= 2) {
    const owner = parts[parts.length - 2].toLowerCase();
    const repo = parts[parts.length - 1].replace(/\.git$/i, "").toLowerCase();
    if (owner && repo) return `${owner}/${repo}`;
  }
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

async function validateProjectPrimaryRepoOrigin(input: {
  cwd: string;
  expectedRepoUrl: string | null | undefined;
}) {
  const expected = normalizeRepoIdentity(input.expectedRepoUrl);
  if (!expected) return;

  const actualUrl = await runGit(["config", "--get", "remote.origin.url"], input.cwd).catch(() => null);
  const actual = normalizeRepoIdentity(actualUrl);
  if (!actual || actual === expected) return;

  throw new WorkspaceRepoMismatchError(
    `Execution workspace cwd "${input.cwd}" is checked out from "${actualUrl}" but the issue expects "${input.expectedRepoUrl}". Refusing to start the agent in the wrong repository.`,
  );
}

type GitSubmoduleReadinessEntry = {
  path: string;
  state: "uninitialized" | "conflicted";
};

function parseGitSubmoduleReadiness(output: string): GitSubmoduleReadinessEntry[] {
  const entries: GitSubmoduleReadinessEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const state = line[0];
    if (state !== "-" && state !== "U") continue;

    const body = line.slice(1).trim();
    const firstWhitespace = body.search(/\s/);
    if (firstWhitespace < 0) continue;

    let submodulePath = body.slice(firstWhitespace).trim();
    if (submodulePath.endsWith(")")) {
      const detailStart = submodulePath.lastIndexOf(" (");
      if (detailStart > 0) {
        submodulePath = submodulePath.slice(0, detailStart);
      }
    }
    if (!submodulePath || seen.has(submodulePath)) continue;
    seen.add(submodulePath);
    entries.push({
      path: submodulePath,
      state: state === "-" ? "uninitialized" : "conflicted",
    });
  }

  return entries;
}

function buildNonInteractiveGitEnv(): NodeJS.ProcessEnv {
  const env = sanitizeRuntimeServiceBaseEnv(process.env);
  env.GIT_TERMINAL_PROMPT = "0";
  if (!env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  return env;
}

/**
 * Result of probing submodule readiness.
 *
 * `ok: false` means the probe *stalled* -- we could not determine the state,
 * which is NOT evidence that submodules are broken. Callers must not strand a
 * live issue on an inconclusive probe -- see `ensureGitSubmodulesReady`.
 *
 * `partial: true` accompanies `ok: true` when the entries were recovered from a
 * *timed-out* probe's partial output. The list is a subset -- the walk did not
 * finish -- but each entry in it is a fault git actually reported, so callers
 * treat it exactly like a completed probe: fail closed on conflicted, repair
 * uninitialized. Only the absence of faults is unknowable from partial output,
 * and that case degrades instead (`ok: false`).
 *
 * Deterministic failures never reach this type: they throw. See
 * `inspectGitSubmoduleReadiness`.
 */
type GitSubmoduleInspection =
  | {
      ok: true;
      entries: GitSubmoduleReadinessEntry[];
      partial?: boolean;
      attempts?: number;
      timeoutReason?: string;
      processGroupAliveAfterTimeout?: boolean;
    }
  | { ok: false; reason: string; attempts: number };

/**
 * Probe submodule readiness, retrying stalls.
 *
 * Two failure modes, deliberately handled differently:
 *
 * - **Stall** (`GitCommandTimeoutError`): inconclusive *unless* the partial output
 *   already names a broken submodule. `git submodule status --recursive` flushes
 *   entries as it walks, so a stall can arrive with a definitive `U`/`-` record
 *   for an earlier submodule in hand. When it does, that evidence is returned
 *   (`partial: true`) and the caller fails closed / repairs as usual -- retrying
 *   would spend another full budget to reach a conclusion we already have.
 *   Otherwise the stall is retried only after the timed-out process group has
 *   disappeared. If the bounded post-kill liveness check says the group is still
 *   alive, the probe degrades immediately instead of overlapping the next Git
 *   tree with the previous one. Exhausted retries are then reported as
 *   `ok: false` so the caller can degrade to a warning. This is the BLO-18784
 *   fix.
 * - **Any other failure** (non-zero exit, missing git binary, malformed
 *   `.gitmodules`, corrupt checkout, permission error): deterministic evidence
 *   that the checkout is unusable. Throws `WorkspaceGitSubmoduleError`, as it did
 *   before BLO-18784. Retrying would burn every budget to reach the same answer,
 *   and degrading past it would start an agent in a workspace we already know is
 *   broken -- the timeout fix must not widen into a general fail-open.
 */
async function inspectGitSubmoduleReadiness(
  cwd: string,
  env: NodeJS.ProcessEnv,
  stage: "initial" | "post_repair",
): Promise<GitSubmoduleInspection> {
  const settings = readSubmoduleInspectSettings();
  let lastTimeoutReason: string | null = null;

  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    try {
      const output = await runGit(["submodule", "status", "--recursive"], cwd, {
        env,
        timeoutMs: settings.timeoutMs,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      return { ok: true, entries: parseGitSubmoduleReadiness(output) };
    } catch (error) {
      if (!(error instanceof GitCommandTimeoutError)) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new WorkspaceGitSubmoduleError(
          `Could not inspect git submodules for execution workspace "${cwd}" ` +
            `(${stage === "post_repair" ? "verification after repair" : "initial check"}): ${reason}`,
        );
      }
      lastTimeoutReason = error.message;

      // The stall may still have produced conclusive evidence before it hung.
      const salvaged = salvageGitSubmoduleFaults(error);
      if (salvaged.length > 0) {
        // Faults git actually reported. Return them as conclusive so the caller
        // fails closed / repairs. Note the converse does NOT hold: an empty
        // `salvaged` is not evidence of health (buffering or an early kill can
        // yield no output at all), so that case falls through to retry/degrade.
        return {
          ok: true,
          entries: salvaged,
          partial: true,
          attempts: attempt,
          timeoutReason: error.message,
          processGroupAliveAfterTimeout: error.processGroupAliveAfterTimeout,
        };
      }

      if (error.processGroupAliveAfterTimeout) {
        return {
          ok: false,
          reason:
            `${error.message}; previous timed-out git process group remained alive after SIGKILL, ` +
            "so retry was skipped to avoid overlapping probes against the same checkout",
          attempts: attempt,
        };
      }

      if (attempt < settings.attempts) {
        // Cap the linear backoff as well: the delay is a *product*, so bounding
        // only the configured value would leave the effective delay unbounded
        // if the caps above are ever raised.
        await delay(Math.min(settings.retryDelayMs * attempt, WORKSPACE_SUBMODULE_INSPECT_MAX_RETRY_DELAY_MS));
      }
    }
  }

  return {
    ok: false,
    reason: lastTimeoutReason ?? "git submodule status --recursive did not complete",
    attempts: settings.attempts,
  };
}

function describeSubmoduleInspectionDegradation(cwd: string, inspection: { reason: string; attempts: number }): string {
  return (
    `Could not inspect git submodules for execution workspace "${cwd}" after ${inspection.attempts} attempt(s): ` +
    `${inspection.reason}. Continuing without the submodule readiness check -- the probe stalled, so the ` +
    `inspection is inconclusive rather than a detected fault. If a submodule really is missing, the agent's own ` +
    `build/test step will fail with a specific error.`
  );
}

/**
 * Record a degraded (skipped) submodule readiness check as a structured
 * workspace operation.
 *
 * Without this the degradation is only a line in the run log. That matters
 * because this change converts a loud failure (`workspace_git_submodule_
 * unavailable`, which raised a recovery action) into a soft warning: absence of
 * recovery actions would then be indistinguishable between "the stalls stopped"
 * and "we stopped reporting the stalls". A `skipped` operation row keeps the
 * occurrence countable, so a chronically slow checkout is still visible.
 *
 * Best-effort: bookkeeping must not defeat the point of degrading. If the
 * recorder itself fails we swallow it and still let the run proceed -- the
 * human-readable warning is returned to the caller either way.
 *
 * `cause` separates two operationally distinct degrades that used to share
 * this one action name with no other structured distinction: `inconclusive_
 * probe` means the probe itself never reached a conclusion (retries
 * exhausted with no evidence either way); `repair_withheld` means the probe
 * *did* find a real fault (missing submodules, from salvaged partial output)
 * but automatic repair was skipped because the previous timed-out process
 * group was still alive. Evidence queries need this to be a stable field, not
 * a prose match on `reason`.
 */
async function recordSubmoduleInspectionDegradation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    cwd: string;
    reason: string;
    attempts: number;
    stage: "initial" | "post_repair";
    cause: "inconclusive_probe" | "repair_withheld";
  },
): Promise<void> {
  if (!recorder) return;
  const settings = readSubmoduleInspectSettings();
  try {
    await recorder.recordOperation({
      phase: "worktree_prepare",
      command: formatCommandForDisplay("git", ["submodule", "status", "--recursive"]),
      cwd: input.cwd,
      metadata: {
        cwd: input.cwd,
        action: "submodule_inspection_degraded",
        stage: input.stage,
        cause: input.cause,
        attempts: input.attempts,
        timeoutMs: settings.timeoutMs,
        reason: input.reason,
      },
      run: async () => ({
        status: "skipped",
        exitCode: null,
        system: `${describeSubmoduleInspectionDegradation(input.cwd, input)}\n`,
      }),
    });
  } catch {
    // Intentionally ignored -- see doc comment.
  }
}

async function ensureGitSubmodulesReady(input: {
  cwd: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<string[]> {
  const gitmodulesExists = await fs.stat(path.join(input.cwd, ".gitmodules"))
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (!gitmodulesExists) return [];

  const env = buildNonInteractiveGitEnv();
  const inspection = await inspectGitSubmoduleReadiness(input.cwd, env, "initial");
  if (!inspection.ok) {
    // The probe stalled (deterministic failures threw above). Degrade to a
    // warning rather than throwing: stranding an in-progress issue because a
    // read-only probe on a network filesystem was slow is strictly worse than
    // letting the run proceed. See BLO-18784.
    const warning = describeSubmoduleInspectionDegradation(input.cwd, inspection);
    await recordSubmoduleInspectionDegradation(input.recorder, {
      cwd: input.cwd,
      reason: inspection.reason,
      attempts: inspection.attempts,
      stage: "initial",
      cause: "inconclusive_probe",
    });
    return [warning];
  }

  const entries = inspection.entries;
  // When the evidence came from a stalled probe, say so: the fault is real but
  // the list is a subset, so an operator reading the error should not treat it
  // as the complete set of broken submodules.
  const partialSuffix = inspection.partial
    ? " (detected in the partial output of a probe that then stalled, so there may be more)"
    : "";

  const conflicted = entries.filter((entry) => entry.state === "conflicted");
  if (conflicted.length > 0) {
    throw new WorkspaceGitSubmoduleError(
      `Execution workspace "${input.cwd}" has conflicted git submodules that need manual resolution before an agent can run: ${conflicted.map((entry) => entry.path).join(", ")}${partialSuffix}`,
    );
  }

  const missingPaths = entries
    .filter((entry) => entry.state === "uninitialized")
    .map((entry) => entry.path);
  if (missingPaths.length === 0) return [];

  if (inspection.partial && inspection.processGroupAliveAfterTimeout) {
    const reason =
      `${inspection.timeoutReason ?? "git submodule status --recursive timed out"}; ` +
      "previous timed-out git process group remained alive after SIGKILL, " +
      "so automatic submodule repair was skipped to avoid overlapping repair commands against the same checkout";
    await recordSubmoduleInspectionDegradation(input.recorder, {
      cwd: input.cwd,
      reason,
      attempts: inspection.attempts ?? 1,
      stage: "initial",
      cause: "repair_withheld",
    });
    return [
      `Could not safely initialize git submodules for execution workspace "${input.cwd}" (${missingPaths.join(", ")}): ` +
        `${reason}. Continuing without automatic submodule repair -- the partial probe found uninitialized ` +
        "submodules, but starting a recursive repair over a still-live git process group could amplify the checkout stall.",
    ];
  }

  const metadata = {
    cwd: input.cwd,
    submodulePaths: missingPaths,
  };

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["submodule", "sync", "--recursive", "--", ...missingPaths],
      cwd: input.cwd,
      env,
      timeoutMs: 60_000,
      metadata: {
        ...metadata,
        action: "sync_submodules",
      },
      successMessage: `Synchronized git submodule URLs for ${missingPaths.join(", ")}\n`,
      failureLabel: "git submodule sync",
    });
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: [
        "-c",
        "protocol.version=2",
        "submodule",
        "update",
        "--init",
        "--recursive",
        "--recommend-shallow",
        "--depth",
        "1",
        "--filter=blob:none",
        "--jobs",
        "4",
        "--",
        ...missingPaths,
      ],
      cwd: input.cwd,
      env,
      timeoutMs: WORKSPACE_SUBMODULE_REPAIR_TIMEOUT_MS,
      metadata: {
        ...metadata,
        action: "repair_uninitialized_submodules",
        depth: 1,
        filter: "blob:none",
      },
      successMessage: `Initialized git submodules for ${missingPaths.join(", ")}\n`,
      failureLabel: "git submodule update",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkspaceGitSubmoduleError(
      `Execution workspace "${input.cwd}" has uninitialized git submodules (${missingPaths.join(", ")}), and Paperclip could not restore them before starting the agent: ${reason}`,
    );
  }

  const verification = await inspectGitSubmoduleReadiness(input.cwd, env, "post_repair");
  if (!verification.ok) {
    // The repair commands themselves succeeded and only the re-check stalled (a
    // definitive verification failure threw above, so success is never claimed
    // over one). Report both rather than discarding the successful repair.
    await recordSubmoduleInspectionDegradation(input.recorder, {
      cwd: input.cwd,
      reason: verification.reason,
      attempts: verification.attempts,
      stage: "post_repair",
      cause: "inconclusive_probe",
    });
    return [
      `Initialized git submodules before starting: ${missingPaths.join(", ")}`,
      describeSubmoduleInspectionDegradation(input.cwd, verification),
    ];
  }
  if (verification.entries.length > 0) {
    const stillMissing = verification.entries.map((entry) => entry.path);
    // Only the paths we actually attempted can be described as unfixed by the
    // repair. A partial initial probe returns a subset, so anything outside
    // `missingPaths` was never attempted -- calling that "still unavailable
    // after repair" would send an operator looking for a repair failure that
    // never happened. The workspace is still unusable either way, so this stays
    // fatal; only the attribution changes.
    const unattempted = stillMissing.filter((candidate) => !missingPaths.includes(candidate));
    throw new WorkspaceGitSubmoduleError(
      `Execution workspace "${input.cwd}" still has unavailable git submodules after repair: ${stillMissing.join(", ")}` +
        (unattempted.length > 0
          ? `. Not attempted by this repair (the initial probe stalled before reporting them): ${unattempted.join(", ")}`
          : "") +
        (verification.partial
          ? " (verification itself stalled, so this list may be incomplete)"
          : ""),
    );
  }

  return [`Initialized git submodules before starting: ${missingPaths.join(", ")}`];
}

async function detectDefaultBranch(repoRoot: string): Promise<string | null> {
  const originMasterRef = "origin/master";
  await refreshRemoteTrackingBaseRef(repoRoot, originMasterRef);
  if (await resolveBaseRefSha(repoRoot, originMasterRef)) {
    return originMasterRef;
  }

  // Try the explicit remote HEAD first (set by git clone or git remote set-head)
  try {
    const remoteHead = await runGit(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      repoRoot,
    );
    if (remoteHead) {
      await refreshRemoteTrackingBaseRef(repoRoot, remoteHead);
      if (await resolveBaseRefSha(repoRoot, remoteHead)) return remoteHead;
    }
  } catch {
    // Not set — fall through to heuristic
  }

  // Fallback: check for common default branch names on the remote
  for (const candidate of ["origin/master", "origin/main", "main", "master"]) {
    try {
      await refreshRemoteTrackingBaseRef(repoRoot, candidate);
      await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoRoot);
      return candidate;
    } catch {
      // Not found — try next
    }
  }

  return null;
}

async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

function deriveRepoNameFromRepoUrlForRuntime(repoUrl: string | null | undefined): string | null {
  const trimmed = (repoUrl ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function resolvePathForWorktreeComparison(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const missingSegments: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const realPath = await fs.realpath(current);
      return path.resolve(realPath, ...missingSegments);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function listLinkedGitWorktreePaths(repoRoot: string): Promise<Set<string>> {
  const output = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length).trim();
    if (!worktree) continue;
    paths.add(await resolvePathForWorktreeComparison(worktree));
  }
  return paths;
}

/**
 * Shared plumbing for the worktree-ownership guards (BLO-19607). The ownership
 * module takes git and path-normalization as parameters so it stays unit
 * testable; this binds it to the runtime's own implementations.
 */
function gitWorktreeOwnershipContext(repoRoot: string) {
  return {
    git: (args: string[], cwd: string) => runGit(args, cwd),
    repoRoot,
    normalizePath: resolvePathForWorktreeComparison,
  };
}

/**
 * Claims a linked worktree for this workspace so that a *different* concurrent
 * run's cleanup cannot reclaim its registration. Git skips locked worktrees
 * during `git worktree prune`, which is what makes the claim effective even
 * against code paths that never learned about ownership.
 */
async function stampGitWorktreeOwnership(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null | undefined;
  executionWorkspaceId?: string | null;
  runId?: string | null;
}): Promise<string[]> {
  const branchName = asString(input.branchName, "").trim();
  if (!branchName) return [];
  const result = await lockGitWorktreeForOwner({
    ...gitWorktreeOwnershipContext(input.repoRoot),
    worktreePath: input.worktreePath,
    token: {
      branchName,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      runId: input.runId ?? null,
    },
  });
  return result.warnings;
}

export async function inspectManagedGitWorktreeBranch(input: {
  worktreePath: string;
  expectedBranchName: string | null | undefined;
  repoRoot?: string | null;
}): Promise<ManagedGitWorktreeBranchInspection> {
  const worktreePath = await resolvePathForWorktreeComparison(input.worktreePath);
  const expectedBranchName = asString(input.expectedBranchName, "").trim() || null;
  const base = {
    worktreePath,
    expectedBranchName,
    actualBranchName: null,
  };

  if (!await directoryExists(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: `worktree path "${worktreePath}" does not exist`,
      reasonCode: "missing_worktree",
      repoRoot: input.repoRoot ? path.resolve(input.repoRoot) : null,
    };
  }

  const repoRoot = input.repoRoot
    ? path.resolve(input.repoRoot)
    : await resolveGitOwnerRepoRoot(worktreePath).catch(() => null);
  if (!repoRoot) {
    return {
      ...base,
      valid: false,
      reason: "path is not a git checkout",
      reasonCode: "not_a_git_checkout",
      repoRoot: null,
    };
  }

  const listedWorktrees = await listLinkedGitWorktreePaths(repoRoot).catch(() => null);
  if (!listedWorktrees?.has(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: "path is not registered in `git worktree list`",
      reasonCode: "not_registered",
      repoRoot,
    };
  }

  const worktreeTopLevel = await runGit(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!worktreeTopLevel || path.resolve(worktreeTopLevel) !== worktreePath) {
    return {
      ...base,
      valid: false,
      reason: "git resolves this path to a different repository root",
      reasonCode: "wrong_repository_root",
      repoRoot,
    };
  }

  const actualBranchName = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    worktreePath,
  ).catch(() => null);
  if (expectedBranchName && actualBranchName !== expectedBranchName) {
    return {
      ...base,
      valid: false,
      reason: `worktree HEAD is on "${actualBranchName ?? "<detached>"}" instead of "${expectedBranchName}"`,
      reasonCode: "branch_mismatch",
      repoRoot,
      actualBranchName,
    };
  }

  return {
    ...base,
    valid: true,
    reason: null,
    reasonCode: null,
    repoRoot,
    actualBranchName,
  };
}

async function validateLinkedGitWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
}): Promise<
  | { valid: true }
  | {
    valid: false;
    reason: string;
    reasonCode: Exclude<ManagedGitWorktreeBranchInspection["reasonCode"], null>;
    actualBranchName?: string | null;
  }
> {
  const inspection = await inspectManagedGitWorktreeBranch({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
  });
  return inspection.valid
    ? { valid: true }
    : {
        valid: false,
        reason: inspection.reason ?? "unknown git worktree mismatch",
        reasonCode: inspection.reasonCode ?? "not_a_git_checkout",
        actualBranchName: inspection.actualBranchName,
      };
}

export function formatManagedGitWorktreeBranchInspection(input: ManagedGitWorktreeBranchInspection) {
  return {
    valid: input.valid,
    reason: input.reason,
    reasonCode: input.reasonCode,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
  };
}

/**
 * Signal a child and, where the platform allows it, everything it spawned.
 *
 * The negative pid targets the process group, which is why callers that may need
 * this must spawn `detached` (a non-detached child shares *our* group, so the
 * negative pid would either miss or, worse, hit us). Falls back to the direct
 * child when the group is already gone or the platform has no groups.
 */
function terminateChildProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped; nothing left to signal.
  }
}

function buildWorkspaceCommandEnv(input: {
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PAPERCLIP_WORKSPACE_CWD = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_BRANCH = input.branchName;
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.base.baseCwd;
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.repoRoot;
  env.PAPERCLIP_WORKSPACE_SOURCE = input.base.source;
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.base.repoRef ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.base.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_CREATED = input.created ? "true" : "false";
  env.PAPERCLIP_PROJECT_ID = input.base.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.base.workspaceId ?? "";
  env.PAPERCLIP_AGENT_ID = input.agent.id ?? "";
  env.PAPERCLIP_AGENT_NAME = input.agent.name;
  env.PAPERCLIP_COMPANY_ID = input.agent.companyId;
  env.PAPERCLIP_ISSUE_ID = input.issue?.id ?? "";
  env.PAPERCLIP_ISSUE_IDENTIFIER = input.issue?.identifier ?? "";
  env.PAPERCLIP_ISSUE_TITLE = input.issue?.title ?? "";
  env.PAPERCLIP_ISSUE_WORK_MODE = input.issue?.workMode ?? "";
  return env;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveRepoManagedWorkspaceCommand(command: string, repoRoot: string) {
  const patterns = [
    /^(?<prefix>(?:bash|sh|zsh)\s+)(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
    /^(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (!match?.groups) continue;

    const relativePath = match.groups.relative;
    const repoManagedPath = path.join(repoRoot, relativePath.slice(2));
    if (!existsSync(repoManagedPath)) continue;

    const prefix = match.groups.prefix ?? "";
    const suffix = match.groups.suffix ?? "";
    return `${prefix}${quoteShellArg(repoManagedPath)}${suffix}`;
  }

  return command;
}

async function runWorkspaceCommand(input: {
  command: string;
  resolvedCommand?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}) {
  const shell = resolveShell();
  const proc = await executeProcess({
    command: shell,
    args: ["-c", input.resolvedCommand ?? input.command],
    cwd: input.cwd,
    env: input.env,
  });
  if (proc.code === 0) return;

  const details = [proc.stderr.trim(), proc.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${proc.code ?? -1}`,
  );
}

async function recordGitOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: WorkspaceOperationPhase;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    failureLabel?: string | null;
  },
): Promise<string> {
  if (!recorder) {
    return runGit(input.args, input.cwd, {
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  let timedOut = false;
  await recorder.recordOperation({
    phase: input.phase,
    command: formatCommandForDisplay("git", input.args),
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const result = await executeProcess({
        command: "git",
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      timedOut = result.timedOut;
      return {
        status: result.code === 0 && !result.timedOut ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.timedOut || result.stdoutTruncated || result.stderrTruncated
            ? {
                timedOut: result.timedOut,
                timeoutMs: input.timeoutMs ?? null,
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (timedOut) {
    throw new Error(`${input.failureLabel ?? `git ${input.args.join(" ")}`} timed out after ${input.timeoutMs}ms`);
  }

  if (code !== 0) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      details.length > 0
        ? `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed: ${details}`
        : `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed with exit code ${code ?? -1}`,
    );
  }
  return stdout.trim();
}

async function recordWorkspaceCommandOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "workspace_provision" | "workspace_teardown";
    command: string;
    resolvedCommand?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    label: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
  },
) {
  if (!recorder) {
    await runWorkspaceCommand(input);
    return null;
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  const operation = await recorder.recordOperation({
    phase: input.phase,
    command: input.command,
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const shell = resolveShell();
      const result = await executeProcess({
        command: shell,
        args: ["-c", input.resolvedCommand ?? input.command],
        cwd: input.cwd,
        env: input.env,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.stdoutTruncated || result.stderrTruncated
            ? {
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (code === 0) return operation;

  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${code ?? -1}`,
  );
}

async function provisionExecutionWorktree(input: {
  strategy: Record<string, unknown>;
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
  if (!provisionCommand) return;
  const resolvedProvisionCommand = resolveRepoManagedWorkspaceCommand(provisionCommand, input.repoRoot);

  await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: provisionCommand,
    resolvedCommand: resolvedProvisionCommand,
    cwd: input.worktreePath,
    env: buildWorkspaceCommandEnv({
      base: input.base,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      issue: input.issue,
      agent: input.agent,
      created: input.created,
    }),
    label: `Execution workspace provision command "${provisionCommand}"`,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      created: input.created,
      resolvedCommand: resolvedProvisionCommand === provisionCommand ? null : resolvedProvisionCommand,
    },
    successMessage: `Provisioned workspace at ${input.worktreePath}\n`,
  });
}

function buildExecutionWorkspaceCleanupEnv(input: {
  workspace: {
    cwd: string | null;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
  };
  projectWorkspaceCwd?: string | null;
}) {
  const env: NodeJS.ProcessEnv = sanitizeRuntimeServiceBaseEnv(process.env);
  env.PAPERCLIP_WORKSPACE_CWD = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_PATH = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH =
    input.workspace.providerRef ?? input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_BRANCH = input.workspace.branchName ?? "";
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.workspace.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.workspace.baseRef ?? "";
  env.PAPERCLIP_PROJECT_ID = input.workspace.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.workspace.projectWorkspaceId ?? "";
  env.PAPERCLIP_ISSUE_ID = input.workspace.sourceIssueId ?? "";
  return env;
}

async function resolveGitRepoRootForWorkspaceCleanup(
  worktreePath: string,
  projectWorkspaceCwd: string | null,
): Promise<string | null> {
  if (projectWorkspaceCwd) {
    const resolvedProjectWorkspaceCwd = path.resolve(projectWorkspaceCwd);
    const gitDir = await runGit(["rev-parse", "--git-common-dir"], resolvedProjectWorkspaceCwd)
      .catch(() => null);
    if (gitDir) {
      const resolvedGitDir = path.resolve(resolvedProjectWorkspaceCwd, gitDir);
      return path.dirname(resolvedGitDir);
    }
  }

  const gitDir = await runGit(["rev-parse", "--git-common-dir"], worktreePath).catch(() => null);
  if (!gitDir) return null;
  const resolvedGitDir = path.resolve(worktreePath, gitDir);
  return path.dirname(resolvedGitDir);
}

export async function realizeExecutionWorkspace(input: {
  db?: Db | null;
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  executionWorkspaceId?: string | null;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<RealizedExecutionWorkspace> {
  const rawStrategy = parseObject(input.config.workspaceStrategy);
  const strategyType = asString(rawStrategy.type, "project_primary");
  if (strategyType !== "git_worktree") {
    const baseIsGitCheckout = await isGitCheckout(input.base.baseCwd);
    let warnings: string[] = [];
    if (input.base.source === "project_primary" && baseIsGitCheckout) {
      await validateProjectPrimaryRepoOrigin({
        cwd: input.base.baseCwd,
        expectedRepoUrl: input.base.repoUrl,
      });
    }
    if (baseIsGitCheckout) {
      warnings = await ensureGitSubmodulesReady({
        cwd: input.base.baseCwd,
        recorder: input.recorder ?? null,
      });
    }
    return {
      ...input.base,
      strategy: "project_primary",
      cwd: input.base.baseCwd,
      branchName: null,
      worktreePath: null,
      warnings,
      created: false,
      baseRefSha: null,
    };
  }

  const repoRoot = await resolveGitOwnerRepoRoot(input.base.baseCwd);
  const branchTemplate = asString(rawStrategy.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: input.issue,
    agent: input.agent,
    projectId: input.base.projectId,
    repoRef: input.base.repoRef,
  });
  // Option (A) (BLO-9117): process-enforce the issue identifier into the branch
  // name so a merged PR reliably ref-links at merge time. See
  // applyIssueIdentifierToBranchName.
  //
  // BLO-19063: then, under `runScope: "per_run"`, append a run token so two
  // concurrent runs of this issue land in different trees instead of sharing
  // one. Applied after the identifier step so the identifier survives.
  let branchName = applyRunScopeToBranchName(
    applyIssueIdentifierToBranchName(renderedBranch, input.issue?.identifier ?? null),
    resolveExecutionWorkspaceRunScope(rawStrategy.runScope),
    input.heartbeatRunId ?? null,
  );
  const configuredParentDir = asString(rawStrategy.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".paperclip", "worktrees");
  const worktreePath = path.join(worktreeParentDir, branchName);
  let pendingForwardBranchReconcile: PendingForwardBranchReconcile | null = null;
  const configuredBaseRef = typeof rawStrategy.baseRef === "string" && rawStrategy.baseRef.length > 0
    ? rawStrategy.baseRef
    : input.base.repoRef ?? null;
  const {
    baseRef,
    warnings: baseRefResolutionWarnings,
    refreshed: baseRefAlreadyRefreshed,
  } = await resolveAuthoritativeBaseRef(repoRoot, configuredBaseRef);
  const baseRefreshWarnings = [
    ...baseRefResolutionWarnings,
    ...(baseRefAlreadyRefreshed ? [] : await refreshRemoteTrackingBaseRef(repoRoot, baseRef)),
  ];
  const currentBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);

  await fs.mkdir(worktreeParentDir, { recursive: true });

  async function reuseExistingWorktree(reusablePath: string, effectiveBranchName = branchName, extraWarnings: string[] = []) {
    const refresh = currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reusablePath,
          branchName: effectiveBranchName,
          baseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reusablePath,
      branchName,
      baseRef,
      recordedBaseRefSha: null,
      skipRefresh: true,
    });
    if (input.recorder) {
      await input.recorder.recordOperation({
        phase: "worktree_prepare",
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath: reusablePath,
          branchName: effectiveBranchName,
          baseRef,
          currentBaseRefSha: baseDrift.currentBaseRefSha,
          branchBaseRefSha: baseDrift.branchBaseRefSha,
          created: false,
          reused: true,
        },
        run: async () => ({
          status: "succeeded",
          exitCode: 0,
          system: `Reused existing git worktree at ${reusablePath}\n`,
        }),
      });
    }
    // Re-stamp on reuse so a worktree created before ownership tracking (or one
    // whose lock was dropped) is adopted rather than left collectable.
    const reuseOwnershipWarnings = await stampGitWorktreeOwnership({
      repoRoot,
      worktreePath: reusablePath,
      branchName: effectiveBranchName,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      runId: input.heartbeatRunId ?? null,
    });
    const submoduleWarnings = await ensureGitSubmodulesReady({
      cwd: reusablePath,
      recorder: input.recorder ?? null,
    });
    await provisionExecutionWorktree({
      strategy: rawStrategy,
      base: input.base,
      repoRoot,
      worktreePath: reusablePath,
      branchName: effectiveBranchName,
      issue: input.issue,
      agent: input.agent,
      created: false,
      recorder: input.recorder ?? null,
    });
    return {
      ...input.base,
      repoRef: baseRef,
      strategy: "git_worktree" as const,
      cwd: reusablePath,
      branchName: effectiveBranchName,
      worktreePath: reusablePath,
      warnings: [
        ...extraWarnings,
        ...baseRefreshWarnings,
        ...baseDrift.warnings,
        ...reuseOwnershipWarnings,
        ...submoduleWarnings,
      ],
      created: false,
      baseRefSha: refresh.baseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha,
      pendingForwardBranchReconcile,
    };
  }

  async function validateReusableWorktree(reusablePath: string) {
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reusablePath,
      expectedBranchName: branchName,
    }).catch(() => null);
    if (validation && !validation.valid && validation.reasonCode === "branch_mismatch") {
      const coherence = await ensureGitWorktreeBranchCoherent({
        db: input.db ?? null,
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: branchName,
        actualBranchName: validation.actualBranchName ?? null,
        sourceIssue: input.issue,
        executionWorkspaceId: null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        enableWorkspaceBranchReconcileForward: input.enableWorkspaceBranchReconcileForward === true,
        enableWorkspaceDirtyQuarantineRepair: input.enableWorkspaceDirtyQuarantineRepair === true,
        reconcileOperationPhase: "worktree_prepare",
        recorder: input.recorder ?? null,
      });
      const effectiveBranchName = coherence.branchName ?? branchName;
      if (coherence.reconciledForward) {
        branchName = effectiveBranchName;
        pendingForwardBranchReconcile = coherence.pendingForwardBranchReconcile ?? null;
      }
      const nextValidation = await validateLinkedGitWorktree({
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: effectiveBranchName,
      }).catch(() => null);
      return {
        validation: nextValidation,
        branchName: effectiveBranchName,
        warnings: coherence.warnings,
      };
    }
    return { validation, branchName, warnings: [] };
  }

  const existingWorktree = await directoryExists(worktreePath);
  if (existingWorktree) {
    const reusable = await validateReusableWorktree(worktreePath);
    if (reusable.validation?.valid) {
      return await reuseExistingWorktree(worktreePath, reusable.branchName, reusable.warnings);
    }
    const validation = reusable.validation;
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Configured worktree path "${worktreePath}" already exists and is not a reusable git worktree${reason}.`);
  }

  const registeredBranchWorktree = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
  if (registeredBranchWorktree) {
    const reusable = await validateReusableWorktree(registeredBranchWorktree);
    if (reusable.validation?.valid) {
      return await reuseExistingWorktree(registeredBranchWorktree, reusable.branchName, reusable.warnings);
    }
    const validation = reusable.validation;
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Registered worktree for branch "${branchName}" at "${registeredBranchWorktree}" is not reusable${reason}.`);
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: currentBaseRefSha,
        created: true,
      },
      successMessage: `Created git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (!gitErrorIncludes(error, "already exists")) {
      throw error;
    }
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["worktree", "add", worktreePath, branchName],
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath,
          branchName,
          baseRef,
          baseRefSha: currentBaseRefSha,
          created: false,
          reusedExistingBranch: true,
        },
        successMessage: `Attached existing branch ${branchName} at ${worktreePath}\n`,
        failureLabel: `git worktree add ${worktreePath}`,
      });
    } catch (attachError) {
      if (!gitErrorIncludes(attachError, "already checked out")) {
        throw attachError;
      }
      const reusablePath = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
      if (!reusablePath || !await isGitCheckout(reusablePath)) {
        throw attachError;
      }
      return await reuseExistingWorktree(reusablePath);
    }
  }
  // Claim the registration before any long-running provisioning: until the lock
  // exists, a concurrent run's prune can still collect this worktree.
  const ownershipWarnings = await stampGitWorktreeOwnership({
    repoRoot,
    worktreePath,
    branchName,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    runId: input.heartbeatRunId ?? null,
  });
  const submoduleWarnings = await ensureGitSubmodulesReady({
    cwd: worktreePath,
    recorder: input.recorder ?? null,
  });
  await provisionExecutionWorktree({
    strategy: rawStrategy,
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created: true,
    recorder: input.recorder ?? null,
  });

  return {
    ...input.base,
    repoRef: baseRef,
    strategy: "git_worktree",
    cwd: worktreePath,
    branchName,
    worktreePath,
    warnings: [...baseRefreshWarnings, ...ownershipWarnings, ...submoduleWarnings],
    created: true,
    baseRefSha: currentBaseRefSha,
  };
}

export async function ensurePersistedExecutionWorkspaceAvailable(input: {
  db?: Db | null;
  base: ExecutionWorkspaceInput;
  workspace: {
    id?: string | null;
    mode: string | null | undefined;
    strategyType: string | null | undefined;
    cwd: string | null | undefined;
    providerRef: string | null | undefined;
    projectId: string | null | undefined;
    projectWorkspaceId: string | null | undefined;
    repoUrl: string | null | undefined;
    baseRef: string | null | undefined;
    branchName: string | null | undefined;
    metadata?: Record<string, unknown> | null;
    config?: {
      provisionCommand?: string | null;
    } | null;
  };
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<RealizedExecutionWorkspace | null> {
  const cwd = asString(input.workspace.cwd ?? input.workspace.providerRef, "").trim();
  if (!cwd) return null;

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  const realized: RealizedExecutionWorkspace = {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (input.workspace.providerRef ?? cwd) : null,
    warnings: [],
    created: false,
    baseRefSha: readRecordedBaseRefSha(input.workspace.metadata),
  };
  const provisionCommand = asString(input.workspace.config?.provisionCommand, "").trim();

  if (strategy !== "git_worktree") {
    const repoUrl = asString(input.workspace.repoUrl ?? input.base.repoUrl, "").trim();
    if (input.workspace.mode === "shared_workspace") {
      const cwdIsGitCheckout = await isGitCheckout(cwd);
      if (cwdIsGitCheckout) {
        await validateProjectPrimaryRepoOrigin({
          cwd,
          expectedRepoUrl: repoUrl,
        });
      } else {
        const projectId = asString(input.workspace.projectId ?? input.base.projectId, "").trim();
        const companyId = asString(input.agent.companyId, "").trim();
        if (repoUrl && projectId && companyId) {
          const managedCwd = resolveManagedProjectWorkspaceDir({
            companyId,
            projectId,
            repoName: deriveRepoNameFromRepoUrlForRuntime(repoUrl),
          });
          if (managedCwd !== cwd && (await isGitCheckout(managedCwd))) {
            return {
              ...realized,
              cwd: managedCwd,
              warnings: [
                `Rebound stale shared workspace cwd "${cwd}" to managed checkout "${managedCwd}".`,
              ],
            };
          }
        }
      }
    }
    if (!await directoryExists(cwd)) {
      return null;
    }
    return realized;
  }
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], input.base.baseCwd);
  const recordedBaseRefSha = readRecordedBaseRefSha(input.workspace.metadata);
  if (await directoryExists(cwd)) {
    const reuseBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
    const reuseWorktreePath = realized.worktreePath ?? cwd;
    const repairWarnings: string[] = [];
    if (await isGitCheckout(reuseWorktreePath)) {
      const coherence = await ensureGitWorktreeBranchCoherent({
        db: input.db ?? null,
        repoRoot,
        worktreePath: reuseWorktreePath,
        expectedBranchName: realized.branchName,
        sourceIssue: input.issue,
        executionWorkspaceId: input.workspace.id ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        enableWorkspaceBranchReconcileForward: input.enableWorkspaceBranchReconcileForward === true,
        enableWorkspaceDirtyQuarantineRepair: input.enableWorkspaceDirtyQuarantineRepair === true,
        persistForwardReconcile: false,
        reconcileOperationPhase: "worktree_prepare",
        recorder: input.recorder ?? null,
      });
      if (coherence.branchName) {
        realized.branchName = coherence.branchName;
      }
      if (coherence.reconciledForward) {
        realized.pendingForwardBranchReconcile = coherence.pendingForwardBranchReconcile ?? null;
      }
      repairWarnings.push(...coherence.warnings);
    }
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reuseWorktreePath,
      expectedBranchName: realized.branchName,
    });
    if (!validation.valid) {
      throw new WorkspaceRuntimeValidationFailure(
        `Persisted git worktree "${reuseWorktreePath}" is not reusable (${validation.reason}).`,
        {
          workspaceValidation: {
            reason: "git_worktree_not_reusable",
            reasonCode: validation.reasonCode,
            worktreePath: reuseWorktreePath,
            executionWorkspaceId: input.workspace.id ?? null,
          },
        },
      );
    }
    const baseRefreshWarnings = reuseBaseRef
      ? await refreshRemoteTrackingBaseRef(repoRoot, reuseBaseRef)
      : [];
    const currentBaseRefSha = reuseBaseRef ? await resolveBaseRefSha(repoRoot, reuseBaseRef) : null;
    const refresh = reuseBaseRef && currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reuseWorktreePath,
          branchName: realized.branchName,
          baseRef: reuseBaseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reuseWorktreePath,
      branchName: realized.branchName,
      baseRef: reuseBaseRef,
      recordedBaseRefSha,
      skipRefresh: true,
    });
    realized.warnings = [...repairWarnings, ...baseRefreshWarnings, ...baseDrift.warnings];
    realized.baseRefSha = refresh.baseRefSha ?? recordedBaseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha;
    if (provisionCommand) {
      await provisionExecutionWorktree({
        strategy: {
          type: "git_worktree",
          provisionCommand,
        },
        base: input.base,
        repoRoot,
        worktreePath: realized.worktreePath ?? cwd,
        branchName: realized.branchName ?? "",
        issue: input.issue,
        agent: input.agent,
        created: false,
        recorder: input.recorder ?? null,
      });
    }
    return realized;
  }

  const worktreePath = realized.worktreePath ?? cwd;
  const branchName = asString(input.workspace.branchName, "").trim();
  if (!branchName) {
    throw new Error(`Execution workspace "${cwd}" is missing and cannot be restored because no branch name is recorded.`);
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  // Deliberately NOT `git worktree prune`: that is repo-global and deletes the
  // administrative files of every registration whose directory git cannot read
  // right now, including live worktrees belonging to other concurrent runs
  // (BLO-19607). Only this workspace's own stale entry is cleared, and only
  // after its ownership lock is confirmed.
  const stalePrune = await pruneOwnStaleGitWorktree({
    ...gitWorktreeOwnershipContext(repoRoot),
    worktreePath,
    token: {
      branchName,
      executionWorkspaceId: input.workspace.id ?? null,
      runId: input.heartbeatRunId ?? null,
    },
  });
  const restoreBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
  const restoreRefreshWarnings = restoreBaseRef ? await refreshRemoteTrackingBaseRef(repoRoot, restoreBaseRef) : [];
  const restoreCurrentBaseRefSha = restoreBaseRef ? await resolveBaseRefSha(repoRoot, restoreBaseRef) : null;

  let created = false;
  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", worktreePath, branchName],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef: input.workspace.baseRef ?? input.base.repoRef ?? null,
        currentBaseRefSha: restoreCurrentBaseRefSha,
        created: false,
        restored: true,
      },
      successMessage: `Reattached missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (
      !gitErrorIncludes(error, "invalid reference")
      && !gitErrorIncludes(error, "not a commit")
      && !gitErrorIncludes(error, "unknown revision")
    ) {
      throw error;
    }
    const baseRef = input.workspace.baseRef ?? await detectDefaultBranch(repoRoot) ?? "HEAD";
    const recreatedBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: recreatedBaseRefSha,
        created: true,
        restored: true,
      },
      successMessage: `Recreated missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
    created = true;
  }

  // The reattached worktree is a fresh registration, so it needs its ownership
  // claim restamped before another run's cleanup can observe it.
  const restoreOwnershipWarnings = await stampGitWorktreeOwnership({
    repoRoot,
    worktreePath,
    branchName,
    executionWorkspaceId: input.workspace.id ?? null,
    runId: input.heartbeatRunId ?? null,
  });

  const baseDrift = await inspectExecutionWorkspaceBaseDrift({
    repoRoot,
    worktreePath,
    branchName,
    baseRef: input.workspace.baseRef ?? input.base.repoRef ?? null,
    recordedBaseRefSha,
    skipRefresh: true,
  });

  await provisionExecutionWorktree({
    strategy: {
      type: "git_worktree",
      ...(provisionCommand ? { provisionCommand } : {}),
    },
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created,
    recorder: input.recorder ?? null,
  });

  return {
    ...realized,
    cwd: worktreePath,
    worktreePath,
    warnings: [
      ...stalePrune.warnings,
      ...restoreRefreshWarnings,
      ...restoreOwnershipWarnings,
      ...baseDrift.warnings,
    ],
    created,
    baseRefSha:
      recordedBaseRefSha
      ?? (created ? restoreCurrentBaseRefSha : baseDrift.branchBaseRefSha)
      ?? baseDrift.currentBaseRefSha,
  };
}

export async function cleanupExecutionWorkspaceArtifacts(input: {
  workspace: {
    id: string;
    cwd: string | null;
    providerType: string;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectWorkspace?: {
    cwd: string | null;
    cleanupCommand: string | null;
  } | null;
  cleanupCommand?: string | null;
  teardownCommand?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const warnings: string[] = [];
  const workspacePath = input.workspace.providerRef ?? input.workspace.cwd;
  const repoRoot = input.workspace.providerType === "git_worktree" && workspacePath
    ? await resolveGitRepoRootForWorkspaceCleanup(
      workspacePath,
      input.projectWorkspace?.cwd ?? null,
    )
    : null;
  const cleanupEnv = buildExecutionWorkspaceCleanupEnv({
    workspace: input.workspace,
    projectWorkspaceCwd: input.projectWorkspace?.cwd ?? null,
  });
  const createdByRuntime = input.workspace.metadata?.createdByRuntime === true;
  const cleanupCommands = [
    input.cleanupCommand ?? null,
    input.projectWorkspace?.cleanupCommand ?? null,
    input.teardownCommand ?? null,
  ]
    .map((value) => asString(value, "").trim())
    .filter(Boolean);

  for (const command of cleanupCommands) {
    try {
      const resolvedCommand = repoRoot
        ? resolveRepoManagedWorkspaceCommand(command, repoRoot)
        : command;
      await recordWorkspaceCommandOperation(input.recorder, {
        phase: "workspace_teardown",
        command,
        resolvedCommand,
        cwd: workspacePath ?? input.projectWorkspace?.cwd ?? process.cwd(),
        env: cleanupEnv,
        label: `Execution workspace cleanup command "${command}"`,
        metadata: {
          workspaceId: input.workspace.id,
          workspacePath,
          branchName: input.workspace.branchName,
          providerType: input.workspace.providerType,
          resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
        },
        successMessage: `Completed cleanup command "${command}"\n`,
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    const worktreeExists = await directoryExists(workspacePath);
    if (worktreeExists) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root for "${workspacePath}".`);
      } else {
        // Teardown must prove the registration is this workspace's own before
        // removing it; an unowned or foreign-owned entry is reported instead of
        // destroyed (BLO-19607).
        const authorization = await authorizeOwnedGitWorktreeCleanup({
          ...gitWorktreeOwnershipContext(repoRoot),
          worktreePath: workspacePath,
          token: {
            branchName: asString(input.workspace.branchName, "").trim(),
            executionWorkspaceId: input.workspace.id,
            runId: null,
          },
        });
        warnings.push(...authorization.warnings);
        if (authorization.authorized) {
          try {
            const removeForceArgs = authorization.removeForce === "double"
              ? ["--force", "--force"]
              : ["--force"];
            await recordGitOperation(input.recorder, {
              phase: "worktree_cleanup",
              args: ["worktree", "remove", ...removeForceArgs, workspacePath],
              cwd: repoRoot,
              metadata: {
                workspaceId: input.workspace.id,
                workspacePath,
                branchName: input.workspace.branchName,
                cleanupAction: "worktree_remove",
                removeForce: authorization.removeForce,
              },
              successMessage: `Removed git worktree ${workspacePath}\n`,
              failureLabel: `git worktree remove ${workspacePath}`,
            });
          } catch (err) {
            warnings.push(err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
    if (createdByRuntime && input.workspace.branchName) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root to delete branch "${input.workspace.branchName}".`);
      } else {
        try {
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: ["branch", "-d", input.workspace.branchName],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "branch_delete",
            },
            successMessage: `Deleted branch ${input.workspace.branchName}\n`,
            failureLabel: `git branch -d ${input.workspace.branchName}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Skipped deleting branch "${input.workspace.branchName}": ${message}`);
        }
      }
    }
  } else if (input.workspace.providerType === "local_fs" && createdByRuntime && workspacePath) {
    const projectWorkspaceCwd = input.projectWorkspace?.cwd ? path.resolve(input.projectWorkspace.cwd) : null;
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const containsProjectWorkspace = projectWorkspaceCwd
      ? (
          resolvedWorkspacePath === projectWorkspaceCwd ||
          projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
        )
      : false;
    if (containsProjectWorkspace) {
      warnings.push(`Refusing to remove path "${workspacePath}" because it contains the project workspace.`);
    } else {
      await fs.rm(resolvedWorkspacePath, { recursive: true, force: true });
      if (input.recorder) {
        await input.recorder.recordOperation({
          phase: "workspace_teardown",
          cwd: projectWorkspaceCwd ?? process.cwd(),
          metadata: {
            workspaceId: input.workspace.id,
            workspacePath: resolvedWorkspacePath,
            cleanupAction: "remove_local_fs",
          },
          run: async () => ({
            status: "succeeded",
            exitCode: 0,
            system: `Removed local workspace directory ${resolvedWorkspacePath}\n`,
          }),
        });
      }
    }
  }

  const cleaned =
    !workspacePath ||
    !(await directoryExists(workspacePath));

  return {
    cleanedPath: workspacePath,
    cleaned,
    warnings,
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function buildTemplateData(input: {
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  port: number | null;
}) {
  return {
    workspace: {
      cwd: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      worktreePath: input.workspace.worktreePath ?? "",
      repoUrl: input.workspace.repoUrl ?? "",
      repoRef: input.workspace.repoRef ?? "",
      env: input.adapterEnv,
    },
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    port: input.port ?? "",
  };
}

function renderRuntimeServiceEnv(input: {
  envConfig: Record<string, unknown>;
  templateData: ReturnType<typeof buildTemplateData>;
}) {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.envConfig)) {
    if (typeof value !== "string") continue;
    rendered[key] = renderTemplate(value, input.templateData);
  }
  return rendered;
}

function resolveRuntimeServiceReuseIdentity(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): {
  serviceName: string;
  lifecycle: RuntimeServiceRef["lifecycle"];
  command: string;
  serviceCwd: string;
  envConfig: Record<string, unknown>;
  envFingerprint: string;
  explicitPort: number;
  identityPort: number | null;
  reuseKey: string | null;
} {
  const serviceName = asString(input.service.name, "service");
  const lifecycle = asString(input.service.lifecycle, "shared") === "ephemeral" ? "ephemeral" : "shared";
  const command = asString(input.service.command, "");
  const serviceCwdTemplate = asString(input.service.cwd, ".");
  const portConfig = parseObject(input.service.port);
  const envConfig = parseObject(input.service.env);
  const explicitPort = asNumber(portConfig.value, asNumber(input.service.port, 0));
  const identityPort = explicitPort > 0 ? explicitPort : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: identityPort,
  });
  const serviceCwd = resolveConfiguredPath(renderTemplate(serviceCwdTemplate, templateData), input.workspace.cwd);
  const renderedEnv = renderRuntimeServiceEnv({
    envConfig,
    templateData,
  });
  const envFingerprint = createHash("sha256").update(stableStringify(renderedEnv)).digest("hex");
  const reuseKey =
    lifecycle === "shared"
      ? createHash("sha256")
          .update(
            stableStringify({
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              serviceName,
              command,
              cwd: serviceCwd,
              port: identityPort,
              env: renderedEnv,
            }),
          )
          .digest("hex")
      : null;

  return {
    serviceName,
    lifecycle,
    command,
    serviceCwd,
    envConfig,
    envFingerprint,
    explicitPort,
    identityPort,
    reuseKey,
  };
}

function resolveWorkspaceCommandExecution(input: {
  command: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
}) {
  const name =
    asString(input.command.name, "")
    || asString(input.command.label, "")
    || asString(input.command.title, "")
    || "workspace command";
  const command = asString(input.command.command, "");
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: null,
  });
  const cwd = resolveConfiguredPath(
    renderTemplate(asString(input.command.cwd, "."), templateData),
    input.workspace.cwd,
  );
  const env = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
    ...renderRuntimeServiceEnv({
      envConfig: parseObject(input.command.env),
      templateData,
    }),
  } as Record<string, string>;

  return {
    name,
    command,
    cwd,
    env,
  };
}

export async function runWorkspaceJobForControl(input: {
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  command: Record<string, unknown>;
  adapterEnv?: Record<string, string>;
  recorder?: WorkspaceOperationRecorder | null;
  metadata?: Record<string, unknown> | null;
}) {
  const resolved = resolveWorkspaceCommandExecution({
    command: input.command,
    workspace: input.workspace,
    agent: input.actor,
    issue: input.issue,
    adapterEnv: input.adapterEnv ?? {},
  });
  if (!resolved.command) {
    throw new Error(`Workspace job "${resolved.name}" is missing command`);
  }

  await ensureServerWorkspaceLinksCurrent(resolved.cwd);
  return await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: resolved.command,
    cwd: resolved.cwd,
    env: resolved.env,
    label: `Workspace job "${resolved.name}"`,
    metadata: {
      workspaceCommandKind: "job",
      workspaceCommandName: resolved.name,
      ...(input.metadata ?? {}),
    },
    successMessage: `Completed workspace job "${resolved.name}"\n`,
  });
}

function resolveServiceScopeId(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  issue: ExecutionWorkspaceIssueRef | null;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
}): {
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
} {
  const scopeTypeRaw = asString(input.service.reuseScope, input.service.lifecycle === "shared" ? "project_workspace" : "run");
  const scopeType =
    scopeTypeRaw === "project_workspace" ||
    scopeTypeRaw === "execution_workspace" ||
    scopeTypeRaw === "agent"
      ? scopeTypeRaw
      : "run";
  if (scopeType === "project_workspace") return { scopeType, scopeId: input.workspace.workspaceId ?? input.workspace.projectId };
  if (scopeType === "execution_workspace") {
    return { scopeType, scopeId: input.executionWorkspaceId ?? input.workspace.cwd };
  }
  if (scopeType === "agent") return { scopeType, scopeId: input.agent.id };
  return { scopeType: "run" as const, scopeId: input.runId };
}

function looksLikeWorkspaceDevServerCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev(?:\s|$)/.test(normalized);
}

export function resolveWorkspaceRuntimeReadinessTimeoutSec(service: Record<string, unknown>) {
  const readiness = parseObject(service.readiness);
  const explicitTimeoutSec = asNumber(readiness.timeoutSec, 0);
  if (explicitTimeoutSec > 0) {
    return Math.max(1, explicitTimeoutSec);
  }
  return looksLikeWorkspaceDevServerCommand(asString(service.command, "")) ? 90 : 30;
}

async function waitForReadiness(input: {
  service: Record<string, unknown>;
  serviceName?: string | null;
  command?: string | null;
  url: string | null;
  readinessUrl: string | null;
}) {
  const readiness = parseObject(input.service.readiness);
  const readinessType = asString(readiness.type, "");
  const readinessTargetUrl = input.readinessUrl ?? input.url;
  if (readinessType !== "http" || !readinessTargetUrl) return;
  const readinessUrl = resolveRuntimeServiceHealthUrl(readinessTargetUrl, {
    serviceName: input.serviceName,
    command: input.command,
  });
  if (!readinessUrl) {
    throw new Error(`Readiness check failed: could not resolve health URL for ${input.url}`);
  }
  const timeoutSec = resolveWorkspaceRuntimeReadinessTimeoutSec(input.service);
  const intervalMs = Math.max(100, asNumber(readiness.intervalMs, 500));
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = "service did not become ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(readinessUrl);
      if (response.ok) return;
      lastError = `received HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  throw new Error(`Readiness check failed for ${readinessUrl}: ${lastError}`);
}

function isPaperclipDevRuntimeService(input: { serviceName?: string | null; command?: string | null }) {
  const serviceName = (input.serviceName ?? "").trim().toLowerCase();
  const command = (input.command ?? "").trim().toLowerCase();
  return (
    serviceName === "paperclip-dev"
    || serviceName === "paperclip-dev-once"
    || (command.includes("dev:once") && command.includes("tailscale-auth"))
  );
}

function resolveRuntimeServiceHealthUrl(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url || !isPaperclipDevRuntimeService(input ?? {})) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/api/health";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

async function isRuntimeServiceUrlHealthy(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url) return true;
  const healthUrl = resolveRuntimeServiceHealthUrl(url, input);
  if (!healthUrl) return false;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function toPersistedWorkspaceRuntimeService(record: RuntimeServiceRecord): typeof workspaceRuntimeServices.$inferInsert {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: new Date(record.lastUsedAt),
    startedAt: new Date(record.startedAt),
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt) : null,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    updatedAt: new Date(),
  };
}

async function persistRuntimeServiceRecord(db: Db | undefined, record: RuntimeServiceRecord) {
  if (!db) return;
  const values = toPersistedWorkspaceRuntimeService(record);
  await db
    .insert(workspaceRuntimeServices)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceRuntimeServices.id,
      set: {
        projectId: values.projectId,
        projectWorkspaceId: values.projectWorkspaceId,
        executionWorkspaceId: values.executionWorkspaceId,
        issueId: values.issueId,
        scopeType: values.scopeType,
        scopeId: values.scopeId,
        serviceName: values.serviceName,
        status: values.status,
        lifecycle: values.lifecycle,
        reuseKey: values.reuseKey,
        command: values.command,
        cwd: values.cwd,
        port: values.port,
        url: values.url,
        provider: values.provider,
        providerRef: values.providerRef,
        ownerAgentId: values.ownerAgentId,
        startedByRunId: values.startedByRunId,
        lastUsedAt: values.lastUsedAt,
        startedAt: values.startedAt,
        stoppedAt: values.stoppedAt,
        stopPolicy: values.stopPolicy,
        healthStatus: values.healthStatus,
        updatedAt: values.updatedAt,
      },
    });
}

async function findStoppedRuntimeServiceReuseCandidate(input: {
  db?: Db;
  companyId: string;
  reuseKey: string | null;
  serviceName: string;
  command: string;
  cwd: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): Promise<StoppedRuntimeServiceReuseCandidate | null> {
  if (!input.db) return null;
  if (input.reuseKey) {
    const row = await input.db
      .select({
        id: workspaceRuntimeServices.id,
        port: workspaceRuntimeServices.port,
      })
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.companyId, input.companyId),
          eq(workspaceRuntimeServices.reuseKey, input.reuseKey),
          eq(workspaceRuntimeServices.provider, "local_process"),
          eq(workspaceRuntimeServices.status, "stopped"),
        ),
      )
      .orderBy(desc(workspaceRuntimeServices.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (row) return row;
  }

  const scopeIdCondition = input.scopeId === null
    ? isNull(workspaceRuntimeServices.scopeId)
    : eq(workspaceRuntimeServices.scopeId, input.scopeId);
  const row = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      port: workspaceRuntimeServices.port,
    })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, input.companyId),
        eq(workspaceRuntimeServices.provider, "local_process"),
        eq(workspaceRuntimeServices.status, "stopped"),
        eq(workspaceRuntimeServices.scopeType, input.scopeType),
        scopeIdCondition,
        eq(workspaceRuntimeServices.serviceName, input.serviceName),
        eq(workspaceRuntimeServices.command, input.command),
        eq(workspaceRuntimeServices.cwd, input.cwd),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row ?? null;
}

function clearIdleTimer(record: RuntimeServiceRecord) {
  if (!record.idleTimer) return;
  clearTimeout(record.idleTimer);
  record.idleTimer = null;
}

export function normalizeAdapterManagedRuntimeServices(input: {
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
  now?: Date;
}): RuntimeServiceRef[] {
  const nowIso = (input.now ?? new Date()).toISOString();
  return input.reports.map((report) => {
    const scopeType = report.scopeType ?? "run";
    const scopeId =
      report.scopeId ??
      (scopeType === "project_workspace"
        ? input.workspace.workspaceId
        : scopeType === "execution_workspace"
          ? input.executionWorkspaceId ?? input.workspace.cwd
          : scopeType === "agent"
            ? input.agent.id
            : input.runId) ??
      null;
    const serviceName = asString(report.serviceName, "").trim() || "service";
    const status = report.status ?? "running";
    const lifecycle = report.lifecycle ?? "ephemeral";
    const healthStatus =
      report.healthStatus ??
      (status === "running" ? "healthy" : status === "failed" ? "unhealthy" : "unknown");
    return {
      id: stableRuntimeServiceId({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType,
        scopeId,
        serviceName,
        reportId: report.id ?? null,
        providerRef: report.providerRef ?? null,
        reuseKey: report.reuseKey ?? null,
      }),
      companyId: input.agent.companyId,
      projectId: report.projectId ?? input.workspace.projectId,
      projectWorkspaceId: report.projectWorkspaceId ?? input.workspace.workspaceId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      issueId: report.issueId ?? input.issue?.id ?? null,
      serviceName,
      status,
      lifecycle,
      scopeType,
      scopeId,
      reuseKey: report.reuseKey ?? null,
      command: report.command ?? null,
      cwd: report.cwd ?? null,
      port: report.port ?? null,
      url: report.url ?? null,
      provider: "adapter_managed",
      providerRef: report.providerRef ?? null,
      ownerAgentId: report.ownerAgentId ?? input.agent.id ?? null,
      startedByRunId: input.runId,
      lastUsedAt: nowIso,
      startedAt: nowIso,
      stoppedAt: status === "running" || status === "starting" ? null : nowIso,
      stopPolicy: report.stopPolicy ?? null,
      healthStatus,
      reused: false,
    };
  });
}

type StartLocalRuntimeServiceInput = {
  db?: Db;
  runId: string;
  leaseRunId?: string | null;
  startedByRunId?: string | null;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  adapterEnv: Record<string, string>;
  service: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  reuseKey: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
};

async function spawnLocalRuntimeService(input: StartLocalRuntimeServiceInput): Promise<LocalRuntimeServiceStart> {
  const leaseRunId = input.leaseRunId === undefined ? input.runId : input.leaseRunId;
  const startedByRunId = input.startedByRunId === undefined ? input.runId : input.startedByRunId;
  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  const serviceName = identity.serviceName;
  const lifecycle = identity.lifecycle;
  const command = identity.command;
  if (!command) throw new Error(`Runtime service "${serviceName}" is missing command`);
  const portConfig = parseObject(input.service.port);
  const envConfig = identity.envConfig;
  const envFingerprint = identity.envFingerprint;
  const serviceIdentityFingerprint = input.reuseKey ?? envFingerprint;
  const explicitPort = identity.explicitPort;
  const identityPort = identity.identityPort;
  const stoppedReuseCandidate = await findStoppedRuntimeServiceReuseCandidate({
    db: input.db,
    companyId: input.agent.companyId,
    reuseKey: input.reuseKey,
    serviceName,
    command,
    cwd: identity.serviceCwd,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  let reusableStoppedPort: number | null = null;
  if (asString(portConfig.type, "") === "auto" && stoppedReuseCandidate?.port) {
    const ownerPid = await readLocalServicePortOwner(stoppedReuseCandidate.port);
    reusableStoppedPort = ownerPid ? null : stoppedReuseCandidate.port;
  }
  const port =
    asString(portConfig.type, "") === "auto"
      ? (reusableStoppedPort ?? await allocatePort())
      : explicitPort > 0
        ? explicitPort
        : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port,
  });
  const serviceCwd =
    port === identityPort
      ? identity.serviceCwd
      : resolveConfiguredPath(renderTemplate(asString(input.service.cwd, "."), templateData), input.workspace.cwd);
  const env: Record<string, string> = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
  } as Record<string, string>;
  for (const [key, value] of Object.entries(renderRuntimeServiceEnv({ envConfig, templateData }))) {
    env[key] = value;
  }
  if (port) {
    const portEnvKey = asString(portConfig.envKey, "PORT");
    env[portEnvKey] = String(port);
  }

  const expose = parseObject(input.service.expose);
  const readiness = parseObject(input.service.readiness);
  const urlTemplate =
    asString(expose.urlTemplate, "") ||
    asString(readiness.urlTemplate, "");
  const url = urlTemplate ? renderTemplate(urlTemplate, templateData) : null;
  const readinessUrlTemplate = asString(readiness.urlTemplate, "");
  const readinessUrl = readinessUrlTemplate ? renderTemplate(readinessUrlTemplate, templateData) : null;
  const stopPolicy = parseObject(input.service.stopPolicy);
  const serviceKey = createLocalServiceKey({
    profileKind: "workspace-runtime",
    serviceName,
    cwd: serviceCwd,
    command,
    envFingerprint: serviceIdentityFingerprint,
    port: identityPort,
    scope: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      reuseKey: input.reuseKey,
    },
  });
  const adoptedRecord = await findAdoptableLocalService({
    serviceKey,
    profileKind: "workspace-runtime",
    serviceName,
    command,
    cwd: serviceCwd,
    envFingerprint: serviceIdentityFingerprint,
    port: port ?? identityPort,
    url,
  });
  if (adoptedRecord) {
    const adoptedUrl = adoptedRecord.url ?? url;
    if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, { serviceName, command }))) {
      await terminateLocalService(adoptedRecord);
      await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
    } else {
      return {
        record: {
          id: adoptedRecord.runtimeServiceId ?? randomUUID(),
          companyId: input.agent.companyId,
          projectId: input.workspace.projectId,
          projectWorkspaceId: input.workspace.workspaceId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issue?.id ?? null,
          serviceName,
          status: "running",
          lifecycle,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          reuseKey: input.reuseKey,
          command,
          cwd: serviceCwd,
          port: adoptedRecord.port ?? port,
          url: adoptedRecord.url ?? url,
          provider: "local_process",
          providerRef: String(adoptedRecord.pid),
          ownerAgentId: input.agent.id ?? null,
          startedByRunId,
          lastUsedAt: new Date().toISOString(),
          startedAt: adoptedRecord.startedAt,
          stoppedAt: null,
          stopPolicy,
          healthStatus: "healthy",
          reused: true,
          db: input.db,
          child: null,
          leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
          idleTimer: null,
          envFingerprint,
          serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
        },
        readiness: Promise.resolve(),
      };
    }
  }
  if (identityPort) {
      const ownerPid = await readLocalServicePortOwner(identityPort);
    if (ownerPid) {
      const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
      const ownerIsInWorkspace = ownerCwd
        ? await isLocalServiceProcessInWorkspace(ownerCwd, serviceCwd)
        : null;
      const ownerDescription = ownerCwd ? `pid ${ownerPid} (cwd: ${ownerCwd})` : `pid ${ownerPid} (cwd unavailable)`;
      if (ownerIsInWorkspace === false) {
        throw new Error(
          `Runtime service "${serviceName}" could not start because port ${identityPort} has a cross-workspace port conflict with ${ownerDescription}; requested workspace: ${serviceCwd}. Stop the other service or configure a different port.`,
        );
      }
      throw new Error(
        `Runtime service "${serviceName}" could not start because port ${identityPort} is already in use by ${ownerDescription}`,
      );
    }
  }

  await ensureServerWorkspaceLinksCurrent(serviceCwd, {
    onLog: input.onLog,
  });

  const shell = resolveShell();
  const child = spawn(shell, ["-lc", command], {
    cwd: serviceCwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      reject(err);
    });
  });
  let stderrExcerpt = "";
  let stdoutExcerpt = "";
  child.stdout?.on("data", async (chunk) => {
    const text = String(chunk);
    stdoutExcerpt = (stdoutExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stdout", `[service:${serviceName}] ${text}`);
  });
  child.stderr?.on("data", async (chunk) => {
    const text = String(chunk);
    stderrExcerpt = (stderrExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stderr", `[service:${serviceName}] ${text}`);
  });

  const nowIso = new Date().toISOString();
  const record: RuntimeServiceRecord = {
    id: stoppedReuseCandidate?.id ?? randomUUID(),
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    issueId: input.issue?.id ?? null,
    serviceName,
    status: "starting",
    lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command,
    cwd: serviceCwd,
    port,
    url,
    provider: "local_process",
    providerRef: child.pid ? String(child.pid) : null,
    ownerAgentId: input.agent.id ?? null,
    startedByRunId,
    lastUsedAt: nowIso,
    startedAt: nowIso,
    stoppedAt: null,
    stopPolicy,
    healthStatus: "unknown",
    reused: false,
    db: input.db,
    child,
    leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
    idleTimer: null,
    envFingerprint,
    serviceKey,
    profileKind: "workspace-runtime",
    processGroupId: child.pid ?? null,
  };

  if (child.pid) {
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey,
      profileKind: "workspace-runtime",
      serviceName,
      command,
      cwd: serviceCwd,
      envFingerprint: serviceIdentityFingerprint,
      port,
      url,
      pid: child.pid,
      processGroupId: child.pid,
      provider: "local_process",
      runtimeServiceId: record.id,
      reuseKey: input.reuseKey,
      startedAt: record.startedAt,
      lastSeenAt: record.lastUsedAt,
      metadata: {
        projectId: record.projectId,
        projectWorkspaceId: record.projectWorkspaceId,
        executionWorkspaceId: record.executionWorkspaceId,
        issueId: record.issueId,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
      },
    });
  }

  const readinessPromise = Promise.race([
    waitForReadiness({ service: input.service, serviceName, command, url, readinessUrl }),
    spawnErrorPromise,
  ]).then(async () => {
    record.status = "running";
    record.healthStatus = "healthy";
    record.lastUsedAt = new Date().toISOString();
    record.stoppedAt = null;
    await touchLocalServiceRegistryRecord(record.serviceKey, {
      runtimeServiceId: record.id,
      lastSeenAt: record.lastUsedAt,
    });
  }).catch(async (err) => {
    terminateChildProcess(child);
    record.status = "stopped";
    record.healthStatus = "unhealthy";
    record.lastUsedAt = new Date().toISOString();
    record.stoppedAt = new Date().toISOString();
    await removeLocalServiceRegistryRecord(record.serviceKey).catch(() => undefined);
    throw new Error(
      `Failed to start runtime service "${serviceName}": ${err instanceof Error ? err.message : String(err)}${stderrExcerpt ? ` | stderr: ${stderrExcerpt.trim()}` : ""}`,
    );
  });

  return { record, readiness: readinessPromise };
}

async function startLocalRuntimeService(input: StartLocalRuntimeServiceInput): Promise<RuntimeServiceRecord> {
  const started = await spawnLocalRuntimeService(input);
  await started.readiness;
  return started.record;
}

function scheduleIdleStop(record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const stopType = asString(record.stopPolicy?.type, "manual");
  if (stopType !== "idle_timeout") return;
  const idleSeconds = Math.max(1, asNumber(record.stopPolicy?.idleSeconds, 1800));
  record.idleTimer = setTimeout(() => {
    stopRuntimeService(record.id).catch(() => undefined);
  }, idleSeconds * 1000);
}

async function stopRuntimeService(serviceId: string) {
  const record = runtimeServicesById.get(serviceId);
  if (!record) return;
  clearIdleTimer(record);
  record.status = "stopped";
  record.healthStatus = "unknown";
  record.lastUsedAt = new Date().toISOString();
  record.stoppedAt = new Date().toISOString();
  runtimeServicesById.delete(serviceId);
  if (record.reuseKey && runtimeServicesByReuseKey.get(record.reuseKey) === record.id) {
    runtimeServicesByReuseKey.delete(record.reuseKey);
  }
  if (record.child && record.child.pid) {
    await terminateLocalService({
      pid: record.child.pid,
      processGroupId: record.processGroupId ?? record.child.pid,
    });
  } else if (record.providerRef) {
    const pid = Number.parseInt(record.providerRef, 10);
    if (Number.isInteger(pid) && pid > 0) {
      await terminateLocalService({
        pid,
        processGroupId: record.processGroupId,
      });
    }
  }
  await removeLocalServiceRegistryRecord(record.serviceKey);
  await persistRuntimeServiceRecord(record.db, record);
}

async function markPersistedRuntimeServicesStoppedForExecutionWorkspace(input: {
  db: Db;
  executionWorkspaceId: string;
}) {
  const now = new Date();
  await input.db
    .update(workspaceRuntimeServices)
    .set({
      status: "stopped",
      healthStatus: "unknown",
      stoppedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
        inArray(workspaceRuntimeServices.status, ["starting", "running"]),
      ),
    );
}

function registerRuntimeService(db: Db | undefined, record: RuntimeServiceRecord) {
  record.db = db;
  runtimeServicesById.set(record.id, record);
  if (record.reuseKey) {
    runtimeServicesByReuseKey.set(record.reuseKey, record.id);
  }

  record.child?.on("exit", (code, signal) => {
    const current = runtimeServicesById.get(record.id);
    if (!current) return;
    clearIdleTimer(current);
    current.status = code === 0 || signal === "SIGTERM" ? "stopped" : "failed";
    current.healthStatus = current.status === "failed" ? "unhealthy" : "unknown";
    current.lastUsedAt = new Date().toISOString();
    current.stoppedAt = new Date().toISOString();
    runtimeServicesById.delete(current.id);
    if (current.reuseKey && runtimeServicesByReuseKey.get(current.reuseKey) === current.id) {
      runtimeServicesByReuseKey.delete(current.reuseKey);
    }
    void removeLocalServiceRegistryRecord(current.serviceKey);
    void persistRuntimeServiceRecord(db, current);
  });
}

function readRuntimeServiceEntries(config: Record<string, unknown>) {
  return listWorkspaceServiceCommandDefinitions(parseObject(config.workspaceRuntime))
    .map((command) => command.rawConfig);
}

export function listConfiguredRuntimeServiceEntries(config: Record<string, unknown>) {
  return readRuntimeServiceEntries(config);
}

function readConfiguredServiceStates(config: Record<string, unknown>) {
  const raw = parseObject(config.serviceStates);
  const states: WorkspaceRuntimeServiceStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === "running" || value === "stopped" || value === "manual") {
      states[key] = value;
    }
  }
  return states;
}

function readDesiredRuntimeState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

export function buildWorkspaceRuntimeDesiredStatePatch(input: {
  config: Record<string, unknown>;
  currentDesiredState: WorkspaceRuntimeDesiredState | null;
  currentServiceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
  action: "start" | "stop" | "restart";
  serviceIndex?: number | null;
}): {
  desiredState: WorkspaceRuntimeDesiredState;
  serviceStates: WorkspaceRuntimeServiceStateMap | null;
} {
  const configuredServices = listConfiguredRuntimeServiceEntries(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.currentDesiredState) ?? "stopped";
  const nextServiceStates: WorkspaceRuntimeServiceStateMap = {};

  for (let index = 0; index < configuredServices.length; index += 1) {
    nextServiceStates[String(index)] = input.currentServiceStates?.[String(index)] ?? fallbackState;
  }

  const nextState: WorkspaceRuntimeDesiredState = input.action === "stop" ? "stopped" : "running";
  const applyActionState = (index: number) => {
    const key = String(index);
    // Manual services are intentionally left under operator control even when
    // an API action targets that individual service.
    if (nextServiceStates[key] === "manual") return;
    nextServiceStates[key] = nextState;
  };
  if (input.serviceIndex === undefined || input.serviceIndex === null) {
    for (let index = 0; index < configuredServices.length; index += 1) {
      applyActionState(index);
    }
  } else if (input.serviceIndex >= 0 && input.serviceIndex < configuredServices.length) {
    applyActionState(input.serviceIndex);
  }

  const desiredState = Object.values(nextServiceStates).some((state) => state === "running")
    ? "running"
    : Object.values(nextServiceStates).some((state) => state === "manual")
      ? "manual"
      : "stopped";

  return {
    desiredState,
    serviceStates: Object.keys(nextServiceStates).length > 0 ? nextServiceStates : null,
  };
}

function selectRuntimeServiceEntries(input: {
  config: Record<string, unknown>;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
  defaultDesiredState?: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}) {
  const entries = listConfiguredRuntimeServiceEntries(input.config);
  const states = input.serviceStates ?? readConfiguredServiceStates(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.defaultDesiredState) ?? "stopped";

  return entries.filter((_, index) => {
    if (input.serviceIndex !== undefined && input.serviceIndex !== null) {
      return index === input.serviceIndex;
    }
    if (!input.respectDesiredStates) return true;
    return (states[String(index)] ?? fallbackState) === "running";
  });
}

export async function ensureRuntimeServicesForRun(input: {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    respectDesiredStates: true,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "running",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const acquiredServiceIds: string[] = [];
  const refs: RuntimeServiceRef[] = [];
  runtimeServiceLeasesByRun.set(input.runId, acquiredServiceIds);

  try {
    for (const service of rawServices) {
      const { scopeType, scopeId } = resolveServiceScopeId({
        service,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        issue: input.issue,
        runId: input.runId,
        agent: input.agent,
      });
      const reuseKey = resolveRuntimeServiceReuseIdentity({
        service,
        workspace: input.workspace,
        agent: input.agent,
        issue: input.issue,
        adapterEnv: input.adapterEnv,
        scopeType,
        scopeId,
      }).reuseKey;

      if (reuseKey) {
        const existingId = runtimeServicesByReuseKey.get(reuseKey);
        const existing = existingId ? runtimeServicesById.get(existingId) : null;
        if (existing && existing.status === "running") {
          existing.leaseRunIds.add(input.runId);
          existing.lastUsedAt = new Date().toISOString();
          existing.stoppedAt = null;
          clearIdleTimer(existing);
          void touchLocalServiceRegistryRecord(existing.serviceKey, {
            runtimeServiceId: existing.id,
            lastSeenAt: existing.lastUsedAt,
          });
          await persistRuntimeServiceRecord(input.db, existing);
          acquiredServiceIds.push(existing.id);
          refs.push(toRuntimeServiceRef(existing, { reused: true }));
          continue;
        }
      }

      const record = await startLocalRuntimeService({
        db: input.db,
        runId: input.runId,
        agent: input.agent,
        issue: input.issue,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        adapterEnv: input.adapterEnv,
        service,
        onLog: input.onLog,
        reuseKey,
        scopeType,
        scopeId,
      });
      registerRuntimeService(input.db, record);
      await persistRuntimeServiceRecord(input.db, record);
      acquiredServiceIds.push(record.id);
      refs.push(toRuntimeServiceRef(record));
    }
  } catch (err) {
    await releaseRuntimeServicesForRun(input.runId);
    throw err;
  }

  return refs;
}

type StartRuntimeServicesForWorkspaceControlInput = {
  db?: Db;
  invocationId?: string;
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
};

type WorkspaceControlStartBatch = {
  refs: RuntimeServiceRef[];
  pendingReadiness: LocalRuntimeServiceStart[];
  startedServiceIds: string[];
};

async function startRuntimeServicesForWorkspaceControlUnlocked(
  input: StartRuntimeServicesForWorkspaceControlInput,
  rawServices: Record<string, unknown>[],
  invocationId: string,
  persistenceDb = input.db,
  registryDb = input.db,
  options?: { deferReadiness?: boolean },
): Promise<WorkspaceControlStartBatch> {
  const refs: RuntimeServiceRef[] = [];
  const pendingReadiness: LocalRuntimeServiceStart[] = [];
  const startedServiceIds: string[] = [];

  for (const service of rawServices) {
    const { scopeType, scopeId } = resolveServiceScopeId({
      service,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      issue: input.issue,
      runId: invocationId,
      agent: input.actor,
    });
    const reuseKey = resolveRuntimeServiceReuseIdentity({
      service,
      workspace: input.workspace,
      agent: input.actor,
      issue: input.issue,
      adapterEnv: input.adapterEnv,
      scopeType,
      scopeId,
    }).reuseKey;

    if (reuseKey) {
      const existingId = runtimeServicesByReuseKey.get(reuseKey);
      const existing = existingId ? runtimeServicesById.get(existingId) : null;
      if (existing && existing.status === "running") {
        existing.lastUsedAt = new Date().toISOString();
        existing.stoppedAt = null;
        clearIdleTimer(existing);
        void touchLocalServiceRegistryRecord(existing.serviceKey, {
          runtimeServiceId: existing.id,
          lastSeenAt: existing.lastUsedAt,
        });
        await persistRuntimeServiceRecord(persistenceDb, existing);
        refs.push(toRuntimeServiceRef(existing, { reused: true }));
        continue;
      }
    }

    const startInput: StartLocalRuntimeServiceInput = {
      db: persistenceDb,
      runId: invocationId,
      leaseRunId: null,
      startedByRunId: null,
      agent: input.actor,
      issue: input.issue,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      adapterEnv: input.adapterEnv,
      service,
      onLog: input.onLog,
      reuseKey,
      scopeType,
      scopeId,
    };

    // Manually controlled services are not tied to a heartbeat run lifecycle, so they do not
    // retain a run lease and never persist a startedByRunId foreign key.
    const started = options?.deferReadiness
      ? await spawnLocalRuntimeService(startInput)
      : {
          record: await startLocalRuntimeService(startInput),
          readiness: Promise.resolve(),
        };
    registerRuntimeService(registryDb, started.record);
    await persistRuntimeServiceRecord(persistenceDb, started.record);
    refs.push(toRuntimeServiceRef(started.record));

    if (options?.deferReadiness && !started.record.reused) {
      // Attach a rejection handler immediately; the caller awaits the same promise after
      // the DB transaction commits, but transaction failures may skip that wait path.
      started.readiness.catch(() => undefined);
      pendingReadiness.push(started);
      startedServiceIds.push(started.record.id);
    }
  }

  return { refs, pendingReadiness, startedServiceIds };
}

export async function startRuntimeServicesForWorkspaceControl(
  input: StartRuntimeServicesForWorkspaceControlInput,
): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    serviceIndex: input.serviceIndex,
    respectDesiredStates: input.respectDesiredStates,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "stopped",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const invocationId = input.invocationId ?? randomUUID();

  if (rawServices.length === 0 || !input.db || (!input.executionWorkspaceId && !input.workspace.workspaceId)) {
    const batch = await startRuntimeServicesForWorkspaceControlUnlocked(input, rawServices, invocationId);
    return batch.refs;
  }

  let startBatch: WorkspaceControlStartBatch = {
    refs: [],
    pendingReadiness: [],
    startedServiceIds: [],
  };
  try {
    await input.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;

      if (input.executionWorkspaceId) {
        const [lockedExecutionWorkspace] = await tx
          .select({ id: executionWorkspaces.id })
          .from(executionWorkspaces)
          .where(
            and(
              eq(executionWorkspaces.id, input.executionWorkspaceId),
              eq(executionWorkspaces.companyId, input.actor.companyId),
            ),
          )
          .for("update");
        if (!lockedExecutionWorkspace) throw new Error("Execution workspace not found before starting runtime services");
      }

      if (input.workspace.workspaceId) {
        const [lockedProjectWorkspace] = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, input.workspace.workspaceId),
              eq(projectWorkspaces.companyId, input.actor.companyId),
            ),
          )
          .for("update");
        if (!lockedProjectWorkspace) throw new Error("Project workspace not found before starting runtime services");
      }

      // Branch reconciliation takes these same parent row locks before mutating
      // a recorded branch. Persisting a `starting` service row before commit closes
      // the process-start window without holding the DB transaction for readiness.
      startBatch = await startRuntimeServicesForWorkspaceControlUnlocked(
        { ...input, db: txDb },
        rawServices,
        invocationId,
        txDb,
        input.db,
        { deferReadiness: true },
      );
    });

    for (const pending of startBatch.pendingReadiness) {
      try {
        await pending.readiness;
        await persistRuntimeServiceRecord(input.db, pending.record);
      } catch (error) {
        await persistRuntimeServiceRecord(input.db, pending.record).catch(() => undefined);
        throw error;
      }
    }

    return startBatch.refs.map((ref) => {
      const record = runtimeServicesById.get(ref.id);
      return record ? toRuntimeServiceRef(record, { reused: ref.reused }) : ref;
    });
  } catch (error) {
    for (const serviceId of startBatch.startedServiceIds) {
      await stopRuntimeService(serviceId).catch(() => undefined);
    }
    throw error;
  }
}

export async function releaseRuntimeServicesForRun(runId: string) {
  const acquired = runtimeServiceLeasesByRun.get(runId) ?? [];
  runtimeServiceLeasesByRun.delete(runId);
  for (const serviceId of acquired) {
    const record = runtimeServicesById.get(serviceId);
    if (!record) continue;
    record.leaseRunIds.delete(runId);
    record.lastUsedAt = new Date().toISOString();
    const stopType = asString(record.stopPolicy?.type, record.lifecycle === "ephemeral" ? "on_run_finish" : "manual");
    await persistRuntimeServiceRecord(record.db, record);
    if (record.leaseRunIds.size === 0) {
      if (record.lifecycle === "ephemeral" || stopType === "on_run_finish") {
        await stopRuntimeService(serviceId);
        continue;
      }
      scheduleIdleStop(record);
    }
  }
}

export async function stopRuntimeServicesForExecutionWorkspace(input: {
  db?: Db;
  executionWorkspaceId: string;
  workspaceCwd?: string | null;
  runtimeServiceId?: string | null;
}) {
  const normalizedWorkspaceCwd = input.workspaceCwd ? path.resolve(input.workspaceCwd) : null;
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      if (record.executionWorkspaceId === input.executionWorkspaceId) return true;
      if (!normalizedWorkspaceCwd || !record.cwd) return false;
      const resolvedCwd = path.resolve(record.cwd);
      return (
        resolvedCwd === normalizedWorkspaceCwd ||
        resolvedCwd.startsWith(`${normalizedWorkspaceCwd}${path.sep}`)
      );
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId);
  }

  if (input.db) {
    if (input.runtimeServiceId) {
      const now = new Date();
      await input.db
        .update(workspaceRuntimeServices)
        .set({
          status: "stopped",
          healthStatus: "unknown",
          stoppedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
    } else {
      await markPersistedRuntimeServicesStoppedForExecutionWorkspace({
        db: input.db,
        executionWorkspaceId: input.executionWorkspaceId,
      });
    }
  }
}

export async function stopRuntimeServicesForProjectWorkspace(input: {
  db?: Db;
  projectWorkspaceId: string;
  runtimeServiceId?: string | null;
}) {
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      return record.projectWorkspaceId === input.projectWorkspaceId && record.scopeType === "project_workspace";
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId);
  }

  if (input.db) {
    const now = new Date();
    await input.db
      .update(workspaceRuntimeServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(
        input.runtimeServiceId
          ? eq(workspaceRuntimeServices.id, input.runtimeServiceId)
          : and(
              eq(workspaceRuntimeServices.projectWorkspaceId, input.projectWorkspaceId),
              eq(workspaceRuntimeServices.scopeType, "project_workspace"),
              inArray(workspaceRuntimeServices.status, ["starting", "running"]),
            ),
      );
  }
}

export async function listWorkspaceRuntimeServicesForProjectWorkspaces(
  db: Db,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId);
    if (existing) existing.push(row);
    else grouped.set(row.projectWorkspaceId, [row]);
  }
  return grouped;
}

export async function reconcilePersistedRuntimeServicesOnStartup(db: Db) {
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["starting", "running", "stopped"]),
      ),
    );

  if (rows.length === 0) return { reconciled: 0, adopted: 0, stopped: 0 };

  let reconciled = 0;
  let adopted = 0;
  let stopped = 0;
  for (const row of rows) {
    let adoptedRecord = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (
      adoptedRecord
      && (
        adoptedRecord.command !== row.command
        || adoptedRecord.serviceName !== row.serviceName
        || adoptedRecord.envFingerprint !== (row.reuseKey ?? "")
        || adoptedRecord.port !== (row.port ?? null)
        || (row.cwd !== null && path.resolve(adoptedRecord.cwd) !== path.resolve(row.cwd))
      )
    ) {
      await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
      adoptedRecord = null;
    }
    if (!adoptedRecord && row.command && row.cwd) {
      adoptedRecord = await findAdoptableLocalService({
        serviceKey: createLocalServiceKey({
          profileKind: "workspace-runtime",
          serviceName: row.serviceName,
          cwd: row.cwd,
          command: row.command,
          envFingerprint: row.reuseKey ?? "",
          port: null,
          scope: {
            scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
            scopeId: row.scopeId ?? null,
            executionWorkspaceId: row.executionWorkspaceId ?? null,
            reuseKey: row.reuseKey ?? null,
          },
        }),
        profileKind: "workspace-runtime",
        serviceName: row.serviceName,
        command: row.command,
        cwd: row.cwd,
        envFingerprint: row.reuseKey ?? "",
        port: row.port ?? null,
        url: row.url ?? null,
      });
    }
    if (adoptedRecord) {
      const adoptedUrl = adoptedRecord.url ?? row.url ?? null;
      if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, { serviceName: row.serviceName, command: row.command }))) {
        await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
      } else {
        const record: RuntimeServiceRecord = {
          id: row.id,
          companyId: row.companyId,
          projectId: row.projectId ?? null,
          projectWorkspaceId: row.projectWorkspaceId ?? null,
          executionWorkspaceId: row.executionWorkspaceId ?? null,
          issueId: row.issueId ?? null,
          serviceName: row.serviceName,
          status: "running",
          lifecycle: row.lifecycle as RuntimeServiceRecord["lifecycle"],
          scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
          scopeId: row.scopeId ?? null,
          reuseKey: row.reuseKey ?? null,
          command: row.command ?? null,
          cwd: row.cwd ?? null,
          port: adoptedRecord.port ?? row.port ?? null,
          url: adoptedRecord.url ?? row.url ?? null,
          provider: "local_process",
          providerRef: String(adoptedRecord.pid),
          ownerAgentId: row.ownerAgentId ?? null,
          startedByRunId: row.startedByRunId ?? null,
          lastUsedAt: new Date().toISOString(),
          startedAt: row.startedAt.toISOString(),
          stoppedAt: null,
          stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
          healthStatus: "healthy",
          reused: true,
          db,
          child: null,
          leaseRunIds: new Set(),
          idleTimer: null,
          envFingerprint: row.reuseKey ?? "",
          serviceKey: adoptedRecord.serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
        };
        registerRuntimeService(db, record);
        await touchLocalServiceRegistryRecord(adoptedRecord.serviceKey, {
          runtimeServiceId: row.id,
          lastSeenAt: record.lastUsedAt,
        });
        await persistRuntimeServiceRecord(db, record);
        reconciled += 1;
        adopted += 1;
        continue;
      }
    }

    if (row.status === "stopped") {
      continue;
    }

    const now = new Date();
    await db
      .update(workspaceRuntimeServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(workspaceRuntimeServices.id, row.id));
    const registryRecord = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (registryRecord) {
      await removeLocalServiceRegistryRecord(registryRecord.serviceKey);
    }
    reconciled += 1;
    stopped += 1;
  }

  return { reconciled, adopted, stopped };
}

export async function restartDesiredRuntimeServicesOnStartup(db: Db) {
  let restarted = 0;
  let failed = 0;

  const projectWorkspaceRows = await db
    .select()
    .from(projectWorkspaces);
  const projectWorkspaceRowsById = new Map(projectWorkspaceRows.map((row) => [row.id, row] as const));

  for (const row of projectWorkspaceRows) {
    const runtimeConfig = readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null);
    if (runtimeConfig?.desiredState !== "running" || !runtimeConfig.workspaceRuntime || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: null,
        workspace: {
          baseCwd: row.cwd,
          source: "project_primary",
          projectId: row.projectId,
          workspaceId: row.id,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.repoRef ?? null,
          strategy: "project_primary",
          cwd: row.cwd,
          branchName: row.defaultRef ?? row.repoRef ?? null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: runtimeConfig.workspaceRuntime,
          desiredState: runtimeConfig.desiredState,
          serviceStates: runtimeConfig.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  const executionWorkspaceRows = await db
    .select()
    .from(executionWorkspaces)
    .where(inArray(executionWorkspaces.status, ["active", "idle", "in_review", "cleanup_failed"]));

  for (const row of executionWorkspaceRows) {
    const config = readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null);
    const inheritedRuntimeConfig = row.projectWorkspaceId
      ? readProjectWorkspaceRuntimeConfig(
          (projectWorkspaceRowsById.get(row.projectWorkspaceId)?.metadata as Record<string, unknown> | null) ?? null,
        )?.workspaceRuntime ?? null
      : null;
    const effectiveRuntimeConfig = config?.workspaceRuntime ?? inheritedRuntimeConfig;
    if (config?.desiredState !== "running" || !effectiveRuntimeConfig || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: row.sourceIssueId
          ? {
              id: row.sourceIssueId,
              identifier: null,
              title: row.name,
            }
          : null,
        workspace: {
          baseCwd: row.cwd,
          source: row.mode === "shared_workspace" ? "project_primary" : "task_session",
          projectId: row.projectId,
          workspaceId: row.projectWorkspaceId ?? null,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.baseRef ?? null,
          strategy: row.strategyType === "git_worktree" ? "git_worktree" : "project_primary",
          cwd: row.cwd,
          branchName: row.branchName ?? null,
          worktreePath: row.strategyType === "git_worktree" ? row.cwd : null,
          warnings: [],
          created: false,
        },
        executionWorkspaceId: row.id,
        config: {
          workspaceRuntime: effectiveRuntimeConfig,
          desiredState: config.desiredState,
          serviceStates: config.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  return { restarted, failed };
}

export async function persistAdapterManagedRuntimeServices(input: {
  db: Db;
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
}) {
  const refs = normalizeAdapterManagedRuntimeServices(input);
  if (refs.length === 0) return refs;

  const existingRows = await input.db
    .select()
    .from(workspaceRuntimeServices)
    .where(inArray(workspaceRuntimeServices.id, refs.map((ref) => ref.id)));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const ref of refs) {
    const existing = existingById.get(ref.id);
    const startedAt = existing?.startedAt ?? new Date(ref.startedAt);
    const createdAt = existing?.createdAt ?? new Date();
    await input.db
      .insert(workspaceRuntimeServices)
      .values({
        id: ref.id,
        companyId: ref.companyId,
        projectId: ref.projectId,
        projectWorkspaceId: ref.projectWorkspaceId,
        executionWorkspaceId: ref.executionWorkspaceId,
        issueId: ref.issueId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        serviceName: ref.serviceName,
        status: ref.status,
        lifecycle: ref.lifecycle,
        reuseKey: ref.reuseKey,
        command: ref.command,
        cwd: ref.cwd,
        port: ref.port,
        url: ref.url,
        provider: ref.provider,
        providerRef: ref.providerRef,
        ownerAgentId: ref.ownerAgentId,
        startedByRunId: ref.startedByRunId,
        lastUsedAt: new Date(ref.lastUsedAt),
        startedAt,
        stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
        stopPolicy: ref.stopPolicy,
        healthStatus: ref.healthStatus,
        createdAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceRuntimeServices.id,
        set: {
          projectId: ref.projectId,
          projectWorkspaceId: ref.projectWorkspaceId,
          executionWorkspaceId: ref.executionWorkspaceId,
          issueId: ref.issueId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          serviceName: ref.serviceName,
          status: ref.status,
          lifecycle: ref.lifecycle,
          reuseKey: ref.reuseKey,
          command: ref.command,
          cwd: ref.cwd,
          port: ref.port,
          url: ref.url,
          provider: ref.provider,
          providerRef: ref.providerRef,
          ownerAgentId: ref.ownerAgentId,
          startedByRunId: ref.startedByRunId,
          lastUsedAt: new Date(ref.lastUsedAt),
          startedAt,
          stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
          stopPolicy: ref.stopPolicy,
          healthStatus: ref.healthStatus,
          updatedAt: new Date(),
        },
      });
  }

  return refs;
}

export function buildWorkspaceReadyComment(input: {
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
}) {
  const lines = ["## Workspace Ready", ""];
  lines.push(`- Strategy: \`${input.workspace.strategy}\``);
  if (input.workspace.branchName) lines.push(`- Branch: \`${input.workspace.branchName}\``);
  lines.push(`- CWD: \`${input.workspace.cwd}\``);
  if (input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd) {
    lines.push(`- Worktree: \`${input.workspace.worktreePath}\``);
  }
  for (const warning of input.workspace.warnings) {
    lines.push(`- Warning: ${warning}`);
  }
  for (const service of input.runtimeServices) {
    const detail = service.url ? `${service.serviceName}: ${service.url}` : `${service.serviceName}: running`;
    const suffix = service.reused ? " (reused)" : "";
    lines.push(`- Service: ${detail}${suffix}`);
  }
  return lines.join("\n");
}
