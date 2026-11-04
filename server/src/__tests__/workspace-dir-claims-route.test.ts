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

  it("treats a missing issue as a determination, not as an unverifiable lookup", async () => {
    const dir = await makeDir("wt/no-such-issue");
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: dir, issueId: "PEN-404" });
    expect(res.status).toBe(409);
    expect(res.body.refusal).toContain("ISSUE LOCK NOT HELD");
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

  it("refuses a path that does not exist, and says to claim after materialising", async () => {
    const res = await request(await createApp())
      .post("/api/workspace-dir-claims")
      .send({ dirPath: path.join(root, "never-made") });
    expect(res.status).toBe(400);
    expect(res.body.refusal).toMatch(/does not exist/);
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
