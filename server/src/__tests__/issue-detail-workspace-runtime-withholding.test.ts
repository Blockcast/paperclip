import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * PEN-2852 / PEN-2370 — the withholding boundary was wired into
 * `routes/execution-workspaces.ts` and `routes/projects.ts`. Its own guard named that limit at the
 * time: *"A workspace response added in a THIRD module is not caught."* (The guard now enforces its
 * own module list, so that sentence no longer appears there — the limit was closed, not restated.)
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
/**
 * PEN-3252 — the issue row's OWN copy of the same material, on a raw JSONB column that never passed
 * the boundary at all because the issue routes answer with spreads. Distinct sentinels from the
 * three above, so a failure names which carrier regressed.
 */
const ISSUE_SETTINGS_RUNTIME_SENTINEL = "sentinel-issue-settings-runtime-must-not-egress";
const ISSUE_SETTINGS_COMMAND_SENTINEL = "sentinel-issue-settings-command-must-not-egress";
const ISSUE_SETTINGS_UNKNOWN_SENTINEL = "sentinel-issue-settings-unknown-key-must-not-egress";
const ISSUE_SETTINGS_ENVIRONMENT_ID = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

/**
 * BLO-33568. The command SCALARS beside `workspaceRuntime`, which this file's fixture did not
 * populate. `compactIssueExecutionWorkspace` / `compactIssueProjectWorkspace` mask them
 * (`routes/issues.ts`), but an absent fixture field cannot show that a present one crosses — the
 * same blind spot PEN-3073 recorded for the empty `plannedActions` array, one field over. Measured
 * 2026-09-18: reverting the `config.cleanupCommand` mask left all 74 tests across all four
 * withholding suites green.
 *
 * Each is the `cleanupCommand` value verbatim and the STEM of its siblings (`-provision`,
 * `-teardown`, `-setup`). So a bare `toContain(SENTINEL)` is satisfied by any one of the three —
 * assert the siblings per-field, never by substring. See the entitled case below.
 */
const CONFIG_COMMAND_SENTINEL = "TOKEN_FIXTURE=sentinel-issue-config-command-not-a-real-credential ./run.sh";
const PROJECT_WS_COMMAND_SENTINEL = "TOKEN_FIXTURE=sentinel-issue-project-ws-command-not-a-real-credential ./drop.sh";

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
  function agentActor(companyId: string, agentId: string, runId: string = randomUUID()) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      source: "agent_key" as const,
      runId,
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
        setupCommand: `${PROJECT_WS_COMMAND_SENTINEL}-setup`,
        cleanupCommand: PROJECT_WS_COMMAND_SENTINEL,
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
          provisionCommand: `${CONFIG_COMMAND_SENTINEL}-provision`,
          teardownCommand: `${CONFIG_COMMAND_SENTINEL}-teardown`,
          cleanupCommand: CONFIG_COMMAND_SENTINEL,
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
      // PEN-3252. The raw JSONB settings column, non-null on every carrier the projection
      // classifies, plus one key nobody has. A `null` or `{}` fixture would pass with or without
      // the mask.
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: ISSUE_SETTINGS_ENVIRONMENT_ID,
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "main",
          provisionCommand: ISSUE_SETTINGS_COMMAND_SENTINEL,
          teardownCommand: `${ISSUE_SETTINGS_COMMAND_SENTINEL}-teardown`,
          worktreeParentDir: `${ISSUE_SETTINGS_COMMAND_SENTINEL}-parent`,
        },
        workspaceRuntime: {
          services: [
            {
              name: "settings-web",
              command: ISSUE_SETTINGS_RUNTIME_SENTINEL,
              env: { TOKEN_FIXTURE: ISSUE_SETTINGS_RUNTIME_SENTINEL },
            },
          ],
        },
        // The unvalidated CREATE path (portability import / plugin host) can plant a key the parser
        // does not know. Seeded directly because no HTTP body could carry it past the strict
        // schema — which is exactly why the walk must default to mask.
        legacyOperatorNotes: ISSUE_SETTINGS_UNKNOWN_SENTINEL,
      },
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

  /**
   * BLO-33568. The command SCALARS beside `workspaceRuntime`, on both compacted exits. Distinct
   * from the assertions above in contract as well as in field: `workspaceRuntime` goes to `null`,
   * these are MASKED — so this asserts sentinel-absence AND an explicit `REDACTED_EVENT_VALUE`
   * equality. `toBeNull()` would encode the wrong contract and would pass on a field that had
   * simply been dropped, which is the opposite of withheld-is-not-absent.
   *
   * ⚠ On the mask alone these equality assertions would NOT be self-sufficient:
   * `maskWorkspaceRuntimeTextForRead` tests `=== null` (`redaction.ts`), so an `undefined` field
   * would map to `REDACTED_EVENT_VALUE` and pass here even if the fixture stopped seeding it —
   * the very blind spot this case exists to close. What rules that out is upstream, not the mask:
   * `readNullableString` (`services/execution-workspaces.ts`) normalises `undefined` to `null`
   * when the config view is derived, so the mask never receives `undefined` on this route and an
   * unseeded scalar arrives as `null`. Measured 2026-09-18 by deleting `provisionCommand` from the
   * fixture: this case fails `expected null to be '***REDACTED***'` and the entitled case below
   * fails alongside it. Both halves guard the seeding; neither depends on the other.
   */
  it("withholds the command scalars beside workspaceRuntime on both compacted exits", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(CONFIG_COMMAND_SENTINEL);
    expect(body).not.toContain(PROJECT_WS_COMMAND_SENTINEL);

    const config = res.body.currentExecutionWorkspace.config;
    expect(config.provisionCommand).toBe(REDACTED_EVENT_VALUE);
    expect(config.teardownCommand).toBe(REDACTED_EVENT_VALUE);
    expect(config.cleanupCommand).toBe(REDACTED_EVENT_VALUE);
    expect(res.body.project.workspaces[0].setupCommand).toBe(REDACTED_EVENT_VALUE);
    expect(res.body.project.workspaces[0].cleanupCommand).toBe(REDACTED_EVENT_VALUE);
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
    // BLO-33568 AC 4. The command scalars are an entitled reader's working data — the workspace
    // editors round-trip them — so masking them unconditionally would be a regression, not a fix.
    // Per-field, because each sentinel is the STEM of its siblings: `toContain(SENTINEL)` alone is
    // satisfied by `cleanupCommand` on its own, so a regression masking `provisionCommand`
    // unconditionally for an entitled reader would still pass. Mirrors the withheld case above and
    // `workspace-runtime-response-withholding.test.ts`'s entitled case.
    //
    // These also pin the FIXTURE: an unseeded scalar fails here as `expected null to be '…'`
    // (measured), so the withheld case above cannot quietly go vacuous. It does not depend on this
    // — see its own note — but the two failing together names the cause immediately.
    const config = res.body.currentExecutionWorkspace.config;
    expect(config.provisionCommand).toBe(`${CONFIG_COMMAND_SENTINEL}-provision`);
    expect(config.teardownCommand).toBe(`${CONFIG_COMMAND_SENTINEL}-teardown`);
    expect(config.cleanupCommand).toBe(CONFIG_COMMAND_SENTINEL);
    expect(res.body.project.workspaces[0].setupCommand).toBe(`${PROJECT_WS_COMMAND_SENTINEL}-setup`);
    expect(res.body.project.workspaces[0].cleanupCommand).toBe(PROJECT_WS_COMMAND_SENTINEL);
  });

  it("reports hasWorkspaceRuntimeConfig to the withheld agent, so existence never needs contents", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    // The reason withholding is viable at all: a caller that only needs to know a runtime config
    // EXISTS is served without it. Pinned here because it is the contract that makes the withheld
    // projection usable rather than merely safe.
    expect(res.body.mentionedProjects[0].workspaces[0].hasWorkspaceRuntimeConfig).toBe(true);
    // …and on the COMPACTED path, which is the one that can lose it: that projection selects fields
    // by name, so the flag survives only if it is named. Without it a withheld caller cannot tell
    // "no runtime config" from "withheld" — a distinction it had before withholding, when the
    // config was disclosed outright.
    expect(res.body.project.workspaces[0].hasWorkspaceRuntimeConfig).toBe(true);
    expect(res.body.project.primaryWorkspace.hasWorkspaceRuntimeConfig).toBe(true);
    // The execution-workspace projection is a *separate* field list and loses the flag
    // independently of the three above — which is how it shipped without one. Asserted on both
    // exits that serialize it, because `/issues/:id` passing says nothing about heartbeat-context.
    expect(res.body.currentExecutionWorkspace.hasWorkspaceRuntimeConfig).toBe(true);
  });

  it("reports hasWorkspaceRuntimeConfig on heartbeat-context currentExecutionWorkspace", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(
      `/api/issues/${issueId}/heartbeat-context`,
    );

    expect(res.status).toBe(200);
    expect(res.body.currentExecutionWorkspace.config.workspaceRuntime).toBeNull();
    expect(res.body.currentExecutionWorkspace.hasWorkspaceRuntimeConfig).toBe(true);
  });

  it("withholds currentExecutionWorkspace on heartbeat-context — the read an agent makes on wake", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(
      `/api/issues/${issueId}/heartbeat-context`,
    );

    // `GET /issues/:id` is not the only exit this boundary has to cover. Heartbeat-context is the
    // other call site that projects an execution workspace, and it is read by the exact principal
    // the entitlement exists for, on every wake — the highest-frequency read of this material.
    expect(res.status).toBe(200);
    expect(res.body.currentExecutionWorkspace.name).toBe("issue-execution");
    expect(res.body.currentExecutionWorkspace.config.workspaceRuntime).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(EXECUTION_WS_SENTINEL);
    // BLO-33568. `compactIssueExecutionWorkspace` is shared with `/issues/:id`, so this is low
    // production risk today — but it is the same "asserted on both exits that serialize it"
    // convention the flag case above states, and it is this principal's every-wake read.
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_COMMAND_SENTINEL);
  });

  it("still discloses heartbeat-context runtime config to an entitled owner member", async () => {
    const { companyId, issueId } = await seedScenario();

    const res = await request(createApp(ownerActor(companyId))).get(
      `/api/issues/${issueId}/heartbeat-context`,
    );

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(EXECUTION_WS_SENTINEL);
  });

  /**
   * PEN-3252. `executionWorkspaceSettings` is the carrier PEN-3073 deliberately left open: it reaches
   * responses on a raw JSONB column through `{...issue}` spreads, so it BYPASSED the boundary rather
   * than slipping through a gap in its width. These assert on the serialized body of the real routes,
   * because the failure was a response that carried the material — not a call site that looked wrong.
   */
  it("withholds executionWorkspaceSettings from an agent on GET /issues/:id", async () => {
    const { companyId, agentId, issueId } = await seedScenario();

    const res = await request(createApp(agentActor(companyId, agentId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    const settings = res.body.executionWorkspaceSettings;
    // Withheld, not deleted — the closed-shape fields the UI actually reads still cross.
    expect(settings.mode).toBe("isolated_workspace");
    expect(settings.environmentId).toBe(ISSUE_SETTINGS_ENVIRONMENT_ID);
    expect(settings.workspaceStrategy.baseRef).toBe("main");
    // …while every operator-authored string is elided, key names intact.
    expect(settings.workspaceStrategy.provisionCommand).not.toBe(ISSUE_SETTINGS_COMMAND_SENTINEL);
    expect(settings.workspaceRuntime.services[0].name).toBe("settings-web");
    expect(settings.workspaceRuntime.services[0].command).not.toBe(ISSUE_SETTINGS_RUNTIME_SENTINEL);
    // Whole-body, not per-field: this response served `currentExecutionWorkspace.config
    // .workspaceRuntime` masked while handing the same bytes back under `executionWorkspaceSettings`,
    // and only a whole-body assertion catches a carrier one key over.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ISSUE_SETTINGS_RUNTIME_SENTINEL);
    expect(body).not.toContain(ISSUE_SETTINGS_COMMAND_SENTINEL);
    expect(body).not.toContain(ISSUE_SETTINGS_UNKNOWN_SENTINEL);
  });

  it("withholds executionWorkspaceSettings on a mutation exit (PATCH /issues/:id)", async () => {
    const { companyId, agentId, issueId } = await seedScenario();
    // PATCH enforces the single-assignee checkout invariant, so the actor has to hold the run lock.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db
      .update(issues)
      .set({ checkoutRunId: runId, executionRunId: runId })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high" });

    // The ten mutation exits answer with `.returning()` rows rather than the detail row, so a fix
    // applied only to `GET /issues/:id` would leave every one of them open. This pins one end-to-end.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ISSUE_SETTINGS_RUNTIME_SENTINEL);
    expect(body).not.toContain(ISSUE_SETTINGS_COMMAND_SENTINEL);
    expect(body).not.toContain(ISSUE_SETTINGS_UNKNOWN_SENTINEL);
    expect(res.body.executionWorkspaceSettings.mode).toBe("isolated_workspace");
  });

  it("still discloses executionWorkspaceSettings to an entitled owner member", async () => {
    const { companyId, issueId } = await seedScenario();

    const res = await request(createApp(ownerActor(companyId))).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    // Without this the two above would also pass on a projection that masked unconditionally.
    const body = JSON.stringify(res.body);
    expect(body).toContain(ISSUE_SETTINGS_RUNTIME_SENTINEL);
    expect(body).toContain(ISSUE_SETTINGS_COMMAND_SENTINEL);
    expect(body).toContain(ISSUE_SETTINGS_UNKNOWN_SENTINEL);
  });
});
