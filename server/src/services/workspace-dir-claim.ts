/**
 * Ownership for a working directory the AGENT chose, not one the control plane
 * provisioned.
 *
 * PEN-5352, measured on PEN-4522 overnight 2026-11-03T01:40Z-03:06Z: two runs
 * of ONE CTO seat (`29033747-...`, `maxConcurrentRuns: 5`) independently
 * implemented the same fix in `/paperclip/wt/pen-4522/repo` and one
 * implementation was thrown away. The directory's own reflog settles what
 * happened and is worth stating, because it rules out the comfortable reading:
 *
 *   01:40:44Z  clone: from https://github.com/Blockcast/paperclip.git
 *   01:47:02Z  checkout: moving from master to cto/pen-4522-park-aware-...
 *   01:47:50Z  checkout: moving from cto/pen-4522-park-aware-... to cto/pen-4522-park-gated-...
 *   03:00:10Z  commit: fix(productivity-review): account deliberate park time ...
 *
 * There is exactly ONE clone entry. Both runs stood in the same tree; the
 * "each had its own clone" explanation is refuted by the repository itself.
 * Two branches were created 48 seconds apart from one HEAD, and
 * `cto/pen-4522-park-aware-productivity-review` carries a single reflog line
 * -- "branch: Created from HEAD" -- so it never held a commit. The second run
 * then spent its remaining budget on an md5-verified restore to preserve that
 * branch. It preserved an empty ref.
 *
 * ## Why none of the four existing guards could fire
 *
 * Every one of them keys on a resource the CONTROL PLANE provisioned, and this
 * directory was created by the agent process after dispatch:
 *
 *   * `shared-checkout-occupancy.ts` probes `executionWorkspace.cwd`. An ad-hoc
 *     clone is not that path, so the probe never looked at it.
 *   * `git-worktree-ownership.ts` reads `$GIT_DIR/worktrees`. `/paperclip/wt/
 *     pen-4522/repo` is a standalone clone -- `.git` is a real directory with
 *     its own `[remote "origin"]` -- so it has no registry entry to stamp.
 *   * `branch-run-claims.ts` keys on an execution-workspace branch name. Both
 *     runs chose their own branch after dispatch, and they chose DIFFERENT
 *     ones, so even a working branch claim would not have collided.
 *   * `issues.checkoutRunId` is issue-scoped and advisory. Run `8e92db74` said
 *     it plainly: it edited before calling `paperclipCheckoutIssue`, "that call
 *     ... would have returned 409", and nothing refused it because nothing in
 *     the filesystem path consults that column.
 *
 * So the gap is not "a guard was mis-tuned". It is that the contended resource
 * -- a directory chosen inside the agent process -- had no guard of any kind.
 * This is the filesystem face of the gap `branch-run-claims.ts` already records
 * for the remote branch under PEN-4764, and it wants the same answer: a claim
 * the agent takes on the resource it actually chose.
 *
 * ## What this module is, and what it refuses to be
 *
 * A claim is a file created with exclusive-create semantics on the shared
 * volume, so the winner/loser determination is made by the filesystem rather
 * than by convention. Convention is explicitly not enough here: both runs in
 * the incident were careful, both wrote considered stand-down notes, and both
 * lost work anyway.
 *
 * Two disciplines are inherited deliberately from code that already paid for
 * them:
 *
 *   * **Atomic in content, not merely in name** (PEN-4877). `writeFile(...,
 *     { flag: "wx" })` is `open(O_CREAT|O_EXCL)` and then a SEPARATE `write()`.
 *     A racing reader can see the name before the bytes and read an empty
 *     claim, which would classify as "unreadable" and refuse a directory that
 *     is in fact healthily owned. We stage the full record and `link()` it into
 *     place, so the claim is never observable without its contents.
 *   * **Release only on a positive determination** (`ensureGitIndexIsUnlocked`,
 *     BLO-35981). A claim is taken over only when the owning run is KNOWN
 *     terminal. Not when it is old, not when it is quiet. "I could not look" is
 *     not a determination, and it refuses -- the same fail-closed posture, for
 *     the same reason: the cost of a wrong break-in is another run's work.
 *
 * It is deliberately NOT a lease with a timeout. An expiring lease would have
 * handed the incident directory to the second run on a clock rather than on a
 * fact, which is the failure mode this exists to prevent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The claim lives inside the directory it claims, so a run that `cd`s there
 * finds it without being told where to look, and so `rm -rf` of the workspace
 * takes the claim with it rather than stranding one.
 */
export const WORKSPACE_CLAIM_FILENAME = ".paperclip-dir-claim.json";

/** Schema marker, so a future shape change is detectable rather than silently mis-parsed. */
export const WORKSPACE_CLAIM_VERSION = 1;

export type WorkspaceDirClaim = {
  version: number;
  /** The run that owns the directory. The field everything else keys on. */
  runId: string;
  /** The seat. Present so a refusal can say "this is you" rather than "a peer". */
  agentId: string | null;
  companyId: string | null;
  /**
   * The issue this directory was taken for, when it was taken for one. A
   * per-issue directory names its issue here; that is what lets
   * `classifyWorkspaceDirClaim` tell a per-issue tree from a scratch one.
   */
  issueId: string | null;
  /** Audit only. Never an input to any verdict -- see the module header on leases. */
  acquiredAt: string;
};

/** Liveness of a claim's owning run, as determined by the caller against the DB. */
export type ClaimOwnerLiveness =
  /** The owning run is running or otherwise not finished. */
  | "live"
  /** Positively determined finished: cancelled, failed, or completed. */
  | "terminal"
  /** Could not be determined. Never reads as "terminal" -- see the module header. */
  | "unknown";

export type WorkspaceDirClaimIdentity = {
  runId: string;
  agentId: string | null;
  companyId: string | null;
  issueId: string | null;
};

export function formatWorkspaceDirClaim(claim: WorkspaceDirClaim): string {
  // Trailing newline so `cat` of the claim in a terminal is readable, and so a
  // truncated write is visible as a missing newline rather than as valid JSON.
  return `${JSON.stringify(claim, null, 2)}\n`;
}

/**
 * Returns null for anything that is not a well-formed claim of a version we
 * understand. Null means "present but unreadable", which the classifier turns
 * into a REFUSAL, not into "available" -- a claim we cannot parse is a claim we
 * cannot prove is dead.
 */
export function parseWorkspaceDirClaim(raw: string | null | undefined): WorkspaceDirClaim | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== WORKSPACE_CLAIM_VERSION) return null;
  if (typeof record.runId !== "string" || !record.runId.trim()) return null;

  const optionalString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value : null;

  return {
    version: WORKSPACE_CLAIM_VERSION,
    runId: record.runId,
    agentId: optionalString(record.agentId),
    companyId: optionalString(record.companyId),
    issueId: optionalString(record.issueId),
    acquiredAt: optionalString(record.acquiredAt) ?? "",
  };
}

export type WorkspaceDirClaimVerdict =
  /** No claim present. The directory is takeable. */
  | { kind: "available" }
  /** Our own claim, already here. Acquire is idempotent and re-entrant. */
  | { kind: "self"; claim: WorkspaceDirClaim }
  /**
   * Held by a live run of the SAME seat. The incident case, and the one whose
   * message has to do real work -- see `describeWorkspaceDirClaimRefusal`.
   */
  | { kind: "sibling_run"; claim: WorkspaceDirClaim }
  /** Held by a live run of a different agent. */
  | { kind: "other_agent"; claim: WorkspaceDirClaim }
  /** Owner positively determined terminal: we may take over. */
  | { kind: "releasable"; claim: WorkspaceDirClaim }
  /** Present but unparseable, or owner liveness unknown. Refuse. */
  | { kind: "indeterminate"; reason: string; claim: WorkspaceDirClaim | null };

/**
 * Pure verdict: given what is on disk and what we know about its owner, may
 * this run take the directory?
 *
 * Split out from `acquireWorkspaceDirClaim` so every branch is directly
 * testable without a filesystem or a database. The I/O wrapper contributes
 * nothing to the decision.
 */
export function classifyWorkspaceDirClaim(input: {
  /** Raw file contents, or null when no claim file exists. */
  rawClaim: string | null;
  self: WorkspaceDirClaimIdentity;
  /** Liveness of the existing claim's owner. Ignored when there is no claim. */
  ownerLiveness: ClaimOwnerLiveness;
}): WorkspaceDirClaimVerdict {
  const { rawClaim, self, ownerLiveness } = input;
  if (rawClaim === null) return { kind: "available" };

  const claim = parseWorkspaceDirClaim(rawClaim);
  if (!claim) {
    return {
      kind: "indeterminate",
      reason: "a claim file is present but could not be parsed, so its owner cannot be identified",
      claim: null,
    };
  }

  // Before liveness: our own claim is ours whatever the DB says about us. A run
  // re-entering its own directory must never be refused by a lagging status
  // read of itself.
  if (claim.runId === self.runId) return { kind: "self", claim };

  if (ownerLiveness === "unknown") {
    return {
      kind: "indeterminate",
      reason: `the owning run ${claim.runId} could not be looked up, so it cannot be shown to have finished`,
      claim,
    };
  }
  if (ownerLiveness === "terminal") return { kind: "releasable", claim };

  // Live, and not us. The only remaining question is whether it is our own seat
  // -- which changes the advice completely, so it is a distinct verdict rather
  // than a flag on one.
  const sameAgent = Boolean(self.agentId && claim.agentId && self.agentId === claim.agentId);
  return sameAgent ? { kind: "sibling_run", claim } : { kind: "other_agent", claim };
}

/**
 * The agent-facing refusal text.
 *
 * The `sibling_run` arm is the reason this module exists. In the incident the
 * colliding run reported:
 *
 *   "a second writer was implementing this issue in it concurrently with me...
 *    No peer session is reachable from my pod (ListAgents -> none), so I could
 *    not coordinate directly."
 *
 * Both halves of that are true and the conclusion drawn from them was wrong.
 * `ListAgents` returns subagents, teammates and local sessions; a sibling run
 * of one's own seat is a separate pod and is invisible there BY CONSTRUCTION.
 * So "none" meant "this tool cannot answer that question", and it was read as
 * "nobody else is here" -- after which the run designed for an unreachable
 * peer, and did careful conservative work protecting a branch that the issue
 * thread had already declared empty 19 minutes earlier.
 *
 * The text therefore has to do three things, not one: name the holder, deny
 * the peer framing explicitly, and point at the surface where concurrent runs
 * of one seat actually do meet. Naming the holder alone would leave the
 * expensive half of the mistake intact.
 */
export function describeWorkspaceDirClaimRefusal(
  verdict: WorkspaceDirClaimVerdict,
  dirPath: string,
): string | null {
  switch (verdict.kind) {
    case "available":
    case "self":
    case "releasable":
      return null;
    case "sibling_run":
      return [
        `WORKSPACE CLAIMED: "${dirPath}" is held by run ${verdict.claim.runId}`,
        verdict.claim.issueId ? ` (working issue ${verdict.claim.issueId})` : "",
        ".",
        ` That run is ANOTHER RUN OF YOUR OWN SEAT (agent ${verdict.claim.agentId}), not a peer agent.`,
        " ListAgents cannot see it: it reports subagents, teammates and local sessions, and a sibling",
        " run is a separate pod, so an empty ListAgents result is NOT evidence that you are alone.",
        " Do not design around an unreachable peer and do not try to preserve its work by reading the",
        " filesystem -- you cannot tell its scratch edits from its real ones, and a careful restore of",
        " an empty branch costs a full budget (PEN-5352).",
        " The issue thread is the one surface where concurrent runs of a single seat meet: read the",
        " comments on the issue before doing anything else. The other run may already have posted what",
        " it is doing, or stood down and told you what is safe to discard.",
      ].join("");
    case "other_agent":
      return [
        `WORKSPACE CLAIMED: "${dirPath}" is held by run ${verdict.claim.runId}`,
        verdict.claim.agentId ? ` of agent ${verdict.claim.agentId}` : "",
        verdict.claim.issueId ? ` (working issue ${verdict.claim.issueId})` : "",
        ". Use a different directory; do not share this tree.",
      ].join("");
    case "indeterminate":
      return [
        `WORKSPACE CLAIM UNRESOLVED: "${dirPath}" carries a claim this run cannot clear --`,
        ` ${verdict.reason}.`,
        " Refusing rather than assuming it is dead. Work in a different directory, and if you believe",
        " the claim is genuinely abandoned, say so on the issue with the claim's contents rather than",
        " deleting it unilaterally.",
      ].join("");
  }
}

/**
 * Refusal for the per-issue case in criterion 1 of PEN-5352: a run that reaches
 * a per-issue directory WITHOUT holding that issue's checkout lock.
 *
 * Kept separate from the claim verdict because it catches a strictly earlier
 * failure. In the incident the first writer reached the directory before any
 * claim existed at all -- `available` was the honest verdict, and it was still
 * the wrong run to be there. The checkout lock is the control plane's answer to
 * "whose issue is this"; this is what makes consulting it unavoidable rather
 * than advisory.
 *
 * `"unknown"` refuses. The lock read is cheap and local; a run that cannot
 * establish whether it owns the issue has no business taking the issue's tree.
 */
export function refuseUnlockedIssueDirectory(input: {
  dirPath: string;
  issueId: string;
  /** Does THIS run hold the issue's checkout/execution lock? */
  selfHoldsIssueLock: boolean | "unknown";
  /** The run that does hold it, when known. Naming it makes the refusal actionable. */
  holderRunId?: string | null;
}): string | null {
  if (input.selfHoldsIssueLock === true) return null;
  const holder = input.holderRunId ? ` It is currently held by run ${input.holderRunId}.` : "";
  if (input.selfHoldsIssueLock === "unknown") {
    return [
      `ISSUE LOCK UNVERIFIED: "${input.dirPath}" is the working directory for issue ${input.issueId},`,
      " and this run could not confirm it holds that issue's checkout lock.",
      " Call paperclipCheckoutIssue and act on its answer before editing anything here.",
    ].join("");
  }
  return [
    `ISSUE LOCK NOT HELD: "${input.dirPath}" is the working directory for issue ${input.issueId},`,
    ` which this run does not have checked out.${holder}`,
    " Call paperclipCheckoutIssue first -- a 409 there is the answer, not an obstacle to route around.",
    " Editing this tree without the lock is how PEN-5352 happened: two runs shared one directory and",
    " each read its own diff back changed.",
  ].join("");
}

/**
 * Write the claim so that it is never observable without its contents.
 *
 * `link()` fails EEXIST when the target exists, so the winner/loser
 * determination is identical to `wx` -- but the bytes are already in the inode
 * before the name appears. See PEN-4877 in `workspace-runtime.ts`, which
 * measured the `wx` race at 0.075% of contended pairs, rising under threadpool
 * pressure.
 *
 * The staging file lives in the PARENT of the claimed directory: same
 * filesystem (so `link` cannot fail EXDEV), but outside the checkout, so a hard
 * kill between `link` and the cleanup cannot leave untracked noise in a working
 * tree that someone is about to run `git status` in.
 */
async function linkClaimExclusively(
  claimPath: string,
  content: string,
): Promise<"created" | "exists" | "unsupported"> {
  const staged = path.join(path.dirname(path.dirname(claimPath)), `.dir-claim-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(staged, content);
  } catch {
    return "unsupported";
  }
  try {
    await fs.link(staged, claimPath);
    return "created";
  } catch (error) {
    // Only EEXIST is "another run won". Anything else is the mount declining
    // hard links, which must not be reported as a concurrent winner.
    return (error as NodeJS.ErrnoException | null)?.code === "EEXIST" ? "exists" : "unsupported";
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

export type WorkspaceDirClaimOutcome = {
  /** True when this run may now work in the directory. */
  acquired: boolean;
  verdict: WorkspaceDirClaimVerdict;
  /** Agent-facing refusal text when `acquired` is false; null when it is true. */
  refusal: string | null;
};

/**
 * Take the directory, or explain precisely why not.
 *
 * `readOwnerLiveness` is injected rather than imported so this module keeps no
 * database dependency and every verdict stays unit-testable. It is called only
 * when a foreign claim actually exists, so the common uncontended path costs
 * one `link()` and no query.
 */
export async function acquireWorkspaceDirClaim(input: {
  dirPath: string;
  self: WorkspaceDirClaimIdentity;
  readOwnerLiveness: (runId: string) => Promise<ClaimOwnerLiveness>;
  now?: () => Date;
}): Promise<WorkspaceDirClaimOutcome> {
  const claimPath = path.join(input.dirPath, WORKSPACE_CLAIM_FILENAME);
  const record: WorkspaceDirClaim = {
    version: WORKSPACE_CLAIM_VERSION,
    runId: input.self.runId,
    agentId: input.self.agentId,
    companyId: input.self.companyId,
    issueId: input.self.issueId,
    acquiredAt: (input.now?.() ?? new Date()).toISOString(),
  };
  const content = formatWorkspaceDirClaim(record);

  // Two attempts at most: the second exists only to resolve the one race that
  // can legitimately change the answer -- we found a terminal owner, renamed it
  // aside, and a third run linked its own claim in between. Retrying further
  // would be a spin against a live holder.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const linked = await linkClaimExclusively(claimPath, content);
    if (linked === "created") {
      return { acquired: true, verdict: { kind: "available" }, refusal: null };
    }
    if (linked === "unsupported") {
      // The mount cannot give us exclusive-create. Say so rather than falling
      // back to a non-atomic write that would silently stop being a mutex.
      const verdict: WorkspaceDirClaimVerdict = {
        kind: "indeterminate",
        reason: "this filesystem does not support the atomic claim (hard links unavailable)",
        claim: null,
      };
      return { acquired: false, verdict, refusal: describeWorkspaceDirClaimRefusal(verdict, input.dirPath) };
    }

    const rawClaim = await fs.readFile(claimPath, "utf8").catch((error: unknown) => {
      // ENOENT here means the owner released between our link and our read, so
      // the directory is free and the next attempt will win it. Any other error
      // is a claim we cannot vet, which must refuse rather than read as absent.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      return undefined;
    });
    if (rawClaim === null) continue;
    if (rawClaim === undefined) {
      const verdict: WorkspaceDirClaimVerdict = {
        kind: "indeterminate",
        reason: "a claim file is present but could not be read",
        claim: null,
      };
      return { acquired: false, verdict, refusal: describeWorkspaceDirClaimRefusal(verdict, input.dirPath) };
    }

    const existing = parseWorkspaceDirClaim(rawClaim);
    const ownerLiveness: ClaimOwnerLiveness =
      !existing || existing.runId === input.self.runId
        ? "unknown" // unused by the classifier on these branches
        : await input.readOwnerLiveness(existing.runId).catch(() => "unknown" as const);

    const verdict = classifyWorkspaceDirClaim({ rawClaim, self: input.self, ownerLiveness });

    if (verdict.kind === "self") return { acquired: true, verdict, refusal: null };

    if (verdict.kind === "releasable" && attempt > 0) {
      // A SECOND terminal owner inside one acquire means the claim changed
      // hands while we were taking it. Report that rather than falling through:
      // `releasable` is a permitting verdict, so `describeWorkspaceDirClaimRefusal`
      // returns null for it, and returning `acquired: false` with a null refusal
      // would hand the caller a silent failure -- the one outcome this module
      // must never produce.
      break;
    }

    if (verdict.kind === "releasable") {
      // Move it aside rather than delete it, for the same reason
      // `ensureGitIndexIsUnlocked` renames: the verdict is evidential and this
      // is the only destructive act on the path. One inode keeps the evidence
      // if we were wrong about the owner.
      // Aside means OUT of the working tree, not next to the claim: a
      // `.released-*` file left inside a checkout shows up in every subsequent
      // `git status` and reads as a stray edit, which is the kind of noise a run
      // standing in a contended tree is least equipped to interpret.
      const abandoned = path.join(
        path.dirname(path.dirname(claimPath)),
        `.dir-claim-released-${existing?.runId ?? "unknown"}-${randomUUID()}.json`,
      );
      const moved = await fs.rename(claimPath, abandoned).then(() => true).catch(() => false);
      if (moved) continue;
      // Someone else cleared it first; let the next attempt re-read the truth.
      continue;
    }

    return {
      acquired: false,
      verdict,
      refusal: describeWorkspaceDirClaimRefusal(verdict, input.dirPath),
    };
  }

  const verdict: WorkspaceDirClaimVerdict = {
    kind: "indeterminate",
    reason: "the claim changed owner while this run was trying to take it",
    claim: null,
  };
  return { acquired: false, verdict, refusal: describeWorkspaceDirClaimRefusal(verdict, input.dirPath) };
}

/**
 * Drop our own claim. Never removes another run's: a release that could delete
 * a foreign claim would reintroduce exactly the overwrite this module prevents,
 * and a run exiting is the moment it is least able to judge whose claim it is
 * looking at.
 */
export async function releaseWorkspaceDirClaim(input: {
  dirPath: string;
  runId: string;
}): Promise<{ released: boolean; reason: string | null }> {
  const claimPath = path.join(input.dirPath, WORKSPACE_CLAIM_FILENAME);
  const raw = await fs.readFile(claimPath, "utf8").catch(() => null);
  if (raw === null) return { released: false, reason: "no claim present" };
  const claim = parseWorkspaceDirClaim(raw);
  if (!claim) return { released: false, reason: "claim present but unparseable; left in place" };
  if (claim.runId !== input.runId) {
    return { released: false, reason: `claim belongs to run ${claim.runId}; left in place` };
  }
  const removed = await fs.rm(claimPath, { force: true }).then(() => true).catch(() => false);
  return removed ? { released: true, reason: null } : { released: false, reason: "claim could not be removed" };
}
