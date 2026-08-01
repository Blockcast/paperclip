/**
 * Ownership guards for linked git worktrees in a shared managed checkout.
 *
 * Concurrent runs share one repository, so they also share one worktree
 * registry (`$GIT_DIR/worktrees`). `git worktree prune` is repo-global and has
 * no notion of who owns an entry: it deletes the administrative files of *any*
 * registration whose working directory is not currently readable. A run whose
 * worktree lives on a path the pruning process cannot see — a different mount
 * namespace, a tmpfs, a not-yet-remounted volume — therefore loses its
 * registration to an unrelated run, while its validated-but-uncommitted edits
 * are still sitting on disk (BLO-19607).
 *
 * Git already ships the primitive for this: a *locked* worktree is skipped by
 * `git worktree prune` and refused by a single-`--force` `git worktree remove`.
 * We stamp every runtime-created worktree with a lock whose reason encodes the
 * owning execution workspace and run, which turns the lock into an ownership
 * record we can read back. Destructive cleanup then has to prove the entry is
 * ours before it touches anything, and anything ambiguous is reported instead
 * of removed.
 */

import fs from "node:fs/promises";

/** Marker that identifies a lock reason as one of ours. */
export const WORKTREE_OWNER_LOCK_PREFIX = "paperclip-owned";

async function directoryExists(value: string): Promise<boolean> {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

/**
 * Ownership is keyed on branch when no persisted execution workspace id is
 * available: git already refuses to check the same branch out in two linked
 * worktrees, so a branch names exactly one registration. When the workspace id
 * is known, it is also accepted as ownership proof so cleanup survives branch
 * drift or missing branch metadata. The run id rides along as audit metadata so
 * an operator reading a lock can tell who took it.
 */
export type GitWorktreeOwnerToken = {
  branchName: string;
  executionWorkspaceId: string | null;
  runId: string | null;
};

export type GitWorktreeRegistration = {
  worktree: string;
  branch: string | null;
  locked: boolean;
  /** Lock reason verbatim, or null when locked without a reason. */
  lockReason: string | null;
  /** Git considers the entry stale: its working directory is not readable. */
  prunable: boolean;
  prunableReason: string | null;
};

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * Lock reasons round-trip through `git worktree list --porcelain`, which is a
 * line-oriented format. Any newline in a token would be parsed back as a
 * separate porcelain field, so tokens are flattened to a single line.
 */
function sanitizeTokenField(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatWorktreeOwnerLockReason(token: GitWorktreeOwnerToken): string {
  const branch = sanitizeTokenField(token.branchName);
  const workspace = sanitizeTokenField(token.executionWorkspaceId ?? "");
  const run = sanitizeTokenField(token.runId ?? "");
  return `${WORKTREE_OWNER_LOCK_PREFIX} branch=${branch || "-"} `
    + `workspace=${workspace || "-"} run=${run || "-"}`;
}

export function parseWorktreeOwnerLockReason(reason: string | null | undefined): GitWorktreeOwnerToken | null {
  const trimmed = (reason ?? "").trim();
  if (!trimmed.startsWith(`${WORKTREE_OWNER_LOCK_PREFIX} `)) return null;

  const fields = new Map<string, string>();
  for (const token of trimmed.slice(WORKTREE_OWNER_LOCK_PREFIX.length + 1).split(/\s+/)) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex <= 0) continue;
    fields.set(token.slice(0, separatorIndex), token.slice(separatorIndex + 1));
  }

  const read = (field: string): string | null => {
    const value = fields.get(field) ?? "";
    return value && value !== "-" ? value : null;
  };

  const branchName = read("branch");
  if (!branchName) return null;

  return {
    branchName,
    executionWorkspaceId: read("workspace"),
    runId: read("run"),
  };
}

/**
 * Parses `git worktree list --porcelain`, retaining the `locked` and
 * `prunable` attributes that the ownership checks depend on. Both attributes
 * appear either bare or with a trailing reason.
 */
export function parseGitWorktreeRegistrations(raw: string): GitWorktreeRegistration[] {
  const entries: GitWorktreeRegistration[] = [];
  let current: GitWorktreeRegistration | null = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        worktree: line.slice("worktree ".length).trim(),
        branch: null,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim() || null;
      continue;
    }
    if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked".length).trim() || null;
      continue;
    }
    if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
      current.prunableReason = line.slice("prunable".length).trim() || null;
      continue;
    }
    if (line === "") flush();
  }
  flush();

  return entries;
}

export type WorktreeOwnershipVerdict =
  /** The entry carries our token: destructive cleanup is authorized. */
  | { kind: "owned" }
  /** The entry carries a different branch's token: never touch it. */
  | { kind: "owned_by_other"; owner: GitWorktreeOwnerToken }
  /** Unlocked, so we cannot prove who created it. */
  | { kind: "unowned" }
  /** Locked by something outside Paperclip (a human, another tool). */
  | { kind: "foreign_lock"; lockReason: string | null }
  /** We hold no branch identity, so we cannot assert ownership of anything. */
  | { kind: "indeterminate" };

export function classifyWorktreeOwnership(
  registration: Pick<GitWorktreeRegistration, "locked" | "lockReason" | "branch">,
  expected: GitWorktreeOwnerToken,
): WorktreeOwnershipVerdict {
  const expectedBranch = sanitizeTokenField(expected.branchName);
  const expectedWorkspaceId = sanitizeTokenField(expected.executionWorkspaceId ?? "");
  if (!expectedBranch && !expectedWorkspaceId) return { kind: "indeterminate" };

  if (!registration.locked) {
    // Worktrees created before ownership stamping carry no lock. Refusing to
    // ever clean those up would leak every pre-upgrade workspace, so a legacy
    // entry is adopted when it is checked out on the branch we own — the
    // caller has already matched it by path, and git permits a branch in only
    // one worktree, so path plus branch is sufficient evidence.
    const branch = (registration.branch ?? "").replace(/^refs\/heads\//, "");
    if (expectedBranch && branch === expectedBranch) return { kind: "owned" };
    return expectedBranch ? { kind: "unowned" } : { kind: "indeterminate" };
  }

  const owner = parseWorktreeOwnerLockReason(registration.lockReason);
  if (!owner) return { kind: "foreign_lock", lockReason: registration.lockReason };
  if (expectedWorkspaceId && owner.executionWorkspaceId === expectedWorkspaceId) return { kind: "owned" };
  if (expectedBranch && owner.branchName === expectedBranch) return { kind: "owned" };
  return { kind: "owned_by_other", owner };
}

async function refreshOwnedGitWorktreeLockReason(input: {
  git: GitRunner;
  repoRoot: string;
  worktreePath: string;
  newReason: string;
  previousReason: string | null;
}): Promise<{ locked: boolean; warnings: string[] }> {
  try {
    await input.git(["worktree", "unlock", input.worktreePath], input.repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      locked: true,
      warnings: [
        `Git worktree "${input.worktreePath}" is owned, but its ownership metadata could not be refreshed (${message}).`,
      ],
    };
  }

  try {
    await input.git(["worktree", "lock", "--reason", input.newReason, input.worktreePath], input.repoRoot);
    return { locked: true, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let relocked = false;
    let relockMessage: string | null = null;
    try {
      if (input.previousReason) {
        await input.git(["worktree", "lock", "--reason", input.previousReason, input.worktreePath], input.repoRoot);
      } else {
        await input.git(["worktree", "lock", input.worktreePath], input.repoRoot);
      }
      relocked = true;
    } catch (relockError) {
      relockMessage = relockError instanceof Error ? relockError.message : String(relockError);
    }

    return {
      locked: relocked,
      warnings: [
        relocked
          ? `Git worktree "${input.worktreePath}" is owned, but its ownership metadata could not be refreshed (${message}); kept the previous lock reason.`
          : `Git worktree "${input.worktreePath}" is owned, but its ownership metadata could not be refreshed (${message}) and the previous lock could not be restored (${relockMessage ?? "unknown error"}). Another run's prune may reclaim its registration.`,
      ],
    };
  }
}

function describeOwner(owner: GitWorktreeOwnerToken): string {
  const parts = [`branch ${owner.branchName}`];
  if (owner.executionWorkspaceId) parts.push(`execution workspace ${owner.executionWorkspaceId}`);
  if (owner.runId) parts.push(`run ${owner.runId}`);
  return parts.join(", ");
}

/**
 * Builds the auditable record for a registration we declined to touch. Every
 * non-destructive branch routes through here so the operator-visible reason is
 * uniform across the prune and teardown paths.
 */
function describeDeclinedCleanup(
  action: string,
  worktreePath: string,
  verdict: Exclude<WorktreeOwnershipVerdict, { kind: "owned" }>,
): string {
  const prefix = `Refusing to ${action} git worktree "${worktreePath}"`;
  switch (verdict.kind) {
    case "owned_by_other":
      return `${prefix}: it is registered to ${describeOwner(verdict.owner)}, not this run.`;
    case "foreign_lock":
      return `${prefix}: it is locked outside Paperclip`
        + `${verdict.lockReason ? ` (${verdict.lockReason})` : ""}.`;
    case "unowned":
      return `${prefix}: no ownership lock is recorded and it is not checked out on this `
        + "workspace's branch, so the registration cannot be proven safe to remove.";
    case "indeterminate":
      return `${prefix}: no branch is recorded for this workspace, so ownership cannot be established.`;
  }
}

/**
 * Marks a freshly created worktree as ours so that no other run's prune can
 * reclaim it. Locking is best-effort: a repository that cannot hold the lock
 * still yields a usable worktree, so the caller gets a warning rather than a
 * failed run.
 */
export async function lockGitWorktreeForOwner(input: {
  git: GitRunner;
  repoRoot: string;
  worktreePath: string;
  token: GitWorktreeOwnerToken;
  normalizePath: (value: string) => Promise<string>;
}): Promise<{ locked: boolean; warnings: string[] }> {
  const reason = formatWorktreeOwnerLockReason(input.token);
  try {
    await input.git(["worktree", "lock", "--reason", reason, input.worktreePath], input.repoRoot);
    return { locked: true, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already locked/i.test(message)) {
      return {
        locked: false,
        warnings: [
          `Could not lock git worktree "${input.worktreePath}" for ownership tracking (${message}). `
          + "Another run's prune may reclaim its registration.",
        ],
      };
    }

    // Git refuses to re-lock, so confirm the existing lock is ours rather than
    // reporting someone else's claim as our own.
    const registration = await findGitWorktreeRegistration(input);
    const verdict = registration
      ? classifyWorktreeOwnership(registration, input.token)
      : ({ kind: "unowned" } as const);
    if (verdict.kind === "owned") {
      if (registration?.lockReason === reason) return { locked: true, warnings: [] };
      return await refreshOwnedGitWorktreeLockReason({
        git: input.git,
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        newReason: reason,
        previousReason: registration?.lockReason ?? null,
      });
    }
    return {
      locked: false,
      warnings: [
        `Git worktree "${input.worktreePath}" is already locked by another owner`
        + `${registration?.lockReason ? ` (${registration.lockReason})` : ""}; `
        + "this run did not claim it.",
      ],
    };
  }
}

export async function readGitWorktreeRegistrations(input: {
  git: GitRunner;
  repoRoot: string;
}): Promise<GitWorktreeRegistration[]> {
  const raw = await input.git(["worktree", "list", "--porcelain"], input.repoRoot).catch(() => null);
  return raw ? parseGitWorktreeRegistrations(raw) : [];
}

export async function findGitWorktreeRegistration(input: {
  git: GitRunner;
  repoRoot: string;
  worktreePath: string;
  /** Injected so callers can resolve symlinks the same way the rest of the runtime does. */
  normalizePath: (value: string) => Promise<string>;
}): Promise<GitWorktreeRegistration | null> {
  const expected = await input.normalizePath(input.worktreePath);
  const registrations = await readGitWorktreeRegistrations(input);
  for (const registration of registrations) {
    if (await input.normalizePath(registration.worktree) === expected) return registration;
  }
  return null;
}

export type WorktreeCleanupOutcome = {
  /** True when the registration is gone (removed now, or already absent). */
  removed: boolean;
  /** Non-destructive audit trail for anything we declined to touch. */
  warnings: string[];
};

/**
 * Replacement for a repo-global `git worktree prune` in the restore path.
 *
 * Only the caller's *own* stale registration is cleared, and only by exact
 * path, so a concurrent run's live-but-unreadable worktree is never collected.
 * A stale entry is removed individually via `git worktree remove --force`,
 * which is path-scoped, rather than by pruning the whole registry.
 */
export async function pruneOwnStaleGitWorktree(input: {
  git: GitRunner;
  repoRoot: string;
  worktreePath: string;
  token: GitWorktreeOwnerToken;
  normalizePath: (value: string) => Promise<string>;
}): Promise<WorktreeCleanupOutcome> {
  const registration = await findGitWorktreeRegistration(input);
  if (!registration) return { removed: true, warnings: [] };

  const verdict = classifyWorktreeOwnership(registration, input.token);
  const worktreePathExists = await directoryExists(input.worktreePath);
  if (verdict.kind !== "owned") {
    // An unlocked missing entry has no claim protecting it and is removed by
    // exact path, preserving the restore path's pre-BLO-19607 self-healing
    // without reintroducing repo-global prune. Locked or visible ambiguities
    // are still reported, not removed.
    if (verdict.kind !== "unowned" || worktreePathExists) {
      return { removed: false, warnings: [describeDeclinedCleanup("prune stale", input.worktreePath, verdict)] };
    }
  }

  // Ask the filesystem rather than trusting git's `prunable` marker: git
  // suppresses that marker for locked worktrees, and ours are always locked, so
  // our own stale entries never advertise themselves as prunable.
  if (worktreePathExists) {
    // Still materialized — reuse and validation own this case; removing it here
    // would discard a working tree that may hold uncommitted work.
    return { removed: false, warnings: [] };
  }

  try {
    await input.git(["worktree", "remove", "--force", "--force", input.worktreePath], input.repoRoot);
    return { removed: true, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      removed: false,
      warnings: [`Could not clear stale git worktree registration "${input.worktreePath}" (${message}).`],
    };
  }
}

/**
 * Ownership check for teardown. Returns whether this run may destroy the
 * registration, rather than destroying it, so the caller keeps its own
 * operation instrumentation around the actual `git worktree remove`.
 *
 * When authorized, the caller removes with `git worktree remove --force
 * --force` so the ownership lock is released atomically with successful
 * removal. Failed removals leave the lock in place.
 */
export async function authorizeOwnedGitWorktreeCleanup(input: {
  git: GitRunner;
  repoRoot: string;
  worktreePath: string;
  token: GitWorktreeOwnerToken;
  normalizePath: (value: string) => Promise<string>;
}): Promise<{ authorized: boolean; warnings: string[] }> {
  const registration = await findGitWorktreeRegistration(input);
  // Nothing registered at this path: leave the decision to the caller, which
  // still needs to clear the directory itself.
  if (!registration) return { authorized: true, warnings: [] };

  const verdict = classifyWorktreeOwnership(registration, input.token);
  if (verdict.kind !== "owned") {
    return { authorized: false, warnings: [describeDeclinedCleanup("clean up", input.worktreePath, verdict)] };
  }

  return { authorized: true, warnings: [] };
}
