import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_CLAIM_FILENAME,
  WORKSPACE_CLAIM_GIT_FILENAME,
  WORKSPACE_CLAIM_VERSION,
  acquireWorkspaceDirClaim,
  classifyWorkspaceDirClaim,
  describeWorkspaceDirClaimRefusal,
  formatWorkspaceDirClaim,
  parseWorkspaceDirClaim,
  refuseUnlockedIssueDirectory,
  releaseWorkspaceDirClaim,
  resolveWorkspaceClaimLocation,
  type ClaimOwnerLiveness,
  type WorkspaceDirClaimIdentity,
} from "../services/workspace-dir-claim.js";

const run = promisify(execFile);

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

  /**
   * The acquire-level positive control cannot catch a classifier re-key: those
   * two runs use different `dirPath`s and never meet here. This is the pure
   * assertion that the ISSUE field is not an input to the verdict -- same seat,
   * different run, DIFFERENT issue, one directory is still a sibling run.
   */
  it("keys a sibling run on the agent alone, never on the issue", () => {
    expect(
      classifyWorkspaceDirClaim({
        rawClaim: claimOf(RUN_B, AGENT, "a-completely-different-issue"),
        self: identity({ runId: RUN_A, issueId: ISSUE }),
        ownerLiveness: "live",
      }),
    ).toMatchObject({ kind: "sibling_run" });
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

  /**
   * The same guarantee on the TAKEOVER path, which is the one the restart
   * scenario actually walks: a seat at `maxConcurrentRuns: 5` waking several
   * runs after a crash, all of them looking at one orphaned claim.
   *
   * The staggered liveness reads are the whole point. `rename` moves whatever
   * sits at the PATH, not the claim that was classified -- so a slow taker
   * that finishes classifying the dead owner only AFTER a fast one has already
   * broken in will rename the WINNER's live claim aside and link over it.
   * Both then report `acquired: true`, which is PEN-5352 reproduced by the
   * module written to prevent it.
   */
  it("admits exactly one winner when runs race to take over ONE terminal claim", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    await fs.writeFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), claimOf(DEAD_RUN, OTHER_AGENT));

    // Only the incumbent is dead. The racing runs are live -- a stub that
    // reported every run terminal would be saying the callers themselves are
    // dead, and a late arrival taking over a fresh winner's claim would then
    // be CORRECT behaviour rather than the defect under test.
    const taker = (runId: string, latencyMs: number) =>
      acquireWorkspaceDirClaim({
        dirPath: dirA,
        self: identity({ runId }),
        readOwnerLiveness: async (lookedUp) => {
          await new Promise((resolve) => setTimeout(resolve, latencyMs));
          return lookedUp === DEAD_RUN ? "terminal" : "live";
        },
      });

    const outcomes = await Promise.all([taker(RUN_A, 1), taker(RUN_B, 50)]);
    const winners = outcomes.filter((outcome) => outcome.acquired);
    expect(winners).toHaveLength(1);

    // The directory must end up holding the winner's claim, and the loser must
    // have been told why rather than left to infer it.
    const onDisk = parseWorkspaceDirClaim(
      await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8"),
    );
    expect([RUN_A, RUN_B]).toContain(onDisk?.runId);
    const loser = outcomes.find((outcome) => !outcome.acquired);
    expect(loser?.refusal).toBeTruthy();

    // Evidence must be labelled with the run whose claim it actually is. The
    // mislabelling is not cosmetic: a `.dir-claim-released-<dead>` file that
    // in fact holds a LIVE run's claim is the artefact an operator would read
    // to decide the directory was safely free.
    const parent = path.dirname(dirA);
    const evidence = (await fs.readdir(parent)).filter((name) => name.includes("released"));
    for (const name of evidence) {
      const claim = parseWorkspaceDirClaim(await fs.readFile(path.join(parent, name), "utf8"));
      expect(name).toContain(claim?.runId ?? "unparseable");
      expect(claim?.runId).toBe(DEAD_RUN);
    }
  });

  /**
   * The same takeover race widened: five runs, scattered liveness latencies,
   * one dead incumbent. This is the shape of the restart the module exists for
   * -- a seat at `maxConcurrentRuns: 5` waking every run at once against one
   * orphaned claim -- and it is run repeatedly because a concurrency guarantee
   * that holds for one interleaving is not a guarantee.
   */
  it("admits exactly one winner no matter how the takeover attempts interleave", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    for (let round = 0; round < 12; round += 1) {
      const dir = path.join(root, `round-${round}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, WORKSPACE_CLAIM_FILENAME), claimOf(DEAD_RUN, OTHER_AGENT));

      const outcomes = await Promise.all(
        [0, 1, 2, 3, 5, 8].map(async (latencyMs, index) => {
          const runId = `race-${round}-${index}`;
          const outcome = await acquireWorkspaceDirClaim({
            dirPath: dir,
            self: identity({ runId }),
            readOwnerLiveness: async (lookedUp) => {
              await new Promise((resolve) => setTimeout(resolve, latencyMs));
              return lookedUp === DEAD_RUN ? "terminal" : "live";
            },
          });
          return { runId, outcome };
        }),
      );

      const winners = outcomes.filter(({ outcome }) => outcome.acquired);
      expect(winners).toHaveLength(1);
      // The directory must be held by the run that was TOLD it won -- a later
      // breaker linking over the winner is the defect, and it leaves exactly
      // one winner in the return values while the claim on disk says someone
      // else.
      const held = parseWorkspaceDirClaim(
        await fs.readFile(path.join(dir, WORKSPACE_CLAIM_FILENAME), "utf8"),
      );
      expect(held?.runId).toBe(winners[0].runId);
      for (const { outcome } of outcomes.filter(({ outcome }) => !outcome.acquired)) {
        expect(outcome.refusal).toBeTruthy();
      }
    }
  });

  /**
   * The election that makes the takeover single-flight is itself a file a
   * killed run can leave behind, and "a stale lock nothing can clear" is the
   * failure this module exists to prevent. These two pin the way out: a LIVE
   * successor blocks, and a TERMINAL one is inherited -- on a positive
   * determination, never on a clock.
   *
   * The token name is recomputed here rather than exported, because the
   * property under test IS the naming: the election is keyed on the dead
   * claim's own bytes, so breaking a different claim never contends for it.
   */
  const successorTokenPath = (scratchDir: string, vettedRaw: string, chain = "") =>
    path.join(
      scratchDir,
      `.dir-claim-successor-${createHash("sha256").update(vettedRaw).update(chain).digest("hex").slice(0, 32)}.json`,
    );

  it("refuses while another run is already taking over the same claim", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    const raw = claimOf(DEAD_RUN, OTHER_AGENT);
    await fs.writeFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), raw);
    await fs.writeFile(
      successorTokenPath(path.dirname(dirA), raw),
      `${JSON.stringify({ runId: RUN_B, deadRunId: DEAD_RUN, generation: 0 })}\n`,
    );

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      // The dead owner is terminal; the run holding the election is not.
      readOwnerLiveness: async (runId) => (runId === RUN_B ? "live" : "terminal"),
    });
    expect(outcome.acquired).toBe(false);
    expect(outcome.refusal).toContain(RUN_B);
    // And it did not touch the claim it was refused from taking.
    expect(
      parseWorkspaceDirClaim(await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8"))?.runId,
    ).toBe(DEAD_RUN);
  });

  /**
   * The loser of the election is, in the scenario this module was built for,
   * usually a SIBLING of the winner: several runs of one seat waking onto one
   * orphaned claim. Reporting the dead owner as "unresolved" would hand that
   * run the one message that does not carry the ListAgents warning -- the
   * expensive half of PEN-5352 -- on the path most likely to need it.
   */
  it("names the sibling that won the takeover race instead of reporting it unresolved", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    const raw = claimOf(DEAD_RUN, OTHER_AGENT);
    const claimFile = path.join(dirA, WORKSPACE_CLAIM_FILENAME);
    await fs.writeFile(claimFile, raw);
    await fs.writeFile(
      successorTokenPath(path.dirname(dirA), raw),
      `${JSON.stringify({ runId: RUN_B, deadRunId: DEAD_RUN, generation: 0 })}\n`,
    );

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: async (runId) => {
        if (runId !== RUN_B) return "terminal";
        // RUN_B holds the election, and by the time we lose it, it has
        // finished the takeover: its own claim is at the path now. Same seat
        // as us, which is the restart case the election exists to resolve.
        await fs.writeFile(claimFile, claimOf(RUN_B, AGENT));
        return "live";
      },
    });

    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("sibling_run");
    expect(outcome.refusal).toContain(RUN_B);
    expect(outcome.refusal).toContain("ListAgents");
    expect(outcome.refusal).toContain("issue thread");
  });

  it("stays indeterminate when the lost race leaves nothing conclusive at the path", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    const raw = claimOf(DEAD_RUN, OTHER_AGENT);
    const claimFile = path.join(dirA, WORKSPACE_CLAIM_FILENAME);
    await fs.writeFile(claimFile, raw);
    await fs.writeFile(
      successorTokenPath(path.dirname(dirA), raw),
      `${JSON.stringify({ runId: RUN_B, deadRunId: DEAD_RUN, generation: 0 })}\n`,
    );

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: async (runId) => {
        if (runId !== RUN_B) return "terminal";
        // The winner has removed the dead claim but not yet linked its own.
        await fs.rm(claimFile, { force: true });
        return "live";
      },
    });

    // Still a refusal, and still an honest one: we know we lost, and we
    // cannot say to whom. It must never read as `available`.
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("indeterminate");
    expect(outcome.refusal).not.toBeNull();
  });

  it("does not take over a second claim it merely happened to find on the re-read", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    const SECOND_DEAD = "00000000-dea2-dea2-dea2-000000000000";
    const raw = claimOf(DEAD_RUN, OTHER_AGENT);
    const claimFile = path.join(dirA, WORKSPACE_CLAIM_FILENAME);
    await fs.writeFile(claimFile, raw);
    await fs.writeFile(
      successorTokenPath(path.dirname(dirA), raw),
      `${JSON.stringify({ runId: RUN_B, deadRunId: DEAD_RUN, generation: 0 })}\n`,
    );

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: async (runId) => {
        if (runId !== RUN_B) return "terminal";
        await fs.writeFile(claimFile, claimOf(SECOND_DEAD, OTHER_AGENT));
        return "live";
      },
    });

    // The re-read is diagnosis only. A second terminal owner is reported, not
    // broken: breaking it would be acting on a verdict about a different claim.
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict.kind).toBe("indeterminate");
    expect(
      parseWorkspaceDirClaim(await fs.readFile(claimFile, "utf8"))?.runId,
    ).toBe(SECOND_DEAD);
  });

  it("reaps an election token whose holder is positively terminal, and leaves a live one", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    const STRANDED = "00000000-str1-str1-str1-000000000000";
    const LIVE_ELSEWHERE = "00000000-1ive-1ive-1ive-000000000000";
    const scratch = path.dirname(dirA);
    const raw = claimOf(DEAD_RUN, OTHER_AGENT);
    await fs.writeFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), raw);

    // Two tokens from OTHER claims, stranded on the shared parent. Neither is
    // keyed on bytes this acquire will ever recompute.
    const strandedToken = path.join(scratch, ".dir-claim-successor-aaaa1111.json");
    const liveToken = path.join(scratch, ".dir-claim-successor-bbbb2222.json");
    await fs.writeFile(strandedToken, `${JSON.stringify({ runId: STRANDED, generation: 0 })}\n`);
    await fs.writeFile(liveToken, `${JSON.stringify({ runId: LIVE_ELSEWHERE, generation: 0 })}\n`);

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: async (runId) => (runId === LIVE_ELSEWHERE ? "live" : "terminal"),
    });
    expect(outcome.acquired).toBe(true);

    // The dead holder's token is gone; the live holder's election is intact,
    // because removing it would reintroduce the two-winner race.
    await expect(fs.stat(strandedToken)).rejects.toThrow();
    expect(await fs.readFile(liveToken, "utf8")).toContain(LIVE_ELSEWHERE);
  });

  it("inherits the takeover when the elected successor itself died part-way", async () => {
    const DEAD_RUN = "00000000-dead-dead-dead-000000000000";
    const DEAD_SUCCESSOR = "00000000-gone-gone-gone-000000000000";
    const raw = claimOf(DEAD_RUN, OTHER_AGENT);
    await fs.writeFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), raw);
    await fs.writeFile(
      successorTokenPath(path.dirname(dirA), raw),
      `${JSON.stringify({ runId: DEAD_SUCCESSOR, deadRunId: DEAD_RUN, generation: 0 })}\n`,
    );

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: async () => "terminal",
    });
    // Inherited, because the stranded successor was POSITIVELY terminal. No
    // timeout was involved and none would have helped.
    expect(outcome.acquired).toBe(true);
    expect(
      parseWorkspaceDirClaim(await fs.readFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), "utf8"))?.runId,
    ).toBe(RUN_A);
  });

  it("names the actual errno instead of blaming the mount", async () => {
    const missing = path.join(root, "does-not-exist", "repo");
    const outcome = await acquireWorkspaceDirClaim({
      dirPath: missing,
      self: identity(),
      readOwnerLiveness: live,
    });
    expect(outcome.acquired).toBe(false);
    expect(outcome.verdict).toMatchObject({ kind: "indeterminate" });
    // ENOENT must not read as "hard links unavailable": that sends a run
    // hunting for a mount problem when the directory simply is not there.
    expect(outcome.refusal).toContain("ENOENT");
    expect(outcome.refusal).not.toContain("hard links unavailable");
  });

  it("bounds the takeover evidence it leaves in a shared parent", async () => {
    const parent = path.dirname(dirA);
    for (let i = 0; i < 40; i += 1) {
      await fs.writeFile(path.join(parent, `.dir-claim-released-stale-${i}.json`), "{}\n");
    }
    await fs.writeFile(path.join(dirA, WORKSPACE_CLAIM_FILENAME), claimOf(RUN_B, OTHER_AGENT));

    const outcome = await acquireWorkspaceDirClaim({
      dirPath: dirA,
      self: identity(),
      readOwnerLiveness: terminal,
    });
    expect(outcome.acquired).toBe(true);

    const evidence = (await fs.readdir(parent)).filter((name) =>
      name.startsWith(".dir-claim-released-"),
    );
    expect(evidence.length).toBeLessThanOrEqual(20);
    // The newest is the one that was just written -- pruning keeps what a
    // reader would actually want.
    expect(evidence.some((name) => name.includes(RUN_B))).toBe(true);
  });
});

/**
 * Criterion from Ally's review: once this is wired in generally, the claim is
 * an untracked file in whatever repository the agent chose. `git add -A` would
 * commit the mutex into that repo's PR and `git clean -fd` would delete it --
 * after which a concurrent run reads `available`, which is PEN-5352 again with
 * the guard installed.
 */
describe("acquireWorkspaceDirClaim in a git checkout", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pen5352-git-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await run("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-qm", "init"], { cwd: repo });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("puts the claim in the git dir, where add -A and clean -fdx cannot reach it", async () => {
    const outcome = await acquireWorkspaceDirClaim({
      dirPath: repo,
      self: identity(),
      readOwnerLiveness: async () => "live",
    });
    expect(outcome.acquired).toBe(true);

    const claimPath = path.join(repo, ".git", WORKSPACE_CLAIM_GIT_FILENAME);
    expect(parseWorkspaceDirClaim(await fs.readFile(claimPath, "utf8"))?.runId).toBe(RUN_A);

    // Nothing untracked in the tree at all -- so there is no file for a
    // routine `git add -A` to sweep into somebody else's commit.
    const { stdout: dirty } = await run("git", ["status", "--porcelain"], { cwd: repo });
    expect(dirty.trim()).toBe("");

    // And the most destructive routine cleanup leaves the mutex standing.
    await run("git", ["clean", "-fdx"], { cwd: repo });
    expect(parseWorkspaceDirClaim(await fs.readFile(claimPath, "utf8"))?.runId).toBe(RUN_A);

    // Still mutually exclusive after all of that.
    const second = await acquireWorkspaceDirClaim({
      dirPath: repo,
      self: identity({ runId: RUN_B }),
      readOwnerLiveness: async () => "live",
    });
    expect(second.acquired).toBe(false);
    expect(second.verdict.kind).toBe("sibling_run");
  });

  it("gives a linked worktree its own claim rather than the main checkout's", async () => {
    const linked = path.join(root, "wt");
    await run("git", ["worktree", "add", "-q", "-b", "side", linked], { cwd: repo });

    const main = await resolveWorkspaceClaimLocation(repo);
    const side = await resolveWorkspaceClaimLocation(linked);
    expect(main.inGitDir).toBe(true);
    expect(side.inGitDir).toBe(true);
    // A `.git` FILE is followed to the per-worktree gitdir. Resolving both to
    // one claim would make two runs in two different worktrees exclude each
    // other for no reason.
    expect(side.claimPath).not.toBe(main.claimPath);

    expect((await acquireWorkspaceDirClaim({
      dirPath: repo, self: identity(), readOwnerLiveness: async () => "live",
    })).acquired).toBe(true);
    expect((await acquireWorkspaceDirClaim({
      dirPath: linked, self: identity({ runId: RUN_B }), readOwnerLiveness: async () => "live",
    })).acquired).toBe(true);
  });

  it("releases its own claim from the git dir", async () => {
    await acquireWorkspaceDirClaim({
      dirPath: repo,
      self: identity(),
      readOwnerLiveness: async () => "live",
    });
    expect(await releaseWorkspaceDirClaim({ dirPath: repo, runId: RUN_B })).toMatchObject({
      released: false,
    });
    expect(await releaseWorkspaceDirClaim({ dirPath: repo, runId: RUN_A })).toMatchObject({
      released: true,
    });
    expect(
      await fs.readFile(path.join(repo, ".git", WORKSPACE_CLAIM_GIT_FILENAME), "utf8").catch(() => null),
    ).toBeNull();
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
