import { Router } from "express";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { getActorInfo } from "./authz.js";
import { issueService } from "../services/index.js";
import {
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  runOwnsIssueExecutionLock,
} from "../services/issue-execution-lock.js";
import {
  acquireWorkspaceDirClaim,
  refuseUnlockedIssueDirectory,
  releaseWorkspaceDirClaim,
  type ClaimOwnerLiveness,
} from "../services/workspace-dir-claim.js";

/**
 * The call site PEN-5352 was missing.
 *
 * `workspace-dir-claim.ts` landed in #3334 as a tested primitive with no
 * caller, and said so: the server cannot take the claim on an agent's behalf
 * for an ad-hoc directory because it never learns the path -- that absence IS
 * the defect. Four existing guards (the issue checkout lock, the worktree
 * registry, the branch claim, the shared-checkout warning) each key on a
 * resource the control plane provisioned, so an agent that clones a directory
 * of its own choosing after dispatch is unguarded by all four at once.
 *
 * So the path has to arrive from the agent, which makes this an HTTP route
 * rather than anything the dispatcher could do. The agent pod and the server
 * share the `/paperclip` volume, and the claim deliberately decides liveness
 * from run STATUS rather than a pid scan, so a claim written here is readable
 * and vettable from the other pod -- which a pid-based reaper (the nearby
 * `ensureGitIndexIsUnlocked` precedent) could not manage across pods.
 *
 * ## Why this route writes to a path the caller chose, and how that is bounded
 *
 * Accepting a filesystem path from an agent and writing to it is the obvious
 * hazard here, so the bounds are explicit rather than incidental:
 *
 *   * the path is `realpath`ed FIRST and the confinement test applied to the
 *     resolved result, so a symlink inside an allowed root cannot aim the
 *     write outside it;
 *   * it must already BE a directory -- this route never creates one, so it
 *     cannot be used to materialise a tree anywhere;
 *   * it must be STRICTLY inside an allowed root. Strictness is load-bearing
 *     and not tidiness: for a non-checkout directory `resolveWorkspaceClaimLocation`
 *     puts scratch and evidence files in `dirname(dirPath)`, so permitting the
 *     root itself would put them in the root's PARENT. Requiring at least one
 *     segment below the root keeps that parent inside the root;
 *   * the only names ever written are the claim, and scratch/evidence files
 *     the module names itself.
 *
 * The roots default to the shared volume and `PAPERCLIP_HOME`, and are
 * overridable for deployments that mount agent workspaces elsewhere.
 */
const DEFAULT_CLAIM_ROOTS = ["/paperclip"];

/** Colon-separated, as PATH is, so it reads the same way in a chart value. */
export function resolveWorkspaceClaimRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PAPERCLIP_WORKSPACE_CLAIM_ROOTS?.trim();
  const roots = configured
    ? configured.split(":").map((entry) => entry.trim()).filter(Boolean)
    : [...DEFAULT_CLAIM_ROOTS, ...(env.PAPERCLIP_HOME?.trim() ? [env.PAPERCLIP_HOME.trim()] : [])];
  // Resolve and de-duplicate so the refusal message lists each root once.
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * Strict containment: `child` must be BELOW `root`, never equal to it.
 *
 * `path.relative` rather than a string prefix, so `/paperclip-other` is not
 * read as living inside `/paperclip`.
 */
export function isStrictlyInsideRoot(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const claimBodySchema = z.object({
  dirPath: z.string().trim().min(1),
  /**
   * When present, the claim is additionally gated on this run holding the
   * issue's checkout lock. This is the strictly EARLIER failure: in the
   * incident no claim file existed, `available` was the honest verdict, and it
   * was still the wrong run to be in that tree.
   */
  issueId: z.string().trim().min(1).optional(),
});

const releaseBodySchema = z.object({ dirPath: z.string().trim().min(1) });

export function workspaceDirClaimRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);

  /**
   * Liveness from run status, with the module's fail-closed contract honoured:
   * a run we cannot find, or a lookup that throws, is `"unknown"` -- never
   * `"terminal"`. Breaking a claim on "I could not look" is how the other run's
   * work gets overwritten, which is the whole subject of this row.
   */
  const readOwnerLiveness = async (runId: string): Promise<ClaimOwnerLiveness> => {
    try {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      if (!run) return "unknown";
      return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status) ? "terminal" : "live";
    } catch (err) {
      logger.error({ err, runId }, "workspace dir claim: owner liveness lookup failed");
      return "unknown";
    }
  };

  /**
   * Resolve and bound the caller's path.
   *
   * Returns a refusal STRING rather than throwing, so every refusal on this
   * route reaches the agent as prose it can act on -- the module's own
   * invariant is that `acquired: false` always carries a reason, and a bare
   * 400 here would be the one hole in it.
   */
  async function resolveClaimDir(
    rawDirPath: string,
  ): Promise<{ dirPath: string } | { refusal: string }> {
    const roots = resolveWorkspaceClaimRoots();
    if (!path.isAbsolute(rawDirPath)) {
      return { refusal: `PATH REFUSED: "${rawDirPath}" is not absolute. Pass the directory's full path.` };
    }
    let resolved: string;
    try {
      resolved = await realpath(rawDirPath);
    } catch {
      return {
        refusal:
          `PATH REFUSED: "${rawDirPath}" does not exist. Claim the directory only once its final shape exists --` +
          " after the clone or worktree is materialised, not before. A directory claimed while plain and then" +
          " turned into a git checkout moves its own claim lookup into .git/, leaving the original claim" +
          " unreadable by the next run and unreleasable by this one.",
      };
    }
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      return { refusal: `PATH REFUSED: "${resolved}" is not a directory.` };
    }
    if (!roots.some((root) => isStrictlyInsideRoot(root, resolved))) {
      return {
        refusal:
          `PATH REFUSED: "${resolved}" is not inside a directory this server may claim.` +
          ` Allowed roots: ${roots.join(", ")}.` +
          " A claim is only useful on a filesystem both the server and the agent pods can see;" +
          " a path local to one pod cannot exclude a run in another.",
      };
    }
    return { dirPath: resolved };
  }

  router.post("/workspace-dir-claims", validate(claimBodySchema), async (req, res) => {
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || !actor.runId) {
      res.status(403).json({
        error:
          "A workspace directory claim identifies the RUN that holds it, so it can only be taken by an" +
          " authenticated agent run. Liveness of the holder is read from its run status; a claim with no run" +
          " behind it could never be shown to have finished and would strand the directory permanently.",
      });
      return;
    }

    const resolvedDir = await resolveClaimDir(req.body.dirPath);
    if ("refusal" in resolvedDir) {
      res.status(400).json({ acquired: false, verdict: { kind: "refused" }, refusal: resolvedDir.refusal });
      return;
    }
    const { dirPath } = resolvedDir;

    // The earlier gate first: holding the issue lock is a precondition for
    // being in the issue's tree at all, and it is cheap and local. Taking the
    // claim first would hand the directory to a run that has no business in it
    // and then tell it so.
    if (req.body.issueId) {
      // A THROWING lookup and a MISSING issue are different answers and must not
      // collapse. `getById` resolves null for "no such issue", which is a
      // determination -- this run demonstrably does not hold a lock on a row
      // that is not there, and the refusal routes it to `paperclipCheckoutIssue`,
      // which will say so precisely. A throw is the absence of a determination,
      // and the module's contract is that those refuse as `"unknown"` rather
      // than resolving either way.
      const lookup = await issues
        .getById(req.body.issueId)
        .then((issue) => ({ determined: true as const, issue }))
        .catch((err: unknown) => {
          logger.error({ err, issueId: req.body.issueId }, "workspace dir claim: issue lookup failed");
          return { determined: false as const, issue: null };
        });
      const selfHoldsIssueLock: boolean | "unknown" = !lookup.determined
        ? "unknown"
        : runOwnsIssueExecutionLock(lookup.issue ?? {}, actor.runId);
      const refusal = refuseUnlockedIssueDirectory({
        dirPath,
        issueId: req.body.issueId,
        selfHoldsIssueLock,
        holderRunId: lookup.issue?.checkoutRunId ?? lookup.issue?.executionRunId ?? null,
      });
      if (refusal) {
        res.status(409).json({ acquired: false, verdict: { kind: "issue_lock_not_held" }, refusal });
        return;
      }
    }

    const outcome = await acquireWorkspaceDirClaim({
      dirPath,
      self: {
        runId: actor.runId,
        agentId: actor.agentId ?? null,
        companyId: req.actor.companyId ?? null,
        issueId: req.body.issueId ?? null,
      },
      readOwnerLiveness,
    });

    res.status(outcome.acquired ? 200 : 409).json({ ...outcome, dirPath });
  });

  router.post("/workspace-dir-claims/release", validate(releaseBodySchema), async (req, res) => {
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || !actor.runId) {
      res.status(403).json({ error: "Only an authenticated agent run can release its own claim" });
      return;
    }
    const resolvedDir = await resolveClaimDir(req.body.dirPath);
    if ("refusal" in resolvedDir) {
      res.status(400).json({ released: false, reason: resolvedDir.refusal });
      return;
    }
    // `releaseWorkspaceDirClaim` refuses to remove a claim that is not ours, so
    // the run id is the authorization and there is nothing to check here.
    const result = await releaseWorkspaceDirClaim({ dirPath: resolvedDir.dirPath, runId: actor.runId });
    res.status(200).json({ ...result, dirPath: resolvedDir.dirPath });
  });

  return router;
}
