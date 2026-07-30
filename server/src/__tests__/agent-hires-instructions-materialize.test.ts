import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BLO-16555: an approved agent hire must materialize the requested
// instructionsBundle.files content atomically, even when the submitted
// adapterConfig already declares instructions* fields (e.g. because it was
// cloned from another agent's adapterConfig as a role template). Regression
// for a bug where that combination silently dropped the requested content,
// leaving the agent with `instructionsBundleMode: "managed"` metadata but a
// bundle that was never written to disk.
//
// This suite exercises the real `agentInstructionsService` against a temp
// PAPERCLIP_HOME (not mocked) so it proves actual bytes land on disk, while
// the DB-backed services (agent persistence, approvals, secrets) are faked
// in-memory.

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));
const mockApprovalService = vi.hoisted(() => ({ create: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillEntries: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn((_agent: unknown, config: Record<string, unknown>) => config));

function makeAgentStore() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    async create(companyId: string, input: Record<string, unknown>) {
      const row = {
        title: null,
        icon: null,
        reportsTo: null,
        capabilities: null,
        status: "idle",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: null,
        updatedAt: new Date(),
        ...input,
        companyId,
      };
      rows.set(String(row.id), row);
      return row;
    },
    async update(id: string, patch: Record<string, unknown>) {
      const existing = rows.get(id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      rows.set(id, next);
      return next;
    },
    async getById(id: string) {
      return rows.get(id) ?? null;
    },
  };
}

async function createApp(agentSvc: ReturnType<typeof makeAgentStore>, realInstructionsService: unknown) {
  vi.doMock("../services/index.js", () => ({
    agentService: () => agentSvc,
    agentInstructionsService: () => realInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => ({}),
    environmentService: () => ({ getById: vi.fn() }),
    heartbeatService: () => ({}),
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn((type: string) => ({ type })),
    findActiveServerAdapter: vi.fn((type: string) => ({ type })),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
  }));

  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: "company-1", requireBoardApprovalForNewAgents: true }]),
      })),
    })),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("agent-hires approval path materializes instructions bundle content", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  let paperclipHome: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();

    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-hires-instructions-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  it("materializes requested AGENTS.md content on disk even when adapterConfig already declares a managed bundle from a cloned template", async () => {
    const { agentInstructionsService } = await vi.importActual<typeof import("../services/agent-instructions.js")>(
      "../services/agent-instructions.js",
    );
    const realInstructionsService = agentInstructionsService();
    const agentSvc = makeAgentStore();

    // Simulate the source agent ("Ally") already having its own materialized bundle,
    // which is the shape a hire submitter would clone into a new hire's adapterConfig.
    const sourceAgentInstructionsRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "source-agent-id",
      "instructions",
    );
    await fs.mkdir(sourceAgentInstructionsRoot, { recursive: true });
    await fs.writeFile(path.join(sourceAgentInstructionsRoot, "AGENTS.md"), "# Source agent\n", "utf8");

    const requestedContent = `# New hire instructions\n\n${"Reviews PRs end to end.\n".repeat(400)}`;
    expect(requestedContent.length).toBeGreaterThan(1000);

    const app = await createApp(agentSvc, realInstructionsService);
    const res = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Ally Reviewer B",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          // Cloned verbatim from the source agent's own config, per BLO-16549's
          // "cloned from Ally's role" hire flow.
          instructionsBundleMode: "managed",
          instructionsRootPath: sourceAgentInstructionsRoot,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: path.join(sourceAgentInstructionsRoot, "AGENTS.md"),
        },
        instructionsBundle: {
          files: {
            "AGENTS.md": requestedContent,
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const hiredAgentId = res.body.agent.id as string;
    expect(hiredAgentId).toEqual(expect.any(String));

    const persisted = agentSvc.rows.get(hiredAgentId);
    expect(persisted, "agent must be persisted").toBeTruthy();
    const persistedAdapterConfig = persisted!.adapterConfig as Record<string, unknown>;

    // The healed adapterConfig must point at THIS agent's own managed root, not the
    // cloned source agent's directory.
    const expectedOwnRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      hiredAgentId,
      "instructions",
    );
    expect(persistedAdapterConfig.instructionsBundleMode).toBe("managed");
    expect(persistedAdapterConfig.instructionsRootPath).toBe(expectedOwnRoot);
    expect(persistedAdapterConfig.instructionsFilePath).toBe(path.join(expectedOwnRoot, "AGENTS.md"));

    // The requested content must be on disk, at the agent's own path, atomically as
    // part of the hire — not size 0, not left at the cloned source path.
    const writtenContent = await fs.readFile(path.join(expectedOwnRoot, "AGENTS.md"), "utf8");
    expect(writtenContent).toBe(requestedContent);

    const sourceAgentContentUnchanged = await fs.readFile(path.join(sourceAgentInstructionsRoot, "AGENTS.md"), "utf8");
    expect(sourceAgentContentUnchanged).toBe("# Source agent\n");

    const bundle = await realInstructionsService.getBundle({
      id: hiredAgentId,
      companyId: "company-1",
      name: "Ally Reviewer B",
      adapterConfig: persistedAdapterConfig,
    });
    const entryFileSummary = bundle.files.find((file: { path: string }) => file.path === "AGENTS.md");
    expect(entryFileSummary?.size).toBe(Buffer.byteLength(requestedContent, "utf8"));
    expect(entryFileSummary?.size).toBeGreaterThan(0);
  });

  it("keeps PUT instructions-bundle/file writable immediately after an approved hire materializes managed metadata", async () => {
    const { agentInstructionsService } = await vi.importActual<typeof import("../services/agent-instructions.js")>(
      "../services/agent-instructions.js",
    );
    const realInstructionsService = agentInstructionsService();
    const agentSvc = makeAgentStore();

    const app = await createApp(agentSvc, realInstructionsService);
    const hireRes = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Fresh Hire",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        instructionsBundle: {
          files: {
            "AGENTS.md": "# Fresh hire\n",
          },
        },
      });
    expect(hireRes.status, JSON.stringify(hireRes.body)).toBe(201);
    const hiredAgentId = hireRes.body.agent.id as string;

    const putRes = await request(app)
      .put(`/api/agents/${hiredAgentId}/instructions-bundle/file?companyId=company-1`)
      .send({ path: "AGENTS.md", content: "# Updated after approval\n" });

    expect(putRes.status, JSON.stringify(putRes.body)).toBe(200);
    expect(putRes.body.size).toBe(Buffer.byteLength("# Updated after approval\n", "utf8"));

    const persisted = agentSvc.rows.get(hiredAgentId);
    const rootPath = (persisted!.adapterConfig as Record<string, unknown>).instructionsRootPath as string;
    const onDisk = await fs.readFile(path.join(rootPath, "AGENTS.md"), "utf8");
    expect(onDisk).toBe("# Updated after approval\n");
  });
});
