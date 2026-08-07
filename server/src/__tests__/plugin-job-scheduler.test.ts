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
