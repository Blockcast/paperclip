import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySkills,
  createDb,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { companySkillService } from "../services/company-skills.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "runtime_skill_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat runtime skill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat runtime skill version pins", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;
  const capturedRuns: Array<{
    agentId: string;
    skills: PaperclipSkillEntry[];
    mcpServers: AdapterRuntimeMcpServer[];
    config: Record<string, unknown>;
    context: Record<string, unknown>;
    serializedRuntimeInput: string;
  }> = [];
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-runtime-skills-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-skills-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    // The server normalizes PAPERCLIP_API_URL into its own env at boot
    // (server/src/index.ts); heartbeat gateway delivery requires it, so pin
    // a deterministic value for tests that never boot the full server.
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        const serializedRuntimeInput = JSON.stringify({
          config: ctx.config,
          context: ctx.context,
          runtimeMcp: ctx.runtimeMcp,
        });
        await ctx.onLog("stdout", `${serializedRuntimeInput}\n`);
        capturedRuns.push({
          agentId: ctx.agent.id,
          skills: (ctx.config.paperclipRuntimeSkills ?? []) as PaperclipSkillEntry[],
          mcpServers: ctx.runtimeMcp?.getServers() ?? [],
          config: ctx.config,
          context: (ctx.context ?? {}) as Record<string, unknown>,
          serializedRuntimeInput,
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          label: "Captured runtime skills",
          resultJson: { exitCode: 0 },
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 120_000);

  afterEach(async () => {
    capturedRuns.length = 0;
    await cleanupHeartbeatTestState(db, heartbeat, {
      extraTruncateTables: ["environments"],
    });
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    await tempDb?.cleanup();
  });

  it("materializes different pinned skill versions for different agents at runtime", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const skillKey = `company/${companyId}/runtime-coach`;
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-versioned-runtime-skill-"));
    cleanupDirs.add(skillDir);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Runtime Coach\n\nVersion one.\n", "utf8");
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "runtime-coach",
      name: "Runtime Coach",
      description: null,
      markdown: "# Runtime Coach\n\nVersion one.\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    const skills = companySkillService(db);
    const versionOne = await skills.createVersion(
      companyId,
      skillId,
      { label: "v1" },
      { type: "user", userId: "board" },
    );
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Runtime Coach\n\nVersion two.\n", "utf8");
    await db
      .update(companySkills)
      .set({ markdown: "# Runtime Coach\n\nVersion two.\n", updatedAt: new Date() })
      .where(eq(companySkills.id, skillId));
    const versionTwo = await skills.createVersion(
      companyId,
      skillId,
      { label: "v2" },
      { type: "user", userId: "board" },
    );

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "Pinned V1",
        role: "engineer",
        status: "idle",
        adapterType: TEST_ADAPTER_TYPE,
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [{ key: skillKey, versionId: versionOne.id }],
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Pinned V2",
        role: "engineer",
        status: "idle",
        adapterType: TEST_ADAPTER_TYPE,
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [{ key: skillKey, versionId: versionTwo.id }],
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const firstRun = await heartbeat.invoke(firstAgentId, "on_demand", {}, "manual");
    expect(firstRun).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, firstRun!.id))?.status).toBe("succeeded");

    const secondRun = await heartbeat.invoke(secondAgentId, "on_demand", {}, "manual");
    expect(secondRun).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, secondRun!.id))?.status).toBe("succeeded");

    const firstSkill = capturedRuns.find((run) => run.agentId === firstAgentId)?.skills
      .find((entry) => entry.key === skillKey);
    const secondSkill = capturedRuns.find((run) => run.agentId === secondAgentId)?.skills
      .find((entry) => entry.key === skillKey);

    expect(firstSkill).toMatchObject({
      key: skillKey,
      versionId: versionOne.id,
      currentVersionId: versionTwo.id,
      sourceStatus: "available",
    });
    expect(secondSkill).toMatchObject({
      key: skillKey,
      versionId: versionTwo.id,
      currentVersionId: versionTwo.id,
      sourceStatus: "available",
    });
    await expect(fs.readFile(path.join(firstSkill!.source, "SKILL.md"), "utf8"))
      .resolves.toContain("Version one.");
    await expect(fs.readFile(path.join(secondSkill!.source, "SKILL.md"), "utf8"))
      .resolves.toContain("Version two.");

    const firstSkillFile = path.join(firstSkill!.source, "SKILL.md");
    const oldMtime = new Date("2024-01-01T00:00:00.000Z");
    await fs.utimes(firstSkillFile, oldMtime, oldMtime);

    const repeatRun = await heartbeat.invoke(firstAgentId, "on_demand", {}, "manual");
    expect(repeatRun).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, repeatRun!.id))?.status).toBe("succeeded");
    const repeatedSkill = capturedRuns
      .filter((run) => run.agentId === firstAgentId)
      .at(-1)
      ?.skills.find((entry) => entry.key === skillKey);
    expect(repeatedSkill).toMatchObject({
      source: firstSkill!.source,
      versionId: versionOne.id,
      sourceStatus: "available",
    });
    expect((await fs.stat(firstSkillFile)).mtime.toISOString()).toBe(oldMtime.toISOString());
  });

  // BLO-7991 AC2 — a declared skill that never materializes must be visible to
  // the agent INSIDE the pod, not merely to the API/UI snapshot.
  //
  // This asserts against `ctx.context`, which is what the adapter injects into
  // the run's opening prompt, rather than against `ctx.onLog`. That distinction
  // is the whole point: `onLog` and `commandNotes` reach the run log and the UI
  // only, so a test asserting "the warning was emitted" would pass against a
  // log line while the model still saw nothing — exactly the failure mode AC2's
  // own verifying signal warns about.
  it("surfaces declared-but-unmaterialized skills to the run prompt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const presentKey = `company/${companyId}/present-skill`;
    const missingSourceKey = `company/${companyId}/missing-source-skill`;
    const missingVersionId = randomUUID();
    // Never imported into `companySkills`, so `listRuntimeSkillEntries` cannot
    // even enter its loop for this key. This is the design-shotgun shape.
    const danglingKey = `company/${companyId}/never-imported-skill`;
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ac2-skill-"));
    cleanupDirs.add(skillDir);

    await db.insert(companies).values({
      id: companyId,
      name: "Skill Delta",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Present\n\nBody.\n", "utf8");
    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: presentKey,
      slug: "present-skill",
      name: "Present Skill",
      description: null,
      markdown: "# Present\n\nBody.\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: missingSourceKey,
      slug: "missing-source-skill",
      name: "Missing Source Skill",
      description: null,
      markdown: "# Missing Source\n\nBody.\n",
      sourceType: "local_path",
      sourceLocator: path.join(skillDir, "does-not-exist"),
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Skill Delta Capture",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {
        // A stale version pin is deterministic here: ordinary missing local
        // sources are intentionally recovered from their stored SKILL.md by
        // the heartbeat runtime path.
        paperclipSkillSync: {
          desiredSkills: [presentKey, { key: missingSourceKey, versionId: missingVersionId }, danglingKey],
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const captured = capturedRuns.find((entry) => entry.agentId === agentId);
    expect(captured).toBeDefined();

    // The delta is real: the dangling key is genuinely absent from what the pod
    // receives, while the resolvable sibling came through. Without this the
    // assertion below could pass on a warning about nothing.
    // Runtime entries are sorted by key before they reach the adapter.
    expect(captured!.skills.map((entry) => entry.key)).toEqual([missingSourceKey, presentKey]);
    expect(captured!.skills.find((entry) => entry.key === missingSourceKey)).toMatchObject({
      sourceStatus: "missing",
    });

    const taskMarkdown = String(captured!.context.paperclipTaskMarkdown ?? "");
    expect(taskMarkdown).toContain(danglingKey);
    expect(taskMarkdown).toContain("3 skills configured, 1 available");
    expect(taskMarkdown).toContain("not in the company skill library");
    expect(taskMarkdown).toContain("library entry exists but its files are not on the runtime volume");
    // Resolvable skills must not be named as missing.
    expect(taskMarkdown).not.toContain(`\`${presentKey}\``);

    // Structured mirror, persisted to the run row via `contextSnapshot`, so a
    // health sweep can key off it without parsing prose.
    expect(captured!.context.paperclipUnmaterializedSkills).toMatchObject({
      declaredCount: 3,
      materializedCount: 1,
      missing: [
        { key: missingSourceKey, reason: "unresolved_source" },
        { key: danglingKey, reason: "absent" },
      ],
    });
  });

  // BLO-31993 — the classification the unit test cannot prove is wired up.
  //
  // `computeUnmaterializedDesiredSkills` being correct is not enough: the call
  // site has to actually consult the catalog, and the AC2 hot path is the one
  // place that could quietly skip it. So this drives a real run against a real
  // `companySkills` row and asserts on the prompt the pod receives.
  //
  // The state under test is "catalog row present, runtime files absent". It is
  // induced deterministically — a row whose source directory does not exist AND
  // whose fileInventory carries no SKILL.md, so `materializeRuntimeSkillFiles`
  // throws and the caller drops the key with its bare `continue`.
  //
  // Note which branch that is: it is the *permanent* one. It throws identically
  // on every subsequent run, unlike a rolling sweep caught mid-flight (rm -rf →
  // mkdir → per-file write is not atomic), which clears on its own. Both reach
  // this classification byte-identically, because `.catch(() => null)` discards
  // which throw it was — so the seam cannot tell them apart, and the reason is
  // named `runtime_files_unpublished` for the observed state rather than for a
  // cause. Inducing the permanent branch here is therefore the load-bearing
  // choice: it is the case a transient-sounding notice would mislead, so the
  // assertions below pin that the notice claims only what is known.
  it("distinguishes a catalog row awaiting materialization from a key with no row", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pendingKey = `company/${companyId}/pending-materialization-skill`;
    // No `companySkills` row at all — the genuinely-absent control. Without it
    // this test could pass by relabelling everything `runtime_files_unpublished`.
    const danglingKey = `company/${companyId}/never-imported-skill`;
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-blo31993-"));
    cleanupDirs.add(skillDir);

    await db.insert(companies).values({
      id: companyId,
      name: "Skill Materialization Pending",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: pendingKey,
      slug: "pending-materialization-skill",
      name: "Pending Materialization Skill",
      description: null,
      markdown: "# Pending\n\nBody.\n",
      sourceType: "local_path",
      // Not on disk, so the direct-source branch misses and materialization runs.
      sourceLocator: path.join(skillDir, "does-not-exist"),
      trustLevel: "markdown_only",
      compatibility: "compatible",
      // No SKILL.md entry, so materialization cannot satisfy `wroteSkillFile`
      // and throws — the key is dropped and produces no runtime entry.
      fileInventory: [{ path: "reference.md", kind: "reference" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Materialization Pending Capture",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {
        paperclipSkillSync: { desiredSkills: [pendingKey, danglingKey] },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const captured = capturedRuns.find((entry) => entry.agentId === agentId);
    expect(captured).toBeDefined();
    // Both keys really did fail to reach the pod, so the notice below is about
    // something rather than passing vacuously.
    expect(captured!.skills.map((entry) => entry.key)).toEqual([]);

    const taskMarkdown = String(captured!.context.paperclipTaskMarkdown ?? "");
    expect(taskMarkdown).toContain(pendingKey);
    expect(taskMarkdown).toContain(danglingKey);
    // The defect: the imported skill was told it was not in the library, and
    // the reader was sent to re-import it.
    expect(taskMarkdown).toContain(
      `\`${pendingKey}\` — in the company skill library, but its runtime files are not published yet`,
    );
    expect(taskMarkdown).toContain(`\`${danglingKey}\` — not in the company skill library`);
    expect(taskMarkdown).toContain("do not import them again");
    // This run induced the PERMANENT branch (see the comment above), so the
    // notice must not promise the state clears by itself — it must state only
    // what is known and say to report a persistent one.
    expect(taskMarkdown).not.toContain("so a later run will pick them up");
    expect(taskMarkdown).toContain("Report it if it persists across runs");
    // Counts are unchanged by the reclassification (AC).
    expect(taskMarkdown).toContain("2 skills configured, 0 available");

    expect(captured!.context.paperclipUnmaterializedSkills).toMatchObject({
      declaredCount: 2,
      materializedCount: 0,
      missing: [
        { key: pendingKey, reason: "runtime_files_unpublished" },
        { key: danglingKey, reason: "absent" },
      ],
    });
  });

  it("adds no skill notice when every declared skill materializes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const skillKey = `company/${companyId}/clean-skill`;
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ac2-clean-"));
    cleanupDirs.add(skillDir);

    await db.insert(companies).values({
      id: companyId,
      name: "Skill Delta Clean",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Clean\n\nBody.\n", "utf8");
    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: skillKey,
      slug: "clean-skill",
      name: "Clean Skill",
      description: null,
      markdown: "# Clean\n\nBody.\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Skill Delta Clean Capture",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skillKey] } },
      runtimeConfig: {},
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const captured = capturedRuns.find((entry) => entry.agentId === agentId);
    expect(captured).toBeDefined();
    expect(captured!.skills.map((entry) => entry.key)).toEqual([skillKey]);
    expect(captured!.context.paperclipUnmaterializedSkills).toBeUndefined();
    expect(String(captured!.context.paperclipTaskMarkdown ?? ""))
      .not.toContain("configured skills are unavailable");
  });

  it("delivers installed connections without exposing gateway bearers in adapter config or logs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Runtime MCP Delivery",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runtime MCP Capture",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [application] = await db.insert(toolApplications).values({
      companyId,
      applicationKey: `runtime-${randomUUID().slice(0, 8)}`,
      name: "Runtime MCP",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [installed, uninstalled] = await db.insert(toolConnections).values([
      {
        companyId,
        applicationId: application!.id,
        name: "Installed Runtime MCP",
        transport: "remote_http",
        status: "active",
        enabled: true,
        config: { url: "https://installed.example.test/mcp" },
      },
      {
        companyId,
        applicationId: application!.id,
        name: "Uninstalled Runtime MCP",
        transport: "remote_http",
        status: "active",
        enabled: true,
        config: { url: "https://uninstalled.example.test/mcp" },
      },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId,
      profileKey: `app:${installed!.id}`,
      name: installed!.name,
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: installed!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agentId,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId,
      connectionId: installed!.id,
      targetType: "agent",
      targetId: agentId,
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const captured = capturedRuns.find((entry) => entry.agentId === agentId);
    expect(captured?.mcpServers).toHaveLength(1);
    expect(captured?.mcpServers[0]).toMatchObject({
      connectionId: installed!.id,
      name: installed!.name,
      token: expect.stringMatching(/^pcgw_/),
      url: expect.stringContaining("/api/tool-gateway/gateways/"),
    });
    expect(captured?.mcpServers.some((server) => server.connectionId === uninstalled!.id)).toBe(false);
    const bearer = captured?.mcpServers[0]?.token;
    expect(bearer).toMatch(/^pcgw_/);
    if (!bearer) throw new Error("Expected runtime MCP bearer");
    expect(captured?.config).not.toHaveProperty("paperclipRuntimeMcpServers");
    expect(JSON.stringify(captured?.config)).not.toContain(bearer);
    expect(captured?.serializedRuntimeInput).not.toContain(bearer);
    const log = await heartbeat.readLog(run!.id);
    expect(log.content).not.toContain(bearer);
    expect(log.content).not.toContain("pcgw_");
  });
});
