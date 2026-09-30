import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * PEN-2370 ask 3 (b2) — door #19, found BY the class guard rather than by an observer.
 *
 * `respondClosedIssueExecutionWorkspace` declares its parameter as
 * `Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">` — five fields, none
 * of them secret-bearing. Every caller passes the full row from `executionWorkspacesSvc.getById`,
 * which is a bare `db.select()` fed through `toExecutionWorkspace` (it sets `workspaceRuntime`).
 * TypeScript does not strip excess properties at runtime, so the 409 body served the whole row.
 *
 * This is the SAME shape as door #17 (`routes/routines.ts`, `RoutineProjectSummary`): a narrow
 * declared type over a full-row value. The narrow type is what makes it read as safe.
 *
 * It reaches the three endpoints an agent calls most — `PATCH /api/issues/:id`,
 * `POST /api/issues/:id/checkout`, `POST /api/issues/:id/comments` — and door #18's fix did not
 * touch it, because that fix covered the issue-DETAIL exits and this is an error path.
 *
 * The assertions check the sentinel against the WHOLE serialized body rather than one field: the
 * failure mode here is material leaving under a key nobody enumerated, so a per-field assertion
 * would reproduce the very blind spot this ticket exists to close. Each case also asserts the
 * surrounding row still projects, so a regression that blanked the response could not pass as a
 * successful withhold.
 *
 * ⛔ Every value below is invented. No real credential, command or path is quoted, per the parent
 * ticket's standing prohibition.
 */

const CLOSED_WS_SENTINEL = "sentinel-closed-execution-workspace-runtime-must-not-egress";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres closed-workspace 409 withholding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("closed isolated execution workspace 409 — workspaceRuntime withholding (PEN-2370 door #19)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-closed-ws-409-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;

  /** An ordinary same-company agent — deliberately NOT entitled to `workspace_runtime:read`. */
  function agentActor(companyId: string, agentId: string) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      source: "agent_key" as const,
      runId: randomUUID(),
    };
  }

  function createApp(actor: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedClosedWorkspaceIssue() {
    prefixCounter += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `CW${prefixCounter}`;

    await db.insert(companies).values({
      id: companyId,
      name: `Closed-workspace tenant ${prefixCounter}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Actor ${prefixCounter}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Closed ${prefixCounter}`,
      status: "active",
    });

    // `isClosedIsolatedExecutionWorkspace` needs mode `isolated_workspace` AND a non-null
    // `closedAt` (or an archived/cleanup_failed status) — otherwise the 409 branch is never
    // reached and every assertion below would pass vacuously against a 200.
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      name: "closed-isolated-workspace",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "archived",
      closedAt: new Date(),
      metadata: {
        config: {
          workspaceRuntime: {
            services: [{ name: "api", command: CLOSED_WS_SENTINEL }],
          },
        },
      },
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      title: `Closed workspace subject ${prefixCounter}`,
      // `todo`, not `in_progress`: an in-progress row trips the run-ownership 409 BEFORE the
      // closed-workspace branch, so the suite would assert against a different 409 entirely.
      status: "todo",
      priority: "medium",
      projectId,
      assigneeAgentId: agentId,
      executionWorkspaceId,
      createdByUserId: "cloud-user-1",
    });

    return { companyId, agentId, issueId };
  }

  /** Shared assertion: the 409 fired, it still identifies the workspace, and it carries no runtime. */
  function expectWithheldClosedWorkspace409(res: { status: number; body: any }) {
    expect(res.status).toBe(409);
    // Withheld, not deleted — the caller still learns which workspace blocked them.
    expect(res.body.executionWorkspace?.name).toBe("closed-isolated-workspace");
    expect(res.body.executionWorkspace?.status).toBe("archived");
    // Sentinel FIRST: this is the assertion about secret material, and it must be the one that
    // decides the verdict. Checking the key-set first would let a shape regression mask (or
    // manufacture) a leak result.
    expect(JSON.stringify(res.body)).not.toContain(CLOSED_WS_SENTINEL);
    // The five declared fields are the WHOLE contract; anything else is excess the type denied.
    expect(Object.keys(res.body.executionWorkspace).sort()).toEqual([
      "closedAt",
      "id",
      "mode",
      "name",
      "status",
    ]);
    expect(res.body.executionWorkspace.workspaceRuntime).toBeUndefined();
    expect(res.body.executionWorkspace.metadata).toBeUndefined();
    expect(res.body.executionWorkspace.config).toBeUndefined();
  }

  it("PATCH /api/issues/:id does not serve workspaceRuntime on the closed-workspace 409", async () => {
    const { companyId, agentId, issueId } = await seedClosedWorkspaceIssue();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Renamed by an agent" });

    expectWithheldClosedWorkspace409(res);
  });

  it("POST /api/issues/:id/checkout does not serve workspaceRuntime on the closed-workspace 409", async () => {
    const { companyId, agentId, issueId } = await seedClosedWorkspaceIssue();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });

    expectWithheldClosedWorkspace409(res);
  });

  it("POST /api/issues/:id/comments does not serve workspaceRuntime on the closed-workspace 409", async () => {
    const { companyId, agentId, issueId } = await seedClosedWorkspaceIssue();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "A comment from an agent" });

    expectWithheldClosedWorkspace409(res);
  });
});
