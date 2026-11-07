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
  companyScopedRespellings,
  refuseUnlockedIssueDirectory,
  releaseWorkspaceDirClaim,
  resolveWorkspaceClaimLocation,
  type ClaimOwnerLiveness,
  type WorkspaceClaimRespelling,
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
 * ⚠ Sharing the volume is NOT sharing the path, and assuming otherwise cost
 * PEN-5865 an investigation and left this route refusing every claim an agent
 * pod made. The agent pods mount COMPANY-SCOPED subPaths of the shared
 * subvolume, so a directory's name on the agent pod is not its name here. See
 * `companyScopedRespellings` for the measured layout and for what this route
 * does about it.
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
 *
 * ## What is NOT closed, stated plainly
 *
 * `realpath` -> `link()` is a TOCTOU window. The agent shares this volume, so
 * it can in principle swap a path component for a symlink between the check
 * and the write. Node exposes no `openat2`/`RESOLVE_NO_SYMLINKS` equivalent,
 * so the window is narrowed -- the resolution happens immediately before the
 * acquire, and both the claim and scratch locations are re-resolved rather
 * than inferred -- but it is not eliminated. The allowed roots are the real
 * bound, which is why they are a deployment control and why a company-scoped
 * root is worth configuring where the layout permits one.
 *
 * Likewise the shared-root denial-of-service: with the default roots, one
 * company's agent can claim another company's directory. See
 * `resolveWorkspaceClaimRoots` for why that is left open rather than guessed
 * at, and for the `{companyId}` mechanism that closes it per deployment.
 */
const DEFAULT_CLAIM_ROOTS = ["/paperclip"];

/**
 * Colon-separated, as PATH is, so it reads the same way in a chart value.
 *
 * A root may contain `{companyId}`, which expands to the CALLING run's company.
 * That is the mechanism for per-company confinement, raised by Ally on #3370:
 * with the default shared roots, any agent run can claim any directory under
 * `/paperclip`, including another company's per-issue worktree, and the
 * victim's runs then read `held` and refuse. That is a cross-tenant
 * denial-of-service and it is NOT closed by the defaults.
 *
 * It is left open deliberately rather than silently: the incident path
 * (`/paperclip/wt/pen-4522/repo`) carries no company segment, so a hard
 * per-company rule would refuse the very case this row exists to fix. The
 * placeholder gives a deployment whose layout DOES segregate by company
 * (`.../companies/<companyId>/...`) a way to say so, without this route
 * guessing a layout it cannot see. Replace-not-extend semantics matter here:
 * a company-scoped root is only a bound if the shared default is gone.
 *
 * A root naming `{companyId}` simply never matches for a caller with no
 * company, which fails closed.
 */
export function resolveWorkspaceClaimRoots(
  env: NodeJS.ProcessEnv = process.env,
  companyId?: string | null,
): string[] {
  const configured = env.PAPERCLIP_WORKSPACE_CLAIM_ROOTS?.trim();
  const roots = configured
    ? configured.split(":").map((entry) => entry.trim()).filter(Boolean)
    : [...DEFAULT_CLAIM_ROOTS, ...(env.PAPERCLIP_HOME?.trim() ? [env.PAPERCLIP_HOME.trim()] : [])];
  const expanded = roots.flatMap((root) => {
    if (!root.includes("{companyId}")) return [root];
    if (!companyId) return [];
    return [root.replaceAll("{companyId}", companyId)];
  });
  // Resolve and de-duplicate so the refusal message lists each root once.
  return [...new Set(expanded.map((root) => path.resolve(root)))];
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

/**
 * Containment that PERMITS the root itself.
 *
 * Used for the directories actually written into, and the asymmetry with
 * `isStrictlyInsideRoot` is deliberate rather than sloppy. `dirPath` must be
 * strictly inside so that `dirname(dirPath)` -- where the module stages
 * scratch and evidence for a non-checkout directory -- is at worst the root.
 * Applying the strict test to that parent in turn would refuse every
 * legitimate claim exactly one segment below a root.
 */
export function isInsideRootInclusive(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Why `companyScopedRespellings` is imported rather than defined here.
 *
 * PEN-5865's mapping is not only needed for the path the caller names: a
 * linked worktree's `.git` pointer is written by git ON THE AGENT POD, so it
 * carries the agent's spelling too, and the claim LOCATION is derived from it.
 * Three places resolve that location independently -- this route,
 * `acquireWorkspaceDirClaim` and `releaseWorkspaceDirClaim` -- so the mapping
 * lives beside the layout it feeds, and all three are handed the same
 * `WorkspaceClaimRespelling` value. See that type for the measured mount
 * layout and for why this can only narrow what a caller reaches.
 */

/**
 * The refusal for a path the server cannot resolve.
 *
 * PEN-5865's second defect, and the one that cost the investigation: this
 * branch used to say only "does not exist -- claim after the clone is
 * materialised". That is advice about a mistake the caller had not made, it
 * points away from the cause, and a caller who follows it burns another call
 * reaching the same place. The root-membership refusal below carries the two
 * facts that actually resolve this -- the allowed roots, and that the check is
 * performed SERVER-side on a filesystem that must be shared -- but it can
 * never fire for a path the server cannot see, because `realpath` throws
 * first. So both facts are carried here too, and the branch additionally says
 * which of the two situations it is in.
 */
function refuseUnresolvablePath(args: {
  rawDirPath: string;
  lexicalPath: string;
  roots: string[];
  respellings: string[];
}): string {
  const { rawDirPath, lexicalPath, roots, respellings } = args;
  const rootList = `Allowed roots: ${roots.join(", ")}.`;
  const sharedFs =
    " This existence check runs on the SERVER's filesystem, not your pod's:" +
    " a claim is only useful on a filesystem both the server and the agent pods can see," +
    " and a path local to one pod cannot exclude a run in another.";
  if (!roots.some((root) => isStrictlyInsideRoot(root, lexicalPath))) {
    return (
      `PATH REFUSED: "${rawDirPath}" could not be resolved, and as written it is not inside a directory` +
      ` this server may claim. ${rootList}${sharedFs}`
    );
  }
  const tried = respellings.length
    ? ` The company-scoped spelling was tried as well and did not resolve either (${respellings.join(", ")}).`
    : "";
  return (
    `PATH REFUSED: "${rawDirPath}" is inside an allowed root but does not exist ON THE SERVER.` +
    ` ${rootList}${sharedFs}` +
    ` The agent pods mount COMPANY-SCOPED subPaths of the shared volume, so your "/paperclip/work/<name>"` +
    ` is this server's "/paperclip/work/<companyId>/<name>"; the two spellings name one directory and only` +
    ` the second one resolves here.${tried}` +
    " If the directory is genuinely not materialised yet, claim it only once its final shape exists --" +
    " a directory claimed while plain and then turned into a git checkout moves its own claim lookup into" +
    " .git/, leaving the original claim unreadable by the next run and unreleasable by this one."
  );
}

/** Roots may themselves be symlinked; compare resolved against resolved. */
async function realRoots(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map(async (root) => (await realpath(root).catch(() => null)) ?? root));
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
    companyId: string | null,
  ): Promise<{ dirPath: string; respelling: WorkspaceClaimRespelling; note?: string } | { refusal: string }> {
    const roots = await realRoots(resolveWorkspaceClaimRoots(process.env, companyId));
    if (roots.length === 0) {
      return {
        refusal:
          "PATH REFUSED: every configured claim root is company-scoped and this run has no company," +
          " so no root can be resolved for it.",
      };
    }
    if (!path.isAbsolute(rawDirPath)) {
      return { refusal: `PATH REFUSED: "${rawDirPath}" is not absolute. Pass the directory's full path.` };
    }
    // `realpath` resolves on the SERVER's filesystem. For an agent pod the
    // same directory has a different name -- see `companyScopedRespellings`
    // for the measured mount layout -- so a literal miss is retried under the
    // caller's own company segment before anything is refused. The literal
    // path always wins when it resolves: re-spelling is a fallback, never a
    // rewrite of a path that already names something.
    const lexicalPath = path.resolve(rawDirPath);
    const respelling: WorkspaceClaimRespelling = { roots, companyId };
    const respellings = companyScopedRespellings(roots, lexicalPath, companyId);
    let resolved = await realpath(rawDirPath).catch(() => null);
    let respelledTo: string | null = null;
    if (resolved === null) {
      for (const candidate of respellings) {
        const hit = await realpath(candidate).catch(() => null);
        if (hit !== null) {
          resolved = hit;
          respelledTo = candidate;
          break;
        }
      }
    }
    if (resolved === null) {
      return { refusal: refuseUnresolvablePath({ rawDirPath, lexicalPath, roots, respellings }) };
    }
    // LITERAL-FIRST IS SAFE BUT NOT UNAMBIGUOUS, and the ambiguity is worth a
    // log line rather than silence (Ally, #3498). Under the measured layout a
    // literal hit beneath a subPath-mounted segment is usually an UNSCOPED
    // server-side tree, not the directory the agent is standing in -- and two
    // companies' runs that both name `/paperclip/work/foo` then collide on
    // that one directory, which is the opposite of what the company segment is
    // for. Not a confinement problem: the claim still lands inside the roots,
    // and inverting the preference would be worse, since it would redirect a
    // server-local caller's perfectly good path. So it is reported, not
    // changed -- a collision that gets investigated beats one that does not.
    if (respelledTo === null && respellings.length > 0) {
      const shadowed: string[] = [];
      for (const candidate of respellings) {
        if ((await stat(candidate).catch(() => null))?.isDirectory()) shadowed.push(candidate);
      }
      if (shadowed.length > 0) {
        logger.warn(
          { rawDirPath, resolved, shadowed, companyId },
          "workspace dir claim: literal path resolved while a company-scoped directory of the same name also" +
            " exists; the claim is on the literal one",
        );
      }
    }

    // Say so rather than re-spelling silently. The response already echoes the
    // resolved `dirPath`, but a caller comparing it to what it sent deserves
    // to know WHY it moved -- and the next investigator deserves to find the
    // translation named rather than inferring it from a diff.
    const note = respelledTo
      ? `Resolved "${rawDirPath}" to "${resolved}": the agent pods mount company-scoped subPaths of the` +
        " shared volume, so that is this server's name for the directory you asked about. Pass this path to" +
        " paperclipReleaseWorkspaceDir, or the same path you sent -- both re-spell identically."
      : undefined;
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

    // CONFINING `dirPath` IS NOT ENOUGH, and this is the escape Ally caught on
    // #3370. Where the server actually writes is decided AFTERWARDS, by
    // `resolveWorkspaceClaimLocation`, from content the agent controls:
    //
    //   * a `.git` FILE holding `gitdir: /anywhere` resolves the claim to an
    //     absolute path outside every root;
    //   * a `.git` SYMLINK to a directory is followed by `fs.stat`, so
    //     `isDirectory()` is true and the claim resolves through the link.
    //
    // The server then writes the claim, `.dir-claim-*.tmp` staging files,
    // successor tokens and takeover evidence there, and prunes evidence files
    // with `rm` -- all as the SERVER's uid, against the server's full view of
    // the volume, which is wider than any agent pod's. So the containment test
    // has to be applied to the resolved write locations, not to the directory
    // the caller named.
    //
    // Inclusive containment here, strict above: see `isInsideRootInclusive`.
    const location = await resolveWorkspaceClaimLocation(resolved, respelling).catch(() => null);
    if (!location) {
      return { refusal: `PATH REFUSED: the claim location for "${resolved}" could not be resolved.` };
    }
    // REFUSE RATHER THAN DEGRADE. An unresolvable `.git` pointer used to fall
    // through to the plain-directory branch, which puts the claim in the
    // WORKING TREE -- an untracked file that `git add -A` commits into
    // somebody's PR and `git clean -fd` deletes, taking the mutual exclusion
    // with it. From an agent pod that branch was unreachable before PEN-5865,
    // because `realpath` threw on the agent's spelling first; re-spelling is
    // what makes it reachable, so it is closed in the same change that opens
    // it (Ally, #3498).
    if (location.unresolvedGitDir) {
      return {
        refusal:
          `PATH REFUSED: "${resolved}" carries a .git pointer to "${location.unresolvedGitDir}", which does not` +
          " resolve to a directory on the server in either spelling (literal or company-scoped)." +
          " A linked worktree's pointer is written by git on YOUR pod, so it names the gitdir the way your pod" +
          " does; this server could not find it either way, which usually means the repository it points into" +
          " is not on the shared volume." +
          " The claim is NOT placed in the working tree instead: a claim there is an untracked file that" +
          " `git add -A` commits and `git clean -fd` deletes, which would silently drop the exclusion this" +
          " call exists to take.",
      };
    }
    for (const [label, target] of [
      ["claim", path.dirname(location.claimPath)],
      ["scratch", location.scratchDir],
    ] as const) {
      const real = await realpath(target).catch(() => null);
      if (!real) {
        return {
          refusal: `PATH REFUSED: the ${label} directory for "${resolved}" ("${target}") could not be resolved.`,
        };
      }
      if (!roots.some((root) => isInsideRootInclusive(root, real))) {
        return {
          refusal:
            `PATH REFUSED: "${resolved}" resolves its ${label} location to "${real}", which is outside every` +
            ` allowed root (${roots.join(", ")}).` +
            " A `.git` pointer file or symlink can aim that location anywhere, so it is checked separately" +
            " from the directory you named.",
        };
      }
    }
    return note ? { dirPath: resolved, respelling, note } : { dirPath: resolved, respelling };
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

    const actorCompanyId = req.actor.companyId ?? null;
    const resolvedDir = await resolveClaimDir(req.body.dirPath, actorCompanyId);
    if ("refusal" in resolvedDir) {
      res.status(400).json({ acquired: false, verdict: { kind: "refused" }, refusal: resolvedDir.refusal });
      return;
    }
    const { dirPath, note } = resolvedDir;

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
      // `issueService.getById` is NOT company-scoped: it resolves a UUID or an
      // identifier against the whole instance. So an unscoped read here would
      // let an agent name ANOTHER company's issue and have the refusal hand
      // back that issue's checkoutRunId/executionRunId. Refuse before any
      // holder is echoed -- a cross-tenant id must not be distinguishable from
      // a missing one by its error body.
      if (lookup.determined && lookup.issue && lookup.issue.companyId !== actorCompanyId) {
        res.status(403).json({
          acquired: false,
          verdict: { kind: "refused" },
          refusal: `ISSUE REFUSED: issue ${req.body.issueId} does not belong to this run's company.`,
        });
        return;
      }

      // An issue reference that resolves to nothing is a typo or a bad id, not
      // a lock verdict. Reporting it as NOT HELD sent an agent to
      // `paperclipCheckoutIssue` for a row that does not exist (Ally, #3370).
      if (lookup.determined && !lookup.issue) {
        res.status(400).json({
          acquired: false,
          verdict: { kind: "refused" },
          refusal:
            `ISSUE REFUSED: "${req.body.issueId}" does not resolve to an issue this run can see.` +
            " Check the identifier before claiming its directory.",
        });
        return;
      }

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
      respelling: resolvedDir.respelling,
      self: {
        runId: actor.runId,
        agentId: actor.agentId ?? null,
        companyId: actorCompanyId,
        issueId: req.body.issueId ?? null,
      },
      readOwnerLiveness,
    });

    res.status(outcome.acquired ? 200 : 409).json({ ...outcome, dirPath, ...(note ? { note } : {}) });
  });

  router.post("/workspace-dir-claims/release", validate(releaseBodySchema), async (req, res) => {
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || !actor.runId) {
      res.status(403).json({ error: "Only an authenticated agent run can release its own claim" });
      return;
    }
    // Same confinement as acquire, and for the same reason: `releaseWorkspaceDirClaim`
    // re-resolves the location statelessly, so without this check release is an
    // `rm` primitive on any file named `paperclip-dir-claim.json` whose JSON
    // happens to carry the caller's own run id (Ally, #3370).
    const resolvedDir = await resolveClaimDir(req.body.dirPath, req.actor.companyId ?? null);
    if ("refusal" in resolvedDir) {
      res.status(400).json({ released: false, reason: resolvedDir.refusal });
      return;
    }
    // `releaseWorkspaceDirClaim` refuses to remove a claim that is not ours, so
    // the run id is the authorization and there is nothing to check here.
    const result = await releaseWorkspaceDirClaim({
      dirPath: resolvedDir.dirPath,
      runId: actor.runId,
      respelling: resolvedDir.respelling,
    });
    res.status(200).json({
      ...result,
      dirPath: resolvedDir.dirPath,
      ...(resolvedDir.note ? { note: resolvedDir.note } : {}),
    });
  });

  return router;
}
