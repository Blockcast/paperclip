/**
 * BLO-20957 — before this fix, a due job dispatched exactly one process-wide
 * `runJob` RPC call per tick, regardless of how many companies had
 * configured the plugin. These tests exercise the fan-out replacement: the
 * scheduler now calls `listConfigCompanyIds(pluginId)` per due job and
 * dispatches once per configured company (or once, unscoped, for zero
 * configured companies), recording each dispatch as its own
 * `plugin_job_runs` row.
 */
import { describe, expect, it, vi } from "vitest";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function fakeDueJobsDb(dueJobs: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dueJobs),
      }),
    }),
  } as never;
}

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    pluginId: "plugin-1",
    jobKey: "check-alert-escalations",
    schedule: "* * * * *",
    status: "active",
    lastRunAt: null,
    nextRunAt: new Date("2026-08-07T00:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeJobStore() {
  const createdRuns: Array<{ id: string; companyId: string | null; jobId: string; trigger: string }> = [];
  const completedRuns: Array<{ runId: string; status: string; error?: string | null }> = [];
  let nextRunId = 1;

  const jobStore: Partial<PluginJobStore> = {
    createRun: vi.fn(async (input) => {
      const run = {
        id: `run-${nextRunId++}`,
        jobId: input.jobId,
        pluginId: input.pluginId,
        companyId: input.companyId ?? null,
        trigger: input.trigger,
        status: "queued",
      };
      createdRuns.push({
        id: run.id,
        companyId: run.companyId,
        jobId: run.jobId,
        trigger: run.trigger,
      });
      return run as never;
    }),
    markRunning: vi.fn(async () => {}),
    completeRun: vi.fn(async (runId, input) => {
      completedRuns.push({ runId, status: input.status, error: input.error });
    }),
    updateRunTimestamps: vi.fn(async () => {}),
  };

  return { jobStore, createdRuns, completedRuns };
}

describe("plugin-job-scheduler per-company dispatch (BLO-20957)", () => {
  it("dispatches one runJob call per configured company, each carrying its own company scope", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore, createdRuns, completedRuns } = makeJobStore();

    const calls: Array<{ pluginId: string; method: string; params: unknown }> = [];
    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (pluginId, method, params) => {
        calls.push({ pluginId, method, params });
        return undefined;
      }) as never,
    };

    const listConfigCompanyIds = vi.fn(async () => ["company-a", "company-b"]);

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds,
    });

    await scheduler.tick();

    expect(listConfigCompanyIds).toHaveBeenCalledWith("plugin-1");
    expect(calls).toHaveLength(2);

    const dispatchedCompanyIds = calls
      .map((c) => (c.params as { job: { companyId?: string | null } }).job.companyId)
      .sort();
    expect(dispatchedCompanyIds).toEqual(["company-a", "company-b"]);

    expect(createdRuns).toHaveLength(2);
    expect(createdRuns.map((r) => r.companyId).sort()).toEqual(["company-a", "company-b"]);
    expect(completedRuns).toHaveLength(2);
    expect(completedRuns.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("dispatches a single instance-scoped call when the plugin has zero configured companies", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore, createdRuns } = makeJobStore();

    const calls: Array<{ params: unknown }> = [];
    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId, _method, params) => {
        calls.push({ params });
        return undefined;
      }) as never,
    };

    const listConfigCompanyIds = vi.fn(async () => []);

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds,
    });

    await scheduler.tick();

    expect(calls).toHaveLength(1);
    expect((calls[0].params as { job: { companyId?: string | null } }).job.companyId).toBeNull();
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0].companyId).toBeNull();
  });

  it("records one company's dispatch failure independently without blocking another company's success", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore, completedRuns } = makeJobStore();

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId, _method, params) => {
        const companyId = (params as { job: { companyId?: string | null } }).job.companyId;
        if (companyId === "company-a") {
          throw new Error('Plugin "plugin-1" is not allowed to perform "issues.list": company context is required');
        }
        return undefined;
      }) as never,
    };

    const listConfigCompanyIds = vi.fn(async () => ["company-a", "company-b"]);

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds,
    });

    await scheduler.tick();

    expect(completedRuns).toHaveLength(2);
    const byStatus = Object.fromEntries(completedRuns.map((r) => [r.status, r]));
    expect(byStatus.failed?.error).toContain("company context is required");
    expect(byStatus.succeeded).toBeTruthy();
  });

  it("still advances the schedule pointer once even when every company dispatch fails", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore } = makeJobStore();

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => {
        throw new Error("company context is required");
      }) as never,
    };

    const listConfigCompanyIds = vi.fn(async () => ["company-a", "company-b"]);

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds,
    });

    await scheduler.tick();

    expect(jobStore.updateRunTimestamps).toHaveBeenCalledTimes(1);
    expect(jobStore.updateRunTimestamps).toHaveBeenCalledWith(
      "job-1",
      expect.any(Date),
      expect.anything(),
    );
  });
});

/**
 * Ally review of PR #1145: treating a company-enumeration *error* as "zero
 * configured companies" made the scheduler fail OPEN — it dispatched one
 * unscoped run, which for a worker like alertmanager returns immediately
 * without doing any work, and then recorded `succeeded`. A registry/DB
 * outage therefore skipped every tenant while reporting perfect health,
 * feeding the new failure alert exactly the wrong signal.
 */
describe("plugin-job-scheduler fails closed on company enumeration errors (BLO-20957 review)", () => {
  it("does not dispatch an unscoped run when enumeration throws", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore } = makeJobStore();

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => undefined) as never,
    };

    const listConfigCompanyIds = vi.fn(async () => {
      throw new Error("registry unavailable");
    });

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds,
    });

    await scheduler.tick();

    // The whole point: no runJob call at all, rather than one unscoped call
    // that no-ops and reports success.
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("records a failed run so the failure-streak health signal can see it", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore, createdRuns, completedRuns } = makeJobStore();

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => undefined) as never,
    };

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    });

    await scheduler.tick();

    // Without a recorded run the fail-closed path would be invisible: no row
    // means nothing for `listJobsWithFailureStreak` to streak on, so an
    // outage would look identical to "job wasn't due".
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]?.companyId).toBeNull();
    expect(completedRuns).toHaveLength(1);
    expect(completedRuns[0]?.status).toBe("failed");
    expect(completedRuns[0]?.error).toContain("registry unavailable");
  });

  it("still advances the schedule pointer so the job self-heals once the registry recovers", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore } = makeJobStore();

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => undefined) as never,
    };

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    });

    await scheduler.tick();

    expect(jobStore.updateRunTimestamps).toHaveBeenCalledTimes(1);
  });

  it("still dispatches one instance-scoped run for a SUCCESSFUL empty enumeration", async () => {
    // The fallback is reserved for this case only — a plugin genuinely
    // configured by nobody still gets its instance-wide tick.
    const job = makeJobRow();
    const db = fakeDueJobsDb([job]);
    const { jobStore, createdRuns } = makeJobStore();

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => undefined) as never,
    };

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds: vi.fn(async () => []),
    });

    await scheduler.tick();

    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]?.companyId).toBeNull();
  });
});

/**
 * Ally review of PR #1145: manual and retry dispatches never carried
 * `job.companyId`, so the new per-company guard in the alertmanager worker
 * returned before running the sweep — and the scheduler recorded the run as
 * `succeeded`. A "run now" that reports success having done nothing is the
 * silent-no-op failure mode this whole issue is about.
 */
describe("plugin-job-scheduler manual trigger carries company scope (BLO-20957 review)", () => {
  function makeTriggerDeps(companyIds: string[]) {
    const job = makeJobRow();
    // `triggerJob` queries for already-running runs before dispatching;
    // return none so the trigger proceeds.
    const db = fakeDueJobsDb([]);
    const { jobStore, createdRuns } = makeJobStore();
    jobStore.getJobById = vi.fn(async () => job as never);

    const calls: Array<{ params: unknown }> = [];
    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId, _method, params) => {
        calls.push({ params });
        return undefined;
      }) as never,
    };

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds: vi.fn(async () => companyIds),
    });

    return { scheduler, calls, createdRuns, jobStore };
  }

  function dispatchedCompanyIds(calls: Array<{ params: unknown }>) {
    return calls
      .map(
        (c) =>
          (c.params as { job: { companyId?: string | null } }).job.companyId ??
          null,
      )
      .sort();
  }

  it("fans a manual trigger out to every configured company, each with its own scope", async () => {
    const { scheduler, calls, createdRuns } = makeTriggerDeps([
      "company-a",
      "company-b",
      "company-c",
    ]);

    const result = await scheduler.triggerJob("job-1", "manual");
    // Dispatch is intentionally backgrounded; let it settle.
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(dispatchedCompanyIds(calls)).toEqual([
      "company-a",
      "company-b",
      "company-c",
    ]);
    // Every dispatched run must be a real, company-stamped row — this is what
    // makes the sweep actually execute instead of returning early.
    expect(createdRuns).toHaveLength(3);
    expect(createdRuns.map((r) => r.companyId).sort()).toEqual([
      "company-a",
      "company-b",
      "company-c",
    ]);
    expect(result.runIds).toHaveLength(3);
    // Legacy single-run field still points at one of the created runs.
    expect(result.runIds).toContain(result.runId);
  });

  it("never dispatches a manual run with a null company when companies are configured", async () => {
    const { scheduler, calls } = makeTriggerDeps(["company-a"]);

    await scheduler.triggerJob("job-1", "manual");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(dispatchedCompanyIds(calls)).not.toContain(null);
  });

  it("applies the same fan-out to retry triggers", async () => {
    const { scheduler, calls } = makeTriggerDeps(["company-a", "company-b"]);

    await scheduler.triggerJob("job-1", "retry");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(dispatchedCompanyIds(calls)).toEqual(["company-a", "company-b"]);
  });

  it("refuses to trigger at all when enumeration fails, rather than firing an unscoped no-op", async () => {
    const job = makeJobRow();
    const db = fakeDueJobsDb([]);
    const { jobStore } = makeJobStore();
    jobStore.getJobById = vi.fn(async () => job as never);

    const workerManager: Partial<PluginWorkerManager> = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => undefined) as never,
    };

    const scheduler = createPluginJobScheduler({
      db,
      jobStore: jobStore as PluginJobStore,
      workerManager: workerManager as PluginWorkerManager,
      listConfigCompanyIds: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    });

    await expect(scheduler.triggerJob("job-1", "manual")).rejects.toThrow(
      /failed to enumerate configured companies/,
    );
    expect(workerManager.call).not.toHaveBeenCalled();
  });
});
