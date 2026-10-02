import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { decodeRunAttribution } from "../services/execution-workspace-cleanup.js";

/**
 * PEN-3692, found by Ally on PR #2175 (review of d55f513).
 *
 * The operator archive (`PATCH /execution-workspaces/:id` with `status:
 * "archived"`) has two cleanup-failure writes, and both used to overwrite
 * `cleanup_reason` with teardown diagnostics — the joined warnings, `null` when
 * there were none, or the thrown error message.
 *
 * That destroyed the run-attribution origin on a row that STAYS collectable.
 * `cleanup_failed` is not `archived`, and neither write clears
 * `cleanupEligibleAt`, so `selectEligible` re-selects the row on the next pass;
 * the archive earlier in the same handler has already nulled the reason, so
 * there is nothing left to read it back from. A row stamped `run_ended` by run
 * teardown then reported as `idle_backfill` (free text) or `unknown` (null)
 * forever after — understating exactly the failed-run population PEN-3692
 * exists to measure.
 *
 * `execution-workspace-cleanup-reason-writers.test.ts` is structurally blind to
 * this: its regex matches a literal `cleanupReason: null`, and these sites
 * spelled a ternary and a variable. So the guard there covers the degenerate
 * null case and this file covers the general one — the assertions below go
 * through `decodeRunAttribution`, pinning the PROPERTY (the origin survives)
 * rather than the stored spelling, so a later change of encoding cannot make
 * them pass for the wrong reason.
 */

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(() => ({ record: vi.fn(async () => undefined) })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() => vi.fn());
vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: vi.fn(),
  cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  listConfiguredRuntimeServiceEntries: vi.fn(() => []),
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({
    destroyReusableSandboxLeases: vi.fn(async () => undefined),
  }),
}));

/** The row as run teardown leaves it: stamped, and attributed to the run. */
const STAMPED_BY_RUN_TEARDOWN = {
  id: "workspace-1",
  companyId: "company-1",
  status: "active",
  mode: "isolated_workspace",
  cwd: "/fixture/cwd",
  providerType: "git_worktree",
  providerRef: "/fixture/cwd",
  projectId: null,
  projectWorkspaceId: null,
  metadata: null,
  cleanupReason: "run_ended",
  cleanupEligibleAt: new Date("2026-10-01T00:00:00Z"),
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/**
 * The patch the handler sends on its SECOND `update` — the cleanup-failure
 * write. The first is the archive itself, which legitimately nulls the reason
 * because it also sets `status: "archived"`.
 */
function cleanupFailurePatch(): Record<string, unknown> {
  expect(mockExecutionWorkspaceService.update.mock.calls.length).toBeGreaterThanOrEqual(2);
  const calls = mockExecutionWorkspaceService.update.mock.calls;
  return calls[calls.length - 1]![1] as Record<string, unknown>;
}

describe.sequential("operator archive preserves run attribution on cleanup failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "runtime:manage",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue({ ...STAMPED_BY_RUN_TEARDOWN });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      workspaceId: "workspace-1",
      state: "ready",
      blockingReasons: [],
      warnings: [],
      linkedIssues: [],
      plannedActions: [],
      isDestructiveCloseAllowed: true,
      isSharedWorkspace: false,
      isProjectPrimaryWorkspace: false,
      git: null,
      runtimeServices: {},
    });
    mockExecutionWorkspaceService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({
        ...STAMPED_BY_RUN_TEARDOWN,
        ...patch,
      }),
    );
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      record: vi.fn(async () => undefined),
    });
  });

  it("keeps the origin when cleanup reports warnings and does not clean", async () => {
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({
      cleaned: false,
      warnings: ["git worktree remove --force failed", "lock held"],
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    const patch = cleanupFailurePatch();
    // The row is handed back to the collector...
    expect(patch.status).toBe("cleanup_failed");
    expect(patch.cleanupEligibleAt).toBeUndefined();
    // ...so it must still carry its origin. Before the fix this was the joined
    // warning text, which decodes to `idle_backfill`.
    expect(decodeRunAttribution(patch.cleanupReason as string | null)).toBe("run_ended");
  });

  it("keeps the origin when cleanup fails with no warnings at all", async () => {
    // The null arm of the old ternary: decoded to `unknown`, the one case the
    // literal-null guard would have caught had it been spelled literally.
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({ cleaned: false, warnings: [] });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    const patch = cleanupFailurePatch();
    expect(patch.status).toBe("cleanup_failed");
    expect(decodeRunAttribution(patch.cleanupReason as string | null)).toBe("run_ended");
  });

  it("keeps the origin when cleanup throws", async () => {
    mockCleanupExecutionWorkspaceArtifacts.mockRejectedValue(new Error("ESTALE on /fixture/cwd"));

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    // This path answers 500 and returns before the activity log, which is why
    // the handler logs the thrown message separately.
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ESTALE on /fixture/cwd");
    const patch = cleanupFailurePatch();
    expect(patch.status).toBe("cleanup_failed");
    expect(decodeRunAttribution(patch.cleanupReason as string | null)).toBe("run_ended");
  });

  it("does not invent an origin for a row that never had one", async () => {
    // The discriminator: the fix must PRESERVE the origin, not hardcode
    // `run_ended`. An unattributed row stays unattributed.
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...STAMPED_BY_RUN_TEARDOWN,
      cleanupReason: "idle_backfill",
    });
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({ cleaned: false, warnings: [] });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(decodeRunAttribution(cleanupFailurePatch().cleanupReason as string | null))
      .toBe("idle_backfill");
  });

  it("still archives cleanly when cleanup succeeds, leaving the row out of scope", async () => {
    // The control: a clean teardown ends `archived`, which `selectEligible`
    // excludes outright, so no attribution question arises.
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({ cleaned: true, warnings: [] });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    const firstPatch = mockExecutionWorkspaceService.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(firstPatch.status).toBe("archived");
    expect(firstPatch.cleanupReason).toBeNull();
  });

  it("does not re-assert the origin when cleanup succeeds but warns", async () => {
    // The only branch that reaches the SECOND update without failing: `cleaned`
    // with warnings. The restore must not fire here — the row ends `archived`,
    // so `selectEligible` excludes it and there is no collector question to
    // answer, but the detail page renders `<cleanupEligibleAt> · <cleanupReason>`
    // whenever the stamp is set. Re-asserting `run_ended` on a collected
    // workspace would display it as though collection were still pending.
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValue({
      cleaned: true,
      warnings: ["teardown command exited 1"],
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    // The update does fire — this is the branch, not a case where it is skipped.
    expect(mockExecutionWorkspaceService.update.mock.calls.length).toBe(2);
    const secondPatch = mockExecutionWorkspaceService.update.mock.calls[1]![1] as Record<string, unknown>;
    // ...and it leaves the archive's own writes alone: no demotion, and the
    // reason is not touched, so the `null` written at archive time stands.
    expect(secondPatch.status).toBeUndefined();
    expect(secondPatch).not.toHaveProperty("cleanupReason");
  });
});
