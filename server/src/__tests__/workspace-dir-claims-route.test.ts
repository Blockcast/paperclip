import express from "express";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-5352: the route is the CALL SITE, so these tests assert the wiring --
 * that a refusal actually reaches an agent over HTTP, that the issue-lock gate
 * runs BEFORE the claim is written, and that the path the caller supplies is
 * bounded. The verdict logic itself is covered exhaustively in
 * `workspace-dir-claim.test.ts` and is not re-tested here.
 *
 * The filesystem is real. The claim's whole contract is `link()` exclusivity,
 * and a mocked `fs` would assert the mock rather than the mutex.
 */

const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("../services/index.js", () => ({ issueService: () => mockIssueService }));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Minimal chainable stand-in for the one drizzle query the route runs. */
function dbReturning(rows: Array<{ status: string }> | Error) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (rows instanceof Error) throw rows;
            return rows;
          },
        }),
      }),
    }),
  };
}

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";
const RUN_SELF = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_SIBLING = "aaaaaaaa-0000-4000-8000-000000000002";

let root: string;

async function createApp(opts: {
  actor?: Record<string, unknown>;
  runRows?: Array<{ status: string }> | Error;
  roots?: string;
} = {}) {
  vi.resetModules();
  process.env.PAPERCLIP_WORKSPACE_CLAIM_ROOTS = opts.roots ?? root;
  const [{ errorHandler }, { workspaceDirClaimRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/workspace-dir-claims.js") as Promise<
      typeof import("../routes/workspace-dir-claims.js")
    >,
  ]);
  const actor = opts.actor ?? {
    type: "agent",
    agentId: AGENT,
    runId: RUN_SELF,
    companyId: "company-1",
    source: "agent_jwt",
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", workspaceDirClaimRoutes(dbReturning(opts.runRows ?? [{ status: "running" }]) as any));
  app.use(errorHandler);
  return app;
}

/** A directory under the allowed root, one segment deep at least. */
async function makeDir(name: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pen5352-route-")));
  mockIssueService.getById.mockReset();
});

afterEach(async () => {
  delete process.env.PAPERCLIP_WORKSPACE_CLAIM_ROOTS;
  await rm(root, { recursive: true, force: true });
});

describe("POST /workspace-dir-claims", () => {
  it("acquires an unclaimed directory and writes a claim naming this run", async () => {
    const dir = await makeDir("wt/alpha");
    const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });

    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
    expect(res.body.refusal).toBeNull();

    const claim = JSON.parse(await readFile(path.join(dir, ".paperclip-dir-claim.json"), "utf8"));
    expect(claim.runId).toBe(RUN_SELF);
    expect(claim.agentId).toBe(AGENT);
  });

  // CRITERION 1: a second run must be REFUSED, not merely warned.
  it("refuses a second run of the same seat in the same directory", async () => {
    const dir = await makeDir("wt/contended");
    const first = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(first.body.acquired).toBe(true);

    const sibling = await createApp({
      actor: { type: "agent", agentId: AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
      runRows: [{ status: "running" }],
    });
    const second = await request(sibling).post("/api/workspace-dir-claims").send({ dirPath: dir });

    expect(second.status).toBe(409);
    expect(second.body.acquired).toBe(false);
    expect(second.body.verdict.kind).toBe("sibling_run");
    expect(second.body.refusal).toContain(RUN_SELF);
  });

  // CRITERION 2: the refusal must deny the peer framing, not merely name a holder.
  it("names the ListAgents blind spot so an empty result stops reading as absence", async () => {
    const dir = await makeDir("wt/blindspot");
    await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });
    const sibling = await createApp({
      actor: { type: "agent", agentId: AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
    });
    const res = await request(sibling).post("/api/workspace-dir-claims").send({ dirPath: dir });

    expect(res.body.refusal).toMatch(/ListAgents/);
    // The expensive half of the incident was the INFERENCE, so assert the text
    // argues against it rather than merely mentioning the tool.
    expect(res.body.refusal).toMatch(/issue thread/i);
  });

  // CRITERION 3, the positive control: concurrency must not be serialized.
  it("positive control: two runs of one seat in different directories both acquire", async () => {
    const a = await makeDir("wt/issue-a");
    const b = await makeDir("wt/issue-b");

    const runA = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: a });
    const runB = await request(
      await createApp({
        actor: { type: "agent", agentId: AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
      }),
    )
      .post("/api/workspace-dir-claims")
      .send({ dirPath: b });

    expect(runA.body.acquired).toBe(true);
    expect(runB.body.acquired).toBe(true);
  });

  it("is re-entrant for the same run", async () => {
    const dir = await makeDir("wt/reentrant");
    const app = await createApp();
    expect((await request(app).post("/api/workspace-dir-claims").send({ dirPath: dir })).body.acquired).toBe(true);
    const again = await request(app).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(again.status).toBe(200);
    expect(again.body.verdict.kind).toBe("self");
  });

  it("admits exactly one winner when runs race for one directory", async () => {
    const dir = await makeDir("wt/race");
    const apps = await Promise.all(
      ["c1", "c2", "c3", "c4", "c5"].map((suffix, i) =>
        createApp({
          actor: {
            type: "agent",
            agentId: AGENT,
            runId: `aaaaaaaa-0000-4000-8000-00000000001${i}`,
            companyId: "company-1",
            source: "agent_jwt",
          },
        }).then((app) => ({ app, suffix })),
      ),
    );
    const results = await Promise.all(
      apps.map(({ app }) => request(app).post("/api/workspace-dir-claims").send({ dirPath: dir })),
    );
    expect(results.filter((r) => r.body.acquired === true)).toHaveLength(1);
    // The class invariant: a refusal always carries a reason.
    for (const r of results.filter((x) => x.body.acquired === false)) {
      expect(typeof r.body.refusal).toBe("string");
      expect(r.body.refusal.length).toBeGreaterThan(0);
    }
  });

  it("takes over from a positively-terminal owner", async () => {
    const dir = await makeDir("wt/terminal");
    await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });

    const successor = await createApp({
      actor: { type: "agent", agentId: OTHER_AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
      runRows: [{ status: "succeeded" }],
    });
    const res = await request(successor).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
  });

  it("refuses when the owning run cannot be found: absence is not a death certificate", async () => {
    const dir = await makeDir("wt/missing-owner");
    await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });

    const successor = await createApp({
      actor: { type: "agent", agentId: OTHER_AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
      runRows: [],
    });
    const res = await request(successor).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(res.status).toBe(409);
    expect(res.body.verdict.kind).toBe("indeterminate");
  });

  it("refuses when the liveness lookup throws", async () => {
    const dir = await makeDir("wt/throwing-owner");
    await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });

    const successor = await createApp({
      actor: { type: "agent", agentId: OTHER_AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
      runRows: new Error("db down"),
    });
    const res = await request(successor).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(res.status).toBe(409);
    expect(res.body.acquired).toBe(false);
  });
});

describe("the issue-lock gate runs before anything is written", () => {
  it("refuses a run that does not hold the issue's checkout lock, and writes no claim", async () => {
    const dir = await makeDir("wt/pen-4522");
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      checkoutRunId: RUN_SIBLING,
      executionRunId: RUN_SIBLING,
    });

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: dir, issueId: "PEN-4522" });

    expect(res.status).toBe(409);
    expect(res.body.refusal).toContain("ISSUE LOCK NOT HELD");
    expect(res.body.refusal).toContain(RUN_SIBLING);
    // The incident's shape exactly: no claim existed, `available` was honest,
    // and it was still the wrong run. Nothing may be written on this path.
    await expect(readFile(path.join(dir, ".paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
  });

  it("proceeds when this run does hold the lock", async () => {
    const dir = await makeDir("wt/pen-5352");
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      checkoutRunId: RUN_SELF,
      executionRunId: RUN_SELF,
    });
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: dir, issueId: "PEN-5352" });
    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
  });

  it("refuses as UNVERIFIED when the issue lookup throws, not as not-held", async () => {
    const dir = await makeDir("wt/lookup-throws");
    mockIssueService.getById.mockRejectedValue(new Error("db down"));
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: dir, issueId: "PEN-1" });
    expect(res.status).toBe(409);
    expect(res.body.refusal).toContain("ISSUE LOCK UNVERIFIED");
  });

  it("reports an unresolvable issue reference as such, not as a lock verdict", async () => {
    // Reporting a typo as NOT HELD sent an agent to paperclipCheckoutIssue for
    // a row that does not exist (Ally, #3370).
    const dir = await makeDir("wt/no-such-issue");
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: dir, issueId: "PEN-404" });
    expect(res.status).toBe(400);
    expect(res.body.refusal).toContain("ISSUE REFUSED");
    expect(res.body.refusal).not.toContain("ISSUE LOCK NOT HELD");
  });

  it("refuses another company's issue without echoing its lock holder", async () => {
    const dir = await makeDir("wt/cross-tenant");
    mockIssueService.getById.mockResolvedValue({
      id: "issue-9",
      companyId: "company-2",
      checkoutRunId: RUN_SIBLING,
      executionRunId: RUN_SIBLING,
    });
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: dir, issueId: "OTHER-1" });
    expect(res.status).toBe(403);
    // The holder is the leak: a cross-tenant id must not be distinguishable
    // from a missing one by what comes back.
    expect(JSON.stringify(res.body)).not.toContain(RUN_SIBLING);
  });
});

describe("path bounding", () => {
  it("refuses a path outside every allowed root", async () => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "pen5352-outside-")));
    try {
      const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: outside });
      expect(res.status).toBe(400);
      expect(res.body.refusal).toContain("PATH REFUSED");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses the root itself, so scratch files can never land in the root's parent", async () => {
    const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: root });
    expect(res.status).toBe(400);
    expect(res.body.refusal).toContain("PATH REFUSED");
  });

  it("refuses a symlink inside the root that points outside it", async () => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "pen5352-escape-")));
    try {
      const link = path.join(root, "escape");
      await symlink(outside, link);
      const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: link });
      expect(res.status).toBe(400);
      expect(res.body.refusal).toContain("PATH REFUSED");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a path that does not exist, naming the roots and the server-side check", async () => {
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "work", "never-made") });
    expect(res.status).toBe(400);
    // PEN-5865 defect 2: this branch used to carry only "claim after the clone
    // is materialised" -- advice about a mistake the caller may not have made,
    // and the one message that could not name the real cause. It now carries
    // the two facts the root-membership branch carries.
    expect(res.body.refusal).toMatch(/does not exist ON THE SERVER/);
    expect(res.body.refusal).toContain(`Allowed roots: ${root}`);
    expect(res.body.refusal).toMatch(/SERVER's filesystem/);
    expect(res.body.refusal).toMatch(/both the server and the agent pods can see/);
    // ...and it still says the thing it used to say.
    expect(res.body.refusal).toMatch(/final shape exists/);
  });

  it("names the roots and the shared-filesystem rule even when the path is outside them", async () => {
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "..", "pen5865-nowhere", "x") });
    expect(res.status).toBe(400);
    expect(res.body.refusal).toContain(`Allowed roots: ${root}`);
    expect(res.body.refusal).toMatch(/both the server and the agent pods can see/);
  });

  it("refuses a file", async () => {
    const file = path.join(root, "a-file");
    await writeFile(file, "x");
    const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: file });
    expect(res.status).toBe(400);
    expect(res.body.refusal).toContain("not a directory");
  });

  it("refuses a relative path", async () => {
    const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: "./relative" });
    expect(res.status).toBe(400);
    expect(res.body.refusal).toContain("not absolute");
  });
});

describe("PEN-5865: the agent pod's spelling of a shared path is not the server's", () => {
  /**
   * Measured cause: the API server mounts the shared CephFS subvolume at
   * `/paperclip` with no subPath, while agent pods mount `work/<companyId>`
   * OF THAT SAME SUBVOLUME at `/paperclip/work`. So the agent's
   * `/paperclip/work/cto-5865` is the server's
   * `/paperclip/work/<companyId>/cto-5865`, `realpath` threw on the former,
   * and EVERY claim from an agent pod refused. The roots were never wrong and
   * the volume was always shared -- neither cause filed on the row was live.
   */
  /** The mapping lives beside the claim layout it feeds, not at the route. */
  async function loadModule() {
    vi.resetModules();
    return import("../services/workspace-dir-claim.js") as Promise<
      typeof import("../services/workspace-dir-claim.js")
    >;
  }

  it("claims the directory when only the company-scoped spelling resolves", async () => {
    const dir = await makeDir(path.join("work", "company-1", "cto-5865"));
    const asTheAgentPodNamesIt = path.join(root, "work", "cto-5865");

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: asTheAgentPodNamesIt });

    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
    expect(res.body.dirPath).toBe(dir);
    expect(res.body.note).toMatch(/company-scoped subPaths/);
    const claim = JSON.parse(await readFile(path.join(dir, ".paperclip-dir-claim.json"), "utf8"));
    expect(claim.runId).toBe(RUN_SELF);
  });

  it("releases through the same re-spelling, so a claim is not strandable by its own spelling", async () => {
    const dir = await makeDir(path.join("work", "company-1", "cto-5865"));
    const asTheAgentPodNamesIt = path.join(root, "work", "cto-5865");
    const app = await createApp();
    await request(app).post("/api/workspace-dir-claims").send({ dirPath: asTheAgentPodNamesIt });

    const res = await request(app)
      .post("/api/workspace-dir-claims/release")
      .send({ dirPath: asTheAgentPodNamesIt });

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    expect(res.body.dirPath).toBe(dir);
  });

  it("prefers the literal path, so re-spelling never redirects a claim that already resolves", async () => {
    const literal = await makeDir(path.join("work", "cto-5865"));
    await makeDir(path.join("work", "company-1", "cto-5865"));

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: literal });

    expect(res.status).toBe(200);
    expect(res.body.dirPath).toBe(literal);
    expect(res.body.note).toBeUndefined();
    // ...but the ambiguity is reported rather than passed over in silence:
    // under the measured layout the literal is usually an unscoped tree, and
    // two companies naming it would collide there (Ally, #3498).
    const { logger } = await import("../middleware/logger.js");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ shadowed: [path.join(root, "work", "company-1", "cto-5865")] }),
      expect.stringContaining("company-scoped directory of the same name also exists"),
    );
  });

  it("cannot reach another company's tree: the segment inserted is the CALLER's company", async () => {
    // The victim's directory exists and is spelled exactly as a re-spelling
    // would be -- for a DIFFERENT company. Re-spelling inserts `company-1`,
    // so this is unreachable rather than merely unclaimed.
    await makeDir(path.join("work", "company-2", "victim"));

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "work", "victim") });

    expect(res.status).toBe(400);
    expect(res.body.acquired).toBe(false);
    expect(res.body.refusal).toContain("PATH REFUSED");
  });

  /**
   * Ally, #3498. A linked worktree's `.git` is a FILE whose `gitdir:` pointer
   * git wrote ON THE AGENT POD, so it carries the agent's spelling too — and
   * the claim LOCATION is derived from it. Re-spelling `dirPath` alone would
   * leave the pointer unresolvable server-side, and the resolver used to
   * degrade silently to the plain-directory branch: claim in the WORKING TREE,
   * where `git add -A` commits it and `git clean -fd` deletes it. That branch
   * was unreachable from an agent pod before this change, because `realpath`
   * threw on the agent's spelling first.
   */
  async function makeLinkedWorktree(opts: { pointsAt: string }): Promise<string> {
    const tree = await makeDir(path.join("work", "company-1", "cto-wt"));
    await writeFile(path.join(tree, ".git"), `gitdir: ${opts.pointsAt}\n`);
    return tree;
  }

  it("re-spells the worktree's .git pointer too, so the claim lands in the gitdir", async () => {
    const gitDir = await makeDir(path.join("work", "company-1", "repo", ".git", "worktrees", "wt1"));
    // As git wrote it on the agent pod: no company segment.
    const tree = await makeLinkedWorktree({
      pointsAt: path.join(root, "work", "repo", ".git", "worktrees", "wt1"),
    });

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "work", "cto-wt") });

    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
    const claim = JSON.parse(await readFile(path.join(gitDir, "paperclip-dir-claim.json"), "utf8"));
    expect(claim.runId).toBe(RUN_SELF);
    // The hazard: NOT in the working tree, where `git clean -fd` would take it.
    await expect(readFile(path.join(tree, ".paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
  });

  it("releases a worktree claim through the same pointer re-spelling", async () => {
    const gitDir = await makeDir(path.join("work", "company-1", "repo", ".git", "worktrees", "wt1"));
    await makeLinkedWorktree({ pointsAt: path.join(root, "work", "repo", ".git", "worktrees", "wt1") });
    const app = await createApp();
    const asTheAgentPodNamesIt = path.join(root, "work", "cto-wt");
    await request(app).post("/api/workspace-dir-claims").send({ dirPath: asTheAgentPodNamesIt });

    const res = await request(app)
      .post("/api/workspace-dir-claims/release")
      .send({ dirPath: asTheAgentPodNamesIt });

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    await expect(readFile(path.join(gitDir, "paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
  });

  it("REFUSES a .git pointer that resolves in neither spelling, rather than claiming in-tree", async () => {
    const tree = await makeLinkedWorktree({
      pointsAt: path.join(root, "work", "gone", ".git", "worktrees", "wt1"),
    });

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "work", "cto-wt") });

    expect(res.status).toBe(400);
    expect(res.body.acquired).toBe(false);
    expect(res.body.refusal).toMatch(/carries a \.git pointer/);
    expect(res.body.refusal).toMatch(/git clean -fd/);
    // Nothing was written into the tree on the way to refusing.
    await expect(readFile(path.join(tree, ".paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
  });

  it("leaves a plain directory alone: no pointer, no refusal", async () => {
    // A `.git` FILE with no `gitdir:` line is not a pointer, so the
    // plain-directory branch is still correct for it.
    const dir = await makeDir(path.join("work", "company-1", "odd"));
    await writeFile(path.join(dir, ".git"), "not a pointer\n");

    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "work", "odd") });

    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
  });

  it("re-spells only below the mount segment, and not for a run with no company", async () => {
    const { companyScopedRespellings } = await loadModule();
    const roots = ["/paperclip"];

    expect(companyScopedRespellings(roots, "/paperclip/work/cto-5865", "c1")).toEqual([
      "/paperclip/work/c1/cto-5865",
    ]);
    expect(companyScopedRespellings(roots, "/paperclip/wt/pen-4522/repo", "c1")).toEqual([
      "/paperclip/wt/c1/pen-4522/repo",
    ]);
    // The mount point itself is never claimable, so there is nothing to re-spell.
    expect(companyScopedRespellings(roots, "/paperclip/work", "c1")).toEqual([]);
    // Already company-scoped; re-spelling would produce work/c1/c1/...
    expect(companyScopedRespellings(roots, "/paperclip/work/c1/cto-5865", "c1")).toEqual([]);
    // Outside every root.
    expect(companyScopedRespellings(roots, "/tmp/elsewhere/x", "c1")).toEqual([]);
    // No company: fails closed rather than guessing a segment.
    expect(companyScopedRespellings(roots, "/paperclip/work/cto-5865", null)).toEqual([]);
  });
});

describe("the WRITE LOCATION is confined, not just the directory named", () => {
  /**
   * Ally, #3370. `resolveWorkspaceClaimLocation` decides where the claim,
   * staging, successor-token and evidence files actually go by reading
   * `<dirPath>/.git` -- content the AGENT controls. Confining `dirPath` alone
   * left that location free to point anywhere the SERVER's uid can write,
   * which is a wider view of the volume than any agent pod has.
   */
  it("refuses a `.git` pointer file aiming the claim outside every root", async () => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "pen5352-gitdir-")));
    try {
      const dir = await makeDir("wt/pointer");
      await writeFile(path.join(dir, ".git"), `gitdir: ${outside}\n`);
      const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });
      expect(res.status).toBe(400);
      expect(res.body.refusal).toContain("PATH REFUSED");
      expect(res.body.refusal).toContain("claim location");
      // Nothing may have been written through the pointer.
      await expect(readFile(path.join(outside, "paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a `.git` SYMLINK to a directory outside every root", async () => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "pen5352-gitlink-")));
    try {
      const dir = await makeDir("wt/gitlink");
      await symlink(outside, path.join(dir, ".git"));
      const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });
      expect(res.status).toBe(400);
      expect(res.body.refusal).toContain("PATH REFUSED");
      await expect(readFile(path.join(outside, "paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("release is confined the same way, so it cannot become an unbounded rm", async () => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "pen5352-relgit-")));
    try {
      const dir = await makeDir("wt/release-pointer");
      await writeFile(path.join(dir, ".git"), `gitdir: ${outside}\n`);
      const res = await request(await createApp())
        .post("/api/workspace-dir-claims/release")
        .send({ dirPath: dir });
      expect(res.status).toBe(400);
      expect(res.body.released).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // Positive control for the new check: the ordinary checkout must still work,
  // and its claim must land in the git dir rather than the working tree.
  it("positive control: a real git checkout inside a root still acquires, into its git dir", async () => {
    const dir = await makeDir("wt/real-checkout");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
    const claim = JSON.parse(await readFile(path.join(dir, ".git", "paperclip-dir-claim.json"), "utf8"));
    expect(claim.runId).toBe(RUN_SELF);
  });

  // The asymmetry that makes the check usable: dirPath strict, write location
  // inclusive. A directory exactly one segment below a root stages into the
  // root itself, which must be allowed.
  it("allows a directory one segment below the root, whose scratch dir IS the root", async () => {
    const dir = await makeDir("one-deep");
    const res = await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });
    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
  });
});

describe("actor requirements", () => {
  it("refuses a board user: a claim with no run behind it could never be shown finished", async () => {
    const app = await createApp({ actor: { type: "board", userId: "u1", source: "session" } });
    const res = await request(app).post("/api/workspace-dir-claims").send({ dirPath: await makeDir("wt/board") });
    expect(res.status).toBe(403);
  });

  it("refuses an agent actor with no run id", async () => {
    const app = await createApp({ actor: { type: "agent", agentId: AGENT, source: "agent_key" } });
    const res = await request(app).post("/api/workspace-dir-claims").send({ dirPath: await makeDir("wt/norun") });
    expect(res.status).toBe(403);
  });
});

describe("resolveWorkspaceClaimRoots", () => {
  /**
   * The HTTP tests above pin the roots to a temp dir, so the DEFAULT -- which is
   * what actually runs in production -- would otherwise be the one path with no
   * coverage. It is the whole bound on where this route may write.
   */
  async function load() {
    vi.resetModules();
    return import("../routes/workspace-dir-claims.js") as Promise<
      typeof import("../routes/workspace-dir-claims.js")
    >;
  }

  it("defaults to the shared volume, and adds PAPERCLIP_HOME when set", async () => {
    const { resolveWorkspaceClaimRoots } = await load();
    expect(resolveWorkspaceClaimRoots({} as NodeJS.ProcessEnv)).toEqual(["/paperclip"]);
    expect(resolveWorkspaceClaimRoots({ PAPERCLIP_HOME: "/home/agent" } as NodeJS.ProcessEnv)).toEqual([
      "/paperclip",
      "/home/agent",
    ]);
  });

  it("an explicit setting REPLACES the defaults rather than extending them", async () => {
    const { resolveWorkspaceClaimRoots } = await load();
    expect(
      resolveWorkspaceClaimRoots({
        PAPERCLIP_WORKSPACE_CLAIM_ROOTS: "/mnt/a:/mnt/b",
        PAPERCLIP_HOME: "/home/agent",
      } as NodeJS.ProcessEnv),
    ).toEqual(["/mnt/a", "/mnt/b"]);
  });

  it("de-duplicates so a refusal lists each root once", async () => {
    const { resolveWorkspaceClaimRoots } = await load();
    expect(
      resolveWorkspaceClaimRoots({
        PAPERCLIP_WORKSPACE_CLAIM_ROOTS: "/mnt/a:/mnt/a/:/mnt/a",
      } as NodeJS.ProcessEnv),
    ).toEqual(["/mnt/a"]);
  });

  it("expands {companyId}, and drops such a root entirely for a run with no company", async () => {
    const { resolveWorkspaceClaimRoots } = await load();
    expect(
      resolveWorkspaceClaimRoots(
        { PAPERCLIP_WORKSPACE_CLAIM_ROOTS: "/paperclip/companies/{companyId}" } as NodeJS.ProcessEnv,
        "company-1",
      ),
    ).toEqual(["/paperclip/companies/company-1"]);
    // Fails closed: no company means no root, rather than a literal path.
    expect(
      resolveWorkspaceClaimRoots(
        { PAPERCLIP_WORKSPACE_CLAIM_ROOTS: "/paperclip/companies/{companyId}" } as NodeJS.ProcessEnv,
        null,
      ),
    ).toEqual([]);
  });

  it("inclusive containment permits the root itself; strict does not", async () => {
    const { isInsideRootInclusive, isStrictlyInsideRoot } = await load();
    expect(isInsideRootInclusive("/paperclip", "/paperclip")).toBe(true);
    expect(isStrictlyInsideRoot("/paperclip", "/paperclip")).toBe(false);
    expect(isInsideRootInclusive("/paperclip", "/paperclip-other")).toBe(false);
    expect(isInsideRootInclusive("/paperclip", "/")).toBe(false);
  });

  it("is a path test, not a prefix test: a sibling name is not inside", async () => {
    const { isStrictlyInsideRoot } = await load();
    expect(isStrictlyInsideRoot("/paperclip", "/paperclip-other/wt")).toBe(false);
    expect(isStrictlyInsideRoot("/paperclip", "/paperclip/wt")).toBe(true);
    // Strict: the root itself is refused, which is what keeps scratch files
    // (written to `dirname(dirPath)`) from landing in the root's parent.
    expect(isStrictlyInsideRoot("/paperclip", "/paperclip")).toBe(false);
    expect(isStrictlyInsideRoot("/paperclip", "/")).toBe(false);
  });
});

describe("POST /workspace-dir-claims/release", () => {
  it("releases this run's own claim", async () => {
    const dir = await makeDir("wt/release-mine");
    const app = await createApp();
    await request(app).post("/api/workspace-dir-claims").send({ dirPath: dir });
    const res = await request(app).post("/api/workspace-dir-claims/release").send({ dirPath: dir });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    await expect(readFile(path.join(dir, ".paperclip-dir-claim.json"), "utf8")).rejects.toThrow();
  });

  it("leaves a foreign claim in place and says whose it is", async () => {
    const dir = await makeDir("wt/release-foreign");
    await request(await createApp()).post("/api/workspace-dir-claims").send({ dirPath: dir });

    const other = await createApp({
      actor: { type: "agent", agentId: OTHER_AGENT, runId: RUN_SIBLING, companyId: "company-1", source: "agent_jwt" },
    });
    const res = await request(other).post("/api/workspace-dir-claims/release").send({ dirPath: dir });
    expect(res.body.released).toBe(false);
    expect(res.body.reason).toContain(RUN_SELF);
    // Still there: a release must never be a way to break another run's claim.
    expect(JSON.parse(await readFile(path.join(dir, ".paperclip-dir-claim.json"), "utf8")).runId).toBe(RUN_SELF);
  });
});
