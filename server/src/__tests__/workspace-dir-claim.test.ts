import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_CLAIM_FILENAME,
  WORKSPACE_CLAIM_VERSION,
  acquireWorkspaceDirClaim,
  classifyWorkspaceDirClaim,
  describeWorkspaceDirClaimRefusal,
  formatWorkspaceDirClaim,
  parseWorkspaceDirClaim,
  refuseUnlockedIssueDirectory,
  releaseWorkspaceDirClaim,
  type ClaimOwnerLiveness,
  type WorkspaceDirClaimIdentity,
} from "../services/workspace-dir-claim.js";

const AGENT = "29033747-e513-46d5-8a13-dcb5dac10017";
const OTHER_AGENT = "11b9c48f-aee6-4ac4-8f4a-5ba60c73fb9c";
const COMPANY = "b1d3f3d3-adc9-48af-beb1-013a18368d84";
const RUN_A = "8e92db74-0000-0000-0000-000000000000";
const RUN_B = "3dc4f77d-0000-0000-0000-000000000000";
const ISSUE = "b40a2360-d8b6-4a90-9526-084f48c00de8";

function identity(overrides: Partial<WorkspaceDirClaimIdentity> = {}): WorkspaceDirClaimIdentity {
  return { runId: RUN_A, agentId: AGENT, companyId: COMPANY, issueId: ISSUE, ...overrides };
}

function claimOf(runId: string, agentId: string | null, issueId: string | null = ISSUE): string {
  return formatWorkspaceDirClaim({
    version: WORKSPACE_CLAIM_VERSION,
    runId,
    agentId,
    companyId: COMPANY,
    issueId,
    acquiredAt: "2026-11-03T01:40:44.000Z",
  });
}

describe("parseWorkspaceDirClaim", () => {
  it("round-trips a formatted claim", () => {
    const parsed = parseWorkspaceDirClaim(claimOf(RUN_A, AGENT));
    expect(parsed?.runId).toBe(RUN_A);
    expect(parsed?.agentId).toBe(AGENT);
    expect(parsed?.issueId).toBe(ISSUE);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   \n"],
    ["not json", "{not json"],
    ["a json array", "[]"],
    ["json null", "null"],
    ["an object with no runId", JSON.stringify({ version: WORKSPACE_CLAIM_VERSION })],
    ["a blank runId", JSON.stringify({ version: WORKSPACE_CLAIM_VERSION, runId: "  " })],
    ["an unknown version", JSON.stringify({ version: 99, runId: RUN_A })],
  ])("returns null for %s", (_label, raw) => {
    expect(parseWorkspaceDirClaim(raw)).toBeNull();
  });

  /**
   * The half-written claim PEN-4877 measured. It must not read as "no claim" --
   * that would hand the directory to the racing run, which is the whole defect.
   */
  it("returns null for a truncated claim rather than a partial record", () => {
    const truncated = claimOf(RUN_A, AGENT).slice(0, 20);
    expect(parseWorkspaceDirClaim(truncated)).toBeNull();
  });
});

describe("classifyWorkspaceDirClaim", () => {
  const base = { self: identity(), ownerLiveness: "live" as ClaimOwnerLiveness };

  it("reports an unclaimed directory as available", () => {
    expect(classifyWorkspaceDirClaim({ ...base, rawClaim: null })).toEqual({ kind: "available" });
  });

  it("recognises our own claim even when our own liveness reads unknown", () => {
    const verdict = classifyWorkspaceDirClaim({
      ...base,
      rawClaim: claimOf(RUN_A, AGENT),
      ownerLiveness: "unknown",
    });
    expect(verdict.kind).toBe("self");
  });

  /** The PEN-5352 incident shape: same seat, different run, both live. */
  it("classifies a live run of the SAME agent as a sibling run", () => {
    const verdict = classifyWorkspaceDirClaim({ ...base, rawClaim: claimOf(RUN_B, AGENT) });
    expect(verdict.kind).toBe("sibling_run");
  });

  it("classifies a live run of a DIFFERENT agent as another agent", () => {
    const verdict = classifyWorkspaceDirClaim({ ...base, rawClaim: claimOf(RUN_B, OTHER_AGENT) });
    expect(verdict.kind).toBe("other_agent");
  });

  it("will not call a claim a sibling when either side's agent is unknown", () => {
    expect(classifyWorkspaceDirClaim({ ...base, rawClaim: claimOf(RUN_B, null) }).kind).toBe("other_agent");
    expect(
      classifyWorkspaceDirClaim({
        ...base,
        self: identity({ agentId: null }),
        rawClaim: claimOf(RUN_B, AGENT),
      }).kind,
    ).toBe("other_agent");
  });

  it("allows takeover only on a positive terminal determination", () => {
    expect(
      classifyWorkspaceDirClaim({ ...base, rawClaim: claimOf(RUN_B, AGENT), ownerLiveness: "terminal" }).kind,
    ).toBe("releasable");
  });

  /**
   * The fail-closed invariant this module inherits from
   * `ensureGitIndexIsUnlocked`: "I could not look" is not a determination.
   */
  it("refuses rather than releasing when owner liveness is unknown", () => {
    const verdict = classifyWorkspaceDirClaim({
      ...base,
      rawClaim: claimOf(RUN_B, AGENT),
      ownerLiveness: "unknown",
    });
    expect(verdict.kind).toBe("indeterminate");
    expect(verdict.kind === "indeterminate" && verdict.reason).toContain(RUN_B);
  });

  it("treats an unparseable claim as indeterminate, never as available", () => {
    const verdict = classifyWorkspaceDirClaim({ ...base, rawClaim: "{garbage" });
    expect(verdict.kind).toBe("indeterminate");
    expect(verdict.kind).not.toBe("available");
  });
});

describe("describeWorkspaceDirClaimRefusal", () => {
  it("is silent on every verdict that permits work", () => {
    expect(describeWorkspaceDirClaimRefusal({ kind: "available" }, "/w")).toBeNull();
    const claim = parseWorkspaceDirClaim(claimOf(RUN_A, AGENT))!;
    expect(describeWorkspaceDirClaimRefusal({ kind: "self", claim }, "/w")).toBeNull();
    expect(describeWorkspaceDirClaimRefusal({ kind: "releasable", claim }, "/w")).toBeNull();
  });

  /**
   * The misdiagnosis is the expensive half of PEN-5352, so the sibling text is
   * asserted on content, not merely on presence. A refusal that named the
   * holder but left "unreachable peer" standing would reproduce the incident.
   */
  it("denies the peer framing, names the ListAgents blind spot, and routes to the issue thread", () => {
    const claim = parseWorkspaceDirClaim(claimOf(RUN_B, AGENT))!;
    const text = describeWorkspaceDirClaimRefusal({ kind: "sibling_run", claim }, "/paperclip/wt/pen-4522/repo")!;
    expect(text).toContain("/paperclip/wt/pen-4522/repo");
    expect(text).toContain(RUN_B);
    expect(text).toContain("YOUR OWN SEAT");
    expect(text).toContain("ListAgents cannot see it");
    expect(text).toContain("NOT evidence that you are alone");
    expect(text).toContain("issue thread");
    expect(text).toContain("PEN-5352");
  });

  it("does not claim a different agent's run is our own seat", () => {
    const claim = parseWorkspaceDirClaim(claimOf(RUN_B, OTHER_AGENT))!;
    const text = describeWorkspaceDirClaimRefusal({ kind: "other_agent", claim }, "/w")!;
    expect(text).toContain(OTHER_AGENT);
    expect(text).not.toContain("YOUR OWN SEAT");
  });

  it("tells an indeterminate claim not to be deleted unilaterally", () => {
    const text = describeWorkspaceDirClaimRefusal(
      { kind: "indeterminate", reason: "owner unknown", claim: null },
      "/w",
    )!;
    expect(text).toContain("Refusing rather than assuming it is dead");
    expect(text).toContain("rather than");
  });
});

describe("refuseUnlockedIssueDirectory", () => {
  it("permits the run that holds the issue lock", () => {
    expect(
      refuseUnlockedIssueDirectory({ dirPath: "/w", issueId: ISSUE, selfHoldsIssueLock: true }),
    ).toBeNull();
  });

  /** Criterion 1: reaching a per-issue tree without the lock is refused. */
  it("refuses a run that does not hold the lock, and names the holder", () => {
    const text = refuseUnlockedIssueDirectory({
      dirPath: "/paperclip/wt/pen-4522/repo",
      issueId: ISSUE,
      selfHoldsIssueLock: false,
      holderRunId: RUN_B,
    })!;
    expect(text).toContain("ISSUE LOCK NOT HELD");
    expect(text).toContain(RUN_B);
    expect(text).toContain("paperclipCheckoutIssue");
    // Run 8e92db74's own stand-down: the 409 IS the answer.
    expect(text).toContain("409");
  });

  it("refuses when the lock could not be verified at all", () => {
    const text = refuseUnlockedIssueDirectory({
      dirPath: "/w",
      issueId: ISSUE,
      selfHoldsIssueLock: "unknown",
    })!;
    expect(text).toContain("ISSUE LOCK UNVERIFIED");
    expect(text).toContain("paperclipCheckoutIssue");
  });
});

describe("acquireWorkspaceDirClaim", () => {
  let root: string;
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pen5352-"));
    dirA = path.join(root, "pen-4522", "repo");
    dirB = path.join(root, "pen-5352", "repo");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const live = async (): Promise<ClaimOwnerLiveness> => "live";
  const terminal = async (): Promise<ClaimOwnerLiveness> => "terminal";
  const unknown = async (): Promise<ClaimOwnerLiveness> => "unknown";

  it("claims a clean directory and writes a readable claim", async () => {
    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: live,
    });
    expect(outcome.acquired).toBe(true);
    expect(outcome.refusal).toBeNull();

    const written = parseWorkspaceDirClaim(
      await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8"),
    );
    expect(written?.runId).toBe(RUN_A);
    expect(written?.issueId).toBe(ISSUE);
  });

  it("does not consult the database when the directory is uncontended", async () => {
    const readOwnerLiveness = vi.fn(live);
    await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness });
    expect(readOwnerLiveness).not.toHaveBeenCalled();
  });

  it("is re-entrant for the same run", async () => {
    await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    const again = await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    expect(again.acquired).toBe(true);
    expect(again.verdict.kind).toBe("self");
  });

  /**
   * The incident, reproduced: one seat, one issue, one directory, two runs.
   * The second must be refused -- in the incident it was not, and it spent its
   * whole budget restoring a branch that had never held a commit.
   */
  it("refuses a second run of the same seat in the same directory", async () => {
    const first = await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    expect(first.acquired).toBe(true);

    const second = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: live,
    });
    expect(second.acquired).toBe(false);
    expect(second.verdict.kind).toBe("sibling_run");
    expect(second.refusal).toContain("YOUR OWN SEAT");
    expect(second.refusal).toContain(RUN_A);
  });

  it("leaves the incumbent claim untouched when it refuses", async () => {
    await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    const before = await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8");
    await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: live,
    });
    expect(await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8")).toBe(before);
  });

  /**
   * PEN-5352 criterion 3, the POSITIVE CONTROL: the fix must stop the seat
   * corrupting itself without serialising its concurrency. Two runs of ONE
   * agent working two DIFFERENT issues in two directories must both proceed.
   *
   * This is the test that fails if the claim is ever re-keyed on the agent (or
   * on anything else seat-wide) rather than on the directory.
   */
  it("positive control: two runs of one seat on different issues both acquire", async () => {
    const first = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_A, issueId: ISSUE }),
      readOwnerLiveness: live,
    });
    const second = await acquireWorkspaceDirClaim({
      dirPath: dirB,
      self: identity({ runId: RUN_B, issueId: "99999999-0000-0000-0000-000000000000" }),
      readOwnerLiveness: live,
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(first.refusal).toBeNull();
    expect(second.refusal).toBeNull();
  });

  it("refuses a different agent's live claim", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B, agentId: OTHER_AGENT }),
      readOwnerLiveness: live,
    });
    const outcome = await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("other_agent");
  });

  it("takes over a terminal owner's claim and keeps it as evidence outside the tree", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: live,
    });
    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: terminal,
    });
    expect(outcome.acquired).toBe(true);

    const now = parseWorkspaceDirClaim(
      await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8"),
    );
    expect(now?.runId).toBe(RUN_A);

    // Evidence kept, and kept OUT of the working tree so it cannot read as a
    // stray edit in `git status`.
    const inTree = await fs.readdir(dirA);
    expect(inTree.filter((name) => name.includes("released"))).toEqual([]);
    const aside = (await fs.readdir(path.dirname(dirA))).filter((name) => name.includes("released"));
    expect(aside).toHaveLength(1);
    expect(parseWorkspaceDirClaim(
      await fs.readFile(path.join(path.dirname(dirA), aside[0]), "utf8"),
    )?.runId).toBe(RUN_B);
  });

  it("refuses, and preserves the claim, when the owner cannot be looked up", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: live,
    });
    const outcome = await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: unknown });
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("indeterminate");
    expect(parseWorkspaceDirClaim(
      await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8"),
    )?.runId).toBe(RUN_B);
  });

  it("refuses when the liveness lookup throws, rather than treating it as free", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: live,
    });
    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: async () => {
        throw new Error("db down");
      },
    });
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("indeterminate");
  });

  it("refuses an unparseable incumbent claim instead of overwriting it", async () => {
    await fs.writeFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "{half-written");
    const outcome = await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("indeterminate");
    expect(await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8")).toBe("{half-written");
  });

  it("leaves no staging file behind in the parent", async () => {
    await acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live });
    const strays = (await fs.readdir(path.dirname(dirA))).filter((name) => name.endsWith(".tmp"));
    expect(strays).toEqual([]);
  });

  /**
   * Class invariant, not a single case: a refused acquire must always carry
   * text explaining itself. A `false`/`null` pair is a silent failure -- the
   * caller is blocked and has nothing to tell anyone, which is indistinguishable
   * at the call site from the module having done nothing at all. One early
   * draft could produce it on the takeover path (a `releasable` verdict reached
   * on the retry, where the describer correctly returns null because
   * `releasable` permits work). Asserting the invariant catches that whole
   * class rather than the one instance.
   */
  it("never refuses silently: acquired=false always carries a refusal", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: live,
    });

    const contended = await Promise.all([
      acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: live }),
      acquireWorkspaceDirClaim({ dirPath: dirA, self: identity(), readOwnerLiveness: unknown }),
      acquireWorkspaceDirClaim({
        dirPath: dirA,
        self: identity({ agentId: OTHER_AGENT }),
        readOwnerLiveness: live,
      }),
      acquireWorkspaceDirClaim({
        dirPath: dirA,
        self: identity(),
        readOwnerLiveness: async () => {
          throw new Error("db down");
        },
      }),
    ]);

    for (const outcome of contended) {
      expect(outcome.acquired).toBe(false);
      expect(outcome.refusal).toBeTruthy();
    }
  });

  /**
   * Exactly one winner under concurrency. The assertion is on the COUNT of
   * acquisitions, not on which run wins -- either outcome is correct, two is
   * the bug.
   */
  it("admits exactly one winner when runs race for one directory", async () => {
    const runs = ["r1", "r2", "r3", "r4", "r5"].map((runId) =>
      acquireWorkspaceDirClaim({ dirPath: dirA, self: identity({ runId }), readOwnerLiveness: live }),
    );
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((outcome) => outcome.acquired)).toHaveLength(1);
  });
});

describe("releaseWorkspaceDirClaim", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pen5352-rel-"));
    dir = path.join(root, "repo");
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("drops our own claim", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dir,
      self: identity(),
      readOwnerLiveness: async () => "live",
    });
    expect(await releaseWorkspaceDirClaim({ dirPath: dir, runId: RUN_A })).toEqual({
      released: true,
      reason: null,
    });
    await expect(fs.readFile(path.join(dir, WORKSPACE_CLAIM_FILENAME), "utf8")).rejects.toThrow();
  });

  /** A release that could delete a foreign claim would reintroduce the defect. */
  it("never drops another run's claim", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: dir,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: async () => "live",
    });
    const result = await releaseWorkspaceDirClaim({ dirPath: dir, runId: RUN_A });
    expect(result.released).toBe(false);
    expect(result.reason).toContain(RUN_B);
    expect(parseWorkspaceDirClaim(
      await fs.readFile(path.join(dir, WORKSPACE_CLAIM_FILENAME), "utf8"),
    )?.runId).toBe(RUN_B);
  });

  it("leaves an unparseable claim in place", async () => {
    await fs.writeFile(path.join(dir, WORKSPACE_CLAIM_FILENAME), "{half");
    const result = await releaseWorkspaceDirClaim({ dirPath: dir, runId: RUN_A });
    expect(result.released).toBe(false);
    expect(await fs.readFile(path.join(dir, WORKSPACE_CLAIM_FILENAME), "utf8")).toBe("{half");
  });

  it("reports cleanly when there is nothing to release", async () => {
    expect(await releaseWorkspaceDirClaim({ dirPath: dir, runId: RUN_A })).toEqual({
      released: false,
      reason: "no claim present",
    });
  });
});
