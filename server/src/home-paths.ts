import path from "node:path";
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
import {
  expandHomePrefix,
  resolveDefaultBackupDir as resolveSharedDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir as resolveSharedDefaultEmbeddedPostgresDir,
  resolveDefaultHeapSnapshotDir as resolveSharedDefaultHeapSnapshotDir,
  resolveDefaultLogsDir as resolveSharedDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath as resolveSharedDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir as resolveSharedDefaultStorageDir,
  resolveHomeAwarePath,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "@paperclipai/shared/home-paths";

export {
  expandHomePrefix,
  resolveHomeAwarePath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
};

export function resolveDefaultConfigPath(): string {
  return resolvePaperclipConfigPathForInstance();
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return resolveSharedDefaultEmbeddedPostgresDir();
}

export function resolveDefaultLogsDir(): string {
  return resolveSharedDefaultLogsDir();
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return resolveSharedDefaultSecretsKeyFilePath();
}

export function resolveDefaultStorageDir(): string {
  return resolveSharedDefaultStorageDir();
}

export function resolveDefaultBackupDir(): string {
  return resolveSharedDefaultBackupDir();
}

export function resolveDefaultHeapSnapshotDir(): string {
  return resolveSharedDefaultHeapSnapshotDir();
}

export function resolveDefaultAgentWorkspaceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(), "workspaces", trimmed);
}

// BLO-18760: repo-less source checkout for k8s per-run isolation.
//
// The per-agent workspace dir above is persistent and accumulates a real
// `.git` from unrelated prior runs. claude_k8s pods bootstrap by
// `git clone --shared`-ing from their resolved cwd, so an issue with no
// project/session workspace lands on that dirty directory and either exits
// 128 under cephfs pressure or (post-BLO-18147) is refused dispatch outright.
//
// This is a deliberate SIBLING of "workspaces/", never a child: git resolves a
// repository by walking *up* the tree, so nesting this under the agent home
// would make `rev-parse --verify HEAD` succeed against the parent and defeat
// the whole point. Nothing writes here — under `run` isolation the pod's
// workspace/home/session/cache roots all live in the ephemeral
// /runtime-cache/paperclip-runs/<runId> tree and this path is only ever read
// as a clone source — so one stable dir per agent stays empty and avoids
// leaking an inode per run.
export function resolveAgentEmptyWorkspaceSourceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(), "empty-workspaces", trimmed);
}

/**
 * Is `cwd` one of the two WORKSPACE-LESS fallback directories above — i.e. a
 * directory the run is *expected* to find empty and repo-less, rather than one
 * the server materialized a checkout into?
 *
 * PEN-5234 (PEN-4932 invariant 9). The server realizes every execution
 * workspace onto its OWN `/paperclip` mount. Once a Job's `data` claim is the
 * agent's own rather than the server's, that tree is on a volume the pod does
 * not mount, so the pod's identically-spelled path resolves to nothing. The
 * adapter has to refuse such a dispatch — but only for a run that was supposed
 * to find content there. A run that resolved no project and no session is
 * handed one of these two directories precisely BECAUSE it is empty, and that
 * expectation is satisfied on a per-agent claim exactly as it is on the
 * server's own. This predicate is the discriminator between the two.
 *
 * It lives here, beside both producers, for the reason the adapter's
 * `readOnlyInstructionsRoot` gives: a second derivation of a path is free to
 * drift from the first, and the permissive direction of that drift is a run
 * dispatched onto a tree that is not there.
 *
 * Keyed on the PATH, never on the resolver's `source` label, for the reason
 * BLO-18760 already records at the dispatch guard: only the FIRST
 * workspace-less run carries `source: "agent_home"`. That cwd is persisted
 * into the task session, so every resume resolves it back as
 * `source: "task_session"` while naming the identical directory. A label test
 * would therefore clear run 1 and refuse runs 2..n of the same stateless
 * agent. The converse leak is just as real: a `local_path` project workspace
 * keeps `source: "project_primary"` with `repoUrl: null` and `workspaceId:
 * null`, so neither of those fields separates the two cases either.
 *
 * A malformed agent id PROPAGATES the producers' throw rather than being
 * swallowed into `false`, and deliberately: both call sites already resolve
 * one of these directories for the same id moments earlier (the BLO-18760
 * dispatch guard, and `buildPaperclipWorkspaceContext`'s own `agentHome`), so
 * swallowing adds no robustness and only moves an unusable id's failure later.
 */
export function isWorkspaceLessFallbackWorkspaceDir(
  cwd: string | null | undefined,
  agentId: string,
): boolean {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) return false;
  const resolvedCwd = path.resolve(trimmedCwd);
  return [resolveDefaultAgentWorkspaceDir, resolveAgentEmptyWorkspaceSourceDir].some(
    (produce) => path.resolve(produce(agentId)) === resolvedCwd,
  );
}

function sanitizeFriendlyPathSegment(value: string | null | undefined, fallback = "_default"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(FRIENDLY_PATH_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

export function resolveManagedProjectWorkspaceDir(input: {
  companyId: string;
  projectId: string;
  repoName?: string | null;
}): string {
  const companyId = input.companyId.trim();
  const projectId = input.projectId.trim();
  if (!companyId || !projectId) {
    throw new Error("Managed project workspace path requires companyId and projectId.");
  }
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "projects",
    sanitizeFriendlyPathSegment(companyId, "company"),
    sanitizeFriendlyPathSegment(projectId, "project"),
    sanitizeFriendlyPathSegment(input.repoName, "_default"),
  );
}
