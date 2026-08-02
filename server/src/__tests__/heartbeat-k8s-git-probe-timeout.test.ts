import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { resolveAgentEmptyWorkspaceSourceDir, resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { heartbeatService } from "../services/heartbeat.js";

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    resultJson: {},
    provider: "test",
    model: "test-model",
  })),
);
const mockHasActiveJobForAgent = vi.hoisted(() => vi.fn(async () => false));
const mockListAgentJobRunStatuses = vi.hoisted(() => vi.fn(async () => null));
const mockListLiveAgentJobRunIds = vi.hoisted(() => vi.fn(async () => null));
const mockListManagedAgentJobs = vi.hoisted(() => vi.fn(async () => null));
const mockReadAgentJobRunStatusByName = vi.hoisted(() => vi.fn(async () => null));
const mockDeleteAgentJobExact = vi.hoisted(() => vi.fn(async () => "deleted" as const));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../services/k8s-job-liveness.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/k8s-job-liveness.ts")>(
    "../services/k8s-job-liveness.ts",
  );
  return {
    ...actual,
    hasActiveJobForAgent: mockHasActiveJobForAgent,
    listAgentJobRunStatuses: mockListAgentJobRunStatuses,
    listLiveAgentJobRunIds: mockListLiveAgentJobRunIds,
    listManagedAgentJobs: mockListManagedAgentJobs,
    readAgentJobRunStatusByName: mockReadAgentJobRunStatusByName,
    deleteAgentJobExact: mockDeleteAgentJobExact,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "claude_k8s",
      supportsLocalAgentJwt: false,
      execute: adapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres k8s git probe timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const execFile = promisify(execFileCallback);

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("claude_k8s agent-home git probe timeout", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-k8s-git-probe-timeout-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      penstockAvailabilityGate: {
        checkAdapter: async () => ({ allow: true }),
        _resetForTesting() {},
      },
    });
  }, 120_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    mockHasActiveJobForAgent.mockClear();
    mockListAgentJobRunStatuses.mockClear();
    mockListLiveAgentJobRunIds.mockClear();
    mockListManagedAgentJobs.mockClear();
    mockReadAgentJobRunStatusByName.mockClear();
    mockDeleteAgentJobExact.mockClear();
    await cleanupHeartbeatTestState(db, heartbeat, {
      extraTruncateTables: ["instance_settings"],
      errorLabel: "k8s git probe timeout cleanup",
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("fails closed before adapter execution when the fallback git probe stalls", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-stalled-git-"));
    const previousPath = process.env.PATH;
    const previousTimeout = process.env.PAPERCLIP_STRICT_GIT_CHECKOUT_PROBE_TIMEOUT_MS;

    try {
      await fs.mkdir(fallbackCwd, { recursive: true });
      await fs.writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
      process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
      process.env.PAPERCLIP_STRICT_GIT_CHECKOUT_PROBE_TIMEOUT_MS = "200";

      await db.insert(companies).values({
        id: companyId,
        name: "K8s Git Probe Timeout Co",
        issuePrefix: "KGP",
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Claude K8s Timeout",
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            wakeOnDemand: true,
            concurrencyEnabled: true,
            maxConcurrentRuns: 2,
          },
        },
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Projectless claude_k8s work",
        status: "in_progress",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: "KGP-1",
      });

      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
        },
      });
      expect(run).not.toBeNull();

      const failed = await waitForRunToFinish(heartbeat, run!.id, 15_000);
      expect(failed).toMatchObject({
        status: "failed",
        errorCode: "workspace_validation_failed",
      });
      expect(failed?.error).toContain(
        "Refusing to dispatch claude_k8s run isolation from the fallback cwd",
      );
      expect(failed?.resultJson).toMatchObject({
        workspaceValidation: expect.objectContaining({
          reason: "k8s_agent_home_git_bootstrap_unsupported",
          gitProbeState: "indeterminate",
        }),
      });
      expect(adapterExecute).not.toHaveBeenCalled();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousTimeout === undefined) delete process.env.PAPERCLIP_STRICT_GIT_CHECKOUT_PROBE_TIMEOUT_MS;
      else process.env.PAPERCLIP_STRICT_GIT_CHECKOUT_PROBE_TIMEOUT_MS = previousTimeout;
      await fs.rm(fakeBin, { recursive: true, force: true });
      await fs.rm(fallbackCwd, { recursive: true, force: true });
    }
  }, 120_000);

  // BLO-18760: the intake case. An issue born with projectId: null and
  // executionWorkspaceId: null used to resolve onto the persistent per-agent
  // dir, which carries a real `.git` from unrelated prior runs — so the pod's
  // `git clone --shared` bootstrap exited 128, or (post-BLO-18147) the guard
  // above refused dispatch and parked the issue with no wake path. It now
  // resolves onto a repo-less source, so the guard's probe passes and the run
  // actually dispatches; the pod's own `rev-parse --verify HEAD` then fails
  // into its non-fatal empty-workspace branch.
  it("dispatches a projectless claude_k8s run from the repo-less fallback source", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const agentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
    const emptySourceCwd = resolveAgentEmptyWorkspaceSourceDir(agentId);

    try {
      // Reproduce the field precondition exactly: the persistent agent home is
      // a real checkout. Before this fix that is what the run would have been
      // handed, and the guard would have refused.
      await fs.mkdir(agentHomeCwd, { recursive: true });
      await execFile("git", ["init"], { cwd: agentHomeCwd });

      await db.insert(companies).values({
        id: companyId,
        name: "K8s Repo-less Fallback Co",
        issuePrefix: "KRF",
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Claude K8s Repoless",
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            wakeOnDemand: true,
            concurrencyEnabled: true,
            maxConcurrentRuns: 2,
          },
        },
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Board-filed work with no project",
        status: "in_progress",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: "KRF-1",
      });

      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      });
      expect(run).not.toBeNull();

      const finished = await waitForRunToFinish(heartbeat, run!.id, 15_000);
      // The whole point: no workspace_validation_failed park, and the adapter
      // is actually reached rather than the run dying during bootstrap.
      expect(finished?.errorCode).not.toBe("workspace_validation_failed");
      expect(adapterExecute).toHaveBeenCalled();
      // ...and it launched from the repo-less source, not the checkout-bearing
      // agent home.
      await expect(
        execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: emptySourceCwd }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(agentHomeCwd, { recursive: true, force: true });
      await fs.rm(emptySourceCwd, { recursive: true, force: true });
    }
  }, 120_000);
});
