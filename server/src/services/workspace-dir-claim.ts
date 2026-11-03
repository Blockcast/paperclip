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
 *   * **Taking over a dead claim is single-flight** (`electClaimSuccessor`).
 *     Verifying before removing is not sufficient on its own: POSIX has no
 *     "unlink only if this path is still that inode", so two runs that both
 *     vet one dead claim both proceed, and any scheme that removes the claim
 *     and re-creates it leaves the path briefly empty for a third run to win.
 *     Both were measured here, at two takers and at six. An exclusive-create
 *     election keyed on the dead claim's own bytes is what makes the removal
 *     single-flight, and it stays scoped to that one claim so a seat's
 *     concurrency is never serialised generally.
 *
 * It is deliberately NOT a lease with a timeout. An expiring lease would have
 * handed the incident directory to the second run on a clock rather than on a
 * fact, which is the failure mode this exists to prevent. That holds for the
 * election too: a successor stranded by a killed run is inherited only on a
 * positive terminal determination about that successor, never on its age.
 *
 * ## Where the claim lives
 *
 * In the git dir for a checkout, in the directory itself otherwise. See
 * `resolveWorkspaceClaimLocation` -- a claim in a working tree is an untracked
 * file in somebody else's repository, which `git add -A` commits and
 * `git clean -fd` deletes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * The claim for a directory that is NOT a git checkout. It lives inside the
 * directory it claims, so a run that `cd`s there finds it without being told
 * where to look, and so `rm -rf` of the workspace takes the claim with it
 * rather than stranding one.
 */
export const WORKSPACE_CLAIM_FILENAME = ".paperclip-dir-claim.json";

/** The same claim, when the directory IS a git checkout. See `resolveWorkspaceClaimLocation`. */
export const WORKSPACE_CLAIM_GIT_FILENAME = "paperclip-dir-claim.json";

/** Prefix for the evidence file a takeover leaves behind. */
const CLAIM_EVIDENCE_PREFIX = ".dir-claim-released-";

/**
 * How many takeover-evidence files to keep in one scratch directory.
 *
 * For a non-git workspace the scratch directory is the shared `/paperclip`
 * volume and nothing else ever removes these, so an unbounded set is a slow
 * leak on a mount every agent pod shares. The newest are the only ones anybody
 * would read.
 */
const MAX_RETAINED_CLAIM_EVIDENCE = 20;

/**
 * Where the claim for `dirPath` lives, and where this module may put its
 * scratch and evidence files for it.
 *
 * For a git checkout the claim goes in the repository's own git directory, NOT
 * in the working tree. A claim in the tree is an untracked file in somebody
 * else's repository as soon as this is wired in generally: a routine
 * `git add -A` commits the mutex into their PR, and `git clean -fd` deletes it
 * -- after which a concurrent run reads `available` and PEN-5352 happens again,
 * this time with the guard installed. Inside the git dir it is invisible to
 * both, while `rm -rf` of the workspace still takes it, which was the whole
 * reason for putting it in the tree in the first place.
 *
 * Only `<dirPath>/.git` counts. This deliberately does NOT walk up the way
 * `rev-parse --git-dir` does: for a subdirectory of a repository that would
 * resolve every subdirectory to ONE claim, and two runs working in two
 * different subtrees would then exclude each other for no reason. A `.git`
 * FILE is followed, because that is a linked worktree or a submodule and its
 * gitdir is per-worktree -- exactly the granularity this wants.
 *
 * PRECONDITION FOR CALLERS, raised by Ally on PR #3334: take the claim only
 * once the directory's final shape exists -- after the clone or worktree is
 * materialised, not before. This resolver is intentionally stateless and
 * re-reads the layout on every call, so a directory claimed at its root while
 * it is still plain, and then turned into a checkout (`git init`, a clone into
 * it), moves its OWN claim lookup to `<dir>/.git/`. The next run then reads
 * `available` with the original root claim still sitting there -- PEN-5352
 * again, with the guard installed. `releaseWorkspaceDirClaim` resolves the
 * same way, so such a claim is also unreleasable by the run that took it.
 *
 * The fix is ordering at the call site, not state here: a stateful resolver
 * would have to remember a location across processes, which is the kind of
 * durable side-state this module exists to avoid.
 */
export async function resolveWorkspaceClaimLocation(dirPath: string): Promise<{
  claimPath: string;
  /** Directory for staging and evidence files. Always on the claim's own filesystem. */
  scratchDir: string;
  inGitDir: boolean;
}> {
  const dotGit = path.join(dirPath, ".git");
  const marker = await fs.stat(dotGit).catch(() => null);
  let gitDir: string | null = null;
  if (marker?.isDirectory()) {
    gitDir = dotGit;
  } else if (marker?.isFile()) {
    const pointer = await fs.readFile(dotGit, "utf8").catch(() => null);
    const match = pointer?.match(/^\s*gitdir:\s*(.+?)\s*$/m);
    if (match) gitDir = path.resolve(dirPath, match[1]);
  }
  if (gitDir && (await fs.stat(gitDir).catch(() => null))?.isDirectory()) {
    return {
      claimPath: path.join(gitDir, WORKSPACE_CLAIM_GIT_FILENAME),
      scratchDir: gitDir,
      inGitDir: true,
    };
  }
  return {
    claimPath: path.join(dirPath, WORKSPACE_CLAIM_FILENAME),
    // The parent, not the directory itself: a staging or evidence file sitting
    // inside a tree someone is about to run `git status` in reads as a stray
    // edit, which is the kind of noise a run in a contended tree is least
    // equipped to interpret.
    scratchDir: path.dirname(dirPath),
    inGitDir: false,
  };
}

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

/** `errno` if we have one, so a refusal names the actual failure. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code ? code : "unknown error";
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
 * The staging file lives in `scratchDir`, which is chosen by
 * `resolveWorkspaceClaimLocation` to be on the claim's own filesystem and
 * outside any working tree -- so a hard kill between `link` and the cleanup
 * cannot leave untracked noise in a tree someone is about to run `git status`
 * in. For a git checkout that is the git dir, where EXDEV is impossible
 * because it is the same directory. For anything else it is the parent, which
 * is the same filesystem in every layout this runs in but is NOT guaranteed to
 * be: a `dirPath` that is itself a mount point (a PVC mounted at the workspace
 * path) would cross devices. That fails closed -- EXDEV is not EEXIST, so it
 * is reported as a refusal, never as a concurrent winner.
 */
async function linkClaimExclusively(
  claimPath: string,
  scratchDir: string,
  content: string,
): Promise<{ kind: "created" } | { kind: "exists" } | { kind: "failed"; reason: string }> {
  const staged = path.join(scratchDir, `.dir-claim-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(staged, content);
  } catch (error) {
    return {
      kind: "failed",
      reason: `the claim could not be staged in "${scratchDir}" (${errnoOf(error)})`,
    };
  }
  try {
    await fs.link(staged, claimPath);
    return { kind: "created" };
  } catch (error) {
    // Only EEXIST is "another run won". Anything else -- a missing directory,
    // a read-only mount, a full filesystem, a mount that declines hard links
    // -- must not be reported as a concurrent winner, and must say which it
    // was: "hard links unavailable" sends an agent hunting for a mount problem
    // when the directory simply does not exist.
    if (errnoOf(error) === "EEXIST") return { kind: "exists" };
    return {
      kind: "failed",
      reason: `the claim could not be linked into place (${errnoOf(error)})`,
    };
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

/** Prefix for the takeover-election token. See `electClaimSuccessor`. */
const CLAIM_SUCCESSOR_PREFIX = ".dir-claim-successor-";

/**
 * Elect ONE successor to a specific dead claim.
 *
 * Breaking a stale claim is the only operation here that removes a file
 * somebody else created, and it cannot be made safe by checking before
 * removing: POSIX has no "unlink only if this path is still that inode", so
 * two breakers that both vet the same dead claim will both proceed. An
 * exclusive-create on a name both of them compute is therefore the only
 * primitive that can elect between them, and this is it. The name is the
 * digest of the dead claim's own bytes, so the election is scoped to exactly
 * the claim being broken: a run breaking a DIFFERENT claim never contends for
 * it, which is what keeps a seat's concurrency from serialising generally.
 *
 * The usual objection to an election token is that it is a lock a killed run
 * leaves behind, and "a stale lock nothing can clear" is the failure this
 * module exists to prevent -- clearing one normally needs a timeout, which the
 * module header rules out. That is answered by chaining rather than by a
 * clock: if the elected successor is itself positively TERMINAL, it died
 * mid-takeover, and the next generation is keyed on the dead successor's id so
 * that exactly one run can inherit from it in turn. Every step still needs a
 * positive terminal determination, so no amount of waiting advances the chain
 * and nothing is ever broken on suspicion.
 */
async function electClaimSuccessor(input: {
  scratchDir: string;
  vettedRaw: string;
  selfRunId: string;
  deadRunId: string;
  readOwnerLiveness: (runId: string) => Promise<ClaimOwnerLiveness>;
}): Promise<{ kind: "elected"; tokenPath: string } | { kind: "refused"; reason: string }> {
  let chain = "";
  // Bounded only to keep a pathological chain from spinning: each step needs a
  // real run to have really died, so reaching the bound is not a timing
  // artefact and refusing there is honest.
  for (let generation = 0; generation < 5; generation += 1) {
    const digest = createHash("sha256").update(input.vettedRaw).update(chain).digest("hex").slice(0, 32);
    const tokenPath = path.join(input.scratchDir, `${CLAIM_SUCCESSOR_PREFIX}${digest}.json`);
    const body = `${JSON.stringify({ runId: input.selfRunId, deadRunId: input.deadRunId, generation })}\n`;

    const taken = await linkClaimExclusively(tokenPath, input.scratchDir, body);
    if (taken.kind === "created") return { kind: "elected", tokenPath };
    if (taken.kind === "failed") return { kind: "refused", reason: taken.reason };

    const raw = await fs.readFile(tokenPath, "utf8").catch(() => null);
    // Released between our link and our read: the previous successor finished.
    // Re-try the same generation rather than inheriting from a run that is not
    // dead.
    if (raw === null) continue;

    let holder: string | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const runId = (parsed as { runId?: unknown } | null)?.runId;
      holder = typeof runId === "string" && runId.trim() ? runId : null;
    } catch {
      holder = null;
    }
    if (!holder) {
      return { kind: "refused", reason: "a takeover token is present but could not be read" };
    }
    if (holder === input.selfRunId) return { kind: "elected", tokenPath };

    const liveness = await input.readOwnerLiveness(holder).catch(() => "unknown" as const);
    if (liveness !== "terminal") {
      return {
        kind: "refused",
        reason: `run ${holder} is already taking over this claim`,
      };
    }
    chain += `:${holder}`;
  }
  return {
    kind: "refused",
    reason: "this claim has had several takeovers die part-way through; it needs a human look",
  };
}

/**
 * After losing a takeover race, read `claimPath` once and say who actually
 * holds it now.
 *
 * Ally raised this on PR #3334, and it matters more than its size suggests:
 * the scenario `electClaimSuccessor` elects between is several runs of ONE
 * SEAT waking onto one orphaned claim, so the loser of that election is
 * usually a SIBLING of the winner. Reporting the dead owner's claim as
 * `indeterminate` hands that run "refusing rather than assuming it is dead"
 * and leaves the `sibling_run` text -- the ListAgents blind-spot warning,
 * which is the half of PEN-5352 that actually cost the money -- unreachable on
 * the one path most likely to need it.
 *
 * Diagnosis only. Nothing here removes, breaks or retries anything, and a
 * verdict is returned ONLY when the re-read is conclusive: a live foreign
 * owner. Everything else -- path now empty, unreadable, unparseable, liveness
 * unknown, or a new owner that is itself terminal -- returns null so the
 * caller keeps `indeterminate`, which is the honest verdict for each of them.
 * In particular a second terminal owner is NOT taken over here: breaking a
 * second claim on the strength of a verdict about the first is the posture the
 * retry loop already refuses.
 */
async function classifySettledClaimAfterLostRace(input: {
  claimPath: string;
  self: WorkspaceDirClaimIdentity;
  readOwnerLiveness: (runId: string) => Promise<ClaimOwnerLiveness>;
}): Promise<WorkspaceDirClaimVerdict | null> {
  const raw = await fs.readFile(input.claimPath, "utf8").catch(() => null);
  if (raw === null) return null;

  const claim = parseWorkspaceDirClaim(raw);
  // Our own claim here would mean we both lost the election and hold the path.
  // That is not a state we can explain, and `self` is a PERMITTING verdict, so
  // returning it would turn a refusal into a silent acquire. Fall through.
  if (!claim || claim.runId === input.self.runId) return null;

  const liveness = await input.readOwnerLiveness(claim.runId).catch(() => "unknown" as const);
  if (liveness !== "live") return null;

  const verdict = classifyWorkspaceDirClaim({ rawClaim: raw, self: input.self, ownerLiveness: liveness });
  return verdict.kind === "sibling_run" || verdict.kind === "other_agent" ? verdict : null;
}

/**
 * Take over a claim whose owner is KNOWN terminal, and leave the directory
 * held by exactly one run.
 *
 * Two defects live on this path, and they need different answers.
 *
 * The first is that `rename` moves whatever is at the PATH, not the claim that
 * was classified: two runs that both find one dead owner would otherwise BOTH
 * acquire, the second renaming the FIRST's live claim aside and linking over
 * it. Measured on this module at liveness latencies of 1 ms and 50 ms:
 * `[ true, true ]`, with the winner's live claim left in the parent
 * mislabelled as the dead owner's. The answer is to verify the bytes before
 * removing anything -- here, by `link`ing the evidence copy first, which
 * leaves `claimPath` exactly where it is, so a mismatch costs nothing and
 * disturbs nobody.
 *
 * The second only shows up with more than two runs, and byte-verification
 * alone does NOT fix it: any scheme that removes the claim and then re-creates
 * it leaves `claimPath` momentarily empty, and a FRESH run arriving in that
 * window links its own claim and acquires while the earlier winner still
 * believes it holds. Measured with six takers: two winners. So the removal has
 * to be single-flight, which is what `electClaimSuccessor` provides -- and the
 * remaining window, between our unlink and our link, is then safe, because
 * whoever fills it wins the ordinary EEXIST election and we refuse.
 */
async function takeOverDeadClaim(input: {
  claimPath: string;
  scratchDir: string;
  /** The exact bytes that were classified `releasable`. */
  vettedRaw: string;
  deadRunId: string;
  selfRunId: string;
  content: string;
  readOwnerLiveness: (runId: string) => Promise<ClaimOwnerLiveness>;
}): Promise<{ kind: "acquired" } | { kind: "refused"; reason: string }> {
  const elected = await electClaimSuccessor({
    scratchDir: input.scratchDir,
    vettedRaw: input.vettedRaw,
    selfRunId: input.selfRunId,
    deadRunId: input.deadRunId,
    readOwnerLiveness: input.readOwnerLiveness,
  });
  if (elected.kind === "refused") return elected;

  try {
    // Keep the evidence BEFORE removing anything, and keep it with `link` so
    // `claimPath` never moves. Renaming rather than deleting is the posture
    // `ensureGitIndexIsUnlocked` takes for the same reason: one inode keeps
    // the evidence if we were wrong about the owner. `link` is strictly
    // better here -- it keeps that inode without ever emptying the path.
    const evidence = path.join(
      input.scratchDir,
      `${CLAIM_EVIDENCE_PREFIX}${input.deadRunId}-${randomUUID()}.json`,
    );
    const kept = await fs.link(input.claimPath, evidence).then(() => true).catch(() => false);
    if (!kept) {
      return { kind: "refused", reason: "the claim vanished while this run was taking it over" };
    }

    const keptRaw = await fs.readFile(evidence, "utf8").catch(() => null);
    if (keptRaw !== input.vettedRaw) {
      // Not the claim we vetted. We have touched nothing but our own copy, so
      // there is nothing to undo.
      await fs.rm(evidence, { force: true }).catch(() => {});
      return { kind: "refused", reason: "the claim changed owner while this run was trying to take it" };
    }

    // Safe to remove now: we hold the election, so no other breaker can be
    // here, and no fresh run can alter a path that is still occupied.
    const removed = await fs.rm(input.claimPath, { force: true }).then(() => true).catch(() => false);
    if (!removed) {
      await fs.rm(evidence, { force: true }).catch(() => {});
      return { kind: "refused", reason: "the dead claim could not be removed" };
    }

    const linked = await linkClaimExclusively(input.claimPath, input.scratchDir, input.content);
    if (linked.kind === "created") {
      await pruneClaimEvidence(input.scratchDir, input.readOwnerLiveness);
      return { kind: "acquired" };
    }
    if (linked.kind === "exists") {
      // A fresh run linked into the window between our unlink and our link.
      // It won the ordinary election; the evidence stays, and we refuse.
      return { kind: "refused", reason: "another run claimed the directory as this run was taking it over" };
    }
    return { kind: "refused", reason: linked.reason };
  } finally {
    // Released on every path, so an ordinary takeover leaves no token behind.
    // One only survives a run that was KILLED mid-takeover, which is exactly
    // the case the next generation of the election is there to inherit.
    await fs.rm(elected.tokenPath, { force: true }).catch(() => {});
  }
}

/**
 * Cap the retained evidence files. Nothing else removes them, and for a
 * non-git workspace they land on the shared `/paperclip` volume, so an
 * unbounded set is a slow leak on a mount every agent pod shares.
 *
 * Best-effort and never fatal -- failing to prune must not fail a takeover
 * that otherwise succeeded.
 *
 * Two kinds of file are eligible, on two different rules.
 *
 * `released` evidence is pruned oldest-first past a cap. It is inert: a copy
 * of a claim whose owner was positively terminal when it was taken.
 *
 * `successor` election tokens are pruned ONLY when their holder is itself
 * positively terminal, and never on age. A live token is the election -- it is
 * what stops two breakers removing one claim -- so pruning one on age would
 * reintroduce the two-winner race this module measured. Ally raised the leak
 * on PR #3334: a successor that dies between its `rm` and its `link` strands
 * its token permanently, because the token is keyed on the digest of bytes
 * that no longer exist anywhere and so can never be recomputed by a later
 * run. The same holds for a dead gen-N token once gen-N+1 has succeeded,
 * since `finally` removes only the caller's own token. Harmless but unbounded
 * on a parent every agent pod shares, and a positive terminal determination
 * is exactly the evidence the rest of this module already requires before it
 * removes anything anyone else created.
 */
async function pruneClaimEvidence(
  scratchDir: string,
  readOwnerLiveness?: (runId: string) => Promise<ClaimOwnerLiveness>,
): Promise<void> {
  const names = await fs.readdir(scratchDir).catch(() => null);
  if (!names) return;
  if (readOwnerLiveness) await pruneDeadSuccessorTokens(scratchDir, names, readOwnerLiveness);
  const evidence = names.filter(
    (name) => name.startsWith(CLAIM_EVIDENCE_PREFIX) && name.endsWith(".json"),
  );
  if (evidence.length <= MAX_RETAINED_CLAIM_EVIDENCE) return;
  const dated = await Promise.all(
    evidence.map(async (name) => ({
      name,
      mtimeMs: (await fs.stat(path.join(scratchDir, name)).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(
    dated
      .slice(MAX_RETAINED_CLAIM_EVIDENCE)
      .map(({ name }) => fs.rm(path.join(scratchDir, name), { force: true }).catch(() => {})),
  );
}

/**
 * Remove election tokens whose holder is positively terminal.
 *
 * Deliberately NOT age-based. The only safe statement about a successor token
 * is the one the module makes everywhere else: the run named inside it has
 * finished. `unknown` leaves the token alone, which is the same fail-closed
 * posture `classifyWorkspaceDirClaim` takes -- a token we cannot attribute is
 * a token we must assume is live.
 */
async function pruneDeadSuccessorTokens(
  scratchDir: string,
  names: string[],
  readOwnerLiveness: (runId: string) => Promise<ClaimOwnerLiveness>,
): Promise<void> {
  const tokens = names.filter(
    (name) => name.startsWith(CLAIM_SUCCESSOR_PREFIX) && name.endsWith(".json"),
  );
  if (tokens.length === 0) return;
  await Promise.all(
    tokens.map(async (name) => {
      const tokenPath = path.join(scratchDir, name);
      const raw = await fs.readFile(tokenPath, "utf8").catch(() => null);
      if (raw === null) return;
      let holder: string | null = null;
      try {
        const runId = (JSON.parse(raw) as { runId?: unknown } | null)?.runId;
        holder = typeof runId === "string" && runId.trim() ? runId : null;
      } catch {
        holder = null;
      }
      // Unparseable is not evidence of death. Leave it.
      if (!holder) return;
      const liveness = await readOwnerLiveness(holder).catch(() => "unknown" as const);
      if (liveness !== "terminal") return;
      await fs.rm(tokenPath, { force: true }).catch(() => {});
    }),
  );
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
  const { claimPath, scratchDir } = await resolveWorkspaceClaimLocation(input.dirPath);
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
    const linked = await linkClaimExclusively(claimPath, scratchDir, content);
    if (linked.kind === "created") {
      return { acquired: true, verdict: { kind: "available" }, refusal: null };
    }
    if (linked.kind === "failed") {
      // We could not get exclusive-create. Say exactly what failed rather than
      // falling back to a non-atomic write that would silently stop being a
      // mutex -- and rather than blaming the mount for what may be a missing
      // directory or a full disk.
      const verdict: WorkspaceDirClaimVerdict = {
        kind: "indeterminate",
        reason: linked.reason,
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
      // Reaching here means the claim vanished under us on the first attempt
      // and a SECOND terminal owner's claim has appeared in its place. The
      // directory is changing hands faster than one acquire can follow, so
      // report that rather than breaking a second claim on the strength of a
      // verdict about the first.
      //
      // `break` rather than `return verdict`: `releasable` is a permitting
      // verdict, so `describeWorkspaceDirClaimRefusal` returns null for it,
      // and returning `acquired: false` with a null refusal would hand the
      // caller a silent failure -- the one outcome this module must never
      // produce. The tail below supplies a real one.
      break;
    }

    if (verdict.kind === "releasable") {
      const taken = await takeOverDeadClaim({
        claimPath,
        scratchDir,
        vettedRaw: rawClaim,
        deadRunId: verdict.claim.runId,
        selfRunId: input.self.runId,
        content,
        readOwnerLiveness: input.readOwnerLiveness,
      });
      if (taken.kind === "acquired") {
        return { acquired: true, verdict, refusal: null };
      }
      // Every refusal here is a race we lost or a claim that moved under us.
      // None of them permits a retry: the verdict we are holding is about a
      // claim that is no longer the one at the path. But we can still say WHO
      // is there now, and on this path that is usually a sibling run of our
      // own seat -- see `classifySettledClaimAfterLostRace`.
      const settled = await classifySettledClaimAfterLostRace({
        claimPath,
        self: input.self,
        readOwnerLiveness: input.readOwnerLiveness,
      });
      if (settled) {
        return {
          acquired: false,
          verdict: settled,
          refusal: describeWorkspaceDirClaimRefusal(settled, input.dirPath),
        };
      }
      const failed: WorkspaceDirClaimVerdict = {
        kind: "indeterminate",
        reason: taken.reason,
        claim: verdict.claim,
      };
      return {
        acquired: false,
        verdict: failed,
        refusal: describeWorkspaceDirClaimRefusal(failed, input.dirPath),
      };
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
  const { claimPath } = await resolveWorkspaceClaimLocation(input.dirPath);
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
