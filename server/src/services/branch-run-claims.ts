import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { branchRunClaims, heartbeatRuns } from "@paperclipai/db";
import { TERMINAL_HEARTBEAT_RUN_STATUSES } from "./issues.js";
import { logger } from "../middleware/logger.js";

// BLO-21602: the issue-scoped run-ownership guard (issues.checkoutRunId /
// executionRunId) only ever compares a run against the ONE issue it is
// checked out on. Two runs of the same agent legitimately checked out on two
// *different* issues (e.g. a parent and its child) can both resolve to the
// same git branch/PR via a shared or inherited execution workspace, and
// neither ever collides with the other -- each independently commits and
// pushes, producing a divergent sibling commit. This module claims the
// branch itself as the contended resource, keyed by (companyId, branchKey),
// independent of which issue a run is checked out on.
export type BranchRunClaim = typeof branchRunClaims.$inferSelect;

const ACTIVE_BRANCH_CONSTRAINT = "branch_run_claims_active_branch_idx";
const DEFAULT_BRANCH_CLAIM_LEASE_MS = 30 * 60 * 1000;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type BranchClaimReadDb = Pick<Db | DbTransaction, "select">;

export class BranchClaimConflictError extends Error {
  readonly code = "branch_claim_conflict";

  constructor(
    readonly runId: string,
    readonly branchKey: string,
    readonly holderRunId: string | null,
    readonly holderIssueId: string | null,
  ) {
    super(
      `Run ${runId} cannot claim branch "${branchKey}"`
      + (holderRunId
        ? `; run ${holderRunId} (issue ${holderIssueId ?? "<unknown>"}) already holds it`
        : ""),
    );
    this.name = "BranchClaimConflictError";
  }
}

function isConstraintConflict(error: unknown, expectedConstraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (typeof current !== "object") return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    const constraint = candidate.constraint ?? candidate.constraint_name;
    if (candidate.code === "23505" && constraint === expectedConstraint) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Canonicalizes a git remote URL to a `host/path` identity so the SSH
 * (`git@github.com:org/repo.git`), scp-like SSH with an explicit scheme
 * (`ssh://git@github.com/org/repo.git`), and HTTPS (`https://github.com/org/repo`)
 * forms of the *same* remote all collide on the same identity. Case-insensitive
 * and trims a trailing `.git`/slash. Falls back to a lowercase/trimmed copy of
 * the raw input for anything that doesn't match a recognized remote form,
 * rather than throwing -- an unrecognized value still needs a stable, if
 * narrower, identity.
 */
function canonicalizeGitRemoteIdentity(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (!trimmed) return "unknown";

  const stripPath = (path: string) =>
    path
      .replace(/^\/+/, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();

  // scp-like SSH syntax has no "://", e.g. `git@github.com:org/repo.git`.
  if (!trimmed.includes("://")) {
    const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scpMatch) {
      const [, host, path] = scpMatch;
      return `${host.toLowerCase()}/${stripPath(path)}`;
    }
  } else {
    // Schemed forms: https://, http://, ssh://, git://, git+ssh://, ...
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname) {
        return `${parsed.hostname.toLowerCase()}/${stripPath(parsed.pathname)}`;
      }
    } catch {
      // fall through to the opaque fallback below
    }
  }

  return trimmed
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

/**
 * Normalizes a repo + branch pair into the key branch_run_claims enforces
 * uniqueness on, so `git@github.com:Org/repo.git`, `ssh://git@github.com/Org/repo`,
 * and `https://github.com/Org/repo/` all collide on the same branch.
 */
export function computeBranchClaimKey(input: { repoUrl: string | null; branchName: string }): string {
  const normalizedRepo = input.repoUrl ? canonicalizeGitRemoteIdentity(input.repoUrl) : "unknown";
  return `${normalizedRepo}#${input.branchName}`;
}

async function getHeartbeatRunState(
  db: BranchClaimReadDb,
  runId: string,
): Promise<"live" | "missing" | "terminal"> {
  const run = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) return "missing";
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status) ? "terminal" : "live";
}

export async function acquireBranchRunClaim(
  db: Db,
  input: {
    companyId: string;
    branchKey: string;
    executionWorkspaceId: string | null;
    issueId: string;
    runId: string;
    agentId: string;
    now?: Date;
    leaseMs?: number;
  },
): Promise<BranchRunClaim> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_BRANCH_CLAIM_LEASE_MS));

  try {
    return await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(branchRunClaims)
        .where(and(
          eq(branchRunClaims.companyId, input.companyId),
          eq(branchRunClaims.branchKey, input.branchKey),
          isNull(branchRunClaims.releasedAt),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (existing) {
        if (existing.heartbeatRunId === input.runId) {
          return tx
            .update(branchRunClaims)
            .set({ expiresAt, lastRenewedAt: now, updatedAt: now })
            .where(eq(branchRunClaims.id, existing.id))
            .returning()
            .then((rows) => rows[0]!);
        }

        const holderState = await getHeartbeatRunState(tx, existing.heartbeatRunId);
        if (holderState === "live") {
          throw new BranchClaimConflictError(input.runId, input.branchKey, existing.heartbeatRunId, existing.issueId);
        }

        await tx
          .update(branchRunClaims)
          .set({
            releasedAt: now,
            releaseReason: holderState === "missing" ? "holder_run_missing" : "holder_run_terminal",
            updatedAt: now,
          })
          .where(and(eq(branchRunClaims.id, existing.id), isNull(branchRunClaims.releasedAt)));

        logger.warn(
          {
            branchKey: input.branchKey,
            supersededRunId: existing.heartbeatRunId,
            supersededIssueId: existing.issueId,
            claimingRunId: input.runId,
            claimingIssueId: input.issueId,
            holderState,
            previousExpiresAt: existing.expiresAt.toISOString(),
          },
          "Superseded a stale branch run claim",
        );
      }

      return tx
        .insert(branchRunClaims)
        .values({
          companyId: input.companyId,
          branchKey: input.branchKey,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.runId,
          agentId: input.agentId,
          acquiredAt: now,
          expiresAt,
          lastRenewedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]!);
    });
  } catch (error) {
    if (error instanceof BranchClaimConflictError) throw error;
    if (!isConstraintConflict(error, ACTIVE_BRANCH_CONSTRAINT)) throw error;
    const conflicting = await db
      .select()
      .from(branchRunClaims)
      .where(and(
        eq(branchRunClaims.companyId, input.companyId),
        eq(branchRunClaims.branchKey, input.branchKey),
        isNull(branchRunClaims.releasedAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    throw new BranchClaimConflictError(
      input.runId,
      input.branchKey,
      conflicting?.heartbeatRunId ?? null,
      conflicting?.issueId ?? null,
    );
  }
}

export async function releaseBranchRunClaim(
  db: Db,
  input: { runId: string; reason: string; now?: Date },
): Promise<BranchRunClaim | null> {
  const now = input.now ?? new Date();
  return db
    .update(branchRunClaims)
    .set({
      releasedAt: now,
      releaseReason: input.reason,
      updatedAt: now,
    })
    .where(and(eq(branchRunClaims.heartbeatRunId, input.runId), isNull(branchRunClaims.releasedAt)))
    .returning()
    .then((rows) => rows[0] ?? null);
}

/**
 * Releases only the claim this run holds on ONE specific branch key, leaving
 * any other claim it holds intact. Used when a run acquires its branch claim
 * before the execution workspace is realized (from the durable
 * `execution_workspaces.branch_name`) and realization then resolves a
 * different branch: the run takes the new key first, then drops the
 * provisional one here, so it is never simultaneously the recorded holder of
 * two branches and never leaves the provisional key claimed after moving off
 * it. Unlike `releaseBranchRunClaim`, which is the end-of-run sweep, this is
 * deliberately narrow.
 */
export async function releaseBranchRunClaimForKey(
  db: Db,
  input: { runId: string; branchKey: string; reason: string; now?: Date },
): Promise<BranchRunClaim | null> {
  const now = input.now ?? new Date();
  return db
    .update(branchRunClaims)
    .set({
      releasedAt: now,
      releaseReason: input.reason,
      updatedAt: now,
    })
    .where(and(
      eq(branchRunClaims.heartbeatRunId, input.runId),
      eq(branchRunClaims.branchKey, input.branchKey),
      isNull(branchRunClaims.releasedAt),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function getActiveBranchRunClaimForRun(db: Db, runId: string): Promise<BranchRunClaim | null> {
  return db
    .select()
    .from(branchRunClaims)
    .where(and(eq(branchRunClaims.heartbeatRunId, runId), isNull(branchRunClaims.releasedAt)))
    .then((rows) => rows[0] ?? null);
}
