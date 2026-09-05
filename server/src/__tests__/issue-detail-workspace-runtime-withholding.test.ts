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
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * PEN-2852 / PEN-2370 — the withholding boundary was wired into
 * `routes/execution-workspaces.ts` and `routes/projects.ts`. Its own guard says so, and names its
 * limit: *"A workspace response added in a THIRD module is not caught."*
 *
 * That third module already existed. `GET /api/issues/:id` answers with the same material under
 * FOUR different nouns, and it is the endpoint an agent reads most — every `paperclipGetIssue`
 * call lands here:
 *
 *   1. `project.workspaces[].runtimeConfig`
 *   2. `project.primaryWorkspace.runtimeConfig`
 *   3. `currentExecutionWorkspace.config.workspaceRuntime`
 *   4. `mentionedProjects[].workspaces[]` — the widest: `listByIds` runs `attachWorkspaces`, so
 *      these rows are UNCOMPACTED and carry `metadata` as well as the derived view.
 *
 * These tests drive the real route against a real database rather than asserting on source text,
 * because the failure this closes is a *response* that carries the material — not a call site that
 * looks wrong. Each case asserts absence of a sentinel AND presence of the surrounding row, so a
 * regression that blanked the whole projection could not pass as "withheld".
 *
 * ⛔ Every value below is invented. No real credential, command or path is quoted here, per the
 * parent ticket's standing prohibition.
 */

const PROJECT_WS_SENTINEL = "sentinel-project-workspace-runtime-must-not-egress";
const MENTIONED_WS_SENTINEL = "sentinel-mentioned-workspace-runtime-must-not-egress";
const EXECUTION_WS_SENTINEL = "sentinel-execution-workspace-runtime-must-not-egress";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-detail workspace-runtime withholding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /api/issues/:id — workspaceRuntime withholding (PEN-2852)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-detail-ws-runtime-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;

  /**
   * A standard same-company agent. This is the principal the boundary exists for: it is NOT in the
   * `workspace_runtime:read` allow-list, while an owner member and an instance admin both are. A
   * board actor here would be entitled and every assertion below would pass vacuously — which is
   * why the entitled case at the end uses a separate actor and asserts the opposite.
   */
  function agentActor(companyId: string, agentId: string) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      source: "agent_key" as const,
      runId: randomUUID(),
    };
  }

  function ownerActor(companyId: string) {
    return {
      type: "board" as const,
      userId: "cloud-user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant" as const,
      isInstanceAdmin: false,
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

  /** `runtimeConfig` / `config` are derived views over `metadata`, so the fixture seeds metadata. */
  function workspaceMetadata(sentinel: string) {
    return {
      runtimeConfig: {
        workspaceRuntime: {
          services: [{ name: "web", command: sentinel, env: { TOKEN_FIXTURE: sentinel } }],
        },
      },
    };
  }

  async function seedScenario() {
    prefixCounter += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `WR${prefixCounter}`;

    await db.insert(companies).values({
      id: companyId,
      name: `Withholding tenant ${prefixCounter}`,
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
      name: `Reader ${prefixCounter}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const projectId = randomUUID();
    const mentionedProjectId = randomUUID();
    await db.insert(projects).values([
      { id: projectId, companyId, name: `Attached ${prefixCounter}`, status: "active" },
      { id: mentionedProjectId, companyId, name: `Mentioned ${prefixCounter}`, status: "active" },
    ]);

    await db.insert(projectWorkspaces).values([
      {
        id: randomUUID(),
        companyId,
        projectId,
        name: "attached-primary",
        isPrimary: true,
        metadata: workspaceMetadata(PROJECT_WS_SENTINEL),
      },
      {
        id: randomUUID(),
        companyId,
        projectId: mentionedProjectId,
        name: "mentioned-primary",
        isPrimary: true,
        metadata: workspaceMetadata(MENTIONED_WS_SENTINEL),
      },
    ]);

    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      name: "issue-execution",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "active",
      metadata: {
        config: {
          workspaceRuntime: {
            services: [{ name: "api", command: EXECUTION_WS_SENTINEL }],
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
      title: `Withholding subject ${prefixCounter}`,
      // `findMentionedProjectIds` scans title + description for `[label](project://<id>)`.
      description: `See [Mentioned](project://${mentionedProjectId}) for context.`,
      status: "in_progress",
      priority: "medium",
      projectId,
      assigneeAgentId: agentId,
      executionWorkspaceId,
      createdByUserId: "cloud-user-1",
    });

    return { companyId, agentId, issueId, projectId, mentionedProjectId };
  }

  it("withholds project.workspaces[] and primaryWorkspace runtime config from an agent", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    const workspace = res.body.project.workspaces[0];
    // Withheld, not deleted: the row and its identifying fields still project, so a change that
    // dropped `workspaces` entirely would fail here rather than read as a successful withhold.
    expect(workspace.name).toBe("attached-primary");
    expect(workspace.runtimeConfig.workspaceRuntime).toBeNull();
    expect(res.body.project.primaryWorkspace.name).toBe("attached-primary");
    expect(res.body.project.primaryWorkspace.runtimeConfig.workspaceRuntime).toBeNull();
    // The sentinel is checked against the WHOLE serialized body, not the field it was seeded in:
    // a per-field assertion cannot catch the same bytes leaving one key over, which is the exact
    // failure mode `runtimeConfig`-vs-`metadata` creates.
    expect(JSON.stringify(res.body)).not.toContain(PROJECT_WS_SENTINEL);
  });

  it("withholds currentExecutionWorkspace.config.workspaceRuntime from an agent", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    expect(res.body.currentExecutionWorkspace.name).toBe("issue-execution");
    expect(res.body.currentExecutionWorkspace.config.workspaceRuntime).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(EXECUTION_WS_SENTINEL);
  });

  it("withholds mentionedProjects[].workspaces — the uncompacted exit that also carries metadata", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    expect(res.body.mentionedProjects).toHaveLength(1);
    const mentioned = res.body.mentionedProjects[0];
    expect(mentioned.name).toContain("Mentioned");
    expect(mentioned.workspaces[0].runtimeConfig.workspaceRuntime).toBeNull();
    // This exit is not compacted, so `metadata` is on the wire shape too and would carry the same
    // bytes even with the derived view masked. `publicProjectWorkspace` nulls both.
    expect(mentioned.workspaces[0].metadata).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(MENTIONED_WS_SENTINEL);
  });

  it("still discloses every exit to an entitled owner member — this is withholding, not removal", async () => {
    const { companyId, issueId } = await seedScenario();

    const res = await request(createApp(ownerActor(companyId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    // Without this case the three above would also pass on a boundary that masked unconditionally,
    // which would break the runtime editors the entitlement exists to keep working.
    const body = JSON.stringify(res.body);
    expect(body).toContain(PROJECT_WS_SENTINEL);
    expect(body).toContain(EXECUTION_WS_SENTINEL);
    expect(body).toContain(MENTIONED_WS_SENTINEL);
  });

  it("reports hasWorkspaceRuntimeConfig to the withheld agent, so existence never needs contents", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    // The reason withholding is viable at all: a caller that only needs to know a runtime config
    // EXISTS is served without it. Pinned here because it is the contract that makes the withheld
    // projection usable rather than merely safe.
    expect(res.body.mentionedProjects[0].workspaces[0].hasWorkspaceRuntimeConfig).toBe(true);
  });
});
